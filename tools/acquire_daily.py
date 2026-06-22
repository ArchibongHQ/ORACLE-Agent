"""acquire_daily.py — Phase A daily acquisition entry point.

Runs the existing fixture + SportyBet sidecar scrape (imported from
scrape_fixtures.py, not forked), then converts the enriched event list into the
Parquet lake (tools/daily_store.py) so the worker/analysis path can read today's
slate without re-scraping live. The legacy JSON sidecar
(.tmp/fixtures/sportybet_today.json) is still written by run_acquisition() —
this script is purely additive on top of it; deleting the lake degrades the
read path back to today's exact existing behavior (fail-open, see
packages/runtime/src/dailyStore.ts).

Usage:
    python tools/acquire_daily.py                 # acquire today (UTC)
    python tools/acquire_daily.py --date 2026-06-21
    python tools/acquire_daily.py --no-playwright # ESPN+Sky+BBC only, no SportyBet sidecar
    python tools/acquire_daily.py --purge         # also run the 24h lake retention sweep after
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import daily_store as ds
import scrape_fixtures as sf


def _flatten_odds(event_id: str, date_str: str, odds: Optional[dict], scraped_at: str) -> list[dict]:
    """Tidy/long-format odds rows: one row per (market, side)."""
    if not odds:
        return []
    rows: list[dict] = []
    for market, body in odds.items():
        if not isinstance(body, dict):
            continue
        # The Asian Handicap block carries a `line` alongside home/away prices —
        # fold it into overround so the schema stays {market,side,price,overround}
        # without adding a column only AH ever populates.
        line = body.get("line")
        for side, price in body.items():
            if side == "line" or price is None:
                continue
            try:
                price_f = float(price)
            except (TypeError, ValueError):
                continue
            rows.append({
                "dt": date_str, "event_id": event_id, "market": market, "side": side,
                "price": price_f, "overround": float(line) if isinstance(line, (int, float)) else None,
                "scraped_at": scraped_at,
            })
    return rows


def _stats_rows(event_id: str, date_str: str, stats: Optional[dict],
                 statscoverage: Optional[dict], xg: Optional[dict], scraped_at: str) -> list[dict]:
    """One row per stats subtab; variable-shape bodies go in as a JSON string
    (payload_json) so the Parquet schema stays stable across days."""
    import json as _json
    rows: list[dict] = []
    for subtab, body in (stats or {}).items():
        rows.append({
            "dt": date_str, "event_id": event_id, "subtab": subtab,
            "payload_json": _json.dumps(body, ensure_ascii=False), "scraped_at": scraped_at,
        })
    if statscoverage:
        rows.append({
            "dt": date_str, "event_id": event_id, "subtab": "statscoverage",
            "payload_json": _json.dumps(statscoverage, ensure_ascii=False), "scraped_at": scraped_at,
        })
    if xg and (xg.get("home") or xg.get("away")):
        rows.append({
            "dt": date_str, "event_id": event_id, "subtab": "xg",
            "payload_json": _json.dumps(xg, ensure_ascii=False), "scraped_at": scraped_at,
        })
    return rows


def events_to_lake_rows(events: list[dict], date_str: str, scraped_at: str) -> dict[str, list[dict]]:
    """Convert sidecar-shaped events into the fixtures/odds/stats row lists."""
    fixtures: list[dict] = []
    odds: list[dict] = []
    stats: list[dict] = []
    for ev in events:
        eid = ev.get("eventId") or ""
        if not eid:
            continue
        fixtures.append({
            "dt": date_str, "event_id": eid, "home": ev.get("home"), "away": ev.get("away"),
            "league": ev.get("league"), "kickoff_utc": ev.get("kickoff_utc"),
            "market_count": ev.get("marketCount"), "scraped_at": scraped_at,
        })
        odds.extend(_flatten_odds(eid, date_str, ev.get("odds"), scraped_at))
        stats.extend(_stats_rows(eid, date_str, ev.get("stats"), ev.get("statscoverage"), ev.get("xg"), scraped_at))
    return {"fixtures": fixtures, "odds": odds, "stats": stats}


def acquire(date_str: str, quiet: bool = False, no_playwright: bool = False) -> int:
    """Run acquisition + lake write. Returns the count of fixtures acquired."""
    _merged_cache, events = sf.run_acquisition(date_str, quiet=quiet, no_playwright=no_playwright)
    scraped_at = ds.utc_now_stamp()
    rows = events_to_lake_rows(events, date_str, scraped_at)
    ds.write_table("fixtures", date_str, rows["fixtures"])
    ds.write_table("odds", date_str, rows["odds"])
    ds.write_table("stats", date_str, rows["stats"])
    if not quiet:
        print(
            f"[acquire_daily] lake write — fixtures:{len(rows['fixtures'])} "
            f"odds:{len(rows['odds'])} stats:{len(rows['stats'])}",
            flush=True,
        )
    return len(rows["fixtures"])


def main() -> None:
    parser = argparse.ArgumentParser(description="ORACLE daily acquisition -> Parquet lake")
    parser.add_argument("--date", default=None, help="YYYY-MM-DD (default: UTC today)")
    parser.add_argument("--quiet", action="store_true", help="Suppress progress output")
    parser.add_argument("--no-playwright", action="store_true",
                        help="Skip Playwright scrapers (no SportyBet sidecar; lake gets 0 odds/stats rows)")
    parser.add_argument("--purge", action="store_true", help="Run the 24h lake retention sweep after acquiring")
    args = parser.parse_args()

    date_str = args.date or ds.utc_today()
    n = acquire(date_str, quiet=args.quiet, no_playwright=args.no_playwright)

    if args.purge:
        result = ds.purge_old()
        if not args.quiet:
            print(f"[acquire_daily] purge deleted:{result['deleted']} archived:{result['archived']}", flush=True)

    print(f"acquired:{n}", flush=True)


if __name__ == "__main__":
    main()
