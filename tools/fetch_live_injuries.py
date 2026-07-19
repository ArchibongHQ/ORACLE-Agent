"""
fetch_live_injuries.py — Fetch live, daily injuries/suspensions via
API-Football (v3), per fixture.

NAMING NOTE: tools/fetch_injuries.py already exists and does something
different (aggregates a Kaggle historical dataset into per-team SEASON
injury-burden CSV features, wired into acquire_daily.py behind
ORACLE_FETCH_INJURIES — see that file's docstring). This tool is a third,
separate signal: TODAY's actual injury/suspension news, per fixture, for ANY
league, pulled live from API-Football. It is also distinct from
tools/fetch_squad_availability.py (Kaggle Transfermarkt squad-value proxy,
top-5 leagues, weekly refresh, feeds SportyBetStats.availability /
keyPlayerPresent). All three coexist; none replaces another.

Modeled closely on tools/fetch_lineups.py (same API_FOOTBALL_KEY/HOST
env-loading, same _api_get() helper, same --dry-run/--fixture-id/
--fixture-ids/--minutes-before argparse shape, same rate-limit sleep between
calls, same "write per-fixture raw JSON + one aggregated summary JSON"
output). Optional/best-effort, same fail-open convention as every other
fetcher in this family (lineups, weather, referee assignments): a missing
key, a failed call, or a malformed response degrades to "no injuries block"
for that fixture — no fixture ever crashes because this data is missing.

Outputs injuries data to .tmp/injuries_live/ and an aggregated summary into
the ORACLE daily store so tools/scrape_fixtures.py can attach a per-fixture
liveInjuries block (see _load_injuries_table()/_injuries_for() there).

API-Football free tier: 100 calls/day (shared budget with fetch_lineups.py
and other fetchers — this tool makes 1 call per fixture plus 1 for the
fixtures list itself, same shape as fetch_lineups.py).
Requires: API_FOOTBALL_KEY in .env

Output:
  .tmp/injuries_live/{fixture_id}.json     — raw API response, per fixture
  .tmp/oracle-store/injuries.json          — aggregated: {"injuries": [
      {"home": str, "away": str, "home_injuries": [...], "away_injuries": [...],
       "home_count": int, "away_count": int}, ...]}
    (same convention as .tmp/oracle-store/referee_assignments.json's
    {"assignments": [...]} shape — see tools/scrape_fixtures.py's
    _load_referee_assignments_table() for the reader this mirrors)

Usage:
    python tools/fetch_live_injuries.py                          # today's fixtures
    python tools/fetch_live_injuries.py --fixture-id 12345        # specific fixture
    python tools/fetch_live_injuries.py --fixture-ids 12345 67890
    python tools/fetch_live_injuries.py --dry-run                 # print without storing
    python tools/fetch_live_injuries.py --minutes-before 75       # poll window

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
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
INJURIES_DIR = ROOT / ".tmp" / "injuries_live"
STORE_DIR = ROOT / ".tmp" / "oracle-store"
STORE_PATH = STORE_DIR / "injuries.json"

API_BASE = "https://v3.football.api-sports.io"
_UA = "ORACLE/1.0 (live injuries fetcher)"


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


def fetch_injuries(fixture_id: int, key: str, host: str) -> dict:
    """Fetch injuries/suspensions for a specific fixture ID.

    Uses ?fixture={id} — the correct filter for ORACLE's per-fixture use
    case, mirroring fetch_lineups.py's fixtures/lineups?fixture={id}
    pattern. API-Football's /injuries also accepts team+season, league+
    season, or player+season as alternate filter combos, but those aren't
    relevant to a single-fixture lookup.
    """
    data = _api_get("injuries", {"fixture": str(fixture_id)}, key, host)
    return data


def parse_injuries(raw: dict, home_name: str, away_name: str) -> tuple[list[dict], list[dict]]:
    """
    Split API-Football's flat /injuries response array into home/away lists.

    Each entry in raw["response"] looks like:
      {"player": {"id", "name", "photo"}, "team": {"id", "name", "logo"},
       "fixture": {...}, "league": {...}, "type": str, "reason": str}

    Team assignment is by exact team-name match against home_name/away_name
    (the fixture meta passed in from main() already carries the names
    scraped alongside the fixture list). An entry whose team name matches
    neither side is skipped rather than guessed at — response arrays are
    typically 0-4 entries, so a wrong attribution is worse than dropping
    that one entry.
    """
    home: list[dict] = []
    away: list[dict] = []
    for entry in raw.get("response", []) or []:
        player = entry.get("player") or {}
        team = entry.get("team") or {}
        name = player.get("name") or ""
        if not name:
            continue
        item = {
            "name": name,
            "type": entry.get("type") or "",
            "reason": entry.get("reason") or "",
        }
        team_name = team.get("name") or ""
        if team_name == home_name:
            home.append(item)
        elif team_name == away_name:
            away.append(item)
        else:
            continue
    return home, away


def summarise_injuries(
    home_list: list[dict], away_list: list[dict], fixture_meta: dict
) -> dict:
    """Build the per-fixture summary entry for the aggregated store file."""
    return {
        "fixture_id": fixture_meta.get("fixture_id", ""),
        "home": fixture_meta.get("home", ""),
        "away": fixture_meta.get("away", ""),
        "date": fixture_meta.get("date", ""),
        "home_injuries": home_list,
        "away_injuries": away_list,
        "home_count": len(home_list),
        "away_count": len(away_list),
    }


def process_fixture(
    fixture_id: int,
    fixture_meta: dict,
    key: str,
    host: str,
    dry_run: bool,
) -> Optional[dict]:
    """Fetch, parse, and store injuries for one fixture."""
    cache_path = INJURIES_DIR / f"{fixture_id}.json"

    if cache_path.exists() and not dry_run:
        raw = json.loads(cache_path.read_text())
        print(f"[live-injuries] loaded cached {fixture_id}")
    else:
        print(f"[live-injuries] fetching fixture {fixture_id}…")
        try:
            raw = fetch_injuries(fixture_id, key, host)
        except Exception as exc:
            print(f"[live-injuries] fetch failed for {fixture_id}: {exc}", file=sys.stderr)
            return None

        if not dry_run:
            INJURIES_DIR.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(raw, indent=2))

    home_list, away_list = parse_injuries(
        raw, fixture_meta.get("home", ""), fixture_meta.get("away", "")
    )
    return summarise_injuries(home_list, away_list, fixture_meta)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--fixture-id", type=int, default=None)
    parser.add_argument("--fixture-ids", type=int, nargs="+", default=None)
    parser.add_argument("--minutes-before", type=int, default=75,
                        help="Only fetch if kick-off is within N minutes (default 75)")
    parser.add_argument("--max-fixtures", type=int, default=80,
                        help="Cap on per-fixture /injuries calls in one run (default 80). "
                             "API-Football's free tier is a SHARED 100-calls/day budget across "
                             "every fetcher in this codebase (fetch_lineups.py included) — "
                             "ORACLE currently scrapes ~123 fixtures/day, so an unbounded "
                             "per-fixture loop here could alone exhaust the daily quota before "
                             "other fetchers get their calls in. Highest-edge/soonest-kickoff "
                             "fixtures are prioritised (today's fixtures are already sorted by "
                             "kickoff time from the API); explicit --fixture-id/--fixture-ids "
                             "runs are NOT capped (a deliberate manual request should always run).")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    env = _load_env()
    key = env.get("API_FOOTBALL_KEY", "")
    host = env.get("API_FOOTBALL_HOST", "v3.football.api-sports.io")

    if not key:
        print(
            "[live-injuries] API_FOOTBALL_KEY not set in .env\n"
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
        print("[live-injuries] fetching today's fixtures…")
        try:
            fixtures = fetch_today_fixtures(key, host)
        except Exception as exc:
            print(f"[live-injuries] failed to fetch today's fixtures: {exc}", file=sys.stderr)
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

        # Cap the auto-discovered (today's fixtures) path only — an explicit
        # --fixture-id/--fixture-ids invocation is a deliberate manual
        # request and is never capped. API-Football's free tier is a SHARED
        # 100-calls/day budget across every fetcher in this codebase; a full
        # ~123-fixture day would alone exhaust it. Already sorted by kickoff
        # time (API-Football's default fixtures-list order), so this keeps
        # the soonest kickoffs — where injury news is most likely to be
        # confirmed and most actionable — over fixtures many hours out.
        if len(fixture_ids) > args.max_fixtures:
            print(
                f"[live-injuries] {len(fixture_ids)} fixtures in window exceeds "
                f"--max-fixtures={args.max_fixtures} — capping to the soonest "
                f"{args.max_fixtures} kickoffs to stay inside the shared "
                "API-Football daily quota"
            )
            fixture_ids = fixture_ids[: args.max_fixtures]

    if not fixture_ids:
        print("[live-injuries] no fixtures in window — nothing to fetch")
        return

    print(f"[live-injuries] processing {len(fixture_ids)} fixture(s)")
    summaries: list[dict] = []

    for fid in fixture_ids:
        summary = process_fixture(fid, fixture_metas[fid], key, host, args.dry_run)
        if summary:
            summaries.append(summary)
        time.sleep(0.3)  # respect rate limit

    if summaries and not args.dry_run:
        STORE_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "injuries": [
                {
                    "home": s["home"],
                    "away": s["away"],
                    "home_injuries": s["home_injuries"],
                    "away_injuries": s["away_injuries"],
                    "home_count": s["home_count"],
                    "away_count": s["away_count"],
                }
                for s in summaries
            ]
        }
        STORE_PATH.write_text(json.dumps(payload, indent=2))
        print(f"[live-injuries] wrote {len(summaries)} summaries -> {STORE_PATH}")
    elif summaries and args.dry_run:
        print(f"[dry-run] would write {len(summaries)} injury summaries")
        print("  sample:", json.dumps(summaries[0], indent=2)[:500])


if __name__ == "__main__":
    main()
