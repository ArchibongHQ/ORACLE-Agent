"""fetch_sharp_odds.py — Sharp-reference odds fetch for CLV measurement (P1-4, Wave 2).

ORACLE bets on football markets and wants to measure CLV (closing line value)
against a genuine SHARP reference price, not just SportyBet's own closing
line (SportyBet is the soft book being bet INTO, so its own closing line is
not independent evidence of a "true" price). This script is the single
network-calling implementation packages/runtime/src/sharpFeed.ts's
fetchSharpFairPrice() shells out to — ONE subprocess call, two internal tiers:

  Tier 1 — the-odds-api.com, Pinnacle-only ("odds_api"). Same endpoint/params
    convention as packages/runtime/src/resolveFixtures.ts's fetchClosingOdds
    (ODDS_API_KEY, regions=uk,eu, bookmakers=pinnacle, oddsFormat=decimal) —
    see .env.example / workflows/resolve.md for the existing key contract,
    reused here verbatim, not reinvented. Only covers h2h/1X2; pass
    --sport-key (an Odds-API sport key, e.g. soccer_epl — see
    packages/runtime/src/resolveFixtures.ts's LEAGUE_TO_SPORT map, the single
    source of truth for the league->sport-key mapping) to use it. A
    non-1X2 market, or a league with no sport-key mapping, skips straight to
    Tier 2 with no wasted roundtrip.

  Tier 2 — Google AI Mode via Playwright ("ai_mode_fallback"), reusing
    scrape_google_ai.py's exact scrape conventions (CLAUDE.md §6: a missing
    key or unsupported market is NEVER a blocker — everything ORACLE needs
    can be acquired via Google AI Mode). Best-effort regex odds extraction
    from the AI answer's prose — materially lower-confidence than Tier 1,
    used only when Tier 1 didn't answer. Degraded relative to a structured
    odds API, same rationale as resolveFixtures.ts's own web-search results
    fallback: strictly better than leaving the fixture with no sharp price
    at all, never treated as equal-confidence to Tier 1.

Devig happens on the TS side (packages/engine/src/markets/devig.ts) — this
script returns RAW (vigged) prices only, never a fair/devigged number, so the
whole codebase has exactly one devig implementation, not two.

Output: ONE JSON object to stdout —
  {"ok": bool, "source": "odds_api"|"ai_mode_fallback"|"unavailable",
   "market": str, "side": str,
   "prices": {"home"?: float, "draw"?: float, "away"?: float,
              "yes"?: float, "no"?: float},
   "error"?: str}
Never raises and never a non-zero-informative exit — any failure (missing
key, no match, Playwright absent, network error) degrades to
{"ok": false, "source": "unavailable", ...}, matching every other
data-acquisition fallback tool in tools/ (fail-open, per CLAUDE.md §6).

Usage:
    python tools/fetch_sharp_odds.py --home "Arsenal" --away "Chelsea" \\
        --kickoff 2026-07-10T15:00:00Z --market 1X2 --side home \\
        --league "Premier League" --sport-key soccer_epl
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

try:
    from lib.team_names import normalise_team
except ImportError:  # repo root on sys.path instead of tools/
    from tools.lib.team_names import normalise_team

try:
    from scrape_google_ai import _GOOGLE_AI_MODE, HAS_PLAYWRIGHT, _run as _ai_mode_run
except ImportError:  # repo root on sys.path instead of tools/
    from tools.scrape_google_ai import (
        _GOOGLE_AI_MODE,
        HAS_PLAYWRIGHT,
        _run as _ai_mode_run,
    )

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(ROOT, ".env")

ODDS_API_BASE = "https://api.the-odds-api.com/v4"
_UA = "ORACLE/1.0 (sharp-odds fetcher)"

_ONE_X_TWO_MARKETS = {"1x2", "h2h", "match_winner", "match winner"}


def _warn(msg: str) -> None:
    print(f"[fetch-sharp-odds] WARN: {msg}", file=sys.stderr)


# ── .env loader (mirrors tools/fetch_lineups.py's manual loader) ──────────────


def _load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, _, v = line.partition("=")
                    env[k.strip()] = v.strip().strip('"').strip("'")
    for key in ("ODDS_API_KEY",):
        if key in os.environ:
            env[key] = os.environ[key]
    return env


# ── Tier 1: the-odds-api.com (Pinnacle sharp consensus, 1X2 only) ────────────


def fetch_odds_api_1x2(
    sport_key: str, home: str, away: str, kickoff: str, api_key: str
) -> Optional[dict[str, float]]:
    """Raw (vigged) Pinnacle 1X2 triple for one fixture, or None on any miss.
    Same commenceTimeFrom/To windowing as resolveFixtures.ts's fetchClosingOdds
    — narrows to games kicking off within +/-2h of the given kickoff, which at
    call time always includes THIS fixture (the window filters by the game's
    own commence time, not by when the call happens), so the identical query
    shape is safe to reuse for both an at-pick (early) and at-close (T-30m)
    capture — "which point in time" comes from WHEN this script is invoked."""
    try:
        kickoff_dt = datetime.fromisoformat(kickoff.replace("Z", "+00:00"))
    except ValueError:
        return None
    window_from = (kickoff_dt - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    window_to = (kickoff_dt + timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    params = urllib.parse.urlencode(
        {
            "apiKey": api_key,
            "regions": "uk,eu",
            "markets": "h2h",
            "oddsFormat": "decimal",
            "bookmakers": "pinnacle",
            "commenceTimeFrom": window_from,
            "commenceTimeTo": window_to,
        }
    )
    url = f"{ODDS_API_BASE}/sports/{sport_key}/odds/?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            games = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        _warn(f"odds-api request failed: {exc}")
        return None

    if not isinstance(games, list):
        return None

    home_n, away_n = normalise_team(home), normalise_team(away)
    for game in games:
        if normalise_team(str(game.get("home_team", ""))) != home_n:
            continue
        if normalise_team(str(game.get("away_team", ""))) != away_n:
            continue
        for bk in game.get("bookmakers", []) or []:
            if bk.get("key") != "pinnacle":
                continue
            for mkt in bk.get("markets", []) or []:
                if mkt.get("key") != "h2h":
                    continue
                prices: dict[str, float] = {}
                for outcome in mkt.get("outcomes", []) or []:
                    name = str(outcome.get("name", ""))
                    price = outcome.get("price")
                    if price is None:
                        continue
                    try:
                        price_f = float(price)
                    except (TypeError, ValueError):
                        continue
                    if name == "Draw":
                        prices["draw"] = price_f
                    elif normalise_team(name) == home_n:
                        prices["home"] = price_f
                    elif normalise_team(name) == away_n:
                        prices["away"] = price_f
                if {"home", "draw", "away"} <= prices.keys():
                    return prices
    return None


# ── Tier 2: Google AI Mode fallback (best-effort regex extraction) ───────────

_PRICE_RE = r"(\d{1,2}\.\d{1,2})"


def _extract_keyword_price(text: str, keyword: str) -> Optional[float]:
    """Best-effort: first decimal number (1.01-50 range) appearing within ~12
    non-digit characters after `keyword`. Deliberately conservative (single
    regex pass, no NLP) — this is the degraded fallback tier, documented as
    lower-confidence than Tier 1 everywhere it's consumed."""
    m = re.search(rf"\b{re.escape(keyword)}\b\D{{0,12}}{_PRICE_RE}", text, re.IGNORECASE)
    if not m:
        return None
    try:
        v = float(m.group(1))
    except ValueError:
        return None
    return v if 1.01 <= v <= 50.0 else None


