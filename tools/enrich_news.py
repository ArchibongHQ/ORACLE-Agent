"""enrich_news.py — per-team news + stats ensemble (Perplexity Sonar, Google AI
Mode, RSS, FotMob, Transfermarkt, Sofascore).

Runs against the day's UNIQUE teams (not per fixture-pair) — injury/suspension/
lineup/motivation/travel signal is team-level and opponent-independent, so this
avoids redundant queries and matches the `news` table's team_slug-keyed schema
(tools/daily_store.py). Reads the day's teams from the `fixtures` lake partition
that tools/acquire_daily.py just wrote — never re-scrapes fixtures itself.

Six source rows per team (additive — one source failing degrades to a skip, not
a block):
  - source="perplexity" — direct structured JSON, same prompt/shape as
    packages/llm/src/callNewsIntel.ts's buildPrompt/callSonar, reworded to a single
    team with no opponent framing (injuries/suspensions/lineup are opponent-
    independent). summary = short joined digest; raw_json = full structured object
    + citations. Falls back to swarm_dispatch.llm_extract_fallback (Kimi -> Haiku
    via Claude Code) when Sonar's response can't be JSON-fence-parsed.
  - source="google_ai"  — Playwright scrape of Google "AI Mode" (reuses
    tools/scrape_google_ai.py's browser/context helpers, one shared context for
    the whole batch — mirrors scrape_fixtures.run_playwright_scrapers). No LLM
    reshape step (Phase A scope, no new Python->Gemini dependency): summary is the
    raw scraped answer text (truncated); raw_json is the full scrape result. The
    engine's existing softContext consumers already read free-text news items, so
    unstructured prose is acceptable input here.
  - source="rss_news" — free, no-auth, no-anti-bot headline scan across BBC Sport
    Football, Sky Sports Football, and The Athletic's football RSS feeds (ESPN's
    RSS endpoints return an empty 202 bot-mitigation response — confirmed dead,
    excluded; see oracle_site_probe_findings memory). Plain stdlib XML parse, no
    Playwright. Per-team match: any feed item whose title/description contains the
    team name (case-insensitive substring) is attached as a headline. The Athletic
    is soft-paywalled — RSS only exposes headline+teaser text, never full article
    body, and this stays that way by design (no login/paywall-bypass attempted).
  - source="transfermarkt" — free, plain HTTP (tools/scrape_transfermarkt_live.py),
    squad list + per-player market value. Genuinely zero browser footprint, uses
    swarm_dispatch's thin-HTTP cap (8 local Windows / unbounded VPS).
  - source="fotmob" — free, Playwright headless response-interception
    (tools/fetch_fotmob.py) — plain HTTP 401s on FotMob's crypto-signed
    X-Fm-Req header, so a real browser computing it correctly is required.
    Uses swarm_dispatch's browser-page cap (4 local Windows / unbounded VPS).
  - source="sofascore" — free, Playwright NON-headless (tools/fetch_sofascore.py)
    — this is the one site in this codebase where headless itself fails a
    TLS/JS fingerprint check, not just the usual ORB-blocked-request issue.
    Needs a real display; degrades to no rows (not a crash) on a VPS without a
    virtual display (Xvfb) configured. Uses the same browser-page cap as FotMob.

Perplexity is COST-GATED by default (owner decision 2026-06-21): only teams in a
priority league or with high market depth (mirrors ORACLE_PRIORITY_LEAGUES +
the marketCount>=40 saturation point in packages/runtime/src/selectFixtures.ts)
get a Perplexity call by default — this keeps spend roughly flat vs. today's
~30-80/day analysis-time cap (newsIntel.ts MAX_JOBS), just moved earlier. Google AI
Mode, RSS, Transfermarkt, FotMob, and Sofascore are all free and always run for
the full slate. Use --perplexity-full-slate to lift the Perplexity gate, or
--no-perplexity / --limit to control cost further.

Usage:
    python tools/enrich_news.py --date 2026-06-21
    python tools/enrich_news.py --date 2026-06-21 --no-perplexity   # skip paid Sonar
    python tools/enrich_news.py --date 2026-06-21 --perplexity-full-slate
    python tools/enrich_news.py --date 2026-06-21 --limit 5         # cap teams (cost control)
    python tools/enrich_news.py --date 2026-06-21 --no-rss          # skip RSS headline scan
    python tools/enrich_news.py --date 2026-06-21 --no-fotmob --no-sofascore  # plain-HTTP sources only
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

from defusedxml import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))

import daily_store as ds
import scrape_google_ai as sgai
import swarm_dispatch as _swarm
import fetch_fotmob as _fotmob
import fetch_sofascore as _sofascore
import scrape_transfermarkt_live as _transfermarkt

ROOT = Path(__file__).resolve().parent.parent

PERPLEXITY_ENDPOINT = "https://api.perplexity.ai/chat/completions"
PERPLEXITY_MODELS = ["sonar-pro", "sonar"]
MIN_CONFIDENCE = 0.4
PERPLEXITY_PACE = 0.5  # seconds between calls — gentle, paid API

# Keep in sync with ORACLE_PRIORITY_LEAGUES in packages/runtime/src/selectFixtures.ts
PRIORITY_LEAGUES: frozenset[str] = frozenset({
    # Europe top flights
    "Premier League", "Championship", "La Liga", "Bundesliga", "Serie A",
    "Ligue 1", "Eredivisie", "Primeira Liga", "Belgian Pro League",
    "Scottish Premiership", "Urvalsdeild", "Eliteserien", "Swiss Super League",
    "Danish Superliga",
    # Europe lower divisions
    "2. Bundesliga", "Eerste Divisie", "OBOS-ligaen", "Swedish Division 1",
    "Swedish Division 2", "Danish 1. Division",
    "Regionalliga Bayern", "Regionalliga Nord", "Regionalliga Nordost",
    "Regionalliga Südwest", "Regionalliga West",
    # Asia / Oceania / Middle East
    "NPL Queensland", "NPL New South Wales", "NPL Victoria",
    "Singapore Premier League", "Malaysia Super League", "Qatar Stars League",
    # Americas
    "MLS", "USL League Two", "Bolivia Primera Division", "Liga MX",
    # Cups
    "Faroe Islands Cup", "Lithuanian Cup", "Estonian Cup",
    # Continental / global
    "Champions League", "Europa League", "Conference League",
    "J League", "FIFA World Cup",
})
# Mirrors the marketCount saturation point in selectFixtures.ts scoreFixture()
# (Math.min(marketCount, 40) / 40) — used here as the "high market depth" bar for
# non-priority-league teams to still qualify for a paid Perplexity call.
HIGH_MARKET_DEPTH = 40

SYSTEM_PROMPT = (
    "You are a football pre-match intelligence researcher. Search current sources "
    "for team news within 48 hours of this team's next match. Report ONLY confirmed, "
    "sourced facts — never speculate. Return ONLY valid JSON, no markdown."
)

_GOOGLE_AI_MODE = "https://www.google.com/search?udm=50&q={q}"

# Football-specific RSS feeds confirmed live 2026-06-28 (see oracle_site_probe_findings
# memory). ESPN's RSS endpoints return an empty 202 bot-mitigation response — excluded.
# The Athletic is soft-paywalled: RSS exposes headline+teaser only, never full article
# body — that limitation is inherent to the feed, not a bypass we're avoiding.
# FootballCritic returns 403 without a browser UA — wired in _DEDICATED_NEWS_FEEDS so
# it uses _RSS_HDR (same Chrome UA the others use); confirmed 200 with UA 2026-06-28.
# Olé Internacional follows a 301 redirect — urllib.request handles this natively.
_RSS_FEEDS: dict[str, str] = {
    "bbc_sport": "http://feeds.bbci.co.uk/sport/football/rss.xml",
    "sky_sports": "https://www.skysports.com/rss/0,20514,11095,00.xml",
    "the_athletic": "https://theathletic.com/football/?rss",
    "guardian_football": "https://www.theguardian.com/football/rss",
    "ole_internacional": "http://www.ole.com.ar/rss/futbol-internacional/",
}

# Dedicated lineup/squad-news feeds written under their OWN source names (not the
# generic "rss_news"), so newsIntel.ts can route them precisely: OneFootball →
# kind "lineup" (confirmed/predicted XI — the goals model cares about attacker
# availability), Evening Standard → kind "news" (World Cup squad / injury reportage).
# FootballCritic → kind "news" (global club/transfer/injury headlines, wide coverage).
_DEDICATED_NEWS_FEEDS: dict[str, str] = {
    "onefootball": "https://onefootball.com/en/rss",
    "evening_standard": "https://www.standard.co.uk/sport/football/rss",
    "footballcritic": "https://www.footballcritic.com/rss",
}
_RSS_HDR = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    )
}


def _load_env() -> dict[str, str]:
    """Mirror tools/fetch_lineups.py's manual .env loader (no python-dotenv dep)."""
    env: dict[str, str] = {}
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip().strip('"').strip("'")
    if "PERPLEXITY_API_KEY" in os.environ:
        env["PERPLEXITY_API_KEY"] = os.environ["PERPLEXITY_API_KEY"]
    if "KIMI_API_KEY" in os.environ:
        env["KIMI_API_KEY"] = os.environ["KIMI_API_KEY"]
    return env


