"""scrape_transfermarkt_live.py — live per-team squad market-value lookup via
Transfermarkt (today's intel, not the historical Kaggle backfill — see
tools/fetch_transfermarkt.py for the season-level GBM-feature builder; this
is a different tool with a different purpose, same site).

Confirmed live 2026-06-23 (plain `requests`, no auth, no anti-bot — see
oracle_market_capture_and_swarm_scope memory): Transfermarkt's quick-search
and squad-list pages are genuinely plain HTML, zero JS rendering required,
unlike FotMob (crypto-signed header, needs Playwright interception — see
fetch_fotmob.py). Zero browser/GPU footprint, safe to run concurrently with
anything, including the existing Playwright scrapers.

Two-step fetch, both plain HTTP:
  1. Quick search (schnellsuche) for the team name -> first senior men's team
     result's slug + numeric id, e.g. "fc-arsenal"/11 (youth/women results
     filtered out the same way scrape_fixtures.py disambiguates fixture level
     elsewhere in this codebase).
  2. That team's current-season squad-list page (/kader/verein/{id}) -> each
     player's id, name, position, and market value.

Usage:
    python tools/scrape_transfermarkt_live.py --team "Arsenal"
    python tools/scrape_transfermarkt_live.py --team "Arsenal" --out .tmp/transfermarkt/arsenal_live.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Optional

import requests

ROOT = Path(__file__).resolve().parent.parent
TM_LIVE_DIR = ROOT / ".tmp" / "transfermarkt"

SEARCH_URL = "https://www.transfermarkt.com/schnellsuche/ergebnis/schnellsuche"
SQUAD_URL = "https://www.transfermarkt.com/{slug}/kader/verein/{tid}/saison_id/{season}"

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)
_HEADERS = {"User-Agent": _UA, "Accept-Language": "en-GB,en;q=0.9"}
_REQUEST_TIMEOUT_S = 20

# Transfermarkt search returns youth/women sides under the same club name
# (e.g. "FC Arsenal U23") — filter those out rather than match the first hit
# blindly. Mirrors the disambiguation principle scrape_fixtures.py already
# applies elsewhere (see feedback_disambiguate_fixture_level memory).
_YOUTH_WOMEN_RE = re.compile(r"-(u1[5-9]|u2[0-3]|frauen|women)-", re.IGNORECASE)

_TEAM_LINK_RE = re.compile(r'href="(/([a-z0-9-]+)/startseite/verein/(\d+))"[^>]*>([^<]*)</a>')
_PLAYER_RE = re.compile(r'href="/[a-z0-9-]+/profil/spieler/(\d+)">\s*([^<]+?)\s*</a>')
_MV_RE = re.compile(r'marktwertverlauf/spieler/(\d+)">\s*[^\d]*([\d.,]+\s*[kKmM]?)\s*</a>')
_POSITION_ROW_RE = re.compile(r'</a>\s*</td>\s*</tr>\s*<tr>\s*<td>\s*([A-Za-z][A-Za-z\s-]*?)\s*</td>\s*</tr>')


def _warn(msg: str) -> None:
    print(f"[scrape-transfermarkt-live] WARN: {msg}", file=sys.stderr)


def resolve_team(team: str) -> Optional[tuple[str, str]]:
    """Quick-search for `team`, return (slug, transfermarkt_id) of the first
    result whose DISPLAY NAME actually matches `team`, or None if nothing
    usable was found. The raw href order is NOT a relevance ranking we can
    trust — live-verified 2026-06-23: searching "Arsenal" returns "SD Tenisca"
    (an unrelated club, no name relation at all) as the first href, with
    "Arsenal FC" only second — so candidates are filtered by display-label
    match first, falling back to href order only among those matches."""
    try:
        resp = requests.get(
            SEARCH_URL, params={"query": team}, headers=_HEADERS, timeout=_REQUEST_TIMEOUT_S
        )
        resp.encoding = "utf-8"
    except Exception as exc:
        _warn(f"search failed for {team!r}: {exc}")
        return None
    if resp.status_code != 200:
        return None

    query_lower = team.strip().lower()
    seen: set[str] = set()
    for href, slug, tid, label in _TEAM_LINK_RE.findall(resp.text):
        if href in seen:
            continue
        seen.add(href)
        if _YOUTH_WOMEN_RE.search(href):
            continue
        if query_lower not in label.strip().lower():
            continue
        return slug, tid
    return None


def fetch_squad(slug: str, team_id: str, season: int = 2025) -> list[dict[str, Any]]:
    """Current-season squad list: [{id, name, position, market_value}]. Position
    is best-effort (None if the row pattern doesn't match — page layout drift,
    degrades gracefully like every other parser in this codebase)."""
    url = SQUAD_URL.format(slug=slug, tid=team_id, season=season)
    try:
        resp = requests.get(url, headers=_HEADERS, timeout=_REQUEST_TIMEOUT_S)
        resp.encoding = "utf-8"
    except Exception as exc:
        _warn(f"squad fetch failed for {slug}/{team_id}: {exc}")
        return []
    if resp.status_code != 200:
        return []

    text = resp.text
    mv_by_id = dict(_MV_RE.findall(text))
    positions = _POSITION_ROW_RE.findall(text)

    out: list[dict[str, Any]] = []
    for i, (pid, name) in enumerate(_PLAYER_RE.findall(text)):
        out.append({
            "id": pid,
            "name": name.strip(),
            "position": positions[i].strip() if i < len(positions) else None,
            "market_value": mv_by_id.get(pid),
        })
    return out


def fetch_transfermarkt_team(team: str) -> Optional[dict[str, Any]]:
    """Single-team fetch: resolve id, then squad list. Returns None on total
    failure — never raises, same convention as every other tool here."""
    resolved = resolve_team(team)
    if not resolved:
        return None
    slug, team_id = resolved
    squad = fetch_squad(slug, team_id)
    if not squad:
        return None
    return {"team": team, "slug": slug, "transfermarkt_id": team_id, "squad": squad}


def fetch_transfermarkt_batch(teams: list[str], max_workers: Optional[int] = None) -> dict[str, dict[str, Any]]:
    """Multi-team fetch via ThreadPoolExecutor — plain HTTP, no browser
    process per worker, so this uses swarm_dispatch.swarm_max_workers (the
    thin-HTTP cap, 8 local Windows / unbounded VPS), NOT the browser-page cap
    fetch_fotmob.py/fetch_sofascore.py need. A team's fetch failure degrades
    to that team being absent from the result dict — never raises."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    out: dict[str, dict[str, Any]] = {}
    if not teams:
        return out

    try:
        from swarm_dispatch import swarm_max_workers
    except ImportError:  # repo root on sys.path instead of tools/
        from tools.swarm_dispatch import swarm_max_workers

    cap = max_workers if max_workers is not None else swarm_max_workers(len(teams))
    with ThreadPoolExecutor(max_workers=max(1, cap)) as pool:
        futures = {pool.submit(fetch_transfermarkt_team, t): t for t in teams}
        for fut in as_completed(futures):
            team = futures[fut]
            try:
                result = fut.result()
                if result:
                    out[team] = result
            except Exception as exc:
                _warn(f"batch fetch failed for {team!r}: {exc}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Live Transfermarkt per-team squad/market-value fetch (plain HTTP).")
    ap.add_argument("--team", required=True, help="Team name, e.g. 'Arsenal'")
    ap.add_argument("--out", help="Write JSON here instead of stdout")
    args = ap.parse_args()

    result = fetch_transfermarkt_team(args.team)
    if result is None:
        print("[scrape-transfermarkt-live] no data captured", file=sys.stderr)
        return 3

    payload = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(payload, encoding="utf-8")
        print(f"[scrape-transfermarkt-live] wrote {out_path}")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
