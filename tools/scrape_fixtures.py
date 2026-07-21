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
import random
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
    # ── Europe (top flights) ──────────────────────────────────────────────────
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
    "isl.1":            "Urvalsdeild",
    "nor.1":            "Eliteserien",
    "che.1":            "Swiss Super League",
    "den.1":            "Danish Superliga",
    # ── Europe (lower divisions) ──────────────────────────────────────────────
    "ger.2":            "2. Bundesliga",
    "ned.2":            "Eerste Divisie",
    "nor.2":            "OBOS-ligaen",
    "den.2":            "Danish 1. Division",
    # ── Europe (cups) ─────────────────────────────────────────────────────────
    "far.cup":          "Faroe Islands Cup",
    "ltu.cup":          "Lithuanian Cup",
    "est.cup":          "Estonian Cup",
    # ── Asia / Oceania / Middle East ──────────────────────────────────────────
    "sgp.1":            "Singapore Premier League",
    "mys.1":            "Malaysia Super League",
    "qat.1":            "Qatar Stars League",
    # ── The Americas ─────────────────────────────────────────────────────────
    "usa.1":            "MLS",
    "usa.3":            "USL League Two",
    "bol.1":            "Bolivia Primera Division",
    "mex.1":            "Liga MX",
    "bra.1":            "Brazilian Serie A",
    "bra.2":            "Brazilian Serie B",
    "arg.1":            "Argentine Primera Division",
    # ── Europe (continental / global) ────────────────────────────────────────
    "uefa.champions":   "Champions League",
    "uefa.europa":      "Europa League",
    "uefa.europa.conf": "Conference League",
    "jpn.1":            "J League",
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

# PR-25 item 2: referee cards-rate normaliser (compute_referee_cards.py) —
# needed to key from a referee's full name (fetch_referee_assignments.py's
# premierleague.com scrape) into the lake's abbreviated-name cards rates.
try:
    from compute_referee_cards import normalise_referee as _normalise_referee
except ImportError:  # repo root on sys.path instead of tools/
    from tools.compute_referee_cards import normalise_referee as _normalise_referee

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

def _sportybet_event_to_record(ev: dict, league: str, league_id: str = "") -> Optional[dict]:
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
        # Sportradar tournament ID (e.g. "sr:tournament:17"), when the API
        # response includes one — closes the league-name-collision gap where
        # two unrelated competitions sharing a generic label (e.g. a
        # lower-tier "Premier League") would otherwise be indistinguishable
        # downstream. Empty string, not None, when absent (Parquet-friendly).
        "leagueId": league_id,
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


def _xg_for(table: dict[str, dict], team: str, venue: Optional[str] = None) -> Optional[dict]:
    """Look up a team's {xgf, xga, src, venueXgf, venueXga} prior by normalised
    name. None when uncovered.

    xgf/xga are the season aggregate (as before). When `venue` ("home"|"away")
    is given and build_xg_table.py recorded matches at that venue, venueXgf/
    venueXga are ALSO populated — the SAME team's xG conditioned on playing at
    this fixture's venue only (goals-market-analysis-prompt-v3 gap-closure) —
    along with venueN (match count) so the TS override can gate on sample size.
    xgf is required; xga may be null on tables built before build_xg_table.py's
    estimated-xGA fill, or carry xgaSrc="estimated" after it (all-markets v3
    §0.3) — the TS override downgrades confidence on that tag."""
    rec = table.get(normalise(team))
    if not rec:
        return None
    xgf, xga = rec.get("xgf"), rec.get("xga")
    if not isinstance(xgf, (int, float)):
        return None
    src = rec.get("src") if isinstance(rec.get("src"), str) else None
    out = {
        "xgf": float(xgf),
        "xga": float(xga) if isinstance(xga, (int, float)) else None,
        "src": src,
    }
    if rec.get("xga_src") == "estimated":
        out["xgaSrc"] = "estimated"
    # PR-25 item 4: non-penalty xG / expected-assisted-goals, FBref-only (see
    # build_xg_table.py's _load_fbref_xg) — distinct signals, not a replacement
    # for xgf/xga, so pass through only when present rather than defaulting.
    npxgf = rec.get("npxgf")
    if isinstance(npxgf, (int, float)):
        out["npxgf"] = float(npxgf)
    xagf = rec.get("xagf")
    if isinstance(xagf, (int, float)):
        out["xagf"] = float(xagf)
    venue_rec = rec.get(venue) if venue in ("home", "away") else None
    if isinstance(venue_rec, dict) and isinstance(venue_rec.get("xgf"), (int, float)):
        out["venueXgf"] = float(venue_rec["xgf"])
        vxga = venue_rec.get("xga")
        out["venueXga"] = float(vxga) if isinstance(vxga, (int, float)) else None
        vn = venue_rec.get("n")
        if isinstance(vn, (int, float)):
            out["venueN"] = int(vn)
    return out


# Match-day squad availability index (tools/fetch_squad_availability.py, Kaggle
# Transfermarkt backfill of top-5-league matchday squads). The table is a
# per-past-match backfill, not a live feed — there's no such thing as "today's"
# row for a fixture that hasn't been played yet, so this looks up each club's
# MOST RECENT known row as a recency proxy for their current squad depth
# (same "last known state as a prior for the next match" pattern as
# applyTemporalDecay elsewhere in this pipeline). Optional — absent for any
# league outside top-5 domestic Kaggle coverage, or if the CSV was never built.
_AVAILABILITY_TABLE_PATH = Path(".tmp/squad-availability/availability_features.csv")


def _load_availability_table() -> dict[str, dict]:
    """Load the squad-availability CSV, keyed by normalise()'d club name, keeping
    only each club's most recent row (by date). Missing/corrupt file or row →
    that club (or field) is simply absent — availability blocks degrade to
    null, never fatal."""
    import csv

    import math

    table: dict[str, dict] = {}
    try:
        with _AVAILABILITY_TABLE_PATH.open("r", encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f):
                club, date, idx_raw = row.get("club"), row.get("date"), row.get("availability_idx")
                if not club or not date or not idx_raw:
                    continue
                try:
                    idx = float(idx_raw)
                except ValueError:
                    continue
                # Defense-in-depth: fetch_squad_availability.py's own min(ratio, 1.0)
                # cap should make this unreachable today, but a NaN/Infinity or
                # out-of-range value would otherwise flow unvalidated into the
                # sidecar JSON (json.dumps's default allow_nan=True would emit the
                # non-standard NaN/Infinity tokens, breaking Node's JSON.parse for
                # the WHOLE day's sidecar file, not just this one row/fixture).
                if not math.isfinite(idx) or not (0.0 <= idx <= 1.0):
                    continue
                key = normalise(club)
                existing = table.get(key)
                if existing is not None and existing["date"] >= date:
                    continue
                kp_raw = row.get("key_player_present")
                table[key] = {
                    "date": date,
                    "idx": idx,
                    "keyPlayerPresent": int(kp_raw) if kp_raw in ("0", "1") else None,
                }
    except (OSError, ValueError):
        return {}
    return table


