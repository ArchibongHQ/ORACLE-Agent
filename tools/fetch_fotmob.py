"""fetch_fotmob.py — per-team squad/form stats via FotMob (Playwright interception).

FotMob's `/api/data/*` endpoints require a crypto-signed `X-Fm-Req` header
(added ~Oct 2024 — see oracle_market_capture_and_swarm_scope memory). Plain
unauthenticated HTTP now 401s; even the established `soccerdata` scraping
library removed FotMob support over this rather than reverse-engineer the
signature. The reliable path (verified live 2026-06-23, probe script at
.tmp/site_probes/probe_fotmob.py) is letting a REAL browser load the team page
— it computes the header correctly itself — and intercepting the resulting
`fotmob.com/api/...` JSON responses via Playwright's response listener. No
header-forging, no reverse-engineering the secret.

Team-ID resolution: FotMob has no public unauthenticated search either, so
this also goes through the browser — loads FotMob's search page for the team
name and reads the first team-result link's id out of the rendered DOM.

GPU-safety: this is a Playwright/browser-page workload (see
oracle_swarm_gpu_bsod_incident memory) — call sites MUST run this
sequentially, never fan it out concurrently with scrape_fixtures.py's or
enrich_news.py's own browser-page swarms on local Windows. One shared browser
per run() call, like scrape_google_ai.py.

Usage:
    python tools/fetch_fotmob.py --team "Arsenal"
    python tools/fetch_fotmob.py --team "Arsenal" --out .tmp/fotmob/arsenal.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.parse
from pathlib import Path
from typing import Any, Optional

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from playwright.async_api import async_playwright, BrowserContext
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

import scrape_google_ai as sgai

ROOT = Path(__file__).resolve().parent.parent
FOTMOB_DIR = ROOT / ".tmp" / "fotmob"

SEARCH_URL = "https://www.fotmob.com/search?term={q}"


def _warn(msg: str) -> None:
    print(f"[fetch-fotmob] WARN: {msg}", file=sys.stderr)


async def _resolve_team_id(ctx: BrowserContext, team: str) -> Optional[str]:
    """Browser-rendered FotMob search → first team result's numeric id, read
    straight off the rendered link's href (/teams/{id}/...) — no API call."""
    page = await ctx.new_page()
    try:
        url = SEARCH_URL.format(q=urllib.parse.quote_plus(team))
        await page.goto(url, wait_until="domcontentloaded", timeout=10000)
        await page.wait_for_timeout(2500)
        hrefs = await page.evaluate(
            "() => Array.from(document.querySelectorAll('a[href*=\"/teams/\"]'))"
            ".map(a => a.getAttribute('href'))"
        )
        for href in hrefs or []:
            parts = [p for p in (href or "").split("/") if p]
            if "teams" in parts:
                idx = parts.index("teams")
                if idx + 1 < len(parts) and parts[idx + 1].isdigit():
                    return parts[idx + 1]
        return None
    except Exception as exc:
        _warn(f"team-id resolve failed for {team!r}: {exc}")
        return None
    finally:
        await page.close()


async def _fetch_team_json(ctx: BrowserContext, team_id: str, team: str) -> Optional[dict[str, Any]]:
    """Load the team's overview page and intercept the JSON the browser itself
    requests from fotmob.com/api/* (correctly X-Fm-Req-signed by the browser)."""
    captured: dict[str, str] = {}

    async def _on_response(resp: Any) -> None:
        try:
            url = resp.url
            if "fotmob.com/api" in url and resp.status == 200:
                ctype = resp.headers.get("content-type", "")
                if "json" in ctype and url not in captured:
                    captured[url] = await resp.text()
        except Exception:
            pass

    page = await ctx.new_page()
    page.on("response", lambda r: asyncio.ensure_future(_on_response(r)))
    try:
        slug = team.lower().replace(" ", "-")
        url = f"https://www.fotmob.com/teams/{team_id}/overview/{slug}"
        await page.goto(url, wait_until="domcontentloaded", timeout=15000)
        await page.wait_for_timeout(4000)
    except Exception as exc:
        _warn(f"team-page load failed for {team!r} (id={team_id}): {exc}")
    finally:
        await page.close()

    if not captured:
        return None

    parsed: dict[str, Any] = {}
    for url, body in captured.items():
        try:
            parsed[url] = json.loads(body)
        except ValueError:
            continue
    return parsed or None


