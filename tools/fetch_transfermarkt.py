"""
fetch_transfermarkt.py — Ingest Transfermarkt squad market values for ORACLE.

Squad market value ratio (home_value / away_value) is a validated prior for
Poisson models, especially in lower leagues and cups where Elo data is sparse.

Supports two Kaggle sources (download one, not both):
  Primary:   davidcariboo/player-scores  — comprehensive, weekly-updated
  Secondary: efeckgz/transfermarkt-squad-value-dataset  — squad-level aggregates

Download:
  kaggle datasets download -d davidcariboo/player-scores
  kaggle datasets download -d efeckgz/transfermarkt-squad-value-dataset

Output:
  .tmp/transfermarkt/squad_values.csv — team, season, total_market_value_eur
  .tmp/transfermarkt/squad_value_ratio.csv — match-level feature:
    date, home, away, div, home_squad_value, away_squad_value, squad_value_ratio

The squad_value_ratio is joined to GBM features in gbm_residual.py by
matching (date, home_team, away_team) to backfill records.

Usage:
    python tools/fetch_transfermarkt.py --player-scores-dir .tmp/kaggle/player-scores
    python tools/fetch_transfermarkt.py --squad-values-dir .tmp/kaggle/squad-values
    python tools/fetch_transfermarkt.py --dry-run
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / ".tmp" / "transfermarkt"

# Map common league names in Transfermarkt data → div codes
TM_LEAGUE_MAP: dict[str, str] = {
    "premier league":               "E0",
    "championship":                 "E1",
    "primera division":             "SP1",
    "la liga":                      "SP1",
    "bundesliga":                   "D1",
    "1. bundesliga":                "D1",
    "serie a":                      "I1",
    "ligue 1":                      "F1",
    "eredivisie":                   "N1",
    "jupiler pro league":           "B1",
    "primera liga":                 "P1",
    "primeira liga":                "P1",
    "scottish premiership":         "SC0",
    "major league soccer":          "MLS",
}


def _season_tag(date_str: str) -> str:
    try:
        year = int(date_str[:4])
        month = int(date_str[5:7])
        s = year if month >= 7 else year - 1
        return f"{str(s)[2:]}{str(s + 1)[2:]}"
    except Exception:
        return "unknown"


# ── player-scores dataset (davidcariboo) ──────────────────────────────────────

def load_player_scores(src_dir: Path) -> dict[tuple[str, str], float]:
    """
    Load squad total market value per (club, season) from davidcariboo/player-scores.

    Relevant files in the dataset:
      player_valuations.csv — player_id, date, market_value_in_eur, club_id
      clubs.csv             — club_id, name, domestic_competition_id
      players.csv           — player_id, current_club_id, name
    """
    valuations_path = _find_file(src_dir, "player_valuations.csv")

    if not valuations_path:
        print(f"[tm/player-scores] could not find player_valuations.csv in {src_dir}",
              file=sys.stderr)
        return {}

    # Aggregate: for each (club_name, season) sum player values per date, take max date
    # player_valuations.csv has current_club_name directly — no clubs.csv join needed
    season_totals: dict[tuple[str, str], dict[str, float]] = defaultdict(lambda: defaultdict(float))

    with open(valuations_path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            club = (row.get("current_club_name") or "").strip()
            date = (row.get("date") or "").strip()
            val_str = row.get("market_value_in_eur", "0") or "0"
            try:
                val = float(val_str)
            except (ValueError, TypeError):
                continue
            if not club or not date or val <= 0:
                continue
            season = _season_tag(date)
            season_totals[(club, season)][date] += val

    # Collapse to a single value per (club, season): max date-total
    result: dict[tuple[str, str], float] = {}
    for (club, season), date_totals in season_totals.items():
        result[(club, season)] = max(date_totals.values())

    print(f"[tm/player-scores] loaded squad values for {len(result)} club/season pairs")
    return result


# ── squad-values dataset (efeckgz) ────────────────────────────────────────────

def load_simple_squad_values(src_dir: Path) -> dict[tuple[str, str], float]:
    """
    Load simple squad-values teams.csv (Team Name / League / Squad Value).
    No season column — marks values as 'current' (season '2526').
    """
    csv_path = src_dir / "teams.csv"
    if not csv_path.exists():
        return {}
    result: dict[tuple[str, str], float] = {}
    with open(csv_path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            club = (row.get("Team Name") or "").strip()
            val_str = (row.get("Squad Value") or "").strip()
            try:
                val = float(val_str.replace(",", "")) * 1_000_000  # stored in millions
            except ValueError:
                continue
            if club:
                result[(club, "2526")] = val
    print(f"[tm/squad-values-simple] loaded {len(result)} club values from {csv_path.name}")
    return result


def load_squad_values(src_dir: Path) -> dict[tuple[str, str], float]:
    """
    Load squad total market value per (club, season) from efeckgz dataset.

    Expected CSV format: club, season (or year), total_value (or squad_value)
    """
    csv_path = _find_file(src_dir, "transfermarkt_squad_value")
    if not csv_path:
        csv_path = _find_first_csv(src_dir)
    if not csv_path:
        print(f"[tm/squad-values] no CSV found in {src_dir}", file=sys.stderr)
        return {}

    result: dict[tuple[str, str], float] = {}
    with open(csv_path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        cols = [c.lower().strip() for c in (reader.fieldnames or [])]
        club_col = _find_col(cols, ["club", "team", "club_name", "name"])
        season_col = _find_col(cols, ["season", "year", "season_year"])
        value_col = _find_col(cols, ["total_value", "squad_value", "market_value",
                                     "total_market_value", "value"])
        col_index = {c.lower().strip(): c for c in (reader.fieldnames or [])}

        for row in reader:
            def get(key: Optional[str]) -> str:
                return row.get(col_index.get(key or "", ""), "").strip() if key else ""

            club = get(club_col)
            season_raw = get(season_col)
            val_str = get(value_col)
            try:
                val = float(val_str.replace(",", "").replace("€", "").replace("m", "e6").replace("k", "e3"))
            except (ValueError, TypeError):
                continue
            if not club or not season_raw:
                continue
            # Normalise season: "2324" or "2023/24" or "2023" → "2324"
            season = _normalise_season(season_raw)
            result[(club, season)] = val

    print(f"[tm/squad-values] loaded squad values for {len(result)} club/season pairs")
    return result


def _normalise_season(s: str) -> str:
    s = s.strip()
    if "/" in s:
        parts = s.split("/")
        return parts[0][-2:] + parts[1][-2:]
    if len(s) == 4 and s.isdigit():
        # Could be "2324" already or "2023" meaning start year
        year = int(s)
        if year > 2000:
            return f"{str(year)[2:]}{str(year + 1)[2:]}"
        return s
    return s


# ── Match-level ratio builder ──────────────────────────────────────────────────

def build_ratio_features(
    squad_values: dict[tuple[str, str], float],
    backfill_dir: Path,
) -> list[dict]:
    """
    Join squad values to backfill match records to produce squad_value_ratio.
    Falls back to season-neighbouring values if exact season not found.
    """
    if not backfill_dir.exists():
        print(f"[tm] backfill dir not found: {backfill_dir}", file=sys.stderr)
        return []

    # Build quick lookup: club_lower → {season: value}
    club_season_map: dict[str, dict[str, float]] = defaultdict(dict)
    for (club, season), val in squad_values.items():
        club_season_map[club.lower()][season] = val

    features: list[dict] = []
    missing = 0

    for csv_path in sorted(backfill_dir.glob("*.csv")):
        fname = csv_path.stem  # e.g. "E0_2324"
        parts = fname.split("_")
        if len(parts) < 2:
            continue
        div, season = parts[0], parts[1]

        with open(csv_path, newline="", encoding="utf-8-sig") as fh:
            for row in csv.DictReader(fh):
                date = row.get("Date", row.get("date", ""))
                home = row.get("HomeTeam", row.get("home_team", row.get("home", "")))
                away = row.get("AwayTeam", row.get("away_team", row.get("away", "")))
                if not home or not away:
                    continue

                home_val = _lookup_value(club_season_map, home, season)
                away_val = _lookup_value(club_season_map, away, season)

                if home_val is None or away_val is None:
                    missing += 1
                    ratio = ""
                else:
                    ratio = round(home_val / away_val, 4) if away_val else ""

                features.append({
                    "date": date,
                    "home": home,
                    "away": away,
                    "div": div,
                    "season": season,
                    "home_squad_value": home_val if home_val is not None else "",
                    "away_squad_value": away_val if away_val is not None else "",
                    "squad_value_ratio": ratio,
                })

    total = len(features)
    print(f"[tm] built ratio features for {total} matches ({missing} missing values, "
          f"{total - missing} complete)")
    return features


def _lookup_value(
    club_map: dict[str, dict[str, float]],
    team: str,
    season: str,
) -> Optional[float]:
    """Lookup with fuzzy team name matching and adjacent-season fallback."""
    key = team.lower().strip()
    seasons = club_map.get(key, {})
    if season in seasons:
        return seasons[season]
    # Try adjacent seasons
    for adj in [_prev_season(season), _next_season(season)]:
        if adj in seasons:
            return seasons[adj]
    # Partial name match (first 6 chars)
    prefix = key[:6]
    for club_key, club_seasons in club_map.items():
        if club_key.startswith(prefix):
            if season in club_seasons:
                return club_seasons[season]
    return None


def _prev_season(s: str) -> str:
    try:
        y = int("20" + s[:2]) - 1
        return f"{str(y)[2:]}{s[:2]}"
    except Exception:
        return s


def _next_season(s: str) -> str:
    try:
        y = int("20" + s[2:]) + 1
        return f"{s[2:]}{str(y)[2:]}"
    except Exception:
        return s


# ── Helpers ────────────────────────────────────────────────────────────────────

def _find_file(base: Path, name_fragment: str) -> Optional[Path]:
    for p in base.rglob("*.csv"):
        if name_fragment.lower() in p.name.lower():
            return p
    return None


def _find_first_csv(base: Path) -> Optional[Path]:
    for p in base.rglob("*.csv"):
        return p
    return None


def _find_col(cols: list[str], candidates: list[str]) -> Optional[str]:
    for c in candidates:
        if c in cols:
            return c
    return None


# ── Write ──────────────────────────────────────────────────────────────────────

def write_output(features: list[dict], dry_run: bool) -> None:
    if not features:
        print("[tm] nothing to write")
        return

    if dry_run:
        print(f"[dry-run] would write {len(features)} squad_value_ratio rows")
        if features:
            print("  sample:", features[0])
        return

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "squad_value_ratio.csv"
    fieldnames = ["date", "home", "away", "div", "season",
                  "home_squad_value", "away_squad_value", "squad_value_ratio"]
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(features)
    print(f"[tm] wrote {len(features)} rows -> {out_path}")


# ── CLI ────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--player-scores-dir", type=Path, default=None,
                        help="davidcariboo/player-scores Kaggle download directory")
    parser.add_argument("--squad-values-dir", type=Path, default=None,
                        help="efeckgz/transfermarkt-squad-value-dataset Kaggle download directory")
    parser.add_argument("--backfill-dir", type=Path,
                        default=ROOT / ".tmp" / "backfill",
                        help="Directory with backfill CSVs (default: .tmp/backfill)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    squad_values: dict[tuple[str, str], float] = {}

    if args.player_scores_dir:
        squad_values.update(load_player_scores(args.player_scores_dir))

    if args.squad_values_dir:
        squad_values.update(load_squad_values(args.squad_values_dir))

    if not squad_values:
        parser.error(
            "No squad value data found. Provide --player-scores-dir or --squad-values-dir.\n"
            "Download first:\n"
            "  kaggle datasets download -d davidcariboo/player-scores\n"
            "  kaggle datasets download -d efeckgz/transfermarkt-squad-value-dataset"
        )

    print(f"[tm] total squad values loaded: {len(squad_values)}")

    features = build_ratio_features(squad_values, args.backfill_dir)
    write_output(features, args.dry_run)


if __name__ == "__main__":
    main()
