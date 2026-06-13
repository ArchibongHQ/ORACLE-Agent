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


def _parse_odds(markets_data: dict) -> dict:
    """Extract 1X2, OU2.5, BTTS, DC, DNB odds from factsCenter/event markets list."""
    result: dict[str, Optional[dict]] = {
        "1x2": None, "ou25": None, "btts": None, "dc": None, "dnb": None,
    }
    for market in markets_data.get("markets") or []:
        mid = str(market.get("id", ""))
        name = (market.get("name") or "").lower()
        outcomes = {str(o.get("id", "")): o.get("odds") for o in market.get("outcomes") or []}

        if mid == "1" or "match result" in name or "1x2" in name:
            # outcomes: 1=home, 2=draw, 3=away
            result["1x2"] = {
                "home": outcomes.get("1"), "draw": outcomes.get("2"), "away": outcomes.get("3"),
            }
        elif mid == "18" or ("over/under" in name and "2.5" in name):
            result["ou25"] = {
                "over": outcomes.get("12"), "under": outcomes.get("13"),
            }
        elif mid == "29" or "both teams" in name or "btts" in name:
            result["btts"] = {"yes": outcomes.get("74"), "no": outcomes.get("76")}
        elif mid == "10" or "double chance" in name:
            result["dc"] = {
                "1x": outcomes.get("9"), "12": outcomes.get("10"), "x2": outcomes.get("11"),
            }
        elif mid == "11" or "draw no bet" in name:
            result["dnb"] = {"home": outcomes.get("5"), "away": outcomes.get("6")}

    return result


def _parse_form(form_data: dict) -> Optional[dict]:
    """Extract last-5 W/D/L and goals from stats_match_form response."""
    if not form_data:
        return None
    teams = form_data.get("teams", {})
    out: dict[str, dict] = {}
    for side in ("home", "away"):
        team = teams.get(side, {})
        form_str = team.get("form", "")
        matches = [m for m in (form_str or "") if m in ("W", "D", "L")][-5:]
        out[side] = {
            "name": team.get("name"),
            "last5": "".join(matches),
            "w": matches.count("W"),
            "d": matches.count("D"),
            "l": matches.count("L"),
        }
    return out or None


def _parse_standings(tables_data: dict, home_id: Optional[int], away_id: Optional[int]) -> Optional[dict]:
    """Extract league position and points for both teams from stats_season_tables."""
    if not tables_data:
        return None
    rows = (tables_data.get("tables") or [{}])[0].get("tablerows", [])
    result: dict[str, Optional[dict]] = {}
    for row in rows:
        tid = row.get("_id")
        if tid in (home_id, away_id):
            label = "home" if tid == home_id else "away"
            result[label] = {
                "pos": row.get("pos"),
                "points": row.get("tot_pts"),
                "played": row.get("tot_sp"),
                "gf": row.get("tot_gf"),
                "ga": row.get("tot_ga"),
            }
        if len(result) == 2:
            break
    return result or None


def _parse_goals(goals_data: dict, home_id: Optional[int], away_id: Optional[int]) -> Optional[dict]:
    """Extract per-team avg goals scored/conceded from stats_season_goals."""
    if not goals_data:
        return None
    raw = goals_data.get("teams", {})
    # Gismo may return teams as a dict keyed by team_id or as a list of team objects
    if isinstance(raw, list):
        team_entries: dict = {str(t.get("_id", t.get("id", ""))): t for t in raw if isinstance(t, dict)}
    else:
        team_entries = raw if isinstance(raw, dict) else {}
    result: dict[str, Optional[dict]] = {}
    for label, tid in (("home", home_id), ("away", away_id)):
        if tid is None:
            continue
        entry = team_entries.get(str(tid))
        if entry:
            result[label] = {
                "avg_scored": entry.get("avgGoalsFor"),
                "avg_conceded": entry.get("avgGoalsAgainst"),
            }
    return result or None


def _parse_h2h(versus_data: dict) -> Optional[dict]:
    """Summarize H2H from stats_team_versusrecent — empty arrays are common for low-tier."""
    if not versus_data:
        return None
    matches = versus_data.get("matches") or []
    if not matches:
        return None
    summary = {"total": len(matches), "home_wins": 0, "away_wins": 0, "draws": 0}
    for m in matches[:10]:
        res = (m.get("result") or "").upper()
        if res == "HOME":
            summary["home_wins"] += 1
        elif res == "AWAY":
            summary["away_wins"] += 1
        elif res == "DRAW":
            summary["draws"] += 1
    return summary