def slug(team: str) -> str:
    out = [ch if ch.isalnum() else "_" for ch in team.lower().strip()]
    s = "".join(out)
    while "__" in s:
        s = s.replace("__", "_")
    return s.strip("_")


def teams_for_date(date_str: str) -> list[tuple[str, Optional[str], int]]:
    """Unique (team, league, market_count) from today's lake fixtures partition.
    league/market_count are best-effort context from the team's first-seen fixture
    (market_count takes the max across all of that team's fixtures today)."""
    fixtures = ds.read_table("fixtures", date_str)
    by_team: dict[str, tuple[Optional[str], int]] = {}
    for fx in fixtures:
        for side in ("home", "away"):
            name = fx.get(side)
            if not name:
                continue
            league = fx.get("league")
            mc = fx.get("market_count") or 0
            prev = by_team.get(name)
            if prev is None:
                by_team[name] = (league, mc)
            elif mc > prev[1]:
                by_team[name] = (prev[0] or league, mc)
    return [(name, league, mc) for name, (league, mc) in by_team.items()]


def is_perplexity_eligible(league: Optional[str], market_count: int) -> bool:
    if league and league in PRIORITY_LEAGUES:
        return True
    return market_count >= HIGH_MARKET_DEPTH


def _build_prompt(team: str, date_str: str) -> str:
    return f"""Find confirmed pre-match team news for: {team}, ahead of their next match on or after {date_str}.
Report only facts confirmed by reputable sources within 48h of the match.
Return ONLY this JSON shape:
{{
  "injuries": ["<player> — <status>"],
  "suspensions": ["<player> — suspended"],
  "lineupHints": ["<confirmed starter or formation note>"],
  "motivationFlags": ["<trophy chase / relegation battle / dead rubber / cup hangover>"],
  "travelFlags": ["<long travel or congested fixtures note>"],
  "confidence": 0.0
}}
confidence: 0.0 if no relevant news found, up to 1.0 if multiple confirmed reports. Empty arrays are fine."""


