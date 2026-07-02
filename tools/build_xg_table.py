"""build_xg_table.py — aggregate Understat per-match xG CSVs into a rolling
team-strength prior, keyed by normalised team name.

Reads the .tmp/xg/{div}_{season}.csv files written by fetch_xg.py and, for each
team, averages xG-for / xG-against over its most recent N matches (current season
first, prior seasons as fallback). The result is a forward-looking *strength
prior* — NOT a per-fixture xG projection — consumed at fixture-selection time by
packages/runtime/src/selectFixtures.ts (via the SportyBet sidecar xg block).

Primary coverage = Understat's top-5 leagues (EPL, La Liga, Bundesliga, Serie A,
Ligue 1) at per-match granularity with a true xG-against. FBref season-aggregate
xG (.tmp/fbref/team_season_stats.csv, written by fetch_fbref.py) is merged in as a
medium-confidence fallback to extend coverage to the World Cup, Brazilian Série
A/B and any other FBref-xG league. Understat wins on key collisions (per-match >
season mean). Teams in neither source are absent; the TS scorer then falls back to
the sidecar goals-average proxy.

Output: .tmp/xg/team_xg_table.json
  { "<normalised team>": { "xgf": float, "xga": float|None, "n": int,
                           "div": str, "src": "understat"|"fbref",
                           "home": {"xgf": float, "xga": float, "n": int} | absent,
                           "away": {"xgf": float, "xga": float, "n": int} | absent } }

goals-market-analysis-prompt-v3 gap-closure: "home"/"away" are the SAME team's
xG conditioned on playing at that venue only (Understat per-match rows already
carry venue; this was previously discarded when folding into the season
aggregate above). A fixture consumer should read the home team's "home" block
and the away team's "away" block — a strictly better prior than the season
aggregate when the team has enough venue-tagged matches. Absent when a team has
zero matches at that venue in the cached window (never a discard signal on its
own — the season aggregate above still applies). FBref-sourced records never
carry a venue split (season aggregate only).

Fail-open: if no .tmp/xg/*.csv exist, writes an empty table and exits 0.

Usage:
    python tools/build_xg_table.py             # default N=8, all cached CSVs
    python tools/build_xg_table.py --window 10 # last 10 matches per team
    python tools/build_xg_table.py --dry-run   # print counts without writing
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Optional

# Reuse the shared team-name normaliser (do not add a second one).
try:
    from scrape_fixtures import normalise
except ImportError:  # repo root on sys.path instead of tools/
    from tools.scrape_fixtures import normalise

XG_DIR = Path(".tmp/xg")
FBREF_CSV = Path(".tmp/fbref/team_season_stats.csv")
OUTPUT_PATH = XG_DIR / "team_xg_table.json"
DEFAULT_WINDOW = 8

# football-data.co.uk div code → display league (matches fetch_xg.LEAGUE_MAP values)
_DIV_CODES = {"E0", "SP1", "D1", "I1", "F1"}


def _load_rows(csv_path: Path) -> list[dict]:
    """Read one fetch_xg.py CSV. Malformed rows are skipped, never fatal."""
    rows: list[dict] = []
    try:
        with csv_path.open(encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                try:
                    rows.append(
                        {
                            "date": r["date"],
                            "home": r["home"],
                            "away": r["away"],
                            "xg_home": float(r["xg_home"]),
                            "xg_away": float(r["xg_away"]),
                        }
                    )
                except (KeyError, ValueError, TypeError):
                    continue
    except OSError as exc:
        print(f"[xg-table] WARN: cannot read {csv_path.name}: {exc}", file=sys.stderr)
    return rows


def _div_of(csv_path: Path) -> str:
    """E0_2324.csv → 'E0' (the div code prefix), else '' if unrecognised."""
    code = csv_path.stem.split("_", 1)[0]
    return code if code in _DIV_CODES else ""


def build_table(window: int) -> dict[str, dict]:
    """Aggregate all cached CSVs into a per-team rolling xGF/xGA table.

    Each team's matches are collected across every CSV, sorted most-recent-first
    by date, and the latest `window` matches averaged. Team venue (home/away)
    selects which xG column is "for" vs "against".
    """
    csv_paths = sorted(XG_DIR.glob("*.csv"))
    if not csv_paths:
        return {}

    # team key → { "div": str, "matches": [(date, xgf, xga)],
    #              "home_matches": [...], "away_matches": [...] }
    acc: dict[str, dict] = {}

    def _record(team_raw: str, div: str, date: str, xgf: float, xga: float, venue: str) -> None:
        key = normalise(team_raw)
        if not key:
            return
        slot = acc.setdefault(
            key, {"div": div, "matches": [], "home_matches": [], "away_matches": []}
        )
        slot["matches"].append((date, xgf, xga))
        slot[f"{venue}_matches"].append((date, xgf, xga))

    for path in csv_paths:
        div = _div_of(path)
        if not div:
            continue
        for m in _load_rows(path):
            # Home perspective: xg_home for, xg_away against; away is the mirror.
            _record(m["home"], div, m["date"], m["xg_home"], m["xg_away"], "home")
            _record(m["away"], div, m["date"], m["xg_away"], m["xg_home"], "away")

    def _avg(matches: list[tuple[str, float, float]]) -> Optional[dict]:
        if not matches:
            return None
        recent = sorted(matches, key=lambda t: t[0], reverse=True)[:window]
        n = len(recent)
        return {
            "xgf": round(sum(t[1] for t in recent) / n, 4),
            "xga": round(sum(t[2] for t in recent) / n, 4),
            "n": n,
        }

    table: dict[str, dict] = {}
    for key, slot in acc.items():
        season = _avg(slot["matches"])
        if not season:
            continue
        rec = {**season, "div": slot["div"], "src": "understat"}
        home_split = _avg(slot["home_matches"])
        away_split = _avg(slot["away_matches"])
        if home_split:
            rec["home"] = home_split
        if away_split:
            rec["away"] = away_split
        table[key] = rec
    return table


def _load_fbref_xg() -> dict[str, dict]:
    """Season-aggregate FBref xG as a medium-confidence fallback prior.

    fetch_fbref.py emits per-team-season totals including team xG (StatsBomb model)
    where FBref publishes it. We derive a per-match xGF = xg / matches-played
    (approximated as minutes/990 ≈ 11 players × 90 min). The player aggregate has
    no team-conceded figure, so xga is left None — the TS override then uses xGF
    only at medium confidence. Most-recent season per team wins.

    Returns: { "<normalised team>": {"xgf": float, "xga": None, "n": int,
                                     "div": str, "src": "fbref"} }
    """
    if not FBREF_CSV.exists():
        return {}
    # team key → (season, record); keep the latest season seen per team
    best: dict[str, tuple[str, dict]] = {}
    try:
        with FBREF_CSV.open(encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                xg_raw = (r.get("xg") or "").strip()
                if not xg_raw:
                    continue  # league without StatsBomb xG coverage
                try:
                    xg = float(xg_raw)
                    minutes = float(r.get("minutes") or "0")
                except (ValueError, TypeError):
                    continue
                matches = minutes / 990.0  # 11 outfield-equivalent × 90
                if matches < 1.0:
                    continue
                key = normalise(r.get("squad") or "")
                if not key:
                    continue
                season = (r.get("season") or "").strip()
                rec = {
                    "xgf": round(xg / matches, 4),
                    "xga": None,
                    "n": int(round(matches)),
                    "div": (r.get("fdco_league") or "").strip(),
                    "src": "fbref",
                }
                prev = best.get(key)
                if prev is None or season > prev[0]:
                    best[key] = (season, rec)
    except OSError as exc:
        print(f"[xg-table] WARN: cannot read {FBREF_CSV}: {exc}", file=sys.stderr)
        return {}
    return {k: rec for k, (_, rec) in best.items()}


def _load_json_xg_table(path: Path) -> dict[str, dict]:
    """Load a fetch_fotmob_xg.py / fetch_sofascore.py --xg-teams output file
    (same per-team {xgf, xga, n, div, src} shape). Missing/corrupt file →
    empty dict, never fatal — these tiers are optional gap-fillers."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build rolling team-xG prior table (Understat > FotMob > Sofascore > FBref)"
    )
    parser.add_argument("--window", type=int, default=DEFAULT_WINDOW,
                        help=f"matches per team to average (default {DEFAULT_WINDOW})")
    parser.add_argument("--dry-run", action="store_true",
                        help="print counts without writing the table")
    args = parser.parse_args()

    table = build_table(max(1, args.window))
    understat_n = len(table)

    # goals-market-analysis-prompt-v3 gap-closure merge order: Understat (best —
    # per-match, true xGA, venue split) > FotMob (1000+ competitions) > Sofascore
    # > FBref (stale since the Jan 2026 Opta licence loss, season-aggregate only).
    # Each tier only fills teams the tiers above it don't already cover.
    fotmob_added = 0
    for key, rec in _load_json_xg_table(XG_DIR / "fotmob_xg.json").items():
        if key not in table:
            table[key] = rec
            fotmob_added += 1

    sofascore_added = 0
    for key, rec in _load_json_xg_table(XG_DIR / "sofascore_xg.json").items():
        if key not in table:
            table[key] = rec
            sofascore_added += 1

    fbref = _load_fbref_xg()
    added = 0
    for key, rec in fbref.items():
        if key not in table:
            table[key] = rec
            added += 1

    if not table:
        print("[xg-table] no Understat/FotMob/Sofascore/FBref data found — writing empty table (fail-open)")
    else:
        print(
            f"[xg-table] understat={understat_n} teams, fotmob-added={fotmob_added}, "
            f"sofascore-added={sofascore_added}, fbref-added={added} teams"
        )

    if args.dry_run:
        print(f"[xg-table] {len(table)} teams (dry-run, not written)")
        return

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUTPUT_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(table, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(OUTPUT_PATH)
    print(f"[xg-table] {len(table)} teams -> {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
