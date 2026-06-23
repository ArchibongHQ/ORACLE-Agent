# SOP: Fixture Scraper

## Objective

Populate `.tmp/fixtures/today.txt` with today's fixture schedule from multiple sources, deduplicated and normalised to UTC ISO-8601. Runs automatically via the worker cron so `today.txt` is always fresh before the 6:00am batch reads it.

## Required Inputs

- Network access to all scraped sites
- Python 3.9+ with all deps: `pip install -r requirements.txt`
- Chromium browser for Playwright sites: `python -m playwright install chromium`
- `.tmp/fixtures/` directory (created automatically if absent)

## Cron Schedule

| Time (local) | Trigger | Purpose |
| --- | --- | --- |
| 00:00 | Standalone scrape | Overnight fixture additions |
| 06:00 | Pre-step inside `runDailyBatch()` | Ensures today.txt is fresh before batch analysis |
| 11:45 | Standalone scrape | Mid-day refresh for CLI users |

The 6am scrape fires as the first step of `runDailyBatch()` in `apps/worker/src/index.ts`, not as
a separate cron entry — a standalone 06:00 scrape was removed when the daily batch moved to that
exact time, since both running at once raced the same `sportybet_today.json` write.

## Manual Run

```bash
# Scrape today (UTC)
python tools/scrape_fixtures.py

# Scrape a specific date
python tools/scrape_fixtures.py --date 2026-06-10

# Dry run — print results without writing to today.txt
python tools/scrape_fixtures.py --dry-run

# Skip Playwright scrapers (faster, ESPN + Sky Sports + BBC only)
python tools/scrape_fixtures.py --no-playwright

# Quiet — suppress log output
python tools/scrape_fixtures.py --quiet
```

## Output Format

`.tmp/fixtures/today.txt` — one fixture per line:

```text
Arsenal vs Chelsea, Premier League, 2026-06-07T15:00:00Z
FC Tokyo vs Cerezo Osaka, J League, 2026-06-07T05:00:00Z
```

## Sources

Sources run in order. All failures are non-fatal — a failed source is skipped with a WARN log.

| Source | Method | Status | Timezone | Notes |
| --- | --- | --- | --- | --- |
| **ESPN** | stdlib urllib, JSON API | ✅ Working | UTC | Primary; all 16 ORACLE leagues; no key |
| **Sky Sports** | requests, HTML entity JSON | ✅ Working | BST/GMT | Best on UK match days |
| **LiveScore** | requests, REST API | ✅ Working | UTC (Unix ts) | `prod-cdn-mev-api.livescore.com/api/v2/date` — no browser needed |
| **BBC Sport** | Playwright, screen-reader spans | ✅ Working | BST/GMT | "X versus Y kick off H:MM" pattern; date-specific URL |
| **Flashscore** | Playwright, JS DOM walk | ✅ Working | CET/CEST | Widest coverage; `headerLeague__wrapper` + `aria-label` |
| **BetExplorer** | Playwright, table DOM | ✅ Working | CET/CEST | Date URL `?yr=&mo=&dy=`; `js-tournament` league headers |
| **365Scores** | Playwright + `__INITIAL_STATE__` | ⚠️ Partial | CET/CEST | Returns 0 on quiet days; `window.__INITIAL_STATE__` not populated |
| **OneFootball** | Playwright + `__NEXT_DATA__` | ⚠️ Partial | UTC | Competition-specific URL; generalise when daily feed found |
| **SportyBet** | Playwright, JS state + DOM | ✅ Working | WAT (UTC+1) | Nigeria `/today` URL; DOM walk fallback; timezone fixed to WAT |
| **WhoScored** | Playwright | ❌ Blocked | BST/GMT | Cloudflare JS challenge — returns [] |

### ESPN League Slugs

