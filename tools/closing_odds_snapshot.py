"""closing_odds_snapshot.py — odds-only T-30m re-snapshot for already-analysed
SportyBet fixtures (PR-8a). Plain anonymous HTTP (factsCenter/event), no
Playwright — reuses scrape_fixtures._sb_get + _parse_odds (the step-1 logic of
_fetch_fixture_detail, tools/scrape_fixtures.py:1803-1814) without any of the
stats/gismo/xg/availability calls that function also makes.

Usage:
    python tools/closing_odds_snapshot.py sr:match:123 sr:match:456
    # prints ONE JSON object to stdout: {"sr:match:123": {"1x2": {...}, ...}, ...}
    # event IDs that fail to fetch/parse are simply omitted from the output —
    # the caller (apps/worker) treats absence as "not captured this tick,
    # will retry next tick if still in the snapshot window."
"""

import argparse
import json
import time
import urllib.parse

try:
    from scrape_fixtures import _parse_odds, _sb_get, _SB_EVENT_URL, _SB_PACE
except ImportError:  # repo root on sys.path instead of tools/
    from tools.scrape_fixtures import _parse_odds, _sb_get, _SB_EVENT_URL, _SB_PACE

# Subset of _parse_odds' full result relevant to CLV/steam capture — team-totals
# (tt_home_05/tt_away_05) are dropped, everything computeRealisedClv/
# lstmMarketDecoderProxy needs (1x2) plus the other markets_v3 prices are kept.
_SNAPSHOT_FIELDS = ("1x2", "ou15", "ou25", "ou35", "btts", "dc", "dnb", "ah")


def fetch_closing_odds(event_ids: list) -> dict:
    """Sequential (not swarmed) — a due-fixture batch is typically a handful of
    fixtures per 5-min tick, plain HTTP, well inside the tick's budget. Sequential
    also keeps this immune to the Playwright-swarm BSOD class this box has
    already hit (unrelated risk class, but keeping this path simple/auditable
    is cheap insurance)."""
    out: dict = {}
    for eid in event_ids:
        eid_enc = urllib.parse.quote(eid)
        event_data = _sb_get(_SB_EVENT_URL.format(eid=eid_enc))
        if event_data:
            markets_payload = event_data.get("data", event_data)
            odds = _parse_odds(markets_payload)
            out[eid] = {k: odds.get(k) for k in _SNAPSHOT_FIELDS}
        time.sleep(_SB_PACE)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch a T-30m odds-only closing snapshot for given SportyBet event IDs"
    )
    parser.add_argument(
        "event_ids", nargs="+", help="SportyBet/Sportradar event IDs, e.g. sr:match:66456926"
    )
    args = parser.parse_args()
    print(json.dumps(fetch_closing_odds(args.event_ids)))


if __name__ == "__main__":
    main()
