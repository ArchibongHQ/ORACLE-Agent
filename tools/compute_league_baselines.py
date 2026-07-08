#!/usr/bin/env python3
"""compute_league_baselines.py — lake-computed league goal baselines (audit P0-2).

Replaces the hand-verified static `V3_LEAGUE_BASELINES` table in
`packages/engine/src/goalsV3/lambda.ts` with values computed from the historical
results lake (`.tmp/backfill/{season}_{fdco}.csv`, football-data.co.uk format,
FTHG/FTAG columns). The static table drifts stale (the audit caught EPL at 2.85
static vs 3.28 in 23/24, 2.93 in 24/25); computing from the lake keeps `L`
current and, once wired, lets it refresh on a cron instead of by manual audit.

Output: .tmp/oracle-store/league_baselines.json
  {
    "computedAt": ISO8601,
    "source": ".tmp/backfill",
    "seasonsUsed": ["2021", ..., "2425"],   # most-recent `--seasons` per league
    "byName":   {"Premier League": 3.08, ...},   # recency-weighted goals/game
    "detail":   {"Premier League": {"2425": {"gpg": 3.03, "matches": 380}, ...}}
  }

This tool is pure data production — it does NOT change any live pricing. Wiring
its output into the engine (behind a default-off flag, static table as fallback)
is a separate step. Run with --report to see the staleness diff vs the current
static table.

Usage:
    python tools/compute_league_baselines.py            # write JSON
    python tools/compute_league_baselines.py --report   # write + print diff
    python tools/compute_league_baselines.py --dry-run   # print, don't write
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKFILL_DIR = ROOT / ".tmp" / "backfill"
OUT_PATH = ROOT / ".tmp" / "oracle-store" / "league_baselines.json"

# football-data.co.uk Div code -> the engine's canonical league name
# (must match V3_LEAGUE_BASELINES / LEAGUE_PARAMS keys in the TS engine).
FDCO_TO_NAME: dict[str, str] = {
    "E0":  "Premier League",
    "E1":  "Championship",
    "SP1": "La Liga",
    "D1":  "Bundesliga",
    "I1":  "Serie A",
    "F1":  "Ligue 1",
    "N1":  "Eredivisie",
    "P1":  "Primeira Liga",
    "SC0": "Scottish Premiership",
    "B1":  "Belgian Pro League",
}

# Mirror of goalsV3/lambda.ts V3_LEAGUE_BASELINES — for the --report diff ONLY;
# not authoritative. Keep loosely in sync; the report tolerates missing keys.
STATIC_REFERENCE: dict[str, float] = {
    "Premier League": 2.85,
    "Bundesliga": 3.15,
    "La Liga": 2.65,
    "Serie A": 2.6,
    "Ligue 1": 2.96,
    "Eredivisie": 3.2,
    "Championship": 2.55,
}


def _season_from_filename(name: str) -> str:
    """'2425_E0.csv' -> '2425'."""
    return name.split("_", 1)[0]


def _fdco_from_filename(name: str) -> str:
    """'2425_E0.csv' -> 'E0'."""
    stem = name.rsplit(".", 1)[0]
    return stem.split("_", 1)[1] if "_" in stem else ""


def season_gpg(path: Path) -> tuple[float, int]:
    """Return (goals_per_game, matches) for one season CSV, skipping rows with
    a blank/non-numeric FTHG or FTAG (postponed/void fixtures)."""
    total_goals = 0.0
    matches = 0
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            fthg = (row.get("FTHG") or "").strip()
            ftag = (row.get("FTAG") or "").strip()
            if not fthg or not ftag:
                continue
            try:
                total_goals += float(fthg) + float(ftag)
            except ValueError:
                continue
            matches += 1
    return (total_goals / matches if matches else 0.0), matches


def compute_baselines(
    backfill_dir: Path, seasons: int = 5
) -> tuple[dict[str, float], dict[str, dict], list[str]]:
    """Compute recency-weighted goals-per-game per league from a backfill dir.

    For each league, uses the most-recent `seasons` seasons available and takes
    a linear recency-weighted mean (most recent season weighted highest). Returns
    (by_name, detail, seasons_used_global)."""
    # (fdco, season) -> (gpg, matches)
    per_season: dict[str, dict[str, tuple[float, int]]] = defaultdict(dict)
    if not backfill_dir.is_dir():
        return {}, {}, []

    for path in sorted(backfill_dir.glob("*.csv")):
        fdco = _fdco_from_filename(path.name)
        season = _season_from_filename(path.name)
        if fdco not in FDCO_TO_NAME or not season:
            continue
        gpg, matches = season_gpg(path)
        if matches:
            per_season[fdco][season] = (gpg, matches)

    by_name: dict[str, float] = {}
    detail: dict[str, dict] = {}
    seasons_used_global: set[str] = set()

    for fdco, season_map in per_season.items():
        name = FDCO_TO_NAME[fdco]
        recent = sorted(season_map.keys())[-seasons:]
        seasons_used_global.update(recent)
        # linear recency weights: oldest of the window = 1 ... newest = len
        weights = list(range(1, len(recent) + 1))
        wsum = sum(weights)
        weighted = sum(
            season_map[s][0] * w for s, w in zip(recent, weights)
        ) / wsum
        by_name[name] = round(weighted, 3)
        detail[name] = {
            s: {"gpg": round(season_map[s][0], 3), "matches": season_map[s][1]}
            for s in recent
        }

    return by_name, detail, sorted(seasons_used_global)


def build_report(by_name: dict[str, float]) -> list[str]:
    """Lines comparing computed baselines to the static reference table."""
    lines = ["[baselines] computed vs static (goals/game):"]
    for name in sorted(by_name):
        computed = by_name[name]
        static = STATIC_REFERENCE.get(name)
        if static is None:
            lines.append(f"  {name:<24} {computed:>5.2f}  (no static entry)")
        else:
            delta = computed - static
            flag = "  <-- STALE" if abs(delta) >= 0.10 else ""
            lines.append(
                f"  {name:<24} {computed:>5.2f}  static={static:>4.2f}  "
                f"d={delta:+.2f}{flag}"
            )
    return lines


def main() -> None:
    parser = argparse.ArgumentParser(description="Compute lake league baselines")
    parser.add_argument("--seasons", type=int, default=5,
                        help="most-recent N seasons per league (default 5)")
    parser.add_argument("--report", action="store_true",
                        help="print the staleness diff vs the static table")
    parser.add_argument("--dry-run", action="store_true",
                        help="print without writing the JSON")
    args = parser.parse_args()

    by_name, detail, seasons_used = compute_baselines(BACKFILL_DIR, args.seasons)
    if not by_name:
        print(f"[baselines] ERROR: no usable CSVs in {BACKFILL_DIR}", file=sys.stderr)
        sys.exit(1)

    print(f"[baselines] {len(by_name)} leagues, seasons={seasons_used}")
    if args.report:
        for line in build_report(by_name):
            print(line)

    if args.dry_run:
        print("[baselines] Dry run — nothing written.")
        return

    payload = {
        "computedAt": datetime.now(tz=timezone.utc).isoformat(),
        "source": str(BACKFILL_DIR.relative_to(ROOT)),
        "seasonsUsed": seasons_used,
        "byName": by_name,
        "detail": detail,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"[baselines] -> {OUT_PATH}  ({len(by_name)} leagues)")


if __name__ == "__main__":
    main()
