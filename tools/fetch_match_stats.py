#!/usr/bin/env python3
"""
fetch_match_stats.py — Extract referee strictness + pre-match xG from match-stats dataset.

Input:  .tmp/kaggle/match-stats/Football.csv  (gokhanergul, 95k rows)
Output:
  .tmp/match-stats/referee_features.csv   — ref_avg_yellow, ref_avg_red, ref_strictness
  .tmp/match-stats/match_xg_features.csv — date, home, away, xg_home, xg_away, xg_diff

NOTE: xG in this dataset is recorded post-match. It is used only as a historical
rolling average lookup (team's prior-match xG) — NOT the current match's xG.
Referee features are pre-match safe (based on referee's historical record).

GBM features added:
  refAvgYellow, refAvgRed, refStrictness (percentile rank)
  xgHome5 / xgAway5 (rolling 5-match pre-match avg, built in gbm_residual.py)
"""

from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

MATCH_STATS_CSV = Path(".tmp/kaggle/match-stats/Football.csv")
OUT_DIR         = Path(".tmp/match-stats")
REF_OUT         = OUT_DIR / "referee_features.csv"
XG_OUT          = OUT_DIR / "match_xg_features.csv"


def _safe_float(val: str) -> float | None:
    try:
        v = float((val or "").replace("%", "").strip())
        return v if v == v else None  # NaN check
    except (ValueError, AttributeError):
        return None


def _parse_date(day: str, year_hint: str) -> str:
    """Convert '3.11' + '2024/2025' -> '2024-11-03'."""
    try:
        parts = day.strip().split(".")
        d, m = int(parts[0]), int(parts[1])
        start_year = int((year_hint or "2024/2025").split("/")[0])
        # Seasons run Aug-May; months Aug-Dec are start_year, Jan-May are start_year+1
        year = start_year if m >= 7 else start_year + 1
        return f"{year}-{m:02d}-{d:02d}"
    except Exception:
        return ""


# Shared team-name normalisation (audit M2-1). Previously a local copy with
# different semantics (strip/lower/replace only) — it was never called, but is
# kept importable so future joins use the canonical implementation.
try:
    from lib.team_names import normalise_team as _normalise_team
except ImportError:  # repo root on sys.path instead of tools/
    from tools.lib.team_names import normalise_team as _normalise_team


def main() -> None:
    if not MATCH_STATS_CSV.exists():
        print(f"[match-stats] ERROR: {MATCH_STATS_CSV} not found", file=sys.stderr)
        sys.exit(1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # --- Pass 1: read all rows ---
    rows_raw: list[dict] = []
    with open(MATCH_STATS_CSV, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows_raw.append(row)
    print(f"[match-stats] loaded {len(rows_raw)} rows from {MATCH_STATS_CSV.name}")

    # --- Build referee history (sorted chronologically) ---
    # Key: referee name → list of (yellows, reds) per match
    ref_history: dict[str, list[tuple[float, float]]] = defaultdict(list)
    match_xg: list[dict] = []

    for row in rows_raw:
        ref = (row.get("referee") or "").strip()
        yellow_h = _safe_float(row.get("Yellow_Cards_Home") or "")
        yellow_a = _safe_float(row.get("Yellow_Cards_Host") or "")
        red_h    = _safe_float(row.get("Red_Cards_Home") or "")
        red_a    = _safe_float(row.get("Red_Cards_Host") or "")
        xg_h     = _safe_float(row.get("expected_goals_xg_home") or "")
        xg_a     = _safe_float(row.get("expected_goals_xg_host") or "")

        if ref:
            yellows = (yellow_h or 0) + (yellow_a or 0)
            reds    = (red_h or 0)    + (red_a or 0)
            ref_history[ref].append((yellows, reds))

        date_str = _parse_date(
            row.get("Date_day") or "",
            row.get("season_year") or ""
        )
        home = (row.get("home_team") or "").strip()
        away = (row.get("away_team") or "").strip()
        if date_str and home and away and (xg_h is not None or xg_a is not None):
            match_xg.append({
                "date":     date_str,
                "home":     home,
                "away":     away,
                "xg_home":  xg_h if xg_h is not None else "",
                "xg_away":  xg_a if xg_a is not None else "",
                "xg_diff":  round(xg_h - xg_a, 3) if (xg_h is not None and xg_a is not None) else "",
            })

    # --- Aggregate referee features ---
    ref_rows: list[dict] = []
    all_avg_yellow = []
    for ref, matches in ref_history.items():
        if len(matches) < 3:
            continue
        avg_y = sum(m[0] for m in matches) / len(matches)
        avg_r = sum(m[1] for m in matches) / len(matches)
        all_avg_yellow.append((ref, avg_y, avg_r, len(matches)))

    # Compute percentile rank of yellow strictness
    all_avg_yellow.sort(key=lambda x: x[1])
    n_refs = len(all_avg_yellow)
    for rank, (ref, avg_y, avg_r, n_matches) in enumerate(all_avg_yellow):
        ref_rows.append({
            "referee":         ref,
            "n_matches":       n_matches,
            "avg_yellow":      round(avg_y, 3),
            "avg_red":         round(avg_r, 3),
            "strictness_pct":  round(rank / max(n_refs - 1, 1), 4),
        })

    with open(REF_OUT, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["referee", "n_matches", "avg_yellow", "avg_red", "strictness_pct"])
        writer.writeheader()
        writer.writerows(ref_rows)
    print(f"[match-stats] {len(ref_rows)} referees -> {REF_OUT}")

    # --- Write match xG ---
    match_xg.sort(key=lambda r: r["date"])
    with open(XG_OUT, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["date", "home", "away", "xg_home", "xg_away", "xg_diff"])
        writer.writeheader()
        writer.writerows(match_xg)
    print(f"[match-stats] {len(match_xg)} match xG rows -> {XG_OUT}")

    # Sample
    if ref_rows:
        mid = len(ref_rows) // 2
        r = ref_rows[mid]
        print(f"  Median ref: {r['referee']}  avg_yellow={r['avg_yellow']}  strictness={r['strictness_pct']}")


if __name__ == "__main__":
    main()