def _extract_prices(market: str, side: str, text: str) -> dict[str, float]:
    m = market.strip().lower()
    prices: dict[str, float] = {}
    if m in _ONE_X_TWO_MARKETS:
        keys = {"home": ("home", "1"), "draw": ("draw", "x"), "away": ("away", "2")}
    elif m in ("btts", "both_teams_to_score"):
        keys = {"yes": ("yes", "btts yes"), "no": ("no", "btts no")}
    elif m in ("dnb", "draw_no_bet"):
        keys = {"home": ("home",), "away": ("away",)}
    else:
        # Unknown market — try only the requested side as a last resort.
        keys = {side: (side,)}
    for label, candidates in keys.items():
        for kw in candidates:
            v = _extract_keyword_price(text, kw)
            if v is not None:
                prices[label] = v
                break
    return prices


def fetch_ai_mode_prices(
    home: str, away: str, league: str, kickoff: str, market: str, side: str
) -> dict[str, float]:
    if not HAS_PLAYWRIGHT:
        _warn("Playwright not installed — skipping AI-Mode fallback tier")
        return {}
    date = kickoff[:10]
    query = re.sub(r"\s+", " ", f"{home} vs {away} {league} {date} pinnacle odds {market}").strip()
    target = _GOOGLE_AI_MODE.format(q=urllib.parse.quote_plus(query))
    try:
        result = asyncio.run(_ai_mode_run(target, 4000))
    except Exception as exc:  # Playwright/browser failures — degrade, never raise
        _warn(f"AI-Mode scrape failed: {exc}")
        return {}
    if not result or not result.get("text"):
        return {}
    return _extract_prices(market, side, str(result["text"]))


