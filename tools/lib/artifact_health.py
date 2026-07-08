"""tools/lib/artifact_health.py — PR-26 artifact freshness/yield registry.

A small, dependency-free health check over the acquisition-tier artifacts
that have historically failed SILENTLY: the code ran, exited 0, and nothing
downstream noticed the output was empty or stale (the root cause behind
both the "FotMob tier yields 0 teams" and "availability CSV 6 weeks stale"
incidents this audit train fixed). Purely a post-hoc reader over files
already on disk — it does not run or instrument any acquisition tier
itself, so registering a new artifact here never changes acquisition
behavior, only what gets reported about it.

Each registered artifact resolves to one HealthResult:
    {name, status: "OK" | "WARN" | "MISSING", detail}
"MISSING" = the file has never been written. "WARN" = it exists but is
either older than its expected cadence, or (for artifacts where an empty
file is never legitimate) has zero items. "OK" covers a fresh file, and
also a fresh-but-empty file for artifacts where that's an expected outcome
on any given day (e.g. the AI-mode xG fallback finding zero residual teams
most days is normal, not a problem).

Usage:
    from lib.artifact_health import check_all, format_health_line
    results = check_all()
    print(format_health_line(results))
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parent.parent.parent


@dataclass(frozen=True)
class ArtifactSpec:
    name: str
    path: Path
    max_age_hours: float
    # Given the file's raw bytes, return an item count (dict/list length,
    # CSV data-row count). None = existence/age-only check, no yield concept
    # (e.g. the sidecar is one blob, not a collection with a count to watch).
    count_fn: Optional[Callable[[bytes], int]] = None
    # True when a zero count on an otherwise-fresh file is an expected,
    # healthy outcome (e.g. "no residual teams needed the fallback today"),
    # not a sign anything broke. False (default) means zero-on-fresh WARNs —
    # correct for xg tables and the availability CSV, which should never
    # legitimately go empty once first populated.
    zero_ok_if_fresh: bool = False


@dataclass(frozen=True)
class HealthResult:
    name: str
    status: str  # "OK" | "WARN" | "MISSING"
    detail: str


def _json_len(data: bytes) -> int:
    """Item count for either a JSON object (dict) or array (list) — the
    registered artifacts use both shapes (team-keyed xG tables are dicts,
    build_market_catalog.py's overlay diff is a list of added entries)."""
    try:
        parsed = json.loads(data)
    except ValueError:
        return 0
    if isinstance(parsed, (dict, list)):
        return len(parsed)
    return 0


def _csv_row_count(data: bytes) -> int:
    """Data rows, excluding the header. A header-only (or empty) file is 0."""
    lines = data.decode("utf-8", errors="replace").splitlines()
    return max(0, len(lines) - 1) if lines else 0


def _registry() -> list[ArtifactSpec]:
    tmp = ROOT / ".tmp"
    return [
        # 02:00 WAT off-peak refresh tiers (PR-7/PR-19) — max_age_hours=30
        # tolerates one missed/late run before WARNing, not just an exact-24h
        # window.
        ArtifactSpec(
            "xg-table", tmp / "xg" / "team_xg_table.json", max_age_hours=30, count_fn=_json_len
        ),
        ArtifactSpec(
            "fotmob-xg", tmp / "xg" / "fotmob_xg.json", max_age_hours=30, count_fn=_json_len
        ),
        ArtifactSpec(
            "ai-mode-xg", tmp / "xg" / "ai_mode_xg.json", max_age_hours=30,
            count_fn=_json_len, zero_ok_if_fresh=True,
        ),
        # Saturday Kaggle refresh cadence — 9 days tolerates one missed
        # Saturday before WARNing.
        ArtifactSpec(
            "availability", tmp / "squad-availability" / "availability_features.csv",
            max_age_hours=24 * 9, count_fn=_csv_row_count,
        ),
        ArtifactSpec(
            "catalog-overlay", tmp / "market_catalog_overlay.json", max_age_hours=24 * 9,
            count_fn=_json_len, zero_ok_if_fresh=True,
        ),
        # Today's SportyBet sidecar — the 09:30 acquisition's own output;
        # 30h tolerance covers a run that slipped past midnight.
        ArtifactSpec("sidecar", tmp / "fixtures" / "sportybet_today.json", max_age_hours=30),
    ]


def _check_one(spec: ArtifactSpec, now: float) -> HealthResult:
    if not spec.path.exists():
        return HealthResult(spec.name, "MISSING", "never written")

    age_hours = (now - spec.path.stat().st_mtime) / 3600
    age_str = f"{age_hours:.1f}h old" if age_hours < 48 else f"{age_hours / 24:.1f}d old"

    if spec.count_fn is None:
        status = "WARN" if age_hours > spec.max_age_hours else "OK"
        return HealthResult(spec.name, status, age_str)

    try:
        count = spec.count_fn(spec.path.read_bytes())
    except OSError:
        return HealthResult(spec.name, "WARN", f"{age_str}, unreadable")

    stale = age_hours > spec.max_age_hours
    empty = count == 0
    if stale:
        return HealthResult(spec.name, "WARN", f"{count} ({age_str}, STALE)")
    if empty and not spec.zero_ok_if_fresh:
        return HealthResult(spec.name, "WARN", f"0 ({age_str}, EMPTY)")
    return HealthResult(spec.name, "OK", f"{count} ({age_str})")


def check_all() -> list[HealthResult]:
    now = time.time()
    return [_check_one(spec, now) for spec in _registry()]


def format_health_line(results: list[HealthResult]) -> str:
    """One-line summary for the daily Telegram report / stdout, e.g.:
    'data health: xg-table 165 (2.1h old), fotmob-xg 0 (2.1h old, EMPTY, WARN), ...'
    Non-OK entries get an explicit ", WARN"/", MISSING" suffix so the
    severity is visible without cross-referencing a legend. Plain ASCII only
    (no Unicode separators) — matches apps/worker/src/xgCoverageNote.ts's
    convention and avoids Windows console/service default-encoding mojibake
    (observed directly: a middle-dot separator rendered as replacement
    characters on this box's default terminal encoding)."""
    parts = []
    for r in results:
        suffix = f", {r.status}" if r.status != "OK" else ""
        parts.append(f"{r.name} {r.detail}{suffix}")
    return "data health: " + ", ".join(parts)
