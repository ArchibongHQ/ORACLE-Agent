"""scrape_live_odds.py — synthesize live odds from multiple sources via consensus.

Fallback source when Odds API fails (quota exhausted, timeout, etc.).
Scrapes live bookmaker odds from 5+ public sources and validates consensus.

Sources (in priority order):
  Flashscore     — High reliability, client-side JS state extraction
  BetExplorer    — High reliability, HTML table + AJAX parsing
  SofaScore      — High reliability, Next.js state + REST API
  OneFootball    — Medium reliability, __NEXT_DATA__ + table parsing
  Betfair API    — High reliability, public JSON REST (no auth required)

Usage:
    python tools/scrape_live_odds.py --match "home_vs_away_league_date"
    python tools/scrape_live_odds.py --fixtures ".tmp/fixtures/today.txt"
    python tools/scrape_live_odds.py --dry-run
    python tools/scrape_live_odds.py --quiet
    python tools/scrape_live_odds.py --no-playwright  # skip dynamic sources
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Any
from urllib.error import HTTPError, URLError

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
    from playwright.async_api import async_playwright, BrowserContext, Page
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

# ── Config ────────────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parent.parent
ODDS_CACHE_DIR = ROOT / ".tmp" / "odds"
FIXTURE_CACHE = ROOT / ".tmp" / "fixtures" / "today.txt"

ODDS_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Scraping timeouts (seconds)
SCRAPE_TIMEOUT = 30
BETFAIR_TIMEOUT = 10

# Consensus thresholds (configurable via env)
DEFAULT_MIN_CONSENSUS = 3  # Minimum sources for synthetic odds
DEFAULT_VARIANCE_THRESHOLD = 0.025  # ±2.5% variance allowed

# ── Circuit breaker ───────────────────────────────────────────────────────────
# Sources like Betfair/SofaScore can return 403 (anti-bot/auth) for every
# fixture in a run — that's a structural block, not a transient blip. Without
# this, every fixture re-pays the full per-call timeout against a source that
# will never succeed this run. After CIRCUIT_BREAKER_THRESHOLD consecutive
# failures, skip that source for the rest of the process (reset happens
# naturally on the next invocation).
CIRCUIT_BREAKER_THRESHOLD = 3
_circuit_failures: dict[str, int] = {}
_circuit_open: set[str] = set()


def _circuit_is_open(source: str) -> bool:
    return source in _circuit_open


def _circuit_record(source: str, success: bool, quiet: bool = False) -> None:
    if success:
        _circuit_failures[source] = 0
        return
    _circuit_failures[source] = _circuit_failures.get(source, 0) + 1
    if _circuit_failures[source] >= CIRCUIT_BREAKER_THRESHOLD and source not in _circuit_open:
        _circuit_open.add(source)
        if not quiet:
            print(
                f"[{source}] circuit open after {CIRCUIT_BREAKER_THRESHOLD} consecutive failures — "
                "skipping for the rest of this run",
                file=sys.stderr,
            )

_CHROME_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

# ── Data Classes ──────────────────────────────────────────────────────────────

@dataclass
class OddsOutcome:
    home: Optional[float] = None
    draw: Optional[float] = None
    away: Optional[float] = None


@dataclass
class OddsMarket:
    h2h: Optional[OddsOutcome] = None
    totals: Optional[OddsOutcome] = None
    btts: Optional[OddsOutcome] = None


@dataclass
class ScrapeResult:
    source: str
    status: str  # "success", "timeout", "no_match", "parse_error", "network_error"
    h2h: Optional[OddsOutcome] = None
    totals: Optional[OddsOutcome] = None
    btts: Optional[OddsOutcome] = None
    timestamp: str = ""

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = datetime.now(timezone.utc).isoformat()


@dataclass
class ConsensusOdds:
    match_id: str
    source: str = "web_search_consensus"
    confidence: float = 0.0
    fetched_at: str = ""
    consensus_odds: Optional[dict[str, Any]] = None
    source_breakdown: Optional[dict[str, Any]] = None
    validation: Optional[dict[str, Any]] = None

    def __post_init__(self):
        if not self.fetched_at:
            self.fetched_at = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ── Scraping Functions ────────────────────────────────────────────────────────

def scrape_flashscore(home: str, away: str, quiet: bool = False) -> ScrapeResult:
    """Scrape odds from Flashscore via Playwright (JS state extraction)."""
    if not HAS_PLAYWRIGHT:
        return ScrapeResult(source="flashscore", status="playwright_unavailable")

    async def _scrape() -> ScrapeResult:
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                context = await browser.new_context(user_agent=_CHROME_UA)
                page = await context.new_page()

                # Search for match
                search_url = f"https://www.flashscore.com/search/?q={home}+{away}"
                await asyncio.wait_for(page.goto(search_url, wait_until="domcontentloaded"), timeout=SCRAPE_TIMEOUT)

                # Extract match link from search results
                links = await page.query_selector_all("a[href*='/match/']")
                if not links:
                    await browser.close()
                    return ScrapeResult(source="flashscore", status="no_match")

                match_url = await links[0].get_attribute("href")
                if not match_url.startswith("http"):
                    match_url = "https://www.flashscore.com" + match_url

                # Navigate to odds page
                odds_url = match_url.replace("/match/", "/match/") + "#odds"
                await asyncio.wait_for(page.goto(odds_url, wait_until="domcontentloaded"), timeout=SCRAPE_TIMEOUT)

                # Extract odds from JS state or DOM
                odds_data = await page.evaluate("""() => {
                    const containers = document.querySelectorAll('[data-testid="odds-container"]');
                    if (containers.length === 0) return null;

                    const h2h = {};
                    containers.forEach(c => {
                        const odds = c.querySelectorAll('[data-testid="odds-value"]');
                        if (odds.length >= 3) {
                            h2h.home = parseFloat(odds[0].textContent);
                            h2h.draw = parseFloat(odds[1].textContent);
                            h2h.away = parseFloat(odds[2].textContent);
                        }
                    });
                    return Object.keys(h2h).length > 0 ? h2h : null;
                }""")

                await browser.close()

                if odds_data:
                    return ScrapeResult(
                        source="flashscore",
                        status="success",
                        h2h=OddsOutcome(**odds_data)
                    )
                else:
                    return ScrapeResult(source="flashscore", status="parse_error")

        except asyncio.TimeoutError:
            return ScrapeResult(source="flashscore", status="timeout")
        except Exception as e:
            if not quiet:
                print(f"[flashscore] Error: {e}", file=sys.stderr)
            return ScrapeResult(source="flashscore", status="network_error")

    return asyncio.run(_scrape())


def scrape_betexplorer(home: str, away: str, quiet: bool = False) -> ScrapeResult:
    """Scrape odds from BetExplorer via HTML parsing."""
    if not HAS_REQUESTS or not HAS_SOUP:
        return ScrapeResult(source="betexplorer", status="requests_unavailable")

    try:
        # Search for match
        search_url = f"https://www.betexplorer.com/search/?q={home}+{away}"
        headers = {"User-Agent": _CHROME_UA}
        resp = _requests.get(search_url, headers=headers, timeout=SCRAPE_TIMEOUT)
        resp.raise_for_status()

        soup = BeautifulSoup(resp.content, "html.parser")
        match_links = soup.find_all("a", href=re.compile(r"/soccer/.*?/\d+/"))

        if not match_links:
            return ScrapeResult(source="betexplorer", status="no_match")

        # Navigate to odds page
        match_url = match_links[0]["href"]
        if not match_url.startswith("http"):
            match_url = "https://www.betexplorer.com" + match_url

        resp = _requests.get(match_url + "odds/", headers=headers, timeout=SCRAPE_TIMEOUT)
        resp.raise_for_status()

        soup = BeautifulSoup(resp.content, "html.parser")

        # Extract odds from table
        odds_rows = soup.find_all("tr", class_=re.compile(r"odds-row"))
        if odds_rows:
            cells = odds_rows[0].find_all("td")
            if len(cells) >= 3:
                try:
                    h2h = OddsOutcome(
                        home=float(cells[0].text.strip()),
                        draw=float(cells[1].text.strip()),
                        away=float(cells[2].text.strip())
                    )
                    return ScrapeResult(source="betexplorer", status="success", h2h=h2h)
                except (ValueError, IndexError):
                    pass

        return ScrapeResult(source="betexplorer", status="parse_error")

    except asyncio.TimeoutError:
        return ScrapeResult(source="betexplorer", status="timeout")
    except Exception as e:
        if not quiet:
            print(f"[betexplorer] Error: {e}", file=sys.stderr)
        return ScrapeResult(source="betexplorer", status="network_error")


def scrape_sofascore(home: str, away: str, quiet: bool = False) -> ScrapeResult:
    """Scrape odds from SofaScore via API."""
    if not HAS_REQUESTS:
        return ScrapeResult(source="sofascore", status="requests_unavailable")

    try:
        # Search for match
        search_url = f"https://api.sofascore.com/api/v1/search/teams?query={home}"
        headers = {"User-Agent": _CHROME_UA}
        resp = _requests.get(search_url, headers=headers, timeout=SCRAPE_TIMEOUT)
        resp.raise_for_status()

        data = resp.json()
        if not data.get("teams"):
            return ScrapeResult(source="sofascore", status="no_match")

        home_id = data["teams"][0]["id"]

        # Find event
        search_url = f"https://api.sofascore.com/api/v1/search/events?query={home}+{away}"
        resp = _requests.get(search_url, headers=headers, timeout=SCRAPE_TIMEOUT)
        resp.raise_for_status()

        data = resp.json()
        if not data.get("events"):
            return ScrapeResult(source="sofascore", status="no_match")

        event_id = data["events"][0]["id"]

        # Get odds
        odds_url = f"https://api.sofascore.com/api/v1/event/{event_id}/odds"
        resp = _requests.get(odds_url, headers=headers, timeout=SCRAPE_TIMEOUT)
        resp.raise_for_status()

        odds_data = resp.json()
        bookmakers = odds_data.get("bookmakers", [])

        if bookmakers:
            bets = bookmakers[0].get("bets", [])
            h2h_bet = next((b for b in bets if b.get("id") == 1), None)

            if h2h_bet:
                outcomes = h2h_bet.get("odds", [])
                if len(outcomes) >= 3:
                    try:
                        h2h = OddsOutcome(
                            home=float(outcomes[0].get("odd", 0)),
                            draw=float(outcomes[1].get("odd", 0)),
                            away=float(outcomes[2].get("odd", 0))
                        )
                        return ScrapeResult(source="sofascore", status="success", h2h=h2h)
                    except (ValueError, TypeError):
                        pass

        return ScrapeResult(source="sofascore", status="parse_error")

    except asyncio.TimeoutError:
        return ScrapeResult(source="sofascore", status="timeout")
    except Exception as e:
        if not quiet:
            print(f"[sofascore] Error: {e}", file=sys.stderr)
        return ScrapeResult(source="sofascore", status="network_error")


def scrape_betfair_api(home: str, away: str, quiet: bool = False) -> ScrapeResult:
    """Scrape odds from Betfair public API (no auth required)."""
    if not HAS_REQUESTS:
        return ScrapeResult(source="betfair_api", status="requests_unavailable")

    try:
        # Search for event
        url = "https://api.betfair.com/exchange/betting/rest/v1/eventTypes"
        headers = {"User-Agent": _CHROME_UA}

        resp = _requests.get(url, headers=headers, timeout=BETFAIR_TIMEOUT)
        resp.raise_for_status()

        data = resp.json()
        soccer_id = next((et["id"] for et in data if et.get("name") == "Soccer"), None)

        if not soccer_id:
            return ScrapeResult(source="betfair_api", status="no_match")

        # Search for events
        url = f"https://api.betfair.com/exchange/betting/rest/v1/events?eventTypeId={soccer_id}"
        resp = _requests.get(url, headers=headers, timeout=BETFAIR_TIMEOUT)
        resp.raise_for_status()

        data = resp.json()
        event = next(
            (e for e in data if home.lower() in e.get("name", "").lower() and away.lower() in e.get("name", "").lower()),
            None
        )

        if not event:
            return ScrapeResult(source="betfair_api", status="no_match")

        # Get market prices
        url = f"https://api.betfair.com/exchange/betting/rest/v1/marketCatalogue?eventIds={event['id']}&marketTypes=MATCH_ODDS"
        resp = _requests.get(url, headers=headers, timeout=BETFAIR_TIMEOUT)
        resp.raise_for_status()

        markets = resp.json()
        if not markets:
            return ScrapeResult(source="betfair_api", status="parse_error")

        market_id = markets[0]["marketId"]

        # Get odds
        url = f"https://api.betfair.com/exchange/betting/rest/v1/marketBook?marketIds={market_id}&priceProjection=EX_BEST_OFFERS"
        resp = _requests.get(url, headers=headers, timeout=BETFAIR_TIMEOUT)
        resp.raise_for_status()

        data = resp.json()
        if data and data[0].get("runners"):
            runners = data[0]["runners"]
            if len(runners) >= 3:
                try:
                    h2h = OddsOutcome(
                        home=1.0 / float(runners[0].get("exBestOffers", {}).get("backOdds", [{}])[0].get("price", 1)),
                        draw=1.0 / float(runners[1].get("exBestOffers", {}).get("backOdds", [{}])[0].get("price", 1)),
                        away=1.0 / float(runners[2].get("exBestOffers", {}).get("backOdds", [{}])[0].get("price", 1))
                    )
                    return ScrapeResult(source="betfair_api", status="success", h2h=h2h)
                except (ValueError, TypeError, ZeroDivisionError):
                    pass

        return ScrapeResult(source="betfair_api", status="parse_error")

    except asyncio.TimeoutError:
        return ScrapeResult(source="betfair_api", status="timeout")
    except Exception as e:
        if not quiet:
            print(f"[betfair_api] Error: {e}", file=sys.stderr)
        return ScrapeResult(source="betfair_api", status="network_error")


# ── Consensus & Validation ────────────────────────────────────────────────────

def compute_consensus(
    results: list[ScrapeResult],
    min_consensus: int = DEFAULT_MIN_CONSENSUS,
    variance_threshold: float = DEFAULT_VARIANCE_THRESHOLD
) -> Optional[ConsensusOdds]:
    """Compute consensus odds from multiple sources."""
    successful = [r for r in results if r.status == "success" and r.h2h]

    if len(successful) < min_consensus:
        return None

    # Compute mean odds
    homes = [r.h2h.home for r in successful if r.h2h.home]
    draws = [r.h2h.draw for r in successful if r.h2h.draw]
    aways = [r.h2h.away for r in successful if r.h2h.away]

    if not homes or not draws or not aways:
        return None

    mean_home = sum(homes) / len(homes)
    mean_draw = sum(draws) / len(draws)
    mean_away = sum(aways) / len(aways)

    # Check variance
    max_var_home = max(abs(h - mean_home) / mean_home for h in homes) if homes else 0
    max_var_draw = max(abs(d - mean_draw) / mean_draw for d in draws) if draws else 0
    max_var_away = max(abs(a - mean_away) / mean_away for a in aways) if aways else 0

    max_variance = max(max_var_home, max_var_draw, max_var_away)

    if max_variance > variance_threshold:
        return None

    # Confidence = (num sources / min consensus) clamped to [0, 1]
    confidence = min(len(successful) / min_consensus, 1.0)

    source_breakdown = {
        r.source: {
            "h2h": asdict(r.h2h) if r.h2h else None,
            "status": r.status
        }
        for r in results
    }

    return ConsensusOdds(
        match_id=f"synthetic_{datetime.now(timezone.utc).timestamp()}",
        confidence=confidence,
        consensus_odds={
            "h2h": {
                "home": round(mean_home, 2),
                "draw": round(mean_draw, 2),
                "away": round(mean_away, 2)
            }
        },
        source_breakdown=source_breakdown,
        validation={
            "consensus_sources": len(successful),
            "min_threshold": min_consensus,
            "max_variance": round(max_variance, 4),
            "passed": max_variance <= variance_threshold
        }
    )


def scrape_consensus_odds(
    home: str,
    away: str,
    league: str,
    min_consensus: int = DEFAULT_MIN_CONSENSUS,
    variance_threshold: float = DEFAULT_VARIANCE_THRESHOLD,
    quiet: bool = False,
    use_playwright: bool = True
) -> Optional[ConsensusOdds]:
    """Scrape live odds from multiple sources and compute consensus."""
    if not quiet:
        print(f"[oracle] Scraping consensus odds: {home} vs {away} ({league})")

    results: list[ScrapeResult] = []

    # Sources with an open circuit (CIRCUIT_BREAKER_THRESHOLD consecutive
    # failures this run) are skipped entirely — no thread spawned, no network
    # call, no wait for their timeout. See _circuit_is_open/_circuit_record.
    CIRCUIT_ELIGIBLE = {"betfair_api", "sofascore"}

    # Run scrapers in parallel
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {}
        if not _circuit_is_open("betfair_api"):
            futures[executor.submit(scrape_betfair_api, home, away, quiet)] = "betfair_api"
        if not _circuit_is_open("sofascore"):
            futures[executor.submit(scrape_sofascore, home, away, quiet)] = "sofascore"
        futures[executor.submit(scrape_betexplorer, home, away, quiet)] = "betexplorer"

        if use_playwright and HAS_PLAYWRIGHT:
            futures.update({
                executor.submit(scrape_flashscore, home, away, quiet): "flashscore",
            })

        for future in as_completed(futures, timeout=SCRAPE_TIMEOUT * 2):
            source_name = futures[future]
            try:
                result = future.result()
                results.append(result)
                if source_name in CIRCUIT_ELIGIBLE:
                    _circuit_record(source_name, result.status == "success", quiet)
            except Exception as e:
                if not quiet:
                    print(f"[executor] Error: {e}", file=sys.stderr)
                if source_name in CIRCUIT_ELIGIBLE:
                    _circuit_record(source_name, False, quiet)

    if not quiet:
        print(f"[oracle] Collected {len(results)} scrape results, {len([r for r in results if r.status == 'success'])} successful")

    consensus = compute_consensus(results, min_consensus, variance_threshold)

    if consensus:
        if not quiet:
            print(f"[oracle] Consensus achieved: {consensus.confidence:.2%} confidence")
        return consensus
    else:
        if not quiet:
            print(f"[oracle] No consensus (insufficient sources or variance too high)")
        return None


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Scrape live odds from multiple sources and compute consensus."
    )
    parser.add_argument("--match", help="Match ID (home_vs_away_league_date)")
    parser.add_argument("--fixtures", help="Path to fixtures file (.tmp/fixtures/today.txt)")
    parser.add_argument("--dry-run", action="store_true", help="Print without writing")
    parser.add_argument("--quiet", action="store_true", help="Suppress output")
    parser.add_argument("--no-playwright", action="store_true", help="Skip Playwright scrapers")
    parser.add_argument(
        "--min-consensus", type=int, default=DEFAULT_MIN_CONSENSUS,
        help=f"Minimum agreeing sources for consensus odds (default {DEFAULT_MIN_CONSENSUS})"
    )
    parser.add_argument(
        "--variance-threshold", type=float, default=DEFAULT_VARIANCE_THRESHOLD,
        help=f"Max allowed variance between sources, e.g. 0.025=2.5%% (default {DEFAULT_VARIANCE_THRESHOLD})"
    )
    args = parser.parse_args()

    if args.match:
        # Parse match ID
        parts = args.match.split("_")
        if len(parts) < 3:
            print(f"Invalid match ID: {args.match}", file=sys.stderr)
            sys.exit(1)

        home, away, league = parts[0], parts[1], "_".join(parts[2:])
        consensus = scrape_consensus_odds(
            home, away, league,
            min_consensus=args.min_consensus,
            variance_threshold=args.variance_threshold,
            quiet=args.quiet,
            use_playwright=not args.no_playwright
        )

        if consensus and not args.dry_run:
            output_path = ODDS_CACHE_DIR / f"{args.match}.json"
            output_path.write_text(json.dumps(consensus.to_dict(), indent=2))
            if not args.quiet:
                print(f"[oracle] Saved to {output_path}")
        elif consensus:
            print(json.dumps(consensus.to_dict(), indent=2))

    elif args.fixtures:
        # Load fixtures and scrape odds
        fixture_path = Path(args.fixtures)
        if not fixture_path.exists():
            print(f"Fixtures file not found: {fixture_path}", file=sys.stderr)
            sys.exit(1)

        lines = fixture_path.read_text().strip().split("\n")
        for line in lines:
            # Parse: "home vs away, league, 2026-06-07T15:00:00Z"
            match = re.match(r"(.+?)\s+vs\s+(.+?),\s+(.+?),\s+(.+)", line)
            if not match:
                continue

            home, away, league, kickoff = match.groups()
            consensus = scrape_consensus_odds(
                home, away, league,
                min_consensus=args.min_consensus,
                variance_threshold=args.variance_threshold,
                quiet=args.quiet,
                use_playwright=not args.no_playwright
            )

            if consensus and not args.dry_run:
                match_id = f"{home}_{away}_{league}_{kickoff[:10]}"
                output_path = ODDS_CACHE_DIR / f"{match_id}.json"
                output_path.write_text(json.dumps(consensus.to_dict(), indent=2))

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
