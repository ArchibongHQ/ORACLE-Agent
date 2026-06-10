"""
fetch_weather.py — Match-day weather features from the Open-Meteo archive API.

No Kaggle, no API key, free. Historical daily weather at the home team's city.
Rain, cold, and wind demonstrably reduce goals and favour defences — directly
affects H/D/A probability calibration.

API: https://archive-api.open-meteo.com/v1/archive
  daily=temperature_2m_mean,precipitation_sum,wind_speed_10m_max&timezone=GMT
  Returns °C / mm / km/h already — no unit conversion needed.

Coordinates are city-level (weather is regional, not stadium-specific). The home
team name is normalised to a city via TEAM_CITY; NaN for any team not in the map
(XGBoost handles NaN). Covers ORACLE's top-5 + English league teams.

Responses cached by (lat, lon, date) to .tmp/weather/cache/{lat}_{lon}_{date}.json
so re-runs hit disk, not the network.

Output: .tmp/weather/weather_features.csv
  date, home, league, temp_c, precip_mm, wind_kph, is_adverse

GBM features wired via load_weather() + build_features() in gbm_residual.py:
  tempC, precipMm, windKph, isAdverse

Usage:
    python tools/fetch_weather.py --backfill-dir .tmp/backfill
    python tools/fetch_weather.py --backfill-dir .tmp/backfill --dry-run
    python tools/fetch_weather.py --backfill-dir .tmp/backfill --seasons 2425 2324
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / ".tmp" / "weather"
CACHE_DIR = OUT_DIR / "cache"

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# Adverse-weather thresholds (precip in mm, wind in km/h).
ADVERSE_PRECIP_MM = 5.0
ADVERSE_WIND_KPH = 50.0

# Home-team name (football-data.co.uk style) → (city_lat, city_lon).
# City-level coordinates — weather is regional. Covers the leagues ORACLE
# backfills (E0/E1/SP1/D1/I1/F1 + common N1/P1/B1/SC0 sides).
TEAM_CITY: dict[str, tuple[float, float]] = {
    # ── England (E0/E1) ──
    "arsenal": (51.51, -0.11), "chelsea": (51.48, -0.19), "tottenham": (51.60, -0.07),
    "west ham": (51.54, 0.02), "crystal palace": (51.40, -0.09), "fulham": (51.47, -0.22),
    "brentford": (51.49, -0.29), "qpr": (51.51, -0.23), "millwall": (51.49, -0.05),
    "charlton": (51.49, 0.04), "watford": (51.65, -0.40), "luton": (51.88, -0.43),
    "man united": (53.46, -2.29), "man city": (53.48, -2.20),
    "liverpool": (53.43, -2.96), "everton": (53.44, -2.97),
    "newcastle": (54.98, -1.62), "sunderland": (54.91, -1.39), "middlesbrough": (54.58, -1.22),
    "leeds": (53.78, -1.57), "sheffield united": (53.37, -1.47), "sheffield weds": (53.41, -1.50),
    "aston villa": (52.51, -1.89), "birmingham": (52.48, -1.87), "wolves": (52.59, -2.13),
    "west brom": (52.51, -1.96), "coventry": (52.45, -1.50), "leicester": (52.62, -1.14),
    "nott'm forest": (52.94, -1.13), "derby": (52.92, -1.45), "stoke": (53.01, -2.18),
    "southampton": (50.91, -1.39), "bournemouth": (50.74, -1.84), "brighton": (50.86, -0.08),
    "portsmouth": (50.80, -1.06), "norwich": (52.62, 1.31), "ipswich": (52.06, 1.15),
    "burnley": (53.79, -2.23), "blackburn": (53.73, -2.49), "preston": (53.77, -2.69),
    "hull": (53.75, -0.37), "bristol city": (51.44, -2.62), "cardiff": (51.47, -3.20),
    "swansea": (51.64, -3.93), "reading": (51.42, -0.98), "blackpool": (53.80, -3.05),
    "rotherham": (53.43, -1.36), "barnsley": (53.55, -1.47), "huddersfield": (53.65, -1.77),
    "wigan": (53.55, -2.65), "plymouth": (50.39, -4.15),
    # ── Spain (SP1) ──
    "real madrid": (40.45, -3.69), "ath madrid": (40.44, -3.60), "atletico madrid": (40.44, -3.60),
    "barcelona": (41.38, 2.12), "espanol": (41.35, 2.10), "espanyol": (41.35, 2.10),
    "sevilla": (37.38, -5.97), "betis": (37.36, -5.98), "valencia": (39.47, -0.36),
    "villarreal": (39.94, -0.10), "ath bilbao": (43.26, -2.95), "athletic club": (43.26, -2.95),
    "sociedad": (43.30, -1.97), "real sociedad": (43.30, -1.97), "celta": (42.21, -8.74),
    "getafe": (40.32, -3.71), "osasuna": (42.80, -1.61), "girona": (41.96, 2.83),
    "vallecano": (40.39, -3.66), "rayo vallecano": (40.39, -3.66), "mallorca": (39.59, 2.65),
    "alaves": (42.84, -2.69), "las palmas": (28.10, -15.46), "granada": (37.15, -3.60),
    "cadiz": (36.50, -6.27), "valladolid": (41.64, -4.76), "leganes": (40.34, -3.76),
    # ── Germany (D1) ──
    "bayern munich": (48.22, 11.62), "dortmund": (51.49, 7.45), "leverkusen": (51.04, 7.00),
    "leipzig": (51.34, 12.35), "rb leipzig": (51.34, 12.35), "ein frankfurt": (50.07, 8.65),
    "wolfsburg": (52.43, 10.80), "freiburg": (47.99, 7.83), "hoffenheim": (49.24, 8.89),
    "stuttgart": (48.79, 9.23), "union berlin": (52.46, 13.57), "werder bremen": (53.07, 8.84),
    "augsburg": (48.32, 10.89), "mainz": (50.01, 8.22), "m'gladbach": (51.17, 6.39),
    "bochum": (51.49, 7.24), "heidenheim": (48.68, 10.14), "st pauli": (53.55, 9.97),
    "koln": (50.93, 6.87), "fc koln": (50.93, 6.87), "darmstadt": (49.86, 8.65),
    "hamburg": (53.59, 10.02), "hertha": (52.51, 13.24), "schalke 04": (51.55, 7.07),
    # ── Italy (I1) ──
    "juventus": (45.11, 7.64), "inter": (45.48, 9.12), "milan": (45.48, 9.12),
    "napoli": (40.83, 14.19), "roma": (41.93, 12.45), "lazio": (41.93, 12.45),
    "atalanta": (45.71, 9.68), "fiorentina": (43.78, 11.28), "bologna": (44.49, 11.31),
    "torino": (45.04, 7.65), "genoa": (44.42, 8.95), "sampdoria": (44.42, 8.95),
    "udinese": (46.08, 13.20), "sassuolo": (44.62, 10.78), "verona": (45.44, 10.97),
    "cagliari": (39.20, 9.14), "lecce": (40.36, 18.21), "empoli": (43.72, 10.95),
    "monza": (45.58, 9.31), "parma": (44.79, 10.34), "como": (45.81, 9.08),
    "salernitana": (40.65, 14.84), "frosinone": (41.63, 13.32), "venezia": (45.44, 12.36),
    # ── France (F1) ──
    "paris sg": (48.84, 2.25), "marseille": (43.27, 5.40), "lyon": (45.77, 4.98),
    "monaco": (43.73, 7.42), "lille": (50.61, 3.13), "rennes": (48.11, -1.71),
    "nice": (43.70, 7.27), "lens": (50.43, 2.81), "nantes": (47.26, -1.52),
    "strasbourg": (48.56, 7.75), "montpellier": (43.62, 3.81), "reims": (49.25, 4.02),
    "toulouse": (43.58, 1.43), "brest": (48.40, -4.46), "nimes": (43.81, 4.34),
    "lorient": (47.75, -3.37), "clermont": (45.78, 3.08), "metz": (49.11, 6.16),
    "auxerre": (47.78, 3.59), "angers": (47.46, -0.53), "le havre": (49.49, 0.17),
    "st etienne": (45.46, 4.39), "bordeaux": (44.83, -0.56),
}

# Shared team-name normalisation (audit M2-1). The old local _normalise kept
# apostrophes; the shared one strips them and applies the alias map, so the
# TEAM_CITY keys are canonicalised once at import to keep lookups consistent.
try:
    from lib.team_names import normalise_team as _normalise
except ImportError:  # repo root on sys.path instead of tools/
    from tools.lib.team_names import normalise_team as _normalise

TEAM_CITY = {_normalise(k): v for k, v in TEAM_CITY.items()}


def _find_col(cols: list[str], candidates: list[str]) -> str | None:
    lower = {c.lower(): c for c in cols}
    for c in candidates:
        if c.lower() in lower:
            return lower[c.lower()]
    return None


def collect_matches(backfill_dir: Path, seasons: list[str] | None) -> list[dict]:
    """
    Read backfill CSVs → list of {date, home, league} for matches whose home team
    is in TEAM_CITY. football-data.co.uk dates are DD/MM/YYYY or DD/MM/YY.
    """
    matches: list[dict] = []
    seen: set[tuple] = set()
    files = sorted(backfill_dir.glob("*.csv"))
    for fp in files:
        # filename: {season}_{div}.csv e.g. 2425_E0.csv
        stem = fp.stem
        parts = stem.split("_")
        season = parts[0] if parts else ""
        if seasons and season not in seasons:
            continue
        try:
            with open(fp, newline="", encoding="utf-8-sig") as fh:
                reader = csv.DictReader(fh)
                cols = reader.fieldnames or []
                date_col = _find_col(cols, ["Date"])
                home_col = _find_col(cols, ["HomeTeam", "Home"])
                div_col = _find_col(cols, ["Div"])
                if not (date_col and home_col):
                    continue
                for raw in reader:
                    home_raw = (raw.get(home_col) or "").strip()
                    norm = _normalise(home_raw)
                    if norm not in TEAM_CITY:
                        continue
                    date_iso = _to_iso(raw.get(date_col, ""))
                    if not date_iso:
                        continue
                    league = (raw.get(div_col) or "").strip() if div_col else ""
                    key = (date_iso, norm)
                    if key in seen:
                        continue
                    seen.add(key)
                    matches.append({"date": date_iso, "home": norm, "league": league})
        except Exception as exc:
            print(f"[weather] skip {fp.name}: {exc}")
    print(f"[weather] {len(matches)} unique (date, home) matches with known coordinates")
    return matches


def _to_iso(date_raw: str) -> str:
    """DD/MM/YYYY or DD/MM/YY → YYYY-MM-DD. Empty on failure."""
    date_raw = date_raw.strip()
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{2,4})$", date_raw)
    if not m:
        return ""
    d, mo, y = m.group(1), m.group(2), m.group(3)
    if len(y) == 2:
        y = ("20" if int(y) < 70 else "19") + y
    return f"{y}-{int(mo):02d}-{int(d):02d}"


def fetch_weather(lat: float, lon: float, date_iso: str, throttle: float) -> dict | None:
    """
    Fetch daily weather for one (lat, lon, date). Disk-cached. Returns
    {temp_c, precip_mm, wind_kph} or None on failure/no-data.
    """
    cache_path = CACHE_DIR / f"{lat:.2f}_{lon:.2f}_{date_iso}.json"
    if cache_path.exists():
        try:
            with open(cache_path, encoding="utf-8") as fh:
                cached = json.load(fh)
            if cached.get("_miss"):
                return None
            return cached
        except Exception:
            pass

    url = (
        f"{ARCHIVE_URL}?latitude={lat:.2f}&longitude={lon:.2f}"
        f"&start_date={date_iso}&end_date={date_iso}"
        f"&daily=temperature_2m_mean,precipitation_sum,wind_speed_10m_max&timezone=GMT"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "oracle-agent/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as exc:
        print(f"[weather] fetch failed {lat:.2f},{lon:.2f} {date_iso}: {exc}")
        return None
    finally:
        if throttle > 0:
            time.sleep(throttle)

    daily = payload.get("daily") or {}
    temps = daily.get("temperature_2m_mean") or []
    precs = daily.get("precipitation_sum") or []
    winds = daily.get("wind_speed_10m_max") or []
    if not temps or temps[0] is None:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as fh:
            json.dump({"_miss": True}, fh)
        return None

    result = {
        "temp_c": float(temps[0]),
        "precip_mm": float(precs[0]) if precs and precs[0] is not None else 0.0,
        "wind_kph": float(winds[0]) if winds and winds[0] is not None else 0.0,
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh)
    return result


def write_output(rows: list[dict], out_path: Path, dry_run: bool) -> None:
    if dry_run:
        print(f"[weather] [dry-run] would write {len(rows)} rows")
        if rows:
            print(f"  sample: {rows[0]}")
        return
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(
            fh, fieldnames=["date", "home", "league", "temp_c", "precip_mm", "wind_kph", "is_adverse"]
        )
        writer.writeheader()
        writer.writerows(rows)
    print(f"[weather] Wrote {len(rows)} rows -> {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Match-day weather features from Open-Meteo")
    parser.add_argument("--backfill-dir", default=".tmp/backfill",
                        help="Dir with football-data.co.uk backfill CSVs (default: .tmp/backfill)")
    parser.add_argument("--out-dir", default=str(OUT_DIR), help="Output directory (default: .tmp/weather)")
    parser.add_argument("--seasons", nargs="*", help="Only these season codes e.g. 2425 2324")
    parser.add_argument("--throttle", type=float, default=0.2,
                        help="Seconds to sleep between live API calls (default 0.2; 0 to disable)")
    parser.add_argument("--limit", type=int, default=0,
                        help="Cap number of matches processed (0 = all; useful for smoke tests)")
    parser.add_argument("--dry-run", action="store_true", help="List matches; no fetch, no write")
    args = parser.parse_args()

    backfill_dir = Path(args.backfill_dir)
    if not backfill_dir.exists():
        print(f"[weather] ERROR: backfill dir not found: {backfill_dir}")
        print("  Run tools/backfill_oracle.py first.")
        sys.exit(1)

    matches = collect_matches(backfill_dir, args.seasons)
    if args.limit > 0:
        matches = matches[: args.limit]

    if args.dry_run:
        write_output([], Path(args.out_dir) / "weather_features.csv", dry_run=True)
        print(f"[weather] [dry-run] {len(matches)} matches would be fetched "
              f"({len(TEAM_CITY)} teams in coordinate map)")
        if matches:
            print(f"  sample match: {matches[0]}")
        return

    rows: list[dict] = []
    hits = 0
    for i, m in enumerate(matches):
        lat, lon = TEAM_CITY[m["home"]]
        wx = fetch_weather(lat, lon, m["date"], args.throttle)
        if wx is None:
            continue
        hits += 1
        is_adverse = 1 if (wx["precip_mm"] > ADVERSE_PRECIP_MM or wx["wind_kph"] > ADVERSE_WIND_KPH) else 0
        rows.append({
            "date": m["date"],
            "home": m["home"],
            "league": m["league"],
            "temp_c": f"{wx['temp_c']:.1f}",
            "precip_mm": f"{wx['precip_mm']:.2f}",
            "wind_kph": f"{wx['wind_kph']:.1f}",
            "is_adverse": is_adverse,
        })
        if (i + 1) % 500 == 0:
            print(f"[weather] {i + 1}/{len(matches)} processed ({hits} resolved)")

    write_output(rows, Path(args.out_dir) / "weather_features.csv", dry_run=False)
    print(f"[weather] Done. {hits}/{len(matches)} matches resolved. "
          f"Next: python tools/gbm_residual.py --dry-run to verify tempC/precipMm/windKph/isAdverse cols")


if __name__ == "__main__":
    main()
