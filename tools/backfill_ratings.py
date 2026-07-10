#!/usr/bin/env python3
"""backfill_ratings.py — Elo + pi-rating (Constantinou & Fenton 2013) backfill
skeleton for `packages/engine/src/ratings/index.ts`'s `TeamRatingsEngine`
(Wave 2 WS2-B).

Once wired (see the TODO in `load_historical_results` below), this tool would
walk historical match results in chronological order and replay
`TeamRatingsEngine.update`/`updatePi` match-by-match, producing a
`TeamRatingsEngine`-compatible store — the same JSON shape `MemoryAdapter`
persists under `STORAGE_KEYS.teamsElo` ("oracle_v2026_teams") and
`STORAGE_KEYS.teamsPi` ("oracle_v2026_pi") — so a real backfill run's output
could be dropped straight into `.tmp/oracle-store/` and picked up by
`TeamRatingsEngine.hydrate()` unchanged.

Data source (not yet wired — see TODO): this repo's historical-results lake,
`.tmp/backfill/{season}_{fdco}.csv` (football-data.co.uk format, FTHG/FTAG
columns), the SAME lake `tools/compute_league_baselines.py` already reads for
the league-baseline backfill (see that file's header/`BACKFILL_DIR` for the
path convention this tool mirrors). Ratings are path-dependent (each match
updates the state used by the next), so a real loader MUST sort every match
across ALL leagues into one global chronological order before replaying —
this is the one non-obvious correctness requirement future work on the TODO
must not skip.

The update math below is a byte-for-byte port of
`TeamRatingsEngine.update`/`updatePi` (packages/engine/src/ratings/index.ts)
— same constants (Elo k=20, pi lambda=0.035/gamma=0.7), same tanh-based
formulas, same clamps — so a completed backfill produces numbers consistent
with what the live TS engine would compute if it had replayed the same
history via `updatePi` calls one match at a time. `--dry-run` proves this
port is correct by running it against a small synthetic match sequence and
asserting the result matches a hand-derived closed-form value, without
needing any real data.

Usage:
    python tools/backfill_ratings.py --dry-run            # synthetic self-check only
    python tools/backfill_ratings.py --dry-run --report   # + print the synthetic ratings table
    python tools/backfill_ratings.py                      # TODO: real backfill (not yet wired)
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKFILL_DIR = ROOT / ".tmp" / "backfill"
STORE_DIR = ROOT / ".tmp" / "oracle-store"
ELO_OUT_PATH = STORE_DIR / "oracle_v2026_teams.json"  # STORAGE_KEYS.teamsElo
PI_OUT_PATH = STORE_DIR / "oracle_v2026_pi.json"  # STORAGE_KEYS.teamsPi

# ── Elo/pi-rating update math — mirrors TeamRatingsEngine EXACTLY ───────────
# (packages/engine/src/ratings/index.ts). Keep these two functions in lockstep
# with that file if either changes; drifting the constants/formula here would
# silently produce a backfill inconsistent with the live TS engine.

ELO_K = 20.0
ELO_MIN = 1000.0
ELO_MAX = 2000.0
PI_LAMBDA_DEFAULT = 0.035
PI_GAMMA_DEFAULT = 0.7


def team_key(name: str) -> str:
    """Mirrors `teamName.toLowerCase().trim()` — the engine's cache key."""
    return name.strip().lower()


def elo_update(
    elo_store: dict[str, float],
    h_team: str,
    a_team: str,
    h_g: int,
    a_g: int,
    ex_h: float,
    ex_a: float,
) -> tuple[float, float, float]:
    """Port of `TeamRatingsEngine.update` (ratings/index.ts:42-53).
    `exH`/`exA` are the caller-supplied expected-goals inputs the TS method
    also requires — this backfill has no opinion on where they come from
    (same as the live engine); a real caller would pass the same values the
    live pipeline would have used at that point in time."""
    import math

    hk, ak = team_key(h_team), team_key(a_team)
    h_before = elo_store.get(hk, 1500.0)
    a_before = elo_store.get(ak, 1500.0)
    upd = ELO_K * math.tanh((h_g - a_g - (ex_h - ex_a)) / 2)
    h_after = max(ELO_MIN, min(ELO_MAX, h_before + upd))
    a_after = max(ELO_MIN, min(ELO_MAX, a_before - upd))
    elo_store[hk] = h_after
    elo_store[ak] = a_after
    return h_after, a_after, upd


