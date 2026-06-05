# SOP: Daily Batch Run

## Objective
Run ORACLE's analysis engine against today's fixtures, produce a self-contained HTML report, and persist analysis records for post-match scoring.

## Required inputs
- `.tmp/fixtures/today.txt` — newline-delimited fixture list (see format below)
- `.env` — API keys (Gemini, Claude, etc.) at repo root

## Fixture file format

```
# Matchday N — YYYY-MM-DD
Arsenal vs Chelsea, Premier League, 2026-06-05T15:00:00Z
Real Madrid vs Barca, La Liga, 2026-06-05T20:00:00Z
Bayern Munich vs Dortmund, Bundesliga, 2026-06-06T18:30:00Z
```

Supported separators: comma `,` or pipe `|`. Lines starting with `#` and blank lines are ignored.

## Tools
- `packages/engine/src/batch/index.ts` → `parseFixtureList`, `runBatch`
- `apps/worker/src/report.ts` → `writeReport`
- `apps/worker/src/index.ts` → `runDailyBatch` (called by cron or `--run-now`)
- `packages/storage/src/GBrainAdapter.ts` → persistence (`.tmp/gbrain/`)

## Steps

### 1. Populate today's fixture list
Write today's fixtures to `.tmp/fixtures/today.txt`. Sources:
- Manual entry (recommended for small batches)
- `tools/fetch_fixtures.py` (when implemented) → calls api-football or football-data.org

### 2. Run the batch
**Scheduled (cron):** The worker runs automatically at 09:00 local time when `node dist/index.js` is running.

**Manual one-shot:**
```bash
pnpm --filter @oracle/worker build
node apps/worker/dist/index.js --run-now
```

### 3. Verify output
- Report written to `.tmp/reports/oracle-YYYY-MM-DD.html` — open in any browser
- Analysis records appended to `.tmp/gbrain/` (GBrainAdapter persistent store)
- Console shows `Batch done — N ok / M errors / K actionable`

### 4. On errors
- Per-fixture errors are logged but do not abort the batch
- The error reason is shown in the report as a red error card
- Common causes: missing odds data (oddsAvailable: false), network timeout
- Fix: check `.env` API keys, verify fixture name spelling, re-run with corrected input

## Edge cases
- **No fixture file**: Worker logs a warning and skips the batch run — does NOT throw
- **All no-odds fixtures**: Batch completes; all cards show `NO_ODDS` flag and `NO_BET`
- **Whitelist mode**: Pass `marketWhitelist: ['Goals O/U']` to `runBatch` to restrict scoring to specific market categories
- **Empty fixture list**: `parseFixtureList` returns `[]`; `runBatch` returns a valid `BatchResult` with 0 jobs

## Post-match resolution
Run at 14:00 (also scheduled by the worker):
```bash
node apps/worker/dist/index.js --run-now  # triggers resolve path too
```
Resolution requires actual match results — see `workflows/skillopt.md` for the full calibration loop.