def _call_sonar(model: str, api_key: str, prompt: str) -> Optional[dict]:
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
    }).encode("utf-8")
    req = urllib.request.Request(
        PERPLEXITY_ENDPOINT,
        data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except Exception:
        return None


def fetch_perplexity(team: str, date_str: str, api_key: str, kimi_api_key: str = "") -> Optional[dict]:
    """Structured per-team news via Perplexity Sonar. None on failure/low confidence.
    If Sonar's response comes back but the expected JSON shape can't be parsed
    out of it (Sonar wrapped it in prose, changed its fence style, etc.), falls
    back to the swarm's Kimi-then-Haiku LLM extractor on that same raw content
    before giving up — a resilience layer over the deterministic parse, not a
    replacement for it (see tools/swarm_dispatch.py)."""
    prompt = _build_prompt(team, date_str)
    for model in PERPLEXITY_MODELS:
        data = _call_sonar(model, api_key, prompt)
        if not data:
            continue
        choices = data.get("choices") or []
        content = (choices[0].get("message", {}) if choices else {}).get("content")
        if not content:
            continue
        cleaned = content.replace("```json", "").replace("```", "").strip()
        start, end = cleaned.find("{"), cleaned.rfind("}")
        obj: Optional[dict] = None
        if start != -1 and end != -1:
            try:
                obj = json.loads(cleaned[start:end + 1])
            except ValueError:
                obj = None
        if obj is None:
            obj = _swarm.llm_extract_fallback(
                content,
                '{"injuries": [string], "suspensions": [string], "lineupHints": [string], '
                '"motivationFlags": [string], "travelFlags": [string], "confidence": float}',
                kimi_api_key,
            )
        if obj is None:
            continue
        try:
            confidence = max(0.0, min(1.0, float(obj.get("confidence", 0) or 0)))
        except (TypeError, ValueError):
            confidence = 0.0
        if confidence < MIN_CONFIDENCE:
            return None
        return {
            "injuries": obj.get("injuries") or [],
            "suspensions": obj.get("suspensions") or [],
            "lineupHints": obj.get("lineupHints") or [],
            "motivationFlags": obj.get("motivationFlags") or [],
            "travelFlags": obj.get("travelFlags") or [],
            "confidence": confidence,
            "sources": (data.get("citations") or [])[:10],
            "model": f"perplexity-{model}",
        }
    return None


async def _fetch_google_ai_batch(teams: list[str], date_str: str, max_workers: Optional[int] = None) -> dict[str, dict]:
    """One shared browser context, bounded concurrency — mirrors
    scrape_fixtures.run_playwright_scrapers' pattern instead of launching a fresh
    browser per team (which would be far slower for a whole-slate batch). Cap
    comes from swarm_dispatch.browser_swarm_max_workers (capped at 4 on local
    Windows — these are real Chromium pages, not thin HTTP workers; see that
    function's docstring for the 2026-06-23 BSOD incident this distinction
    fixes), effectively unbounded on a VPS (ORACLE_IS_VPS=true)."""
    out: dict[str, dict] = {}
    if not sgai.HAS_PLAYWRIGHT or not teams:
        return out

    cap = max_workers if max_workers is not None else _swarm.browser_swarm_max_workers(len(teams))

    async with sgai.async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=sgai._launch_args())
        ctx = await browser.new_context(
            user_agent=sgai._CHROME_UA,
            viewport={"width": 1280, "height": 900},
            locale="en-GB",
            extra_http_headers={"Accept-Language": "en-GB,en;q=0.9"},
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
        )
        sem = asyncio.Semaphore(cap)

        async def _one(team: str) -> None:
            async with sem:
                query = f"{team} team news injuries suspensions lineup {date_str}"
                url = _GOOGLE_AI_MODE.format(q=urllib.parse.quote_plus(query))
                try:
                    result = await sgai._scrape_url(ctx, url, 4000)
                    if result and result.get("text"):
                        out[team] = result
                except Exception:
                    pass

        await asyncio.gather(*(_one(t) for t in teams))
        await browser.close()
    return out


