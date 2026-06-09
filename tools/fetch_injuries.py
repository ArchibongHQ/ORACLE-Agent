#!/usr/bin/env python3
"""
fetch_injuries.py — Aggregate player injury data into per-team season features.

Input:  .tmp/kaggle/injuries/dataset.csv
Output: .tmp/injuries/team_injury_stats.csv

Columns in output:
  squad_slug, season, total_injury_days, injured_player_count,
  avg_days_injured, pct_significant_injury
"""

from __future__ import annotations

import csv
import sys
from collections import defaultdict
from pathlib import Path

INJURY_CSV = Path(".tmp/kaggle/injuries/dataset.csv")
OUT_DIR    = Path(".tmp/injuries")
OUT_CSV    = OUT_DIR / "team_injury_stats.csv"


def _safe_float(val: str) -> float:
    try:
        return float((val or "").replace(",", "").strip())
    except ValueError:
        return 0.0


def aggregate() -> list[dict]:
    if not INJURY_CSV.exists():
        print(f"[injuries] ERROR: {INJURY_CSV} not found", file=sys.stderr)
        sys.exit(1)

    # Injury data is player-level with p_id2 (player slug) + start_year.
    # No squad column — we aggregate by (p_id2 prefix → can't map to squad without
    # a roster join). Instead emit player-level rows for external join.
    # Output: player slug + season → injury load features usable by fetch_lineups.
    rows_out = []
    with open(INJURY_CSV, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            p_id      = (row.get("p_id2") or "").strip()
            start_yr  = (row.get("start_year") or "").strip()
            if not p_id or not start_yr:
                continue
            rows_out.append({
                "player_slug":               p_id,
                "start_year":                start_yr,
                "season_days_injured":       round(_safe_float(row.get("season_days_injured") or "0")),
                "total_days_injured":        round(_safe_float(row.get("total_days_injured") or "0")),
                "season_minutes_played":     round(_safe_float(row.get("season_minutes_played") or "0")),
                "significant_injury_prev":   row.get("significant_injury_prev_season", "0").strip(),
                "avg_days_injured_prev":     round(_safe_float(row.get("avg_days_injured_prev_seasons") or "0"), 1),
            })

    rows_out.sort(key=lambda r: (r["start_year"], r["player_slug"]))
    return rows_out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    rows = aggregate()

    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    seasons = sorted(set(r["start_year"] for r in rows))
    print(f"[injuries] {len(rows)} player-season rows -> {OUT_CSV}")
    print(f"[injuries] Seasons covered: {seasons[:5]}...{seasons[-1]}")
    avg_inj = sum(r['season_days_injured'] for r in rows) / len(rows)
    print(f"[injuries] Mean season days injured: {avg_inj:.1f}")


if __name__ == "__main__":
    main()
