#!/usr/bin/env python3
"""
fetch_fbref.py — Aggregate FBref player stats into per-team season features.

Input:  .tmp/kaggle/fbref/players_data_light-2025_2026.csv
Output: .tmp/fbref/team_season_stats.csv

Columns in output:
  squad, comp, season, goals, assists, shots, shots_on_target,
  yellow_cards, red_cards, minutes, player_count,
  goals_per90, shots_per90, sot_per90
"""

from __future__ import annotations

import csv
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

FBREF_DIR  = Path(".tmp/kaggle/fbref")
OUT_DIR    = Path(".tmp/fbref")
LIGHT_CSV  = FBREF_DIR / "players_data_light-2025_2026.csv"
OUT_CSV    = OUT_DIR / "team_season_stats.csv"

COMP_TO_FDCO = {
    "eng Premier League": "E0",
    "es La Liga":         "SP1",
    "de Bundesliga":      "D1",
    "it Serie A":         "I1",
    "fr Ligue 1":         "F1",
}

SEASON = "2526"


def _safe_float(val: str) -> float:
    try:
        return float(val.replace(",", "").strip())
    except (ValueError, AttributeError):
        return 0.0


def aggregate() -> list[dict]:
    if not LIGHT_CSV.exists():
        print(f"[fbref] ERROR: {LIGHT_CSV} not found — run kaggle download first", file=sys.stderr)
        sys.exit(1)

    teams: dict[tuple[str, str], dict] = defaultdict(lambda: {
        "goals": 0.0, "assists": 0.0, "shots": 0.0,
        "shots_on_target": 0.0, "yellow_cards": 0.0,
        "red_cards": 0.0, "minutes": 0.0, "player_count": 0,
    })

    with open(LIGHT_CSV, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            squad = (row.get("Squad") or "").strip()
            comp  = (row.get("Comp") or "").strip()
            if not squad or not comp:
                continue
            key = (squad, comp)
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
    for (squad, comp), stats in teams.items():
        mins = stats["minutes"] or 1.0
        nineties = mins / 90.0
        rows.append({
            "squad":            squad,
            "comp":             comp,
            "fdco_league":      COMP_TO_FDCO.get(comp, ""),
            "season":           SEASON,
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

    rows.sort(key=lambda r: (r["comp"], r["squad"]))
    return rows


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    rows = aggregate()

    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    print(f"[fbref] {len(rows)} team-season rows -> {OUT_CSV}")
    for r in rows[:5]:
        print(f"  {r['squad']:25s}  {r['fdco_league']}  goals={r['goals']}  shots={r['shots']}  sot_per90={r['sot_per90']}")


if __name__ == "__main__":
    main()
