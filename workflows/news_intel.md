# SOP: News Intelligence Enrichment

## Objective

Populate the `news` Parquet lake table (`tools/daily_store.py`) with per-team pre-match intelligence — injuries, suspensions, lineup hints, motivation/travel flags, and general headlines — for every unique team in today's fixture slate. Runs after `tools/acquire_daily.py` writes the day's `fixtures` partition; never re-scrapes fixtures itself.

## Required Inputs

- `.tmp/oracle-daily/fixtures/{date}/` partition already written (by `acquire_daily.py`)
- `PERPLEXITY_API_KEY` in `.env` (optional — paid, cost-gated; missing key degrades to Google AI + RSS only, never blocks)
- `KIMI_API_KEY` in `.env` (optional — swarm LLM-extraction fallback; missing key degrades to the local Claude Code CLI fallback, then to skipping that one shard)
- Chromium for the Google AI Mode Playwright path: `python -m playwright install chromium`

## Manual Run

```bash
python tools/enrich_news.py --date 2026-06-21
python tools/enrich_news.py --date 2026-06-21 --no-perplexity      # skip paid Sonar
python tools/enrich_news.py --date 2026-06-21 --perplexity-full-slate
python tools/enrich_news.py --date 2026-06-21 --limit 5            # cap teams (cost control)
python tools/enrich_news.py --date 2026-06-21 --no-rss             # skip RSS headline scan
python tools/enrich_news.py --date 2026-06-21 --no-google          # skip Google AI Mode
python tools/enrich_news.py --date 2026-06-21 --no-fotmob          # skip FotMob
python tools/enrich_news.py --date 2026-06-21 --no-transfermarkt   # skip Transfermarkt
python tools/enrich_news.py --date 2026-06-21 --no-sofascore       # skip Sofascore (needs a real display)
```

## Sources

Additive — one source failing degrades that row to a skip, never a block. All rows share the shape `{dt, team_slug, source, summary, raw_json, scraped_at}`. Live-tested 2026-06-23 against today's real fixture slate (Portugal vs Uzbekistan) — all four free sources produced real rows: RSS 1/2 teams matched, Transfermarkt 2/2, FotMob 1/2, Sofascore 2/2.

| Source | Method | Cost | Coverage | Notes |
| --- | --- | --- | --- | --- |
| **Perplexity Sonar** | HTTPS API, structured JSON | Paid | Cost-gated: priority leagues OR market_count ≥ 40 (lift with `--perplexity-full-slate`) | Falls back to `swarm_dispatch.llm_extract_fallback` (Kimi → Haiku) if Sonar's response can't be JSON-fence-parsed, before giving up on that team |
| **Google AI Mode** | Playwright, shared browser context | Free | Full slate, always runs | One shared context, bounded concurrency via `swarm_dispatch.browser_swarm_max_workers` (4 local Windows / unbounded VPS) — NOT the thin-worker cap, see `workflows/scrape_fixtures.md`'s swarm section |
| **RSS headline scan** (`source="rss_news"`) | stdlib XML parse, no auth | Free | Full slate | BBC Sport Football, Sky Sports Football, The Athletic football feeds — confirmed live 2026-06-23. Per-team match: any feed item whose title/description contains the team name (case-insensitive substring) |
| **Transfermarkt** (`source="transfermarkt"`) | Plain `requests`, no browser | Free | Full slate | `tools/scrape_transfermarkt_live.py`'s `fetch_transfermarkt_batch()` — `ThreadPoolExecutor`, thin-HTTP swarm cap (`swarm_max_workers`, 8 local / unbounded VPS) |
| **FotMob** (`source="fotmob"`) | Playwright headless, response interception | Free | Full slate | `tools/fetch_fotmob.py`'s `fetch_fotmob_batch()` — ONE shared browser context (not one browser per team — that would recreate the BSOD incident), browser-page swarm cap (`browser_swarm_max_workers`, 4 local / unbounded VPS) |
| **Sofascore** (`source="sofascore"`) | Playwright **non-headless**, response interception | Free | Full slate | `tools/fetch_sofascore.py`'s `fetch_sofascore_batch()` — same shared-context pattern as FotMob, but needs a real display (`headless=False` is required for this site specifically — see that module's docstring). Degrades to zero rows (not a crash) on a VPS without a virtual display (Xvfb) configured |

### RSS feed URLs

Generic (`_RSS_FEEDS` → `source="rss_news"` → LLM kind `news`):

