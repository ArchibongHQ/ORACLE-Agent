"""fetch_xg_fallback.py — Google AI-Mode xG fallback for teams still missing
xG after the Understat/FotMob/Sofascore/FBref merge (build_xg_table.py).

Standing rule (CLAUDE.md §6, [[oracle-no-data-blocker-playwright]]): missing
data is NEVER a blocker — this IS the no-key, no-structured-API fallback tier
for xG specifically, reusing scrape_google_ai.py's Playwright Google AI-Mode
("udm=50") surface. Runs ONE shared browser context across all teams (same
GPU-safety contract as fetch_fotmob.py/fetch_sofascore.py — never fan out
concurrently with another browser-page swarm on local Windows) and asks a
natural-language question per team, then regex-extracts an xG/xGA figure from
the AI-mode prose answer.

This is deliberately a LOW-confidence tier: an LLM-generated prose summary is
not a structured stat feed. Every hit is tagged `src: "google_ai"`, which
downstream (packages/runtime/src/goalsV3/completeness.ts) applies the softer
`xgEstimated` −1pt penalty instead of the −2pt "missing" penalty — i.e. this
tier trades "no signal" for "weak signal with a bigger v3 edge-gate haircut",
never presented as equal-confidence to Understat/FotMob/Sofascore.

Output: .tmp/xg/ai_mode_xg.json (same per-team {xgf, xga, n, div, src} shape
as the other xG JSON tiers — merge this LAST, after fotmob/sofascore, in any
orchestration script; build_xg_table.py's own merge order does not include
this tier automatically since it needs to run only for the RESIDUAL gap after
the other three, not unconditionally for every team).

Usage:
    python tools/fetch_xg_fallback.py --teams "Botafogo,Al Hilal"
    python tools/fetch_xg_fallback.py --residual-from .tmp/xg/team_xg_table.json --teams-file .tmp/xg/teams_today.txt
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
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

import scrape_google_ai as sgai  # noqa: E402

try:
    from scrape_fixtures import normalise
except ImportError:  # repo root on sys.path instead of tools/
    from tools.scrape_fixtures import normalise

ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = ROOT / ".tmp" / "xg" / "ai_mode_xg.json"

_QUERY_TMPL = "{team} football xG and xGA (expected goals for and against) per game this season, home and away"

# Prose extraction: "xG" or "xGA" followed (within a natural-prose gap — AI-Mode
# answers commonly interpose a verb phrase like "stands at approximately") by a
# decimal number. xGA is matched separately from the generic xG pattern (the
# negative lookahead keeps xG from also matching the "A" in "xGA" as noise).
_GAP = r"[^\d]{0,50}"
_XGA_RE = re.compile(rf"x\s?g\s?a{_GAP}(\d+\.\d+)", re.IGNORECASE)
_XG_RE = re.compile(rf"\bx\s?g\b(?!\s?a){_GAP}(\d+\.\d+)", re.IGNORECASE)


def _warn(msg: str) -> None:
    print(f"[fetch-xg-fallback] WARN: {msg}", file=sys.stderr)


def _extract_xg_from_text(text: str) -> Optional[dict]:
    """Best-effort regex pull of an xG/xGA figure from Google AI-Mode's prose
    answer. Returns None when no plausible xG figure is found — this is a
    fallback tier, absence is the expected common case for well-covered teams
    that never needed it. Sanity-bounds both figures to [0,6] (a believable
    per-match team xG range; wildly out-of-range hits are almost always the
    regex matching an unrelated number, not the model being wrong)."""
    if not text:
        return None
    xgf_match = _XG_RE.search(text)
    xga_match = _XGA_RE.search(text)
    if not xgf_match:
        return None
    try:
        xgf = float(xgf_match.group(1))
    except ValueError:
        return None
    if not (0 <= xgf <= 6):
        return None
    xga: Optional[float] = None
    if xga_match:
        try:
            candidate = float(xga_match.group(1))
            if 0 <= candidate <= 6:
                xga = candidate
        except ValueError:
            pass
    return {"xgf": xgf, "xga": xga}


async def _query_one(ctx: BrowserContext, team: str, wait_ms: int) -> Optional[dict]:
    query = _QUERY_TMPL.format(team=team)
    url = sgai._GOOGLE_AI_MODE.format(q=urllib.parse.quote_plus(query))
    try:
        result = await sgai._scrape_url(ctx, url, wait_ms)
    except Exception as exc:
        _warn(f"query failed for {team!r}: {exc}")
        return None
    if not result:
        return None
    return _extract_xg_from_text(result.get("text", ""))


async def fetch_xg_fallback_table(
    teams: list[str], max_workers: Optional[int] = None, wait_ms: int = 4000
) -> dict[str, dict]:
    """Fetch + extract a Google-AI-Mode xG estimate for every team in `teams`.
    Sequential-safe bounded concurrency, same shared-browser pattern as
    fetch_fotmob_batch/fetch_sofascore_batch. A team with no extractable
    figure is simply absent from the result — never fatal."""
    if not HAS_PLAYWRIGHT or not teams:
        return {}

    try:
        from swarm_dispatch import browser_swarm_max_workers
    except ImportError:  # repo root on sys.path instead of tools/
        from tools.swarm_dispatch import browser_swarm_max_workers

    cap = max_workers if max_workers is not None else browser_swarm_max_workers(len(teams))
    sem = asyncio.Semaphore(max(1, cap))
    table: dict[str, dict] = {}

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
                xg = await _query_one(ctx, team, wait_ms)
                if not xg:
                    return
                key = normalise(team)
                if not key:
                    return
                table[key] = {
                    "xgf": xg["xgf"],
                    "xga": xg["xga"],
                    "n": None,
                    "div": "",
                    "src": "google_ai",
                }

        try:
            await asyncio.gather(*(_one(t) for t in teams))
        finally:
            await browser.close()

    return table


def _residual_teams(all_teams: list[str], covered_path: Path) -> list[str]:
    """Filter `all_teams` down to those NOT already present in an existing xG
    table (e.g. team_xg_table.json after the Understat/FotMob/Sofascore/FBref
    merge) — this tier should only run for the genuine residual gap, not
    unconditionally re-query every team every day."""
    try:
        covered = json.loads(covered_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        covered = {}
    if not isinstance(covered, dict):
        covered = {}
    return [t for t in all_teams if normalise(t) not in covered]


def main() -> int:
    ap = argparse.ArgumentParser(description="Google AI-Mode xG fallback (last-resort, low-confidence tier).")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--teams", help="Comma-separated team names")
    group.add_argument("--teams-file", help="Path to a newline-delimited team-name file")
    ap.add_argument(
        "--residual-from",
        help="Only query teams NOT already present in this xG-table JSON file "
        "(e.g. .tmp/xg/team_xg_table.json after the main merge)",
    )
    ap.add_argument("--max-workers", type=int, default=None)
    ap.add_argument("--wait-ms", type=int, default=4000)
    ap.add_argument("--out", default=str(OUTPUT_PATH))
    args = ap.parse_args()

    if args.teams:
        teams = [t.strip() for t in args.teams.split(",") if t.strip()]
    else:
        teams = [
            line.strip()
            for line in Path(args.teams_file).read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    if args.residual_from:
        before = len(teams)
        teams = _residual_teams(teams, Path(args.residual_from))
        print(f"[fetch-xg-fallback] residual filter: {before} -> {len(teams)} teams still missing xG")

    table = asyncio.run(fetch_xg_fallback_table(teams, max_workers=args.max_workers, wait_ms=args.wait_ms))

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(table, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[fetch-xg-fallback] {len(table)}/{len(teams)} teams matched -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
