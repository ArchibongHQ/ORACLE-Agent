# SOP: Resolution Run

## Objective
For each fixture analysed yesterday (or a specified date), fetch the actual result,
compute RPS and realised CLV, and write a `ResolutionRecord` to GBrain. This is the
primary scored-history accumulation step that feeds calibration (§8.3) and SkillOpt (§8.5).

## When to run
Scheduled: `14:00 daily` (worker cron, `resolveYesterdayFixtures()`).
Manual: `node apps/worker/dist/index.js --run-now` (triggers batch then resolution).

## Required inputs
- `FOOTBALL_DATA_API_KEY` in `.env` — for fetching match results
- `ODDS_API_KEY` in `.env` (optional) — for realised CLV computation; omit for calibration-only
- Analysis records in GBrain ledger with `kickoff` dates matching the target date

## Steps

1. **Load analysis records** for target date (`kickoff.startsWith(YYYY-MM-DD)`) from `STORAGE_KEYS.analysisRecords`
2. **Fetch match results** from football-data.org `/matches?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD`
3. **Match fixtures** by fuzzy home/away team name to the fetched results
4. **Compute RPS** for each resolved fixture using stored `probabilities` vs actual outcome
5. **Fetch closing odds** from the Odds API (if key present) for CLV-eligible leagues; tag as `KICKOFF_PROXY` (§8.3)
6. **Compute realised CLV**: `(modelOdds / closingOdds) - 1`; set `clvSourceQuality` accordingly
7. **Write** `ResolutionRecord` to `STORAGE_KEYS.resolutionRecords` via `upsertBulk` on `fixtureId`

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

## Web Search Fallback (v2026.9+)

When the Odds API fails with quota exhaustion (429) during batch fixture fetch:

1. **Primary source**: Odds API (as above) → live odds from Pinnacle, BetFair, etc.
2. **Fallback trigger**: Odds API returns 429 or timeout after all sport keys attempted
3. **Web search synthesis**: Invoke `tools/scrape_live_odds.py --fixtures <fixture_cache>` to scrape live odds from:
   - Flashscore, BetExplorer, SofaScore (Playwright-based dynamic sites)
   - Betfair public API (no auth required)
   - Requires ≥3 sources agree within ±2% variance for consensus acceptance
4. **Quality tagging**: Synthetic odds tagged with `odds_source: 'web_search_consensus'` and `odds_quality: 'degraded'`
5. **Confidence scoring**: Each fixture gets `consensus_confidence: 0.0–1.0` based on source count and variance

### Config flags
- `ENABLE_WEB_SEARCH_FALLBACK=true` (default) — attempt web scraping when Odds API fails
- `WEB_ODDS_MIN_CONSENSUS=3` (default) — minimum sources for consensus odds
- `WEB_ODDS_VARIANCE_THRESHOLD=0.025` (default, ±2.5%) — maximum allowed variance between sources

### Resolution audit trail
- `ResolutionRecord` includes `odds_source` and `odds_quality` for transparency
- Picks made on synthetic odds are logged as `quality: 'degraded'` in FrozenOddsRegistry
- Post-resolution analysis can filter by quality tier (live vs. degraded)

## Acceptance criteria
- Every analysis record from yesterday has either a matching resolution record or a logged skip reason
- RPS values are in [0, 1]; CLV is tagged with source quality
- Running twice on the same date produces the same resolution records (idempotent)
- Web search fallback produces ≥80% consensus success rate for matches with fixture data

