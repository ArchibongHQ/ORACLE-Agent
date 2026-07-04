# SOP: Daily Batch Run

## Objective
Run ORACLE's analysis engine against today's fixtures, produce a self-contained HTML report, and persist analysis records for post-match scoring.

## All-markets v3 engine + v4 upgrade (2026-07-02+, v4 2026-07-04+)
Candidate generation runs through the deterministic all-markets v3 engine by default (`ORACLE_MARKETS_V3=on`) instead of the legacy `scanMarkets` cascade. The v4 upgrade (PRs #39–#44 + PR-7/PR-8) added the HFA λ term, v4 gates/completeness, slate pre-filter, Outputs A–D, R10 cross-check, corners/cards, the calibration feedback loop, and LLM posture A (demote draft cascade + arbiter top-N only) — see `workflows/markets_v3.md` for the full spec-to-code map, all env flags, and per-PR rollback.

## Daily control flow (WAT cron, source of truth = `apps/worker/src/index.ts`)
All jobs are pinned to explicit WAT (`WAT_TZ`). If the box was off at a slot, `checkHeartbeatFreshness` fires the missed acquire/goals jobs on daemon restart.

| Time (WAT) | Job | What |
|---|---|---|
| 09:30 | `acquire-daily` | `acquire_daily.py` → Parquet lake + JSON sidecar; news-intel enrichment; sends the fixture spreadsheet (xlsx) report to Telegram. Also runs `fetch_injuries.py` when `ORACLE_FETCH_INJURIES=on`. |
| 09:35 | `daily-batch` | `runDailyBatch("scheduled")` → full v3 all-markets analysis → HTML report + Telegram. Internal scrape is gap-fill-only (reuses the 09:30 lake). Calibration read side runs here (stamps `state.ledger` when `ORACLE_CALIBRATION_LEDGER=on`). |
| 09:40 | `goals-batch` | Independent goals discovery funnel over the SportyBet pool. |
| 10:00 | `resolve-yesterday` | `resolveDay` → fetch yesterday's results, write resolution records, **settle picks into the calibration ledger** (PR-7, shadow+on) + surface hit-rate/Brier/ECE/CLV metrics. |
| 10:00 / 12:00 / 13:00 | punt prompts | Named-slip counter-booking prompts (independent job). |

**HTML report vs xlsx workbook:** the engine + LLM read the **Parquet lake + sidecar directly** — neither rendered artifact is the analysis feed. The **xlsx workbook** (`fixtureWorkbook.ts`) is the canonical LLM-readable delivery; the **HTML report** (`report.ts`) is human-facing only.

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
**Scheduled (cron):** The worker runs the main daily batch at **09:35 WAT** when `node dist/index.js`
is running (see the control-flow table above for the full chain). The goals batch fires at 09:40 WAT
as an independent funnel over the SportyBet pool.

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
Scheduled at **10:00 WAT** (`resolve-yesterday`), or one-shot:
```bash
node apps/worker/dist/index.js --run-resolve
```
Resolution fetches actual results, writes resolution records, and (PR-7) settles each resolved pick into the calibration ledger — active whenever `ORACLE_CALIBRATION_LEDGER` is `shadow` (default) or `on`. See `workflows/markets_v3.md` for the calibration flag semantics and `workflows/skillopt.md` for the full loop.
