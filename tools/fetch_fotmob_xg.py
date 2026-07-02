"""fetch_fotmob_xg.py — per-team xG via FotMob (reuses fetch_fotmob.py's
Playwright interception; FotMob covers 1000+ competitions, the primary
gap-filler for leagues outside Understat's top-5).

Runs fetch_fotmob_batch() (ONE shared browser, bounded concurrency — same
GPU-safety contract as fetch_fotmob.py: never fan out concurrently with
another browser-page swarm on local Windows) over a team list, then applies
xg_extract.best_team_xg() to each team's captured payload (see xg_extract.py's
docstring for why this is a best-effort key-walk rather than a fixed schema —
no live FotMob session was available to verify the exact JSON shape while
writing this).

Output: .tmp/xg/fotmob_xg.json
  { "<normalised team>": {"xgf": float, "xga": float|None, "n": null,
                          "div": "", "src": "fotmob"} }
No venue split (FotMob team-overview payloads are season-aggregate; unlike
Understat's per-match rows, there is no home/away breakdown to preserve here).

Merge priority in build_xg_table.py: Understat > FotMob > Sofascore > FBref —
FotMob only fills teams Understat's top-5-league coverage misses.

Usage:
    python tools/fetch_fotmob_xg.py --teams "Arsenal,Botafogo,Al Hilal"
    python tools/fetch_fotmob_xg.py --teams-file .tmp/xg/teams_today.txt
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fetch_fotmob import fetch_fotmob_batch, HAS_PLAYWRIGHT  # noqa: E402
from xg_extract import best_team_xg  # noqa: E402

try:
    from scrape_fixtures import normalise
except ImportError:  # repo root on sys.path instead of tools/
    from tools.scrape_fixtures import normalise

ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = ROOT / ".tmp" / "xg" / "fotmob_xg.json"


def _warn(msg: str) -> None:
    print(f"[fetch-fotmob-xg] WARN: {msg}", file=sys.stderr)


async def fetch_fotmob_xg_table(teams: list[str], max_workers: int | None = None) -> dict[str, dict]:
    """Fetch + extract xG for every team in `teams`. Teams FotMob has no data
    for, or whose captured payload has no xG-shaped key, are simply absent
    from the result — never fatal, matches every other tier in this pipeline."""
    if not HAS_PLAYWRIGHT:
        _warn("Playwright not installed — skipping FotMob xG")
        return {}
    if not teams:
        return {}

    raw = await fetch_fotmob_batch(teams, max_workers=max_workers)
    table: dict[str, dict] = {}
    for team, captured in raw.items():
        xg = best_team_xg(captured)
        if not xg:
            continue
        key = normalise(team)
        if not key:
            continue
        table[key] = {"xgf": xg["xgf"], "xga": xg["xga"], "n": None, "div": "", "src": "fotmob"}
    return table


def main() -> int:
    ap = argparse.ArgumentParser(description="Per-team xG via FotMob (best-effort key-walk).")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--teams", help="Comma-separated team names")
    group.add_argument("--teams-file", help="Path to a newline-delimited team-name file")
    ap.add_argument("--max-workers", type=int, default=None)
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

    table = asyncio.run(fetch_fotmob_xg_table(teams, max_workers=args.max_workers))

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(table, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[fetch-fotmob-xg] {len(table)}/{len(teams)} teams matched -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
