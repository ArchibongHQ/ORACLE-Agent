"""scrape_fixtures.py — populate .tmp/fixtures/today.txt from multiple sources.

Also writes .tmp/fixtures/sportybet_today.json (SportyBet event sidecar with
market counts) — consumed by packages/runtime/src/selectFixtures.ts to gate the
pre-analysis fixture selection.

Sources (in order):
  ESPN JSON API   — 16 ORACLE leagues, stdlib urllib, no key
  Sky Sports HTML — HTML-entity-encoded JSON, requires requests
  BBC Sport       — Playwright headless browser (client-side rendered)
  Flashscore      — Playwright headless browser
  LiveScore       — Playwright headless browser
  365Scores       — Playwright headless browser
  OneFootball     — Playwright headless browser
  BetExplorer     — Playwright headless browser
  SportyBet       — Playwright headless browser
  WhoScored       — Playwright headless browser (Cloudflare-blocked, returns [])

Usage:
    python tools/scrape_fixtures.py                   # scrape today (UTC)
    python tools/scrape_fixtures.py --date 2026-06-10 # specific date
    python tools/scrape_fixtures.py --dry-run          # print without writing
    python tools/scrape_fixtures.py --quiet            # suppress output
    python tools/scrape_fixtures.py --no-playwright    # skip all Playwright scrapers
"""
from __future__ import annotations

import argparse
import asyncio
import html
import json
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

try:
    import requests as _requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

try:
    from playwright.async_api import async_playwright, BrowserContext, Page
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

# ── Config ────────────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_CACHE = ROOT / ".tmp" / "fixtures" / "today.txt"
# SportyBet sidecar — consumed by packages/runtime/src/selectFixtures.ts to gate
# the pre-analysis fixture selection (membership + market depth).
SPORTYBET_SIDECAR = ROOT / ".tmp" / "fixtures" / "sportybet_today.json"

ESPN_LEAGUE_MAP: dict[str, str] = {
    "eng.1":            "Premier League",
    "eng.2":            "Championship",
    "esp.1":            "La Liga",
    "ger.1":            "Bundesliga",
    "ita.1":            "Serie A",
    "fra.1":            "Ligue 1",
    "ned.1":            "Eredivisie",
    "por.1":            "Primeira Liga",
    "bel.1":            "Belgian Pro League",
    "sco.1":            "Scottish Premiership",
    "uefa.champions":   "Champions League",
    "uefa.europa":      "Europa League",
    "uefa.europa.conf": "Conference League",
    "jpn.1":            "J League",
    "usa.1":            "MLS",
    "fifa.world":       "FIFA World Cup",
}

_SUFFIX_RE = re.compile(
    r"\b(fc|afc|sc|cf|ac|as|ss|ssc|sv|bk|if|cd|ud|fk|hfc|bsc|rsc|vfb|rb)\b"
)
_NONALNUM_RE = re.compile(r"[^a-z0-9\s]")
_WS_RE = re.compile(r"\s+")

# Country/team aliases for cross-source dedup now live in the shared module
# (audit M2-1) — TEAM_ALIASES is a superset of the old _COUNTRY_ALIASES and
# also canonicalises club-name variants across sources.
try:
    from lib.team_names import TEAM_ALIASES as _COUNTRY_ALIASES
except ImportError:  # repo root on sys.path instead of tools/
    from tools.lib.team_names import TEAM_ALIASES as _COUNTRY_ALIASES

# Women/U-age suffix patterns stripped before dedup
_WOMEN_RE = re.compile(r"\s+(women|w|ladies)$", re.IGNORECASE)
_AGE_RE   = re.compile(r"\s+u\d{2}$", re.IGNORECASE)

_CHROME_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

# ── Data class ────────────────────────────────────────────────────────────────

@dataclass
class Fixture:
    home: str
    away: str
    league: str
    kickoff_utc: str  # ISO-8601 UTC, e.g. "2026-06-07T15:00:00Z"

    def to_line(self) -> str:
        # Guard: collapse any newlines that slipped through source-level cleaning
        home   = " ".join(self.home.split())
        away   = " ".join(self.away.split())
        league = " ".join(self.league.split())
        return f"{home} vs {away}, {league}, {self.kickoff_utc}"


# ── Shared helpers ────────────────────────────────────────────────────────────

def normalise(name: str) -> str:
    s = name.lower().strip()
    # Canonicalise Women/W/Ladies → single "w" token (keeps gender in dedup key)
    s = _WOMEN_RE.sub(" w", s)
    # Strip U-age suffixes (U21/U19 etc — same match reported with and without)
    s = _AGE_RE.sub("", s)
    # Apply country aliases (with and without trailing " w")
    if s.endswith(" w"):
        base = s[:-2].strip()
        s = _COUNTRY_ALIASES.get(base, base) + " w"
    else:
        s = _COUNTRY_ALIASES.get(s, s)
    s = _SUFFIX_RE.sub("", s)
    s = _NONALNUM_RE.sub("", s)
    s = _WS_RE.sub(" ", s).strip()
    return s


_KNOWN_ACRONYMS = re.compile(
    r"\b(USL|UEFA|FIFA|NPL|GFA|MLS|USL|RFEF|AFC|CAF|CONMEBOL|CONCACAF|OFC|ASEAN|EAFF)\b",
    re.IGNORECASE,
)

def _clean_league(raw: str) -> str:
    """Sanitise a raw league string: collapse whitespace/newlines, strip junk prefixes."""
    s = re.sub(r"[\r\n\t]+", " ", raw)
    s = _WS_RE.sub(" ", s).strip()
    # Strip leading "- " artifact (BetExplorer league headers with missing parent)
    s = re.sub(r"^[-–]\s*", "", s).strip()
    # Title-case ALL-CAPS strings, then restore known acronyms to uppercase
    if s == s.upper() and len(s) > 3:
        s = s.title()
        s = _KNOWN_ACRONYMS.sub(lambda m: m.group().upper(), s)
    return s or "Football"


def dedup_key(home: str, away: str, kickoff_utc: str) -> str:
    return f"{normalise(home)}_vs_{normalise(away)}_{kickoff_utc[:10]}"


def _warn(msg: str) -> None:
    print(f"[scrape] WARN: {msg}", file=sys.stderr)


def _utc_today() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")


def _normalise_iso(ts: str) -> str:
    """Normalise various UTC timestamp formats to YYYY-MM-DDTHH:MM:SSZ."""
    ts = ts.strip()
    if ts.endswith("+00:00"):
        ts = ts[:-6] + "Z"
    if not ts.endswith("Z"):
        ts += "Z"
    # Trim sub-second precision
    ts = re.sub(r"\.\d+Z$", "Z", ts)
    return ts


def _cet_to_utc(time_str: str, date_str: str) -> Optional[str]:
    """Convert HH:MM CET/CEST (UTC+1 winter / UTC+2 summer) → UTC ISO-8601."""
    try:
        h, m = (int(x) for x in time_str.strip().split(":"))
        year, month, day = (int(x) for x in date_str.split("-"))
        offset = 2 if 4 <= month <= 10 else 1
        dt = datetime(year, month, day, h, m, tzinfo=timezone.utc) - timedelta(hours=offset)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, TypeError):
        return None


def _bst_to_utc(time_str: str, date_str: str) -> Optional[str]:
    """Convert HH:MM BST/GMT (UTC+1 Apr-Oct / UTC otherwise) → UTC ISO-8601."""
    try:
        h, m = (int(x) for x in time_str.strip().split(":"))
        year, month, day = (int(x) for x in date_str.split("-"))
        offset = 1 if 4 <= month <= 10 else 0
        dt = datetime(year, month, day, h, m, tzinfo=timezone.utc) - timedelta(hours=offset)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, TypeError):
        return None


def _wat_to_utc(time_str: str, date_str: str) -> Optional[str]:
    """Convert HH:MM WAT (UTC+1, no DST — West Africa Time) → UTC ISO-8601."""
    try:
        h, m = (int(x) for x in time_str.strip().split(":"))
        year, month, day = (int(x) for x in date_str.split("-"))
        dt = datetime(year, month, day, h, m, tzinfo=timezone.utc) - timedelta(hours=1)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, TypeError):
        return None


# ── ESPN scraper ──────────────────────────────────────────────────────────────

class ESPNScraper:
    BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/scoreboard"
    TIMEOUT = 15

    def fetch_league(self, slug: str, league_name: str, date_str: str) -> list[Fixture]:
        url = self.BASE.format(slug=slug) + f"?dates={date_str.replace('-', '')}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ORACLE/1.0"})
            with urllib.request.urlopen(req, timeout=self.TIMEOUT) as resp:
                data = json.loads(resp.read())
        except Exception as exc:
            _warn(f"ESPN {slug}: {exc}")
            return []

        fixtures: list[Fixture] = []
        for event in data.get("events", []):
            comps = event.get("competitions", [])
            if not comps:
                continue
            comp = comps[0]
            if comp.get("status", {}).get("type", {}).get("state") == "post":
                continue
            competitors = comp.get("competitors", [])
            home_name = away_name = None
            for c in competitors:
                name = c.get("team", {}).get("displayName", "")
                if c.get("homeAway") == "home":
                    home_name = name
                elif c.get("homeAway") == "away":
                    away_name = name
            if not home_name or not away_name:
                continue
            kickoff = event.get("date", "")
            if not kickoff:
                continue
            fixtures.append(Fixture(home=home_name, away=away_name,
                                    league=league_name,
                                    kickoff_utc=_normalise_iso(kickoff)))
        return fixtures

    def fetch_all(self, date_str: str) -> list[Fixture]:
        results: list[Fixture] = []
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {
                pool.submit(self.fetch_league, slug, league, date_str): slug
                for slug, league in ESPN_LEAGUE_MAP.items()
            }
            for fut in as_completed(futures):
                try:
                    results.extend(fut.result())
                except Exception as exc:
                    _warn(f"ESPN worker: {exc}")
        return results