| Slug | ORACLE League |
| --- | --- |
| `eng.1` | Premier League |
| `eng.2` | Championship |
| `esp.1` | La Liga |
| `ger.1` | Bundesliga |
| `ita.1` | Serie A |
| `fra.1` | Ligue 1 |
| `ned.1` | Eredivisie |
| `por.1` | Primeira Liga |
| `bel.1` | Belgian Pro League |
| `sco.1` | Scottish Premiership |
| `uefa.champions` | Champions League |
| `uefa.europa` | Europa League |
| `uefa.europa.conf` | Conference League |
| `jpn.1` | J League |
| `usa.1` | MLS |
| `fifa.world` | World Cup |

All 16 leagues fetched in parallel via `ThreadPoolExecutor(max_workers=4)`.

## Deduplication

Two fixtures are the same if their normalised dedup key matches:

```python
key = f"{normalise(home)}_vs_{normalise(away)}_{YYYY-MM-DD}"
```

`normalise()` lowercases, strips common suffixes (FC, AFC, SC, etc.), strips punctuation, and collapses whitespace. Existing lines in `today.txt` are preserved; only genuinely new fixtures are appended.

**Cross-source name variance**: Different providers use slightly different team names (e.g. "Yokohama F Marinos" vs "Yokohama F. Marinos"). Normalisation catches most cases. For mismatches that slip through, the batch analysis will process each as a separate fixture — the Odds API entry (with odds) takes precedence.

## Timezone Handling

- **ESPN**: UTC natively — no conversion needed
- **Sky Sports / BBC Sport / WhoScored**: BST (UTC+1, April–October) or GMT (UTC, November–March)
- **Flashscore / BetExplorer / 365Scores**: CEST (UTC+2, April–October) or CET (UTC+1, November–March)
- **LiveScore**: UTC natively (Unix timestamps from API)
- **SportyBet**: WAT (UTC+1, year-round, no DST)
- **OneFootball**: UTC natively (Next.js SSR)

Timezone offsets are approximated by calendar month. Daylight saving transitions mid-month may cause a 1-hour error on transition days (rare, acceptable).

## Edge Cases & Known Constraints

| Scenario | Behaviour |
| --- | --- |
| Off-season (no matches today) | ESPN returns 0; today.txt retains its last content |
| ESPN 429 / timeout | That league skipped with WARN; others continue |
| Sky Sports / BBC HTML structure change | Parser fails gracefully; other sources still run |
| WhoScored Cloudflare challenge | Detected by page title; returns [] immediately |
| Playwright not installed | Warning printed; falls back to ESPN + Sky Sports + BBC |
| `requests` not installed | Sky Sports and BBC silently skipped |
| Scrape failure in worker | `scrapeFixtures()` always resolves (non-fatal); batch continues with existing today.txt |
| Playwright sites redesign selectors | Returns [] gracefully; other sources still written |

## WhoScored Note

WhoScored uses Cloudflare with JavaScript fingerprinting. Standard Playwright (even with `AutomationControlled` disabled) is detected and served a challenge page. The scraper checks the page title and returns `[]` immediately. If future versions of `playwright-stealth` or Cloudflare bypass tools become available, this can be wired in as a drop-in replacement.

## Per-Fixture Stats Enrichment (`_fetch_fixture_detail`)

Separate from the fixture-listing scrape above: once a fixture is on `today.txt`, `_fetch_fixture_detail(event_id)` enriches it with odds + stats via SportyBet's underlying Sportradar gismo API. This is a different mechanism from the multi-source scrape and runs per-fixture, not once-daily.

**First-attempt data-acquisition mechanism (mandatory ordering):** Always call the **no-auth gismo host first** — `stats.fn.sportradar.com/sportybet/en/Etc:UTC/gismo/{query}` via plain `urllib.request` with just `_SB_HDR` (a `User-Agent` string, no token). This is what `_sb_get()`/`_gismo_doc()` already do for every call in `_fetch_fixture_detail()`. Only fall back to the SIR-widget-token-harvest technique (see `/sportybet-stats-probe` skill) if a query is later found that the no-auth host doesn't serve — to date (2026-06-23), every gismo query probed (including the new possession/corners endpoints below) returns identical data from both hosts, so the token-harvest path has never actually been needed in production and should stay a documented fallback, not the default.

