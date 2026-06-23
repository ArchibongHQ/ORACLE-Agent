"""swarm_dispatch.py — shard fan-out + LLM fallback-extraction for the daily
scrape and news-intel jobs.

Two independent pieces, both usable standalone:

  1. run_swarm(tasks, worker) — generic bounded-concurrency fan-out for a list
     of independent shard tasks (one fixture / one team / one site each).
     Concurrency cap mirrors the existing fork in scrape_fixtures.py and
     enrich_news.py (sys.platform=="win32" and not ORACLE_IS_VPS => capped to
     avoid local OOM/driver-crash issues — see oracle_turbo_oom_windows memory;
     ORACLE_IS_VPS=true or non-Windows => effectively unbounded, one worker per
     shard, since a VPS has the headroom and these are thin I/O-bound tasks).

  2. llm_extract_fallback(raw_text, schema_hint) — invoked ONLY when a shard's
     deterministic parser returns nothing (selector changed, API schema
     drifted). Hands the raw scraped text/JSON to an LLM and asks it to pull
     out the same structured fields a working parser would have returned.
     Cascade: Kimi K2.6 (Moonshot API, cheap, fast) -> local Claude Code CLI
     pinned to Haiku (free, no network dependency) -> None. This is a
     resilience layer, not a replacement for the deterministic scrapers — the
     existing urllib/Playwright fetch code is unchanged and still does 100% of
     the actual HTTP/browser work. Never raises; degrades to None on total
     failure, same convention as every other tool in this directory.

Owner instruction (2026-06-23): scrape + news-intel jobs should run as a
"swarm of agents", OS-bounded locally / unbounded on a VPS, with Kimi as the
LLM tier and Claude Haiku (via the local Claude Code CLI) as its fallback.
This module is the implementation of that instruction, reusing the existing
ORACLE_IS_VPS concurrency convention rather than introducing a second knob.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional, TypeVar

ROOT = Path(__file__).resolve().parent.parent

T = TypeVar("T")
R = TypeVar("R")

KIMI_ENDPOINT = "https://api.moonshot.ai/v1/chat/completions"
KIMI_MODEL = "kimi-k2.6"  # keep in sync with packages/llm/src/cascade.ts MODELS.KIMI_SWARM
KIMI_TIMEOUT_S = 20

# Haiku is appropriate here specifically because this is data-extraction, not
# analysis/decision-making — the "Opus/Fable only" operator instruction in
# packages/llm/src/callClaudeCode.ts is scoped to the decision layer, not the
# acquisition layer. See feedback memory on this distinction if it's ever
# questioned again.
CLAUDE_CODE_HAIKU_MODEL = "haiku"
CLAUDE_CODE_TIMEOUT_S = 20


def _is_local_windows() -> bool:
    return sys.platform == "win32" and os.environ.get("ORACLE_IS_VPS", "").lower() != "true"


def swarm_max_workers(default_unbounded: int) -> int:
    """Concurrency cap for a swarm of THIN, NETWORK-ONLY shards (plain HTTP
    fetches, LLM-fallback calls) — no browser process per worker. Local Windows
    caps at 8. VPS/non-Windows runs one worker per shard, uncapped.

    Do NOT use this for Playwright/browser-page workloads — see
    browser_swarm_max_workers below. A 2026-06-23 incident used this function
    to size a Playwright page-concurrency cap (_fetch_google_ai_batch), raising
    it from a deliberately-tuned 4 to 8 and causing two GPU-driver BSODs
    (0x50/0x3B) within an hour on this box's integrated Intel UHD 610 while the
    OracleWorker service's scheduled scrape was also running concurrently with
    interactive terminal work. Keep these two caps separate."""
    return min(8, default_unbounded) if _is_local_windows() else default_unbounded


def browser_swarm_max_workers(default_unbounded: int) -> int:
    """Concurrency cap for a swarm of Playwright/browser-page shards (each
    holds open a real Chromium renderer process/page, GPU-compositor load).
    Local Windows caps at 4 — matches the existing, deliberately-tuned
    semaphore in scrape_fixtures.py's run_playwright_scrapers (see
    oracle_latency_twotier_fix / oracle_turbo_oom_windows memories: this box's
    integrated GPU + driver crashes under heavier concurrent page load, which
    surfaces as a hard reboot, not a catchable exception). VPS/non-Windows runs
    one worker per shard, uncapped — VPS deployments don't share this GPU
    contention risk (no GPU rendering pressure in a headless cloud box)."""
    return min(4, default_unbounded) if _is_local_windows() else default_unbounded


async def run_swarm(
    tasks: list[T],
    worker: Callable[[T], Awaitable[R]],
    max_workers: Optional[int] = None,
) -> list[R]:
    """Fan out `tasks` across `worker` with a bounded asyncio.Semaphore. Order of
    results matches order of `tasks`. A single task's exception does not cancel
    the rest of the swarm — every other ORACLE tool degrades per-item, not
    all-or-nothing, and the swarm follows the same rule."""
    import asyncio

    cap = max_workers if max_workers is not None else swarm_max_workers(len(tasks) or 1)
    sem = asyncio.Semaphore(max(1, cap))

    async def _run_one(task: T) -> R:
        async with sem:
            return await worker(task)

    return await asyncio.gather(*(_run_one(t) for t in tasks))


def _call_kimi(prompt: str, api_key: str) -> Optional[str]:
    if not api_key:
        return None
    try:
        import urllib.request

        req = urllib.request.Request(
            KIMI_ENDPOINT,
            data=json.dumps({
                "model": KIMI_MODEL,
                "messages": [
                    {"role": "system", "content": (
                        "You extract structured data from raw scraped text/JSON. "
                        "Return ONLY valid JSON matching the requested shape, no markdown, "
                        "no commentary. If a field can't be found, omit it."
                    )},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0,
                "max_tokens": 1024,
            }).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=KIMI_TIMEOUT_S) as resp:
            data = json.loads(resp.read())
        return data.get("choices", [{}])[0].get("message", {}).get("content")
    except Exception:
        return None


def _call_claude_code_haiku(prompt: str) -> Optional[str]:
    """Local Claude Code CLI, pinned to Haiku (--model haiku) — the data-
    extraction fallback tier, distinct from the analysis-layer CLI calls in
    packages/llm/src/callClaudeCode.ts which are pinned to Opus/Fable only."""
    claude_bin = os.environ.get("CLAUDE_BIN", "claude")
    try:
        proc = subprocess.run(
            [claude_bin, "-p", "--output-format", "json", "--max-turns", "1",
             "--model", CLAUDE_CODE_HAIKU_MODEL],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=CLAUDE_CODE_TIMEOUT_S,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return None
        envelope = json.loads(proc.stdout)
        if envelope.get("is_error") or not envelope.get("result"):
            return None
        return envelope["result"]
    except Exception:
        return None


def _strip_fences(text: str) -> str:
    cleaned = text.replace("```json", "").replace("```", "").strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end == -1:
        return ""
    return cleaned[start:end + 1]


def llm_extract_fallback(
    raw_text: str,
    schema_hint: str,
    kimi_api_key: str = "",
) -> Optional[dict[str, Any]]:
    """Ask an LLM to pull structured fields out of `raw_text` per `schema_hint`
    (a short description of the JSON shape wanted, e.g. '{"shots_on_target":
    int, "possession_pct": float}'). Tries Kimi first, then the local Claude
    Code CLI pinned to Haiku. Returns None if both fail or neither produces
    parseable JSON — callers should treat None exactly like "deterministic
    parse also found nothing", i.e. skip, never block."""
    if not raw_text.strip():
        return None

    prompt = (
        f"Extract the following fields from this scraped content. "
        f"Shape wanted: {schema_hint}\n\n"
        f"Scraped content:\n{raw_text[:6000]}"
    )

    text = _call_kimi(prompt, kimi_api_key)
    used = "kimi"
    if not text:
        text = _call_claude_code_haiku(prompt)
        used = "claude-code-haiku"
    if not text:
        return None

    payload = _strip_fences(text)
    if not payload:
        return None
    try:
        obj = json.loads(payload)
    except ValueError:
        return None
    if not isinstance(obj, dict):
        return None
    obj["_extractedBy"] = used
    return obj