async def fetch_fotmob_team(team: str) -> Optional[dict[str, Any]]:
    """Single-team fetch: launches its OWN browser. Convenient for the CLI/
    one-off case, but do NOT call this in a loop for multiple teams — each
    call is a full Chromium process. Use fetch_fotmob_batch for more than one
    team (shared browser, one page per worker, properly capped)."""
    if not HAS_PLAYWRIGHT:
        _warn("Playwright not installed — skipping FotMob")
        return None

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=sgai._launch_args())
        ctx = await browser.new_context(
            user_agent=sgai._CHROME_UA,
            viewport={"width": 1280, "height": 900},
            locale="en-GB",
            extra_http_headers={"Accept-Language": "en-GB,en;q=0.9"},
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
        )
        try:
            team_id = await _resolve_team_id(ctx, team)
            if not team_id:
                return None
            return await _fetch_team_json(ctx, team_id, team)
        finally:
            await browser.close()


async def _fetch_one_in_ctx(ctx: BrowserContext, team: str) -> Optional[dict[str, Any]]:
    team_id = await _resolve_team_id(ctx, team)
    if not team_id:
        return None
    return await _fetch_team_json(ctx, team_id, team)


async def fetch_fotmob_batch(teams: list[str], max_workers: Optional[int] = None) -> dict[str, dict[str, Any]]:
    """Multi-team fetch: ONE shared browser context, bounded concurrency via
    swarm_dispatch.browser_swarm_max_workers — mirrors enrich_news.py's
    _fetch_google_ai_batch pattern instead of one browser process per team
    (which is exactly the GPU-overload pattern that caused the 2026-06-23 BSOD
    incident, see oracle_swarm_gpu_bsod_incident memory). A team's fetch
    failure degrades to that team being absent from the result dict — never
    raises, never blocks the rest of the batch."""
    out: dict[str, dict[str, Any]] = {}
    if not HAS_PLAYWRIGHT or not teams:
        return out

    try:
        from swarm_dispatch import browser_swarm_max_workers
    except ImportError:  # repo root on sys.path instead of tools/
        from tools.swarm_dispatch import browser_swarm_max_workers

    cap = max_workers if max_workers is not None else browser_swarm_max_workers(len(teams))
    sem = asyncio.Semaphore(max(1, cap))

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=sgai._launch_args())
        ctx = await browser.new_context(
            user_agent=sgai._CHROME_UA,
            viewport={"width": 1280, "height": 900},
            locale="en-GB",
            extra_http_headers={"Accept-Language": "en-GB,en;q=0.9"},
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
        )

        async def _one(team: str) -> None:
            async with sem:
                try:
                    result = await _fetch_one_in_ctx(ctx, team)
                    if result:
                        out[team] = result
                except Exception as exc:
                    _warn(f"batch fetch failed for {team!r}: {exc}")

        try:
            await asyncio.gather(*(_one(t) for t in teams))
        finally:
            await browser.close()

    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="FotMob per-team squad/form fetch (Playwright interception).")
    ap.add_argument("--team", required=True, help="Team name, e.g. 'Arsenal'")
    ap.add_argument("--out", help="Write JSON here instead of stdout")
    args = ap.parse_args()

    result = asyncio.run(fetch_fotmob_team(args.team))
    if result is None:
        print("[fetch-fotmob] no data captured", file=sys.stderr)
        return 3

    payload = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(payload, encoding="utf-8")
        print(f"[fetch-fotmob] wrote {out_path}")
    else:
        # Windows' default console codepage (cp1252) can't encode every
        # character FotMob's JSON may contain (e.g. U+200E LEFT-TO-RIGHT MARK,
        # live-hit 2026-06-23) — write raw UTF-8 bytes directly to stdout's
        # buffer instead of going through print()'s text-mode encoder.
        sys.stdout.buffer.write(payload.encode("utf-8"))
        sys.stdout.buffer.write(b"\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
