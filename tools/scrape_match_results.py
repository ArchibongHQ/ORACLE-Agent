"""scrape_match_results.py — multi-source consensus match-result resolver.

Last-resort results source for fixtures that neither API-Football nor
football-data.org resolved (resolveFixtures.ts's `unmatched` list) — the
results counterpart to scrape_live_odds.py's consensus-odds fallback.
Implements CLAUDE.md §6 (no-data-blocker): missing/exhausted result APIs
must never block resolution; search engines and live-score sites already
have the score, so scrape it.

Sources (in priority order), mirroring scrape_live_odds.py's source set
plus ESPN (structured JSON, already used for fixtures in scrape_fixtures.py)
and Google AI Mode (scrape_google_ai.py) as a 5th cross-check:
  ESPN            — site.api.espn.com scoreboard, status=post, no Playwright
  Flashscore      — Playwright, client-side JS state extraction
  BetExplorer     — requests + BeautifulSoup, results table
  SofaScore       — public REST API (search + event + score)
  Google AI Mode  — scrape_google_ai.py, parses "X-Y" scoreline from prose

A result is accepted only when >= min_consensus sources agree on the exact
same (home_goals, away_goals) scoreline — goals are integers, so "consensus"
means identical, not within-variance like odds.

Usage:
    python tools/scrape_match_results.py --match "Arsenal_Chelsea_Premier League_2026-06-05"
    python tools/scrape_match_results.py --fixtures .tmp/fixtures/unmatched_2026-06-21.txt
    python tools/scrape_match_results.py --dry-run
    python tools/scrape_match_results.py --quiet
    python tools/scrape_match_results.py --no-playwright
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

try:
    import requests as _requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

try:
    from bs4 import BeautifulSoup
    HAS_SOUP = True
except ImportError:
    HAS_SOUP = False

try:
    from playwright.async_api import async_playwright
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

# ── Config ────────────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parent.parent
RESULTS_CACHE_DIR = ROOT / ".tmp" / "results"
RESULTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)

SCRAPE_TIMEOUT = 20
DEFAULT_MIN_CONSENSUS = 2  # goals are exact integers — 2 agreeing sources is a strong signal

_CHROME_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

# Same 16-league map as scrape_fixtures.py — ESPN's scoreboard endpoint covers
# the same slate this tool needs to resolve, including FIFA World Cup.
ESPN_LEAGUE_MAP: dict[str, str] = {
    "eng.1": "Premier League", "eng.2": "Championship", "esp.1": "La Liga",
    "ger.1": "Bundesliga", "ita.1": "Serie A", "fra.1": "Ligue 1",
    "ned.1": "Eredivisie", "por.1": "Primeira Liga", "bel.1": "Belgian Pro League",
    "sco.1": "Scottish Premiership", "uefa.champions": "Champions League",
    "uefa.europa": "Europa League", "uefa.europa.conf": "Conference League",
    "jpn.1": "J League", "usa.1": "MLS", "fifa.world": "FIFA World Cup",
}


def _warn(msg: str) -> None:
    print(f"[scrape-results] WARN: {msg}", file=sys.stderr)


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _names_match(a: str, b: str) -> bool:
    na, nb = _norm(a), _norm(b)
    return na == nb or na in nb or nb in na


# ── Result dataclasses ──────────────────────────────────────────────────────────

@dataclass
class ScoreResult:
    source: str
    status: str  # "success", "no_match", "parse_error", "network_error", "unavailable"
    home_goals: Optional[int] = None
    away_goals: Optional[int] = None
    timestamp: str = ""

    def __post_init__(self) -> None:
        if not self.timestamp:
            self.timestamp = datetime.now(timezone.utc).isoformat()


@dataclass
class ConsensusResult:
    home: str
    away: str
    league: str
    date: str
    home_goals: int
    away_goals: int
    actual_result: str  # "home" | "draw" | "away"
    confidence: float
    agreeing_sources: int
    total_sources: int
    source_breakdown: dict[str, Any]
    resolved_at: str = ""

    def __post_init__(self) -> None:
        if not self.resolved_at:
            self.resolved_at = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ── ESPN (structured JSON, no Playwright) ───────────────────────────────────────

def scrape_espn(home: str, away: str, date_str: str, quiet: bool = False) -> ScoreResult:
    date_compact = date_str.replace("-", "")
    for slug in ESPN_LEAGUE_MAP:
        url = (
            f"https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/scoreboard"
            f"?dates={date_compact}"
        )
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ORACLE/1.0"})
            with urllib.request.urlopen(req, timeout=SCRAPE_TIMEOUT) as resp:
                data = json.loads(resp.read())
        except Exception:
            continue

        for event in data.get("events", []):
            comps = event.get("competitions", [])
            if not comps:
                continue
            comp = comps[0]
            if comp.get("status", {}).get("type", {}).get("state") != "post":
                continue
            competitors = comp.get("competitors", [])
            h_name = h_score = a_name = a_score = None
            for c in competitors:
                name = c.get("team", {}).get("displayName", "")
                score = c.get("score")
                if c.get("homeAway") == "home":
                    h_name, h_score = name, score
                elif c.get("homeAway") == "away":
                    a_name, a_score = name, score
            if not h_name or not a_name:
                continue
            if _names_match(home, h_name) and _names_match(away, a_name):
                try:
                    return ScoreResult(
                        source="espn", status="success",
                        home_goals=int(h_score), away_goals=int(a_score),
                    )
                except (TypeError, ValueError):
                    continue
    return ScoreResult(source="espn", status="no_match")


# ── Flashscore (Playwright) ──────────────────────────────────────────────────────

def scrape_flashscore_result(home: str, away: str, quiet: bool = False) -> ScoreResult:
    if not HAS_PLAYWRIGHT:
        return ScoreResult(source="flashscore", status="unavailable")

    async def _scrape() -> ScoreResult:
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
                context = await browser.new_context(user_agent=_CHROME_UA)
                page = await context.new_page()
                try:
                    search_url = f"https://www.flashscore.com/search/?q={urllib.parse.quote(home + ' ' + away)}"
                    await asyncio.wait_for(
                        page.goto(search_url, wait_until="domcontentloaded"), timeout=SCRAPE_TIMEOUT
                    )
                    links = await page.query_selector_all("a[href*='/match/']")
                    if not links:
                        return ScoreResult(source="flashscore", status="no_match")
                    match_url = await links[0].get_attribute("href")
                    if match_url and not match_url.startswith("http"):
                        match_url = "https://www.flashscore.com" + match_url
                    await asyncio.wait_for(
                        page.goto(match_url, wait_until="domcontentloaded"), timeout=SCRAPE_TIMEOUT
                    )
                    await page.wait_for_timeout(1500)
                    score_text = await page.evaluate(
                        """() => {
                            const el = document.querySelector('[data-testid="wcl-scores-overline-05"], .detailScore__wrapper, .duelParticipant__score');
                            return el ? el.textContent : null;
                        }"""
                    )
                    if not score_text:
                        return ScoreResult(source="flashscore", status="parse_error")
                    m = re.search(r"(\d+)\D+(\d+)", score_text)
                    if not m:
                        return ScoreResult(source="flashscore", status="parse_error")
                    return ScoreResult(
                        source="flashscore", status="success",
                        home_goals=int(m.group(1)), away_goals=int(m.group(2)),
                    )
                finally:
                    await browser.close()
        except asyncio.TimeoutError:
            return ScoreResult(source="flashscore", status="network_error")
        except Exception as e:
            if not quiet:
                print(f"[flashscore] Error: {e}", file=sys.stderr)
            return ScoreResult(source="flashscore", status="network_error")

    return asyncio.run(_scrape())


# ── BetExplorer (requests + BeautifulSoup) ──────────────────────────────────────

def scrape_betexplorer_result(home: str, away: str, quiet: bool = False) -> ScoreResult:
    if not HAS_REQUESTS or not HAS_SOUP:
        return ScoreResult(source="betexplorer", status="unavailable")
    try:
        search_url = f"https://www.betexplorer.com/search/?q={urllib.parse.quote(home + ' ' + away)}"
        headers = {"User-Agent": _CHROME_UA}
        resp = _requests.get(search_url, headers=headers, timeout=SCRAPE_TIMEOUT)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.content, "html.parser")
        match_links = soup.find_all("a", href=re.compile(r"/soccer/.*?/\d+/"))
        if not match_links:
            return ScoreResult(source="betexplorer", status="no_match")
        match_url = match_links[0]["href"]
        if not match_url.startswith("http"):
            match_url = "https://www.betexplorer.com" + match_url
        resp = _requests.get(match_url, headers=headers, timeout=SCRAPE_TIMEOUT)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.content, "html.parser")
        score_el = soup.find(class_=re.compile(r"result__score|sc-result"))
        if not score_el:
            return ScoreResult(source="betexplorer", status="parse_error")
        m = re.search(r"(\d+)\s*:\s*(\d+)", score_el.get_text())
        if not m:
            return ScoreResult(source="betexplorer", status="parse_error")
        return ScoreResult(
            source="betexplorer", status="success",
            home_goals=int(m.group(1)), away_goals=int(m.group(2)),
        )
    except Exception as e:
        if not quiet:
            print(f"[betexplorer] Error: {e}", file=sys.stderr)
        return ScoreResult(source="betexplorer", status="network_error")


# ── SofaScore (public REST API) ──────────────────────────────────────────────────

def scrape_sofascore_result(home: str, away: str, quiet: bool = False) -> ScoreResult:
    if not HAS_REQUESTS:
        return ScoreResult(source="sofascore", status="unavailable")
    try:
        headers = {"User-Agent": _CHROME_UA}
        search_url = f"https://api.sofascore.com/api/v1/search/events?query={urllib.parse.quote(home + ' ' + away)}"
        resp = _requests.get(search_url, headers=headers, timeout=SCRAPE_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        events = data.get("results") or data.get("events") or []
        if not events:
            return ScoreResult(source="sofascore", status="no_match")
        event = events[0].get("entity", events[0])
        home_score = event.get("homeScore", {}).get("current")
        away_score = event.get("awayScore", {}).get("current")
        if home_score is None or away_score is None:
            return ScoreResult(source="sofascore", status="parse_error")
        return ScoreResult(
            source="sofascore", status="success",
            home_goals=int(home_score), away_goals=int(away_score),
        )
    except Exception as e:
        if not quiet:
            print(f"[sofascore] Error: {e}", file=sys.stderr)
        return ScoreResult(source="sofascore", status="network_error")


# ── Google AI Mode (scrape_google_ai.py subprocess) ─────────────────────────────

def scrape_google_ai_result(home: str, away: str, league: str, date_str: str, quiet: bool = False) -> ScoreResult:
    import subprocess
    script = ROOT / "tools" / "scrape_google_ai.py"
    query = f"{home} vs {away} {league} final score {date_str}"
    try:
        result = subprocess.run(
            [sys.executable, str(script), "--query", query, "--wait-ms", "4000"],
            capture_output=True, text=True, timeout=35,
        )
        if result.returncode != 0 or not result.stdout:
            return ScoreResult(source="google_ai_mode", status="network_error")
        payload = json.loads(result.stdout)
        if not payload.get("ok") or not payload.get("result", {}).get("text"):
            return ScoreResult(source="google_ai_mode", status="no_match")
        text = payload["result"]["text"]
        # Look for "Home 2-1 Away" / "Home 2 - 1 Away" / "2-1" near the team names.
        m = re.search(
            rf"{re.escape(home)}\D{{0,30}}?(\d+)\s*[-–:]\s*(\d+)\D{{0,30}}?{re.escape(away)}",
            text, re.IGNORECASE,
        )
        if not m:
            m = re.search(r"\b(\d+)\s*[-–:]\s*(\d+)\b", text)
        if not m:
            return ScoreResult(source="google_ai_mode", status="parse_error")
        return ScoreResult(
            source="google_ai_mode", status="success",
            home_goals=int(m.group(1)), away_goals=int(m.group(2)),
        )
    except Exception as e:
        if not quiet:
            print(f"[google_ai_mode] Error: {e}", file=sys.stderr)
        return ScoreResult(source="google_ai_mode", status="network_error")


# ── Consensus ─────────────────────────────────────────────────────────────────

def compute_result_consensus(
    home: str, away: str, league: str, date_str: str,
    results: list[ScoreResult],
    min_consensus: int = DEFAULT_MIN_CONSENSUS,
) -> Optional[ConsensusResult]:
    successful = [r for r in results if r.status == "success" and r.home_goals is not None and r.away_goals is not None]
    if len(successful) < min_consensus:
        return None

    tally = Counter((r.home_goals, r.away_goals) for r in successful)
    (best_score, agree_count) = tally.most_common(1)[0]
    if agree_count < min_consensus:
        return None

    home_goals, away_goals = best_score
    actual_result = "home" if home_goals > away_goals else "away" if away_goals > home_goals else "draw"
    confidence = min(agree_count / max(len(successful), 1), 1.0)

    return ConsensusResult(
        home=home, away=away, league=league, date=date_str,
        home_goals=home_goals, away_goals=away_goals,
        actual_result=actual_result,
        confidence=round(confidence, 3),
        agreeing_sources=agree_count,
        total_sources=len(results),
        source_breakdown={r.source: {"status": r.status, "score": (r.home_goals, r.away_goals)} for r in results},
    )


def scrape_consensus_result(
    home: str, away: str, league: str, date_str: str,
    min_consensus: int = DEFAULT_MIN_CONSENSUS,
    quiet: bool = False,
    use_playwright: bool = True,
) -> Optional[ConsensusResult]:
    if not quiet:
        print(f"[oracle] Scraping result consensus: {home} vs {away} ({league}, {date_str})")

    results: list[ScoreResult] = []
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {
            executor.submit(scrape_espn, home, away, date_str, quiet): "espn",
            executor.submit(scrape_betexplorer_result, home, away, quiet): "betexplorer",
            executor.submit(scrape_sofascore_result, home, away, quiet): "sofascore",
            executor.submit(scrape_google_ai_result, home, away, league, date_str, quiet): "google_ai_mode",
        }
        if use_playwright and HAS_PLAYWRIGHT:
            futures[executor.submit(scrape_flashscore_result, home, away, quiet)] = "flashscore"

        for future in as_completed(futures, timeout=SCRAPE_TIMEOUT * 3):
            try:
                results.append(future.result())
            except Exception as e:
                source_name = futures[future]
                if not quiet:
                    print(f"[executor] {source_name} error: {e}", file=sys.stderr)
                results.append(ScoreResult(source=source_name, status="network_error"))

    if not quiet:
        ok = len([r for r in results if r.status == "success"])
        print(f"[oracle] Collected {len(results)} scrape results, {ok} successful")

    consensus = compute_result_consensus(home, away, league, date_str, results, min_consensus)
    if consensus:
        if not quiet:
            print(
                f"[oracle] Result consensus: {consensus.home_goals}-{consensus.away_goals} "
                f"({consensus.agreeing_sources}/{consensus.total_sources} sources, "
                f"{consensus.confidence:.0%} confidence)"
            )
        return consensus
    if not quiet:
        print("[oracle] No result consensus (insufficient agreeing sources)")
    return None


# ── CLI ───────────────────────────────────────────────────────────────────────

def _slug(home: str, away: str, league: str, date_str: str) -> str:
    raw = f"{home}_{away}_{league}_{date_str}"
    return re.sub(r"[^a-zA-Z0-9_-]", "_", raw)


def main() -> int:
    ap = argparse.ArgumentParser(description="Multi-source consensus match-result resolver (ORACLE results fallback).")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--match", help="Match spec: 'Home_Away_League_YYYY-MM-DD'")
    g.add_argument("--fixtures", help="Path to a file of unmatched fixtures, one 'home vs away, league, YYYY-MM-DDTHH:MM:SSZ' per line")
    ap.add_argument("--dry-run", action="store_true", help="Print without writing")
    ap.add_argument("--quiet", action="store_true", help="Suppress progress output")
    ap.add_argument("--no-playwright", action="store_true", help="Skip Flashscore (Playwright)")
    ap.add_argument(
        "--min-consensus", type=int, default=DEFAULT_MIN_CONSENSUS,
        help=f"Minimum agreeing sources required (default {DEFAULT_MIN_CONSENSUS})",
    )
    args = ap.parse_args()

    jobs: list[tuple[str, str, str, str]] = []
    if args.match:
        parts = args.match.split("_")
        if len(parts) < 4:
            print(f"Invalid match spec: {args.match} (expected Home_Away_League_YYYY-MM-DD)", file=sys.stderr)
            return 1
        home, away, league, date_str = parts[0], parts[1], "_".join(parts[2:-1]), parts[-1]
        jobs.append((home, away, league, date_str))
    else:
        fixture_path = Path(args.fixtures)
        if not fixture_path.exists():
            print(f"Fixtures file not found: {fixture_path}", file=sys.stderr)
            return 1
        for line in fixture_path.read_text(encoding="utf-8").strip().split("\n"):
            m = re.match(r"(.+?)\s+vs\s+(.+?),\s+(.+?),\s+(.+)", line.strip())
            if not m:
                continue
            home, away, league, kickoff = m.groups()
            jobs.append((home, away, league, kickoff[:10]))

    any_resolved = False
    for home, away, league, date_str in jobs:
        consensus = scrape_consensus_result(
            home, away, league, date_str,
            min_consensus=args.min_consensus,
            quiet=args.quiet,
            use_playwright=not args.no_playwright,
        )
        if consensus and not args.dry_run:
            out_path = RESULTS_CACHE_DIR / f"{_slug(home, away, league, date_str)}.json"
            out_path.write_text(json.dumps(consensus.to_dict(), indent=2), encoding="utf-8")
            if not args.quiet:
                print(f"[oracle] Saved to {out_path}")
            any_resolved = True
        elif consensus:
            print(json.dumps(consensus.to_dict(), indent=2))
            any_resolved = True

    return 0 if any_resolved else 3


if __name__ == "__main__":
    sys.exit(main())
