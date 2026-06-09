"""
fetch_lineups.py — Fetch confirmed/expected lineups via API-Football (v3).

Lineup availability 60–75 minutes before kick-off is the highest-priority
missing soft context signal for ORACLE's decision layer (PRD: HIGH severity gap).

Outputs lineup data to .tmp/lineups/ and injects a lineup summary into the
ORACLE daily store so the LLM decision layer can read it in its prompt.

API-Football free tier: 100 calls/day (sufficient for ~50 fixtures/day).
Requires: API_FOOTBALL_KEY in .env

Output per fixture:
  .tmp/lineups/{fixture_id}.json  — raw API response
  .tmp/lineups/today_summary.json — aggregated: {home_xi, away_xi, home_missing, away_missing}

Usage:
    python tools/fetch_lineups.py                          # today's fixtures
    python tools/fetch_lineups.py --fixture-id 12345       # specific fixture
    python tools/fetch_lineups.py --fixture-ids 12345 67890
    python tools/fetch_lineups.py --dry-run                # print without storing
    python tools/fetch_lineups.py --minutes-before 75      # poll window

Environment:
    API_FOOTBALL_KEY=<your-key>   (set in .env)
    API_FOOTBALL_HOST=v3.football.api-sports.io  (default)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent.parent
LINEUPS_DIR = ROOT / ".tmp" / "lineups"
FIXTURES_CACHE = ROOT / ".tmp" / "fixtures" / "today.txt"
STORE_DIR = ROOT / ".tmp" / "oracle-store"

API_BASE = "https://v3.football.api-sports.io"
_UA = "ORACLE/1.0 (lineup fetcher)"

# Positions used to flag formation shape
GK = "G"
DEF_POSITIONS = {"D", "CB", "LB", "RB", "LWB", "RWB"}
MID_POSITIONS = {"M", "CM", "CDM", "CAM", "DM", "AM", "LM", "RM"}
FWD_POSITIONS = {"F", "CF", "ST", "LW", "RW", "SS"}


def _load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip().strip('"').strip("'")
    # os.environ takes precedence
    for key in ("API_FOOTBALL_KEY", "API_FOOTBALL_HOST"):
        if key in os.environ:
            env[key] = os.environ[key]
    return env


def _api_get(endpoint: str, params: dict[str, str], key: str, host: str) -> dict:
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{API_BASE}/{endpoint}?{qs}"
    req = urllib.request.Request(
        url,
        headers={
            "x-rapidapi-key": key,
            "x-rapidapi-host": host,
            "User-Agent": _UA,
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_today_fixtures(key: str, host: str) -> list[dict]:
    """Fetch today's fixture IDs from API-Football."""
    today = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
    data = _api_get("fixtures", {"date": today}, key, host)
    return data.get("response", [])


def fetch_lineup(fixture_id: int, key: str, host: str) -> dict:
    """Fetch lineup for a specific fixture ID."""
    data = _api_get("fixtures/lineups", {"fixture": str(fixture_id)}, key, host)
    return data


def parse_lineup(raw: dict, team_key: str = "home") -> dict:
    """
    Extract starting XI, formation, and substitute list from API-Football lineup response.

    Returns:
      {
        "team": str,
        "formation": str,
        "starting_xi": [{"name": str, "pos": str, "number": int}],
        "substitutes": [str],
        "confirmed": bool,
      }
    """
    responses = raw.get("response", [])
    if not responses:
        return {"team": "", "formation": "", "starting_xi": [], "substitutes": [], "confirmed": False}

    # API-Football returns [home_lineup, away_lineup]
    idx = 0 if team_key == "home" else 1
    if idx >= len(responses):
        return {"team": "", "formation": "", "starting_xi": [], "substitutes": [], "confirmed": False}

    lineup = responses[idx]
    team_name = lineup.get("team", {}).get("name", "")
    formation = lineup.get("formation", "")

    starting = []
    for player in lineup.get("startXI", []):
        p = player.get("player", {})
        starting.append({
            "name": p.get("name", ""),
            "pos": p.get("pos", ""),
            "number": p.get("number", 0),
        })

    subs = [
        player.get("player", {}).get("name", "")
        for player in lineup.get("substitutes", [])
    ]

    return {
        "team": team_name,
        "formation": formation,
        "starting_xi": starting,
        "substitutes": subs,
        "confirmed": bool(starting),
    }


def _formation_defensiveness(formation: str) -> float:
    """
    Heuristic score: higher = more defensive. Based on number of defenders.
    '4-3-3' → 4 defenders → 0.4, '5-4-1' → 5 defenders → 0.6
    """
    if not formation:
        return 0.5  # neutral default
    parts = [int(x) for x in formation.split("-") if x.isdigit()]
    if not parts:
        return 0.5
    defenders = parts[0]
    total_outfield = sum(parts)
    return round(defenders / total_outfield, 3) if total_outfield else 0.5