| Feed | URL | Status |
| --- | --- | --- |
| BBC Sport | `http://feeds.bbci.co.uk/sport/football/rss.xml` | ✅ Working |
| Sky Sports | `https://www.skysports.com/rss/0,20514,11095,00.xml` | ✅ Working |
| The Athletic | `https://theathletic.com/football/?rss` | ✅ Working — soft-paywalled: headline+teaser text only, never full article body. This is the feed's own limitation, not a bypass being deliberately avoided — login/paywall-bypass is out of scope by design |
| The Guardian (Football) | `https://www.theguardian.com/football/rss` | ✅ Working — confirmed 200 2026-06-28; high-quality injury/squad/tactical reportage |
| Olé Internacional | `http://www.ole.com.ar/rss/futbol-internacional/` | ✅ Working — follows 301 redirect; covers La Liga/Serie A/Bundesliga; useful for motivation/Copa America hangover signals |
| ESPN FC | — | ❌ Blocked — every URL variant tried returns HTTP 202 with an empty body (bot-mitigation gate). Excluded from `_RSS_FEEDS`. ESPN's JSON fixture API (used in `scrape_fixtures.py` for fixture listing) is unaffected — only the news RSS feed is blocked |

Dedicated (`_DEDICATED_NEWS_FEEDS` → own `source` name → routed to specific LLM kind):

| Feed | Source key | LLM kind | URL | Status |
| --- | --- | --- | --- | --- |
| OneFootball | `onefootball` | `lineup` | `https://onefootball.com/en/rss` | ✅ Working |
| Evening Standard | `evening_standard` | `news` | `https://www.standard.co.uk/sport/football/rss` | ✅ Working |
| FootballCritic | `footballcritic` | `news` | `https://www.footballcritic.com/rss` | ✅ Working — requires Chrome UA header (returns 403 without); `_fetch_rss` sends `_RSS_HDR` globally; confirmed 200 2026-06-28; wide global club/transfer/injury coverage |

## Cost Gate (Perplexity)

Owner decision 2026-06-21: only teams in a priority league (mirrors `ORACLE_PRIORITY_LEAGUES`) or with market_count ≥ 40 (mirrors `selectFixtures.ts`'s saturation point) get a Perplexity call by default — keeps spend roughly flat vs. the old analysis-time cap, just moved earlier in the pipeline. `--perplexity-full-slate` lifts the gate; `--no-perplexity` / `--limit` control cost further.

## Swarm / Concurrency

See `workflows/scrape_fixtures.md`'s "Scrape Swarm" section for the full `tools/swarm_dispatch.py` design (two separate concurrency-cap functions for thin-HTTP vs. browser-page workloads, and the Kimi→Haiku LLM extraction-fallback cascade). Five call sites in `enrich_news.py` use it: Google AI Mode batch, FotMob batch, Sofascore batch (all `browser_swarm_max_workers` or its thin-HTTP equivalent), Transfermarkt batch (`swarm_max_workers`), and Perplexity's fallback-extraction call (`llm_extract_fallback`).

The three new browser-page batches (Google AI, FotMob, Sofascore) run SEQUENTIALLY inside `enrich()` — each is its own `async with async_playwright()` block that fully launches, runs, and closes its browser before the next one starts. This is safe by construction: there is never more than one browser-page swarm's worth of concurrent Chromium load at a time, even though three separate batches happen during one `enrich_news.py` invocation. Do not parallelize these three blocks against each other without re-deriving the GPU math — see `oracle_swarm_gpu_bsod_incident` memory for why that matters on this box.

## LLM Decision-Layer Wiring

All six sources reach the LLM's soft-context prompt via `packages/runtime/src/newsIntel.ts`'s `lakeRowToSoftContext()`: `perplexity` → structured `injury`/`lineup`/`motivation`/`news` items; `google_ai`/`rss_news` → a single `news` item (raw summary text); `transfermarkt`/`fotmob`/`sofascore` → a single `stats` item (the same soft-context kind `sportyBetStats.ts`'s `buildStatsSoftContext` uses for SportyBet sidecar stats). A row with an empty `summary` or an unrecognised `source` string maps to `[]` — silently inert, not an error. Before adding a 7th source, add its branch here too, or its lake rows will be written but never seen by the LLM (this exact gap existed for `rss_news` until 2026-06-23 — it was being written since the RSS feeds shipped but had no `lakeRowToSoftContext` branch until this same pass added the three newer sources).

## Edge Cases & Known Constraints

| Scenario | Behaviour |
| --- | --- |
| `PERPLEXITY_API_KEY` missing | Perplexity skipped entirely, Google AI + RSS still run — never a block |
| `KIMI_API_KEY` missing | `llm_extract_fallback` falls through to the local Claude Code CLI (`--model haiku`) automatically |
| Local `claude` CLI missing/not on PATH | `llm_extract_fallback` returns `None` for that shard — that team's Perplexity row is skipped, not a block |
| Sonar response not valid JSON | Falls back to LLM extraction on the same raw content before giving up |
| Playwright not installed | Google AI Mode batch returns `{}`; RSS + Perplexity (if eligible) still run |
| RSS feed unreachable | That feed skipped; other feeds + sources still run |
| `confidence < MIN_CONFIDENCE` (0.4) on a Perplexity result | That team's Perplexity row is dropped (treated as no real signal), Google AI/RSS rows for that team are unaffected |
