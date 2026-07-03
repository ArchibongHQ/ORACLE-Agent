# SOP: All-Markets v3 Deterministic Engine

## Objective

Implement `all-markets-analysis-prompt-v3` (owner-supplied spec) as deterministic script math instead of LLM probability estimation — for prediction accuracy, latency, and token cost. This doc maps spec sections → code, records what shipped vs what's deferred, and is the entry point for anyone extending the engine or diagnosing a live batch.

## Status: shipped across 7 stacked PRs (#29–#35), `ORACLE_MARKETS_V3` defaults **on**

| Phase | PR | What |
|---|---|---|
| P1 | #29 | Data foundation — typed corners/cards/BTTS%/CS%/FTS%/1H-share/OU-hit-rate fields through `StatsOverride`; xG estimated-fallback; `goalsFunnel.ts` news-intel fix |
| P2 | #30 | Core deterministic engine — `packages/engine/src/marketsV3/` (grid, dual split, feed dictionary, engines 3.3–3.8, S/M/L/X classes, tiered EV gate) |
| P3 | #31 | Pipeline integration — wired into `decide()` via `batch/index.ts`, `ORACLE_MARKETS_V3` flag (default `on`), standalone eligibility/completeness gate library |
| P4 | #32 | LLM demotion — Q4 catalogue-dump executor suppressed when v3 supplies a fixture's candidates; arbiter gets ≤5 gate-survivors instead |
| P5 | #33 | Goals-batch verification arbiter (R10) — `crossCheckGoalsPick()`, downgrade+re-gate semantics |
| P6 | #34 | Slate-level Phase 7/8 outputs — Output A/B/C/D construction, chunk/final status lines |
| P7 | #35 | Conditional corners (Negative Binomial) + cards (Poisson) modules |

## Spec → code map

| Spec section | Module |
|---|---|
| Rule 0 (data integrity) | `feedDictionary.ts` (`isSkip`) — unmapped markets are skipped, never guessed |
| §0.3/§0.4 (reliability tiers, completeness gate) | `packages/runtime/src/marketsV3/pipeline.ts` (`gateMarketsV3Fixture`), reusing `goalsV3/completeness.ts` |
| §1/§1.2 (eligibility) | `packages/runtime/src/goalsV3/eligibility.ts` (`classifyEligibility`), reused as-is |
| §2 (prioritisation) | `packages/engine/src/marketsV3/prioritise.ts` |
| §3.1 (λ) | `packages/engine/src/goalsV3/lambda.ts` (`computeV3Lambdas`), reused |
| §3.2 (dual split) | `packages/engine/src/marketsV3/split.ts` (`deriveDualSplit`), wraps `goalsV3/matchShape.ts` |
| §3.3–§3.8 (engines) | `packages/engine/src/marketsV3/engines/{totals,result,shape,half,time,exotics}.ts` |
| §3.9 (corners/cards) | `packages/engine/src/marketsV3/engines/{corners,cards}.ts` — **built but not routed** (see Known gaps) |
| §4 (de-vig, classes) | `packages/engine/src/marketsV3/{evGate,classes}.ts` |
| §5 (EV gate) | `packages/engine/src/marketsV3/evGate.ts` (`gateAllMarkets`) |
| §6 (discard/abstain) | Implicit — a fixture with no `V3AllMarketsResult.best` is a valid no-bet outcome throughout |
| §7 (outputs A/B/C/D) | `packages/engine/src/marketsV3/outputs.ts` — **built but not wired into delivery** (see Known gaps) |
| §8 (status/summary) | `outputs.ts` (`formatChunkStatus`, `formatFinalSummary`) — **built but not called from the worker** |
| R10 (goals cross-check) | `packages/runtime/src/marketsV3/goalsCrossCheck.ts` — **built but not wired into the worker loop** |

## Env flags

| Var | Default | Effect |
|---|---|---|
| `ORACLE_MARKETS_V3` | `on` | `on`: v3 replaces `eligible` for `decide()` per fixture (fail-open to legacy on any error/empty result). `shadow`: v3 runs, output discarded, legacy path acts. `off`: v3 never runs — byte-identical to pre-v3 behavior. |
| `ORACLE_MARKETS_V3_COMPLETENESS_MIN` | `70` | Weighted §0.4 completeness floor (0–100) for `gateMarketsV3Fixture` |
| `ORACLE_MARKETS_V3_HEIGHTENED_MIN` | `85` | Floor for heightened fixtures (youth/women/friendly/cup-final) |
| `ENABLE_LLM_MARKET_EXECUTOR` | `false` | Legacy Q4 catalogue-dump executor — auto-suppressed per-fixture when v3 supplies that fixture's candidates (P4); still fires normally when v3 is off/shadow/declined |