# ── Sky Sports scraper ────────────────────────────────────────────────────────

class SkySportsScraper:
    URL = "https://www.skysports.com/football/fixtures"
    TIMEOUT = 20
    _DATE_RE = re.compile(r'"start"\s*:\s*\{[^}]*"date"\s*:\s*"([^"]+)"[^}]*"time"\s*:\s*"([^"]+)"')
    _COMP_RE = re.compile(r'"competition"\s*:\s*\{[^{]*"name"\s*:\s*\{[^{]*"full"\s*:\s*"([^"]+)"')
    _HOME_RE = re.compile(r'"home"\s*:\s*\{[^{]*"name"\s*:\s*\{[^{]*"full"\s*:\s*"([^"]+)"')
    _AWAY_RE = re.compile(r'"away"\s*:\s*\{[^{]*"name"\s*:\s*\{[^{]*"full"\s*:\s*"([^"]+)"')

    def fetch(self, date_str: str) -> list[Fixture]:
        if not HAS_REQUESTS:
            _warn("Sky Sports: requests not installed — skipping")
            return []
        try:
            resp = _requests.get(self.URL, headers={
                "User-Agent": _CHROME_UA,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-GB,en;q=0.9",
            }, timeout=self.TIMEOUT)
            resp.raise_for_status()
            body = html.unescape(resp.text)
        except Exception as exc:
            _warn(f"Sky Sports: {exc}")
            return []
        return self._parse(body, date_str)

    def _parse(self, body: str, date_str: str) -> list[Fixture]:
        fixtures: list[Fixture] = []
        for seg in re.split(r'"matchFixture"|"fixtureCard"', body)[1:]:
            chunk = seg[:2000]
            date_m = self._DATE_RE.search(chunk)
            comp_m = self._COMP_RE.search(chunk)
            home_m = self._HOME_RE.search(chunk)
            away_m = self._AWAY_RE.search(chunk)
            if not (date_m and home_m and away_m):
                continue
            raw_date, raw_time = date_m.group(1), date_m.group(2)
            comp = comp_m.group(1) if comp_m else "Football"
            kickoff = self._to_utc(raw_date, raw_time, date_str)
            if kickoff:
                fixtures.append(Fixture(home=home_m.group(1), away=away_m.group(1),
                                        league=comp, kickoff_utc=kickoff))
        return fixtures

    @staticmethod
    def _to_utc(date_human: str, time_str: str, ref_date: str) -> Optional[str]:
        clean = re.sub(r"(\d+)(st|nd|rd|th)", r"\1", date_human)
        m = re.search(r"(\d+)\s+(\w+)", clean)
        if not m:
            return None
        day = int(m.group(1))
        month_map = {"january":1,"february":2,"march":3,"april":4,"may":5,"june":6,
                     "july":7,"august":8,"september":9,"october":10,"november":11,"december":12}
        month = month_map.get(m.group(2).lower())
        if not month:
            return None
        try:
            h, mn = (int(x) for x in time_str.split(":"))
        except ValueError:
            return None
        return _bst_to_utc(f"{h:02d}:{mn:02d}", f"{ref_date[:4]}-{month:02d}-{day:02d}")


# ── BBC Sport scraper (Playwright) ───────────────────────────────────────────
# BBC Sport loads fixtures entirely client-side; requests cannot access the data.

class BBCSportScraper:
    URL = "https://www.bbc.co.uk/sport/football/scores-fixtures/{date}"

    async def fetch(self, ctx: "BrowserContext", date_str: str) -> list[Fixture]:
        page = await ctx.new_page()
        fixtures: list[Fixture] = []
        try:
            await page.goto(self.URL.format(date=date_str),
                            wait_until="domcontentloaded", timeout=30_000)
            await _dismiss_consent(page)
            try:
                await page.wait_for_selector('[data-testid*="fixture"]', timeout=15_000)
            except Exception:
                return fixtures
            await page.wait_for_timeout(500)

            # BBC Sport adds screen-reader spans: "Mexico versus South Africa kick off 20:00"
            # Walk HeaderWrapper sections to associate competition names with matches.
            raw: list[dict] = await page.evaluate("""
                () => {
                    const out = [];
                    for (const wrapper of document.querySelectorAll('[class*="HeaderWrapper"]')) {
                        const h2 = wrapper.querySelector('h2');
                        const h3 = wrapper.querySelector('h3');
                        const league = ((h2 ? h2.innerText.trim() : '') +
                                        (h3 ? ' - ' + h3.innerText.trim() : '')).trim() || 'Football';
                        for (const li of wrapper.querySelectorAll('li[class*="HeadToHead"]')) {
                            for (const span of li.querySelectorAll('[class*="VisuallyHidden"]')) {
                                const m = span.textContent.match(
                                    /(.+?) versus (.+?) kick off (\\d{1,2}:\\d{2})/
                                );
                                if (m) {
                                    out.push({home: m[1].trim(), away: m[2].trim(),
                                              time: m[3], league});
                                    break;
                                }
                            }
                        }
                    }
                    return out;
                }
            """)
            for item in raw:
                kickoff = _bst_to_utc(item["time"], date_str)
                if kickoff:
                    fixtures.append(Fixture(home=item["home"], away=item["away"],
                                             league=item["league"], kickoff_utc=kickoff))
        except Exception as exc:
            _warn(f"BBC Sport: {exc}")
        finally:
            await page.close()
        return fixtures


# ── JSON fixture collector (recursive) ───────────────────────────────────────

def _collect_fixtures(node: object, out: list[dict], depth: int = 0) -> None:
    """Walk arbitrary JSON, collecting dicts that look like fixture objects."""
    if depth > 12:
        return
    if isinstance(node, dict):
        if ("homeTeam" in node or "home" in node) and ("awayTeam" in node or "away" in node):
            out.append(node)
            return
        for v in node.values():
            _collect_fixtures(v, out, depth + 1)
    elif isinstance(node, list):
        for item in node:
            _collect_fixtures(item, out, depth + 1)


# ── Playwright helpers ────────────────────────────────────────────────────────

_CONSENT_SELECTORS = [
    "#onetrust-accept-btn-handler",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "button:has-text('Accept all')",
    "button:has-text('Accept All')",
    "button:has-text('I Accept')",
    "button:has-text('Accept & Continue')",
    "button:has-text('Agree')",
    ".cc-allow",
    "#cookie-accept",
    "[data-testid='accept-button']",
    "[aria-label='Accept all cookies']",
]


async def _dismiss_consent(page: "Page") -> None:
    for sel in _CONSENT_SELECTORS:
        try:
            loc = page.locator(sel).first
            if await loc.is_visible(timeout=1500):
                await loc.click()
                await page.wait_for_timeout(600)
                return
        except Exception:
            pass


async def _text(el, default: str = "") -> str:
    try:
        return (await el.inner_text()).strip()
    except Exception:
        return default


async def _attr(el, name: str, default: str = "") -> str:
    try:
        return (await el.get_attribute(name) or default).strip()
    except Exception:
        return default


# ── Flashscore scraper ────────────────────────────────────────────────────────

class FlashscoreScraper:
    URL = "https://www.flashscore.com/football/"

    async def fetch(self, ctx: "BrowserContext", date_str: str) -> list[Fixture]:
        page = await ctx.new_page()
        fixtures: list[Fixture] = []
        try:
            await page.goto(self.URL, wait_until="domcontentloaded", timeout=30_000)
            await _dismiss_consent(page)
            await page.wait_for_selector(".event__match--scheduled", timeout=20_000)
            await page.wait_for_timeout(800)

            # Scheduled matches are siblings of .headerLeague__wrapper inside div.sportName.
            # Walk the DOM in JS for efficiency.
            raw_items: list[dict] = await page.evaluate("""
                () => {
                    const out = [];
                    for (const sn of document.querySelectorAll('div.sportName')) {
                        let league = 'Football';
                        for (const child of sn.children) {
                            if (child.classList.contains('headerLeague__wrapper')) {
                                const hdr = child.querySelector('[data-testid="wcl-headerLeague"]');
                                if (hdr) league = hdr.innerText.trim();
                            } else if (child.classList.contains('event__match') &&
                                       child.classList.contains('event__match--scheduled')) {
                                const link = child.querySelector('.eventRowLink');
                                const timeEl = child.querySelector('.event__time');
                                const label = link ? link.getAttribute('aria-label') : '';
                                const timeStr = timeEl ? timeEl.innerText.trim() : '';
                                if (label && timeStr) out.push({label, timeStr, league});
                            }
                        }
                    }
                    return out;
                }
            """)
            for item in raw_items:
                label: str = item.get("label", "")
                time_raw: str = item.get("timeStr", "")
                league_raw: str = re.split(r"\s*/\s*|\s+[A-Z]{2,}:", item.get("league", "Football"))[0].strip() or "Football"
                league = _clean_league(league_raw)
                time_m = re.search(r"\d{1,2}:\d{2}", time_raw)
                if not label or not time_m:
                    continue
                parts = label.split(" - ", 1)
                if len(parts) != 2:
                    continue
                kickoff = _cet_to_utc(time_m.group(), date_str)
                if kickoff:
                    fixtures.append(Fixture(home=parts[0].strip(), away=parts[1].strip(),
                                             league=league, kickoff_utc=kickoff))
        except Exception as exc:
            _warn(f"Flashscore: {exc}")
        finally:
            await page.close()
        return fixtures


# ── LiveScore scraper (direct API — no Playwright) ───────────────────────────

