#!/usr/bin/env python3
"""fetch_apify_stats.py — OPTIONAL reliability fallback for SportyBet sidecar stats.

ORACLE's PRIMARY stats source is the direct Sportradar gismo HTTP API (sub-second
real JSON, free, and the only source carrying xG). This module is a DORMANT fallback
for the few subtabs gismo can return null for (H2H, standings, lineups, injuries),
hitting the Apify Flashscore actor (joaobrito/flashscore-sports-data-api).

It is deliberately NOT a replacement for the Playwright/Google-AI tier and NOT used
for odds or xG:
  - Apify is pay-per-event (~$0.001 basic / $0.003 stats / $0.0006 standings) and
    polling-based scraping with 1-3s latency — strictly slower and narrower than
    gismo, so it can never be the primary path.
  - It has NO xG field, so xG never routes here.

DORMANCY CONTRACT: every entry point is a no-op (returns None) unless APIFY_TOKEN is
set in .env. With the token absent there is zero network cost and zero behaviour
change — wiring this in is safe to ship unactivated. A call cap (APIFY_MAX_CALLS,
default 20) bounds per-run spend even when the token IS set.

Schema note: the actor's exact output shape is not verified in-repo. Every parser
returns None on any shape mismatch (never fabricates), mirroring the gismo-parser
discipline (see oracle_gismo_parsers memory) — confirm the live shape before
relying on this tier in production.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

_ACTOR = "joaobrito~flashscore-sports-data-api"
_API_BASE = "https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items"
_TIMEOUT = 30  # seconds — the actor polls Flashscore, 1-3s typical, allow headroom

# Per-process call budget so a single run can't run up an unbounded Apify bill even
# when the token is set. Reset is per process (one scrape run).
_calls_made = 0


def _env_token() -> str:
    """APIFY_TOKEN from process env or .env (no extra deps). Empty string when unset
    → the whole module no-ops, the dormancy contract."""
    tok = os.environ.get("APIFY_TOKEN", "").strip()
    if tok:
        return tok
    env_path = Path(".env")
    if not env_path.exists():
        return ""
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("APIFY_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        return ""
    return ""


def _max_calls() -> int:
    try:
        return int(os.environ.get("APIFY_MAX_CALLS", "20"))
    except ValueError:
        return 20


def _run_actor(token: str, payload: dict) -> Optional[list]:
    """POST the actor input, return the dataset items list. None on any failure."""
    global _calls_made
    if _calls_made >= _max_calls():
        return None
    _calls_made += 1
    url = _API_BASE.format(actor=_ACTOR) + "?" + urllib.parse.urlencode({"token": token})
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            body = json.load(r)
            return body if isinstance(body, list) else None
    except (urllib.error.URLError, ValueError, TimeoutError):
        return None


def fetch_apify_subtab(home: str, away: str, subtab: str) -> Optional[dict]:
    """Fetch one missing stats subtab via Apify. No-op (None) without APIFY_TOKEN.

    `subtab` ∈ {"h2h", "standings", "lineups", "injuries"}. Returns a dict matching
    the corresponding gismo parser's output shape, or None when the token is absent,
    the call cap is hit, the actor fails, or the shape doesn't match. Never raises.
    """
    if subtab not in {"h2h", "standings", "lineups", "injuries"}:
        return None
    token = _env_token()
    if not token:
        return None  # DORMANT — no token, no call, no cost
    items = _run_actor(
        token,
        {"home": home, "away": away, "dataType": subtab, "sport": "football"},
    )
    if not items:
        return None
    return _normalise(items, subtab)


def _normalise(items: list, subtab: str) -> Optional[dict]:
    """Map the actor's dataset items to the gismo parser output shape. Defensive —
    returns None on any unexpected shape rather than fabricating a record."""
    rec = items[0] if items and isinstance(items[0], dict) else None
    if not rec:
        return None
    try:
        if subtab == "h2h":
            # Match _parse_h2h: {total, home_wins, away_wins, draws}
            h = rec.get("h2h") or rec
            if not isinstance(h, dict):
                return None
            out = {
                "total": h.get("total"),
                "home_wins": h.get("homeWins") or h.get("home_wins"),
                "away_wins": h.get("awayWins") or h.get("away_wins"),
                "draws": h.get("draws"),
            }
            return out if isinstance(out.get("total"), int) else None
        if subtab == "standings":
            # Match _parse_standings per side: {pos, points, played, gf, ga}
            return rec.get("standings") if isinstance(rec.get("standings"), dict) else None
        # lineups / injuries pass through as opaque text the news layer can render.
        return rec or None
    except (AttributeError, TypeError):
        return None


if __name__ == "__main__":
    # Smoke test — prints whether the tier is dormant (no token) or live.
    tok = _env_token()
    print(f"[apify] token {'present' if tok else 'absent (dormant)'}; max_calls={_max_calls()}")