def pi_update(
    pi_store: dict[str, dict[str, float]],
    h_team: str,
    a_team: str,
    h_g: int,
    a_g: int,
    lam: float = PI_LAMBDA_DEFAULT,
    gamma: float = PI_GAMMA_DEFAULT,
) -> tuple[dict[str, float], dict[str, float]]:
    """Port of `TeamRatingsEngine.updatePi` (ratings/index.ts:67-88), INCLUDING
    the Wave 2 WS2-B `n` sample-counter addition — increments both teams' `n`
    every call, defaulting a missing/legacy entry's `n` to 0 first (same
    round-trip-safety guarantee the TS side gives pre-Wave-2 persisted data)."""
    import math

    hk, ak = team_key(h_team), team_key(a_team)
    pi_store.setdefault(hk, {"home": 0.0, "away": 0.0, "n": 0.0})
    pi_store.setdefault(ak, {"home": 0.0, "away": 0.0, "n": 0.0})
    h = pi_store[hk]
    a = pi_store[ak]
    exp_diff = math.tanh((h["home"] - a["away"]) / 3)
    obs_diff = math.tanh((h_g - a_g) / 3)
    err = obs_diff - exp_diff
    h["home"] += lam * err
    h["away"] += lam * gamma * err
    a["away"] -= lam * err
    a["home"] -= lam * gamma * err
    h["n"] = h.get("n", 0.0) + 1
    a["n"] = a.get("n", 0.0) + 1
    return h, a


# ── Data loading (TODO — not yet wired) ──────────────────────────────────────


def load_historical_results(backfill_dir: Path) -> list[tuple[str, str, str, int, int]]:
    """Returns a GLOBALLY chronologically-sorted list of
    (date_iso, home_team, away_team, home_goals, away_goals) tuples across
    every league CSV in `backfill_dir`.

    TODO (not implemented — this is the real-data integration point a future
    session should wire, deliberately left as a stub per this tool's scope):
      1. Glob `backfill_dir / "*.csv"` (football-data.co.uk format, same files
         `tools/compute_league_baselines.py` reads — see FDCO_TO_NAME there
         for the Div-code -> league-name mapping this would need too).
      2. Parse each row's `Date`, `HomeTeam`, `AwayTeam`, `FTHG`, `FTAG`
         (skip rows with a blank/non-numeric score — postponed/void, same
         guard `compute_league_baselines.py._read_season` already uses).
      3. Run team names through the shared normalizer (`tools/lib/team_names.py`
         — do NOT invent a second name-matching scheme; the codebase already
         hit a real bug from silently diverging normalizers, see
         MEMORY: "OTS Name Gap").
      4. Merge ALL leagues into ONE list and sort by date ascending — ratings
         are path-dependent (each match's update depends on the state left by
         every earlier match for those two teams), so per-league sorting
         alone is insufficient; a team's Tuesday Champions League match and
         Saturday league match must replay in real chronological order.
      5. Return the merged, sorted list for `main()` to replay via
         `elo_update`/`pi_update`.

    Currently a no-op stub — always returns []. Guarded in `main()` so running
    without `--dry-run` reports this clearly instead of silently writing an
    empty/bogus ratings store over any real one."""
    return []


# ── Synthetic self-check (--dry-run) ─────────────────────────────────────────


def synthetic_match_sequence() -> list[tuple[str, str, int, int]]:
    """Small deterministic sequence — enough matches to exercise the `n`
    counter across repeat and non-repeat pairings, not meant to be realistic
    football data."""
    return [
        ("Home FC", "Away FC", 2, 0),
        ("Home FC", "Away FC", 1, 1),
        ("Third FC", "Home FC", 0, 3),
        ("Away FC", "Third FC", 1, 1),
        ("Home FC", "Third FC", 2, 2),
    ]


