# ORACLE Phase 0 — Engine Migration Guide

How to port the verified logic out of `ORACLE_v2026_8_0.jsx` (7,134 lines) into this scaffold
**without re-deriving any math from scratch**. The scaffold gives you the landing structure, the
boundaries, and an exact per-method source map. Porting is mechanical: copy a verified body, apply
the three rewrites below, delete the source coupling.

## The three mechanical rewrites

Every engine that touched the browser needs the same three edits. Nothing else about the logic changes.

### 1. Storage: `_safeStorage` → `StoragePort` (hydrate / persist)
The source fakes persistence with an in-memory localStorage shim (`_safeStorage`, §0a, lines 14–22)
and calls `_safeStorage.getItem/setItem` inline. Replace with `StoragePort` + the key constants in
`src/storage/keys.ts`. Use the **hydrate-once / persist-at-end** pattern (see `ratings.ts`,
`calibration.ts`): load the slice you need at the start of a run into a plain object, mutate it
synchronously through the math, write it back once at the end.

| Old key (string literal in source) | New constant | Owner | Source lines |
|---|---|---|---|
| `oracle_v2026_teams` | `STORAGE_KEYS.teamsElo` | TeamRatingsEngine | 1325–1327 |
| `oracle_v2026_pi` | `STORAGE_KEYS.teamsPi` | TeamRatingsEngine | 1346–1347 |
| `oracle_v2026_ledger` | `STORAGE_KEYS.calibrationLedger` | CalibrationEngine | 1378–1380 |
| `RAGSystem._STORAGE_KEY` | `STORAGE_KEYS.ragStore` | RAGSystem | 1895, 1905 |
| *(new)* | `STORAGE_KEYS.decisionDisagreementLog` | decision.ts (§6) | — |

### 2. Keys & bankroll: `window.__ORACLE_CORE__` → `OracleConfig`
The source reads secrets and bankroll from the central store's `ui`/`telemetry` slices. Replace each
read with an injected `OracleConfig` field (`src/config/index.ts`).

| Source read | Lines | Replace with |
|---|---|---|
| `…getState().ui.userApiKey` | 305, 1600 | `config.<provider>ApiKey` |
| `…getState().ui.claudeKey` | 3853 | `config.claudeApiKey` (via injected `LLMProvider`) |
| `…getState().telemetry.broll` | 1486 | `config.bankroll` |
| `…getState().crowdWisdom` | 2437 | pass in explicitly |

### 3. localStorage shim & `OracleCoreStore` → delete / replace
Remove the `Object.defineProperty(window, 'localStorage', …)` patch (lines 20–22). The Redux-like
`OracleCoreStore` class (lines 5314–6124) is **UI state**, not engine state — it stays in `apps/web`.
The engine never imports it.

## Async boundary (important)
`StoragePort` is **async** (the Phase-2 target is Postgres/GBrain). The source's `load()/save()` are
sync. Do **not** sprinkle `await` through the math. Instead: `await engine.hydrate()` before
`ExecutionEngine.run(...)`, run the (synchronous) analysis, `await engine.persist()` after. This
matches how a headless worker and the backtest harness already operate.

## Port order (dependency-first)
1. **`math.ts`** — ✅ **COMPLETE.** All of MathEngine (lines 353–1317) ported verbatim + typed + unit-tested
   (25 checks green). Includes distributions, `dixonColesTau`/`sarmanovTau`, `estimateDynamicRho`, `buildMatrix`
   (Sarmanov branch live), λ-adjustments, `extractMarkets`, `generateSyntheticAlpha`, `matrixVariance`/`monteCarlo`,
   `detectLowScoringRegime`, `asianHandicapPivot`, `shinPowerVigRemoval`, `optimizedKelly`, `clvProjection`,
   `CorrelationMatrix`, `rankedProbabilityScore`/`meanRPS`, `klDivergence`, `normalizedEfficiency`, `getDrawdownPenalty`,
   `leeRecoveryConstraint`, `adaptiveVarianceRegime`, `serialDependenceMultiplier`, `rerunWithOverride`, and the rest.
   Nothing in MathEngine remains stubbed.
2. **`ratings.ts`** (1323–1376) and **`calibration.ts`** (1377–1577) — apply rewrite #1.
3. **`safety.ts`** — MLSafetyFilter (2573–2990), ConvergenceScorer (2359–2572), then
   AntiSycophancyCircuit (3349–4002, apply rewrite #2: key → injected `LLMProvider`).
4. **`telemetry.ts`** (4682–5313) — apply rewrite #2; implement the §9 `resolveFixture` outcomes.
5. **`execution.ts`** (4003–4669) — port `scanMarkets`/`run`, then wire `applyRankingMode` (see below).
6. **RAGSystem** (1884–2185) — not yet scaffolded; add `src/engine/rag.ts`, apply rewrite #1.

## Logic changes to apply *during* the port (from PRD v1.1)
- **§5 ranking modes.** `applyRankingMode()` is already implemented in `execution.ts`. When you port
  `scanMarkets`, replace its final hard-coded `evs.sort((a,b)=>b.rankingScore-a.rankingScore)`
  (line ~4144/4266) with `applyRankingMode(evs, mode)`. Default = `CONFIDENCE_WEIGHTED`.
- **§6 LLM-gated decision.** `decision.ts` is implemented (real `validateSelection` + `decide`). Feed
  it the gate-passed `evMarkets`. The hard gates run in code *after* the LLM responds.
- **§8.3 calibration-primary.** `CalibrationEngine.calculate` is the optimization target (RPS +
  reliability). Record CLV in `backtestCLV` **only** where `isLiquidMarket` (liquidity tag on `OddsData`).
- **§9 fixture fix.** Replace the three `throw "No fixture found"` sites (lines 4747, 4952, 5505) with
  the typed `ResolveOutcome` (`RESOLVED | AMBIGUOUS | NO_DATA`) in `telemetry.ts`.
- **§8.4 do NOT auto-optimize** the ported `math.ts`/Kelly. Tune only via walk-forward backtest.

## Porting the test suite
The source has `runProtocolUnitTests` (T1–T367, lines 6125–7133). Port assertions into `test/` as you
migrate each engine. They were written against the object-literal API; the method names are unchanged,
so most port with only an import swap. The scaffold's `test/math.test.ts` shows the pattern.

## Done-criteria for Phase 0 (PRD §3.1)
- [ ] `@oracle/engine` has zero imports from `react`, `window`, or any concrete storage/network.
- [ ] `MemoryAdapter` ⇄ (future) `GBrainAdapter` swap needs no engine change.
- [ ] `npm run typecheck` clean (already passing on the scaffold).
- [ ] Ported T1–T367 pass via `npm test`.
- [ ] `runFixture(query, makeDeps())` produces a gated decision headlessly.