def _availability_for(table: dict[str, dict], team: str) -> Optional[dict]:
    """Look up a team's most recent {idx, keyPlayerPresent} by normalised name.
    None when uncovered (team outside top-5 Kaggle coverage, or table absent)."""
    rec = table.get(normalise(team))
    if not rec:
        return None
    out: dict = {"idx": rec["idx"]}
    if rec.get("keyPlayerPresent") is not None:
        out["keyPlayerPresent"] = rec["keyPlayerPresent"]
    return out


# PR-25: match-day weather (tools/fetch_weather.py's forecast-endpoint half —
# Open-Meteo, keyless, plain HTTP, disk-cached by (lat,lon,date) so a repeat
# run on the same slate is free). Weather is regional/venue-level, keyed by
# the HOME team's city only (one block per fixture, not per side) — the away
# team plays wherever the home team's ground is.
#
# Gated by ORACLE_FETCH_WEATHER, DEFAULT OFF — NOT a cheap/harmless default-on
# feature. Populating this table means fixtures.ts's toEngineWeather() starts
# setting RunState.pipeline.fetched.weather, which is the ONLY gate on
# @oracle/engine's applyEnvironmentalPenalties (execution/index.ts) — an
# already-live, UNCONDITIONAL lambda adjustment (wind >18.5mph: -8%, rain
# >5mm: -6%) that has been fully dormant since it was ported from the
# original monolith, simply because nothing ever populated fetched.weather
# until this PR. Turning this flag on is therefore a real, immediate pricing
# change on every fixture with adverse conditions, not just a new report
# column — matches the "no λ change without backtest" caveat in the PR-25
# plan. Flip to "on" only as a deliberate owner decision.
#
# Built as a table BEFORE the threaded enrichment pool starts (same
# convention as xg/availability) rather than fetching per-event inside the
# pool, so the sequential, throttled, disk-cached fetch loop below never
# stacks concurrent requests against Open-Meteo from multiple worker threads
# at once.


def _load_weather_table(events: list[dict]) -> dict[tuple[str, str], dict]:
    """One Open-Meteo forecast call per DISTINCT (home-team-city, kickoff
    date) pair across today's slate — typically a few dozen even on a
    90-fixture day, since most fixtures cluster into a handful of leagues/
    cities. Missing coordinate coverage (team outside TEAM_CITY) or any
    fetch failure simply omits that key — degrades to no weather for that
    fixture, never fatal to acquisition. A per-event fetch/parse error is
    caught and skips only that event, so one bad record can't blank out
    weather for the rest of the slate (this loop runs before the
    ThreadPoolExecutor below, so nothing else isolates it)."""
    if os.environ.get("ORACLE_FETCH_WEATHER", "off").strip().lower() != "on":
        return {}
    try:
        import fetch_weather as fw
    except ImportError:
        from tools import fetch_weather as fw  # repo root on sys.path instead of tools/

    table: dict[tuple[str, str], dict] = {}
    # Cache the FETCH RESULT (not just "already fetched") per (lat, lon,
    # date) — two teams sharing a city (Inter/Milan, Roma/Lazio) must both
    # get a table entry from the one shared network call, not just the
    # first team processed. Keying only a "seen" set here previously caused
    # the second team to silently get no weather at all.
    fetched: dict[tuple[float, float, str], dict | None] = {}
    for ev in events:
        home = normalise(ev.get("home", ""))
        date_iso = (ev.get("kickoff_utc") or "")[:10]
        if not home or not date_iso:
            continue
        coords = fw.city_for_team(home)
        if not coords:
            continue
        key = (coords[0], coords[1], date_iso)
        try:
            if key not in fetched:
                fetched[key] = fw.fetch_forecast(coords[0], coords[1], date_iso)
            wx = fetched[key]
            if wx is None:
                continue
            is_adverse = wx["precip_mm"] > fw.ADVERSE_PRECIP_MM or wx["wind_kph"] > fw.ADVERSE_WIND_KPH
            table[(home, date_iso)] = {
                "tempC": round(wx["temp_c"], 1),
                "precipMm": round(wx["precip_mm"], 2),
                "windKph": round(wx["wind_kph"], 1),
                "isAdverse": is_adverse,
            }
        except Exception as exc:  # noqa: BLE001 — one bad event must not blank the slate
            print(f"[weather] skipping {home} {date_iso}: {exc}", flush=True)
            continue
    return table


def _weather_for(table: dict[tuple[str, str], dict], home_team: str, kickoff_utc: str) -> Optional[dict]:
    """Look up today's fixture weather by (normalised home team, date)."""
    date_iso = (kickoff_utc or "")[:10]
    if not date_iso:
        return None
    return table.get((normalise(home_team), date_iso))


# PR-25 item 2: referee assignment + cards-rate (EPL only — see
# tools/fetch_referee_assignments.py's module docstring for the premierleague.
# com scrape + its "no automated discovery yet" limitation, and
# tools/compute_referee_cards.py for the lake-computed shrunk cards rate).
# Both tables are optional/best-effort — a fixture with no referee
# assignment (any non-EPL league, or a week the scraper wasn't run) simply
# gets no referee block, same fail-open convention as xg/availability/weather.
_REFEREE_ASSIGNMENTS_PATH = Path(".tmp/oracle-store/referee_assignments.json")
_REFEREE_CARDS_PATH = Path(".tmp/oracle-store/referee_cards.json")

# tools/fetch_live_injuries.py's aggregated live per-fixture injuries/
# suspensions (API-Football /injuries, ANY league, daily-refreshed — see
# that file's module docstring for how this differs from the OTHER two
# injury-adjacent signals: fetch_squad_availability.py's Kaggle squad-value
# proxy (top-5 leagues, feeds SportyBetStats.availability/keyPlayerPresent)
# and fetch_injuries.py's Kaggle season injury-burden CSV. This table is
# optional/best-effort, same fail-open convention as referee/xg/availability/
# weather — a fixture with no entry (fetcher never run, or API-Football
# returned nothing for that fixture) simply gets no liveInjuries block.
_INJURIES_PATH = Path(".tmp/oracle-store/injuries.json")