Calls 10 and 11 (added 2026-06-23) extend the existing 9-call pipeline:

| # | Endpoint | Parser | Output key |
| --- | --- | --- | --- |
| 10 | `gismo/stats_season_uniqueteamstats/{season_id}` | `_parse_possession_value()` | `stats.possessionValue.{home,away}` — shots_on_target_avg, shots_off_target_avg, shots_blocked_avg, corners_avg, possession_pct_avg |
| 11 | `gismo/stats_team_lastxextended/{home_id}` and `/{away_id}` | `_parse_recent_form_corners()` | `stats.recentCorners.{home,away}` — avg corners won, last 5 matches |

**No real xG field exists anywhere in SportyBet/Sportradar's gismo API** (confirmed via non-headless Playwright capture of the Sportradar SIR widget, 93 captured responses, 2026-06-23 — see memory `oracle_sportybet_possession_value_endpoints.md`). `shots_on_target_avg` + `shots_off_target_avg` from endpoint #10 is the closest available shot-volume proxy for xG, and feeds the engine's possession-value feature-store work as such — it is NOT real xG and must not be relabelled as one downstream.

Endpoint #10 is keyed by team **`_id`** (matching `home_id`/`away_id` from `match_info`, NOT `home_uid`/`away_uid` — confirmed live 2026-06-23; this differs from `stats_season_overunder`, which is `uid`-keyed — see that function's docstring for the contrasting gotcha). Endpoint #11's per-match `corners` field is `{home, away}` keyed by venue, not by queried side — the parser matches each match's `teams.home/away._id` against the queried team id to pick the right side.

## Generic All-Markets Capture (`_parse_all_markets`, added 2026-06-23)

A single live SportyBet fixture carries 900+ markets in its `markets[]` array (machine-verified: 951 on `sr:match:66457034`, Portugal vs Uzbekistan). `_parse_all_markets()` captures EVERY market unconditionally into `odds.allMarkets` — id, name, desc, group, specifier, outcomes (each outcome's `desc` is already a human-readable label straight from the API, e.g. "Over 1.5", "Yes"). This is layered on top of, not instead of, the existing 10 hand-picked typed fields and the new `_parse_half_markets()` typed accessors for named exotics users actually reference by name (Win Either Half, Both Halves Over/Under X.5, 1st/2nd-half O/U — exact market IDs in that function's docstring). Three tiers, one shared `markets_payload`, zero extra fetches.

## New Stats Sources (probed + wired 2026-06-23)

Per-team supplementary stats sources, each a standalone `tools/fetch_*.py` / `tools/scrape_*.py` module (not part of the fixture-listing scrape above — called separately, same "never blocks, degrades to None" convention):