def _fetch_fixture_detail(event_id: str) -> dict:
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

    # 2. match_info → team IDs, seasonId, statscoverage
    mi_data = _gismo_doc(f"match_info/{mid}")
    _time.sleep(_SB_PACE)

    home_id: Optional[int] = None
    away_id: Optional[int] = None
    season_id: Optional[int] = None
    statscoverage: dict = {}

    if mi_data:
        match = mi_data.get("match", {})
        teams = match.get("teams", {})
        home_id = teams.get("home", {}).get("_id")
        away_id = teams.get("away", {}).get("_id")
        season_id = match.get("_seasonid")
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

    stats: dict = {}
    if form:
        stats["form"] = form
    if standings:
        stats["standings"] = standings
    if goals:
        stats["goals"] = goals
    if h2h:
        stats["h2h"] = h2h

    return {
        "odds": odds,
        "stats": stats or None,
        "statscoverage": statscoverage or None,
    }


def enrich_sportybet_events(events: list[dict]) -> list[dict]:
    """
    Add per-fixture odds/stats to the sidecar event list (sidecar v2).

    Uses ThreadPoolExecutor(max_workers=4) — 300 fixtures ≈ 7 min.
    Each event record gains: odds, stats, statscoverage keys.
    A fetch failure degrades that record's fields to None; the event is not dropped.
    """
    import time as _time

    if not events:
        return events

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
            detail = _fetch_fixture_detail(eid)
            return {**ev, **detail, "xg": xg}
        except Exception:
            return {**ev, "odds": None, "stats": None, "statscoverage": None, "xg": xg}

    enriched: list[dict] = [{}] * len(events)
    with ThreadPoolExecutor(max_workers=4) as pool:
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

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
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

        for name, scraper in scrapers:
            try:
                fx = await scraper.fetch(ctx, date_str)
                counts[name] = len(fx)
                results.extend(fx)
            except Exception as exc:
                _warn(f"{name} runner: {exc}")
                counts[name] = 0

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
      odds: {1x2, ou25, btts, dc, dnb}, stats: {form, standings, goals, h2h},
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

def main() -> None:
    parser = argparse.ArgumentParser(description="Scrape today's football fixtures")
    parser.add_argument("--date", default=None, help="YYYY-MM-DD (default: UTC today)")
    parser.add_argument("--dry-run", action="store_true", help="Print without writing")
    parser.add_argument("--quiet", action="store_true", help="Suppress output")
    parser.add_argument("--no-playwright", action="store_true",
                        help="Skip all Playwright scrapers (faster, ESPN+Sky+BBC only)")
    args = parser.parse_args()

    date_str = args.date or _utc_today()

    espn_fixtures      = ESPNScraper().fetch_all(date_str)
    sky_fixtures       = SkySportsScraper().fetch(date_str)
    livescore_fixtures = LiveScoreScraper().fetch(date_str)
    if args.no_playwright:
        pw_fixtures, sportybet_events = [], []
        pw_ran = False
    else:
        pw_fixtures, sportybet_events = asyncio.run(run_playwright_scrapers(date_str))
        pw_ran = HAS_PLAYWRIGHT

    all_new = espn_fixtures + sky_fixtures + livescore_fixtures + pw_fixtures
    existing = read_cache()
    merged, added = merge_and_dedup(existing, all_new)

    if not args.quiet:
        print(
            f"[scrape] {len(merged)} fixtures ({added} new) — "
            f"espn:{len(espn_fixtures)} sky:{len(sky_fixtures)} "
            f"livescore:{len(livescore_fixtures)} pw:{len(pw_fixtures)} "
            f"existing:{len(existing)}"
        )

    if args.dry_run:
        for line in merged:
            print(line)
        return

    write_cache(merged)
    if pw_ran:
        if sportybet_events:
            print(f"[enrich] enriching {len(sportybet_events)} SportyBet fixtures with odds+stats …", flush=True)
            sportybet_events = enrich_sportybet_events(sportybet_events)
        write_sportybet_sidecar(date_str, sportybet_events)


if __name__ == "__main__":
    main()
