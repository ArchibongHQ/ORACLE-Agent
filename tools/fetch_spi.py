"""
fetch_spi.py — Download FiveThirtyEight SPI (Soccer Power Index) ratings for ORACLE.

SPI provides separate offensive and defensive ratings per club per match,
acting as a substitute for pi-ratings (exponential-decay attack/defense
decomposition) identified as a GBM feature gap in ORACLE PRD §backlog.

Kaggle dataset: thedevastator/club-soccer-predictions-spi-ratings-and-forecast
Download: kaggle datasets download -d thedevastator/club-soccer-predictions-spi-ratings-and-forecast

Alternatively, the raw FiveThirtyEight CSVs are publicly hosted on GitHub:
  https://github.com/fivethirtyeight/data/tree/master/soccer-spi

This tool tries the GitHub source first (no Kaggle auth needed), then falls back
to a local Kaggle download.

Output:
  .tmp/spi/spi_matches.csv  — raw SPI match data
  .tmp/spi/spi_ratings.csv  — per-team SPI offensive/defensive ratings by date
  .tmp/spi/spi_features_{div}_{season}.csv — GBM-ready features joined to backfill key

GBM features produced:
  home_spi_off  — SPI offensive rating for home team at time of match
  home_spi_def  — SPI defensive rating for home team
  away_spi_off  — SPI offensive rating for away team
  away_spi_def  — SPI defensive rating for away team
  spi_off_diff  — home_spi_off - away_spi_off  (attack edge)
  spi_def_diff  — home_spi_def - away_spi_def  (defense edge)

Usage:
    python tools/fetch_spi.py
    python tools/fetch_spi.py --local-dir .tmp/kaggle/spi
    python tools/fetch_spi.py --dry-run
    python tools/fetch_spi.py --force   # re-download even if cached
"""
from __future__ import annotations

import argparse
import csv
import io
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / ".tmp" / "spi"

# FiveThirtyEight SPI data via GitHub mirror (FTE projects API is defunct as of 2023)
FTE_SPI_URL = (
    "https://raw.githubusercontent.com/datasets/five-thirty-eight-datasets/"
    "main/datasets/soccer-spi/data/spi_matches.csv"
)
FTE_SPI_URL_FALLBACK = (
    "https://raw.githubusercontent.com/fivethirtyeight/data/"
    "master/soccer-spi/spi_matches.csv"
)

_UA = "ORACLE/1.0 (SPI fetcher)"

# SPI league names (lower-case, as found in the CSV) → football-data.co.uk div codes
SPI_LEAGUE_MAP: dict[str, str] = {
    "barclays premier league":          "E0",
    "english league championship":      "E1",
    "spanish primera division":         "SP1",
    "german bundesliga":                "D1",
    "italy serie a":                    "I1",
    "french ligue 1":                   "F1",
    "dutch eredivisie":                 "N1",
    "belgian first division a":         "B1",
    "portuguese liga":                  "P1",
    "scottish premiership":             "SC0",
    "major league soccer":              "MLS",
    "uefa champions league":            "UCL",
    "uefa europa league":               "UEL",
}

# GitHub URL for global rankings (has per-club off/def ratings)
FTE_RANKINGS_URL = (
    "https://raw.githubusercontent.com/datasets/five-thirty-eight-datasets/"
    "main/datasets/soccer-spi/data/spi_global_rankings.csv"
)


