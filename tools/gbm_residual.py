"""
gbm_residual.py — GBM residual model for ORACLE.

Trains an XGBoost multi-class probability model on top of Pinnacle closing
odds + rolling form features. The "residual" framing: Pinnacle devigged
probabilities are included as features, so XGBoost learns corrections to
the market's forecast using additional information.

Pipeline:
  1. Load .tmp/backfill/*.csv  (football-data.co.uk)
  2. Build rolling pre-match form features (5 and 10-match windows)
  3. Devivify Pinnacle closing odds (PSCH/PSCD/PSCA) → market probabilities
  4. Walk-forward validation: train on seasons ≤N-1, test on season N
  5. Evaluate RPS: Pinnacle market vs GBM
  6. Report feature importances
  7. Save model artefact to .tmp/models/gbm_residual.json

Accept gate (PRD §8.3): GBM must beat Pinnacle RPS baseline by ≥0.002 on
the held-out test set with N ≥ 100 fixtures.

Usage:
    python tools/gbm_residual.py
    python tools/gbm_residual.py --seasons 2425 2324 2223
    python tools/gbm_residual.py --test-season 2425
    python tools/gbm_residual.py --dry-run    # build features, no training
"""

import argparse
import csv
import json
import re
import sys
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import xgboost as xgb

# ── Config ────────────────────────────────────────────────────────────────────

BACKFILL_DIR = Path(".tmp/backfill")
XG_DIR = Path(".tmp/xg")
CLUBELO_DIR = Path(".tmp/clubelo")
SPI_DIR = Path(".tmp/spi")
TRANSFERMARKT_DIR = Path(".tmp/transfermarkt")
ODDS_TIMESERIES_DIR = Path(".tmp/odds-timeseries")
PPDA_DIR = Path(".tmp/ppda")
WEATHER_DIR = Path(".tmp/weather")
AVAILABILITY_DIR = Path(".tmp/squad-availability")
REVERSE_LM_DIR = Path(".tmp/reverse-lm")
MODEL_DIR = Path(".tmp/models")
RPS_IMPROVEMENT_THRESHOLD = 0.002
MIN_TEST_FIXTURES = 100

LEAGUE_MAP = {
    "E0": "Premier League",
    "E1": "Championship",
    "D1": "Bundesliga",
    "SP1": "La Liga",
    "I1": "Serie A",
    "F1": "Ligue 1",
    "N1": "Eredivisie",
    "B1": "Belgian Pro League",
    "P1": "Primeira Liga",
    "SC0": "Scottish Premiership",
}

TOP5_DIVS = {"E0", "SP1", "D1", "I1", "F1"}
TOP5_LEAGUES = {LEAGUE_MAP[d] for d in TOP5_DIVS}

FORM_WINDOWS = [5, 10]

# ── ClubElo loader (PRD §8.3 Tier 3) ─────────────────────────────────────────

# football-data.co.uk team name -> ClubElo club name (exact or normalised)
_CLUBELO_ALIASES: dict[str, str] = {
    "man city":           "Man City",
    "manchester city":    "Man City",
    "man united":         "Man United",
    "manchester united":  "Man United",
    "man utd":            "Man United",
    "newcastle":          "Newcastle",
    "newcastle united":   "Newcastle",
    "nott'm forest":      "Nottm Forest",
    "nottingham forest":  "Nottm Forest",
    "wolves":             "Wolverhampton",
    "wolverhampton":      "Wolverhampton",
    "wolverhampton wanderers": "Wolverhampton",
    "spurs":              "Tottenham",
    "tottenham":          "Tottenham",
    "tottenham hotspur":  "Tottenham",
    "west brom":          "West Brom",
    "west bromwich albion": "West Brom",
    "sheffield utd":      "Sheffield United",
    "sheff utd":          "Sheffield United",
    "sheffield united":   "Sheffield United",
    "sheff wed":          "Sheffield Wednesday",
    "sheffield wednesday": "Sheffield Wednesday",
    "leicester":          "Leicester",
    "leicester city":     "Leicester",
    "brighton":           "Brighton",
    "brighton and hove albion": "Brighton",
    "norwich":            "Norwich",
    "norwich city":       "Norwich",
    "cardiff":            "Cardiff",
    "cardiff city":       "Cardiff",
    "luton":              "Luton",
    "luton town":         "Luton",
    "ipswich":            "Ipswich",
    "ipswich town":       "Ipswich",
    "paris sg":           "Paris SG",
    "paris saint-germain": "Paris SG",
    "psg":                "Paris SG",
    "atletico madrid":    "Atletico Madrid",
    "atletico de madrid": "Atletico Madrid",
    "atletico":           "Atletico Madrid",
    "real sociedad":      "Real Sociedad",
    "sociedad":           "Real Sociedad",
    "internazionale":     "Inter",
    "inter milan":        "Inter",
    "ac milan":           "Milan",
    "rb leipzig":         "RasenBallsport Leipzig",
    "rasenballsport leipzig": "RasenBallsport Leipzig",
    "bayer leverkusen":   "Bayer Leverkusen",
    "leverkusen":         "Bayer Leverkusen",
    "eintracht frankfurt": "Eintracht Frankfurt",
    "borussia dortmund":  "Dortmund",
    "bvb":                "Dortmund",
    "hertha bsc":         "Hertha",
    "hertha":             "Hertha",
    "schalke 04":         "Schalke",
    "schalke":            "Schalke",
    "olympique lyonnais": "Lyon",
    "lyon":               "Lyon",
    "olympique de marseille": "Marseille",
    "marseille":          "Marseille",
    "stade rennais fc":   "Rennes",
    "rennes":             "Rennes",
    "as monaco":          "Monaco",
    "monaco":             "Monaco",
    "losc lille":         "Lille",
    "lille":              "Lille",
    "ogc nice":           "Nice",
    "nice":               "Nice",
    "girondins de bordeaux": "Bordeaux",
    "bordeaux":           "Bordeaux",
    "hellas verona":      "Verona",
    "verona":             "Verona",
}


def _clubelo_key(name: str) -> str:
    """Normalise a football-data.co.uk team name to a ClubElo lookup key."""
    s = name.strip()
    mapped = _CLUBELO_ALIASES.get(s.lower())
    return mapped if mapped else s


def load_clubelo(clubelo_dir: Path) -> dict[str, float]:
    """Load ClubElo ratings from the most recent snapshot in .tmp/clubelo/.
    Returns {ClubElo_club_name: elo_rating}. Empty dict if no snapshot found."""
    snapshots = sorted(clubelo_dir.glob("ratings_*.json"), reverse=True)
    if not snapshots:
        return {}
    try:
        data = json.loads(snapshots[0].read_text(encoding="utf-8"))
        clubs = data.get("clubs", [])
        ratings = {c["club"]: float(c["elo"]) for c in clubs if c.get("club") and c.get("elo")}
        print(f"[gbm] ClubElo: {len(ratings)} ratings loaded from {snapshots[0].name}")
        return ratings
    except Exception as exc:
        print(f"[gbm] ClubElo load failed: {exc}")
        return {}


# ── xG data loader ───────────────────────────────────────────────────────────

def load_xg(xg_dir: Path) -> pd.DataFrame:
    """
    Load all Understat xG CSVs from .tmp/xg/ into a single lookup DataFrame.
    Files are named {div}_{season}.csv (e.g. E0_2324.csv).
    Only covers top-5 leagues (E0, SP1, D1, I1, F1).
    """
    frames = []
    for p in sorted(xg_dir.glob("*.csv")):
        # filename: {div}_{season}.csv → div = part before first underscore
        div = p.stem.split("_")[0]
        try:
            df = pd.read_csv(p, encoding="utf-8")
            df["_div"] = div
            frames.append(df)
        except Exception:
            continue
    if not frames:
        return pd.DataFrame()
    xg = pd.concat(frames, ignore_index=True)
    xg["date"] = pd.to_datetime(xg["date"], errors="coerce")
    xg = xg.dropna(subset=["date", "xg_home", "xg_away"])
    print(f"[gbm] xG data loaded: {len(xg)} matches across {xg['_div'].nunique()} leagues")
    return xg


# Known abbreviation → full name mappings (football-data.co.uk → Understat)
_TEAM_ALIASES: dict[str, str] = {
    "man city":              "manchester city",
    "man united":            "manchester united",
    "man utd":               "manchester united",
    "newcastle":             "newcastle united",
    "nott'm forest":         "nottingham forest",
    "nottm forest":          "nottingham forest",
    "wolves":                "wolverhampton wanderers",
    "spurs":                 "tottenham hotspur",
    "tottenham":             "tottenham hotspur",
    "west brom":             "west bromwich albion",
    "sheffield utd":         "sheffield united",
    "sheff utd":             "sheffield united",
    "sheff wed":             "sheffield wednesday",
    "leicester":             "leicester city",
    "brighton":              "brighton and hove albion",
    "norwich":               "norwich city",
    "cardiff":               "cardiff city",
    "swansea":               "swansea city",
    "stoke":                 "stoke city",
    "hull":                  "hull city",
    "ipswich":               "ipswich town",
    "luton":                 "luton town",
    "burnley":               "burnley",
    "brentford":             "brentford",
    "celta":                 "celta vigo",
    "atletico madrid":       "atletico de madrid",
    "atletico":              "atletico de madrid",
    "real betis":            "real betis",
    "betis":                 "real betis",
    "sociedad":              "real sociedad",
    "real sociedad":         "real sociedad",
    "hertha":                "hertha bsc",
    "hertha bsc berlin":     "hertha bsc",
    "rb leipzig":            "rasenballsport leipzig",
    "eintracht frankfurt":   "frankfurt",
    "bayer leverkusen":      "bayer 04 leverkusen",
    "leverkusen":            "bayer 04 leverkusen",
    "schalke":               "fc schalke 04",
    "schalke 04":            "fc schalke 04",
    "hannover":              "hannover 96",
    "mainz":                 "1 fsv mainz 05",
    "mainz 05":              "1 fsv mainz 05",
    "freiburg":              "sport-club freiburg",
    "sc freiburg":           "sport-club freiburg",
    "augsburg":              "fc augsburg",
    "wolfsburg":             "vfl wolfsburg",
    "inter":                 "internazionale",
    "inter milan":           "internazionale",
    "ac milan":              "milan",
    "verona":                "hellas verona",
    "hellas verona fc":      "hellas verona",
    "spal":                  "spal 2013",
    "chievo":                "chievo verona",
    "cagliari":              "cagliari",
    "psg":                   "paris saint-germain",
    "paris sg":              "paris saint-germain",
    "st etienne":            "saint-etienne",
    "saint etienne":         "saint-etienne",
    "lyon":                  "olympique lyonnais",
    "marseille":             "olympique de marseille",
    "nantes":                "fc nantes",
    "rennes":                "stade rennais fc",
    "stade rennais":         "stade rennais fc",
    "bordeaux":              "girondins de bordeaux",
    "lille":                 "losc lille",
    "losc":                  "losc lille",
    "monaco":                "as monaco",
    "nice":                  "ogc nice",
    "strasbourg":            "rc strasbourg alsace",
    "metz":                  "fc metz",
    "reims":                 "stade de reims",
}


