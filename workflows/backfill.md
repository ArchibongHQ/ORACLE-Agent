# SOP: Historical Backfill

## Objective
Seed the GBrain ledger with historical match data so calibration (§8.3) and the
walk-forward backtest harness (§8.4) can run before enough live data has accumulated.
This decouples Phase 1 metrics from Phase 2 live-data requirements.

## Tool
`tools/backfill_oracle.py`

## Required inputs
- `FOOTBALL_DATA_API_KEY` in `.env`
- `ODDS_API_KEY` in `.env` (optional; for historical CLV tagging)
- Date range: `--from YYYY-MM-DD --to YYYY-MM-DD`
- League filter: `--leagues "Premier League,La Liga"` (optional; default: all)

## Steps

1. **Fetch historical fixtures** from football-data.org for the date range and leagues
2. **For each fixture**, reconstruct the analysis record:
   - Run `ExecutionEngine` with historical odds (if available from Odds API) as telemetry
   - If no historical odds: run with empty telemetry (model-only path)
   - Timestamp all features strictly as `observedAt < kickoff` (anti-leakage, §8.7)
3. **Fetch actual results** and compute RPS
4. **Fetch closing odds** (Odds API historical endpoint) where available; tag `clvSourceQuality`
5. **Write** `AnalysisRecord` via `upsertBulk` on `analysisId` (idempotent)
6. **Write** `ResolutionRecord` via `upsertBulk` on `fixtureId`
7. **Log** a backfill manifest entry to `STORAGE_KEYS.runManifests` with `trigger: "backfill"`

## Anti-leakage discipline (§8.7)
- All features (xG, odds, lineup data) must have `timestamp < kickoff`
- Team ratings (`TeamRatingsEngine`) must be computed from data up to but not including the match
- No future data at any step — the harness halts and flags any unstamped feature

## LLM leakage guard (§8.5)
Historical fixtures inside the LLM's training-data window must be excluded from SkillOpt
validation. The backfill tool tags each record with `llmBlindPeriod: true` if the fixture
is within the model's known training window (currently: before August 2025 for claude-opus-4-8).
These records are used for lambda calibration only, not LLM decision scoring.

## Output
Backfill records in GBrain with:
- `runId: "backfill_YYYYMMDD_YYYYMMDD_<slug>"`
- `calibrationSnapshotId: "calib_YYYY-MM-DD"` (date of backfill run)
- `schemaVersion: 1`

## Acceptance criteria
- Re-running the same date range produces the same records (idempotent via `upsertBulk`)
- No fixture's features reference data timestamped after its kickoff
- Total RPS over the backfill period matches within 1% of a hand-verified sample
- `llmBlindPeriod` is correctly set for all pre-cutoff fixtures