class LiveScoreScraper:
    """Uses LiveScore's internal REST API directly — no browser needed."""
    API = ("https://prod-cdn-mev-api.livescore.com/api/v2/date/soccer"
           "/{date}/1?countryCode=NG&paging=false&locale=en")
    TIMEOUT = 15

    def fetch(self, date_str: str) -> list[Fixture]:
        if not HAS_REQUESTS:
            _warn("LiveScore: requests not installed — skipping")
            return []
        date_compact = date_str.replace("-", "")
        try:
            resp = _requests.get(
                self.API.format(date=date_compact),
                headers={"User-Agent": _CHROME_UA, "Referer": "https://www.livescore.com/"},
                timeout=self.TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            _warn(f"LiveScore: {exc}")
            return []

        fixtures: list[Fixture] = []
        for section in data.get("Sctns", []):
            stage = section.get("Ts", {})
            league = _clean_league(stage.get("Snm", "") or stage.get("Cnm", "") or "Football")
            for ev in stage.get("Evs", []):
                if ev.get("Eps") != "NS":  # only not-started
                    continue
                t1 = (ev.get("T1") or [{}])[0]
                t2 = (ev.get("T2") or [{}])[0]
                home = t1.get("Nm", "")
                away = t2.get("Nm", "")
                unix_ts = ev.get("Est")
                if not home or not away or not unix_ts:
                    continue
                try:
                    kickoff = datetime.fromtimestamp(unix_ts, tz=timezone.utc).strftime(
                        "%Y-%m-%dT%H:%M:%SZ"
                    )
                    fixtures.append(Fixture(home=home, away=away, league=league,
                                             kickoff_utc=kickoff))
                except Exception:
                    pass
        return fixtures


# ── 365Scores scraper ─────────────────────────────────────────────────────────

class Scores365Scraper:
    URL = "https://www.365scores.com/football"

    async def fetch(self, ctx: "BrowserContext", date_str: str) -> list[Fixture]:
        page = await ctx.new_page()
        fixtures: list[Fixture] = []
        try:
            await page.goto(self.URL, wait_until="domcontentloaded", timeout=30_000)
            await _dismiss_consent(page)
            await page.wait_for_timeout(3000)

            # 365scores embeds game data in window.__INITIAL_STATE__ or via JSON-LD
            state = await page.evaluate("() => JSON.stringify(window.__INITIAL_STATE__ || {})")
            data = json.loads(state) if state != "{}" else {}
            if data:
                items: list[dict] = []
                _collect_fixtures(data, items, 0)
                for entry in items:
                    home = entry.get("homeCompetitor", {}).get("name", "")
                    away = entry.get("awayCompetitor", {}).get("name", "")
                    ts = entry.get("startTime") or entry.get("startDate") or ""
                    league = entry.get("competition", {}).get("name", "Football")
                    if home and away and ts:
                        try:
                            fixtures.append(Fixture(home=home, away=away, league=league,
                                                     kickoff_utc=_normalise_iso(ts)))
                        except Exception:
                            pass
                if fixtures:
                    return fixtures

            # DOM fallback
            cards = await page.query_selector_all('[class*="game-"], [class*="Game"], [data-testid*="game"]')
            for card in cards:
                teams = await card.query_selector_all('[class*="competitor-name"], [class*="team"]')
                time_el = await card.query_selector('[class*="game-time"], [class*="GameTime"]')
                if len(teams) >= 2:
                    home = await _text(teams[0])
                    away = await _text(teams[1])
                    time_str = await _text(time_el) if time_el else ""
                    if home and away and re.match(r"^\d{1,2}:\d{2}$", time_str):
                        kickoff = _cet_to_utc(time_str, date_str)
                        if kickoff:
                            fixtures.append(Fixture(home=home, away=away, league="Football",
                                                     kickoff_utc=kickoff))
        except Exception as exc:
            _warn(f"365Scores: {exc}")
        finally:
            await page.close()
        return fixtures


# ── OneFootball scraper ───────────────────────────────────────────────────────

class OneFootballScraper:
    URL = "https://onefootball.com/en/competition/premier-league-8/fixtures"

    async def fetch(self, ctx: "BrowserContext", date_str: str) -> list[Fixture]:
        page = await ctx.new_page()
        fixtures: list[Fixture] = []
        try:
            await page.goto(self.URL, wait_until="domcontentloaded", timeout=45_000)
            await _dismiss_consent(page)
            await page.wait_for_timeout(3000)

            # OneFootball uses Next.js
            raw = await page.evaluate("""
                () => {
                    const nd = document.getElementById('__NEXT_DATA__');
                    return nd ? nd.textContent : '';
                }
            """)
            if raw:
                data = json.loads(raw)
                items: list[dict] = []
                _collect_fixtures(data, items, 0)
                for entry in items:
                    home = entry.get("homeTeam", {})
                    away = entry.get("awayTeam", {})
                    h = home.get("name", "") if isinstance(home, dict) else ""
                    a = away.get("name", "") if isinstance(away, dict) else ""
                    ts = entry.get("kickoff") or entry.get("startTime") or entry.get("date") or ""
                    if h and a and ts:
                        try:
                            fixtures.append(Fixture(home=h, away=a, league="Football",
                                                     kickoff_utc=_normalise_iso(ts)))
                        except Exception:
                            pass

            # DOM fallback — match cards
            if not fixtures:
                cards = await page.query_selector_all('[class*="MatchCard"], [class*="match-card"]')
                for card in cards:
                    teams = await card.query_selector_all('[class*="team-name"], [class*="TeamName"]')
                    time_el = await card.query_selector('[class*="kickoff"], [class*="time"]')
                    if len(teams) >= 2:
                        home = await _text(teams[0])
                        away = await _text(teams[1])
                        time_str = await _text(time_el) if time_el else ""
                        if home and away and re.match(r"^\d{1,2}:\d{2}$", time_str):
                            kickoff = _cet_to_utc(time_str, date_str)
                            if kickoff:
                                fixtures.append(Fixture(home=home, away=away, league="Football",
                                                         kickoff_utc=kickoff))
        except Exception as exc:
            _warn(f"OneFootball: {exc}")
        finally:
            await page.close()
        return fixtures


# ── BetExplorer scraper ───────────────────────────────────────────────────────

class BetExplorerScraper:
    def _url(self, date_str: str) -> str:
        y, m, d = date_str.split("-")
        return f"https://www.betexplorer.com/soccer/?yr={y}&mo={m}&dy={d}"

    async def fetch(self, ctx: "BrowserContext", date_str: str) -> list[Fixture]:
        page = await ctx.new_page()
        fixtures: list[Fixture] = []
        try:
            await page.goto(self._url(date_str), wait_until="domcontentloaded", timeout=30_000)
            await _dismiss_consent(page)
            await page.wait_for_selector("table.table-main tbody tr", timeout=15_000)

            rows = await page.query_selector_all("table.table-main tbody tr")
            current_league = "Football"
            for row in rows:
                cls = await _attr(row, "class")
                if "js-tournament" in cls:
                    # League header: th > a.table-main__tournament
                    league_el = await row.query_selector("a.table-main__tournament")
                    if league_el:
                        raw = await _text(league_el)
                        # "Asia: ASEAN Championship U19" → strip "Region: " prefix
                        stripped = re.sub(r"^[^:]+:\s*", "", raw).strip() or raw.strip()
                        current_league = _clean_league(stripped)
                    continue

                # Match row: td > span.table-main__time + a (match name)
                time_el = await row.query_selector("td span.table-main__time")
                match_el = await row.query_selector("td a[href*='/football/']")
                if not time_el or not match_el:
                    continue
                time_str = await _text(time_el)
                match_name = await _text(match_el)
                if not re.match(r"^\d{1,2}:\d{2}$", time_str):
                    continue
                parts = match_name.split(" - ", 1)
                if len(parts) != 2:
                    continue
                kickoff = _cet_to_utc(time_str, date_str)
                if kickoff:
                    fixtures.append(Fixture(home=parts[0].strip(), away=parts[1].strip(),
                                             league=current_league, kickoff_utc=kickoff))
        except Exception as exc:
            _warn(f"BetExplorer: {exc}")
        finally:
            await page.close()
        return fixtures


# ── SportyBet scraper ─────────────────────────────────────────────────────────
# Uses SportyBet's internal pcUpcomingEvents API, intercepted via Playwright.
# Timestamps are UTC Unix ms — no timezone conversion needed.
# todayGames=true limits to today; pageSize=100 with pagination covers all matches.

def _sportybet_event_to_record(ev: dict, league: str) -> Optional[dict]:
    """Map a pcUpcomingEvents event to a sidecar record, or None if malformed."""
    home = ev.get("homeTeamName", "")
    away = ev.get("awayTeamName", "")
    ts_ms = ev.get("estimateStartTime")
    if not (home and away and ts_ms):
        return None
    try:
        kickoff = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
    except Exception:
        return None
    # marketCount is remote-controlled web content — a bad value must not
    # abort the parse loop, just degrade to 0 for this event
    try:
        market_count = max(0, int(ev.get("totalMarketSize") or len(ev.get("markets") or [])))
    except (TypeError, ValueError):
        market_count = 0
    return {
        "eventId": str(ev.get("eventId", "")),
        "home": home,
        "away": away,
        "league": league,
        "kickoff_utc": kickoff,
        "marketCount": market_count,
    }


# ── SportyBet per-fixture enrichment (sidecar v2) ────────────────────────────
# Plain anonymous HTTP — no Playwright.  All endpoints verified in spike
# (see .tmp/sportybet_api_capture/FINDINGS.md).

_SB_HDR = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0"}
_SB_EVENT_URL = "https://www.sportybet.com/api/ng/factsCenter/event?eventId={eid}&productId=3"
_SB_GISMO = "https://stats.fn.sportradar.com/sportybet/en/Etc:UTC/gismo/{q}"
_SB_PACE = 0.15  # seconds between requests within one fixture's fetch

# Rolling team-xG prior (built by tools/build_xg_table.py). Optional — absent for
# leagues outside Understat's top-5 coverage; the TS scorer falls back to the
# sidecar goals-average proxy when a team is missing.
_XG_TABLE_PATH = Path(".tmp/xg/team_xg_table.json")


def _load_xg_table() -> dict[str, dict]:
    """Load the team-xG prior table, keyed by normalise()'d team name. Missing or
    corrupt file → empty dict (xg blocks degrade to null, never fatal)."""
    try:
        data = json.loads(_XG_TABLE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _xg_for(table: dict[str, dict], team: str) -> Optional[dict]:
    """Look up a team's {xgf, xga} prior by normalised name. None when uncovered."""
    rec = table.get(normalise(team))
    if not rec:
        return None
    xgf, xga = rec.get("xgf"), rec.get("xga")
    if not isinstance(xgf, (int, float)) or not isinstance(xga, (int, float)):
        return None
    return {"xgf": float(xgf), "xga": float(xga)}


def _sb_get(url: str) -> Optional[dict]:
    try:
        req = urllib.request.Request(url, headers=_SB_HDR)
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except Exception:
        return None


def _gismo_doc(query: str) -> Optional[dict]:
    """Return first doc's data dict from a gismo response, or None on any failure."""
    j = _sb_get(_SB_GISMO.format(q=query))
    if not j:
        return None
    docs = j.get("doc", [])
    if not docs:
        return None
    doc = docs[0]
    if doc.get("event") == "exception":
        return None
    return doc.get("data")


def _parse_all_markets(markets_data: dict) -> list[dict]:
    """Generic capture of EVERY market SportyBet returns for a fixture (a live
    fixture carries 900+ markets — machine-verified 2026-06-23 against
    sr:match:66457034, Portugal vs Uzbekistan: 951 markets, including named
    exotics like "Home To Win Either Half" (id 50), "Both Halves Under X.5"
    (id 59), "1st Half - Over/Under" (id 68), "2nd Half - Total" (id 90)).

    Hand-picking market-by-market (the old _parse_odds approach) cannot keep
    up with SportyBet's catalogue or its own additions over time, so this
    captures the full markets[] array in a stable generic shape instead. Each
    outcome's `desc` field is already a human-readable label (e.g. "Over 1.5",
    "Yes", "Under 1") straight from the API — no separate id→label table needed.
    Cheap: ~900 small dicts is a few hundred KB of JSON per fixture, written
    once per scrape.
    """
    out: list[dict] = []
    for market in markets_data.get("markets") or []:
        outcomes = [
            {"id": str(o.get("id", "")), "desc": o.get("desc"), "odds": o.get("odds")}
            for o in market.get("outcomes") or []
            if o.get("odds")
        ]
        if not outcomes:
            continue
        out.append({
            "id": str(market.get("id", "")),
            "name": market.get("name"),
            "desc": market.get("desc"),
            "group": market.get("group"),
            "specifier": market.get("specifier"),
            "outcomes": outcomes,
        })
    return out


def _parse_odds(markets_data: dict) -> dict:
    """Extract 1X2, OU1.5/2.5/3.5, team-totals, BTTS, DC, DNB, AH odds from
    factsCenter/event markets.

    Market IDs (machine-verified live 2026-06-15 against sr:match:67126172):
      1=1X2, 18=Over/Under (total goals), 19=Home O/U, 20=Away O/U,
      10=Double Chance, 29=BTTS (name "GG/NG"), 11=Draw No Bet, 16=Asian Handicap.
    The goals line lives in market["specifier"] as "total=1.5"/"2.5"/"3.5" — NOT in
    the outcome's handicap/line/name. Over/Under outcomes: id 12 = Over (desc
    "Over <line>"), id 13 = Under. Half-time / 1st-/2nd-half variants carry distinct
    ids and are handled by the typed accessors below (_parse_half_markets), plus
    captured unconditionally (with everything else) by _parse_all_markets.
    """
    result: dict[str, Optional[dict]] = {
        "1x2": None, "ou15": None, "ou25": None, "ou35": None,
        "tt_home_05": None, "tt_away_05": None,
        "btts": None, "dc": None, "dnb": None, "ah": None,
    }

    def _ou_line_key(spec: Optional[str]) -> Optional[str]:
        """Map a 'total=<line>' specifier to the ou15/ou25/ou35 result key."""
        if not spec:
            return None
        line = spec.split("total=", 1)[-1].strip() if "total=" in spec else ""
        return {"1.5": "ou15", "2.5": "ou25", "3.5": "ou35"}.get(line)

    def _fill_over_under(market: dict, target: dict) -> None:
        """Populate {over,under} from an O/U market's outcomes (id 12=over, 13=under)."""
        for o in market.get("outcomes") or []:
            odds_val = o.get("odds")
            if not odds_val:
                continue
            oid = str(o.get("id", ""))
            desc = (o.get("desc") or o.get("name") or "").lower()
            if oid == "12" or desc.startswith("over"):
                target["over"] = odds_val
            elif oid == "13" or desc.startswith("under"):
                target["under"] = odds_val

    for market in markets_data.get("markets") or []:
        mid = str(market.get("id", ""))
        name = (market.get("name") or "").lower()
        spec = market.get("specifier")
        outcomes = {str(o.get("id", "")): o.get("odds") for o in market.get("outcomes") or []}

        if mid == "1":
            # outcomes: 1=home, 2=draw, 3=away
            result["1x2"] = {
                "home": outcomes.get("1"), "draw": outcomes.get("2"), "away": outcomes.get("3"),
            }
        elif mid == "18":
            # Total-goals Over/Under — one market per line, line in the specifier.
            key = _ou_line_key(spec)
            if key:
                result[key] = result.get(key) or {}
                _fill_over_under(market, result[key])  # type: ignore[arg-type]
        elif mid == "19" and spec == "total=0.5":
            # Home team total Over/Under 0.5 → engine label "Home Total Over 0.5".
            result["tt_home_05"] = result.get("tt_home_05") or {}
            _fill_over_under(market, result["tt_home_05"])  # type: ignore[arg-type]
        elif mid == "20" and spec == "total=0.5":
            # Away team total Over/Under 0.5 → engine label "Away Total Over 0.5".
            result["tt_away_05"] = result.get("tt_away_05") or {}
            _fill_over_under(market, result["tt_away_05"])  # type: ignore[arg-type]
        elif mid == "10":
            # Double Chance: outcomes 9=1X, 10=12, 11=X2.
            result["dc"] = {
                "1x": outcomes.get("9"), "12": outcomes.get("10"), "x2": outcomes.get("11"),
            }
        elif mid == "16" or "asian handicap" in name:
            # Pick the closest-to-zero AH line for home and away
            best_line: Optional[float] = None
            best_home: Optional[str] = None
            best_away: Optional[str] = None
            outcomes_list = market.get("outcomes") or []
            # Group by handicap and find the home/away pair with smallest |handicap|
            lines: dict[float, dict] = {}
            for o in outcomes_list:
                raw_h = o.get("handicap") or o.get("line")
                if raw_h is None:
                    continue
                try:
                    h_val = float(raw_h)
                except (TypeError, ValueError):
                    continue
                otype = (o.get("name") or o.get("type") or "").lower()
                odds_val = o.get("odds")
                if not odds_val:
                    continue
                if h_val not in lines:
                    lines[h_val] = {}
                if "home" in otype or o.get("id") in (1, "1"):
                    lines[h_val]["home"] = odds_val
                elif "away" in otype or o.get("id") in (2, "2"):
                    lines[h_val]["away"] = odds_val
            if lines:
                best_line = min(lines.keys(), key=lambda x: abs(x))
                best_pair = lines[best_line]
                if best_pair.get("home") and best_pair.get("away"):
                    result["ah"] = {
                        "line": best_line,
                        "home": best_pair["home"],
                        "away": best_pair["away"],
                    }
        elif mid == "29" or "both teams" in name or "btts" in name:
            result["btts"] = {"yes": outcomes.get("74"), "no": outcomes.get("76")}
        elif mid == "11" or "draw no bet" in name:
            result["dnb"] = {"home": outcomes.get("5"), "away": outcomes.get("6")}

    return result


def _parse_half_markets(markets_data: dict) -> dict:
    """Typed accessors for the named half-related exotics on top of the generic
    _parse_all_markets capture — these are the markets users actually mention by
    name (Win Either Half, half-time/2nd-half O/U, Both Halves Over/Under) and
    that the booking layer (apps/booking/src/marketMap.ts) already recognises
    by label, so the sidecar should carry their odds too instead of only the
    market name. IDs verified live 2026-06-23 against sr:match:66457034:
      50=Home To Win Either Half, 51=Away To Win Either Half (outcomes 74=Yes/76=No)
      58=Both Halves Over X.5, 59=Both Halves Under X.5 (outcomes 74=Yes/76=No, line in specifier)
      68=1st Half O/U, 90=2nd Half - Total (outcomes 12=Over/13=Under, line in specifier)
      69=1st Half Home O/U, 70=1st Half Away O/U, 91=2nd Half Home Total, 92=2nd Half Away Total
    """
    result: dict[str, Optional[dict]] = {
        "win_either_half": None, "both_halves_ou": None,
        "ht_ou": {}, "h2_ou": {},
        "ht_team_ou": {}, "h2_team_ou": {},
    }

    def _yes_no(outcomes: dict) -> dict:
        return {"yes": outcomes.get("74"), "no": outcomes.get("76")}

    def _over_under(outcomes: dict) -> dict:
        return {"over": outcomes.get("12"), "under": outcomes.get("13")}

    def _line_key(spec: Optional[str]) -> Optional[str]:
        if not spec or "total=" not in spec:
            return None
        return spec.split("total=", 1)[-1].strip()

    win_either_half: dict[str, Optional[dict]] = {}
    for market in markets_data.get("markets") or []:
        mid = str(market.get("id", ""))
        spec = market.get("specifier")
        outcomes = {str(o.get("id", "")): o.get("odds") for o in market.get("outcomes") or [] if o.get("odds")}
        if not outcomes:
            continue

        if mid == "50":
            win_either_half["home"] = _yes_no(outcomes)
        elif mid == "51":
            win_either_half["away"] = _yes_no(outcomes)
        elif mid in ("58", "59"):
            line = _line_key(spec)
            if line:
                result["both_halves_ou"] = result["both_halves_ou"] or {}
                result["both_halves_ou"][line] = result["both_halves_ou"].get(line) or {}  # type: ignore[union-attr]
                result["both_halves_ou"][line]["over" if mid == "58" else "under"] = _yes_no(outcomes).get("yes")  # type: ignore[index]
        elif mid == "68":
            line = _line_key(spec)
            if line:
                result["ht_ou"][line] = _over_under(outcomes)  # type: ignore[index]
        elif mid == "90":
            line = _line_key(spec)
            if line:
                result["h2_ou"][line] = _over_under(outcomes)  # type: ignore[index]
        elif mid in ("69", "70"):
            line = _line_key(spec)
            if line:
                side = "home" if mid == "69" else "away"
                result["ht_team_ou"].setdefault(side, {})[line] = _over_under(outcomes)  # type: ignore[index]
        elif mid in ("91", "92"):
            line = _line_key(spec)
            if line:
                side = "home" if mid == "91" else "away"
                result["h2_team_ou"].setdefault(side, {})[line] = _over_under(outcomes)  # type: ignore[index]

    if win_either_half:
        result["win_either_half"] = win_either_half

    return result


def _parse_form(form_data: dict) -> Optional[dict]:
    """Extract last-5 W/D/L from stats_match_form response.

    Live gismo shape: teams.{home,away} = {team:{name,…}, form:[{type:"W"},…]}.
    `form` is a list of recent-results objects (most-recent-first), not a string.
    """
    if not form_data:
        return None
    teams = form_data.get("teams", {})
    out: dict[str, dict] = {}
    for side in ("home", "away"):
        team = teams.get(side) or {}
        form_list = team.get("form") or []
        # Newest-first → take the most recent 5, normalise to W/D/L letters.
        letters = [
            (f.get("type") or "").upper()
            for f in form_list
            if isinstance(f, dict) and (f.get("type") or "").upper() in ("W", "D", "L")
        ][:5]
        name = (team.get("team") or {}).get("name") or team.get("name")
        # Current streak, derived from last5 (most-recent-first): length of the
        # leading run of identical results. Signed: +N win streak, -N loss streak,
        # 0 when the most recent match was a draw (no streak direction).
        streak = 0
        if letters:
            if letters[0] == "D":
                streak = 0
            else:
                run = 1
                for ch in letters[1:]:
                    if ch == letters[0]:
                        run += 1
                    else:
                        break
                streak = run if letters[0] == "W" else -run
        out[side] = {
            "name": name,
            "last5": "".join(letters),
            "w": letters.count("W"),
            "d": letters.count("D"),
            "l": letters.count("L"),
            "streak": streak,
        }
    return out or None


def _parse_standings(tables_data: dict, home_id: Optional[int], away_id: Optional[int]) -> Optional[dict]:
    """Extract league position, points, and goals for both teams from stats_season_tables.

    Live gismo shape: tables[0].tablerows[] where each row has team:{_id,…} and
    totals fields pointsTotal / total (matches played) / goalsForTotal /
    goalsAgainstTotal. (The old tot_pts/tot_sp/_id schema was never returned.)
    """
    if not tables_data:
        return None
    rows = (tables_data.get("tables") or [{}])[0].get("tablerows", [])
    result: dict[str, Optional[dict]] = {}
    for row in rows:
        tid = (row.get("team") or {}).get("_id")
        # Guard against None ids: a malformed row with no team._id must not match
        # when home_id/away_id are themselves None (mirrors _parse_goals).
        if tid is not None and tid in (home_id, away_id):
            label = "home" if tid == home_id else "away"
            result[label] = {
                "pos": row.get("pos"),
                "points": row.get("pointsTotal"),
                "played": row.get("total"),
                "gf": row.get("goalsForTotal"),
                "ga": row.get("goalsAgainstTotal"),
            }
        if len(result) == 2:
            break
    return result or None


def _parse_goals(goals_data: dict, home_id: Optional[int], away_id: Optional[int]) -> Optional[dict]:
    """Extract per-team avg goals scored/conceded from stats_season_goals.

    Live gismo shape: teams is keyed by array index ("0","1",…) — NOT by team id —
    and each entry holds team:{_id,…}, scoredsum, concededsum, matches. The per-game
    average is derived (scoredsum / matches). (The old avgGoalsFor/Against fields and
    id-keyed lookup were never returned by this endpoint.)
    """
    if not goals_data:
        return None
    raw = goals_data.get("teams", {})
    entries = (
        list(raw.values()) if isinstance(raw, dict) else (raw if isinstance(raw, list) else [])
    )
    by_id: dict[int, dict] = {}
    for e in entries:
        if not isinstance(e, dict):
            continue
        tid = (e.get("team") or {}).get("_id")
        if isinstance(tid, int):
            by_id[tid] = e
    result: dict[str, Optional[dict]] = {}
    for label, tid in (("home", home_id), ("away", away_id)):
        entry = by_id.get(tid) if tid is not None else None
        if not entry:
            continue
        played = entry.get("matches")
        scored = entry.get("scoredsum")
        conceded = entry.get("concededsum")
        if isinstance(played, int) and played > 0:
            result[label] = {
                "avg_scored": round(scored / played, 3) if isinstance(scored, (int, float)) else None,
                "avg_conceded": round(conceded / played, 3) if isinstance(conceded, (int, float)) else None,
            }
    return result or None


def _parse_h2h(versus_data: dict) -> Optional[dict]:
    """Summarize H2H from stats_team_versusrecent — empty arrays are common for low-tier.

    Live gismo shape: matches[].result is an object {home, away, winner} where
    winner ∈ home/away/draw (relative to that match's home/away team), NOT a
    string status. We count by winner. The home/away split here is per-historical-
    match, so it reflects head-to-head dominance, not the current fixture's sides.
    """
    if not versus_data:
        return None
    matches = versus_data.get("matches") or []
    if not matches:
        return None
    summary = {"total": len(matches), "home_wins": 0, "away_wins": 0, "draws": 0}
    for m in matches[:10]:
        res = m.get("result")
        # Defend against the legacy string-result shape: a bare string has no
        # .get(), so only an object carries a countable winner.
        winner = (res.get("winner") or "").lower() if isinstance(res, dict) else ""
        if winner == "home":
            summary["home_wins"] += 1
        elif winner == "away":
            summary["away_wins"] += 1
        elif winner == "draw":
            summary["draws"] += 1
    return summary


def _parse_overunder(ou_data: dict, home_uid: Optional[int], away_uid: Optional[int]) -> Optional[dict]:
    """Extract season over-1.5/2.5/3.5 percentages per team from stats_season_overunder.

    Live gismo shape: stats is keyed by the team's "uniqueteam" id (`team.uid`),
    NOT the "team" doctype `_id` that match_info/stats_season_tables/stats_season_goals/
    stats_season_fixtures all key by (verified live 2026-06-20 — Czechia: _id=9509,
    uid=4714; both ids coexist on the same match_info team object, callers must pass
    uid here). Each entry's `total.ft["<line>"]` holds {over, under} match counts
    across the season (both venues combined). Percentage is over/(over+under);
    a line with zero matches recorded is omitted rather than reported as 0%.
    """
    if not ou_data:
        return None
    stats = ou_data.get("stats", {})
    if not isinstance(stats, dict):
        return None
    result: dict[str, Optional[dict]] = {}
    for label, tid in (("home", home_uid), ("away", away_uid)):
        entry = stats.get(str(tid)) if tid is not None else None
        if not isinstance(entry, dict):
            continue
        lines = ((entry.get("total") or {}).get("ft")) or {}
        pct: dict[str, float] = {}
        for line_key, out_key in (("1.5", "over15_pct"), ("2.5", "over25_pct"), ("3.5", "over35_pct")):
            rec = lines.get(line_key)
            if not isinstance(rec, dict):
                continue
            over, under = rec.get("over"), rec.get("under")
            if isinstance(over, (int, float)) and isinstance(under, (int, float)) and (over + under) > 0:
                pct[out_key] = round(over / (over + under), 3)
        if pct:
            result[label] = pct
    return result or None


def _parse_rest_congestion(
    fixtures_data: dict, home_id: Optional[int], away_id: Optional[int], kickoff_uts: Optional[int]
) -> Optional[dict]:
    """Derive rest days (since last match) and days-to-next-match per team from
    stats_season_fixtures, relative to this fixture's own kickoff.

    Live gismo shape: matches[] is a flat season schedule with teams.home/away._id
    and time.uts (unix seconds). Postponed/canceled entries are excluded — they
    didn't actually consume a match slot. `rest_days` feeds the engine's existing
    (currently-dormant) restH/restA fatigue-decay input; `next_days` is ranker/LLM-
    only congestion context with no engine consumption point.
    """
    if not fixtures_data or not kickoff_uts:
        return None
    matches = fixtures_data.get("matches") or []
    if not isinstance(matches, list):
        return None
    result: dict[str, Optional[dict]] = {}
    for label, tid in (("home", home_id), ("away", away_id)):
        if tid is None:
            continue
        last_uts: Optional[int] = None
        next_uts: Optional[int] = None
        for m in matches:
            if not isinstance(m, dict) or m.get("postponed") or m.get("canceled"):
                continue
            teams = m.get("teams") or {}
            mh = (teams.get("home") or {}).get("_id")
            ma = (teams.get("away") or {}).get("_id")
            if tid != mh and tid != ma:
                continue
            uts = ((m.get("time") or {}).get("uts"))
            if not isinstance(uts, (int, float)):
                continue
            if uts < kickoff_uts and (last_uts is None or uts > last_uts):
                last_uts = uts
            elif uts > kickoff_uts and (next_uts is None or uts < next_uts):
                next_uts = uts
        entry: dict[str, float] = {}
        if last_uts is not None:
            entry["rest_days"] = round((kickoff_uts - last_uts) / 86400, 2)
        if next_uts is not None:
            entry["next_days"] = round((next_uts - kickoff_uts) / 86400, 2)
        if entry:
            result[label] = entry
    return result or None


def _parse_possession_value(
    uniqueteamstats_data: dict, home_id: Optional[int], away_id: Optional[int]
) -> Optional[dict]:
    """Extract season-aggregate shots/corners/possession per team from
    stats_season_uniqueteamstats — the possession-value proxy feeding the engine's
    feature store (no raw xG field exists anywhere in SportyBet/Sportradar's gismo
    API, confirmed live-probed 2026-06-23; shots_on_goal + shots_off_goal is the
    closest available shot-volume proxy).

    Live gismo shape: stats.uniqueteams is keyed by the "uniqueteam" doctype id,
    which equals the team's match_info `_id` (NOT the `uid` that stats_season_overunder
    uses — verified live 2026-06-23 against sr:match:66457034). Each stat is
    {average, total, matches} over the season; `average` is what feeds the model.
    """
    if not uniqueteamstats_data:
        return None
    teams = (uniqueteamstats_data.get("stats") or {}).get("uniqueteams")
    if not isinstance(teams, dict):
        return None
    result: dict[str, dict] = {}
    for label, tid in (("home", home_id), ("away", away_id)):
        entry = teams.get(str(tid)) if tid is not None else None
        if not isinstance(entry, dict):
            continue
        out: dict[str, float] = {}
        for key, out_key in (
            ("shots_on_goal", "shots_on_target_avg"),
            ("shots_off_goal", "shots_off_target_avg"),
            ("shots_blocked", "shots_blocked_avg"),
            ("corner_kicks", "corners_avg"),
            ("ball_possession", "possession_pct_avg"),
        ):
            avg = (entry.get(key) or {}).get("average")
            if isinstance(avg, (int, float)):
                out[out_key] = round(float(avg), 2)
        if out:
            result[label] = out
    return result or None


def _parse_recent_form_corners(
    lastx_data: dict, side: str, n: int = 5
) -> Optional[float]:
    """Average corners won (for the queried team) across its last N matches from
    stats_team_lastxextended — recency-weighted complement to the season-aggregate
    corners_avg above.

    Live gismo shape: matches[] is ordered most-recent-first; each match's
    `corners` is {home, away} keyed by venue, not by which side is the queried
    team — must match against `teams.home/away._id` per match to pick the right
    side (verified live 2026-06-23 against sr:match:66457034, team uid 4704/4723).
    """
    if not lastx_data:
        return None
    team_id = (lastx_data.get("team") or {}).get("_id")
    matches = lastx_data.get("matches")
    if not isinstance(matches, list) or team_id is None:
        return None
    vals: list[float] = []
    for m in matches[:n]:
        if not isinstance(m, dict):
            continue
        corners = m.get("corners")
        teams = m.get("teams") or {}
        if not isinstance(corners, dict):
            continue
        if (teams.get("home") or {}).get("_id") == team_id:
            v = corners.get("home")
        elif (teams.get("away") or {}).get("_id") == team_id:
            v = corners.get("away")
        else:
            continue
        if isinstance(v, (int, float)):
            vals.append(float(v))
    if not vals:
        return None
    return round(sum(vals) / len(vals), 2)


def _parse_funfacts(funfacts_data: dict) -> Optional[list[str]]:
    """Extract pre-match textual facts from match_funfacts — the closest verified
    gismo equivalent to a "commentary" subtab (live-probed 2026-06-21: no
    `probability`/`commentary`-named gismo endpoint exists under any plausible
    query string; SportyBet's implied "probability" is just de-vigged odds, which
    the engine already derives via Shin power-method de-vig from the captured
    `odds` block — no extra fetch needed for that).
    """
    if not funfacts_data:
        return None
    facts = funfacts_data.get("funfacts") or []
    out = [str(f) for f in facts if f]
    return out or None


def _fetch_fixture_detail(event_id: str, kickoff_utc: Optional[str] = None) -> dict:
    """
    Fetch markets + stats for one fixture via anonymous plain HTTP.

    Returns a dict with keys: odds, stats, statscoverage.
    Any sub-call failure degrades that field to None — never raises.
    """
    mid = event_id.rsplit(":", 1)[-1]
    # Validate mid is numeric-only before using it in Gismo URL paths to prevent path traversal
    if not mid.isdigit():
        return {"odds": None, "stats": None, "statscoverage": {}}
    import urllib.parse as _uparse
    eid_enc = _uparse.quote(event_id)

    # 1. Markets (factsCenter/event)
    import time as _time
    event_data = _sb_get(_SB_EVENT_URL.format(eid=eid_enc))
    _time.sleep(_SB_PACE)

    odds: Optional[dict] = None
    if event_data:
        markets_payload = event_data.get("data", event_data)
        odds = _parse_odds(markets_payload)
        odds["half"] = _parse_half_markets(markets_payload)
        odds["allMarkets"] = _parse_all_markets(markets_payload)

    # 2. match_info → team IDs, seasonId, statscoverage
    mi_data = _gismo_doc(f"match_info/{mid}")
    _time.sleep(_SB_PACE)

    home_id: Optional[int] = None
    away_id: Optional[int] = None
    # stats_season_overunder keys its `stats` dict by the team's "uniqueteam" id
    # (`team.uid`), NOT the "team" doctype `_id` that match_info/stats_season_tables/
    # stats_season_goals/stats_season_fixtures all key by — verified live 2026-06-20
    # (Czechia: _id=9509, uid=4714; both ids coexist on the same team object).
    home_uid: Optional[int] = None
    away_uid: Optional[int] = None
    season_id: Optional[int] = None
    statscoverage: dict = {}

    if mi_data:
        match = mi_data.get("match", {})
        teams = match.get("teams", {})
        # Validate IDs are numeric before using in Gismo URL paths (path-traversal guard)
        _raw_home = teams.get("home", {}).get("_id")
        _raw_away = teams.get("away", {}).get("_id")
        _raw_home_uid = teams.get("home", {}).get("uid")
        _raw_away_uid = teams.get("away", {}).get("uid")
        _raw_season = match.get("_seasonid")
        home_id = int(_raw_home) if str(_raw_home).isdigit() else None
        away_id = int(_raw_away) if str(_raw_away).isdigit() else None
        home_uid = int(_raw_home_uid) if str(_raw_home_uid).isdigit() else None
        away_uid = int(_raw_away_uid) if str(_raw_away_uid).isdigit() else None
        season_id = int(_raw_season) if str(_raw_season).isdigit() else None
        statscoverage = mi_data.get("statscoverage") or {}

    # 3. Form (stats_match_form)
    form_data = _gismo_doc(f"stats_match_form/{mid}")
    _time.sleep(_SB_PACE)
    form = _parse_form(form_data)

    # 4. Standings (stats_season_tables)
    standings_data = _gismo_doc(f"stats_season_tables/{season_id}") if season_id else None
    _time.sleep(_SB_PACE)
    standings = _parse_standings(standings_data, home_id, away_id)

    # 5. Season goals (stats_season_goals)
    goals_data = _gismo_doc(f"stats_season_goals/{season_id}") if season_id else None
    _time.sleep(_SB_PACE)
    goals = _parse_goals(goals_data, home_id, away_id)

    # 6. H2H (stats_team_versusrecent) — empty for most low-tier pairs; parse defensively
    h2h_data = _gismo_doc(f"stats_team_versusrecent/{home_id}/{away_id}") if (home_id and away_id) else None
    if h2h_data:
        _time.sleep(_SB_PACE)
    h2h = _parse_h2h(h2h_data)

    # 7. Season over/under % (stats_season_overunder) — keyed by uid, not _id (see above)
    ou_data = _gismo_doc(f"stats_season_overunder/{season_id}") if season_id else None
    _time.sleep(_SB_PACE)
    overunder = _parse_overunder(ou_data, home_uid, away_uid)

    # 8. Rest days + fixture congestion (stats_season_fixtures), relative to this
    # fixture's own kickoff — reuses the season fixture list already fetched for
    # standings context, no extra season-id resolution needed.
    kickoff_uts: Optional[int] = None
    if kickoff_utc:
        try:
            kickoff_uts = int(
                datetime.fromisoformat(kickoff_utc.replace("Z", "+00:00")).timestamp()
            )
        except ValueError:
            kickoff_uts = None
    fixtures_data = _gismo_doc(f"stats_season_fixtures/{season_id}") if season_id else None
    congestion = _parse_rest_congestion(fixtures_data, home_id, away_id, kickoff_uts)

    # 9. Pre-match facts (match_funfacts) — additive, best-effort "commentary" subtab.
    _time.sleep(_SB_PACE)
    funfacts_data = _gismo_doc(f"match_funfacts/{mid}")
    commentary = _parse_funfacts(funfacts_data)

    # 10. Possession-value proxy: season-aggregate shots/corners/possession
    # (stats_season_uniqueteamstats, keyed by team _id — not uid, see docstring).
    _time.sleep(_SB_PACE)
    uts_data = _gismo_doc(f"stats_season_uniqueteamstats/{season_id}") if season_id else None
    possession_value = _parse_possession_value(uts_data, home_id, away_id)

    # 11. Recent-form corners (last 5 matches per team), recency complement to #10.
    _time.sleep(_SB_PACE)
    home_lastx = _gismo_doc(f"stats_team_lastxextended/{home_id}") if home_id else None
    _time.sleep(_SB_PACE)
    away_lastx = _gismo_doc(f"stats_team_lastxextended/{away_id}") if away_id else None
    recent_corners: dict[str, float] = {}
    h_corners = _parse_recent_form_corners(home_lastx, "home")
    a_corners = _parse_recent_form_corners(away_lastx, "away")
    if h_corners is not None:
        recent_corners["home"] = h_corners
    if a_corners is not None:
        recent_corners["away"] = a_corners

    stats: dict = {}
    if form:
        stats["form"] = form
    if standings:
        stats["standings"] = standings
    if goals:
        stats["goals"] = goals
    if h2h:
        stats["h2h"] = h2h
    if overunder:
        stats["overunder"] = overunder
    if congestion:
        stats["congestion"] = congestion
    if commentary:
        stats["commentary"] = commentary
    if possession_value:
        stats["possessionValue"] = possession_value
    if recent_corners:
        stats["recentCorners"] = recent_corners

    return {
        "odds": odds,
        "stats": stats or None,
        "statscoverage": statscoverage or None,
    }


def enrich_sportybet_events(events: list[dict], max_workers: Optional[int] = None) -> list[dict]:
    """
    Add per-fixture odds/stats to the sidecar event list (sidecar v2).

    Each fixture makes ~6 serial anonymous HTTP GETs (factsCenter + gismo), so
    this is network-bound, not CPU-bound — a natural swarm shard, one worker per
    fixture. max_workers defaults to swarm_dispatch.swarm_max_workers(len(events)):
    capped at 8 on local Windows (measured: 115 fixtures 187s → ~95s at 8-way,
    gentle enough on stats.fn.sportradar.com to avoid 429s) but one worker per
    fixture (effectively unbounded) on a VPS deployment, per owner instruction
    2026-06-23 to scale acquisition fan-out OS-bound locally / unbounded on VPS.
    Each event record gains: odds, stats, statscoverage keys.
    A fetch failure degrades that record's fields to None; the event is not dropped.
    """
    import time as _time

    try:
        from swarm_dispatch import swarm_max_workers
    except ImportError:  # repo root on sys.path instead of tools/
        from tools.swarm_dispatch import swarm_max_workers

    if not events:
        return events

    if max_workers is None:
        max_workers = swarm_max_workers(len(events))

    xg_table = _load_xg_table()

    def _xg_block(ev: dict) -> dict:
        return {
            "home": _xg_for(xg_table, ev.get("home", "")),
            "away": _xg_for(xg_table, ev.get("away", "")),
        }

    def _worker(ev: dict) -> dict:
        eid = ev.get("eventId", "")
        xg = _xg_block(ev)
        if not eid:
            return {**ev, "odds": None, "stats": None, "statscoverage": None, "xg": xg}
        try:
            detail = _fetch_fixture_detail(eid, ev.get("kickoff_utc"))
            return {**ev, **detail, "xg": xg}
        except Exception:
            return {**ev, "odds": None, "stats": None, "statscoverage": None, "xg": xg}

    enriched: list[dict] = [{}] * len(events)
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_worker, ev): i for i, ev in enumerate(events)}
        done = 0
        for fut in as_completed(futures):
            idx = futures[fut]
            try:
                enriched[idx] = fut.result()
            except Exception:
                enriched[idx] = {
                    **events[idx],
                    "odds": None, "stats": None, "statscoverage": None,
                    "xg": _xg_block(events[idx]),
                }
            done += 1
            if done % 50 == 0:
                print(f"[enrich] {done}/{len(events)} fixtures enriched", flush=True)

    print(f"[enrich] done — {len(enriched)} fixtures enriched with odds+stats", flush=True)
    return enriched


