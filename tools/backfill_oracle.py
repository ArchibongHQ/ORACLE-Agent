"""
backfill_oracle.py — Historical data ingestion for ORACLE calibration ledger.

Downloads season CSVs from football-data.co.uk (Pinnacle odds included),
computes devigged probabilities + RPS, then bulk-writes AnalysisRecord[] and
ResolutionRecord[] into the GBrainAdapter store.

Requires only stdlib + urllib (no pip dependencies).

Usage:
    python tools/backfill_oracle.py
    python tools/backfill_oracle.py --seasons 2425 2324 2223
    python tools/backfill_oracle.py --leagues E0 SP1 D1
    python tools/backfill_oracle.py --dry-run          # print stats, no write
    python tools/backfill_oracle.py --store-dir .tmp/oracle-store

    # Kaggle ingest (adamgbor / mexwell / fdco-compatible CSVs):
    python tools/backfill_oracle.py --source kaggle --kaggle-dir .tmp/kaggle/club-football-2000-2025
    python tools/backfill_oracle.py --source kaggle --kaggle-dir .tmp/kaggle/mexwell

football-data.co.uk CSV columns used:
    Div, Date, HomeTeam, AwayTeam, FTHG, FTAG, FTR, PSH, PSD, PSA
    (PSH/PSD/PSA = Pinnacle closing odds — absent in some older seasons)

Kaggle schema auto-detection (priority order):
    adamgbor  — HomeTeam/AwayTeam + HomeGoals/AwayGoals + Result + AvgH/AvgD/AvgA
    mexwell   — home_team/away_team + home_goals/away_goals + winner + odd_h/odd_d/odd_a
    fdco-compat — any CSV whose header contains HomeTeam + FTHG + FTR (treated as fdco)
"""

import argparse
import csv
import hashlib
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ── Config ────────────────────────────────────────────────────────────────────

BASE_URL = "https://www.football-data.co.uk/mmz4281"
STORE_DIR = Path(".tmp/oracle-store")
CACHE_DIR = Path(".tmp/backfill")

# football-data.co.uk division code → ORACLE league name
DIV_TO_LEAGUE: dict[str, str] = {
    "E0":  "Premier League",
    "E1":  "Championship",
    "SP1": "La Liga",
    "D1":  "Bundesliga",
    "I1":  "Serie A",
    "F1":  "Ligue 1",
    "N1":  "Eredivisie",
    "B1":  "Belgian Pro League",
    "P1":  "Primeira Liga",
    "SC0": "Scottish Premiership",
}

DEFAULT_SEASONS = ["2425", "2324", "2223"]
DEFAULT_LEAGUES = list(DIV_TO_LEAGUE.keys())

ANALYSIS_KEY    = "oracle_v2026_analysis"
RESOLUTION_KEY  = "oracle_v2026_resolution"

OUTCOME_ORDER = ["home", "draw", "away"]

# ── Storage helpers ───────────────────────────────────────────────────────────

def key_to_path(key: str, store_dir: Path) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9_\-]", "_", key)
    return store_dir / f"{safe}.json"


def load_store(key: str, store_dir: Path) -> list[dict]:
    path = key_to_path(key, store_dir)
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, list) else []


def save_store(key: str, records: list[dict], store_dir: Path) -> None:
    store_dir.mkdir(parents=True, exist_ok=True)
    path = key_to_path(key, store_dir)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2)


# ── HTTP fetch with local cache ───────────────────────────────────────────────

