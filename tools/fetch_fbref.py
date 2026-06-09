#!/usr/bin/env python3
"""
fetch_fbref.py — Aggregate FBref player stats into per-team season features.

Scans all fbref-* and fbref dirs under .tmp/kaggle/ for light CSVs and
aggregates player-level stats to team-season level.

Output: .tmp/fbref/team_season_stats.csv

Columns: squad, comp, fdco_league, season, goals, assists, shots,
         shots_on_target, yellow_cards, red_cards, minutes, player_count,
         goals_per90, shots_per90, sot_per90
"""

from __future__ import annotations

import csv
import sys
from collections import defaultdict
from pathlib import Path

KAGGLE_DIR = Path(".tmp/kaggle")
OUT_DIR    = Path(".tmp/fbref")
OUT_CSV    = OUT_DIR / "team_season_stats.csv"

COMP_TO_FDCO = {
    "eng Premier League": "E0",
    "es La Liga":         "SP1",
    "de Bundesliga":      "D1",
    "it Serie A":         "I1",
    "fr Ligue 1":         "F1",
    "eng Championship":   "E1",
}

# Infer season code from filename suffix e.g. "players_data_light-2024_2025.csv" -> "2425"
def _season_from_filename(name: str) -> str:
    import re
    m = re.search(r"(\d{4})_(\d{4})", name)
    if m:
        return m.group(1)[2:] + m.group(2)[2:]
    return "unknown"


def _safe_float(val: str) -> float:
    try:
        return float((val or "").replace(",", "").strip())
    except ValueError:
        return 0.0


def aggregate_csv(path: Path, season: str) -> list[dict]:
    teams: dict[tuple[str, str, str], dict] = defaultdict(lambda: {
        "goals": 0.0, "assists": 0.0, "shots": 0.0,
        "shots_on_target": 0.0, "yellow_cards": 0.0,
        "red_cards": 0.0, "minutes": 0.0, "player_count": 0,
    })

    with open(path, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            squad = (row.get("Squad") or "").strip()
            comp  = (row.get("Comp") or "").strip()
            if not squad or not comp:
                continue
            key = (squad, comp, season)
            t = teams[key]
            t["goals"]           += _safe_float(row.get("Gls") or "0")
            t["assists"]         += _safe_float(row.get("Ast") or "0")
            t["shots"]           += _safe_float(row.get("Sh") or "0")
            t["shots_on_target"] += _safe_float(row.get("SoT") or "0")
            t["yellow_cards"]    += _safe_float(row.get("CrdY") or "0")
            t["red_cards"]       += _safe_float(row.get("CrdR") or "0")
            t["minutes"]         += _safe_float(row.get("Min") or "0")
            t["player_count"]    += 1

    rows = []
    for (squad, comp, ssn), stats in teams.items():
        mins = stats["minutes"] or 1.0
        nineties = mins / 90.0
        rows.append({
            "squad":            squad,
            "comp":             comp,
            "fdco_league":      COMP_TO_FDCO.get(comp, ""),
            "season":           ssn,
            "goals":            round(stats["goals"]),
            "assists":          round(stats["assists"]),
            "shots":            round(stats["shots"]),
            "shots_on_target":  round(stats["shots_on_target"]),
            "yellow_cards":     round(stats["yellow_cards"]),
            "red_cards":        round(stats["red_cards"]),
            "minutes":          round(stats["minutes"]),
            "player_count":     stats["player_count"],
            "goals_per90":      round(stats["goals"] / nineties, 4),
            "shots_per90":      round(stats["shots"] / nineties, 4),
            "sot_per90":        round(stats["shots_on_target"] / nineties, 4),
        })
    return rows


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Find all light CSVs across fbref* dirs
    light_csvs: list[tuple[Path, str]] = []
    for d in sorted(KAGGLE_DIR.iterdir()):
        if not d.is_dir() or not d.name.startswith("fbref"):
            continue
        for csv_path in sorted(d.glob("players_data_light-*.csv")):
            season = _season_from_filename(csv_path.name)
            light_csvs.append((csv_path, season))

    if not light_csvs:
        print("[fbref] ERROR: no FBref light CSVs found in .tmp/kaggle/fbref*/", file=sys.stderr)
        sys.exit(1)

    # Aggregate across all files; deduplicate by (squad, comp, season)
    seen: set[tuple[str, str, str]] = set()
    all_rows: list[dict] = []
    for csv_path, season in light_csvs:
        rows = aggregate_csv(csv_path, season)
        new = 0
        for r in rows:
            key = (r["squad"], r["comp"], r["season"])
            if key not in seen:
                seen.add(key)
                all_rows.append(r)
                new += 1
        print(f"[fbref] {csv_path.name} (season={season}): {new} team-season rows")

    all_rows.sort(key=lambda r: (r["season"], r["comp"], r["squad"]))

    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(all_rows[0].keys()))
        writer.writeheader()
        writer.writerows(all_rows)

    seasons = sorted(set(r["season"] for r in all_rows))
    print(f"[fbref] Total: {len(all_rows)} team-season rows, seasons={seasons} -> {OUT_CSV}")


if __name__ == "__main__":
    main()