class SportyBetScraper:
    PAGE_URL = "https://www.sportybet.com/ng/sport/football/today"
    API_BASE = (
        "https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents"
        "?sportId=sr%3Asport%3A1"
        "&marketId=1%2C18%2C10%2C29%2C11%2C26%2C36%2C14%2C60100"
        "&pageSize=100"
        "&pageNum={page}"
        "&todayGames=true"
        "&timeline=1.4"
    )
    # Secondary sweep: todayGames=false with timeline=1 captures fixtures SportyBet
    # serves under tournament/cup headers that the todayGames=true sweep misses
    # (e.g. World Cup group games that appear on separate tournament pages).
    API_BASE_UPCOMING = (
        "https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents"
        "?sportId=sr%3Asport%3A1"
        "&marketId=1%2C18%2C10%2C29%2C11%2C26%2C36%2C14%2C60100"
        "&pageSize=100"
        "&pageNum={page}"
        "&todayGames=false"
        "&timeline=1"
    )
    # Tertiary sweep: 3-day window catches WC/tournament legs punters book ahead.
    API_BASE_3DAY = (
        "https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents"
        "?sportId=sr%3Asport%3A1"
        "&marketId=1%2C18%2C10%2C29%2C11%2C26%2C36%2C14%2C60100"
        "&pageSize=100"
        "&pageNum={page}"
        "&todayGames=false"
        "&timeline=3"
    )

    def __init__(self) -> None:
        # Sidecar records for the requested date — read by run_playwright_scrapers
        self.captured_events: list[dict] = []

    async def fetch(self, ctx: "BrowserContext", date_str: str) -> list[Fixture]:
        page = await ctx.new_page()
        fixtures: list[Fixture] = []
        api_pages: list[dict] = []

        try:
            # Intercept pcUpcomingEvents responses — capture all paginated pages
            async def on_response(resp: "Page") -> None:
                if "pcUpcomingEvents" in resp.url:
                    try:
                        api_pages.append(await resp.json())
                    except Exception:
                        pass

            page.on("response", on_response)
            await page.goto(self.PAGE_URL, wait_until="domcontentloaded", timeout=40_000)
            await page.wait_for_timeout(3_000)

            # If the first page indicates more results, fetch remaining pages directly
            if api_pages:
                first = api_pages[0]
                total = first.get("data", {}).get("totalNum", 0)
                fetched = len(first.get("data", {}).get("tournaments", []))
                # Rough estimate: each tournament holds ~1 match on average in this API
                # Fetch up to 10 additional pages to be safe
                page_num = 2
                while fetched < total and page_num <= 10:
                    try:
                        url = self.API_BASE.format(page=page_num) + f"&_t={int(datetime.now(tz=timezone.utc).timestamp() * 1000)}"
                        resp = await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
                        if resp:
                            data = await resp.json()
                            api_pages.append(data)
                            fetched += len(data.get("data", {}).get("tournaments", []))
                    except Exception as exc:
                        _warn(f"SportyBet page {page_num}: {exc}")
                    page_num += 1

            # Secondary sweep: todayGames=false&timeline=1 — catches WC/tournament
            # fixtures that the todayGames=true endpoint omits (e.g. World Cup groups
            # served under separate tournament headers on SportyBet).
            for sweep_label, sweep_base, sweep_max_pages in [
                ("upcoming-1d", self.API_BASE_UPCOMING, 5),
                ("upcoming-3d", self.API_BASE_3DAY, 5),
            ]:
                sweep_pages: list[dict] = []
                try:
                    url = sweep_base.format(page=1) + f"&_t={int(datetime.now(tz=timezone.utc).timestamp() * 1000)}"
                    resp = await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
                    if resp:
                        first_sw = await resp.json()
                        sweep_pages.append(first_sw)
                        total_sw = first_sw.get("data", {}).get("totalNum", 0)
                        fetched_sw = len(first_sw.get("data", {}).get("tournaments", []))
                        page_num_sw = 2
                        while fetched_sw < total_sw and page_num_sw <= sweep_max_pages:
                            try:
                                url = sweep_base.format(page=page_num_sw) + f"&_t={int(datetime.now(tz=timezone.utc).timestamp() * 1000)}"
                                resp = await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
                                if resp:
                                    data = await resp.json()
                                    sweep_pages.append(data)
                                    fetched_sw += len(data.get("data", {}).get("tournaments", []))
                            except Exception as exc:
                                _warn(f"SportyBet {sweep_label} page {page_num_sw}: {exc}")
                            page_num_sw += 1
                except Exception as exc:
                    _warn(f"SportyBet {sweep_label} sweep: {exc}")
                api_pages.extend(sweep_pages)

            # Parse all captured API pages (dedup — pagination can replay events)
            seen_events: set[tuple[str, str, str]] = set()
            for api_data in api_pages:
                tournaments = api_data.get("data", {}).get("tournaments", [])
                for tournament in tournaments:
                    league = tournament.get("name", "Football")
                    for ev in tournament.get("events", []):
                        record = _sportybet_event_to_record(ev, league)
                        # Only keep fixtures for the requested date
                        if record and record["kickoff_utc"][:10] == date_str:
                            ev_key = (record["home"], record["away"], record["kickoff_utc"])
                            if ev_key in seen_events:
                                continue
                            seen_events.add(ev_key)
                            self.captured_events.append(record)
                            fixtures.append(Fixture(
                                home=record["home"], away=record["away"],
                                league=league, kickoff_utc=record["kickoff_utc"],
                            ))

        except Exception as exc:
            _warn(f"SportyBet: {exc}")
        finally:
            await page.close()
        return fixtures


