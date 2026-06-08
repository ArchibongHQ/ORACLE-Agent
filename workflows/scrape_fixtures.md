# SOP: Fixture Scraper

## Objective

Populate `.tmp/fixtures/today.txt` with today's fixture schedule from multiple sources, deduplicated and normalised to UTC ISO-8601. Runs automatically via the worker cron so `today.txt` is always fresh before the 9:00am batch reads it.

## Required Inputs

- Network access to all scraped sites
- Python 3.9+ with all deps: `pip install -r requirements.txt`
- Chromium browser for Playwright sites: `python -m playwright install chromium`
- `.tmp/fixtures/` directory (created automatically if absent)

## Cron Schedule

| Time (local) | Trigger | Purpose |
| --- | --- | --- |
| 00:00 | Standalone scrape | Overnight fixture additions |
| 06:00 | Standalone scrape | Morning refresh |
| 09:00 | Pre-step inside `runDailyBatch()` | Ensures today.txt is fresh before batch analysis |
| 11:45 | Standalone scrape | Mid-day refresh for CLI users |

The 9am scrape fires as the first step of `runDailyBatch()` in `apps/worker/src/index.ts`, not as a separate cron entry.

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