def _fetch_rss(url: str) -> list[dict]:
    """Fetch + parse one RSS 2.0 feed into [{title, link, pubDate, description}].
    Any failure (network, malformed XML) degrades to [] — never raises, mirrors
    the rest of this module's additive-source failure behaviour."""
    try:
        req = urllib.request.Request(url, headers=_RSS_HDR)
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
        root = ET.fromstring(raw)
        items: list[dict] = []
        for item in root.iter("item"):
            items.append({
                "title": (item.findtext("title") or "").strip(),
                "link": (item.findtext("link") or "").strip(),
                "pubDate": (item.findtext("pubDate") or "").strip(),
                "description": (item.findtext("description") or "").strip(),
            })
        return items
    except Exception:
        return []


def _fetch_all_rss_feeds() -> dict[str, list[dict]]:
    """One fetch per feed for the whole batch (not per-team) — feeds are
    slate-wide, matching against team name happens client-side per team."""
    out: dict[str, list[dict]] = {}
    for source_name, url in _RSS_FEEDS.items():
        items = _fetch_rss(url)
        if items:
            out[source_name] = items
    return out


def _rss_headlines_for_team(team: str, feeds: dict[str, list[dict]]) -> list[dict]:
    """Headline items across all fetched feeds whose title/description mentions
    `team` (case-insensitive substring — same matching precision as a human
    skimming headlines; team-name normalisation is intentionally out of scope
    here since RSS headlines use full club names, not SportyBet's short forms)."""
    needle = team.lower()
    hits: list[dict] = []
    for source_name, items in feeds.items():
        for it in items:
            haystack = f"{it['title']} {it['description']}".lower()
            if needle in haystack:
                hits.append({**it, "source": source_name})
    return hits


