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
    python tools/acquire_daily.py --live-xg-refresh  # standalone FotMob xG refresh only (PR-7 off-peak cron)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import daily_store as ds
import scrape_fixtures as sf


def _maybe_fetch_injuries(quiet: bool = False) -> None:
    """PR-8: refresh per-team season injury features (fetch_injuries.py) when
    ORACLE_FETCH_INJURIES=on. This is distinct from fetch_squad_availability.py —
    that derives a match-day squad-value availability ratio from Transfermarkt,
    whereas this aggregates historical injury burden (days/count) from the Kaggle
    injuries dataset; both are real, non-overlapping signals. Best-effort: a
    missing dataset or non-zero exit must never break daily acquisition."""
    if os.environ.get("ORACLE_FETCH_INJURIES", "").strip().lower() != "on":
        return
    script = Path(__file__).resolve().parent / "fetch_injuries.py"
    try:
        proc = subprocess.run(
            [sys.executable, str(script)],
            capture_output=True, text=True, timeout=180, check=False,
        )
        if not quiet:
            status = "ok" if proc.returncode == 0 else f"exit={proc.returncode}"
            print(f"[acquire_daily] fetch_injuries {status}", flush=True)
    except Exception as exc:  # noqa: BLE001 — best-effort, never fatal
        if not quiet:
            print(f"[acquire_daily] fetch_injuries skipped: {exc}", flush=True)


def _maybe_fetch_squad_availability(quiet: bool = False) -> None:
    """Refresh the match-day squad availability feature CSV (fetch_squad_
    availability.py) when ORACLE_FETCH_SQUAD_AVAILABILITY=on. This is a Kaggle
    Transfermarkt BACKFILL over top-5-league historical matches, not a live
    per-fixture fetch — refreshing it here keeps availability_features.csv
    current with whatever Kaggle player-scores snapshot is on disk so
    scrape_fixtures.py's _load_availability_table() picks up new rows as the
    underlying dataset is updated. Requires .tmp/kaggle/player-scores/ to
    already be downloaded (see workflows/kaggle_integration.md) — a missing
    dataset exits non-zero and is logged, never fatal to daily acquisition."""
    if os.environ.get("ORACLE_FETCH_SQUAD_AVAILABILITY", "").strip().lower() != "on":
        return
    script = Path(__file__).resolve().parent / "fetch_squad_availability.py"
    try:
        proc = subprocess.run(
            [sys.executable, str(script)],
            capture_output=True, text=True, timeout=300, check=False,
        )
        if not quiet:
            status = "ok" if proc.returncode == 0 else f"exit={proc.returncode}"
            print(f"[acquire_daily] fetch_squad_availability {status}", flush=True)
    except Exception as exc:  # noqa: BLE001 — best-effort, never fatal
        if not quiet:
            print(f"[acquire_daily] fetch_squad_availability skipped: {exc}", flush=True)