| Source | Tool | Method | Status | Notes |
| --- | --- | --- | --- | --- |
| **FotMob** | `tools/fetch_fotmob.py` | Playwright headless, response interception | ✅ Working | Plain HTTP 401s — FotMob added a crypto-signed `X-Fm-Req` header (~Oct 2024) that a real browser computes correctly but bare `requests` can't replicate without reverse-engineering the secret (the `soccerdata` library removed FotMob support over this rather than maintain a workaround). Team-ID resolved via the site's own rendered search page, then the team-overview page's own API calls are intercepted. |
| **Transfermarkt** | `tools/scrape_transfermarkt_live.py` | Plain `requests`, no auth | ✅ Working | Genuinely zero browser/GPU footprint — distinct from `tools/fetch_transfermarkt.py` (the historical Kaggle-CSV-based GBM-feature builder; same site, different purpose, don't confuse the two). Team search ranks by an opaque relevance order, NOT a name match — filter candidates by checking the result's display label actually contains the query (live-verified: searching "Arsenal" returns unrelated "SD Tenisca" before "Arsenal FC"). |
| **Sofascore** | `tools/fetch_sofascore.py` | Playwright **non-headless** (`headless=False`), response interception | ✅ Working | `api.sofascore.com` 403s even through Playwright in headless mode — this is the one site in this codebase where headless itself fails a TLS/JS fingerprint check, not just the usual ORB-blocked-request issue `--disable-blink-features` fixes everywhere else. Team search has no working API either (also 403s) — resolved via the site's own rendered search box, reading result links straight out of the DOM after typing. Captures events/last, events/next, standings/seasons live; player-statistics/seasons needs a separate tab click, not currently captured. |
| **FBref** | — | — | ❌ Blocked | Genuine interactive Cloudflare challenge (identical ~27.6KB "Just a moment..." shell in headless AND non-headless). Not bypassed — CAPTCHA-class block, out of scope per owner's "probe, don't bypass" constraint. |
| **footystats.org** | — | — | ❌ Blocked | Same Cloudflare challenge as FBref. |
| **ESPN FC (RSS)** | — | — | ❌ Blocked | RSS endpoints return HTTP 202 with an empty body (bot-mitigation gate) on every URL variant tried. ESPN's JSON fixture API (used elsewhere in this same file for fixture listing) is unaffected — only the RSS news feed is blocked. |
| **WhoScored `/Fixtures`** | — | — | ❌ Blocked (path-specific) | A fake-200 fingerprint-script gate (`cx-resources.oddschecker.com/fingerprint/verify-client.js`), not a visible Cloudflare challenge — distinct from this file's existing `WhoScoredScraper` Cloudflare-challenge finding above. Notably NOT site-wide: `/Teams/.../Show/...` pages load fine in both headless modes — an unexploited source for team-level data if ever prioritised. |

The Athletic, Sky Sports, and BBC Sport are wired as RSS sources in `tools/enrich_news.py` (`source="rss_news"`), not here — see `workflows/news_intel.md`.

## Scrape Swarm (Kimi → Haiku fallback, added 2026-06-23)

`tools/swarm_dispatch.py` provides shard fan-out + an LLM extraction-fallback layer for both this scraper and `enrich_news.py`. The LLM is a resilience layer over the existing deterministic fetch code (invoked only when a shard's deterministic parse comes back empty — selector or schema drift), not a replacement for it; the urllib/Playwright fetch code is unchanged and still does 100% of the actual HTTP/browser work.

Two SEPARATE concurrency-cap functions — do not conflate them:

- `swarm_max_workers(n)` — thin, network-only shards (plain HTTP fetch, LLM-fallback call). Capped at 8 on local Windows, one worker per shard on a VPS (`ORACLE_IS_VPS=true`).
- `browser_swarm_max_workers(n)` — Playwright/browser-page shards (real Chromium renderer process per worker). Capped at 4 on local Windows, one worker per shard on a VPS.

**Why two functions, not one:** reusing the thin-worker cap (8) for a browser-page workload caused two real BSODs (`0x50`/`0x3B`) within ~10 minutes on this box's integrated GPU — see memory `oracle_swarm_gpu_bsod_incident`. Any new concurrency-tuned call site must pick the correct one for its workload type; if a third workload class is ever added (e.g. a heavier per-worker subprocess), give it its own cap function rather than reusing either of these.

LLM extraction fallback cascade (`llm_extract_fallback`): Kimi K2.6 (Moonshot API, `KIMI_API_KEY`) first, then the local Claude Code CLI pinned to `--model haiku` (free, no network dependency) as fallback, then `None`. Haiku is appropriate here specifically because this is data-extraction, not analysis/decision-making — the codebase's "Opus/Fable only" rule (`packages/llm/src/callClaudeCode.ts`) is scoped to the decision layer, not the acquisition layer.