# ── WhoScored scraper ─────────────────────────────────────────────────────────

class WhoScoredScraper:
    """Cloudflare-protected — likely returns [] but implemented for completeness."""
    URL = "https://www.whoscored.com/Fixtures"

    async def fetch(self, ctx: "BrowserContext", date_str: str) -> list[Fixture]:
        page = await ctx.new_page()
        fixtures: list[Fixture] = []
        try:
            await page.goto(self.URL, wait_until="domcontentloaded", timeout=30_000)
            # Cloudflare challenge check
            title = await page.title()
            if "Just a moment" in title or "Cloudflare" in title or "challenge" in title.lower():
                _warn("WhoScored: Cloudflare challenge — skipping")
                return fixtures
            await _dismiss_consent(page)
            await page.wait_for_timeout(3000)

            rows = await page.query_selector_all('[class*="Match-module_fixture"],'
                                                  '[id*="match-row"], .fixture')
            for row in rows:
                home_el = await row.query_selector('[class*="home"], .home')
                away_el = await row.query_selector('[class*="away"], .away')
                time_el = await row.query_selector('[class*="time"], .time')
                home = await _text(home_el)
                away = await _text(away_el)
                time_str = await _text(time_el)
                if home and away and re.match(r"^\d{1,2}:\d{2}$", time_str):
                    kickoff = _bst_to_utc(time_str, date_str)
                    if kickoff:
                        fixtures.append(Fixture(home=home, away=away, league="Football",
                                                 kickoff_utc=kickoff))
        except Exception as exc:
            _warn(f"WhoScored: {exc}")
        finally:
            await page.close()
        return fixtures


