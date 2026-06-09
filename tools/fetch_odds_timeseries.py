"""
fetch_odds_timeseries.py — Ingest Kaggle odds time-series datasets for ORACLE.

Processes two Kaggle datasets (downloaded separately) to extract line-movement
features and Asian Handicap closing lines used as GBM features.

Datasets (download via `kaggle datasets download -d <slug>`):
  1. Beat The Bookie — austro/beat-the-bookie-worldwide-football-dataset
     Hourly-sampled 1X2 odds from up to 32 bookmakers, 72h before kick-off.
  2. European Football AH Odds Time-Series — realsingwong/european-football-asian-handicap-odds-time-series
     Opening→closing Asian Handicap odds, 15 bookmakers, 5 leagues, 4 seasons.

Output:
  .tmp/odds-timeseries/btb_{div}_{season}.csv  — Beat the Bookie, per league/season
  .tmp/odds-timeseries/ah_{div}_{season}.csv   — AH time-series, per league/season

Derived features written to .tmp/odds-timeseries/features_{season}.csv:
  match_id, date, home, away, div,
  line_movement_slope   — linear regression slope of opening→closing 1X2H odds
  opening_to_close_delta — (close - open) / open for home odds
  ah_open_line          — opening AH line (Asian Handicap handicap value)
  ah_close_line         — closing AH line
  ah_close_delta        — close - open AH line shift

Usage:
    python tools/fetch_odds_timeseries.py --btb-dir .tmp/kaggle/beat-the-bookie
    python tools/fetch_odds_timeseries.py --ah-dir  .tmp/kaggle/ah-odds
    python tools/fetch_odds_timeseries.py --btb-dir .tmp/kaggle/beat-the-bookie \\
                                           --ah-dir  .tmp/kaggle/ah-odds
    python tools/fetch_odds_timeseries.py --dry-run
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / ".tmp" / "odds-timeseries"

# Mapping Kaggle league names → football-data.co.uk div codes
BTB_LEAGUE_MAP: dict[str, str] = {
    "premier league":       "E0",
    "premier_league":       "E0",
    "championship":         "E1",
    "la liga":              "SP1",
    "la_liga":              "SP1",
    "bundesliga":           "D1",
    "serie a":              "I1",
    "serie_a":              "I1",
    "ligue 1":              "F1",
    "ligue_1":              "F1",
    "eredivisie":           "N1",
    "belgian pro league":   "B1",
    "primeira liga":        "P1",
    "scottish premiership": "SC0",
}

AH_LEAGUE_MAP: dict[str, str] = {
    "eng":  "E0",
    "esp":  "SP1",
    "ger":  "D1",
    "ita":  "I1",
    "fra":  "F1",
}


# ── Linear regression slope (pure stdlib) ─────────────────────────────────────

def _linreg_slope(values: list[float]) -> float:
    """Return OLS slope for a 1-D sequence indexed by position."""
    n = len(values)
    if n < 2:
        return 0.0
    x_mean = (n - 1) / 2
    y_mean = sum(values) / n
    num = sum((i - x_mean) * (v - y_mean) for i, v in enumerate(values))
    den = sum((i - x_mean) ** 2 for i in range(n))
    return num / den if den else 0.0


# ── Beat The Bookie parser ─────────────────────────────────────────────────────

def process_btb(btb_dir: Path, dry_run: bool) -> list[dict]:
    """
    Parse Beat The Bookie CSVs.

    Expected format (one row per bookmaker-timestamp per match):
      MatchID, Date, HomeTeam, AwayTeam, League, BookmakerName,
      OddsHome, OddsDraw, OddsAway, TimestampHoursBeforeKickoff
    Falls back to any CSV that has odds columns and a time column.
    Returns list of feature dicts (one per match).
    """
    if not btb_dir.exists():
        print(f"[btb] directory not found: {btb_dir} — skipping", file=sys.stderr)
        return []

    csvs = list(btb_dir.rglob("*.csv"))
    if not csvs:
        print(f"[btb] no CSV files found in {btb_dir}", file=sys.stderr)
        return []

    # Accumulate home-odds time series per match key
    match_series: dict[str, list[tuple[float, float]]] = {}  # key → [(hours_before, home_odds)]
    match_meta: dict[str, dict] = {}

    for csv_path in csvs:
        try:
            with open(csv_path, newline="", encoding="utf-8-sig") as fh:
                reader = csv.DictReader(fh)
                cols = [c.lower().strip() for c in (reader.fieldnames or [])]
                # Identify relevant columns by common naming patterns
                home_col = _find_col(cols, ["oddshome", "home_odds", "h_odds", "b365h", "psh"])
                time_col = _find_col(cols, ["timehoursbeforekickoff", "hours_before", "time_before", "hbk"])
                home_team_col = _find_col(cols, ["hometeam", "home_team", "home"])
                away_team_col = _find_col(cols, ["awayteam", "away_team", "away"])
                date_col = _find_col(cols, ["date", "matchdate", "match_date"])
                league_col = _find_col(cols, ["league", "div", "division"])

                if not home_col:
                    continue  # not an odds file

                raw_cols = reader.fieldnames or []
                col_index = {c.lower().strip(): c for c in raw_cols}

                for row in reader:
                    def get(key: Optional[str]) -> str:
                        return row.get(col_index.get(key or "", ""), "").strip() if key else ""

                    home_team = get(home_team_col)
                    away_team = get(away_team_col)
                    date = get(date_col)
                    if not home_team or not away_team or not date:
                        continue

                    match_key = f"{date}_{home_team}_{away_team}"

                    try:
                        home_odds = float(get(home_col))
                    except (ValueError, TypeError):
                        continue

                    try:
                        hours_before = float(get(time_col)) if time_col else 0.0
                    except (ValueError, TypeError):
                        hours_before = 0.0

                    if match_key not in match_series:
                        match_series[match_key] = []
                        league_raw = get(league_col).lower()
                        div = BTB_LEAGUE_MAP.get(league_raw, "UNK")
                        match_meta[match_key] = {
                            "date": date,
                            "home": home_team,
                            "away": away_team,
                            "div": div,
                        }

                    match_series[match_key].append((hours_before, home_odds))

        except Exception as exc:
            print(f"[btb] error reading {csv_path}: {exc}", file=sys.stderr)

    features: list[dict] = []
    for key, series in match_series.items():
        if len(series) < 2:
            continue
        # Sort by hours_before descending (earliest snapshot first)
        series.sort(key=lambda t: t[0], reverse=True)
        odds_seq = [t[1] for t in series]
        opening = odds_seq[0]
        closing = odds_seq[-1]
        slope = _linreg_slope(odds_seq)
        delta = (closing - opening) / opening if opening else 0.0

        meta = match_meta[key]
        features.append({
            "match_id": key,
            "date": meta["date"],
            "home": meta["home"],
            "away": meta["away"],
            "div": meta["div"],
            "line_movement_slope": round(slope, 6),
            "opening_to_close_delta": round(delta, 6),
        })

    print(f"[btb] extracted line-movement features for {len(features)} matches")
    return features


# ── Asian Handicap parser ──────────────────────────────────────────────────────

def process_ah(ah_dir: Path, dry_run: bool) -> list[dict]:
    """
    Parse AH odds time-series CSVs.

    Expected format (one row per bookmaker-timestamp per match file):
      row 0 = closing odds (most recent), last row = opening odds
      Columns vary; looks for: HandicapHome, AHLine, Line, handicap
    Returns list of feature dicts (one per match).
    """
    if not ah_dir.exists():
        print(f"[ah] directory not found: {ah_dir} — skipping", file=sys.stderr)
        return []

    csvs = list(ah_dir.rglob("*.csv"))
    if not csvs:
        print(f"[ah] no CSV files found in {ah_dir}", file=sys.stderr)
        return []

    features: list[dict] = []
    for csv_path in csvs:
        try:
            with open(csv_path, newline="", encoding="utf-8-sig") as fh:
                reader = csv.DictReader(fh)
                cols = [c.lower().strip() for c in (reader.fieldnames or [])]
                line_col = _find_col(cols, ["handicaphome", "ahline", "line", "handicap", "ah_line"])
                home_col = _find_col(cols, ["hometeam", "home_team", "home"])
                away_col = _find_col(cols, ["awayteam", "away_team", "away"])
                date_col = _find_col(cols, ["date", "matchdate"])
                league_col = _find_col(cols, ["league", "div", "country"])

                if not line_col:
                    continue

                raw_cols = reader.fieldnames or []
                col_index = {c.lower().strip(): c for c in raw_cols}

                rows = list(reader)
                if len(rows) < 2:
                    continue

                def get_row(r: dict, key: Optional[str]) -> str:
                    return r.get(col_index.get(key or "", ""), "").strip() if key else ""

                # row 0 = closing, last = opening
                try:
                    ah_close = float(get_row(rows[0], line_col))
                    ah_open = float(get_row(rows[-1], line_col))
                except (ValueError, TypeError):
                    continue

                home_team = get_row(rows[0], home_col)
                away_team = get_row(rows[0], away_col)
                date = get_row(rows[0], date_col)
                league_raw = get_row(rows[0], league_col).lower()
                div = AH_LEAGUE_MAP.get(league_raw[:3], BTB_LEAGUE_MAP.get(league_raw, "UNK"))

                match_key = f"{date}_{home_team}_{away_team}"
                features.append({
                    "match_id": match_key,
                    "date": date,
                    "home": home_team,
                    "away": away_team,
                    "div": div,
                    "ah_open_line": round(ah_open, 2),
                    "ah_close_line": round(ah_close, 2),
                    "ah_close_delta": round(ah_close - ah_open, 2),
                })

        except Exception as exc:
            print(f"[ah] error reading {csv_path}: {exc}", file=sys.stderr)

    print(f"[ah] extracted AH features for {len(features)} matches")
    return features


# ── Merge and write ────────────────────────────────────────────────────────────

def merge_and_write(btb: list[dict], ah: list[dict], dry_run: bool) -> None:
    # Index AH by match_id for join
    ah_index: dict[str, dict] = {r["match_id"]: r for r in ah}

    merged: list[dict] = []
    for rec in btb:
        row: dict = dict(rec)
        ah_rec = ah_index.get(rec["match_id"], {})
        row["ah_open_line"] = ah_rec.get("ah_open_line", "")
        row["ah_close_line"] = ah_rec.get("ah_close_line", "")
        row["ah_close_delta"] = ah_rec.get("ah_close_delta", "")
        merged.append(row)

    # AH-only matches (not in BTB)
    btb_keys = {r["match_id"] for r in btb}
    for ah_rec in ah:
        if ah_rec["match_id"] not in btb_keys:
            row = {
                "match_id": ah_rec["match_id"],
                "date": ah_rec["date"],
                "home": ah_rec["home"],
                "away": ah_rec["away"],
                "div": ah_rec["div"],
                "line_movement_slope": "",
                "opening_to_close_delta": "",
                "ah_open_line": ah_rec["ah_open_line"],
                "ah_close_line": ah_rec["ah_close_line"],
                "ah_close_delta": ah_rec["ah_close_delta"],
            }
            merged.append(row)

    if not merged:
        print("[merge] no records to write")
        return

    if dry_run:
        print(f"[dry-run] would write {len(merged)} merged feature rows")
        if merged:
            print("  sample:", merged[0])
        return

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "odds_timeseries_features.csv"
    fieldnames = ["match_id", "date", "home", "away", "div",
                  "line_movement_slope", "opening_to_close_delta",
                  "ah_open_line", "ah_close_line", "ah_close_delta"]
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(merged)

    print(f"[merge] wrote {len(merged)} rows -> {out_path}")


# ── Helpers ────────────────────────────────────────────────────────────────────

def _find_col(cols: list[str], candidates: list[str]) -> Optional[str]:
    """Return first candidate that appears in the normalised column list."""
    for c in candidates:
        if c in cols:
            return c
    return None


# ── CLI ────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--btb-dir", type=Path, default=None,
                        help="Directory with Beat The Bookie CSV files")
    parser.add_argument("--ah-dir", type=Path, default=None,
                        help="Directory with AH Odds Time-Series CSV files")
    parser.add_argument("--dry-run", action="store_true", help="Parse and report without writing")
    args = parser.parse_args()

    if not args.btb_dir and not args.ah_dir:
        parser.error("Provide at least one of --btb-dir or --ah-dir.\n"
                     "Download datasets first:\n"
                     "  kaggle datasets download -d austro/beat-the-bookie-worldwide-football-dataset\n"
                     "  kaggle datasets download -d realsingwong/european-football-asian-handicap-odds-time-series")

    btb_features: list[dict] = []
    ah_features: list[dict] = []

    if args.btb_dir:
        btb_features = process_btb(args.btb_dir, args.dry_run)

    if args.ah_dir:
        ah_features = process_ah(args.ah_dir, args.dry_run)

    if btb_features or ah_features:
        merge_and_write(btb_features, ah_features, args.dry_run)
    else:
        print("[fetch_odds_timeseries] no data processed — check input directories")


if __name__ == "__main__":
    main()