def fetch_csv(season: str, div: str) -> str | None:
    url = f"{BASE_URL}/{season}/{div}.csv"
    cache_path = CACHE_DIR / f"{season}_{div}.csv"

    if cache_path.exists():
        print(f"[backfill] Cache hit: {cache_path.name}")
        return cache_path.read_text(encoding="utf-8", errors="replace")

    print(f"[backfill] Fetching {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ORACLE-backfill/1.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"[backfill] WARN: {url} - {e}")
        return None

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(raw, encoding="utf-8")
    return raw


# ── RPS ───────────────────────────────────────────────────────────────────────

def rps_score(probs: dict[str, float], actual: str) -> float:
    cum_f, cum_a, score = 0.0, 0.0, 0.0
    for out in OUTCOME_ORDER:
        cum_f += probs.get(out, 0.0)
        cum_a += 1.0 if out == actual else 0.0
        score += (cum_f - cum_a) ** 2
    return score / (len(OUTCOME_ORDER) - 1)


# ── Devig Pinnacle odds → fair probabilities ──────────────────────────────────

def devig(h: float, d: float, a: float) -> dict[str, float] | None:
    """Power devig (Shin approximation). Returns None if any odds ≤ 1."""
    if h <= 1.0 or d <= 1.0 or a <= 1.0:
        return None
    ih, id_, ia = 1 / h, 1 / d, 1 / a
    total = ih + id_ + ia
    if total <= 0:
        return None
    return {"home": ih / total, "draw": id_ / total, "away": ia / total}


# ── Date parsing ──────────────────────────────────────────────────────────────

def parse_date(date_str: str) -> str | None:
    """Parse DD/MM/YYYY or DD/MM/YY → ISO-8601 date string."""
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            dt = datetime.strptime(date_str.strip(), fmt)
            return dt.strftime("%Y-%m-%dT12:00:00Z")
        except ValueError:
            continue
    return None


# ── Fixture ID ────────────────────────────────────────────────────────────────

def make_fixture_id(home: str, away: str, kickoff: str) -> str:
    raw = f"{home}_{away}_{kickoff[:10]}"
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


# ── CSV row → records ─────────────────────────────────────────────────────────

def row_to_records(
    row: dict[str, str],
    league: str,
) -> tuple[dict, dict] | None:
    """Return (AnalysisRecord, ResolutionRecord) or None if row is unusable."""
    home = (row.get("HomeTeam") or "").strip()
    away = (row.get("AwayTeam") or "").strip()
    date_str = (row.get("Date") or "").strip()
    ftr = (row.get("FTR") or "").strip().upper()
    fthg_s = (row.get("FTHG") or "").strip()
    ftag_s = (row.get("FTAG") or "").strip()

    if not all([home, away, date_str, ftr, fthg_s, ftag_s]):
        return None

    kickoff = parse_date(date_str)
    if not kickoff:
        return None

    try:
        home_goals = int(fthg_s)
        away_goals = int(ftag_s)
    except ValueError:
        return None

    actual_result = {"H": "home", "D": "draw", "A": "away"}.get(ftr)
    if actual_result is None:
        return None

    # Pinnacle closing odds (preferred) — fall back to BbAv or B365 if missing
    psh = _try_float(row, ["PSH", "BbAvH", "B365H"])
    psd = _try_float(row, ["PSD", "BbAvD", "B365D"])
    psa = _try_float(row, ["PSA", "BbAvA", "B365A"])

    probs: dict[str, float] | None = None
    frozen_odds: dict[str, Any] = {}

    if psh and psd and psa:
        probs = devig(psh, psd, psa)
        frozen_odds = {"home": psh, "draw": psd, "away": psa}

    if probs is None:
        # Uniform fallback — no calibration value but keeps the record
        probs = {"home": 1 / 3, "draw": 1 / 3, "away": 1 / 3}

    rps_val = rps_score(probs, actual_result)
    fixture_id = make_fixture_id(home, away, kickoff)
    now = datetime.now(timezone.utc).isoformat()

    analysis: dict[str, Any] = {
        "fixtureId":            fixture_id,
        "home":                 home,
        "away":                 away,
        "league":               league,
        "kickoff":              kickoff,
        "lambdaH":              0.0,
        "lambdaA":              0.0,
        "probabilities":        probs,
        "regime":               "STANDARD",
        "rankingMode":          "CONFIDENCE_WEIGHTED",
        "evMarkets":            [],
        "llmPick":              None,
        "deterministicTopPick": None,
        "frozenOddsAtAnalysis": frozen_odds if frozen_odds else None,
        "liquidityTag":         "CLV_ELIGIBLE",
        "analysedAt":           now,
        "_backfill":            True,
    }

    resolution: dict[str, Any] = {
        "fixtureId":          fixture_id,
        "actualResult":       actual_result,
        "homeGoals":          home_goals,
        "awayGoals":          away_goals,
        "realisedCLV":        None,
        "rpsContribution":    round(rps_val, 6),
        "drawCalibrationPoint": {
            "league":    league,
            "predicted": probs["draw"],
            "realised":  1 if actual_result == "draw" else 0,
        },
        "resolvedAt":         now,
        "_backfill":          True,
    }

    return analysis, resolution


def _try_float(row: dict[str, str], keys: list[str]) -> float | None:
    for k in keys:
        v = row.get(k, "").strip()
        try:
            f = float(v)
            return f if f > 1.0 else None
        except ValueError:
            continue
    return None


# ── Kaggle schema helpers ────────────────────────────────────────────────────

def _find_col(header: list[str], candidates: list[str]) -> str | None:
    """Case-insensitive column lookup against a list of candidate names."""
    lc = {c.lower(): c for c in header if c is not None}
    for cand in candidates:
        if cand.lower() in lc:
            return lc[cand.lower()]
    return None


def _detect_schema(header: list[str]) -> str:
    """
    Detect which Kaggle dataset schema a CSV header matches.
    Returns: 'adamgbor' | 'mexwell' | 'mexwell_extra' | 'fdco' | 'unknown'
    """
    lc = {c.lower() for c in header if c is not None}
    # adamgbor v2 uses FTHome/FTAway/FTResult + Division/MatchDate
    if "fthome" in lc and "ftaway" in lc and "ftresult" in lc:
        return "adamgbor"
    # panaaaaa championship: "FTH Goals"/"FTA Goals"/"FT Result"
    if "fth goals" in lc and "fta goals" in lc and "ft result" in lc:
        return "panaaaaa"
    # mexwell extra/ uses Home/Away/HG/AG/Res + Country/League/Season/Date
    if "hg" in lc and "ag" in lc and "res" in lc and "home" in lc and "away" in lc:
        return "mexwell_extra"
    if "homegoals" in lc or "home_goals" in lc:
        # adamgbor uses HomeGoals/AwayGoals; mexwell uses home_goals/away_goals
        if "home_team" in lc or "hometeam" in lc:
            if "home_goals" in lc:
                return "mexwell"
            return "adamgbor"
    if "fthg" in lc and "ftr" in lc:
        return "fdco"
    if "home_goals" in lc and "home_team" in lc:
        return "mexwell"
    if "homegoals" in lc and "hometeam" in lc:
        return "adamgbor"
    return "unknown"


def _row_to_records_adamgbor(
    row: dict[str, str], league: str
) -> tuple[dict, dict] | None:
    """Normalise an adamgbor-schema row → (AnalysisRecord, ResolutionRecord)."""
    header = list(row.keys())
    home_col  = _find_col(header, ["HomeTeam", "Home", "home_team"])
    away_col  = _find_col(header, ["AwayTeam", "Away", "away_team"])
    date_col  = _find_col(header, ["Date", "date", "MatchDate", "match_date"])
    hg_col    = _find_col(header, ["HomeGoals", "home_goals", "FTHome", "FTHG", "HG"])
    ag_col    = _find_col(header, ["AwayGoals", "away_goals", "FTAway", "FTAG", "AG"])
    res_col   = _find_col(header, ["Result", "FTR", "FTResult", "result", "winner"])
    # Odds: prefer Pinnacle (PSH/PSD/PSA), fall back to AvgH/AvgD/AvgA or B365
    oh_col    = _find_col(header, ["PSH", "AvgH", "OddHome", "B365H", "odd_h", "1", "home_odd"])
    od_col    = _find_col(header, ["PSD", "AvgD", "OddDraw", "B365D", "odd_d", "X", "draw_odd"])
    oa_col    = _find_col(header, ["PSA", "AvgA", "OddAway", "B365A", "odd_a", "2", "away_odd"])

    if not all([home_col, away_col, date_col, hg_col, ag_col, res_col]):
        return None

    home = row.get(home_col, "").strip()  # type: ignore[arg-type]
    away = row.get(away_col, "").strip()  # type: ignore[arg-type]
    date_str = row.get(date_col, "").strip()  # type: ignore[arg-type]
    ftr_raw = row.get(res_col, "").strip().upper()  # type: ignore[arg-type]

    if not all([home, away, date_str, ftr_raw]):
        return None

    # Normalise result: H/D/A or Home/Draw/Away or 1/X/2
    ftr_map = {
        "H": "home", "D": "draw", "A": "away",
        "HOME": "home", "DRAW": "draw", "AWAY": "away",
        "1": "home", "X": "draw", "2": "away",
        "HOME WIN": "home", "AWAY WIN": "away",
    }
    actual_result = ftr_map.get(ftr_raw)
    if actual_result is None:
        return None

    kickoff = parse_date(date_str)
    if not kickoff:
        # Try ISO format (adamgbor uses YYYY-MM-DD)
        try:
            dt = datetime.strptime(date_str[:10], "%Y-%m-%d")
            kickoff = dt.strftime("%Y-%m-%dT12:00:00Z")
        except ValueError:
            return None

    try:
        home_goals = int(float(row.get(hg_col, "")))  # type: ignore[arg-type]
        away_goals = int(float(row.get(ag_col, "")))  # type: ignore[arg-type]
    except (ValueError, TypeError):
        return None

    # Odds
    psh = _try_float(row, [oh_col] if oh_col else [])
    psd = _try_float(row, [od_col] if od_col else [])
    psa = _try_float(row, [oa_col] if oa_col else [])

    probs: dict[str, float] | None = None
    frozen_odds: dict[str, Any] = {}
    if psh and psd and psa:
        probs = devig(psh, psd, psa)
        frozen_odds = {"home": psh, "draw": psd, "away": psa}
    if probs is None:
        probs = {"home": 1 / 3, "draw": 1 / 3, "away": 1 / 3}

    rps_val = rps_score(probs, actual_result)
    fixture_id = make_fixture_id(home, away, kickoff)
    now = datetime.now(timezone.utc).isoformat()

    analysis: dict[str, Any] = {
        "fixtureId":            fixture_id,
        "home":                 home,
        "away":                 away,
        "league":               league,
        "kickoff":              kickoff,
        "lambdaH":              0.0,
        "lambdaA":              0.0,
        "probabilities":        probs,
        "regime":               "STANDARD",
        "rankingMode":          "CONFIDENCE_WEIGHTED",
        "evMarkets":            [],
        "llmPick":              None,
        "deterministicTopPick": None,
        "frozenOddsAtAnalysis": frozen_odds if frozen_odds else None,
        "liquidityTag":         "CLV_ELIGIBLE",
        "analysedAt":           now,
        "_backfill":            True,
        "_source":              "kaggle",
    }
    resolution: dict[str, Any] = {
        "fixtureId":          fixture_id,
        "actualResult":       actual_result,
        "homeGoals":          home_goals,
        "awayGoals":          away_goals,
        "realisedCLV":        None,
        "rpsContribution":    round(rps_val, 6),
        "drawCalibrationPoint": {
            "league":    league,
            "predicted": probs["draw"],
            "realised":  1 if actual_result == "draw" else 0,
        },
        "resolvedAt":         now,
        "_backfill":          True,
        "_source":            "kaggle",
    }
    return analysis, resolution


def _row_to_records_mexwell(
    row: dict[str, str], league: str
) -> tuple[dict, dict] | None:
    """Normalise a mexwell-schema row. mexwell uses snake_case columns."""
    # mexwell: home_team, away_team, home_goals, away_goals, winner (H/D/A),
    # league, odd_h, odd_d, odd_a (or odds_h/odds_d/odds_a), date (YYYY-MM-DD)
    header = list(row.keys())
    home_col = _find_col(header, ["home_team", "HomeTeam"])
    away_col = _find_col(header, ["away_team", "AwayTeam"])
    date_col = _find_col(header, ["date", "Date", "match_date"])
    hg_col   = _find_col(header, ["home_goals", "HomeGoals", "FTHG"])
    ag_col   = _find_col(header, ["away_goals", "AwayGoals", "FTAG"])
    res_col  = _find_col(header, ["winner", "Result", "FTR", "result"])
    lg_col   = _find_col(header, ["league", "League", "Division", "Div"])
    oh_col   = _find_col(header, ["odd_h", "odds_h", "PSH", "AvgH", "B365H"])
    od_col   = _find_col(header, ["odd_d", "odds_d", "PSD", "AvgD", "B365D"])
    oa_col   = _find_col(header, ["odd_a", "odds_a", "PSA", "AvgA", "B365A"])

    if not all([home_col, away_col, date_col, hg_col, ag_col, res_col]):
        return None

    # Use embedded league name when available (mexwell stores it per-row)
    if lg_col:
        row_league = row.get(lg_col, "").strip() or league
    else:
        row_league = league

    # Delegate to shared normalisation (same logic, different col names)
    remapped: dict[str, str] = {
        "HomeTeam": row.get(home_col, ""),   # type: ignore[arg-type]
        "AwayTeam": row.get(away_col, ""),   # type: ignore[arg-type]
        "Date":     row.get(date_col, ""),   # type: ignore[arg-type]
        "FTHG":     row.get(hg_col, ""),     # type: ignore[arg-type]
        "FTAG":     row.get(ag_col, ""),     # type: ignore[arg-type]
        "FTR":      row.get(res_col, ""),    # type: ignore[arg-type]
    }
    if oh_col:
        remapped["PSH"] = row.get(oh_col, "")  # type: ignore[arg-type]
    if od_col:
        remapped["PSD"] = row.get(od_col, "")  # type: ignore[arg-type]
    if oa_col:
        remapped["PSA"] = row.get(oa_col, "")  # type: ignore[arg-type]

    # mexwell winner field: H/D/A or Home/Draw/Away — normalise to H/D/A for row_to_records
    ftr = remapped["FTR"].strip().upper()
    ftr_map = {
        "HOME": "H", "DRAW": "D", "AWAY": "A",
        "HOME WIN": "H", "AWAY WIN": "A", "1": "H", "X": "D", "2": "A",
    }
    remapped["FTR"] = ftr_map.get(ftr, ftr)

    result = row_to_records(remapped, row_league)
    if result:
        result[0]["_source"] = "kaggle"
        result[1]["_source"] = "kaggle"
    return result


def _row_to_records_panaaaaa(
    row: dict[str, str], league: str
) -> tuple[dict, dict] | None:
    """Normalise a panaaaaa championship schema row (FTH Goals/FTA Goals/FT Result)."""
    remapped: dict[str, str] = {
        "HomeTeam": (row.get("HomeTeam") or "").strip(),
        "AwayTeam": (row.get("AwayTeam") or "").strip(),
        "Date":     (row.get("Date") or "").strip(),
        "FTHG":     (row.get("FTH Goals") or "").strip(),
        "FTAG":     (row.get("FTA Goals") or "").strip(),
        "FTR":      (row.get("FT Result") or "").strip(),
    }
    lg_col = _find_col(list(row.keys()), ["League", "league", "Division", "Div"])
    row_league = (row.get(lg_col) or "").strip() if lg_col else ""
    row_league = row_league or league
    result = row_to_records(remapped, row_league)
    if result:
        result[0]["_source"] = "kaggle"
        result[1]["_source"] = "kaggle"
    return result


def _row_to_records_mexwell_extra(
    row: dict[str, str], league: str
) -> tuple[dict, dict] | None:
    """Normalise a mexwell extra/ schema row (Home/Away/HG/AG/Res/Odd_H/Odd_D/Odd_A)."""
    header = list(row.keys())
    home_col = _find_col(header, ["Home", "HomeTeam", "home_team"])
    away_col = _find_col(header, ["Away", "AwayTeam", "away_team"])
    date_col = _find_col(header, ["Date", "date", "match_date"])
    hg_col   = _find_col(header, ["HG", "HomeGoals", "FTHG", "home_goals"])
    ag_col   = _find_col(header, ["AG", "AwayGoals", "FTAG", "away_goals"])
    res_col  = _find_col(header, ["Res", "Result", "FTR", "result", "winner"])
    lg_col   = _find_col(header, ["League", "league", "Division", "Div"])
    oh_col   = _find_col(header, ["Odd_H", "odd_h", "PSH", "AvgH", "B365H"])
    od_col   = _find_col(header, ["Odd_D", "odd_d", "PSD", "AvgD", "B365D"])
    oa_col   = _find_col(header, ["Odd_A", "odd_a", "PSA", "AvgA", "B365A"])

    if not all([home_col, away_col, date_col, hg_col, ag_col, res_col]):
        return None

    row_league = (row.get(lg_col, "").strip() if lg_col else "") or league
    remapped: dict[str, str] = {
        "HomeTeam": row.get(home_col, ""),  # type: ignore[arg-type]
        "AwayTeam": row.get(away_col, ""),  # type: ignore[arg-type]
        "Date":     row.get(date_col, ""),  # type: ignore[arg-type]
        "FTHG":     row.get(hg_col, ""),    # type: ignore[arg-type]
        "FTAG":     row.get(ag_col, ""),    # type: ignore[arg-type]
        "FTR":      row.get(res_col, ""),   # type: ignore[arg-type]
    }
    if oh_col:
        remapped["PSH"] = row.get(oh_col, "")  # type: ignore[arg-type]
    if od_col:
        remapped["PSD"] = row.get(od_col, "")  # type: ignore[arg-type]
    if oa_col:
        remapped["PSA"] = row.get(oa_col, "")  # type: ignore[arg-type]

    ftr = remapped["FTR"].strip().upper()
    ftr_map = {"HOME": "H", "DRAW": "D", "AWAY": "A", "1": "H", "X": "D", "2": "A"}
    remapped["FTR"] = ftr_map.get(ftr, ftr)

    result = row_to_records(remapped, row_league)
    if result:
        result[0]["_source"] = "kaggle"
        result[1]["_source"] = "kaggle"
    return result


# ── Kaggle directory ingest ───────────────────────────────────────────────────

def ingest_kaggle_dir(
    kaggle_dir: Path,
    fallback_league: str = "Unknown",
) -> tuple[list[dict], list[dict]]:
    """
    Walk a Kaggle download directory, auto-detect schema per CSV file, and
    ingest all rows. Returns (analyses, resolutions) aggregated across all files.
    """
    csv_files = sorted(kaggle_dir.rglob("*.csv"))
    if not csv_files:
        print(f"[backfill] WARN: no CSVs found in {kaggle_dir}")
        return [], []

    total_analyses: list[dict] = []
    total_resolutions: list[dict] = []

    for csv_path in csv_files:
        try:
            raw = csv_path.read_text(encoding="utf-8-sig", errors="replace")
        except OSError as e:
            print(f"[backfill] WARN: cannot read {csv_path}: {e}")
            continue

        lines = raw.splitlines()
        if len(lines) < 2:
            continue

        reader = csv.DictReader(lines)
        header = reader.fieldnames or []
        schema = _detect_schema(list(header))

        if schema == "unknown":
            print(f"[backfill] SKIP {csv_path.name}: unrecognised schema (cols: {header[:8]})")
            continue

        print(f"[backfill] {csv_path.name}: schema={schema}")

        file_analyses: list[dict] = []
        file_resolutions: list[dict] = []

        for row in reader:
            # Per-row league: adamgbor/mexwell often embed league/division name
            league_col = _find_col(list(row.keys()), ["league", "League", "Division", "Div", "division"])
            row_league = (row.get(league_col) or "").strip() if league_col else ""
            row_league = row_league or fallback_league

            if schema == "fdco":
                result = row_to_records(row, row_league)
            elif schema == "adamgbor":
                result = _row_to_records_adamgbor(row, row_league)
            elif schema == "panaaaaa":
                result = _row_to_records_panaaaaa(row, row_league)
            elif schema == "mexwell_extra":
                result = _row_to_records_mexwell_extra(row, row_league)
            else:  # mexwell
                result = _row_to_records_mexwell(row, row_league)

            if result is None:
                continue
            analysis, resolution = result
            file_analyses.append(analysis)
            file_resolutions.append(resolution)

        print(f"[backfill]   -> {len(file_analyses)} matches ingested")
        total_analyses.extend(file_analyses)
        total_resolutions.extend(file_resolutions)

    return total_analyses, total_resolutions


# ── CSV ingest ────────────────────────────────────────────────────────────────

def ingest_csv(raw: str, league: str) -> tuple[list[dict], list[dict]]:
    analyses: list[dict] = []
    resolutions: list[dict] = []

    reader = csv.DictReader(raw.splitlines())
    for row in reader:
        result = row_to_records(row, league)
        if result is None:
            continue
        analysis, resolution = result
        analyses.append(analysis)
        resolutions.append(resolution)

    return analyses, resolutions


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="ORACLE historical backfill")
    parser.add_argument("--source", choices=["fdco", "kaggle"], default="fdco",
                        help="Data source: 'fdco' (football-data.co.uk, default) or 'kaggle'")
    parser.add_argument("--kaggle-dir", type=str, default=None,
                        help="Directory containing downloaded Kaggle CSVs (required when --source kaggle)")
    parser.add_argument("--seasons", nargs="+", default=DEFAULT_SEASONS,
                        help="Seasons to ingest — fdco only (e.g. 2425 2324)")
    parser.add_argument("--leagues", nargs="+", default=DEFAULT_LEAGUES,
                        help="football-data.co.uk division codes — fdco only (e.g. E0 SP1 D1)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print stats without writing to store")
    parser.add_argument("--store-dir", default=str(STORE_DIR),
                        help="GBrainAdapter-compatible store directory")
    args = parser.parse_args()

    store_dir = Path(args.store_dir)
    total_analyses: list[dict] = []
    total_resolutions: list[dict] = []

    if args.source == "kaggle":
        if not args.kaggle_dir:
            print("[backfill] ERROR: --kaggle-dir is required when --source kaggle")
            sys.exit(1)
        kaggle_dir = Path(args.kaggle_dir)
        if not kaggle_dir.is_dir():
            print(f"[backfill] ERROR: kaggle-dir does not exist: {kaggle_dir}")
            sys.exit(1)
        print(f"[backfill] Kaggle ingest from {kaggle_dir}")
        total_analyses, total_resolutions = ingest_kaggle_dir(kaggle_dir)
    else:
        unknown = [l for l in args.leagues if l not in DIV_TO_LEAGUE]
        if unknown:
            print(f"[backfill] WARN: unknown league codes skipped: {unknown}")
        leagues = [l for l in args.leagues if l in DIV_TO_LEAGUE]

        for season in args.seasons:
            for div in leagues:
                league = DIV_TO_LEAGUE[div]
                raw = fetch_csv(season, div)
                if raw is None:
                    continue
                analyses, resolutions = ingest_csv(raw, league)
                print(f"[backfill] {season}/{div} ({league}): {len(analyses)} matches")
                total_analyses.extend(analyses)
                total_resolutions.extend(resolutions)

    # De-duplicate by fixtureId (keep last write — newest season wins)
    def dedup(records: list[dict]) -> list[dict]:
        seen: dict[str, dict] = {}
        for r in records:
            seen[r["fixtureId"]] = r
        return list(seen.values())

    total_analyses    = dedup(total_analyses)
    total_resolutions = dedup(total_resolutions)

    rps_vals = [r["rpsContribution"] for r in total_resolutions]
    mean_rps = sum(rps_vals) / len(rps_vals) if rps_vals else 0.0
    draws = sum(1 for r in total_resolutions if r["actualResult"] == "draw")
    draw_rate = draws / len(total_resolutions) if total_resolutions else 0.0

    print(f"\n[backfill] -- Summary --")
    print(f"  Analysis records:    {len(total_analyses)}")
    print(f"  Resolution records:  {len(total_resolutions)}")
    print(f"  Mean Brier RPS:      {mean_rps:.4f}")
    print(f"  Draw rate:           {draw_rate:.3f}")

    if args.dry_run:
        print("\n[backfill] Dry run - store not modified.")
        sys.exit(0)

    # Load existing, merge (new records added, existing fixtureIds updated)
    existing_analyses    = load_store(ANALYSIS_KEY,   store_dir)
    existing_resolutions = load_store(RESOLUTION_KEY, store_dir)

    # Index existing by fixtureId
    analysis_map    = {r["fixtureId"]: r for r in existing_analyses}
    resolution_map  = {r["fixtureId"]: r for r in existing_resolutions}

    new_a = 0
    for r in total_analyses:
        if r["fixtureId"] not in analysis_map:
            new_a += 1
        analysis_map[r["fixtureId"]] = r

    new_r = 0
    for r in total_resolutions:
        if r["fixtureId"] not in resolution_map:
            new_r += 1
        resolution_map[r["fixtureId"]] = r

    save_store(ANALYSIS_KEY,   list(analysis_map.values()),   store_dir)
    save_store(RESOLUTION_KEY, list(resolution_map.values()), store_dir)

    print(f"\n[backfill] Wrote to {store_dir}")
    print(f"  New analysis records:    {new_a}")
    print(f"  New resolution records:  {new_r}")
    print(f"  Total analysis records:  {len(analysis_map)}")
    print(f"  Total resolution records:{len(resolution_map)}")


if __name__ == "__main__":
    main()