# ── Playwright runner ─────────────────────────────────────────────────────────

async def run_playwright_scrapers(date_str: str) -> tuple[list[Fixture], list[dict]]:
    if not HAS_PLAYWRIGHT:
        _warn("Playwright not installed — skipping JS scrapers. "
              "Run: pip install playwright && python -m playwright install chromium")
        return [], []

    sportybet = SportyBetScraper()
    scrapers = [
        ("BBC Sport",    BBCSportScraper()),
        ("Flashscore",   FlashscoreScraper()),
        ("365Scores",    Scores365Scraper()),
        ("OneFootball",  OneFootballScraper()),
        ("BetExplorer",  BetExplorerScraper()),
        ("SportyBet",    sportybet),
        ("WhoScored",    WhoScoredScraper()),
    ]

    results: list[Fixture] = []
    counts: dict[str, int] = {}

    # On local Windows, disable GPU rendering to prevent driver crashes causing hard reboots.
    # Auto-disabled on VPS/cloud (ORACLE_IS_VPS=true or non-Windows) where GPU is not the issue.
    _is_local_windows = sys.platform == "win32" and os.environ.get("ORACLE_IS_VPS", "").lower() != "true"
    _pw_args = ["--no-sandbox", "--disable-blink-features=AutomationControlled"]
    if _is_local_windows:
        _pw_args += ["--disable-gpu", "--disable-dev-shm-usage", "--disable-software-rasterizer"]

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=_pw_args,
        )
        ctx = await browser.new_context(
            user_agent=_CHROME_UA,
            viewport={"width": 1280, "height": 800},
            locale="en-GB",
            extra_http_headers={"Accept-Language": "en-GB,en;q=0.9"},
        )
        # Mask automation flag
        await ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
        )

        # Run scrapers concurrently — each opens its own ctx.new_page(), so the
        # shared context is safe to fan out. A semaphore caps simultaneous pages so
        # the slow zero-yield sites (OneFootball/365Scores/WhoScored) overlap the
        # productive ones instead of serialising behind them — collapses the crawl
        # from sum() toward max() wall time. Cap 4 on local Windows (CPU-contended;
        # higher just inflates each page's load time — see oracle_latency_twotier_fix);
        # all scrapers in one wave on the VPS where there's headroom.
        sem = asyncio.Semaphore(4 if _is_local_windows else len(scrapers))

        async def _run_one(name: str, scraper: object) -> tuple[str, list[Fixture]]:
            async with sem:
                try:
                    return name, await scraper.fetch(ctx, date_str)
                except Exception as exc:
                    _warn(f"{name} runner: {exc}")
                    return name, []

        for name, fx in await asyncio.gather(
            *(_run_one(name, scraper) for name, scraper in scrapers)
        ):
            counts[name] = len(fx)
            results.extend(fx)

        await browser.close()

    if counts:
        summary = " ".join(f"{k.lower().replace(' ','')}:{v}" for k, v in counts.items())
        print(f"[scrape] playwright — {summary}", flush=True)

    return results, sportybet.captured_events