def _load_referee_assignments_table() -> dict[tuple[str, str], str]:
    """Load referee_assignments.json, keyed by (normalise(home),
    normalise(away)) -> raw referee display name. Missing/corrupt file or an
    empty assignments list (e.g. --url never given, or the scrape failed
    open) -> empty dict, never fatal."""
    try:
        data = json.loads(_REFEREE_ASSIGNMENTS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    table: dict[tuple[str, str], str] = {}
    for a in data.get("assignments") or []:
        home, away, ref = a.get("home"), a.get("away"), a.get("referee")
        if not home or not away or not ref:
            continue
        table[(normalise(home), normalise(away))] = ref
    return table


def _load_referee_cards_table() -> tuple[dict[str, dict], dict[str, float]]:
    """Load referee_cards.json (tools/compute_referee_cards.py). Returns
    (by_key, league_means) in the SAME shapes that tool writes — by_key keyed
    by "{league}|{normalise_referee(name)}", league_means keyed by league name
    for the fallback path below. Missing/corrupt file -> both empty."""
    try:
        data = json.loads(_REFEREE_CARDS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}, {}
    by_key = data.get("byKey") if isinstance(data.get("byKey"), dict) else {}
    league_means = data.get("leagueMeans") if isinstance(data.get("leagueMeans"), dict) else {}
    return by_key, league_means


def _referee_for(
    assignments: dict[tuple[str, str], str],
    cards_by_key: dict[str, dict],
    league_means: dict[str, float],
    home: str,
    away: str,
    league: str,
) -> Optional[dict]:
    """Look up this fixture's assigned referee + shrunk cards rate.

    None when no assignment exists for this fixture (the common case for any
    non-EPL league, or any week the appointment scraper wasn't run/found
    nothing) — the caller degrades to no referee block, never a crash.

    When an assignment DOES exist but the referee has no entry in the lake's
    cards table (e.g. a newly-promoted official with zero backfill history),
    falls back to that league's overall mean cards rate (cardsRateSrc:
    "league_mean_fallback") rather than dropping the referee entirely — a
    referee IS being appointed either way, so "average referee" is a better
    prior than no signal at all. Only drops to a null rate (rare — would need
    the whole league missing from the lake) while still keeping the name,
    since the assignment itself is still useful context even without a rate.
    """
    ref = assignments.get((normalise(home), normalise(away)))
    if not ref:
        return None
    key = f"{league}|{_normalise_referee(ref)}"
    entry = cards_by_key.get(key)
    if entry and isinstance(entry.get("shrunkRate"), (int, float)):
        return {"name": ref, "cardsRate": entry["shrunkRate"], "cardsRateSrc": "empirical"}
    mean = league_means.get(league)
    if isinstance(mean, (int, float)):
        return {"name": ref, "cardsRate": mean, "cardsRateSrc": "league_mean_fallback"}
    return {"name": ref, "cardsRate": None, "cardsRateSrc": None}


def _load_injuries_table() -> dict[tuple[str, str], dict]:
    """Load injuries.json (tools/fetch_live_injuries.py), keyed by
    (normalise(home), normalise(away)) -> {"home": [...], "away": [...],
    "home_count": int, "away_count": int}. Missing/corrupt file or an empty
    injuries list -> empty dict, never fatal."""
    try:
        data = json.loads(_INJURIES_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    table: dict[tuple[str, str], dict] = {}
    for entry in data.get("injuries") or []:
        home, away = entry.get("home"), entry.get("away")
        if not home or not away:
            continue
        table[(normalise(home), normalise(away))] = {
            "home": entry.get("home_injuries") or [],
            "away": entry.get("away_injuries") or [],
            "home_count": entry.get("home_count") or 0,
            "away_count": entry.get("away_count") or 0,
        }
    return table


def _injuries_for(
    table: dict[tuple[str, str], dict], home: str, away: str
) -> Optional[dict]:
    """Look up this fixture's live per-team injuries/suspensions block.

    None when no entry exists for this fixture (the common case whenever
    tools/fetch_live_injuries.py hasn't been run today, or API-Football had
    nothing for this fixture) — the caller degrades to no liveInjuries
    block, never a crash."""
    entry = table.get((normalise(home), normalise(away)))
    if not entry:
        return None
    return {
        "home": {"count": entry["home_count"], "players": entry["home"]},
        "away": {"count": entry["away_count"], "players": entry["away"]},
    }


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


def _parse_combo_markets(markets_data: dict) -> dict:
    """Typed accessors for the joint 1X2+BTTS / 1X2+O-U / O-U+BTTS combo markets
    on top of the generic _parse_all_markets capture, feeding the engine's BLOCK
    12 (packages/engine/src/execution/index.ts). IDs verified live 2026-06-29
    against the Brazil vs Japan fixture (45 combo-group entries present):
      35=1X2 & GG/NG (outcomes 78=Home&Yes, 80=Home&No, 82=Draw&Yes, 84=Draw&No,
         86=Away&Yes, 88=Away&No)
      37=1X2 & Over/Under (line in specifier "total=<line>"; outcomes 794=Home&Under,
         796=Home&Over, 798=Draw&Under, 800=Draw&Over, 802=Away&Under, 804=Away&Over)
      36=Over/Under & GG/NG (line in specifier; outcomes are Over&Yes/Over&No/Under&Yes/Under&No
         — exact ids vary by line, matched by outcome desc instead of id)
    """
    result: dict[str, Optional[dict]] = {
        "1x2_btts": None, "ou_btts": {}, "1x2_ou": {},
    }

    def _line_key(spec: Optional[str]) -> Optional[str]:
        if not spec or "total=" not in spec:
            return None
        return spec.split("total=", 1)[-1].strip()

    for market in markets_data.get("markets") or []:
        mid = str(market.get("id", ""))
        spec = market.get("specifier")
        outcomes = market.get("outcomes") or []
        by_id = {str(o.get("id", "")): o.get("odds") for o in outcomes if o.get("odds")}
        if not by_id:
            continue

        if mid == "35":
            result["1x2_btts"] = {
                "home_yes": by_id.get("78"), "home_no": by_id.get("80"),
                "draw_yes": by_id.get("82"), "draw_no": by_id.get("84"),
                "away_yes": by_id.get("86"), "away_no": by_id.get("88"),
            }
        elif mid == "37":
            line = _line_key(spec)
            if line:
                result["1x2_ou"][line] = {  # type: ignore[index]
                    "home_under": by_id.get("794"), "home_over": by_id.get("796"),
                    "draw_under": by_id.get("798"), "draw_over": by_id.get("800"),
                    "away_under": by_id.get("802"), "away_over": by_id.get("804"),
                }
        elif mid == "36":
            line = _line_key(spec)
            if line:
                cell: dict[str, Optional[str]] = {}
                for o in outcomes:
                    desc = (o.get("desc") or "").lower()
                    odds_val = o.get("odds")
                    if not odds_val:
                        continue
                    if "over" in desc and "yes" in desc:
                        cell["over_yes"] = odds_val
                    elif "over" in desc and "no" in desc:
                        cell["over_no"] = odds_val
                    elif "under" in desc and "yes" in desc:
                        cell["under_yes"] = odds_val
                    elif "under" in desc and "no" in desc:
                        cell["under_no"] = odds_val
                if cell:
                    result["ou_btts"][line] = cell  # type: ignore[index]

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
    """Extract league position, points, goals, and win/draw/loss record for both
    teams from stats_season_tables.

    Live gismo shape: tables[0].tablerows[] where each row has team:{_id,…} and
    totals fields pointsTotal / total (matches played) / goalsForTotal /
    goalsAgainstTotal / winTotal / drawTotal / lossTotal / goalDiffTotal. (The
    old tot_pts/tot_sp/_id schema was never returned.) winTotal/drawTotal/
    lossTotal/goalDiffTotal confirmed live-present in the same row already
    being read for pos/points/played/gf/ga (2026-07-20) — previously fetched
    but discarded.
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
            entry = {
                "pos": row.get("pos"),
                "points": row.get("pointsTotal"),
                "played": row.get("total"),
                "gf": row.get("goalsForTotal"),
                "ga": row.get("goalsAgainstTotal"),
            }
            # w/d/l/diff omitted entirely (not set to None) when the source
            # row lacks them — matches this file's "never fabricate, omit
            # rather than null" convention (see _parse_disciplinary) and
            # keeps the base 5-field shape's existing callers/tests untouched.
            for key, out_key in (
                ("winTotal", "w"),
                ("drawTotal", "d"),
                ("lossTotal", "l"),
                ("goalDiffTotal", "diff"),
            ):
                v = row.get(key)
                if v is not None:
                    entry[out_key] = v
            result[label] = entry
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

    Besides the aggregate counters (home_wins/away_wins/draws — relied on by the
    engine scorer and test_gismo_parsers.py), this also surfaces a `matches` list
    of the most-recent meetings with their scoreline and date (verified live
    2026-06-29: each match carries result{home,away,winner}, time{date,uts}, and
    teams{home.name, away.name}). The per-match detail was previously fetched but
    discarded; the report/spreadsheet and the LLM arbiter want the actual results
    (e.g. "2-0; 2-2; 3-1"), not just the tally. The summary shape is unchanged.

    CONFIRMED DATA ABSENCE (live-verified 2026-07-20, not an extraction gap):
    each match object here carries NO corners/cards fields at all — checked the
    raw response for a real fixture with 24 H2H entries, keys are exactly
    {_doc, _doctype, _id, _rcid, _seasonid, _sid, _tid, _utid, bestof, canceled,
    comment, disqualified, inlivescore, neutralground, numberofperiods, periods,
    postponed, result, retired, round, roundname, stadiumid, status, teams,
    time, tobeannounced, walkover, week}. This is a materially different shape
    from stats_team_lastxextended's match objects, which DO carry a per-match
    `corners` field — head-to-head corners/cards genuinely do not exist on this
    endpoint, so BTTS%/Over1.5%/Over2.5% (computed in
    packages/runtime/src/selectFixtures.ts's computeH2hAggregate(), from the
    goals already in `result` above) are the full extent of derivable H2H
    aggregate stats. Do not re-probe this without a new reason to suspect the
    schema changed.
    """
    if not versus_data:
        return None
    matches = versus_data.get("matches") or []
    if not matches:
        return None
    window = matches[:10]
    # `total` is the size of the counted window (not len(matches)) so home_wins +
    # away_wins + draws always reconciles to total — otherwise the report's
    # "last N meetings, H/A/D" line never adds up.
    summary: dict = {"total": len(window), "home_wins": 0, "away_wins": 0, "draws": 0}
    detail: list[dict] = []
    for m in window:
        res = m.get("result")
        # Defend against the legacy string-result shape: a bare string has no
        # .get(), so only an object carries a countable winner.
        if not isinstance(res, dict):
            continue
        winner = (res.get("winner") or "").lower()
        h, a = res.get("home"), res.get("away")
        if winner == "home":
            summary["home_wins"] += 1
        elif winner == "away":
            summary["away_wins"] += 1
        elif winner == "draw":
            summary["draws"] += 1
        elif isinstance(h, (int, float)) and isinstance(a, (int, float)) and h == a:
            # Live gismo records draws as winner:null with equal home/away goals
            # (verified 2026-06-25 — e.g. {home:2,away:2,winner:null}), never the
            # literal "draw" string. Infer the draw from the scoreline so drawn
            # meetings aren't silently dropped from the H2H tally.
            winner = "draw"
            summary["draws"] += 1

        teams = m.get("teams") or {}
        tm = m.get("time") or {}
        if isinstance(h, (int, float)) and isinstance(a, (int, float)):
            detail.append({
                "date": tm.get("date"),
                "uts": tm.get("uts"),
                "home_team": (teams.get("home") or {}).get("name"),
                "away_team": (teams.get("away") or {}).get("name"),
                "home_goals": int(h),
                "away_goals": int(a),
                "winner": winner or None,
            })
    if detail:
        summary["matches"] = detail
    return summary


def _parse_overunder(ou_data: dict, home_uid: Optional[int], away_uid: Optional[int]) -> Optional[dict]:
    """Extract season over-1.5/2.5/3.5 (full-time) and over-0.5/1.5 (first-half)
    percentages per team from stats_season_overunder.

    Live gismo shape: stats is keyed by the team's "uniqueteam" id (`team.uid`),
    NOT the "team" doctype `_id` that match_info/stats_season_tables/stats_season_goals/
    stats_season_fixtures all key by (verified live 2026-06-20 — Czechia: _id=9509,
    uid=4714; both ids coexist on the same match_info team object, callers must pass
    uid here). Each entry's `total.ft["<line>"]` holds {over, under} match counts
    across the season (both venues combined); `total.p1["<line>"]` is the same
    shape for first-half-only goals (confirmed live 2026-07-20 — `total` also
    carries `p2`/`ap` siblings, not read here as they weren't part of the
    owner's ask). Percentage is over/(over+under); a line with zero matches
    recorded is omitted rather than reported as 0%.
    """
    if not ou_data:
        return None
    stats = ou_data.get("stats", {})
    if not isinstance(stats, dict):
        return None

    def pct_for(lines: dict, mapping: tuple) -> dict[str, float]:
        pct: dict[str, float] = {}
        for line_key, out_key in mapping:
            rec = lines.get(line_key)
            if not isinstance(rec, dict):
                continue
            over, under = rec.get("over"), rec.get("under")
            if isinstance(over, (int, float)) and isinstance(under, (int, float)) and (over + under) > 0:
                pct[out_key] = round(over / (over + under), 3)
        return pct

    result: dict[str, Optional[dict]] = {}
    for label, tid in (("home", home_uid), ("away", away_uid)):
        entry = stats.get(str(tid)) if tid is not None else None
        if not isinstance(entry, dict):
            continue
        total = entry.get("total") or {}
        pct = pct_for(
            total.get("ft") or {}, (("1.5", "over15_pct"), ("2.5", "over25_pct"), ("3.5", "over35_pct"))
        )
        pct.update(
            pct_for(total.get("p1") or {}, (("0.5", "ht_over05_pct"), ("1.5", "ht_over15_pct")))
        )
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
    lastx_data: dict, side: str, n: int = 5, conceded: bool = False
) -> Optional[float]:
    """Average corners won (for the queried team) across its last N matches from
    stats_team_lastxextended — recency-weighted complement to the season-aggregate
    corners_avg above. With conceded=True, returns the OPPONENTS' corners in those
    same matches instead (corners against — the missing half of the v3 §3.9
    Negative-Binomial corners model; uniqueteamstats only carries corners-for).

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
            v = corners.get("away" if conceded else "home")
        elif (teams.get("away") or {}).get("_id") == team_id:
            v = corners.get("home" if conceded else "away")
        else:
            continue
        if isinstance(v, (int, float)):
            vals.append(float(v))
    if not vals:
        return None
    return round(sum(vals) / len(vals), 2)


def _parse_recent_form_goals(
    lastx_data: dict, n: int = 5
) -> Optional[dict]:
    """Average goals scored/conceded (for the queried team) across its last N
    matches from stats_team_lastxextended — a true recency signal for the goals
    model, complementing the season-aggregate goals.avg_scored/avg_conceded.

    Reuses the SAME lastxextended doc already fetched for recent corners (no extra
    HTTP call). Live gismo shape: matches[] is ordered most-recent-first; each
    match's `result` is {home, away} keyed by venue — must match against
    `teams.home/away._id` per match to attribute scored vs conceded to the queried
    team (same venue-keying as corners, verified live 2026-06-25 against
    stats_team_lastxextended/44: result {home,away} carries the scoreline).
    Returns {scored_avg, conceded_avg, n} or None when no countable matches.
    """
    if not lastx_data:
        return None
    team_id = (lastx_data.get("team") or {}).get("_id")
    matches = lastx_data.get("matches")
    if not isinstance(matches, list) or team_id is None:
        return None
    scored: list[float] = []
    conceded: list[float] = []
    for m in matches[:n]:
        if not isinstance(m, dict) or m.get("postponed") or m.get("canceled"):
            continue
        res = m.get("result")
        teams = m.get("teams") or {}
        if not isinstance(res, dict):
            continue
        h, a = res.get("home"), res.get("away")
        if not (isinstance(h, (int, float)) and isinstance(a, (int, float))):
            continue
        if (teams.get("home") or {}).get("_id") == team_id:
            scored.append(float(h))
            conceded.append(float(a))
        elif (teams.get("away") or {}).get("_id") == team_id:
            scored.append(float(a))
            conceded.append(float(h))
    if not scored:
        return None
    return {
        "scored_avg": round(sum(scored) / len(scored), 2),
        "conceded_avg": round(sum(conceded) / len(conceded), 2),
        "n": len(scored),
    }


def _parse_scoring_conceding(scyc_data: dict, venue: str) -> Optional[dict]:
    """Extract season scoring/conceding profile from stats_season_teamscoringconceding.

    This is the "Scoring & Conceding" stats subtab — the richest pre-match goals
    signal SportyBet exposes. Endpoint shape verified live 2026-06-25:
    stats_season_teamscoringconceding/{seasonid}/{uid}/{limit} (keyed by uid, the
    uniqueteam id — NOT _id) returns data.stats with `scoring`/`conceding` blocks,
    each carrying {total, home, away} venue splits for goalsscored, BTTS rate,
    failed-to-score rate, half-time scoring, and a goals-by-minute histogram.

    `venue` selects which venue split to surface for this fixture's role: "home"
    for the home team, "away" for the away team — a team's home goal rate is the
    relevant prior when it plays at home. Returns a flat dict of the goals-relevant
    averages, or None when the season has no recorded matches yet.
    """
    if not scyc_data:
        return None
    stats = scyc_data.get("stats")
    if not isinstance(stats, dict):
        return None
    total_matches = ((stats.get("totalmatches") or {}).get(venue)) or 0
    if not total_matches:
        return None
    scoring = stats.get("scoring") or {}
    conceding = stats.get("conceding") or {}

    def avg(block: dict, key: str) -> Optional[float]:
        rec = block.get(key)
        v = rec.get(venue) if isinstance(rec, dict) else None
        return round(float(v), 2) if isinstance(v, (int, float)) else None

    out = {
        "matches": int(total_matches),
        "scored_avg": avg(scoring, "goalsscoredaverage"),
        "conceded_avg": avg(conceding, "goalsconcededaverage"),
        "btts_rate": avg(scoring, "bothteamsscoredaverage"),
        "failed_to_score_rate": avg(scoring, "failedtoscoreaverage"),
        "scoring_1h_rate": avg(scoring, "scoringathalftimeaverage"),
        "goals_1h_avg": avg(scoring, "goalsscoredfirsthalfaverage"),
        "clean_sheet_rate": avg(conceding, "cleansheetsaverage"),
    }
    # Drop keys that came back null so the report only shows real values.
    cleaned = {k: v for k, v in out.items() if v is not None}
    return cleaned if len(cleaned) > 1 else None


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


def _parse_disciplinary(disc_data: dict, venue: str) -> Optional[dict]:
    """Cards/fouls per team from stats_season_teamdisciplinary/{seasonid}/{uid}.

    Marginal goals signal (card-heavy refs → stoppages, fewer goals; many fouls →
    set-pieces). Defensive against unverified schema: known gismo disciplinary docs
    expose a `stats` dict with per-90 averages; we read the documented keys and
    return None on any shape mismatch (never fabricate — see oracle_gismo_parsers).
    `venue` selects the home/away split when present, falling back to `total`.
    """
    if not disc_data:
        return None
    stats = disc_data.get("stats")
    if not isinstance(stats, dict):
        return None

    def avg(key: str) -> Optional[float]:
        rec = stats.get(key)
        if isinstance(rec, dict):
            v = rec.get(venue, rec.get("total"))
        else:
            v = rec
        return round(float(v), 2) if isinstance(v, (int, float)) else None

    out: dict[str, Optional[float]] = {
        "yellow_avg": avg("yellowcardsaverage"),
        "red_avg": avg("redcardsaverage"),
        "fouls_avg": avg("foulsaverage"),
    }
    # Total-cards display figure (owner reference-screenshot request, 2026-07-20):
    # only computed when yellow is present — red defaults to 0.0 when genuinely
    # absent, but a missing yellow means the whole record is unreliable, so no
    # total is fabricated from red_avg alone.
    if out["yellow_avg"] is not None:
        out["total_avg"] = round(out["yellow_avg"] + (out["red_avg"] or 0.0), 2)
    cleaned = {k: v for k, v in out.items() if v is not None}
    return cleaned or None


def _parse_position_history(ph_data: dict) -> Optional[dict]:
    """League-position trend from stats_season_teampositionhistory/{seasonid}/{uid}.

    Momentum signal: a team climbing vs sliding over recent rounds. Defensive parse —
    returns {current, best, worst, trend} where trend = sign(earliest − latest) so a
    positive trend means improving (lower position number). None on shape mismatch.
    """
    if not ph_data:
        return None
    hist = ph_data.get("positionhistory") or ph_data.get("history")
    if not isinstance(hist, list) or not hist:
        return None
    positions: list[int] = []
    for entry in hist:
        p = entry.get("position") if isinstance(entry, dict) else entry
        if isinstance(p, (int, float)):
            positions.append(int(p))
    if not positions:
        return None
    current = positions[-1]
    trend = positions[0] - current  # >0 = climbed (lower number = better)
    return {
        "current": current,
        "best": min(positions),
        "worst": max(positions),
        "trend": trend,
        "n": len(positions),
    }


def _parse_top_goals(tg_data: dict, team_id: Optional[int], team_uid: Optional[int]) -> Optional[dict]:
    """Top-scorer concentration from stats_season_topgoals/{seasonid}.

    Key-player-absence signal when paired with news intel: a team whose goals are
    concentrated in one scorer is more fragile to that player's absence. Returns
    {top_scorer_goals, top_scorer_name} for this fixture's team. Defensive parse.
    """
    if not tg_data:
        return None
    players = tg_data.get("topgoals") or tg_data.get("players")
    if not isinstance(players, list) or not players:
        return None
    for p in players:
        if not isinstance(p, dict):
            continue
        team = p.get("team") or {}
        tid = team.get("_id") if isinstance(team, dict) else None
        tuid = team.get("uid") if isinstance(team, dict) else None
        if (team_id and tid == team_id) or (team_uid and tuid == team_uid):
            goals = p.get("goals")
            if isinstance(goals, (int, float)):
                return {
                    "top_scorer_goals": int(goals),
                    "top_scorer_name": str(p.get("name") or p.get("playername") or "?"),
                }
    return None


def _parse_squad_averages(squad_data: dict) -> Optional[dict]:
    """Mean age/height/weight across a team's roster from stats_team_squad/{uid}.

    Live gismo shape (verified 2026-07-20 against a live MLS Next Pro fixture):
    keyed by the team's "uniqueteam" `uid` — NOT the "team" doctype `_id` that
    match_info/stats_season_tables/stats_season_goals/stats_season_fixtures use
    (passing `_id` here returns an empty `players` list, not an error — the
    same silent-mismatch trap documented on _parse_overunder). `players[]` each
    carry `birthdate.uts` (age computed from this vs. now), `height` (cm),
    `weight` (kg).

    Data-quality gotcha (live-verified, not assumed): lower-tier leagues have
    real gaps in this roster data — height/weight are `0` (a null sentinel,
    not a real measurement — no professional player is 0cm/0kg) for a material
    fraction of players (4/13 and 4/19 on the two sides of the verifying
    fixture). Zero-valued height/weight are excluded from their averages so a
    missing-data sentinel never silently drags the mean down; age has no such
    sentinel (birthdate was 100% populated on both verifying rosters) but is
    still defensively skipped per-player on any unparseable birthdate.
    """
    if not squad_data:
        return None
    players = squad_data.get("players")
    if not isinstance(players, list) or not players:
        return None
    now = time.time()
    ages: list[float] = []
    heights: list[float] = []
    weights: list[float] = []
    for p in players:
        if not isinstance(p, dict):
            continue
        bd = p.get("birthdate")
        uts = bd.get("uts") if isinstance(bd, dict) else None
        if isinstance(uts, (int, float)) and uts > 0:
            ages.append((now - uts) / 31_557_600)  # seconds per Julian year
        h = p.get("height")
        if isinstance(h, (int, float)) and h > 0:
            heights.append(float(h))
        w = p.get("weight")
        if isinstance(w, (int, float)) and w > 0:
            weights.append(float(w))
    out: dict[str, float] = {}
    if ages:
        out["avg_age"] = round(sum(ages) / len(ages), 1)
    if heights:
        out["avg_height_cm"] = round(sum(heights) / len(heights), 1)
    if weights:
        out["avg_weight_kg"] = round(sum(weights) / len(weights), 1)
    return out or None


def _parse_venue(mi_data: dict) -> Optional[dict]:
    """Stadium name/city/country/capacity from match_info's embedded `stadium`
    object — report-only descriptive context, NOT a pricing signal.

    Discovery note (2026-07-21): there is NO separate gismo venue/stadium query.
    8 plausible names (venue/{id}, stadium/{id}, stats_venue/{id}, venueinfo/{id},
    stats_stadium/{id}, stadiuminfo/{id}, stats_venue_info/{id},
    stats_venue_details/{id}) all return the gismo "exception" doc shape. The
    venue data is embedded in match_info's own `data.stadium` object;
    `match.stadiumid` is just that object's `_id` pointer (verified equal live:
    2322==2322 for Kalmar's "Guldfageln Arena", 72069==72069 for Rapid
    Bucuresti's "Stadionul Rapid-Giulesti"). No new gismo call is made — this
    reuses the match_info response already fetched as call #2 of
    _fetch_fixture_detail (stats_team_info/{uid} carries the same object, but
    reading it there would cost a redundant extra request).

    Live-verified shape (2026-07-21, real CLUB fixtures — Allsvenskan/Superliga):
    stadium = {name, city, country, capacity, googlecoords, pitchsize, ...}.
    Gotchas (verified, not assumed):
    - `capacity` is a STRING ("12500"), not an int — coerced to int, dropped if
      non-numeric or <= 0.
    - the whole `stadium` object is absent (None) for neutral-ground / venue-
      unknown fixtures (a club friendly returned stadium=None) — returns None.
    - `name`/`city`/`country` can be empty strings; treated as missing (omitted,
      never fabricated — same "omit rather than null" convention as
      _parse_disciplinary/_parse_standings).
    """
    if not mi_data:
        return None
    st = mi_data.get("stadium")
    if not isinstance(st, dict):
        return None
    out: dict = {}
    for key in ("name", "city", "country"):
        v = st.get(key)
        if isinstance(v, str) and v.strip():
            out[key] = v.strip()
    cap = st.get("capacity")
    if isinstance(cap, bool):  # bool is an int subclass — never a capacity
        cap = None
    if isinstance(cap, (int, float)) and cap > 0:
        out["capacity"] = int(cap)
    elif isinstance(cap, str) and cap.strip().isdigit() and int(cap) > 0:
        out["capacity"] = int(cap.strip())
    return out or None


def _fetch_fixture_detail(
    event_id: str,
    kickoff_utc: Optional[str] = None,
    home: str = "",
    away: str = "",
) -> dict:
    """
    Fetch markets + stats for one fixture via anonymous plain HTTP.

    Returns a dict with keys: odds, stats, statscoverage.
    Any sub-call failure degrades that field to None — never raises.

    home/away are used ONLY for the optional, dormant Apify reliability fallback
    (tools/fetch_apify_stats.py) — a no-op unless APIFY_TOKEN is set. gismo stays
    the primary source; Apify only fills H2H/standings when gismo returned null.
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
        odds["combo"] = _parse_combo_markets(markets_payload)
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

    # 6. H2H (stats_team_versusrecent) — keyed by the team's "uniqueteam" id (`uid`),
    # NOT the "team" doctype `_id` (verified live 2026-06-25 against match 66457034,
    # Portugal vs Uzbekistan: _id=9531/311459 returns an empty doc, uid=4704/4723
    # returns the matches array). This is the same uid-vs-_id gismo trap that bites
    # stats_season_overunder. Passing _id here silently emptied H2H for every fixture
    # whose _id != uid (i.e. virtually all non-classic teams — classic clubs like
    # Liverpool happen to have _id==uid and masked the bug). Empty arrays remain
    # common for genuinely-unmet low-tier pairs; parse defensively either way.
    h2h_data = (
        _gismo_doc(f"stats_team_versusrecent/{home_uid}/{away_uid}")
        if (home_uid and away_uid)
        else None
    )
    if h2h_data:
        _time.sleep(_SB_PACE)
    h2h = _parse_h2h(h2h_data)

    # 6b. DORMANT Apify reliability fallback — only fires when gismo returned no H2H
    # AND APIFY_TOKEN is set (no token = no call, no cost). gismo stays primary.
    if not h2h and home and away:
        try:
            from fetch_apify_stats import fetch_apify_subtab
        except ImportError:  # repo root on sys.path instead of tools/
            try:
                from tools.fetch_apify_stats import fetch_apify_subtab
            except ImportError:
                fetch_apify_subtab = None  # type: ignore[assignment]
        if fetch_apify_subtab is not None:
            ap_h2h = fetch_apify_subtab(home, away, "h2h")
            if ap_h2h:
                h2h = ap_h2h

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

    # 11a. Corners AGAINST (opponents' corners in the same last-5 matches) — the
    # other half of the v3 §3.9 corners model; reuses the lastxextended docs.
    recent_corners_against: dict[str, float] = {}
    h_corners_ag = _parse_recent_form_corners(home_lastx, "home", conceded=True)
    a_corners_ag = _parse_recent_form_corners(away_lastx, "away", conceded=True)
    if h_corners_ag is not None:
        recent_corners_against["home"] = h_corners_ag
    if a_corners_ag is not None:
        recent_corners_against["away"] = a_corners_ag

    # 11b. Recent-form goals (last 5 scored/conceded per team) — reuses the SAME
    # lastxextended docs above (no extra fetch). The strongest recency signal for a
    # goals model; previously the per-match scoreline in lastxextended was fetched
    # but only corners were extracted, discarding the goals entirely.
    recent_goals: dict[str, dict] = {}
    h_rg = _parse_recent_form_goals(home_lastx)
    a_rg = _parse_recent_form_goals(away_lastx)
    if h_rg is not None:
        recent_goals["home"] = h_rg
    if a_rg is not None:
        recent_goals["away"] = a_rg

    # 11c. Scoring & Conceding profile (stats_season_teamscoringconceding) — the
    # richest pre-match goals subtab: BTTS rate, failed-to-score rate, half-time
    # scoring, venue-split goal averages. Keyed by uid + seasonid + limit (verified
    # live 2026-06-25). home team's "home" venue split + away team's "away" split
    # are the relevant priors for this fixture's matchup.
    scoring_conceding: dict[str, dict] = {}
    if season_id and home_uid:
        _time.sleep(_SB_PACE)
        h_scyc = _gismo_doc(f"stats_season_teamscoringconceding/{season_id}/{home_uid}/10")
        parsed = _parse_scoring_conceding(h_scyc, "home")
        if parsed:
            scoring_conceding["home"] = parsed
    if season_id and away_uid:
        _time.sleep(_SB_PACE)
        a_scyc = _gismo_doc(f"stats_season_teamscoringconceding/{season_id}/{away_uid}/10")
        parsed = _parse_scoring_conceding(a_scyc, "away")
        if parsed:
            scoring_conceding["away"] = parsed

    # 12. Disciplinary (cards/fouls) — stats_season_teamdisciplinary/{seasonid}/{uid}.
    # Marginal goals signal (referee/foul proxy). uid-keyed like overunder/h2h.
    disciplinary: dict[str, dict] = {}
    if season_id and home_uid:
        _time.sleep(_SB_PACE)
        h_disc = _gismo_doc(f"stats_season_teamdisciplinary/{season_id}/{home_uid}")
        parsed = _parse_disciplinary(h_disc, "home")
        if parsed:
            disciplinary["home"] = parsed
    if season_id and away_uid:
        _time.sleep(_SB_PACE)
        a_disc = _gismo_doc(f"stats_season_teamdisciplinary/{season_id}/{away_uid}")
        parsed = _parse_disciplinary(a_disc, "away")
        if parsed:
            disciplinary["away"] = parsed

    # 13. Position history (momentum trend) — stats_season_teampositionhistory/{seasonid}/{uid}.
    position_history: dict[str, dict] = {}
    if season_id and home_uid:
        _time.sleep(_SB_PACE)
        h_ph = _gismo_doc(f"stats_season_teampositionhistory/{season_id}/{home_uid}")
        parsed = _parse_position_history(h_ph)
        if parsed:
            position_history["home"] = parsed
    if season_id and away_uid:
        _time.sleep(_SB_PACE)
        a_ph = _gismo_doc(f"stats_season_teampositionhistory/{season_id}/{away_uid}")
        parsed = _parse_position_history(a_ph)
        if parsed:
            position_history["away"] = parsed

    # 14. Top scorers (key-player concentration) — stats_season_topgoals/{seasonid}.
    # One doc covers the whole league; extract each team's lead scorer.
    top_goals: dict[str, dict] = {}
    if season_id:
        _time.sleep(_SB_PACE)
        tg_data = _gismo_doc(f"stats_season_topgoals/{season_id}")
        h_tg = _parse_top_goals(tg_data, home_id, home_uid)
        a_tg = _parse_top_goals(tg_data, away_id, away_uid)
        if h_tg:
            top_goals["home"] = h_tg
        if a_tg:
            top_goals["away"] = a_tg

    # 15. Squad averages (age/height/weight) — stats_team_squad/{uid}. uid-keyed
    # (verified live 2026-07-20: passing the team _id here silently returns an
    # empty players[] instead of an error — same trap class as overunder/h2h).
    squad_averages: dict[str, dict] = {}
    if home_uid:
        _time.sleep(_SB_PACE)
        h_squad = _gismo_doc(f"stats_team_squad/{home_uid}")
        parsed = _parse_squad_averages(h_squad)
        if parsed:
            squad_averages["home"] = parsed
    if away_uid:
        _time.sleep(_SB_PACE)
        a_squad = _gismo_doc(f"stats_team_squad/{away_uid}")
        parsed = _parse_squad_averages(a_squad)
        if parsed:
            squad_averages["away"] = parsed

    # 16. Venue/stadium (name/city/country/capacity) — embedded in match_info's
    # own `stadium` object (call #2 above), NOT a separate gismo query. No extra
    # request. Report-only descriptive context; see _parse_venue for the shape.
    venue = _parse_venue(mi_data)

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
    if recent_corners_against:
        stats["recentCornersAgainst"] = recent_corners_against
    if recent_goals:
        stats["recentGoals"] = recent_goals
    if scoring_conceding:
        stats["scoringConceding"] = scoring_conceding
    if disciplinary:
        stats["disciplinary"] = disciplinary
    if position_history:
        stats["positionHistory"] = position_history
    if top_goals:
        stats["topGoals"] = top_goals
    if squad_averages:
        stats["squadAverages"] = squad_averages
    if venue:
        stats["venue"] = venue

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
    availability_table = _load_availability_table()
    # PR-25: sequential + disk-cached, so this runs to completion BEFORE the
    # threaded pool below starts — see _load_weather_table's docstring for why.
    weather_table = _load_weather_table(events)
    # PR-25 item 2: referee assignment + cards-rate (EPL only, best-effort —
    # both tables degrade to empty when absent, same as the tables above).
    referee_assignments_table = _load_referee_assignments_table()
    referee_cards_by_key, referee_league_means = _load_referee_cards_table()
    injuries_table = _load_injuries_table()

    def _xg_block(ev: dict) -> dict:
        return {
            "home": _xg_for(xg_table, ev.get("home", ""), venue="home"),
            "away": _xg_for(xg_table, ev.get("away", ""), venue="away"),
        }

    def _availability_block(ev: dict) -> dict:
        return {
            "home": _availability_for(availability_table, ev.get("home", "")),
            "away": _availability_for(availability_table, ev.get("away", "")),
        }

    def _weather_block(ev: dict) -> Optional[dict]:
        return _weather_for(weather_table, ev.get("home", ""), ev.get("kickoff_utc", ""))

    def _referee_block(ev: dict) -> Optional[dict]:
        return _referee_for(
            referee_assignments_table, referee_cards_by_key, referee_league_means,
            ev.get("home", ""), ev.get("away", ""), ev.get("league", ""),
        )

    def _injuries_block(ev: dict) -> Optional[dict]:
        return _injuries_for(injuries_table, ev.get("home", ""), ev.get("away", ""))

    def _worker(ev: dict) -> dict:
        eid = ev.get("eventId", "")
        xg = _xg_block(ev)
        availability = _availability_block(ev)
        weather = _weather_block(ev)
        referee = _referee_block(ev)
        live_injuries = _injuries_block(ev)
        if not eid:
            return {
                **ev, "odds": None, "stats": None, "statscoverage": None,
                "xg": xg, "availability": availability, "weather": weather,
                "referee": referee, "liveInjuries": live_injuries,
            }
        try:
            detail = _fetch_fixture_detail(
                eid, ev.get("kickoff_utc"), ev.get("home", ""), ev.get("away", "")
            )
            return {
                **ev, **detail, "xg": xg, "availability": availability,
                "weather": weather, "referee": referee, "liveInjuries": live_injuries,
            }
        except Exception:
            return {
                **ev, "odds": None, "stats": None, "statscoverage": None,
                "xg": xg, "availability": availability, "weather": weather,
                "referee": referee, "liveInjuries": live_injuries,
            }

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
                    "availability": _availability_block(events[idx]),
                    "weather": _weather_block(events[idx]),
                    "referee": _referee_block(events[idx]),
                    "liveInjuries": _injuries_block(events[idx]),
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

            # If the first page indicates more results, fetch remaining pages directly.
            # Delay 3–7 s between requests to avoid rate-limiting / IP blocks.
            if api_pages:
                first = api_pages[0]
                total = first.get("data", {}).get("totalNum", 0)
                fetched = len(first.get("data", {}).get("tournaments", []))
                # Rough estimate: each tournament holds ~1 match on average in this API
                # Fetch up to 10 additional pages to be safe
                page_num = 2
                while fetched < total and page_num <= 10:
                    await asyncio.sleep(random.uniform(3, 7))
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
            # Same 3–7 s random throttle between pages applies to each sweep.
            for sweep_label, sweep_base, sweep_max_pages in [
                ("upcoming-1d", self.API_BASE_UPCOMING, 5),
                ("upcoming-3d", self.API_BASE_3DAY, 5),
            ]:
                sweep_pages: list[dict] = []
                try:
                    await asyncio.sleep(random.uniform(3, 7))
                    url = sweep_base.format(page=1) + f"&_t={int(datetime.now(tz=timezone.utc).timestamp() * 1000)}"
                    resp = await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
                    if resp:
                        first_sw = await resp.json()
                        sweep_pages.append(first_sw)
                        total_sw = first_sw.get("data", {}).get("totalNum", 0)
                        fetched_sw = len(first_sw.get("data", {}).get("tournaments", []))
                        page_num_sw = 2
                        while fetched_sw < total_sw and page_num_sw <= sweep_max_pages:
                            await asyncio.sleep(random.uniform(3, 7))
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
                    # Sportradar tournament ID (e.g. "sr:tournament:28424") —
                    # verified against .tmp/sportybet_api_capture's real
                    # pcUpcomingEvents response. Previously discarded; now
                    # captured to disambiguate leagues sharing a generic name.
                    league_id = str(tournament.get("id") or "")
                    for ev in tournament.get("events", []):
                        record = _sportybet_event_to_record(ev, league, league_id)
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
    Each event record shape: {eventId, home, away, league, leagueId, kickoff_utc, marketCount,
      odds: {1x2, ou15, ou25, ou35, btts, dc, dnb, ah}, stats: {form, standings, goals, h2h},
      statscoverage: {leaguetable, formtable, headtohead, …},
      xg: {home: {xgf, xga|null, src} | null, away: ...}  # Understat top-5 + FBref fallback}
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