def _maybe_fetch_live_xg(events: list[dict], quiet: bool = False) -> None:
    """Refresh the rolling team-xG prior from live FotMob xG when
    ORACLE_FETCH_LIVE_XG=on (default ON as of PR-7 — see run_live_xg_refresh's
    docstring for why the swarm-collision risk this was originally gated
    against no longer applies). Closes the gap where build_xg_table.py already
    merges .tmp/xg/fotmob_xg.json but nothing in production ever writes it — so
    obscure-league teams (outside Understat's top-5 + FBref's coverage) get no
    xG. FotMob covers 1000+ competitions and runs HEADLESS (unlike Sofascore,
    which needs a real display the LocalSystem service lacks), making it the
    service-viable live tier.

    Feeds `events`'s team names to fetch_fotmob_xg.py, then rebuilds the merged
    prior (build_xg_table.py). The updated prior is a rolling strength prior
    keyed by team — same semantics as the weekly Understat/FBref table — so it
    enriches each team's NEXT scrape, not retroactively the fixtures `events`
    came from (irrelevant whether those are today's live-acquired events or a
    prior day's sidecar read back from disk, per run_live_xg_refresh).

    After the FotMob+rebuild pass, PR-19 additionally runs the Google-AI-Mode
    xG fallback (tools/fetch_xg_fallback.py) over whatever teams are STILL
    missing xG (the residual gap left by Understat/FotMob/Sofascore/FBref) —
    see _maybe_fetch_xg_fallback below. Gated separately
    (ORACLE_FETCH_XG_FALLBACK) since it's a materially lower-confidence,
    LLM-prose-extraction tier; always runs inside this same off-peak window,
    never inline in the 09:30 acquisition path.

    Best-effort: any failure or timeout must never break the caller."""
    if os.environ.get("ORACLE_FETCH_LIVE_XG", "on").strip().lower() != "on":
        return
    teams = sorted({
        (ev.get(side) or "").strip()
        for ev in events
        for side in ("home", "away")
        if (ev.get(side) or "").strip()
    })
    if not teams:
        return
    tools_dir = Path(__file__).resolve().parent
    teams_file = tools_dir.parent / ".tmp" / "xg" / "teams_today.txt"
    try:
        teams_file.parent.mkdir(parents=True, exist_ok=True)
        teams_file.write_text("\n".join(teams), encoding="utf-8")
    except OSError as exc:
        if not quiet:
            print(f"[acquire_daily] live-xg skipped (teams-file write): {exc}", flush=True)
        return
    # 1. FotMob live xG for the slate (headless, own browser-page cap). Bounded
    #    timeout so a hung browser can never stall the caller.
    for label, script, args, timeout in (
        ("fetch_fotmob_xg", "fetch_fotmob_xg.py", ["--teams-file", str(teams_file)], 1200),
        # 2. Re-merge Understat/FBref CSVs + the fresh fotmob_xg.json into the prior.
        ("build_xg_table", "build_xg_table.py", [], 180),
    ):
        try:
            proc = subprocess.run(
                [sys.executable, str(tools_dir / script), *args],
                capture_output=True, text=True, timeout=timeout, check=False,
            )
            if not quiet:
                status = "ok" if proc.returncode == 0 else f"exit={proc.returncode}"
                tail = (proc.stdout or proc.stderr or "").strip().splitlines()
                note = tail[-1] if tail else ""
                print(f"[acquire_daily] {label} {status} {note}".rstrip(), flush=True)
            if label == "fetch_fotmob_xg" and proc.returncode == 0 and not _fotmob_xg_has_teams(tools_dir):
                # The historical silent-zero bug (fotmob_xg.json parses to {})
                # must be observable even when the subprocess itself exits 0.
                print("[acquire_daily] WARN fetch_fotmob_xg yielded 0 teams", flush=True)
        except Exception as exc:  # noqa: BLE001 — best-effort, never fatal
            if not quiet:
                print(f"[acquire_daily] {label} skipped: {exc}", flush=True)

    # 3. Google-AI-Mode xG fallback (PR-19) — only for the RESIDUAL gap left
    #    after the real tiers above, and only when explicitly not disabled.
    _maybe_fetch_xg_fallback(teams, tools_dir, quiet=quiet)


def _fotmob_xg_has_teams(tools_dir: Path) -> bool:
    """True when .tmp/xg/fotmob_xg.json parses to a non-empty team table.
    Missing/corrupt file counts as "no teams" (same fail-open read as
    build_xg_table.py's _load_json_xg_table) — used only to decide whether to
    print the WARN above, never fatal itself."""
    path = tools_dir.parent / ".tmp" / "xg" / "fotmob_xg.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and len(data) > 0


# Mirrors packages/runtime/src/goalsV3/eligibility.ts's SRL_RE (§1.2 hard
# discard) — reimplemented here in Python rather than parsed from the TS
# source; keep the two patterns in sync if either changes.
_SRL_VIRTUAL_RE = re.compile(r"simulated\s*reality|\bsrl\b|e-?soccer|esports?|virtual", re.IGNORECASE)


