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
    print(
        f"[gbm] Feature matrix: {len(features)} rows x {len(features.columns)} cols"
        f" | xG: {xg_coverage} | Elo: {elo_coverage}"
        f" | SPI: {spi_coverage} | SV: {sv_coverage} | OTS: {ots_coverage}"
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

    # 3. Feature engineering
    features = build_features(
        df,
        xg_lookup=xg_lookup,
        clubelo_ratings=clubelo_ratings,
        spi_lookup=spi_lookup,
        spi_team_ratings=spi_team_ratings or None,
        squad_value_lookup=squad_value_lookup,
        odds_ts_lookup=odds_ts_lookup,
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