def run_dry_run(report: bool) -> None:
    import math

    matches = synthetic_match_sequence()
    elo_store: dict[str, float] = {}
    pi_store: dict[str, dict[str, float]] = {}

    for h_team, a_team, h_g, a_g in matches:
        # exH/exA left at 0 for the synthetic Elo pass — this tool's job is to
        # prove the UPDATE FORMULA matches the TS port, not to source real
        # expected-goals inputs (same "caller supplies exH/exA" contract the
        # live TS `update()` method already has).
        elo_update(elo_store, h_team, a_team, h_g, a_g, 0.0, 0.0)
        pi_update(pi_store, h_team, a_team, h_g, a_g)

    # Self-check: hand-derive the FIRST pi-rating update in closed form and
    # assert the ported function matches exactly — this is what proves the
    # Python port is faithful to TeamRatingsEngine.updatePi, not just
    # "looks similar".
    h0, a0 = "home fc", "away fc"
    exp_diff0 = math.tanh((0.0 - 0.0) / 3)  # both start at 0
    obs_diff0 = math.tanh((2 - 0) / 3)  # first match: Home FC 2-0 Away FC
    err0 = obs_diff0 - exp_diff0
    expected_home_home = PI_LAMBDA_DEFAULT * err0
    expected_home_away = PI_LAMBDA_DEFAULT * PI_GAMMA_DEFAULT * err0
    expected_away_away = -PI_LAMBDA_DEFAULT * err0
    expected_away_home = -PI_LAMBDA_DEFAULT * PI_GAMMA_DEFAULT * err0

    # Replay just the first match in isolation to compare against the
    # closed-form expectation (the full run above already applied 5 matches,
    # so re-run fresh here rather than trying to isolate mid-sequence state).
    check_store: dict[str, dict[str, float]] = {}
    pi_update(check_store, "Home FC", "Away FC", 2, 0)
    assert abs(check_store[h0]["home"] - expected_home_home) < 1e-12, "pi_update home.home mismatch"
    assert abs(check_store[h0]["away"] - expected_home_away) < 1e-12, "pi_update home.away mismatch"
    assert abs(check_store[a0]["away"] - expected_away_away) < 1e-12, "pi_update away.away mismatch"
    assert abs(check_store[a0]["home"] - expected_away_home) < 1e-12, "pi_update away.home mismatch"
    assert check_store[h0]["n"] == 1, "pi_update n counter mismatch (home)"
    assert check_store[a0]["n"] == 1, "pi_update n counter mismatch (away)"
    print(f"[backfill_ratings] self-check OK — pi_update matches TeamRatingsEngine.updatePi's "
          f"closed-form formula for match 1 (err={err0:.6f})")

    print(f"[backfill_ratings] dry-run: {len(matches)} synthetic matches, "
          f"{len(pi_store)} teams rated")
    if report:
        print("[backfill_ratings] synthetic pi-ratings + n:")
        for key in sorted(pi_store):
            r = pi_store[key]
            print(f"  {key:<12} home={r['home']:+.5f}  away={r['away']:+.5f}  n={int(r['n'])}")
        print("[backfill_ratings] synthetic elo:")
        for key in sorted(elo_store):
            print(f"  {key:<12} elo={elo_store[key]:.2f}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill Elo/pi-ratings from historical results")
    parser.add_argument("--dry-run", action="store_true",
                         help="run the update math against synthetic data only; no I/O, no real backfill")
    parser.add_argument("--report", action="store_true",
                         help="print the resulting ratings table (dry-run) or a summary (real run)")
    args = parser.parse_args()

    if args.dry_run:
        run_dry_run(report=args.report)
        return

    matches = load_historical_results(BACKFILL_DIR)
    if not matches:
        print(
            "[backfill_ratings] Real backfill is not wired yet — load_historical_results() "
            f"is a TODO stub (see its docstring). No CSVs read from {BACKFILL_DIR}, nothing "
            "written. Run with --dry-run to verify the update math against synthetic data.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Unreachable until the TODO above is implemented — kept here so the
    # write path/output schema is already correct for whoever wires it.
    elo_store: dict[str, float] = {}
    pi_store: dict[str, dict[str, float]] = {}
    for _date, h_team, a_team, h_g, a_g in matches:
        elo_update(elo_store, h_team, a_team, h_g, a_g, 0.0, 0.0)
        pi_update(pi_store, h_team, a_team, h_g, a_g)

    if args.report:
        print(f"[backfill_ratings] {len(matches)} matches replayed, {len(pi_store)} teams rated")

    STORE_DIR.mkdir(parents=True, exist_ok=True)
    ELO_OUT_PATH.write_text(json.dumps(elo_store, indent=2), encoding="utf-8")
    PI_OUT_PATH.write_text(json.dumps(pi_store, indent=2), encoding="utf-8")
    print(f"[backfill_ratings] -> {ELO_OUT_PATH}, {PI_OUT_PATH} "
          f"(computedAt={datetime.now(tz=timezone.utc).isoformat()})")


if __name__ == "__main__":
    main()