def _summary_from_structured(obj: dict) -> str:
    parts: list[str] = []
    for key in ("injuries", "suspensions", "lineupHints", "motivationFlags", "travelFlags"):
        parts.extend(obj.get(key) or [])
    return " | ".join(parts)[:1000] if parts else "no confirmed news"


def _summary_from_fotmob(captured: dict) -> str:
    """captured is {api_url: parsed_json} — heterogeneous by design (see
    fetch_fotmob.py). Best-effort: surface whatever counts are present rather
    than assume a fixed shape, since which endpoints fire depends on what the
    team page itself requests."""
    parts: list[str] = []
    for payload in captured.values():
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            parts.append(f"{len(payload['data'])} items")
    return f"FotMob: {', '.join(parts)}" if parts else "FotMob: data captured"


def _summary_from_transfermarkt(result: dict) -> str:
    squad = result.get("squad") or []
    values = [s["market_value"] for s in squad if s.get("market_value")]
    return f"Transfermarkt squad: {len(squad)} players, {len(values)} with market value"


def _summary_from_sofascore(result: dict) -> str:
    stats = result.get("stats") or {}
    return f"Sofascore: {len(stats)} stat streams captured"


def enrich(
    date_str: str,
    use_perplexity: bool = True,
    perplexity_full_slate: bool = False,
    use_google: bool = True,
    use_rss: bool = True,
    use_fotmob: bool = True,
    use_transfermarkt: bool = True,
    use_sofascore: bool = True,
    use_dedicated_news: bool = True,
    limit: Optional[int] = None,
    quiet: bool = False,
) -> list[dict]:
    env = _load_env()
    api_key = env.get("PERPLEXITY_API_KEY", "")
    kimi_api_key = env.get("KIMI_API_KEY", "")
    teams = teams_for_date(date_str)
    if limit is not None:
        teams = teams[:limit]
    team_names = [t[0] for t in teams]

    # Pre-run machine-health gate (owner instruction): before launching ANY
    # browser-page swarm (Google AI / FotMob / Sofascore), confirm the local box
    # is healthy enough. On an unhealthy/loaded local Windows machine we skip the
    # browser tier entirely (degrade to RSS + Transfermarkt thin-HTTP) rather than
    # risk the GPU-driver crash. On VPS the gate always passes. The thin-HTTP and
    # RSS sources are unaffected — only the three browser sources are gated.
    browser_ok, browser_reason = _swarm.browser_workload_health_gate()
    if not browser_ok:
        if not quiet:
            print(
                f"[enrich_news] browser-swarm health gate FAILED — {browser_reason}; "
                "skipping Google AI / FotMob / Sofascore this run",
                file=sys.stderr,
            )
        use_google = False
        use_fotmob = False
        use_sofascore = False
    elif not quiet:
        print(f"[enrich_news] browser-swarm health gate ok — {browser_reason}", flush=True)

    scraped_at = ds.utc_now_stamp()
    rows: list[dict] = []

    # Google AI Mode — free, full slate, one shared browser context.
    google_results: dict[str, dict] = {}
    if use_google:
        try:
            google_results = asyncio.run(_fetch_google_ai_batch(team_names, date_str))
        except Exception as exc:
            if not quiet:
                print(f"[enrich_news] google_ai batch failed: {exc}", file=sys.stderr)
    for team, scraped in google_results.items():
        rows.append({
            "dt": date_str, "team_slug": slug(team), "source": "google_ai",
            "summary": (scraped.get("text") or "")[:1000],
            "raw_json": json.dumps(scraped, ensure_ascii=False),
            "scraped_at": scraped_at,
        })

    # RSS headline scan (BBC Sport / Sky Sports / The Athletic) — free, no auth,
    # one fetch per feed for the whole slate, then matched per team client-side.
    if use_rss:
        feeds = _fetch_all_rss_feeds()
        rss_hits = 0
        for team in team_names:
            headlines = _rss_headlines_for_team(team, feeds)
            if not headlines:
                continue
            rss_hits += 1
            rows.append({
                "dt": date_str, "team_slug": slug(team), "source": "rss_news",
                "summary": " | ".join(h["title"] for h in headlines)[:1000],
                "raw_json": json.dumps(headlines, ensure_ascii=False),
                "scraped_at": scraped_at,
            })
        if not quiet:
            print(f"[enrich_news] rss feeds:{len(feeds)}/{len(_RSS_FEEDS)} teams_matched:{rss_hits}", flush=True)

    # Dedicated lineup/squad-news feeds (OneFootball, Evening Standard) — free,
    # no-auth RSS, one fetch per feed for the whole slate, matched per team. Written
    # under their OWN source name so newsIntel.ts routes them (OneFootball→lineup,
    # Evening Standard→news). Reuses the same RSS fetch + team-matcher as the
    # generic headline scan; a dead feed degrades to no rows, never blocks.
    if use_dedicated_news:
        for source_name, url in _DEDICATED_NEWS_FEEDS.items():
            items = _fetch_rss(url)
            if not items:
                if not quiet:
                    print(f"[enrich_news] {source_name} feed empty/unreachable", file=sys.stderr)
                continue
            feed_map = {source_name: items}
            matched = 0
            for team in team_names:
                headlines = _rss_headlines_for_team(team, feed_map)
                if not headlines:
                    continue
                matched += 1
                rows.append({
                    "dt": date_str, "team_slug": slug(team), "source": source_name,
                    "summary": " | ".join(h["title"] for h in headlines)[:1000],
                    "raw_json": json.dumps(headlines, ensure_ascii=False),
                    "scraped_at": scraped_at,
                })
            if not quiet:
                print(f"[enrich_news] {source_name} teams_matched:{matched}/{len(team_names)}", flush=True)

    # Transfermarkt — free, plain HTTP, full slate, thin-HTTP swarm cap
    # (genuinely zero browser footprint — see scrape_transfermarkt_live.py).
    if use_transfermarkt:
        try:
            tm_results = _transfermarkt.fetch_transfermarkt_batch(team_names)
        except Exception as exc:
            tm_results = {}
            if not quiet:
                print(f"[enrich_news] transfermarkt batch failed: {exc}", file=sys.stderr)
        for team, result in tm_results.items():
            rows.append({
                "dt": date_str, "team_slug": slug(team), "source": "transfermarkt",
                "summary": _summary_from_transfermarkt(result),
                "raw_json": json.dumps(result, ensure_ascii=False),
                "scraped_at": scraped_at,
            })
        if not quiet:
            print(f"[enrich_news] transfermarkt teams_matched:{len(tm_results)}/{len(team_names)}", flush=True)

    # FotMob — free, Playwright headless response-interception, full slate,
    # browser-page swarm cap (one shared browser context — see fetch_fotmob.py).
    if use_fotmob:
        try:
            fm_results = asyncio.run(_fotmob.fetch_fotmob_batch(team_names))
        except Exception as exc:
            fm_results = {}
            if not quiet:
                print(f"[enrich_news] fotmob batch failed: {exc}", file=sys.stderr)
        for team, result in fm_results.items():
            rows.append({
                "dt": date_str, "team_slug": slug(team), "source": "fotmob",
                "summary": _summary_from_fotmob(result),
                "raw_json": json.dumps(result, ensure_ascii=False),
                "scraped_at": scraped_at,
            })
        if not quiet:
            print(f"[enrich_news] fotmob teams_matched:{len(fm_results)}/{len(team_names)}", flush=True)

    # Sofascore — free, Playwright NON-headless (this site specifically fails
    # the TLS/JS fingerprint check in headless mode — see fetch_sofascore.py),
    # full slate, browser-page swarm cap. Needs a real display; degrades to {}
    # on a VPS without a virtual display (Xvfb) configured — never blocks.
    if use_sofascore:
        try:
            sf_results = asyncio.run(_sofascore.fetch_sofascore_batch(team_names))
        except Exception as exc:
            sf_results = {}
            if not quiet:
                print(f"[enrich_news] sofascore batch failed: {exc}", file=sys.stderr)
        for team, result in sf_results.items():
            rows.append({
                "dt": date_str, "team_slug": slug(team), "source": "sofascore",
                "summary": _summary_from_sofascore(result),
                "raw_json": json.dumps(result, ensure_ascii=False),
                "scraped_at": scraped_at,
            })
        if not quiet:
            print(f"[enrich_news] sofascore teams_matched:{len(sf_results)}/{len(team_names)}", flush=True)

    # Perplexity — paid, cost-gated to priority leagues / high market depth by default.
    if use_perplexity and api_key:
        eligible = [
            (team, league, mc) for team, league, mc in teams
            if perplexity_full_slate or is_perplexity_eligible(league, mc)
        ]
        for i, (team, _league, _mc) in enumerate(eligible):
            structured = fetch_perplexity(team, date_str, api_key, kimi_api_key)
            if i > 0:
                import time as _time
                _time.sleep(PERPLEXITY_PACE)
            if structured:
                rows.append({
                    "dt": date_str, "team_slug": slug(team), "source": "perplexity",
                    "summary": _summary_from_structured(structured),
                    "raw_json": json.dumps(structured, ensure_ascii=False),
                    "scraped_at": scraped_at,
                })
        if not quiet:
            print(f"[enrich_news] perplexity eligible:{len(eligible)}/{len(teams)} teams", flush=True)
    elif use_perplexity and not api_key and not quiet:
        print("[enrich_news] PERPLEXITY_API_KEY not set — skipping Perplexity, Google AI only", file=sys.stderr)

    ds.write_table("news", date_str, rows)
    if not quiet:
        print(f"[enrich_news] teams:{len(teams)} rows:{len(rows)}", flush=True)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="ORACLE per-team news ensemble -> Parquet lake")
    parser.add_argument("--date", default=None, help="YYYY-MM-DD (default: UTC today)")
    parser.add_argument("--no-perplexity", action="store_true", help="Skip the paid Perplexity Sonar call entirely")
    parser.add_argument("--perplexity-full-slate", action="store_true",
                        help="Lift the priority-league/market-depth cost gate — query every team")
    parser.add_argument("--no-google", action="store_true", help="Skip the free Google AI Mode scrape")
    parser.add_argument("--no-rss", action="store_true", help="Skip the free BBC/Sky/Athletic RSS headline scan")
    parser.add_argument("--no-fotmob", action="store_true", help="Skip the free FotMob stats scrape")
    parser.add_argument("--no-transfermarkt", action="store_true", help="Skip the free Transfermarkt squad/market-value scrape")
    parser.add_argument("--no-sofascore", action="store_true", help="Skip the free Sofascore stats scrape (needs a real display)")
    parser.add_argument("--no-dedicated-news", action="store_true", help="Skip the OneFootball + Evening Standard lineup/squad-news feeds")
    parser.add_argument("--limit", type=int, default=None, help="Cap the number of teams processed (cost control)")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    date_str = args.date or ds.utc_today()
    rows = enrich(
        date_str,
        use_perplexity=not args.no_perplexity,
        perplexity_full_slate=args.perplexity_full_slate,
        use_google=not args.no_google,
        use_rss=not args.no_rss,
        use_fotmob=not args.no_fotmob,
        use_transfermarkt=not args.no_transfermarkt,
        use_sofascore=not args.no_sofascore,
        use_dedicated_news=not args.no_dedicated_news,
        limit=args.limit,
        quiet=args.quiet,
    )
    print(f"enriched:{len(rows)}", flush=True)


if __name__ == "__main__":
    main()