def _residual_teams_for_fallback(teams: list[str], tools_dir: Path) -> list[str]:
    """Teams from today's slate NOT already covered by the merged xG table
    (.tmp/xg/team_xg_table.json, rebuilt just before this is called) AND not
    SRL/virtual — those fixtures are hard-discarded by eligibility anyway, so
    spending a fallback browser page on them is wasted quota.

    Membership must use the SAME normaliser that built team_xg_table.json's
    keys (scrape_fixtures.normalise — see build_xg_table.py's own "reuse the
    shared team-name normaliser, do not add a second one" convention and
    fetch_xg_fallback.py's identical _residual_teams helper). tools/lib/
    team_names.normalise_team is a DIFFERENT function with a different alias
    table; using it here would silently misclassify already-covered teams as
    residual (or vice versa) since the two normalisers don't agree on the
    same input. `sf` (scrape_fixtures, already imported at module level) is
    the same module build_xg_table.py and fetch_xg_fallback.py both import
    `normalise` from — reuse it directly rather than re-importing."""
    table_path = tools_dir.parent / ".tmp" / "xg" / "team_xg_table.json"
    try:
        covered = json.loads(table_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        covered = {}
    if not isinstance(covered, dict):
        covered = {}

    residual: list[str] = []
    for team in teams:
        if _SRL_VIRTUAL_RE.search(team):
            continue
        if sf.normalise(team) in covered:
            continue
        residual.append(team)
    return residual


def _maybe_fetch_xg_fallback(teams: list[str], tools_dir: Path, quiet: bool = False) -> None:
    """PR-19: run the Google-AI-Mode xG fallback (fetch_xg_fallback.py) over
    the RESIDUAL team list — those still missing xG after the Understat/
    FotMob/Sofascore/FBref merge above — then re-run build_xg_table.py so the
    new google_ai tier merges in as the last, lowest-confidence fill. Gated by
    ORACLE_FETCH_XG_FALLBACK (default on); capped by
    ORACLE_XG_FALLBACK_MAX_TEAMS (default 25) since each team is a real
    Playwright page load against Google AI-Mode. Best-effort: any failure or
    timeout must never break the caller, same convention as every other stage
    in _maybe_fetch_live_xg."""
    if os.environ.get("ORACLE_FETCH_XG_FALLBACK", "on").strip().lower() == "off":
        if not quiet:
            print("[acquire_daily] xg-fallback skipped (ORACLE_FETCH_XG_FALLBACK=off)", flush=True)
        return

    residual = _residual_teams_for_fallback(teams, tools_dir)
    if not residual:
        if not quiet:
            print("[acquire_daily] xg-fallback skipped (no residual teams)", flush=True)
        return

    try:
        max_teams = int(os.environ.get("ORACLE_XG_FALLBACK_MAX_TEAMS", "25"))
    except ValueError:
        max_teams = 25
    residual = residual[: max(0, max_teams)]
    if not residual:
        return

    fallback_teams_file = tools_dir.parent / ".tmp" / "xg" / "teams_fallback_today.txt"
    try:
        fallback_teams_file.parent.mkdir(parents=True, exist_ok=True)
        fallback_teams_file.write_text("\n".join(residual), encoding="utf-8")
    except OSError as exc:
        if not quiet:
            print(f"[acquire_daily] xg-fallback skipped (teams-file write): {exc}", flush=True)
        return

    try:
        proc = subprocess.run(
            [
                sys.executable, str(tools_dir / "fetch_xg_fallback.py"),
                "--teams-file", str(fallback_teams_file),
            ],
            capture_output=True, text=True, timeout=900, check=False,
        )
        if not quiet:
            status = "ok" if proc.returncode == 0 else f"exit={proc.returncode}"
            tail = (proc.stdout or proc.stderr or "").strip().splitlines()
            note = tail[-1] if tail else ""
            print(f"[acquire_daily] fetch_xg_fallback {status} {note}".rstrip(), flush=True)
    except Exception as exc:  # noqa: BLE001 — best-effort, never fatal
        if not quiet:
            print(f"[acquire_daily] fetch_xg_fallback skipped: {exc}", flush=True)
        return

    # Re-merge so the new google_ai tier is reflected in team_xg_table.json.
    try:
        proc = subprocess.run(
            [sys.executable, str(tools_dir / "build_xg_table.py")],
            capture_output=True, text=True, timeout=180, check=False,
        )
        if not quiet:
            status = "ok" if proc.returncode == 0 else f"exit={proc.returncode}"
            tail = (proc.stdout or proc.stderr or "").strip().splitlines()
            note = tail[-1] if tail else ""
            print(f"[acquire_daily] build_xg_table (post-fallback) {status} {note}".rstrip(), flush=True)
    except Exception as exc:  # noqa: BLE001 — best-effort, never fatal
        if not quiet:
            print(f"[acquire_daily] build_xg_table (post-fallback) skipped: {exc}", flush=True)


def run_live_xg_refresh(quiet: bool = False) -> None:
    """PR-7: standalone, off-peak entry point for the FotMob live-xG refresh —
    decouples it from acquire()'s 09:30 critical path. Previously
    _maybe_fetch_live_xg ran INLINE inside acquire(), sequentially after that
    run's own SportyBet/BBC/Flashscore Playwright fixture-discovery swarm —
    never concurrent, but still stacked back-to-back in the same 09:30 window,
    extending how long the process holds multiple browser-page swarms' memory
    (the actual pressure class behind the 2026-07-05 BSOD/OOM crisis, see
    oracle_machine_crash_2026_07_05 memory). Intended to run from its own
    off-peak worker cron slot (e.g. 02:00 WAT, apps/worker/src/index.ts) —
    nothing else is scraping then, so the collision risk this was gated
    against is gone and ORACLE_FETCH_LIVE_XG can default on.

    Reads the SportyBet sidecar already on disk (written by the most recent
    acquire() run, whichever day that was) for its team list rather than
    re-running the Playwright fixture-discovery swarm just to get names —
    fetch_fotmob_xg.py's rolling team-xG prior only ever benefits a team's
    NEXT scrape regardless of which day's fixtures supplied the name (see
    _maybe_fetch_live_xg's docstring), so a live re-scrape here would just be
    redundant Playwright usage for no benefit. Missing/corrupt sidecar (e.g.
    first run ever) degrades to a no-op, never fatal."""
    try:
        import json
        payload = json.loads(sf.SPORTYBET_SIDECAR.read_text(encoding="utf-8"))
        events = payload.get("events") if isinstance(payload, dict) else None
        events = events if isinstance(events, list) else []
    except (OSError, ValueError):
        events = []
    if not events and not quiet:
        print("[acquire_daily] live-xg-refresh: no sidecar on disk yet — skipping", flush=True)
    _maybe_fetch_live_xg(events, quiet=quiet)


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
                 statscoverage: Optional[dict], xg: Optional[dict],
                 availability: Optional[dict], scraped_at: str) -> list[dict]:
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
    if availability and (availability.get("home") or availability.get("away")):
        rows.append({
            "dt": date_str, "event_id": event_id, "subtab": "availability",
            "payload_json": _json.dumps(availability, ensure_ascii=False), "scraped_at": scraped_at,
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
            "league": ev.get("league"), "league_id": ev.get("leagueId") or "",
            "kickoff_utc": ev.get("kickoff_utc"),
            "market_count": ev.get("marketCount"), "scraped_at": scraped_at,
        })
        odds.extend(_flatten_odds(eid, date_str, ev.get("odds"), scraped_at))
        stats.extend(_stats_rows(
            eid, date_str, ev.get("stats"), ev.get("statscoverage"),
            ev.get("xg"), ev.get("availability"), scraped_at,
        ))
    return {"fixtures": fixtures, "odds": odds, "stats": stats}