Rollback: set `ORACLE_MARKETS_V3=off`. No other change needed — the legacy `scanMarkets` path in `packages/engine/src/execution/index.ts` was never touched by this work.

## Known gaps (deliberate scope reductions, not oversights)

Each phase's PR documents its own scope note; consolidated here for a single "what's not done yet" view:

1. **Slate-level fixture pre-filtering** (`pipeline.ts`) is a tested library, not wired into `apps/worker/src/index.ts`'s `runDailyBatch` fixture-list loop. v3 currently fails open on thin data via its own per-outcome penalty table inside `processOne` instead — every fixture still reaches the engine, just penalized rather than pre-discarded.
2. **`outputs.ts`** (Output A/B/C/D, Phase 8 status lines) is not called anywhere live. The worker's existing 39-leg safety-net trim (`apps/worker/src/index.ts` ~L829) and fixture-report rendering are untouched by this work.
3. **`goalsCrossCheck.ts`** (R10) is not invoked from the worker batch loop. Wiring it requires reconstructing goalsV3's exact per-fixture input inside `runDailyBatch` and mutating a finalized `BatchResult`'s counts/report/Telegram delivery consistently when a pick is downgraded or dropped post-hoc.
4. **Corners/cards engines** (`corners.ts`/`cards.ts`) are complete and tested but `feedDictionary.ts` still routes those markets to explicit `"corners-dormant"`/`"cards-dormant"` skips (P2) rather than to these modules. Wiring needs `V3EngineCtx` extended with corners/cards means and touches P2's already-authored `routeMarket()` tests.
5. **Goals-pipeline "Output B"/"Output C" naming** (`apps/worker/src/index.ts`) predates this spec, uses different numbering (its B/C ≈ this spec's C/D), and collides cosmetically with the new A/B/C/D scheme. Not renamed — touches 10 files including `apps/web` and `apps/bot`.

None of these gate the live `ORACLE_MARKETS_V3=on` default — the core per-fixture pricing/gating pipeline (P1–P4) is fully wired and is what actually drives `decide()` today. Items 1–5 are additive refinements queued as follow-up work, prioritized in that order (1–2 have the most user-visible upside).

## Verification

Every phase passed the full pipeline before merging:
```bash
pnpm turbo run typecheck test build --concurrency=1   # OOM constraint on Windows — always use --concurrency=1
pnpm exec biome ci .                                   # catches import-order regressions pre-commit misses
```
Golden-fixture tests anchor Phase 3/5 math to the spec's own worked examples (`packages/engine/test/marketsV3.test.ts`). Batch-wiring seams are verified with mocked `analyzeFixtureMarketsV3`/`runAllMarketsLlmExecutor` (`packages/engine/test/marketsV3BatchIntegration.test.ts`) so they're deterministic independent of the real engine's output.

## Recommended next step: walk-forward backtest

The engine went live immediately (owner decision — no shadow-mode gate before cutover). To validate it in production, run the walk-forward comparison described in `workflows/backtest.md` once enough resolved fixtures have accumulated under `ORACLE_MARKETS_V3=on` (at minimum 1–2 weeks of daily batches, ideally covering multiple leagues/market classes):

1. Pull resolved fixtures + their v3 `assessments`/`best` picks from `.tmp/oracle-store` (persisted by `runAnalysis`) for the live window.
2. Compare hit-rate and CLV against the equivalent legacy-`scanMarkets` picks for the same fixtures (re-run with `ORACLE_MARKETS_V3=off` on the same historical odds snapshot — `tools/backfill_oracle.py` / `workflows/backtest.md` cover the harness).
3. Segment by market class (S/M/L/X) — the tiered EV gate's thresholds (§5.2) are the main lever if any class is mis-calibrated; adjust `V3_ALLMARKETS_PENALTY_PTS`/`CLASS_GATE` in `evGate.ts` rather than the probability engines themselves if hit-rates diverge from the gate's implied confidence.
4. If v3 underperforms legacy on any class, the fastest safe lever is `ORACLE_MARKETS_V3=shadow` (keeps v3 running for continued data collection without affecting live picks) rather than a full rollback.

This is a recommendation, not something this session could execute — it requires real elapsed time and resolved match outcomes that don't exist yet.