# ── Cache helpers ─────────────────────────────────────────────────────────────

def read_cache() -> list[str]:
    if not FIXTURE_CACHE.exists():
        return []
    return [l.strip() for l in FIXTURE_CACHE.read_text(encoding="utf-8").splitlines() if l.strip()]


def write_cache(lines: list[str]) -> None:
    FIXTURE_CACHE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_CACHE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_sportybet_sidecar(date_str: str, events: list[dict]) -> None:
    """Write sidecar v2 — events enriched with odds/stats blocks.

    Written even when events is empty (TS selector fails open on empty list).
    Atomic write — a concurrent reader must never see a partial file.
    Each event record shape: {eventId, home, away, league, kickoff_utc, marketCount,
      odds: {1x2, ou15, ou25, ou35, btts, dc, dnb, ah}, stats: {form, standings, goals, h2h},
      statscoverage: {leaguetable, formtable, headtohead, …},
      xg: {home: {xgf, xga} | null, away: {xgf, xga} | null}  # Understat top-5 only}
    """
    SPORTYBET_SIDECAR.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "date": date_str,
        "scraped_at": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "events": events,
    }
    tmp = SPORTYBET_SIDECAR.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, SPORTYBET_SIDECAR)


def parse_existing_line(line: str) -> Optional[tuple[str, str, str]]:
    parts = line.split(", ")
    if len(parts) < 3:
        return None
    vs_parts = parts[0].split(" vs ", 1)
    if len(vs_parts) != 2:
        return None
    return vs_parts[0].strip(), vs_parts[1].strip(), parts[2].strip()


