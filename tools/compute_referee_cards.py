#!/usr/bin/env python3
"""compute_referee_cards.py — lake-computed referee cards-rate (PR-25 item 2).

Referee cards-rate signal for the cards markets (marketsV3/engines/cards.ts +
its new shadow-diagnostic sibling refereeCardsShadow.ts). Zero new scraping is
needed for this half of the feature: `.tmp/backfill/{season}_{fdco}.csv`
(football-data.co.uk format, the SAME lake `compute_league_baselines.py`
already reads) carries a `Referee` column plus `HY`/`AY` (home/away yellow)
and `HR`/`AR` (home/away red) for every historical match — verified live
against `.tmp/backfill/2425_E0.csv` (26 distinct EPL referees, 23-30 games
each for the busiest).

Research (real-time, cite-checked — see the PR description for full sourcing):
top referees issue ~23% more cards than average, bottom ~19% fewer
(Oxford Academic JRSS-A "Yellow Fever" Conway-Maxwell-Poisson copula paper +
Dean Markwick's independent stan_glmer analysis). The effect is real but
requires empirical-Bayes shrinkage for low-sample referees (a ref with 3-5
games in the lake is mostly noise; one with 100+ games is mostly signal).

Design choices (deliberately deviating from a naive per-source convention —
documented so a future reviewer doesn't "fix" this back to something that
breaks the shadow-diagnostic's unit compatibility):

  1. COUNT, not points-weighted (yellow + red, weight 1 each) — NOT the
     "yellow + 2*red" weighting some referee-strictness studies use. Reason:
     the consumer of this rate (marketsV3/refereeCardsShadow.ts) diffs it
     directly against V3CardsMeans.total from engines/cards.ts, which is
     itself a plain COUNT (cardsAvgH + cardsAvgA — see that file's header:
     "Total Booking Points" (points-weighted) is deliberately NOT priced
     there since no separate red-card rate is tracked). A points-weighted
     referee rate would be a different unit than the model's count-based
     mean and produce a nonsensical shadow diff. Count-based keeps the two
     numbers comparable apples-to-apples.

  2. Flat aggregate over the season window, NOT recency-weighted (unlike
     compute_league_baselines.py's linear recency weighting for goals).
     League scoring rates drift season-to-season (rule changes, managerial
     eras); a referee's personal card-issuing tendency is a more stable
     individual trait over a several-season window, so a flat rate across
     the window is the more defensible default here. Revisit with recency
     weighting only if ledger evidence shows real season-to-season drift.

  3. Shrinkage: shrunk_rate = (n*observed + k*league_mean) / (n+k), a
     standard empirical-Bayes "pseudo-count" point estimate (Efron-Morris /
     James-Stein family, simplified — no per-referee variance term). k=10
     chosen to mirror this repo's existing SHRINK_THRESHOLD-style credibility
     weighting (sportyBetStats.ts uses a linear credibility weight w=n/8 for
     thin-sample xG): a referee with n=4 games gets a shrink weight of
     4/14=0.29 toward their own rate (heavily regressed to the league mean,
     matching the task's "3-5 games -> heavy shrink" requirement); n=100
     gets 100/110=0.91 (barely shrunk, matching "100+ games -> stays close
     to own empirical rate").

  4. Keyed by (league, normalised-referee), NOT referee name alone — the
     same surname can referee in more than one country/league, and even
     within one source, names collide across leagues in the lake's own
     Div codes. The "league" component of the key is the SAME canonical
     league name compute_league_baselines.py already produces
     (FDCO_TO_NAME), imported from that module rather than duplicated.

  5. Normalisation key is (first-initial, surname), NOT team_names.py's
     normalise_team (that's for TEAM names, referees aren't teams, no alias
     table applies) and NOT a plain lowercase-collapse (too strict — see the
     name-format gap below). football-data.co.uk stores referees ABBREVIATED
     ("R Jones", "A Taylor", "M Oliver" — verified in 2425_E0.csv), while
     premierleague.com's "Match Officials" articles (fetch_referee_
     assignments.py, this PR's other half) use FULL first names ("Rob
     Jones", "Anthony Taylor", "Michael Oliver"). A first-initial+surname key
     collapses "R Jones" and "Rob Jones" to the same "r.jones" bucket without
     needing a name-alias table. Known false-negative: two referees who
     share BOTH a first initial and surname (rare) collide; known
     false-positive risk: none identified (surname + initial is a fairly
     tight key for football officials rosters, which are small).

Output: .tmp/oracle-store/referee_cards.json
  {
    "computedAt": ISO8601,
    "source": ".tmp/backfill",
    "seasonsUsed": [...],
    "shrinkK": 10.0,
    "leagueMeans": {"Premier League": 3.62, ...},
    "byKey": {
      "Premier League|r.jones": {
        "league": "Premier League", "referee": "R Jones",
        "n": 87, "rawRate": 3.41, "shrunkRate": 3.44
      }, ...
    }
  }

Usage:
    python tools/compute_referee_cards.py            # write JSON
    python tools/compute_referee_cards.py --report    # write + print summary
    python tools/compute_referee_cards.py --dry-run   # print, don't write
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    import compute_league_baselines as clb
except ImportError:  # repo root on sys.path instead of tools/
    from tools import compute_league_baselines as clb

ROOT = Path(__file__).resolve().parent.parent
BACKFILL_DIR = ROOT / ".tmp" / "backfill"
OUT_PATH = ROOT / ".tmp" / "oracle-store" / "referee_cards.json"

# Empirical-Bayes pseudo-count — see design note 3 above.
SHRINK_K_DEFAULT = 10.0

_WS_RE = re.compile(r"\s+")


def normalise_referee(raw: str) -> str:
    """(first-initial, surname) key — see design note 5 above. Strips a
    trailing "(pictured)" annotation (premierleague.com convention, e.g.
    "Michael Oliver (pictured)") before splitting. Returns the lowercased
    whole string unchanged when it has fewer than 2 tokens (can't derive an
    initial+surname pair — better to keep it distinguishable than collapse
    unrelated single-token entries onto each other)."""
    s = re.sub(r"\(.*?\)", "", raw).strip()
    s = _WS_RE.sub(" ", s)
    parts = s.split(" ")
    if len(parts) < 2 or not parts[0] or not parts[-1]:
        return s.lower()
    initial = parts[0][0].lower()
    surname = parts[-1].lower()
    return f"{initial}.{surname}"


def _read_season_referee_cards(path: Path) -> dict[str, tuple[float, int]]:
    """Return {raw_referee_name: (total_cards_sum, matches)} for one season
    CSV, skipping rows with a blank referee or non-numeric HY/AY/HR/AR
    (postponed/void/malformed rows — same tolerant-skip convention as
    compute_league_baselines.py's _read_season)."""
    out: dict[str, list] = defaultdict(lambda: [0.0, 0])
    totals: dict[str, tuple[float, int]] = {}
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            ref = (row.get("Referee") or "").strip()
            if not ref:
                continue
            try:
                hy = float((row.get("HY") or "").strip() or "nan")
                ay = float((row.get("AY") or "").strip() or "nan")
                hr = float((row.get("HR") or "0").strip() or "0")
                ar = float((row.get("AR") or "0").strip() or "0")
            except ValueError:
                continue
            if hy != hy or ay != ay:  # NaN check without importing math
                continue
            cards = hy + ay + hr + ar
            cur = out[ref]
            cur[0] += cards
            cur[1] += 1
    for ref, (total, n) in out.items():
        if n:
            totals[ref] = (total, int(n))
    return totals


def compute_referee_cards(
    backfill_dir: Path, seasons: int = 5, k: float = SHRINK_K_DEFAULT
) -> tuple[dict[str, dict], dict[str, float], list[str]]:
    """Compute per-(league, referee) shrunk cards-per-game rates from a
    backfill dir. Flat (non-recency-weighted) aggregate over the most recent
    `seasons` seasons per league — see design note 2. Returns
    (by_key, league_means, seasons_used_global)."""
    by_key: dict[str, dict] = {}
    league_means: dict[str, float] = {}
    seasons_used_global: set[str] = set()

    if not backfill_dir.is_dir():
        return {}, {}, []

    # (fdco, season) -> path, mirroring compute_league_baselines.py's grouping.
    per_season: dict[str, dict[str, Path]] = defaultdict(dict)
    for path in sorted(backfill_dir.glob("*.csv")):
        fdco = clb._fdco_from_filename(path.name)
        season = clb._season_from_filename(path.name)
        if fdco not in clb.FDCO_TO_NAME or not season:
            continue
        per_season[fdco][season] = path

    for fdco, season_map in per_season.items():
        league = clb.FDCO_TO_NAME[fdco]
        recent = sorted(season_map.keys())[-seasons:]
        seasons_used_global.update(recent)

        # normalised key -> [display_name, cards_sum, matches], aggregated
        # across the whole window.
        agg: dict[str, list] = defaultdict(lambda: [None, 0.0, 0])
        league_cards_sum = 0.0
        league_matches = 0

        for season in recent:
            season_totals = _read_season_referee_cards(season_map[season])
            for raw_ref, (cards_sum, n) in season_totals.items():
                key = normalise_referee(raw_ref)
                entry = agg[key]
                if entry[0] is None:
                    entry[0] = raw_ref
                entry[1] += cards_sum
                entry[2] += n
                league_cards_sum += cards_sum
                league_matches += n

        if league_matches == 0:
            continue
        league_mean = round(league_cards_sum / league_matches, 3)
        league_means[league] = league_mean

        for key, (display, cards_sum, n) in agg.items():
            if n <= 0:
                continue
            raw_rate = cards_sum / n
            shrunk_rate = (n * raw_rate + k * league_mean) / (n + k)
            by_key[f"{league}|{key}"] = {
                "league": league,
                "referee": display,
                "n": int(n),
                "rawRate": round(raw_rate, 3),
                "shrunkRate": round(shrunk_rate, 3),
            }

    return by_key, league_means, sorted(seasons_used_global)


def build_report(by_key: dict[str, dict], league_means: dict[str, float]) -> list[str]:
    lines = ["[referee-cards] league means + top shrunk referees:"]
    by_league: dict[str, list[dict]] = defaultdict(list)
    for entry in by_key.values():
        by_league[entry["league"]].append(entry)
    for league in sorted(league_means):
        mean = league_means[league]
        lines.append(f"  {league:<24} league_mean={mean:.2f}")
        refs = sorted(by_league.get(league, []), key=lambda e: -e["shrunkRate"])
        for e in refs[:3]:
            lines.append(
                f"      {e['referee']:<20} n={e['n']:<4} raw={e['rawRate']:.2f}  shrunk={e['shrunkRate']:.2f}"
            )
    return lines


def main() -> None:
    parser = argparse.ArgumentParser(description="Compute lake referee cards-rate")
    parser.add_argument("--seasons", type=int, default=5,
                        help="most-recent N seasons per league (default 5)")
    parser.add_argument("--shrink-k", type=float, default=SHRINK_K_DEFAULT,
                        help=f"empirical-Bayes pseudo-count (default {SHRINK_K_DEFAULT})")
    parser.add_argument("--report", action="store_true",
                        help="print a league-mean + top-referee summary")
    parser.add_argument("--dry-run", action="store_true",
                        help="print without writing the JSON")
    args = parser.parse_args()

    by_key, league_means, seasons_used = compute_referee_cards(
        BACKFILL_DIR, args.seasons, args.shrink_k
    )
    if not by_key:
        print(f"[referee-cards] ERROR: no usable CSVs in {BACKFILL_DIR}", file=sys.stderr)
        sys.exit(1)

    print(f"[referee-cards] {len(by_key)} referees across {len(league_means)} leagues, "
          f"seasons={seasons_used}")
    if args.report:
        for line in build_report(by_key, league_means):
            print(line)

    if args.dry_run:
        print("[referee-cards] Dry run — nothing written.")
        return

    payload = {
        "computedAt": datetime.now(tz=timezone.utc).isoformat(),
        "source": str(BACKFILL_DIR.relative_to(ROOT)),
        "seasonsUsed": seasons_used,
        "shrinkK": args.shrink_k,
        "leagueMeans": league_means,
        "byKey": by_key,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"[referee-cards] -> {OUT_PATH}  ({len(by_key)} referees)")


if __name__ == "__main__":
    main()