def summarise_lineup(home_lineup: dict, away_lineup: dict, fixture_meta: dict) -> dict:
    """Build a soft-context summary for the LLM decision prompt."""
    return {
        "fixture_id": fixture_meta.get("fixture_id", ""),
        "home": fixture_meta.get("home", ""),
        "away": fixture_meta.get("away", ""),
        "date": fixture_meta.get("date", ""),
        "home_formation": home_lineup.get("formation", "unknown"),
        "away_formation": away_lineup.get("formation", "unknown"),
        "home_defensive_score": _formation_defensiveness(home_lineup.get("formation", "")),
        "away_defensive_score": _formation_defensiveness(away_lineup.get("formation", "")),
        "home_xi_confirmed": home_lineup.get("confirmed", False),
        "away_xi_confirmed": away_lineup.get("confirmed", False),
        "home_starting_xi": [p["name"] for p in home_lineup.get("starting_xi", [])],
        "away_starting_xi": [p["name"] for p in away_lineup.get("starting_xi", [])],
        "home_subs": home_lineup.get("substitutes", []),
        "away_subs": away_lineup.get("substitutes", []),
    }


def process_fixture(
    fixture_id: int,
    fixture_meta: dict,
    key: str,
    host: str,
    dry_run: bool,
) -> Optional[dict]:
    """Fetch, parse, and store lineup for one fixture."""
    cache_path = LINEUPS_DIR / f"{fixture_id}.json"

    if cache_path.exists() and not dry_run:
        raw = json.loads(cache_path.read_text())
        print(f"[lineups] loaded cached {fixture_id}")
    else:
        print(f"[lineups] fetching fixture {fixture_id}…")
        try:
            raw = fetch_lineup(fixture_id, key, host)
        except Exception as exc:
            print(f"[lineups] fetch failed for {fixture_id}: {exc}", file=sys.stderr)
            return None

        if not dry_run:
            LINEUPS_DIR.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(raw, indent=2))

    home_lineup = parse_lineup(raw, "home")
    away_lineup = parse_lineup(raw, "away")
    summary = summarise_lineup(home_lineup, away_lineup, fixture_meta)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--fixture-id", type=int, default=None)
    parser.add_argument("--fixture-ids", type=int, nargs="+", default=None)
    parser.add_argument("--minutes-before", type=int, default=75,
                        help="Only fetch if kick-off is within N minutes (default 75)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    env = _load_env()
    key = env.get("API_FOOTBALL_KEY", "")
    host = env.get("API_FOOTBALL_HOST", "v3.football.api-sports.io")

    if not key:
        print(
            "[lineups] API_FOOTBALL_KEY not set in .env\n"
            "Get a free key at https://www.api-football.com (100 calls/day free tier)",
            file=sys.stderr,
        )
        sys.exit(1)

    fixture_ids: list[int] = []
    fixture_metas: dict[int, dict] = {}

    if args.fixture_id:
        fixture_ids = [args.fixture_id]
        fixture_metas[args.fixture_id] = {"fixture_id": args.fixture_id, "home": "", "away": "", "date": ""}

    elif args.fixture_ids:
        fixture_ids = args.fixture_ids
        for fid in fixture_ids:
            fixture_metas[fid] = {"fixture_id": fid, "home": "", "away": "", "date": ""}

    else:
        print("[lineups] fetching today's fixtures…")
        try:
            fixtures = fetch_today_fixtures(key, host)
        except Exception as exc:
            print(f"[lineups] failed to fetch today's fixtures: {exc}", file=sys.stderr)
            sys.exit(1)

        now = datetime.now(tz=timezone.utc)
        for fx in fixtures:
            fdata = fx.get("fixture", {})
            fid = fdata.get("id")
            kickoff_str = fdata.get("date", "")
            if not fid:
                continue
            # Filter by kick-off window
            if kickoff_str:
                try:
                    from datetime import datetime as dt2
                    ko = dt2.fromisoformat(kickoff_str.replace("Z", "+00:00"))
                    minutes_to_ko = (ko - now).total_seconds() / 60
                    if not (0 <= minutes_to_ko <= args.minutes_before):
                        continue
                except Exception:
                    pass

            teams = fx.get("teams", {})
            fixture_metas[fid] = {
                "fixture_id": fid,
                "home": teams.get("home", {}).get("name", ""),
                "away": teams.get("away", {}).get("name", ""),
                "date": fdata.get("date", ""),
            }
            fixture_ids.append(fid)

    if not fixture_ids:
        print("[lineups] no fixtures in window — nothing to fetch")
        return

    print(f"[lineups] processing {len(fixture_ids)} fixture(s)")
    summaries: list[dict] = []

    for fid in fixture_ids:
        summary = process_fixture(fid, fixture_metas[fid], key, host, args.dry_run)
        if summary:
            summaries.append(summary)
        time.sleep(0.3)  # respect rate limit

    if summaries and not args.dry_run:
        LINEUPS_DIR.mkdir(parents=True, exist_ok=True)
        today_path = LINEUPS_DIR / "today_summary.json"
        today_path.write_text(json.dumps(summaries, indent=2))
        print(f"[lineups] wrote {len(summaries)} summaries → {today_path}")

        # Also write to oracle-store so decision layer can read it
        STORE_DIR.mkdir(parents=True, exist_ok=True)
        store_path = STORE_DIR / "oracle_lineups.json"
        store_path.write_text(json.dumps(summaries, indent=2))
        print(f"[lineups] stored → {store_path}")
    elif summaries and args.dry_run:
        print(f"[dry-run] would write {len(summaries)} lineup summaries")
        print("  sample:", json.dumps(summaries[0], indent=2)[:500])


if __name__ == "__main__":
    main()
