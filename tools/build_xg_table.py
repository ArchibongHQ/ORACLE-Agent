"""build_xg_table.py — aggregate Understat per-match xG CSVs into a rolling
team-strength prior, keyed by normalised team name.

Reads the .tmp/xg/{div}_{season}.csv files written by fetch_xg.py and, for each
team, averages xG-for / xG-against over its most recent N matches (current season
first, prior seasons as fallback). The result is a forward-looking *strength
prior* — NOT a per-fixture xG projection — consumed at fixture-selection time by
packages/runtime/src/selectFixtures.ts (via the SportyBet sidecar xg block).

Coverage = Understat's top-5 leagues only (EPL, La Liga, Bundesliga, Serie A,
Ligue 1). Teams outside coverage are absent from the table; the TS scorer falls
back to the sidecar goals-average proxy for them.

Output: .tmp/xg/team_xg_table.json
  { "<normalised team>": { "xgf": float, "xga": float, "n": int, "div": str } }

Fail-open: if no .tmp/xg/*.csv exist, writes an empty table and exits 0.

Usage:
    python tools/build_xg_table.py             # default N=8, all cached CSVs
    python tools/build_xg_table.py --window 10 # last 10 matches per team
    python tools/build_xg_table.py --dry-run   # print counts without writing
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

# Reuse the shared team-name normaliser (do not add a second one).
try:
    from scrape_fixtures import normalise
except ImportError:  # repo root on sys.path instead of tools/
    from tools.scrape_fixtures import normalise

XG_DIR = Path(".tmp/xg")
OUTPUT_PATH = XG_DIR / "team_xg_table.json"
DEFAULT_WINDOW = 8

# football-data.co.uk div code → display league (matches fetch_xg.LEAGUE_MAP values)
_DIV_CODES = {"E0", "SP1", "D1", "I1", "F1"}


def _load_rows(csv_path: Path) -> list[dict]:
    """Read one fetch_xg.py CSV. Malformed rows are skipped, never fatal."""
    rows: list[dict] = []
    try:
        with csv_path.open(encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                try:
                    rows.append(
                        {
                            "date": r["date"],
                            "home": r["home"],
                            "away": r["away"],
                            "xg_home": float(r["xg_home"]),
                            "xg_away": float(r["xg_away"]),
                        }
                    )
                except (KeyError, ValueError, TypeError):
                    continue
    except OSError as exc:
        print(f"[xg-table] WARN: cannot read {csv_path.name}: {exc}", file=sys.stderr)
    return rows


def _div_of(csv_path: Path) -> str:
    """E0_2324.csv → 'E0' (the div code prefix), else '' if unrecognised."""
    code = csv_path.stem.split("_", 1)[0]
    return code if code in _DIV_CODES else ""


def build_table(window: int) -> dict[str, dict]:
    """Aggregate all cached CSVs into a per-team rolling xGF/xGA table.

    Each team's matches are collected across every CSV, sorted most-recent-first
    by date, and the latest `window` matches averaged. Team venue (home/away)
    selects which xG column is "for" vs "against".
    """
    csv_paths = sorted(XG_DIR.glob("*.csv"))
    if not csv_paths:
        return {}

    # team key → { "div": str, "matches": [(date, xgf, xga)] }
    acc: dict[str, dict] = {}

    def _record(team_raw: str, div: str, date: str, xgf: float, xga: float) -> None:
        key = normalise(team_raw)
        if not key:
            return
        slot = acc.setdefault(key, {"div": div, "matches": []})
        slot["matches"].append((date, xgf, xga))

    for path in csv_paths:
        div = _div_of(path)
        if not div:
            continue
        for m in _load_rows(path):
            # Home perspective: xg_home for, xg_away against; away is the mirror.
            _record(m["home"], div, m["date"], m["xg_home"], m["xg_away"])
            _record(m["away"], div, m["date"], m["xg_away"], m["xg_home"])

    table: dict[str, dict] = {}
    for key, slot in acc.items():
        matches = sorted(slot["matches"], key=lambda t: t[0], reverse=True)[:window]
        if not matches:
            continue
        n = len(matches)
        xgf = sum(t[1] for t in matches) / n
        xga = sum(t[2] for t in matches) / n
        table[key] = {
            "xgf": round(xgf, 4),
            "xga": round(xga, 4),
            "n": n,
            "div": slot["div"],
        }
    return table


def main() -> None:
    parser = argparse.ArgumentParser(description="Build rolling team-xG prior table from Understat CSVs")
    parser.add_argument("--window", type=int, default=DEFAULT_WINDOW,
                        help=f"matches per team to average (default {DEFAULT_WINDOW})")
    parser.add_argument("--dry-run", action="store_true",
                        help="print counts without writing the table")
    args = parser.parse_args()

    table = build_table(max(1, args.window))

    if not table:
        print("[xg-table] no .tmp/xg/*.csv found — writing empty table (fail-open)")

    if args.dry_run:
        print(f"[xg-table] {len(table)} teams (dry-run, not written)")
        return

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUTPUT_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(table, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(OUTPUT_PATH)
    print(f"[xg-table] {len(table)} teams -> {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
