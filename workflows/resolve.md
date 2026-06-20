# SOP: Resolution Run

## Objective
For each fixture analysed yesterday (or a specified date), fetch the actual result,
compute RPS and realised CLV, and write a `ResolutionRecord` to GBrain. This is the
primary scored-history accumulation step that feeds calibration (§8.3) and SkillOpt (§8.5).

## When to run
Scheduled: `14:00 daily` (worker cron, `resolveYesterdayFixtures()`).
Manual: `node apps/worker/dist/index.js --run-now` (triggers batch then resolution).

## Required inputs
- `API_FOOTBALL_KEY` in `.env` — primary result source, broad league coverage (see below)
- `FOOTBALL_DATA_API_KEY` in `.env` — fallback result source, narrow league coverage but any date
- At least one of the two above must be set; both is recommended
- `ODDS_API_KEY` in `.env` (optional) — for realised CLV computation; omit for calibration-only
- Analysis records in GBrain ledger with `kickoff` dates matching the target date

## Steps

1. **Load analysis records** for target date (`kickoff.startsWith(YYYY-MM-DD)`) from `STORAGE_KEYS.analysisRecords`
2. **Fetch match results** — tries two sources in order (see "Result Source: API-Football
   primary, football-data.org fallback" below for why both exist):
   - **Primary:** API-Football `/fixtures?date=YYYY-MM-DD&status=FT` — one request, all leagues
   - **Fallback:** football-data.org `/matches?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&status=FINISHED`
     (date padded ±1 day — the free tier unreliably returns 0 results for a same-day window
     even when matches exist on that exact date; `findMatch` still filters back to the
     exact kickoff date) — used only when API-Football found nothing for the date
3. **Match fixtures** by fuzzy home/away team name (`namesMatch()` in `teamNames.ts` — the
   shared, alias-aware matcher also used by `oddsProviders.ts`; do not reimplement locally)
4. **Compute RPS** for each resolved fixture using stored `probabilities` vs actual outcome
5. **Fetch closing odds** from the Odds API (if key present) for CLV-eligible leagues; tag as `KICKOFF_PROXY` (§8.3)
6. **Compute realised CLV**: `(modelOdds / closingOdds) - 1`; set `clvSourceQuality` accordingly
7. **Write** `ResolutionRecord` to `STORAGE_KEYS.resolutionRecords` via `upsertBulk` on `fixtureId`

## Result Source: API-Football primary, football-data.org fallback

football-data.org's free tier only covers ~10 major leagues + the World Cup
(`_LEAGUE_TO_COMPETITION`/`LEAGUE_TO_SPORT` in `resolveFixtures.ts`) — ORACLE's actual
fixture slate is dominated by minor leagues (Botola Pro, Veikkausliiga, USL tiers,
Faroese/Icelandic divisions, etc.) that it can never resolve. API-Football (already
wired for odds as tier-3 in `oddsProviders.ts`, same `API_FOOTBALL_KEY`) covers far more
ground for free: a single `/fixtures?date=&status=FT` call returns every finished match
globally in one request (confirmed live: 94 matches across 38 leagues for one day).

The catch: API-Football's free tier only accepts dates in a rolling window near "today"
(confirmed live: querying a date 2 days in the past from "today" was rejected with
`"Free plans do not have access to this date"` — returned as HTTP 200 with a populated
`errors` object, not a non-2xx status, so this must be checked explicitly). It can't
backfill arbitrary old dates the way football-data.org can. Hence: API-Football first
(broad coverage, narrow window), football-data.org as fallback (narrow coverage, any
date) — `resolveRecords()` in `resolveFixtures.ts` tries them in that order and only
moves to the fallback when the primary returns nothing for the date.

SportyBet (ORACLE's primary fixture/odds sidecar) was evaluated as a results source and
rejected: its sidecar (`tools/scrape_fixtures.py`) only calls `pcUpcomingEvents` (excludes
started/finished matches) and Sportradar `gismo` stats endpoints for form/standings/H2H —
never a live-score or finished-match endpoint. The public SportyBet results page is a
client-rendered SPA with no API capture on file. Building a results scraper from scratch
would be real, untested net-new work versus reusing an already-keyed, already-verified API.

## Output
```json
{
  "fixtureId": "arsenal_vs_chelsea_202606051500",
  "date": "2026-06-05",
  "home": "Arsenal",
  "away": "Chelsea",
  "result": { "homeGoals": 2, "awayGoals": 1, "outcome": "home" },
  "rps": 0.14,
  "realisedClv": 0.03,
  "clvSourceQuality": "KICKOFF_PROXY",
  "liquidityTag": "CLV_ELIGIBLE",
  "pick": { "market": "Goals O/U", "side": "Over 2.5", "odds": 2.1, "stake": 0.03 },
  "pickOutcome": "win",
  "resolvedAt": "2026-06-06T14:01:23Z"
}
```

## Edge cases

- **No API key**: skip CLV; set `realisedClv: null`, `clvSourceQuality: "UNKNOWN"`
- **Unmatched fixture**: log warning, skip — do not write a partial record
- **Multiple matches for same team pair on same date**: flag as `AMBIGUOUS_FIXTURE`, skip
- **Rate limit (429)**: classify as `RATE_LIMITED`, retry with exponential backoff (§11A)
- **Already resolved**: `upsertBulk` on `fixtureId` ensures idempotency — safe to re-run

## Structured Free-API Odds Fallback (v2026.10+)

Before any web-search synthesis, the gap-fill tries the structured provider chain in
`packages/runtime/src/oddsProviders.ts` (`buildOddsProviders()`, tier order via stable
sort, stop at first sharp price). Audited against current code 2026-06-20 — the table
below was previously missing two real providers (`oddspapi`, `sportybet-sidecar`):

| Tier | Provider | Env key | Free quota | Sharp? |
| --- | --- | --- | --- | --- |
| 2 | SharpAPI.io | `SHARPAPI_IO_KEY` | trial tier (api.sharpapi.io) | yes (Pinnacle/SBOBet/BetOnline) |
| 3 | API-Football | `API_FOOTBALL_KEY` | permanent free | no (net consensus) |
| 4 | Odds-API.io | `ODDS_API_IO_KEY` | 100 req/hr | yes when Pinnacle/SingBet present |
| 4 | OddsPapi | `ODDSPAPI_KEY` | tournament-scoped, see provider | yes (Pinnacle) |
| 5 | SportsGameOdds | `SPORTS_GAMEODDS_KEY` | 1,000 objects/mo | yes (Pinnacle), American-format odds |
| 6 | SportyBet sidecar | none (file read) | unlimited — zero-network | no (retail, wider overround tolerance) |

Tier 4 has two providers (`Odds-API.io`, `OddsPapi`) — both run before tier 5 is tried;
ties are broken by array order in `buildOddsProviders()` (`Odds-API.io` before
`OddsPapi`), since `Array.sort` is stable. Tier 6 (`sportybet-sidecar`) always has
quota (`hasQuota: () => true` — pure file read of `.tmp/fixtures/sportybet_today.json`,
no API key) and acts as the free floor before falling through to the Gemini/web-search
path below; its result is tagged "degraded" by the engine given retail-book overround.

Quota notes learned at integration (2026-06-10):

- Tier 4 runs before tier 5 on purpose — SportsGameOdds bills per *object returned*
  (1,000/mo is tiny), so the generous Odds-API.io quota absorbs the sharp-hunting traffic.
- SportsGameOdds responses use American odds (`"-112"`); the provider converts to decimal.
- Missing key = tier silently skipped; 429 = provider treated as quota-exhausted for that run.
- SportsGameOdds 3-way moneyline oddIDs (`points-*-game-ml3way-*`) are schema-inferred from
  docs — machine-verify against one live response when the key first lands.

## Web Search Fallback (v2026.9+)

When the structured provider chain (above) finds nothing for a fixture, the last
resort is `fetchWebSearchOdds()` in `packages/runtime/src/fixtures.ts`, which spawns
`tools/scrape_live_odds.py --fixtures <fixture_cache>`:

1. **Trigger**: fixture has no price after both the sidecar/priced check and the
   structured-provider + Gemini gap-fill (`stillUnpriced` in `fetchTodaysFixtures()`)
2. **Web search synthesis**: scrapes live odds from:
   - Flashscore, BetExplorer, SofaScore (Playwright-based dynamic sites)
   - Betfair public API (no auth required)
   - Requires ≥`min_consensus` sources to agree within `variance_threshold` for
     consensus acceptance (defaults: 3 sources, ±2.5% — see config flags below)
3. **Confidence scoring**: each fixture gets a `confidence: 0.0–1.0` value based on
   source count and variance (`compute_consensus()` in `scrape_live_odds.py`)

### Config flags (audited against code 2026-06-20 — these are genuinely wired)
- `ENABLE_WEB_SEARCH_FALLBACK=true` (default) — gates the whole fallback; threaded
  through `config.enableWebSearchOddsFallback` → all 4 `fetchTodaysFixtures()` call
  sites (`apps/worker`, `apps/bot`, `apps/cli`) → the `enableWebSearchFallback` param
- `WEB_ODDS_MIN_CONSENSUS=3` (default) — passed as `--min-consensus` to
  `scrape_live_odds.py`
- `WEB_ODDS_VARIANCE_THRESHOLD=0.025` (default, ±2.5%) — passed as
  `--variance-threshold` to `scrape_live_odds.py`

(Prior to 2026-06-20 these three flags were read into `config` but never actually
reached the code that would use them — all 4 call sites hardcoded `true` for the
fallback toggle regardless of `.env`, and the consensus/variance flags were never
passed to the Python script at all, which silently used its own internal defaults.
Fixed this session; see commit history for `fixtures.ts`/`apps/*/src/index.ts` /
`cli.ts` around this date if this section needs re-verifying later.)

## Acceptance criteria
- Every analysis record from yesterday has either a matching resolution record or a logged skip reason
- RPS values are in [0, 1]; CLV is tagged with source quality
- Running twice on the same date produces the same resolution records (idempotent)

