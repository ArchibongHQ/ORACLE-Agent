"""enrich_news.py — Phase A per-team news ensemble (Perplexity Sonar + Google AI Mode).

Runs against the day's UNIQUE teams (not per fixture-pair) — injury/suspension/
lineup/motivation/travel signal is team-level and opponent-independent, so this
avoids redundant queries and matches the `news` table's team_slug-keyed schema
(tools/daily_store.py). Reads the day's teams from the `fixtures` lake partition
that tools/acquire_daily.py just wrote — never re-scrapes fixtures itself.

Two source rows per team (additive — one source failing degrades to a skip, not a
block):
  - source="perplexity" — direct structured JSON, same prompt/shape as
    packages/llm/src/callNewsIntel.ts's buildPrompt/callSonar, reworded to a single
    team with no opponent framing (injuries/suspensions/lineup are opponent-
    independent). summary = short joined digest; raw_json = full structured object
    + citations.
  - source="google_ai"  — Playwright scrape of Google "AI Mode" (reuses
    tools/scrape_google_ai.py's browser/context helpers, one shared context for
    the whole batch — mirrors scrape_fixtures.run_playwright_scrapers). No LLM
    reshape step (Phase A scope, no new Python->Gemini dependency): summary is the
    raw scraped answer text (truncated); raw_json is the full scrape result. The
    engine's existing softContext consumers already read free-text news items, so
    unstructured prose is acceptable input here.

Perplexity is COST-GATED by default (owner decision 2026-06-21): only teams in a
priority league or with high market depth (mirrors ORACLE_PRIORITY_LEAGUES +
the marketCount>=40 saturation point in packages/runtime/src/selectFixtures.ts)
get a Perplexity call by default — this keeps spend roughly flat vs. today's
~30-80/day analysis-time cap (newsIntel.ts MAX_JOBS), just moved earlier. Google AI
Mode (free) always runs for the full slate. Use --perplexity-full-slate to lift the
gate, or --no-perplexity / --limit to control cost further.

Usage:
    python tools/enrich_news.py --date 2026-06-21
    python tools/enrich_news.py --date 2026-06-21 --no-perplexity   # Google AI only (free)
    python tools/enrich_news.py --date 2026-06-21 --perplexity-full-slate
    python tools/enrich_news.py --date 2026-06-21 --limit 5         # cap teams (cost control)
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

sys.path.insert(0, str(Path(__file__).resolve().parent))

import daily_store as ds
import scrape_google_ai as sgai

ROOT = Path(__file__).resolve().parent.parent

PERPLEXITY_ENDPOINT = "https://api.perplexity.ai/chat/completions"
PERPLEXITY_MODELS = ["sonar-pro", "sonar"]
MIN_CONFIDENCE = 0.4
PERPLEXITY_PACE = 0.5  # seconds between calls — gentle, paid API

# Keep in sync with ORACLE_PRIORITY_LEAGUES in packages/runtime/src/selectFixtures.ts
PRIORITY_LEAGUES: frozenset[str] = frozenset({
    "Premier League", "Championship", "La Liga", "Bundesliga", "Serie A",
    "Ligue 1", "Eredivisie", "Primeira Liga", "Belgian Pro League",
    "Scottish Premiership", "Champions League", "Europa League",
    "Conference League", "J League", "MLS", "FIFA World Cup",
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


def fetch_perplexity(team: str, date_str: str, api_key: str) -> Optional[dict]:
    """Structured per-team news via Perplexity Sonar. None on failure/low confidence."""
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
        if start == -1 or end == -1:
            continue
        try:
            obj = json.loads(cleaned[start:end + 1])
        except ValueError:
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


async def _fetch_google_ai_batch(teams: list[str], date_str: str, max_workers: int = 4) -> dict[str, dict]:
    """One shared browser context, bounded concurrency — mirrors
    scrape_fixtures.run_playwright_scrapers' pattern instead of launching a fresh
    browser per team (which would be far slower for a whole-slate batch)."""
    out: dict[str, dict] = {}
    if not sgai.HAS_PLAYWRIGHT or not teams:
        return out

    is_local_windows = sys.platform == "win32" and os.environ.get("ORACLE_IS_VPS", "").lower() != "true"
    cap = 4 if is_local_windows else max_workers

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


def _summary_from_structured(obj: dict) -> str:
    parts: list[str] = []
    for key in ("injuries", "suspensions", "lineupHints", "motivationFlags", "travelFlags"):
        parts.extend(obj.get(key) or [])
    return " | ".join(parts)[:1000] if parts else "no confirmed news"


def enrich(
    date_str: str,
    use_perplexity: bool = True,
    perplexity_full_slate: bool = False,
    use_google: bool = True,
    limit: Optional[int] = None,
    quiet: bool = False,
) -> list[dict]:
    env = _load_env()
    api_key = env.get("PERPLEXITY_API_KEY", "")
    teams = teams_for_date(date_str)
    if limit is not None:
        teams = teams[:limit]
    team_names = [t[0] for t in teams]

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

    # Perplexity — paid, cost-gated to priority leagues / high market depth by default.
    if use_perplexity and api_key:
        eligible = [
            (team, league, mc) for team, league, mc in teams
            if perplexity_full_slate or is_perplexity_eligible(league, mc)
        ]
        for i, (team, _league, _mc) in enumerate(eligible):
            structured = fetch_perplexity(team, date_str, api_key)
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
    parser.add_argument("--limit", type=int, default=None, help="Cap the number of teams processed (cost control)")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    date_str = args.date or ds.utc_today()
    rows = enrich(
        date_str,
        use_perplexity=not args.no_perplexity,
        perplexity_full_slate=args.perplexity_full_slate,
        use_google=not args.no_google,
        limit=args.limit,
        quiet=args.quiet,
    )
    print(f"enriched:{len(rows)}", flush=True)


if __name__ == "__main__":
    main()
