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


def _read_season(path: Path) -> tuple[float, float, int]:
    """Return (home_goals_per_game, away_goals_per_game, matches) for one season
    CSV, skipping rows with a blank/non-numeric FTHG or FTAG (postponed/void)."""
    home_goals = 0.0
    away_goals = 0.0
    matches = 0
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            fthg = (row.get("FTHG") or "").strip()
            ftag = (row.get("FTAG") or "").strip()
            if not fthg or not ftag:
                continue
            try:
                h = float(fthg)
                a = float(ftag)
            except ValueError:
                continue
            home_goals += h
            away_goals += a
            matches += 1
    if not matches:
        return 0.0, 0.0, 0
    return home_goals / matches, away_goals / matches, matches


def season_gpg(path: Path) -> tuple[float, int]:
    """Return (total_goals_per_game, matches) for one season CSV."""
    home, away, matches = _read_season(path)
    return (home + away), matches


# HFA is applied in lambda.ts as λH *= m, λA /= m from a symmetric baseline, so
# the observed home/away goal ratio ≈ m². Fit m = sqrt(home_gpg / away_gpg),
# clamped to a sane band (a data glitch or a tiny sample must not produce an
# absurd multiplier). 1.0 = no home edge; 1.30 is already an extreme HFA league.
HFA_MIN = 1.0
HFA_MAX = 1.30


def compute_baselines(
    backfill_dir: Path, seasons: int = 5
) -> tuple[dict[str, float], dict[str, float], dict[str, dict], list[str]]:
    """Compute recency-weighted goals-per-game AND per-league HFA from a backfill
    dir.

    For each league, uses the most-recent `seasons` seasons available and takes a
    linear recency-weighted mean (most recent season weighted highest). Baseline
    L = weighted total goals/game; HFA = sqrt(weighted home gpg / weighted away
    gpg), clamped to [HFA_MIN, HFA_MAX]. Returns
    (by_name, hfa_by_name, detail, seasons_used_global)."""
    # (fdco, season) -> (home_gpg, away_gpg, matches)
    per_season: dict[str, dict[str, tuple[float, float, int]]] = defaultdict(dict)
    if not backfill_dir.is_dir():
        return {}, {}, {}, []

    for path in sorted(backfill_dir.glob("*.csv")):
        fdco = _fdco_from_filename(path.name)
        season = _season_from_filename(path.name)
        if fdco not in FDCO_TO_NAME or not season:
            continue
        home, away, matches = _read_season(path)
        if matches:
            per_season[fdco][season] = (home, away, matches)

    by_name: dict[str, float] = {}
    hfa_by_name: dict[str, float] = {}
    detail: dict[str, dict] = {}
    seasons_used_global: set[str] = set()

    for fdco, season_map in per_season.items():
        name = FDCO_TO_NAME[fdco]
        recent = sorted(season_map.keys())[-seasons:]
        seasons_used_global.update(recent)
        # linear recency weights: oldest of the window = 1 ... newest = len
        weights = list(range(1, len(recent) + 1))
        wsum = sum(weights)
        home_w = sum(season_map[s][0] * w for s, w in zip(recent, weights)) / wsum
        away_w = sum(season_map[s][1] * w for s, w in zip(recent, weights)) / wsum
        by_name[name] = round(home_w + away_w, 3)
        hfa = (home_w / away_w) ** 0.5 if away_w > 0 else HFA_MIN
        hfa_by_name[name] = round(min(HFA_MAX, max(HFA_MIN, hfa)), 3)
        detail[name] = {
            s: {
                "gpg": round(season_map[s][0] + season_map[s][1], 3),
                "home_gpg": round(season_map[s][0], 3),
                "away_gpg": round(season_map[s][1], 3),
                "matches": season_map[s][2],
            }
            for s in recent
        }

    return by_name, hfa_by_name, detail, sorted(seasons_used_global)


def build_report(by_name: dict[str, float], hfa_by_name: dict[str, float]) -> list[str]:
    """Lines comparing computed baselines to the static reference table, plus the
    fitted per-league HFA multiplier (static global default is 1.10)."""
    lines = ["[baselines] computed vs static (goals/game) + fitted HFA:"]
    for name in sorted(by_name):
        computed = by_name[name]
        hfa = hfa_by_name.get(name, HFA_MIN)
        static = STATIC_REFERENCE.get(name)
        if static is None:
            lines.append(f"  {name:<24} {computed:>5.2f}  (no static entry)   hfa={hfa:.3f}")
        else:
            delta = computed - static
            flag = "  <-- STALE" if abs(delta) >= 0.10 else ""
            lines.append(
                f"  {name:<24} {computed:>5.2f}  static={static:>4.2f}  "
                f"d={delta:+.2f}   hfa={hfa:.3f}{flag}"
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

    by_name, hfa_by_name, detail, seasons_used = compute_baselines(BACKFILL_DIR, args.seasons)
    if not by_name:
        print(f"[baselines] ERROR: no usable CSVs in {BACKFILL_DIR}", file=sys.stderr)
        sys.exit(1)

    print(f"[baselines] {len(by_name)} leagues, seasons={seasons_used}")
    if args.report:
        for line in build_report(by_name, hfa_by_name):
            print(line)

    if args.dry_run:
        print("[baselines] Dry run — nothing written.")
        return

    payload = {
        "computedAt": datetime.now(tz=timezone.utc).isoformat(),
        "source": str(BACKFILL_DIR.relative_to(ROOT)),
        "seasonsUsed": seasons_used,
        "byName": by_name,
        "hfaByName": hfa_by_name,
        "detail": detail,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"[baselines] -> {OUT_PATH}  ({len(by_name)} leagues)")


if __name__ == "__main__":
    main()