def merge_and_dedup(existing: list[str], new_fixtures: list[Fixture]) -> tuple[list[str], int]:
    seen: set[str] = set()
    merged: list[str] = []
    for line in existing:
        # Skip clearly malformed lines (no comma = likely a split newline artifact)
        if ", " not in line:
            continue
        parsed = parse_existing_line(line)
        if parsed:
            key = dedup_key(parsed[0], parsed[1], parsed[2])
            if key not in seen:
                seen.add(key)
                merged.append(line)
    added = 0
    for fix in new_fixtures:
        key = dedup_key(fix.home, fix.away, fix.kickoff_utc)
        if key not in seen:
            seen.add(key)
            merged.append(fix.to_line())
            added += 1
    return merged, added


# ── Main ──────────────────────────────────────────────────────────────────────

def run_acquisition(
    date_str: str,
    quiet: bool = False,
    no_playwright: bool = False,
    dry_run: bool = False,
) -> tuple[list[str], list[dict]]:
    """Run the full fixture-list + SportyBet sidecar acquisition for one date.

    Extracted from main() (no behavior change) so tools/acquire_daily.py can
    import and call this directly instead of forking a second `scrape_fixtures.py`
    process — cache/sidecar writes stay byte-identical to the original CLI path.
    Returns (merged_cache_lines, enriched_sportybet_events); the events list is
    empty when no_playwright is set or Playwright isn't installed.
    """
    t_other_start = time.perf_counter()
    espn_fixtures      = ESPNScraper().fetch_all(date_str)
    sky_fixtures       = SkySportsScraper().fetch(date_str)
    livescore_fixtures = LiveScoreScraper().fetch(date_str)
    t_other = time.perf_counter() - t_other_start

    if no_playwright:
        pw_fixtures, sportybet_events = [], []
        pw_ran = False
        t_playwright = 0.0
    else:
        t_pw_start = time.perf_counter()
        pw_fixtures, sportybet_events = asyncio.run(run_playwright_scrapers(date_str))
        t_playwright = time.perf_counter() - t_pw_start
        pw_ran = HAS_PLAYWRIGHT

    all_new = espn_fixtures + sky_fixtures + livescore_fixtures + pw_fixtures
    existing = read_cache()
    merged, added = merge_and_dedup(existing, all_new)

    if not quiet:
        print(
            f"[scrape] {len(merged)} fixtures ({added} new) — "
            f"espn:{len(espn_fixtures)} sky:{len(sky_fixtures)} "
            f"livescore:{len(livescore_fixtures)} pw:{len(pw_fixtures)} "
            f"existing:{len(existing)}"
        )
        print(
            f"[timing] non_playwright={t_other:.1f}s playwright_crawl={t_playwright:.1f}s",
            flush=True,
        )

    if dry_run:
        for line in merged:
            sys.stdout.buffer.write((line + "\n").encode("utf-8"))
        return merged, sportybet_events

    write_cache(merged)
    if pw_ran:
        if sportybet_events:
            print(f"[enrich] enriching {len(sportybet_events)} SportyBet fixtures with odds+stats …", flush=True)
            t_enrich_start = time.perf_counter()
            sportybet_events = enrich_sportybet_events(sportybet_events)
            t_enrich = time.perf_counter() - t_enrich_start
            print(f"[timing] enrichment={t_enrich:.1f}s ({len(sportybet_events)} fixtures)", flush=True)
        write_sportybet_sidecar(date_str, sportybet_events)
    return merged, sportybet_events


def main() -> None:
    parser = argparse.ArgumentParser(description="Scrape today's football fixtures")
    parser.add_argument("--date", default=None, help="YYYY-MM-DD (default: UTC today)")
    parser.add_argument("--dry-run", action="store_true", help="Print without writing")
    parser.add_argument("--quiet", action="store_true", help="Suppress output")
    parser.add_argument("--no-playwright", action="store_true",
                        help="Skip all Playwright scrapers (faster, ESPN+Sky+BBC only)")
    args = parser.parse_args()

    date_str = args.date or _utc_today()
    run_acquisition(date_str, quiet=args.quiet, no_playwright=args.no_playwright, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