# ── CLI ────────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Sharp-reference (Pinnacle) odds fetch for one fixture/market/side — "
        "Odds API primary, Google AI Mode fallback."
    )
    ap.add_argument("--home", required=True)
    ap.add_argument("--away", required=True)
    ap.add_argument("--kickoff", required=True, help="ISO-8601 kickoff, e.g. 2026-07-10T15:00:00Z")
    ap.add_argument("--market", required=True, help='e.g. "1X2", "btts", "dnb"')
    ap.add_argument("--side", required=True, help='e.g. "home", "draw", "away", "yes", "no"')
    ap.add_argument("--league", default="", help="Used for AI-Mode query context only")
    ap.add_argument(
        "--sport-key",
        default="",
        help="Odds-API sport key (e.g. soccer_epl) — omit to skip Tier 1 for this league",
    )
    ap.add_argument("--fixture-key", default="", help="Caller's fixtureId, for traceability only")
    ap.add_argument("--odds-api-key", default="", help="Override .env ODDS_API_KEY (optional)")
    args = ap.parse_args()

    env = _load_env()
    odds_api_key = args.odds_api_key or env.get("ODDS_API_KEY", "")

    prices: dict[str, float] = {}
    source = "unavailable"
    error: Optional[str] = None

    if args.market.strip().lower() in _ONE_X_TWO_MARKETS and odds_api_key and args.sport_key:
        try:
            fetched = fetch_odds_api_1x2(args.sport_key, args.home, args.away, args.kickoff, odds_api_key)
        except Exception as exc:  # never let Tier 1 take the process down
            fetched = None
            error = f"odds_api: {exc}"
        if fetched:
            prices = fetched
            source = "odds_api"

    if not prices:
        try:
            ai_prices = fetch_ai_mode_prices(
                args.home, args.away, args.league, args.kickoff, args.market, args.side
            )
        except Exception as exc:  # never let Tier 2 take the process down
            ai_prices = {}
            error = f"ai_mode: {exc}"
        if ai_prices:
            prices = ai_prices
            source = "ai_mode_fallback"

    payload: dict[str, Any] = {
        "ok": bool(prices),
        "source": source if prices else "unavailable",
        "market": args.market,
        "side": args.side,
        "fetched_at": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "prices": prices,
    }
    if error and not prices:
        payload["error"] = error

    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # fail-open contract: ALWAYS emit valid JSON, never a bare traceback
        print(
            json.dumps(
                {
                    "ok": False,
                    "source": "unavailable",
                    "market": "",
                    "side": "",
                    "prices": {},
                    "error": str(exc),
                }
            )
        )
        sys.exit(0)