def _fetch_url(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def _season_tag(date_str: str) -> str:
    """'2023-09-15' → '2324'  (football-data.co.uk season naming)"""
    try:
        year, month = int(date_str[:4]), int(date_str[5:7])
        season_start = year if month >= 7 else year - 1
        return f"{str(season_start)[2:]}{str(season_start + 1)[2:]}"
    except Exception:
        return "unknown"


def load_spi_csv(source: str) -> list[dict]:
    """Parse SPI CSV (from string content). Returns list of row dicts."""
    reader = csv.DictReader(io.StringIO(source))
    return list(reader)


def load_rankings(rankings_raw: str) -> dict[str, tuple[float, float]]:
    """
    Parse global rankings CSV: name, league, off, def → {club_lower: (off, def)}.
    Used to enrich match rows with per-team attack/defense ratings.
    """
    result: dict[str, tuple[float, float]] = {}
    for row in csv.DictReader(io.StringIO(rankings_raw)):
        name = (row.get("name") or "").lower().strip()
        try:
            off = float(row.get("off") or 0)
            def_ = float(row.get("def") or 0)
        except (ValueError, TypeError):
            continue
        if name:
            result[name] = (off, def_)
    return result


def build_features(rows: list[dict], rankings: dict[str, tuple[float, float]]) -> list[dict]:
    """
    Convert raw SPI match rows to GBM feature rows.

    GitHub mirror CSV columns:
      date, league_id, team1, team2, spi1, spi2, prob1, prob2, probtie,
      proj_score1, proj_score2, score1, score2, xg1, xg2, nsxg1, nsxg2,
      adj_score1, adj_score2

    Note: off/def not in match CSV — enriched from global rankings snapshot.
    """
    features: list[dict] = []

    for row in rows:
        date = row.get("date", "")
        # league col is league_id (numeric) in this file; use empty string for div lookup
        league_raw = (row.get("league") or "").lower().strip()
        team1 = (row.get("team1") or "").strip()
        team2 = (row.get("team2") or "").strip()

        if not date or not team1 or not team2:
            continue

        div = SPI_LEAGUE_MAP.get(league_raw, "UNK")
        season = _season_tag(date)

        # Combined SPI (always present)
        try:
            spi1 = float(row.get("spi1") or 0)
            spi2 = float(row.get("spi2") or 0)
        except (ValueError, TypeError):
            continue

        # Per-team off/def from rankings snapshot (best available)
        t1_key = team1.lower()
        t2_key = team2.lower()
        home_off, home_def = rankings.get(t1_key, (spi1, spi1))
        away_off, away_def = rankings.get(t2_key, (spi2, spi2))

        # nsxg = non-shot xG (expected goals without shot location data) — useful as extra signal
        try:
            nsxg1 = float(row.get("nsxg1") or 0)
            nsxg2 = float(row.get("nsxg2") or 0)
        except (ValueError, TypeError):
            nsxg1 = nsxg2 = 0.0

        features.append({
            "date": date,
            "season": season,
            "div": div,
            "home": team1,
            "away": team2,
            "home_spi": round(spi1, 4),
            "away_spi": round(spi2, 4),
            "home_spi_off": round(home_off, 4),
            "home_spi_def": round(home_def, 4),
            "away_spi_off": round(away_off, 4),
            "away_spi_def": round(away_def, 4),
            "spi_off_diff": round(home_off - away_off, 4),
            "spi_def_diff": round(home_def - away_def, 4),
            "spi_nsxg_home": round(nsxg1, 4),
            "spi_nsxg_away": round(nsxg2, 4),
        })

    return features


def write_features(features: list[dict], dry_run: bool) -> None:
    if not features:
        print("[spi] no features to write")
        return

    # Bucket by div+season for easy join in gbm_residual.py
    buckets: dict[str, list[dict]] = defaultdict(list)
    for row in features:
        key = f"{row['div']}_{row['season']}"
        buckets[key].append(row)

    if dry_run:
        print(f"[dry-run] would write SPI features for {len(buckets)} div/season buckets")
        sample = features[0] if features else {}
        print(f"  sample: {sample}")
        return

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Write combined file
    combined_path = OUT_DIR / "spi_features.csv"
    fieldnames = ["date", "season", "div", "home", "away",
                  "home_spi", "away_spi",
                  "home_spi_off", "home_spi_def", "away_spi_off", "away_spi_def",
                  "spi_off_diff", "spi_def_diff", "spi_nsxg_home", "spi_nsxg_away"]
    with open(combined_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(features)

    print(f"[spi] wrote {len(features)} rows → {combined_path}")

    # Write per-bucket files for direct join with backfill CSVs
    for bucket_key, rows in buckets.items():
        bucket_path = OUT_DIR / f"spi_{bucket_key}.csv"
        with open(bucket_path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)

    print(f"[spi] wrote {len(buckets)} per-div/season files to {OUT_DIR}/")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--local-dir", type=Path, default=None,
        help="Path to Kaggle download directory (contains spi_matches.csv)",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true", help="Re-download even if cached")
    args = parser.parse_args()

    cached = OUT_DIR / "spi_matches.csv"

    raw: Optional[str] = None

    # 1. Use local Kaggle download if provided
    if args.local_dir:
        local_csv = Path(args.local_dir) / "spi_matches.csv"
        if not local_csv.exists():
            # Try recursive search
            candidates = list(Path(args.local_dir).rglob("spi_matches.csv"))
            if candidates:
                local_csv = candidates[0]

        if local_csv.exists():
            raw = local_csv.read_text(encoding="utf-8-sig")
            print(f"[spi] loaded from local file: {local_csv}")

    # 2. Use disk cache
    if raw is None and cached.exists() and not args.force:
        raw = cached.read_text(encoding="utf-8")
        print(f"[spi] using cached data: {cached}")

    # 3. Fetch from FiveThirtyEight (primary URL, then fallback)
    if raw is None:
        for attempt, url in enumerate([FTE_SPI_URL, FTE_SPI_URL_FALLBACK], 1):
            print(f"[spi] downloading from source {attempt}: {url}")
            try:
                raw = _fetch_url(url)
                if not args.dry_run:
                    OUT_DIR.mkdir(parents=True, exist_ok=True)
                    cached.write_text(raw, encoding="utf-8")
                    print(f"[spi] cached raw CSV → {cached}")
                break
            except Exception as exc:
                print(f"[spi] source {attempt} failed: {exc}", file=sys.stderr)
        else:
            print(
                "[spi] all remote sources failed.\n"
                "Download manually from Kaggle:\n"
                "  kaggle datasets download -d thedevastator/club-soccer-predictions-spi-ratings-and-forecast\n"
                "Then pass: --local-dir <unzip-dir>",
                file=sys.stderr,
            )
            sys.exit(1)

    rows = load_spi_csv(raw)
    print(f"[spi] parsed {len(rows)} rows")

    # Fetch global rankings for per-club off/def enrichment
    rankings: dict[str, tuple[float, float]] = {}
    rankings_cached = OUT_DIR / "spi_rankings.csv"
    if rankings_cached.exists() and not args.force:
        rankings_raw = rankings_cached.read_text(encoding="utf-8")
        rankings = load_rankings(rankings_raw)
        print(f"[spi] loaded {len(rankings)} club ratings from cache")
    else:
        print(f"[spi] downloading global rankings…")
        try:
            rankings_raw = _fetch_url(FTE_RANKINGS_URL)
            rankings = load_rankings(rankings_raw)
            if not args.dry_run:
                OUT_DIR.mkdir(parents=True, exist_ok=True)
                rankings_cached.write_text(rankings_raw, encoding="utf-8")
            print(f"[spi] loaded {len(rankings)} club off/def ratings")
        except Exception as exc:
            print(f"[spi] rankings fetch failed ({exc}) — using combined SPI as off/def proxy",
                  file=sys.stderr)

    features = build_features(rows, rankings)
    print(f"[spi] built {len(features)} feature rows")

    write_features(features, args.dry_run)


if __name__ == "__main__":
    main()