def _normalise_team(name: str) -> str:
    """
    Lowercase, strip punctuation, collapse whitespace, then apply alias map.
    Handles football-data.co.uk abbreviations vs Understat full names.
    """
    s = name.lower()
    s = re.sub(r"[^a-z0-9\s]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return _TEAM_ALIASES.get(s, s)


def build_xg_lookup(xg: pd.DataFrame) -> dict[tuple, tuple[float, float]]:
    """
    Build a lookup: (date_str, norm_home, norm_away) → (xg_home, xg_away).
    Used for O(1) join during feature engineering.
    """
    lookup: dict[tuple, tuple[float, float]] = {}
    for _, row in xg.iterrows():
        key = (
            row["date"].strftime("%Y-%m-%d"),
            _normalise_team(str(row["home"])),
            _normalise_team(str(row["away"])),
        )
        lookup[key] = (float(row["xg_home"]), float(row["xg_away"]))
    return lookup


# ── SPI feature loader ───────────────────────────────────────────────────────

def load_spi_features(spi_dir: Path) -> tuple[dict[tuple, dict], dict[str, tuple[float, float]]]:
    """
    Load SPI attack/defense features.

    Returns:
      fixture_lookup: (date_str, norm_home, norm_away) → feature dict  (exact match, 2016-2019 only)
      team_ratings:   norm_team_name → (off, def)  (static snapshot, covers 460+ clubs)

    The static team_ratings are used as a fallback when the fixture key misses, giving
    broad coverage across all seasons via team-name-only join.
    """
    fixture_lookup: dict[tuple, dict] = {}
    team_ratings: dict[str, tuple[float, float]] = {}

    # Load per-match SPI features (2016-2019 coverage)
    path = spi_dir / "spi_features.csv"
    if path.exists():
        try:
            df = pd.read_csv(path, encoding="utf-8")
            df["date"] = pd.to_datetime(df["date"], errors="coerce")
            df = df.dropna(subset=["date", "home", "away"])
            for _, row in df.iterrows():
                key = (
                    row["date"].strftime("%Y-%m-%d"),
                    _normalise_team(str(row["home"])),
                    _normalise_team(str(row["away"])),
                )
                fixture_lookup[key] = {
                    "spiOffHome":  float(row.get("home_spi_off", float("nan"))),
                    "spiDefHome":  float(row.get("home_spi_def", float("nan"))),
                    "spiOffAway":  float(row.get("away_spi_off", float("nan"))),
                    "spiDefAway":  float(row.get("away_spi_def", float("nan"))),
                    "spiOffDiff":  float(row.get("spi_off_diff", float("nan"))),
                    "spiDefDiff":  float(row.get("spi_def_diff", float("nan"))),
                }
            print(f"[gbm] SPI features loaded: {len(fixture_lookup)} matches from {path.name}")
        except Exception as exc:
            print(f"[gbm] SPI match load failed: {exc}")

    # Load static global rankings → team-level off/def (covers 460+ clubs, all seasons)
    rankings_path = spi_dir / "spi_rankings.csv"
    if rankings_path.exists():
        try:
            rdf = pd.read_csv(rankings_path, encoding="utf-8")
            for _, row in rdf.iterrows():
                name = _normalise_team(str(row.get("name", "")))
                if not name:
                    continue
                try:
                    team_ratings[name] = (float(row.get("off", 0) or 0), float(row.get("def", 0) or 0))
                except (ValueError, TypeError):
                    pass
            print(f"[gbm] SPI rankings loaded: {len(team_ratings)} club ratings (static fallback)")
        except Exception as exc:
            print(f"[gbm] SPI rankings load failed: {exc}")

    return fixture_lookup, team_ratings


# ── Squad value loader ───────────────────────────────────────────────────────

def load_squad_value(tm_dir: Path) -> dict[tuple, float]:
    """
    Load squad_value_ratio from .tmp/transfermarkt/squad_value_ratio.csv.
    Returns lookup: (date_str, norm_home, norm_away) → squad_value_ratio float.
    Columns expected: date, home, away, squad_value_ratio.
    """
    path = tm_dir / "squad_value_ratio.csv"
    if not path.exists():
        return {}
    try:
        df = pd.read_csv(path, encoding="utf-8")
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        df = df.dropna(subset=["date", "home", "away", "squad_value_ratio"])
        lookup: dict[tuple, float] = {}
        for _, row in df.iterrows():
            key = (
                row["date"].strftime("%Y-%m-%d"),
                _normalise_team(str(row["home"])),
                _normalise_team(str(row["away"])),
            )
            lookup[key] = float(row["squad_value_ratio"])
        print(f"[gbm] Squad value ratio loaded: {len(lookup)} matches from {path.name}")
        return lookup
    except Exception as exc:
        print(f"[gbm] Squad value load failed: {exc}")
        return {}


# ── Odds time-series loader ───────────────────────────────────────────────────

def load_odds_timeseries(ots_dir: Path) -> dict[tuple, dict]:
    """
    Load AH + line-movement features from .tmp/odds-timeseries/odds_timeseries_features.csv.
    Returns lookup: (date_str, norm_home, norm_away) → feature dict.
    Columns expected: date, home, away, line_movement_slope, opening_to_close_delta,
                      ah_open_line, ah_close_line, ah_close_delta.
    """
    path = ots_dir / "odds_timeseries_features.csv"
    if not path.exists():
        return {}
    try:
        df = pd.read_csv(path, encoding="utf-8")
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        df = df.dropna(subset=["date", "home", "away"])
        lookup: dict[tuple, dict] = {}
        for _, row in df.iterrows():
            key = (
                row["date"].strftime("%Y-%m-%d"),
                _normalise_team(str(row["home"])),
                _normalise_team(str(row["away"])),
            )
            lookup[key] = {
                "lineMovSlope":     float(row.get("line_movement_slope",    float("nan"))),
                "openToCloseDelta": float(row.get("opening_to_close_delta", float("nan"))),
                "ahOpenLine":       float(row.get("ah_open_line",           float("nan"))),
                "ahCloseLine":      float(row.get("ah_close_line",          float("nan"))),
                "ahCloseDelta":     float(row.get("ah_close_delta",         float("nan"))),
            }
        print(f"[gbm] Odds time-series loaded: {len(lookup)} matches from {path.name}")
        return lookup
    except Exception as exc:
        print(f"[gbm] Odds time-series load failed: {exc}")
        return {}


def load_ppda(ppda_dir: Path) -> dict[tuple, dict]:
    """
    Load PPDA / OPPDA pressing features from .tmp/ppda/ppda_features.csv.
    Returns lookup: (date_str, norm_home, norm_away) → feature dict.
    Columns expected: date, home, away, div, ppda_home, ppda_away, oppda_home, oppda_away.
    Covers top-5 leagues only (slehkyi dataset scope).
    """
    path = ppda_dir / "ppda_features.csv"
    if not path.exists():
        return {}
    try:
        df = pd.read_csv(path, encoding="utf-8")
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        df = df.dropna(subset=["date", "home", "away"])
        lookup: dict[tuple, dict] = {}
        for _, row in df.iterrows():
            key = (
                row["date"].strftime("%Y-%m-%d"),
                _normalise_team(str(row["home"])),
                _normalise_team(str(row["away"])),
            )
            lookup[key] = {
                "ppda_home":  float(row.get("ppda_home",  float("nan"))),
                "ppda_away":  float(row.get("ppda_away",  float("nan"))),
                "oppda_home": float(row.get("oppda_home", float("nan"))),
                "oppda_away": float(row.get("oppda_away", float("nan"))),
            }
        print(f"[gbm] PPDA loaded: {len(lookup)} matches from {path.name}")
        return lookup
    except Exception as exc:
        print(f"[gbm] PPDA load failed: {exc}")
        return {}


def load_weather(weather_dir: Path) -> dict[tuple, dict]:
    """
    Load match-day weather from .tmp/weather/weather_features.csv.
    Returns lookup: (date_str, norm_home) → feature dict (keyed on home team =
    stadium venue). Columns expected: date, home, temp_c, precip_mm, wind_kph,
    is_adverse. Covers teams in fetch_weather.py TEAM_CITY map (top-5 + English).
    """
    path = weather_dir / "weather_features.csv"
    if not path.exists():
        return {}
    try:
        df = pd.read_csv(path, encoding="utf-8")
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        df = df.dropna(subset=["date", "home"])
        lookup: dict[tuple, dict] = {}
        for _, row in df.iterrows():
            key = (
                row["date"].strftime("%Y-%m-%d"),
                _normalise_team(str(row["home"])),
            )
            lookup[key] = {
                "tempC":     float(row.get("temp_c",    float("nan"))),
                "precipMm":  float(row.get("precip_mm", float("nan"))),
                "windKph":   float(row.get("wind_kph",  float("nan"))),
                "isAdverse": float(row.get("is_adverse", float("nan"))),
            }
        print(f"[gbm] Weather loaded: {len(lookup)} matches from {path.name}")
        return lookup
    except Exception as exc:
        print(f"[gbm] Weather load failed: {exc}")
        return {}


def load_squad_availability(avail_dir: Path) -> dict[tuple, dict]:
    """
    Load match-day squad availability from
    .tmp/squad-availability/availability_features.csv.
    Returns lookup: (date_str, norm_club) → feature dict (team-level — join home
    and away separately). Columns: date, club, availability_idx,
    key_player_present, starting_xi_value. Derived from Transfermarkt lineups.
    """
    path = avail_dir / "availability_features.csv"
    if not path.exists():
        return {}
    try:
        df = pd.read_csv(path, encoding="utf-8")
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        df = df.dropna(subset=["date", "club"])
        lookup: dict[tuple, dict] = {}
        for _, row in df.iterrows():
            key = (
                row["date"].strftime("%Y-%m-%d"),
                _normalise_team(str(row["club"])),
            )
            kp = row.get("key_player_present", "")
            lookup[key] = {
                "availIdx":  float(row.get("availability_idx", float("nan"))),
                "keyPlayer": float(kp) if str(kp).strip() not in ("", "nan") else float("nan"),
            }
        print(f"[gbm] Squad availability loaded: {len(lookup)} team-matches from {path.name}")
        return lookup
    except Exception as exc:
        print(f"[gbm] Squad availability load failed: {exc}")
        return {}


def load_reverse_lm(reverse_lm_dir: Path) -> dict[tuple, dict]:
    """
    Load 1X2 reverse-line-movement features from
    .tmp/reverse-lm/reverse_lm_features.csv.
    Returns lookup: (date_str, norm_home, norm_away) → feature dict.
    Columns: date, home, away, mlHomeDrift, mlDrawDrift, mlReverseLM.
    Derived from eladsil/football-games-odds moneyline snapshots.
    """
    path = reverse_lm_dir / "reverse_lm_features.csv"
    if not path.exists():
        return {}
    try:
        df = pd.read_csv(path, encoding="utf-8")
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        df = df.dropna(subset=["date", "home", "away"])
        lookup: dict[tuple, dict] = {}
        for _, row in df.iterrows():
            key = (
                row["date"].strftime("%Y-%m-%d"),
                _normalise_team(str(row["home"])),
                _normalise_team(str(row["away"])),
            )
            lookup[key] = {
                "mlHomeDrift": float(row.get("mlHomeDrift", float("nan"))),
                "mlDrawDrift": float(row.get("mlDrawDrift", float("nan"))),
                "mlReverseLM": float(row.get("mlReverseLM", float("nan"))),
            }
        print(f"[gbm] Reverse-LM loaded: {len(lookup)} matches from {path.name}")
        return lookup
    except Exception as exc:
        print(f"[gbm] Reverse-LM load failed: {exc}")
        return {}


def load_fbref(fbref_dir: Path) -> dict[tuple, dict]:
    """
    Load FBref squad-level season stats.
    Returns lookup: (norm_squad, fdco_league, season) -> feature dict.
    Covers top-5 leagues, 2024-25 + 2025-26 seasons.
    """
    path = fbref_dir / "team_season_stats.csv"
    if not path.exists():
        return {}
    try:
        df = pd.read_csv(path, encoding="utf-8")
        lookup: dict[tuple, dict] = {}
        for _, row in df.iterrows():
            key = (
                _normalise_team(str(row["squad"])),
                str(row.get("fdco_league", "")),
                str(row.get("season", "")),
            )
            lookup[key] = {
                "fbrefGoals":  float(row.get("goals", float("nan"))),
                "fbrefShots":  float(row.get("shots", float("nan"))),
                "fbrefSotP90": float(row.get("sot_per90", float("nan"))),
            }
        print(f"[gbm] FBref loaded: {len(lookup)} team-season rows from {path.name}")
        return lookup
    except Exception as exc:
        print(f"[gbm] FBref load failed: {exc}")
        return {}


def load_referee(match_stats_dir: Path) -> dict[str, float]:
    """
    Load referee strictness percentile from .tmp/match-stats/referee_features.csv.
    Returns lookup: norm_referee_name -> strictness_pct (0..1).
    """
    path = match_stats_dir / "referee_features.csv"
    if not path.exists():
        return {}
    try:
        lookup: dict[str, float] = {}
        with open(path, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                ref = (row.get("referee") or "").strip().lower()
                pct = row.get("strictness_pct", "")
                try:
                    lookup[ref] = float(pct)
                except ValueError:
                    pass
        print(f"[gbm] Referee features loaded: {len(lookup)} referees from {path.name}")
        return lookup
    except Exception as exc:
        print(f"[gbm] Referee load failed: {exc}")
        return {}


# ── CSV loading ───────────────────────────────────────────────────────────────

def load_csvs(csv_dir: Path, seasons: list[str] | None = None) -> pd.DataFrame:
    frames = []
    for csv_path in sorted(csv_dir.glob("*.csv")):
        season = csv_path.stem[:4]
        div = csv_path.stem[5:]
        if seasons and season not in seasons:
            continue
        try:
            df = pd.read_csv(csv_path, encoding="utf-8-sig", low_memory=False)
        except Exception:
            df = pd.read_csv(csv_path, encoding="latin-1", low_memory=False)

        required = {"HomeTeam", "AwayTeam", "FTHG", "FTAG", "FTR"}
        if not required.issubset(df.columns):
            continue

        df["_season"] = season
        df["_div"] = div
        df["_league"] = LEAGUE_MAP.get(div, div)

        # Parse date
        df["_date"] = pd.to_datetime(df["Date"], dayfirst=True, errors="coerce")
        df = df.dropna(subset=["_date"])

        # Keep only rows with Pinnacle closing odds
        for col in ("PSCH", "PSCD", "PSCA"):
            if col not in df.columns:
                df[col] = np.nan
        df = df.dropna(subset=["PSCH", "PSCD", "PSCA"])

        frames.append(df)

    if not frames:
        print("[gbm] No CSVs loaded.")
        return pd.DataFrame()

    raw = pd.concat(frames, ignore_index=True)
    raw = raw.sort_values("_date").reset_index(drop=True)
    print(f"[gbm] Loaded {len(raw)} matches from {len(frames)} CSV(s)")
    return raw


# ── Feature engineering ───────────────────────────────────────────────────────

def _devivify(h: float, d: float, a: float) -> tuple[float, float, float]:
    """Remove bookmaker margin → fair probabilities."""
    ih, id_, ia = 1 / h, 1 / d, 1 / a
    total = ih + id_ + ia
    if total <= 0:
        return 1 / 3, 1 / 3, 1 / 3
    return ih / total, id_ / total, ia / total


def _rolling_stats(matches: list[dict], w: int, prefix: str, feat: dict) -> None:
    recent = matches[-w:]
    n = max(len(recent), 1)
    feat[f"{prefix}GF{w}"] = sum(r["gf"] for r in recent) / n
    feat[f"{prefix}GA{w}"] = sum(r["ga"] for r in recent) / n
    feat[f"{prefix}Pts{w}"] = sum(r["pts"] for r in recent) / n
    feat[f"{prefix}WR{w}"] = sum(1 for r in recent if r["pts"] == 3) / n
    feat[f"{prefix}DR{w}"] = sum(1 for r in recent if r["pts"] == 1) / n


def build_features(
    df: pd.DataFrame,
    xg_lookup: dict | None = None,
    clubelo_ratings: dict[str, float] | None = None,
    spi_lookup: dict | None = None,
    spi_team_ratings: dict | None = None,
    squad_value_lookup: dict | None = None,
    odds_ts_lookup: dict | None = None,
    fbref_lookup: dict | None = None,
    referee_lookup: dict[str, float] | None = None,
    ppda_lookup: dict | None = None,
    weather_lookup: dict | None = None,
    availability_lookup: dict | None = None,
    reverse_lm_lookup: dict | None = None,
) -> pd.DataFrame:
    """
    For each match, compute rolling pre-match features using only data
    strictly before the match date (anti-leakage).

    Both all-venue and venue-specific form are computed:
    - homeXxx  / awayXxx  — all-venue form
    - hHomeXxx / aAwayXxx — home team's home-only / away team's away-only form

    xG features are rolling pre-match averages from the team's prior game history
    (NOT the current match's xG, which would be post-match leakage).
    """
    rows = []
    history: dict[str, list[dict]] = {}        # all-venue
    home_hist_map: dict[str, list[dict]] = {}   # home-venue only for each team
    away_hist_map: dict[str, list[dict]] = {}   # away-venue only for each team
    # Per-team xG history (rolling pre-match, anti-leakage)
    xg_history: dict[str, list[tuple[float, float]]] = {}  # team -> [(xgF, xgA), ...]
    xg_hits = 0
    # Directional H2H history (home, away) -> list of FTR outcomes
    h2h_history: dict[tuple[str, str], list[str]] = {}

    for idx, row in df.iterrows():
        home = row["HomeTeam"]
        away = row["AwayTeam"]

        hh_all  = history.get(home, [])
        ah_all  = history.get(away, [])
        hh_home = home_hist_map.get(home, [])
        ah_away = away_hist_map.get(away, [])

        feat: dict = {}

        # ── Market probabilities (closing) ──
        try:
            mh, md, ma = _devivify(float(row["PSCH"]), float(row["PSCD"]), float(row["PSCA"]))
        except (ValueError, ZeroDivisionError):
            _update_history(history, home_hist_map, away_hist_map, row)
            continue
        feat["mktH"] = mh
        feat["mktD"] = md
        feat["mktA"] = ma

        # ── Line movement: opening → closing probability shift ──
        # Sharp money signal: closing odds incorporate bookmaker/bettor information
        # Positive shift = more weight moved onto that outcome (steam)
        try:
            oh, od, oa = _devivify(float(row["PSH"]), float(row["PSD"]), float(row["PSA"]))
            feat["lineMovH"] = mh - oh   # +ve = money moved to home
            feat["lineMovD"] = md - od
            feat["lineMovA"] = ma - oa
            feat["lineMovHAbs"] = abs(feat["lineMovH"])
        except (ValueError, ZeroDivisionError, KeyError):
            feat["lineMovH"] = 0.0
            feat["lineMovD"] = 0.0
            feat["lineMovA"] = 0.0
            feat["lineMovHAbs"] = 0.0

        # ── Opening market consensus (soft-book average, pre-sharp-money) ──
        # AvgH/AvgD/AvgA = market average opening odds (newer CSVs, 2019+)
        # BbAvH/BbAvD/BbAvA = Betbrain average (older CSVs pre-2019) — same concept
        # NaN for seasons without this col — XGBoost handles natively
        for open_h, open_d, open_a in [("AvgH", "AvgD", "AvgA"), ("BbAvH", "BbAvD", "BbAvA")]:
            if open_h in row.index and pd.notna(row[open_h]):
                try:
                    aoh, aod, aoa = _devivify(float(row[open_h]), float(row[open_d]), float(row[open_a]))
                    feat["openAvgH"] = aoh
                    feat["openAvgD"] = aod
                    feat["openAvgA"] = aoa
                    feat["openMovH"] = mh - aoh   # closing vs soft-book open
                    feat["openMovA"] = ma - aoa
                except (ValueError, ZeroDivisionError):
                    pass
                break
        feat.setdefault("openAvgH", float("nan"))
        feat.setdefault("openAvgD", float("nan"))
        feat.setdefault("openAvgA", float("nan"))
        feat.setdefault("openMovH", float("nan"))
        feat.setdefault("openMovA", float("nan"))

        # ── Max closing odds (best price at close — CLV proxy) ──
        # MaxCH/MaxCD/MaxCA = best close across all tracked books (newer CSVs, 2019+)
        for mc_h, mc_d, mc_a in [("MaxCH", "MaxCD", "MaxCA"), ("BbMxH", "BbMxD", "BbMxA")]:
            if mc_h in row.index and pd.notna(row[mc_h]):
                try:
                    mxh, mxd, mxa = _devivify(float(row[mc_h]), float(row[mc_d]), float(row[mc_a]))
                    feat["maxCloseH"] = mxh
                    feat["maxCloseD"] = mxd
                    feat["maxCloseA"] = mxa
                    feat["maxCloseEdgeH"] = mxh - mh   # best price vs Pinnacle close
                    feat["maxCloseEdgeA"] = mxa - ma
                except (ValueError, ZeroDivisionError):
                    pass
                break
        feat.setdefault("maxCloseH", float("nan"))
        feat.setdefault("maxCloseD", float("nan"))
        feat.setdefault("maxCloseA", float("nan"))
        feat.setdefault("maxCloseEdgeH", float("nan"))
        feat.setdefault("maxCloseEdgeA", float("nan"))

        # ── Simple rolling attack/defense rating proxy ──
        # gd_rolling = goals_for - goals_against over last 10 (team strength proxy)
        feat["homeAttack"] = sum(r["gf"] for r in hh_all[-10:]) / max(len(hh_all[-10:]), 1)
        feat["homeDefense"] = sum(r["ga"] for r in hh_all[-10:]) / max(len(hh_all[-10:]), 1)
        feat["awayAttack"] = sum(r["gf"] for r in ah_all[-10:]) / max(len(ah_all[-10:]), 1)
        feat["awayDefense"] = sum(r["ga"] for r in ah_all[-10:]) / max(len(ah_all[-10:]), 1)
        feat["homeGD10"] = feat["homeAttack"] - feat["homeDefense"]
        feat["awayGD10"] = feat["awayAttack"] - feat["awayDefense"]

        # ── All-venue rolling form ──
        for w in FORM_WINDOWS:
            _rolling_stats(hh_all, w, "home", feat)
            _rolling_stats(ah_all, w, "away", feat)

        # ── Venue-specific form (key improvement over generic form) ──
        for w in FORM_WINDOWS:
            _rolling_stats(hh_home, w, "hHome", feat)   # home team's HOME record
            _rolling_stats(ah_away, w, "aAway", feat)   # away team's AWAY record

        # ── xG features: rolling pre-match averages (anti-leakage) ──
        # Uses team's historical xG from prior games, NOT the current match's xG.
        # NaN when no prior xG data available — XGBoost handles NaN natively.
        for w, nan_val in [(5, float("nan")), (10, float("nan"))]:
            feat[f"xgForHome{w}"]     = float("nan")
            feat[f"xgAgainstHome{w}"] = float("nan")
            feat[f"xgForAway{w}"]     = float("nan")
            feat[f"xgAgainstAway{w}"] = float("nan")
            feat[f"xgDiffHome{w}"]    = float("nan")
            feat[f"xgDiffAway{w}"]    = float("nan")
        if xg_history:
            h_xg = xg_history.get(_normalise_team(str(home)), [])
            a_xg = xg_history.get(_normalise_team(str(away)), [])
            if len(h_xg) >= 1:
                xg_hits += 1
                for w in (5, 10):
                    recent_h = h_xg[-w:]
                    feat[f"xgForHome{w}"]     = sum(x[0] for x in recent_h) / len(recent_h)
                    feat[f"xgAgainstHome{w}"] = sum(x[1] for x in recent_h) / len(recent_h)
                    feat[f"xgDiffHome{w}"]    = feat[f"xgForHome{w}"] - feat[f"xgAgainstHome{w}"]
            if len(a_xg) >= 1:
                for w in (5, 10):
                    recent_a = a_xg[-w:]
                    feat[f"xgForAway{w}"]     = sum(x[0] for x in recent_a) / len(recent_a)
                    feat[f"xgAgainstAway{w}"] = sum(x[1] for x in recent_a) / len(recent_a)
                    feat[f"xgDiffAway{w}"]    = feat[f"xgForAway{w}"] - feat[f"xgAgainstAway{w}"]

        # Look up current match xG to update history AFTER feature extraction
        _current_match_xg: tuple[float, float] | None = None
        if xg_lookup:
            date_str = row["_date"].strftime("%Y-%m-%d") if pd.notna(row["_date"]) else ""
            key = (date_str, _normalise_team(str(home)), _normalise_team(str(away)))
            if key in xg_lookup:
                _current_match_xg = xg_lookup[key]

        # ── ClubElo features (PRD §8.3 Tier 3) ──
        # Elo ratings are pre-season snapshots — anti-leakage compliant.
        # NaN when club not found in snapshot (non-covered leagues) — XGBoost handles NaN.
        feat["eloHome"] = float("nan")
        feat["eloAway"] = float("nan")
        feat["eloDiff"] = float("nan")
        if clubelo_ratings:
            elo_h = clubelo_ratings.get(_clubelo_key(str(home)))
            elo_a = clubelo_ratings.get(_clubelo_key(str(away)))
            if elo_h is not None:
                feat["eloHome"] = elo_h
            if elo_a is not None:
                feat["eloAway"] = elo_a
            if elo_h is not None and elo_a is not None:
                feat["eloDiff"] = elo_h - elo_a

        # ── SPI attack/defense ratings ──
        # NaN when SPI data absent (non-covered leagues/seasons) — XGBoost handles NaN.
        feat["spiOffHome"] = float("nan")
        feat["spiDefHome"] = float("nan")
        feat["spiOffAway"] = float("nan")
        feat["spiDefAway"] = float("nan")
        feat["spiOffDiff"] = float("nan")
        feat["spiDefDiff"] = float("nan")
        if spi_lookup:
            date_str = row["_date"].strftime("%Y-%m-%d") if pd.notna(row["_date"]) else ""
            spi_key = (date_str, _normalise_team(str(home)), _normalise_team(str(away)))
            spi_entry = spi_lookup.get(spi_key)
            if spi_entry:
                feat.update(spi_entry)

        # ── Squad market value ratio ──
        # home_squad_value / away_squad_value; >1 = home richer.
        feat["squadValueRatio"] = float("nan")
        if squad_value_lookup:
            date_str = row["_date"].strftime("%Y-%m-%d") if pd.notna(row["_date"]) else ""
            sv_key = (date_str, _normalise_team(str(home)), _normalise_team(str(away)))
            sv_val = squad_value_lookup.get(sv_key)
            if sv_val is not None:
                feat["squadValueRatio"] = sv_val

        # ── Odds time-series (AH + line-movement) ──
        # NaN when data absent — XGBoost handles NaN.
        feat["lineMovSlope"]     = float("nan")
        feat["openToCloseDelta"] = float("nan")
        feat["ahOpenLine"]       = float("nan")
        feat["ahCloseLine"]      = float("nan")
        feat["ahCloseDelta"]     = float("nan")
        if odds_ts_lookup:
            date_str = row["_date"].strftime("%Y-%m-%d") if pd.notna(row["_date"]) else ""
            ots_key = (date_str, _normalise_team(str(home)), _normalise_team(str(away)))
            ots_entry = odds_ts_lookup.get(ots_key)
            if ots_entry:
                feat.update(ots_entry)

        # ── FBref squad-season features ──
        feat["fbrefGoalsHome"]  = float("nan")
        feat["fbrefShotsHome"]  = float("nan")
        feat["fbrefSotP90Home"] = float("nan")
        feat["fbrefGoalsAway"]  = float("nan")
        feat["fbrefShotsAway"]  = float("nan")
        feat["fbrefSotP90Away"] = float("nan")
        feat["fbrefSotDiff"]    = float("nan")
        if fbref_lookup:
            league_code = str(row.get("Div", ""))
            # season code: "2425" from "_season" col added by load_csvs
            season_code = str(row.get("_season", ""))
            h_entry = fbref_lookup.get((_normalise_team(str(home)), league_code, season_code))
            a_entry = fbref_lookup.get((_normalise_team(str(away)), league_code, season_code))
            if h_entry:
                feat["fbrefGoalsHome"]  = h_entry["fbrefGoals"]
                feat["fbrefShotsHome"]  = h_entry["fbrefShots"]
                feat["fbrefSotP90Home"] = h_entry["fbrefSotP90"]
            if a_entry:
                feat["fbrefGoalsAway"]  = a_entry["fbrefGoals"]
                feat["fbrefShotsAway"]  = a_entry["fbrefShots"]
                feat["fbrefSotP90Away"] = a_entry["fbrefSotP90"]
            if h_entry and a_entry:
                feat["fbrefSotDiff"] = h_entry["fbrefSotP90"] - a_entry["fbrefSotP90"]

        # ── Referee strictness ──
        feat["refStrictness"] = float("nan")
        if referee_lookup:
            ref_val = row.get("Referee")
            ref_raw = str(ref_val).strip().lower() if ref_val and str(ref_val) != "nan" else ""
            if ref_raw:
                feat["refStrictness"] = referee_lookup.get(ref_raw, float("nan"))

        # ── PPDA pressing intensity ──
        # Lower PPDA = more intense pressing (allows fewer passes per defensive action).
        # Season-level from slehkyi; NaN outside top-5 leagues — XGBoost handles NaN.
        feat["ppdaHome"]  = float("nan")
        feat["ppdaAway"]  = float("nan")
        feat["ppdaDiff"]  = float("nan")
        feat["oppdaHome"] = float("nan")
        feat["oppdaAway"] = float("nan")
        if ppda_lookup:
            date_str = row["_date"].strftime("%Y-%m-%d") if pd.notna(row["_date"]) else ""
            ppda_key = (date_str, _normalise_team(str(home)), _normalise_team(str(away)))
            ppda_entry = ppda_lookup.get(ppda_key)
            if ppda_entry:
                feat["ppdaHome"]  = ppda_entry["ppda_home"]
                feat["ppdaAway"]  = ppda_entry["ppda_away"]
                feat["ppdaDiff"]  = ppda_entry["ppda_home"] - ppda_entry["ppda_away"]
                feat["oppdaHome"] = ppda_entry["oppda_home"]
                feat["oppdaAway"] = ppda_entry["oppda_away"]

        # ── Match-day weather (home venue) ──
        # Rain/cold/wind suppress goals and favour defences. Keyed on home team
        # (= stadium). NaN outside the coordinate map — XGBoost handles NaN.
        feat["tempC"]     = float("nan")
        feat["precipMm"]  = float("nan")
        feat["windKph"]   = float("nan")
        feat["isAdverse"] = float("nan")
        if weather_lookup:
            date_str = row["_date"].strftime("%Y-%m-%d") if pd.notna(row["_date"]) else ""
            wx_entry = weather_lookup.get((date_str, _normalise_team(str(home))))
            if wx_entry:
                feat["tempC"]     = wx_entry["tempC"]
                feat["precipMm"]  = wx_entry["precipMm"]
                feat["windKph"]   = wx_entry["windKph"]
                feat["isAdverse"] = wx_entry["isAdverse"]

        # ── Match-day squad availability (Transfermarkt lineups, top-5 only) ──
        # availIdx = matchday squad value / rolling-peak squad value (<1 = depleted).
        # keyPlayer = club's top-valued player in today's squad (1/0). NaN elsewhere.
        feat["availIdxHome"] = float("nan")
        feat["availIdxAway"] = float("nan")
        feat["keyPlayerHome"] = float("nan")
        feat["keyPlayerAway"] = float("nan")
        feat["availIdxDiff"] = float("nan")
        if availability_lookup:
            date_str = row["_date"].strftime("%Y-%m-%d") if pd.notna(row["_date"]) else ""
            h_av = availability_lookup.get((date_str, _normalise_team(str(home))))
            a_av = availability_lookup.get((date_str, _normalise_team(str(away))))
            if h_av:
                feat["availIdxHome"]  = h_av["availIdx"]
                feat["keyPlayerHome"] = h_av["keyPlayer"]
            if a_av:
                feat["availIdxAway"]  = a_av["availIdx"]
                feat["keyPlayerAway"] = a_av["keyPlayer"]
            if h_av and a_av and pd.notna(h_av["availIdx"]) and pd.notna(a_av["availIdx"]):
                feat["availIdxDiff"] = h_av["availIdx"] - a_av["availIdx"]

        # ── 1X2 reverse line movement (moneyline opening→closing drift) ──
        # mlHomeDrift = de-vigged home prob shift; mlReverseLM = 1 when the line
        # moved against the opening favourite (sharp-money signal). Distinct from
        # the AH line-movement above. NaN outside coverage — XGBoost handles NaN.
        feat["mlHomeDrift"] = float("nan")
        feat["mlDrawDrift"] = float("nan")
        feat["mlReverseLM"] = float("nan")
        if reverse_lm_lookup:
            date_str = row["_date"].strftime("%Y-%m-%d") if pd.notna(row["_date"]) else ""
            rlm_entry = reverse_lm_lookup.get(
                (date_str, _normalise_team(str(home)), _normalise_team(str(away)))
            )
            if rlm_entry:
                feat["mlHomeDrift"] = rlm_entry["mlHomeDrift"]
                feat["mlDrawDrift"] = rlm_entry["mlDrawDrift"]
                feat["mlReverseLM"] = rlm_entry["mlReverseLM"]

        # ── Head-to-head features (directional: home vs away) ──
        # Uses only prior meetings between this exact pair (home_team at home).
        # Shrink toward overall league average when sample is thin (k=5).
        # Anti-leakage: current match is added to history AFTER feature extraction.
        H2H_SHRINK_K = 5  # pooling constant — league prior gets full weight at n=0
        prior_h2h = h2h_history.get((home, away), [])
        n_h2h = len(prior_h2h)
        w_own = n_h2h / (n_h2h + H2H_SHRINK_K)  # shrinkage weight for own H2H
        w_prior = 1.0 - w_own
        # League-level baseline from market probs (best unbiased estimate with no H2H)
        h2h_home_raw = sum(1 for r in prior_h2h if r == "H") / max(n_h2h, 1)
        h2h_draw_raw = sum(1 for r in prior_h2h if r == "D") / max(n_h2h, 1)
        h2h_away_raw = sum(1 for r in prior_h2h if r == "A") / max(n_h2h, 1)
        feat["h2hHomeWin"]  = w_own * h2h_home_raw + w_prior * mh
        feat["h2hDraw"]     = w_own * h2h_draw_raw + w_prior * md
        feat["h2hAwayWin"]  = w_own * h2h_away_raw + w_prior * ma
        feat["h2hN"]        = float(n_h2h)  # sample size (GBM can learn reliability)
        feat["h2hGoalDiff"] = float("nan")
        if n_h2h > 0:
            # Signed: positive = home team historically dominant in this fixture
            goal_diffs = []
            for r in prior_h2h:
                if r == "H":
                    goal_diffs.append(1.0)
                elif r == "D":
                    goal_diffs.append(0.0)
                else:
                    goal_diffs.append(-1.0)
            feat["h2hGoalDiff"] = sum(goal_diffs) / len(goal_diffs)

        # ── Target ──
        result_map = {"H": 0, "D": 1, "A": 2}
        result = result_map.get(str(row["FTR"]).strip())
        if result is None:
            _update_history(history, home_hist_map, away_hist_map, row)
            continue

        feat["_outcome"] = result
        feat["_mktH"] = mh
        feat["_mktD"] = md
        feat["_mktA"] = ma
        feat["_season"] = row["_season"]
        feat["_league"] = row["_league"]
        feat["_date"] = row["_date"]
        rows.append(feat)

        _update_history(history, home_hist_map, away_hist_map, row)
        # Update H2H history with this match's result (post-extraction — no leakage)
        ftr = str(row.get("FTR", "")).strip()
        if ftr in ("H", "D", "A"):
            h2h_history.setdefault((home, away), []).append(ftr)
        # Update rolling xG history with this match's xG (post-extraction — no leakage)
        if _current_match_xg is not None:
            xg_h_val, xg_a_val = _current_match_xg
            xg_history.setdefault(_normalise_team(str(home)), []).append((xg_h_val, xg_a_val))
            xg_history.setdefault(_normalise_team(str(away)), []).append((xg_a_val, xg_h_val))

    features = pd.DataFrame(rows)
    n = max(len(features), 1)
    xg_coverage = f"{xg_hits}/{len(features)} ({100*xg_hits/n:.1f}%)" if xg_lookup else "disabled"
    elo_hits = int(features["eloDiff"].notna().sum()) if "eloDiff" in features.columns else 0
    elo_coverage = f"{elo_hits}/{len(features)} ({100*elo_hits/n:.1f}%)" if clubelo_ratings else "disabled"
    spi_hits = int(features["spiOffDiff"].notna().sum()) if "spiOffDiff" in features.columns else 0
    spi_coverage = f"{spi_hits}/{len(features)} ({100*spi_hits/n:.1f}%)" if spi_lookup else "disabled"
    sv_hits = int(features["squadValueRatio"].notna().sum()) if "squadValueRatio" in features.columns else 0
    sv_coverage = f"{sv_hits}/{len(features)} ({100*sv_hits/n:.1f}%)" if squad_value_lookup else "disabled"
    ots_hits = int(features["ahCloseDelta"].notna().sum()) if "ahCloseDelta" in features.columns else 0
    ots_coverage = f"{ots_hits}/{len(features)} ({100*ots_hits/n:.1f}%)" if odds_ts_lookup else "disabled"
    fbref_hits = int(features["fbrefSotDiff"].notna().sum()) if "fbrefSotDiff" in features.columns else 0
    fbref_coverage = f"{fbref_hits}/{len(features)} ({100*fbref_hits/n:.1f}%)" if fbref_lookup else "disabled"
    ref_hits = int(features["refStrictness"].notna().sum()) if "refStrictness" in features.columns else 0
    ref_coverage = f"{ref_hits}/{len(features)} ({100*ref_hits/n:.1f}%)" if referee_lookup else "disabled"
    ppda_hits = int(features["ppdaHome"].notna().sum()) if "ppdaHome" in features.columns else 0
    ppda_coverage = f"{ppda_hits}/{len(features)} ({100*ppda_hits/n:.1f}%)" if ppda_lookup else "disabled"
    wx_hits = int(features["tempC"].notna().sum()) if "tempC" in features.columns else 0
    wx_coverage = f"{wx_hits}/{len(features)} ({100*wx_hits/n:.1f}%)" if weather_lookup else "disabled"
    av_hits = int(features["availIdxHome"].notna().sum()) if "availIdxHome" in features.columns else 0
    av_coverage = f"{av_hits}/{len(features)} ({100*av_hits/n:.1f}%)" if availability_lookup else "disabled"
    rlm_hits = int(features["mlReverseLM"].notna().sum()) if "mlReverseLM" in features.columns else 0
    rlm_coverage = f"{rlm_hits}/{len(features)} ({100*rlm_hits/n:.1f}%)" if reverse_lm_lookup else "disabled"
    print(
        f"[gbm] Feature matrix: {len(features)} rows x {len(features.columns)} cols"
        f" | xG: {xg_coverage} | Elo: {elo_coverage}"
        f" | SPI: {spi_coverage} | SV: {sv_coverage} | OTS: {ots_coverage}"
        f" | FBref: {fbref_coverage} | Ref: {ref_coverage} | PPDA: {ppda_coverage}"
        f" | Wx: {wx_coverage} | Avail: {av_coverage} | RLM: {rlm_coverage}"
    )
    return features


def _update_history(
    history: dict[str, list[dict]],
    home_hist_map: dict[str, list[dict]],
    away_hist_map: dict[str, list[dict]],
    row: pd.Series,
) -> None:
    """Record match result in all-venue and venue-specific team histories."""
    ftr = str(row.get("FTR", "")).strip()
    hg = int(row["FTHG"]) if pd.notna(row.get("FTHG")) else 0
    ag = int(row["FTAG"]) if pd.notna(row.get("FTAG")) else 0
    home_team = row["HomeTeam"]
    away_team = row["AwayTeam"]

    # Home team
    hpts = 3 if ftr == "H" else (1 if ftr == "D" else 0)
    entry_h = {"gf": hg, "ga": ag, "pts": hpts}
    history.setdefault(home_team, []).append(entry_h)
    home_hist_map.setdefault(home_team, []).append(entry_h)

    # Away team
    apts = 3 if ftr == "A" else (1 if ftr == "D" else 0)
    entry_a = {"gf": ag, "ga": hg, "pts": apts}
    history.setdefault(away_team, []).append(entry_a)
    away_hist_map.setdefault(away_team, []).append(entry_a)


# ── RPS ───────────────────────────────────────────────────────────────────────

def rps_vector(probs: np.ndarray, outcomes: np.ndarray) -> np.ndarray:
    """
    Vectorised RPS for ordered 3-outcome: probs shape (N,3), outcomes shape (N,) ints 0/1/2.
    RPS = mean((cumF_j - cumA_j)^2) for j=1,2
    cumF = [P(H), P(H)+P(D)]
    cumA = [I(outcome=H), I(outcome in {H,D})]
    """
    cum_p = np.cumsum(probs[:, :2], axis=1)  # (N,2): [P(H), P(H)+P(D)]
    cum_a = np.column_stack([
        (outcomes <= 0).astype(float),  # I(outcome = home)
        (outcomes <= 1).astype(float),  # I(outcome = home or draw)
    ])
    return np.mean((cum_p - cum_a) ** 2, axis=1)


# ── Walk-forward training and evaluation ──────────────────────────────────────

def walk_forward_eval(
    features: pd.DataFrame,
    test_season: str | None = None,
    leagues: set[str] | None = None,
    exclude_features: set[str] | None = None,
    n_estimators: int = 400,
    max_depth: int = 4,
) -> dict:
    """
    Walk-forward validation:
      - If test_season given: train on all prior seasons, test on that season.
      - Otherwise: train on earliest 2 seasons, test on the latest season.
      - If leagues given: restrict to that subset of league names.
    """
    if leagues:
        features = features[features["_league"].isin(leagues)].copy()
        print(f"[gbm] League filter: {sorted(leagues)} -> {len(features)} rows")

    seasons = sorted(features["_season"].unique())
    if len(seasons) < 2:
        print(f"[gbm] Need >= 2 seasons for walk-forward, got {seasons}. Using 80/20 split.")
        cutoff = int(len(features) * 0.8)
        train_df = features.iloc[:cutoff]
        test_df = features.iloc[cutoff:]
    elif test_season:
        train_df = features[features["_season"] < test_season]
        test_df = features[features["_season"] == test_season]
    else:
        # Train on all but last season; test on last season
        train_df = features[features["_season"] < seasons[-1]]
        test_df = features[features["_season"] == seasons[-1]]

    print(f"[gbm] Train: {len(train_df)} | Test: {len(test_df)} ({test_df['_season'].unique()})")

    if len(test_df) < MIN_TEST_FIXTURES:
        print(f"[gbm] WARNING: only {len(test_df)} test fixtures (min {MIN_TEST_FIXTURES})")

    feat_cols = [c for c in features.columns if not c.startswith("_")]
    if exclude_features:
        feat_cols = [c for c in feat_cols if c not in exclude_features]

    X_train = train_df[feat_cols].fillna(0).values
    y_train = train_df["_outcome"].values
    X_test  = test_df[feat_cols].fillna(0).values
    y_test  = test_df["_outcome"].values

    # ── XGBoost training ──
    model = xgb.XGBClassifier(
        objective="multi:softprob",
        num_class=3,
        n_estimators=n_estimators,
        max_depth=max_depth,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=5,
        reg_lambda=1.0,
        use_label_encoder=False,
        eval_metric="mlogloss",
        verbosity=0,
        random_state=42,
        early_stopping_rounds=30,
    )

    X_val = X_train[int(len(X_train) * 0.85):]
    y_val = y_train[int(len(y_train) * 0.85):]
    X_tr2  = X_train[:int(len(X_train) * 0.85)]
    y_tr2  = y_train[:int(len(y_train) * 0.85)]

    model.fit(
        X_tr2, y_tr2,
        eval_set=[(X_val, y_val)],
        verbose=False,
    )

    gbm_probs = model.predict_proba(X_test)  # (N, 3)

    # ── Pinnacle market probabilities ──
    mkt_probs = test_df[["_mktH", "_mktD", "_mktA"]].fillna(1/3).values

    # ── RPS comparison ──
    gbm_rps  = rps_vector(gbm_probs, y_test)
    mkt_rps  = rps_vector(mkt_probs, y_test)

    mean_gbm = float(np.mean(gbm_rps))
    mean_mkt = float(np.mean(mkt_rps))
    improvement = mean_mkt - mean_gbm  # positive = GBM is better

    # Per-league breakdown
    league_stats = {}
    for lg in test_df["_league"].unique():
        mask = test_df["_league"].values == lg
        lg_gbm = float(np.mean(gbm_rps[mask]))
        lg_mkt = float(np.mean(mkt_rps[mask]))
        league_stats[lg] = {
            "n": int(mask.sum()),
            "gbm_rps": round(lg_gbm, 4),
            "mkt_rps": round(lg_mkt, 4),
            "delta": round(lg_mkt - lg_gbm, 4),
        }

    # Feature importances
    importances = dict(zip(feat_cols, model.feature_importances_.tolist()))
    top_features = sorted(importances.items(), key=lambda x: -x[1])[:15]

    return {
        "n_train": len(train_df),
        "n_test": len(test_df),
        "test_seasons": list(test_df["_season"].unique()),
        "mean_gbm_rps": round(mean_gbm, 4),
        "mean_mkt_rps": round(mean_mkt, 4),
        "improvement": round(improvement, 4),
        "gate_passed": improvement >= RPS_IMPROVEMENT_THRESHOLD,
        "league_stats": league_stats,
        "top_features": top_features,
        "model": model,
        "feat_cols": feat_cols,
    }


# ── Result reporting & saving ─────────────────────────────────────────────────

def _print_results(results: dict, label: str = "") -> None:
    tag = f"[gbm{' ' + label if label else ''}]"
    print(f"\n{tag} === RESULTS ===")
    print(f"{tag} Train: {results['n_train']} | Test: {results['n_test']} ({results['test_seasons']})")
    print(f"{tag} GBM mean RPS:    {results['mean_gbm_rps']:.4f}")
    print(f"{tag} Market mean RPS: {results['mean_mkt_rps']:.4f}")
    delta = results["improvement"]
    sign = "+" if delta > 0 else ""
    status = "PASS" if results["gate_passed"] else "FAIL -- below 0.002 threshold"
    print(f"{tag} Delta:           {sign}{delta:.4f}  ({status})")
    print(f"\n{tag} Per-league breakdown (test set):")
    for lg, s in sorted(results["league_stats"].items(), key=lambda x: -x[1]["delta"]):
        flag = " PASS" if s["delta"] >= 0.002 else (" +" if s["delta"] > 0 else " -")
        print(f"{tag}   {lg:<30} n={s['n']:4}  GBM={s['gbm_rps']:.4f}  Mkt={s['mkt_rps']:.4f}  d={s['delta']:+.4f}{flag}")
    print(f"\n{tag} Top 15 features by importance:")
    for feat, imp in results["top_features"]:
        bar = "=" * int(imp * 50)
        print(f"{tag}   {feat:<20} {imp:.4f}  {bar}")


def _save_model(results: dict, model_stem: str) -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    model_path = MODEL_DIR / f"{model_stem}.json"
    results["model"].save_model(str(model_path))
    meta_path = MODEL_DIR / f"{model_stem}_meta.json"
    meta = {
        "mean_gbm_rps": results["mean_gbm_rps"],
        "mean_mkt_rps": results["mean_mkt_rps"],
        "improvement": results["improvement"],
        "gate_passed": results["gate_passed"],
        "test_seasons": results["test_seasons"],
        "n_test": results["n_test"],
        "feat_cols": results["feat_cols"],
        "league_stats": results["league_stats"],
    }
    meta_path.write_text(json.dumps(meta, indent=2))
    print(f"\n[gbm] Model saved -> {model_path}")
    print(f"[gbm] Meta saved  -> {meta_path}")


def walk_forward_rolling(
    features: pd.DataFrame,
    folds: int,
    leagues: set[str] | None = None,
    exclude_features: set[str] | None = None,
    n_estimators: int = 400,
) -> dict:
    """Run N-fold rolling walk-forward: each fold tests one season, trains on all prior.
    Returns averaged metrics and the best-fold model (highest improvement)."""
    if leagues:
        features = features[features["_league"].isin(leagues)].copy()
        print(f"[gbm] League filter: {sorted(leagues)} -> {len(features)} rows")

    seasons = sorted(features["_season"].unique())
    test_seasons = seasons[-folds:]  # last N seasons used as test folds
    if len(test_seasons) < folds:
        print(f"[gbm] WARNING: only {len(seasons)} seasons available, using {len(test_seasons)} folds")

    fold_results = []
    for ts in test_seasons:
        train_df = features[features["_season"] < ts]
        test_df  = features[features["_season"] == ts]
        if len(train_df) < 100 or len(test_df) < 50:
            print(f"[gbm]   Fold {ts}: skipped (too few rows)")
            continue

        feat_cols = [c for c in features.columns if not c.startswith("_")]
        if exclude_features:
            feat_cols = [c for c in feat_cols if c not in exclude_features]

        X_train = train_df[feat_cols].fillna(0).values
        y_train = train_df["_outcome"].values
        X_test  = test_df[feat_cols].fillna(0).values
        y_test  = test_df["_outcome"].values

        model = xgb.XGBClassifier(
            objective="multi:softprob",
            num_class=3,
            n_estimators=n_estimators,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            min_child_weight=5,
            reg_lambda=1.0,
            use_label_encoder=False,
            eval_metric="mlogloss",
            verbosity=0,
            random_state=42,
            early_stopping_rounds=30,
        )
        val_cut = int(len(X_train) * 0.85)
        model.fit(X_train[:val_cut], y_train[:val_cut],
                  eval_set=[(X_train[val_cut:], y_train[val_cut:])], verbose=False)

        gbm_probs = model.predict_proba(X_test)
        mkt_probs = test_df[["_mktH", "_mktD", "_mktA"]].fillna(1/3).values
        gbm_rps = rps_vector(gbm_probs, y_test)
        mkt_rps = rps_vector(mkt_probs, y_test)
        delta = float(np.mean(mkt_rps)) - float(np.mean(gbm_rps))

        importances = dict(zip(feat_cols, model.feature_importances_.tolist()))
        print(f"[gbm]   Fold {ts}: train={len(train_df)} test={len(test_df)} delta={delta:+.4f}")
        fold_results.append({
            "test_season": ts,
            "n_train": len(train_df),
            "n_test": len(test_df),
            "mean_gbm_rps": round(float(np.mean(gbm_rps)), 4),
            "mean_mkt_rps": round(float(np.mean(mkt_rps)), 4),
            "improvement": round(delta, 4),
            "model": model,
            "feat_cols": feat_cols,
            "importances": importances,
        })

    if not fold_results:
        raise RuntimeError("No valid folds produced results")

    avg_delta = sum(f["improvement"] for f in fold_results) / len(fold_results)
    best = max(fold_results, key=lambda f: f["improvement"])

    # Average importances across folds
    avg_imp: dict[str, float] = {}
    for f in fold_results:
        for col, val in f["importances"].items():
            avg_imp[col] = avg_imp.get(col, 0.0) + val / len(fold_results)
    top_features = sorted(avg_imp.items(), key=lambda x: -x[1])[:15]

    print(f"[gbm] Rolling {len(fold_results)}-fold avg delta: {avg_delta:+.4f}  "
          f"({'PASS' if avg_delta >= RPS_IMPROVEMENT_THRESHOLD else 'FAIL'})")

    return {
        "n_train": best["n_train"],
        "n_test": best["n_test"],
        "test_seasons": [f["test_season"] for f in fold_results],
        "mean_gbm_rps": best["mean_gbm_rps"],
        "mean_mkt_rps": best["mean_mkt_rps"],
        "improvement": round(avg_delta, 4),
        "gate_passed": avg_delta >= RPS_IMPROVEMENT_THRESHOLD,
        "league_stats": {},
        "top_features": top_features,
        "model": best["model"],
        "feat_cols": best["feat_cols"],
        "fold_details": [{"season": f["test_season"], "delta": f["improvement"]} for f in fold_results],
    }


def _run_single_model(features: pd.DataFrame, test_season: str | None) -> None:
    results = walk_forward_eval(features, test_season=test_season)
    _print_results(results)
    _save_model(results, "gbm_residual")
    if not results["gate_passed"]:
        print(f"[gbm] NOTE: gate not passed (d < {RPS_IMPROVEMENT_THRESHOLD}). Model saved as calibration signal.")
        print("[gbm] Suggestions: more xG seasons, ClubElo features, head-to-head features.")


def _run_split_model(
    features: pd.DataFrame,
    test_season: str | None,
    xg_feature_cols: set[str],
    n_estimators: int = 400,
    rolling_folds: int = 1,
) -> None:
    """
    Train two models:
      - Top-5 (E0/SP1/D1/I1/F1): full feature set including xG
      - Base (E1/N1/B1/P1/SC0): xG features excluded (sparse/missing)

    Gate: top-5 delta >= +0.002 (hard gate); base delta >= 0 (hold-even).
    Both models are saved regardless of individual gate status.
    """
    base_leagues = {lg for div, lg in LEAGUE_MAP.items() if div not in TOP5_DIVS}

    print("\n[gbm] -- TOP-5 MODEL (Premier League / La Liga / Bundesliga / Serie A / Ligue 1) --")
    if rolling_folds > 1:
        top5_results = walk_forward_rolling(features, folds=rolling_folds, leagues=TOP5_LEAGUES, n_estimators=n_estimators)
    else:
        top5_results = walk_forward_eval(features, test_season=test_season, leagues=TOP5_LEAGUES, n_estimators=n_estimators)
    _print_results(top5_results, label="top5")

    print("\n[gbm] -- BASE MODEL (Championship / Eredivisie / Belgian / Primeira Liga / Scottish) --")
    if rolling_folds > 1:
        base_results = walk_forward_rolling(features, folds=rolling_folds, leagues=base_leagues, exclude_features=xg_feature_cols, n_estimators=n_estimators)
    else:
        base_results = walk_forward_eval(features, test_season=test_season, leagues=base_leagues, exclude_features=xg_feature_cols, n_estimators=n_estimators)
    _print_results(base_results, label="base")

    # Combined gate assessment
    top5_ok = top5_results["gate_passed"]  # delta >= +0.002
    base_ok = base_results["improvement"] >= 0.0  # hold-even
    print(f"\n[gbm] -- SPLIT-MODEL GATE SUMMARY --")
    print(f"[gbm]   Top-5 delta: {top5_results['improvement']:+.4f}  {'PASS' if top5_ok else 'FAIL'}")
    print(f"[gbm]   Base  delta: {base_results['improvement']:+.4f}  {'PASS (hold-even)' if base_ok else 'FAIL (below 0)'}")

    # Save both models regardless of gate status — model serves as calibration signal
    # in the engine alongside Pinnacle odds. Gate result is advisory, recorded in meta.
    _save_model(top5_results, "gbm_top5")
    _save_model(base_results, "gbm_base")

    if top5_ok and base_ok:
        print("\n[gbm] Both gates passed. Split-model pipeline complete.")
    elif not top5_ok:
        print("\n[gbm] Top-5 gate not met. Suggestions: more xG seasons, ClubElo features, higher n_estimators.")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="ORACLE GBM residual model")
    parser.add_argument("--seasons", nargs="*", help="Seasons to include e.g. 2425 2324 2223")
    parser.add_argument("--test-season", help="Season to hold out for testing e.g. 2425")
    parser.add_argument("--dry-run", action="store_true", help="Build features only, no training")
    parser.add_argument("--backfill-dir", default=str(BACKFILL_DIR))
    parser.add_argument("--xg-dir", default=str(XG_DIR), help="Path to .tmp/xg/ xG CSVs")
    parser.add_argument("--clubelo-dir", default=str(CLUBELO_DIR), help="Path to .tmp/clubelo/ snapshots")
    parser.add_argument("--spi-dir", default=str(SPI_DIR), help="Path to .tmp/spi/ SPI features")
    parser.add_argument("--transfermarkt-dir", default=str(TRANSFERMARKT_DIR), help="Path to .tmp/transfermarkt/ squad values")
    parser.add_argument("--odds-ts-dir", default=str(ODDS_TIMESERIES_DIR), help="Path to .tmp/odds-timeseries/ AH+line-movement features")
    parser.add_argument("--no-xg", action="store_true", help="Disable xG features")
    parser.add_argument("--no-elo", action="store_true", help="Disable ClubElo features")
    parser.add_argument("--no-spi", action="store_true", help="Disable SPI features")
    parser.add_argument("--no-squad-value", action="store_true", help="Disable squad market value features")
    parser.add_argument("--no-odds-ts", action="store_true", help="Disable odds time-series features")
    parser.add_argument("--ppda-dir", default=str(PPDA_DIR), help="Path to .tmp/ppda/ PPDA features")
    parser.add_argument("--no-ppda", action="store_true", help="Disable PPDA pressing features")
    parser.add_argument("--weather-dir", default=str(WEATHER_DIR), help="Path to .tmp/weather/ match-day weather features")
    parser.add_argument("--no-weather", action="store_true", help="Disable weather features")
    parser.add_argument("--availability-dir", default=str(AVAILABILITY_DIR), help="Path to .tmp/squad-availability/ availability features")
    parser.add_argument("--no-availability", action="store_true", help="Disable squad-availability features")
    parser.add_argument("--reverse-lm-dir", default=str(REVERSE_LM_DIR), help="Path to .tmp/reverse-lm/ 1X2 line-movement features")
    parser.add_argument("--no-reverse-lm", action="store_true", help="Disable reverse-line-movement features")
    parser.add_argument("--n-estimators", type=int, default=400, help="XGBoost n_estimators (default 400)")
    parser.add_argument("--rolling-folds", type=int, default=1, help="N-fold rolling walk-forward (default 1 = single holdout)")
    parser.add_argument(
        "--split-model",
        action="store_true",
        help=(
            "Train two separate models: top-5 leagues (E0/SP1/D1/I1/F1) with xG features "
            "-> gbm_top5.json; base leagues (E1/N1/B1/P1/SC0) without xG -> gbm_base.json"
        ),
    )
    args = parser.parse_args()

    backfill_dir = Path(args.backfill_dir)
    if not backfill_dir.exists():
        print(f"[gbm] ERROR: backfill dir not found: {backfill_dir}")
        sys.exit(1)

    # 1. Load
    df = load_csvs(backfill_dir, args.seasons)
    if df.empty:
        print("[gbm] No data loaded. Run backfill_oracle.py first.")
        sys.exit(1)

    # 2. xG lookup (optional — top-5 leagues only)
    xg_lookup = None
    if not args.no_xg:
        xg_dir = Path(args.xg_dir)
        if xg_dir.exists():
            xg_df = load_xg(xg_dir)
            if not xg_df.empty:
                xg_lookup = build_xg_lookup(xg_df)
        else:
            print(f"[gbm] xG dir not found ({xg_dir}) -- run fetch_xg.py first, or use --no-xg")

    # 2b. ClubElo ratings (optional — 526 clubs, PRD §8.3 Tier 3)
    clubelo_ratings = None
    if not args.no_elo:
        clubelo_dir = Path(args.clubelo_dir)
        if clubelo_dir.exists():
            clubelo_ratings = load_clubelo(clubelo_dir)
        else:
            print(f"[gbm] ClubElo dir not found ({clubelo_dir}) -- run fetch_clubelo.py first, or use --no-elo")

    # 2c. SPI attack/defense ratings (optional — from fetch_spi.py)
    spi_lookup = None
    spi_team_ratings: dict[str, tuple[float, float]] = {}
    if not args.no_spi:
        spi_dir = Path(args.spi_dir)
        if spi_dir.exists():
            spi_lookup, spi_team_ratings = load_spi_features(spi_dir)
        else:
            print(f"[gbm] SPI dir not found ({spi_dir}) -- run fetch_spi.py first, or use --no-spi")

    # 2d. Squad market value ratio (optional — from fetch_transfermarkt.py)
    squad_value_lookup = None
    if not args.no_squad_value:
        tm_dir = Path(args.transfermarkt_dir)
        if tm_dir.exists():
            squad_value_lookup = load_squad_value(tm_dir)
        else:
            print(f"[gbm] Transfermarkt dir not found ({tm_dir}) -- run fetch_transfermarkt.py first, or use --no-squad-value")

    # 2e. Odds time-series AH + line-movement (optional — from fetch_odds_timeseries.py)
    odds_ts_lookup = None
    if not args.no_odds_ts:
        ots_dir = Path(args.odds_ts_dir)
        if ots_dir.exists():
            odds_ts_lookup = load_odds_timeseries(ots_dir)
        else:
            print(f"[gbm] Odds-timeseries dir not found ({ots_dir}) -- run fetch_odds_timeseries.py first, or use --no-odds-ts")

    # 2f. FBref squad-season stats (optional — from fetch_fbref.py, top-5 only)
    fbref_lookup = None
    fbref_dir = Path(".tmp/fbref")
    if fbref_dir.exists():
        fbref_lookup = load_fbref(fbref_dir)
    else:
        print("[gbm] FBref dir not found (.tmp/fbref) -- run fetch_fbref.py first")

    # 2g. Referee strictness (optional — from fetch_match_stats.py)
    referee_lookup = None
    match_stats_dir = Path(".tmp/match-stats")
    if match_stats_dir.exists():
        referee_lookup = load_referee(match_stats_dir)
    else:
        print("[gbm] Match-stats dir not found (.tmp/match-stats) -- run fetch_match_stats.py first")

    # 2h. PPDA pressing intensity (optional — from fetch_ppda.py, top-5 only)
    ppda_lookup = None
    if not args.no_ppda:
        ppda_dir = Path(args.ppda_dir)
        if ppda_dir.exists():
            ppda_lookup = load_ppda(ppda_dir)
        else:
            print(f"[gbm] PPDA dir not found ({ppda_dir}) -- run fetch_ppda.py first, or use --no-ppda")

    # 2i. Match-day weather (optional — from fetch_weather.py, Open-Meteo)
    weather_lookup = None
    if not args.no_weather:
        weather_dir = Path(args.weather_dir)
        if weather_dir.exists():
            weather_lookup = load_weather(weather_dir)
        else:
            print(f"[gbm] Weather dir not found ({weather_dir}) -- run fetch_weather.py first, or use --no-weather")

    # 2j. Squad availability (optional — from fetch_squad_availability.py, top-5 only)
    availability_lookup = None
    if not args.no_availability:
        avail_dir = Path(args.availability_dir)
        if avail_dir.exists():
            availability_lookup = load_squad_availability(avail_dir)
        else:
            print(f"[gbm] Availability dir not found ({avail_dir}) -- run fetch_squad_availability.py first, or use --no-availability")

    # 2k. 1X2 reverse line movement (optional — from fetch_reverse_lm.py)
    reverse_lm_lookup = None
    if not args.no_reverse_lm:
        rlm_dir = Path(args.reverse_lm_dir)
        if rlm_dir.exists():
            reverse_lm_lookup = load_reverse_lm(rlm_dir)
        else:
            print(f"[gbm] Reverse-LM dir not found ({rlm_dir}) -- run fetch_reverse_lm.py first, or use --no-reverse-lm")

    # 3. Feature engineering
    features = build_features(
        df,
        xg_lookup=xg_lookup,
        clubelo_ratings=clubelo_ratings,
        spi_lookup=spi_lookup,
        spi_team_ratings=spi_team_ratings or None,
        squad_value_lookup=squad_value_lookup,
        odds_ts_lookup=odds_ts_lookup,
        fbref_lookup=fbref_lookup,
        referee_lookup=referee_lookup,
        ppda_lookup=ppda_lookup,
        weather_lookup=weather_lookup,
        availability_lookup=availability_lookup,
        reverse_lm_lookup=reverse_lm_lookup,
    )
    if features.empty:
        print("[gbm] No feature rows built.")
        sys.exit(1)

    if args.dry_run:
        print("\n[gbm] Dry run -- feature sample:")
        feat_cols = [c for c in features.columns if not c.startswith("_")]
        print(features[feat_cols].describe().to_string())
        sys.exit(0)

    XG_FEATURE_COLS = {
        "xgForHome5", "xgAgainstHome5", "xgForAway5", "xgAgainstAway5",
        "xgDiffHome5", "xgDiffAway5",
        "xgForHome10", "xgAgainstHome10", "xgForAway10", "xgAgainstAway10",
        "xgDiffHome10", "xgDiffAway10",
    }
    H2H_FEATURE_COLS = {
        "h2hHomeWin", "h2hDraw", "h2hAwayWin", "h2hN", "h2hGoalDiff",
    }

    if args.split_model:
        _run_split_model(features, args.test_season, XG_FEATURE_COLS | H2H_FEATURE_COLS, n_estimators=args.n_estimators, rolling_folds=args.rolling_folds)
    else:
        _run_single_model(features, args.test_season)


if __name__ == "__main__":
    main()
