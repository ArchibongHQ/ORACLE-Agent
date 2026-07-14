"""sync_cloud_news.py — pull cloud-committed news-intel + xG JSONs into the
local Parquet lake / .tmp dirs.

Two upstream cloud jobs commit deterministic-shaped JSON to the `data` git
branch (never `main` — that branch stays code-only):
  - A daily Claude cloud routine writes per-fixture news-intel JSONs to
    `data/news_intel/<YYYY-MM-DD>/*.json` (NewsIntelResult shape — see
    packages/llm/src/callNewsIntel.ts — plus `home`/`away`).
  - A GitHub Actions job writes xG JSONs to `data/xg/*.json`.

This tool runs on the local Windows worker AFTER tools/enrich_news.py (same
acquisition step, additive source) and merges that cloud data in:
  - News rows are validated, reshaped into tools/daily_store.py's "news"
    table row schema (source="cloud_news"), and merged into that day's
    Parquet partition alongside enrich_news.py's rss_news/perplexity/etc rows.
  - xG JSONs are copied byte-for-byte into .tmp/xg/ for whatever downstream
    step already reads that directory.

Talks to git via subprocess + a bare `<remote>/<branch>` ref (no local
checkout of the `data` branch, no working-tree changes) — `git fetch` then
`git ls-tree`/`git show` against the remote-tracking ref. Nothing here ever
mutates the caller's checked-out branch or working tree.

Data-is-never-a-blocker: the `data` branch, or a given date's `news_intel`
directory, or `data/xg`, may simply not exist yet (cloud job hasn't run, or
this is a fresh clone with no `data` branch fetched). None of that is an
error — every git-touching step degrades to "0 rows synced" and this tool
always exits 0. Only malformed CLI usage exits non-zero (argparse's own exit
2 covers that; there's no additional validation here to keep this a thin,
best-effort sync layer, not a gate).

Usage:
    python tools/sync_cloud_news.py
    python tools/sync_cloud_news.py --date 2026-07-11
    python tools/sync_cloud_news.py --remote origin --branch data --quiet
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import daily_store as ds

ROOT = Path(__file__).resolve().parent.parent
XG_OUT_DIR = ROOT / ".tmp" / "xg"

GIT_TIMEOUT_S = 60
STALE_AFTER = timedelta(hours=24)
FUTURE_SKEW_ALLOWED = timedelta(hours=1)

_REQUIRED_ARRAY_FIELDS = (
    "injuries", "suspensions", "lineupHints", "motivationFlags", "travelFlags", "sources",
)


def slug(team: str) -> str:
    """Mirrors tools/enrich_news.py's slug() EXACTLY (source of truth) — same
    Unicode-aware alnum test, same double-underscore collapse/strip rules.
    packages/runtime/src/dailyStore.ts's teamSlug() mirrors the same algorithm
    TS-side; all three must stay byte-identical or a news row's team_slug
    silently fails to match on lookup (the same class of bug as the OTS
    name-gap — see project memory). Replicated here rather than imported so
    this lightweight git-sync tool doesn't pull in enrich_news.py's heavy,
    unrelated import graph (Playwright, swarm_dispatch, fotmob/sofascore/
    transfermarkt scrapers)."""
    out = [ch if ch.isalnum() else "_" for ch in team.lower().strip()]
    s = "".join(out)
    while "__" in s:
        s = s.replace("__", "_")
    return s.strip("_")


def _parse_observed_at(value: str) -> datetime:
    """Parse an ISO-8601 timestamp, tolerating a trailing 'Z' the way JS's
    Date#toISOString() emits it. Raises ValueError on anything unparsable —
    callers treat that as a validation rejection, never a crash."""
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def parse_and_validate(payload: dict[str, Any], date_str: str) -> Optional[dict[str, Any]]:
    """Validate one cloud news-intel JSON payload (NewsIntelResult shape —
    packages/llm/src/callNewsIntel.ts — plus `home`/`away`) and turn it into a
    tools/daily_store.py "news" table row. Returns None (and warns on stderr)
    on any structural problem or an observedAt outside the acceptable window
    — never raises, so one malformed cloud file never blocks the rest."""
    if not isinstance(payload, dict):
        print("[sync_cloud_news] payload is not a JSON object — rejecting", file=sys.stderr)
        return None

    home = payload.get("home")
    if not isinstance(home, str) or not home.strip():
        print("[sync_cloud_news] missing/invalid 'home' — rejecting", file=sys.stderr)
        return None
    away = payload.get("away")
    if not isinstance(away, str) or not away.strip():
        print("[sync_cloud_news] missing/invalid 'away' — rejecting", file=sys.stderr)
        return None

    for field in _REQUIRED_ARRAY_FIELDS:
        value = payload.get(field)
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            print(f"[sync_cloud_news] '{field}' missing/not a string array — rejecting", file=sys.stderr)
            return None

    confidence = payload.get("confidence")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        print("[sync_cloud_news] 'confidence' missing/not numeric — rejecting", file=sys.stderr)
        return None
    if not (0.0 <= float(confidence) <= 1.0):
        print(f"[sync_cloud_news] 'confidence' {confidence} out of range [0,1] — rejecting", file=sys.stderr)
        return None

    model = payload.get("model")
    if not isinstance(model, str) or not model.strip():
        print("[sync_cloud_news] missing/invalid 'model' — rejecting", file=sys.stderr)
        return None

    observed_at = payload.get("observedAt")
    if not isinstance(observed_at, str) or not observed_at.strip():
        print("[sync_cloud_news] missing/invalid 'observedAt' — rejecting", file=sys.stderr)
        return None
    try:
        observed_dt = _parse_observed_at(observed_at)
    except ValueError:
        print(f"[sync_cloud_news] unparsable observedAt {observed_at!r} — rejecting", file=sys.stderr)
        return None

    now = datetime.now(tz=timezone.utc)
    if now - observed_dt > STALE_AFTER:
        print(f"[sync_cloud_news] observedAt {observed_at} is stale (>24h old) — rejecting", file=sys.stderr)
        return None
    if observed_dt - now > FUTURE_SKEW_ALLOWED:
        print(f"[sync_cloud_news] observedAt {observed_at} is >1h in the future — rejecting", file=sys.stderr)
        return None

    injuries = payload["injuries"]
    suspensions = payload["suspensions"]
    lineup_hints = payload["lineupHints"]

    first_item = injuries[0] if injuries else (lineup_hints[0] if lineup_hints else "")
    summary = f"inj:{len(injuries)} sus:{len(suspensions)} lineup:{len(lineup_hints)}"
    if first_item:
        summary += f" | {first_item}"
    summary = summary[:1000]

    raw_subset = {
        "injuries": injuries,
        "suspensions": suspensions,
        "lineupHints": lineup_hints,
        "motivationFlags": payload["motivationFlags"],
        "travelFlags": payload["travelFlags"],
        "sources": payload["sources"],
        "confidence": float(confidence),
        "model": model,
        "observedAt": observed_at,
    }

    return {
        "dt": date_str,
        "team_slug": slug(home),
        "source": "cloud_news",
        "summary": summary,
        "raw_json": json.dumps(raw_subset, ensure_ascii=False),
        "scraped_at": observed_at,
    }


def merge_rows(existing: list[dict[str, Any]], cloud: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Idempotent merge: drop any prior source="cloud_news" rows (a re-sync
    fully replaces them, never duplicates), keep every other source's rows
    untouched (rss_news, perplexity, google_ai, ...), append the freshly
    validated cloud rows."""
    kept = [row for row in existing if row.get("source") != "cloud_news"]
    return kept + cloud