def acquire(date_str: str, quiet: bool = False, no_playwright: bool = False) -> int:
    """Run acquisition + lake write. Returns the count of fixtures acquired."""
    _merged_cache, events = sf.run_acquisition(date_str, quiet=quiet, no_playwright=no_playwright)
    scraped_at = ds.utc_now_stamp()
    rows = events_to_lake_rows(events, date_str, scraped_at)
    ds.write_table("fixtures", date_str, rows["fixtures"])
    ds.write_table("odds", date_str, rows["odds"])
    ds.write_table("stats", date_str, rows["stats"])
    _maybe_fetch_injuries(quiet=quiet)
    _maybe_fetch_squad_availability(quiet=quiet)
    # Live-xG refresh is NOT called here (PR-7 decoupling) — see
    # run_live_xg_refresh()'s docstring for why it now runs from its own
    # off-peak worker cron slot instead of inline in the 09:30 critical path.
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
    parser.add_argument("--live-xg-refresh", action="store_true",
                        help="Run ONLY the standalone off-peak FotMob live-xG refresh (PR-7) and exit — "
                             "no acquisition, no lake write. Intended for its own off-peak cron slot.")
    args = parser.parse_args()

    if args.live_xg_refresh:
        run_live_xg_refresh(quiet=args.quiet)
        return

    date_str = args.date or ds.utc_today()
    n = acquire(date_str, quiet=args.quiet, no_playwright=args.no_playwright)

    if args.purge:
        result = ds.purge_old()
        if not args.quiet:
            print(f"[acquire_daily] purge deleted:{result['deleted']} archived:{result['archived']}", flush=True)

    print(f"acquired:{n}", flush=True)


if __name__ == "__main__":
    main()
