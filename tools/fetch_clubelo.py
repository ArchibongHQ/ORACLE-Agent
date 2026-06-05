"""fetch_clubelo.py — Download ClubElo ratings and seed GBrain (PRD §8.3 Tier 3).

ClubElo API (no auth, free): http://api.clubelo.com/YYYY-MM-DD -> CSV
Format: Rank,Club,Country,Level,Elo,From,To

Writes:
  .tmp/clubelo/ratings_YYYY-MM-DD.json   — full snapshot for the date
  .tmp/oracle-store/oracle_clubelo.json  — GBrain key (latest ratings, keyed by club name)

Usage:
    python tools/fetch_clubelo.py                   # today's ratings
    python tools/fetch_clubelo.py --date 2026-06-03 # specific date
    python tools/fetch_clubelo.py --dry-run         # print without writing
"""
import argparse
import csv
import json
import sys
import urllib.request
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLUBELO_API = "http://api.clubelo.com/{date}"
OUT_DIR = ROOT / ".tmp" / "clubelo"
STORE_PATH = ROOT / ".tmp" / "oracle-store" / "oracle_clubelo.json"

# ORACLE league -> ClubElo country/level filters for focused pulls
ORACLE_LEAGUES: dict[str, tuple[str, int]] = {
    "Premier League":       ("ENG", 1),
    "Championship":         ("ENG", 2),
    "La Liga":              ("ESP", 1),
    "Bundesliga":           ("GER", 1),
    "Serie A":              ("ITA", 1),
    "Ligue 1":              ("FRA", 1),
    "Eredivisie":           ("NED", 1),
    "Primeira Liga":        ("POR", 1),
    "Belgian Pro League":   ("BEL", 1),
    "Scottish Premiership": ("SCO", 1),
    "Champions League":     ("", 0),   # cross-league, all clubs
    "Europa League":        ("", 0),
    "Conference League":    ("", 0),
    "J League":             ("JPN", 1),
    "MLS":                  ("USA", 1),
    "World Cup":            ("", 0),
}


def _utc_today() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")


def fetch_ratings(date_str: str) -> list[dict]:
    """Fetch all club ratings from ClubElo for the given date."""
    url = CLUBELO_API.format(date=date_str)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ORACLE/1.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
    except Exception as exc:
        print(f"[clubelo] ERROR: fetch failed — {exc}", file=sys.stderr)
        sys.exit(1)

    reader = csv.DictReader(StringIO(raw))
    rows = []
    for row in reader:
        try:
            rows.append({
                "club":    row.get("Club", "").strip(),
                "country": row.get("Country", "").strip(),
                "level":   int(row.get("Level", 0) or 0),
                "elo":     float(row.get("Elo", 0) or 0),
                "from":    row.get("From", "").strip(),
                "to":      row.get("To", "").strip(),
            })
        except (ValueError, KeyError):
            continue
    return rows


def filter_oracle_leagues(rows: list[dict]) -> list[dict]:
    """Keep clubs from ORACLE's covered leagues."""
    oracle_countries = {c for c, _ in ORACLE_LEAGUES.values() if c}
    oracle_levels    = {lv for _, lv in ORACLE_LEAGUES.values() if lv}
    return [
        r for r in rows
        if not oracle_countries                          # empty = include all
        or (r["country"] in oracle_countries and r["level"] in oracle_levels)
        or r["level"] == 1                               # always include top-tier
    ]


def build_store(rows: list[dict], fetched_at: str) -> dict:
    """Build the GBrain key payload — keyed by club name for fast lookup."""
    ratings = {r["club"]: {"elo": r["elo"], "country": r["country"], "level": r["level"]} for r in rows}
    return {
        "fetchedAt": fetched_at,
        "source": "api.clubelo.com",
        "count": len(ratings),
        "ratings": ratings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch ClubElo ratings -> GBrain store")
    parser.add_argument("--date", default=None, help="YYYY-MM-DD (default: UTC today)")
    parser.add_argument("--dry-run", action="store_true", help="Print stats without writing")
    args = parser.parse_args()

    date_str = args.date or _utc_today()
    print(f"[clubelo] Fetching ratings for {date_str} from api.clubelo.com …")

    all_rows = fetch_ratings(date_str)
    print(f"[clubelo] {len(all_rows)} total clubs fetched")

    oracle_rows = filter_oracle_leagues(all_rows)
    print(f"[clubelo] {len(oracle_rows)} clubs in ORACLE leagues")

    # Print top 10 by Elo for a quick sanity check
    top10 = sorted(oracle_rows, key=lambda r: r["elo"], reverse=True)[:10]
    print("[clubelo] Top 10 by Elo:")
    for r in top10:
        print(f"  {r['club']:<30} {r['country']} Lv{r['level']}  Elo={r['elo']:.0f}")

    if args.dry_run:
        print("[clubelo] Dry run — nothing written.")
        return

    # Write full snapshot
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    snapshot_path = OUT_DIR / f"ratings_{date_str}.json"
    snapshot_path.write_text(
        json.dumps({"date": date_str, "clubs": oracle_rows}, indent=2),
        encoding="utf-8",
    )
    print(f"[clubelo] Snapshot -> {snapshot_path}")

    # Write GBrain store key
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    store = build_store(oracle_rows, fetched_at=datetime.now(tz=timezone.utc).isoformat())
    STORE_PATH.write_text(json.dumps(store, indent=2), encoding="utf-8")
    print(f"[clubelo] GBrain store -> {STORE_PATH}  ({store['count']} ratings)")
    print("[clubelo] Done. Use oracle_clubelo ratings as GBM features in tools/gbm_residual.py")


if __name__ == "__main__":
    main()