def _log(msg: str, quiet: bool) -> None:
    if not quiet:
        print(msg, file=sys.stderr)


def _run_git(args: list[str], timeout: int = GIT_TIMEOUT_S) -> Optional[subprocess.CompletedProcess]:
    """Run a git subprocess call, capturing output as UTF-8 text. None on any
    failure to even run it (git missing, timeout) — every caller treats None
    (or a nonzero returncode) as 'skip this step', never raises."""
    try:
        return subprocess.run(
            ["git", *args],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def git_fetch(remote: str, branch: str) -> tuple[bool, str]:
    proc = _run_git(["fetch", remote, branch])
    if proc is None:
        return False, "git fetch timed out or git is unavailable"
    if proc.returncode != 0:
        return False, f"git fetch {remote} {branch} failed: {proc.stderr.strip()[:200]}"
    return True, ""


def git_ls_tree(remote: str, branch: str, path: str) -> tuple[Optional[list[str]], str]:
    proc = _run_git(["ls-tree", "-r", "--name-only", f"{remote}/{branch}", "--", path])
    if proc is None:
        return None, "git ls-tree timed out or git is unavailable"
    if proc.returncode != 0:
        return None, f"git ls-tree failed: {proc.stderr.strip()[:200]}"
    return [line for line in proc.stdout.splitlines() if line.strip()], ""


def git_show(remote: str, branch: str, path: str) -> Optional[str]:
    proc = _run_git(["show", f"{remote}/{branch}:{path}"])
    if proc is None or proc.returncode != 0:
        return None
    return proc.stdout


def sync_news(remote: str, branch: str, date_str: str, quiet: bool) -> int:
    """Fetch cloud news-intel JSONs for date_str, validate + merge them into
    the local "news" lake partition. Returns the count of cloud rows merged
    (0 on any absence — missing dir, no files, all-invalid, etc)."""
    paths, reason = git_ls_tree(remote, branch, f"data/news_intel/{date_str}/")
    if paths is None:
        _log(f"[sync_cloud_news] no cloud data ({reason}) — skipping news sync", quiet)
        return 0
    json_paths = [p for p in paths if p.endswith(".json") and Path(p).name != "_summary.json"]
    if not json_paths:
        _log(f"[sync_cloud_news] no cloud data (no news_intel files for {date_str}) — skipping news sync", quiet)
        return 0

    cloud_rows: list[dict[str, Any]] = []
    for path in json_paths:
        raw = git_show(remote, branch, path)
        if raw is None:
            _log(f"[sync_cloud_news] git show failed for {path} — skipping file", quiet)
            continue
        try:
            payload = json.loads(raw)
        except ValueError as exc:
            _log(f"[sync_cloud_news] bad JSON in {path} ({exc}) — skipping file", quiet)
            continue
        row = parse_and_validate(payload, date_str)
        if row is not None:
            cloud_rows.append(row)

    if not cloud_rows:
        return 0

    existing = ds.read_table("news", date_str)
    merged = merge_rows(existing, cloud_rows)
    ds.write_table("news", date_str, merged)
    return len(cloud_rows)


def sync_xg(remote: str, branch: str, quiet: bool) -> int:
    """Mirror every data/xg/*.json blob on <remote>/<branch> into .tmp/xg/,
    overwriting by basename. Absent dir -> 0, not an error (the GitHub
    Actions xG job may simply not have run yet today)."""
    paths, reason = git_ls_tree(remote, branch, "data/xg/")
    if paths is None:
        _log(f"[sync_cloud_news] no cloud data ({reason}) — skipping xg sync", quiet)
        return 0
    json_paths = [p for p in paths if p.endswith(".json")]
    if not json_paths:
        return 0

    XG_OUT_DIR.mkdir(parents=True, exist_ok=True)
    count = 0
    for path in json_paths:
        raw = git_show(remote, branch, path)
        if raw is None:
            _log(f"[sync_cloud_news] git show failed for {path} — skipping file", quiet)
            continue
        out_path = XG_OUT_DIR / Path(path).name
        out_path.write_text(raw, encoding="utf-8")
        count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Sync cloud-committed news-intel + xG JSONs (git branch `data`) into the local ORACLE lake",
    )
    parser.add_argument("--date", default=None, help="YYYY-MM-DD (default: UTC today)")
    parser.add_argument("--remote", default="origin", help="git remote name (default: origin)")
    parser.add_argument("--branch", default="data", help="git branch holding cloud-committed JSONs (default: data)")
    parser.add_argument("--quiet", action="store_true", help="Suppress informational/skip stderr logging")
    args = parser.parse_args()

    date_str = args.date or ds.utc_today()

    ok, reason = git_fetch(args.remote, args.branch)
    if not ok:
        _log(f"[sync_cloud_news] no cloud data ({reason}) — skipping", args.quiet)
        print("[sync_cloud_news] news:0 xg:0", flush=True)
        return

    news_count = sync_news(args.remote, args.branch, date_str, args.quiet)
    xg_count = sync_xg(args.remote, args.branch, args.quiet)

    print(f"[sync_cloud_news] news:{news_count} xg:{xg_count}", flush=True)


if __name__ == "__main__":
    main()
