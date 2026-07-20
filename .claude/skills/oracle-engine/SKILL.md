---
name: oracle-engine
description: Navigate ORACLE's deterministic prediction engine (packages/engine/src) — module map, math quick-ref, decision-tree pipeline shape, and pointers to the actively-maintained spec docs. Use before touching prediction math, EV gating, staking, calibration, or safety-filter code.
triggers: /oracle-engine
---

# ORACLE Prediction Engine — Navigation

**Goal**: give an agent working knowledge of `packages/engine/src/` fast, without
re-deriving it from scratch, and without becoming a second source of truth that
drifts from the code. Two docs are already current and actively maintained
per-PR — `workflows/markets_v3.md` (goalsV3 + marketsV3 pricing spec-to-code map)
and `workflows/oracle_decision_rubric.md` (LLM decision-layer rubric, itself
auto-updated offline by `tools/skillopt.py` per `workflows/skillopt.md`). **Read
those for goalsV3/marketsV3/decision-layer detail — this skill points to them
rather than duplicating them.** This skill's own job is the parts nothing else
covers: the module map, the pipeline's actual (non-linear) shape, a `math/index.ts`
quick-reference, and full documentation of six modules that had zero coverage
anywhere as of 2026-07-08 (`safety/`, `rag/`, `swarm/`, `ratings/`, `gbm/`).

**Context (discovered 2026-07-08)**: the engine has no single clean entry point.
`batch/index.ts`'s `processOne` is a ~460-line decision tree through ~8 optional
stages gated by ~35 independent `ORACLE_*` flags (`types.ts`), and two pricer
generations coexist — the legacy `ExecutionEngine.scanMarkets` (hand-tuned
per-market blocks in `execution/index.ts`) and the newer `marketsV3` grid-based
engines — reconciled ad hoc via a `usedV3` boolean (`batch/index.ts:605-673`).
Three "generations" of the goals/markets pricer exist in the codebase
simultaneously (legacy → goalsV3 → marketsV3); treat any description of "the
pipeline" as a snapshot of a fast-moving decision tree, not a fixed spec — verify
against current code before trusting a line number.

## 1. Module index

| Module | Status | Where documented |
|---|---|---|
| `execution/index.ts` (2375 lines) | Live — `ExecutionEngine.scanMarkets()`, legacy per-market pricing, Monte Carlo sensitivity analysis, hosts the safety-layer call sites (§5) | Partial — no dedicated doc; large/legacy |
| `decision/index.ts`, `decision/marketExecutor.ts` | Live — LLM cascade (Opus→Gemini→OpenRouter→deterministic fallback) + arbiter + `validateSelection()` hard gates | `workflows/oracle_decision_rubric.md` |
| `goalsV3/` (`lambda.ts`, `matchShape.ts`, `edgeGate.ts`, `analyzeFixture.ts`) | Live — deterministic goals-only pipeline; `computeV3Lambdas` at `lambda.ts:211` | `workflows/markets_v3.md` |
| `marketsV3/` (`grid.ts`, `evGate.ts`, `classes.ts`, `engines/*`, etc.) | Live — all-markets v3 engine, shared Poisson/DC grid, per-class EV gate (§4) | `workflows/markets_v3.md` |
| `math/index.ts` (1902 lines) | Live — core stats library, the whole engine's formula source | No dedicated doc — see §3 below |
| `calibration/index.ts` | Live — Brier/RPS/ECE/log-loss, isotonic PAVA, Platt scaling, bootstrap significance gate | `workflows/backtest.md` (verified accurate 2026-07-08) |
| `safety/index.ts` (1211 lines) | Live — `ConvergenceScorer`, `MLSafetyFilter`, `AntiSycophancyCircuit`; instantiated in `execution/index.ts:2200/2204/2207/2229` | **Documented here — §5, first coverage anywhere** |
| `ratings/index.ts` (83 lines) | **Dormant** — `TeamRatingsEngine` (Elo + pi-rating), zero `new TeamRatingsEngine(` call sites in `packages/` | **Documented here — §6** |
| `rag/index.ts` (403 lines) | Live — `RAGSystem`, instantiated `execution/index.ts:2204`, feeds `ConvergenceScorer`'s S10 signal | **Documented here — §5.4** |
| `gbm/index.ts` (263 lines) | **Gated off** — `blendGbmIntoFp` has zero call sites in `batch/`, `execution/`, `goalsV3/`, or `marketsV3/` despite an `enableGbmResidual` config flag existing; the wiring its own header describes doesn't exist yet | `workflows/gbm_residual.md` (rejection rationale) + **§6 here** (live-wiring status) |
| `swarm/index.ts` (193 lines) | Live — `runSwarm()` called from `batch/index.ts:757`, advisory-only, never sets `primaryPick` | **Documented here — §5.5** |
| `markets/` | Live — static market catalog + two/three-way devig helpers | — |
| `batch/index.ts`, `batch/pool.ts` | Live — `runBatch`/`processOne`, closest thing to a top-level entry point (§ above) | — |
| `safety/pipeline.ts` (new, Wave 3 WS3-A) | Live — `runSafetyPipeline()`, a verbatim-lift extraction of `execution/index.ts` `_run`'s post-pricing safety block (steam-chaser veto → portfolio correlation → AntiSycophancy → RAG → ConvergenceScorer → tier/family multipliers → MLSafetyFilter → rag.addToStore) into a source-agnostic function so both legacy and v3-adapted candidates run the identical stage; `v3AssessmentsToEvMarkets` adapter lives here too | No dedicated doc yet — see this file's own header comment |

## 2. Pipeline shape (decision tree, not a fixed sequence)

`batch/index.ts:processOne` threads through, roughly in order: v3 goals →
optional v3 all-markets (`usedV3` set true at `batch/index.ts:624` when it runs)
→ LLM briefing/decision → optional swarm fan-out (`runSwarm`, gated to
APEX/PRIME/VIABLE tiers only, `swarm/index.ts:swarmWorkersForTier`) → optional
CVL verification → market executor → arbiter → cross-check. Each stage is gated
by its own flag; `usedV3` also demotes the LLM market executor to
unmapped-tail-only scope when v3 already priced the market
(`batch/index.ts:671-673`). **Don't assume every fixture goes through every
stage** — check the relevant `config.*` flags in `types.ts` before reasoning
about what ran. For the current flag → market-generation mapping, see
`workflows/markets_v3.md`'s env-flag table rather than duplicating it here.

## 3. `math/index.ts` quick-reference

Line numbers are a map, not gospel — grep the function name to confirm before
citing a constant; this file changes often.

| Function | File:line | What it does |
|---|---|---|
| `poissonPMF` | `math/index.ts:250` | Poisson PMF, log-space for stability, λ floored at 0.01 |
| `dixonColesTau` | `math/index.ts:289` | Low-score dependence correction (Dixon-Coles τ) |
| `sarmanovTau` | `math/index.ts:349` | Generalized DC τ for `order > 0` (Sarmanov) |
| `estimateDynamicRho` | `math/index.ts:305` | Per-league ρ via bracketed bisection on dL/dρ; consumed with shrinkage in `calibration/index.ts:456` and `goalsV3/lambda.ts:resolveRho:100` |
| `calculateDynamicRho` | `math/index.ts:1063` | Exponential decay on total λ |
| `shinPowerVigRemoval` | `math/index.ts:995` | Shin power-method devig (bisection on exponent k); two/three-way wrappers in `markets/devig.ts` |
| `hurdle` | `math/index.ts:1067` | Minimum-edge floor by win-probability band |
| `adjEV` | `math/index.ts:1077` | `modelP * odds - 1 - MOS` (EV minus margin-of-safety) |
| `optimizedKelly` | `math/index.ts:1080` | Canonical Kelly `f* = (mp·odds−1)/(odds−1)`, scaled by `base(0.25) × dqs × councilPenalty × varMultiplier × drawdownPenalty × calibFactor`, **hard-capped at 0.15** (line 1101) |
| `pairwiseCrossFixtureCorrelation` | `math/index.ts:1777` | League+kickoff-window-driven ρ between two portfolio legs |
| `copulaJointProbability` | `math/index.ts:1820` | Bivariate-normal joint exceedance across legs — portfolio correlation veto |

**Kelly cap note (was undocumented anywhere before this skill)**: `optimizedKelly`
clamps its output to `[0, 0.15]` regardless of how favorable the inputs are —
`math/index.ts:1101`. The `base` multiplier defaults to `0.25` (quarter-Kelly)
before the DQS/penalty/variance/drawdown/calibration multipliers are applied on
top, so the effective stake is very rarely close to the 0.15 ceiling in practice.
This is separate from `safety/index.ts`'s tier `kellyMultiplier` (§5.1), which is
applied afterward on top of whatever `optimizedKelly` already returned
(`execution/index.ts:643`, `applyConvergenceTierToStake`).

## 4. EV gate — per-class, not a single number

`oracle_decision_rubric.md` historically stated a blanket `ev > 0.04` gate. The
actual gate in `marketsV3/evGate.ts:61-69` (`CLASS_GATE`) is per market class:

| Class | `minAdjEdge` | `minAdjEvPct` | `maxOdds` |
|---|---|---|---|
| S | 0.03 | 0.04 | — |
| M | 0.05 | — (edge-only) | — |
| L | 0.06 | 0.15 | — |
| X | 0.06 | 0.20 | 15 |

A stricter v4 "heightened" variant exists at `evGate.ts:73-81`
(`CLASS_GATE_HEIGHTENED`) — S/M/L bars raised, X excluded entirely. See
`marketsV3/evGate.ts:1-24`'s header comment for the full penalty/cap model
(§5.2–§5.4 of the spec it implements). `workflows/oracle_decision_rubric.md`
lines 24/82 were corrected to point here rather than restate a single number
(see that file's own changelog for the date).

## 5. `safety/index.ts` — ConvergenceScorer, MLSafetyFilter, AntiSycophancyCircuit

All three are instantiated per-fixture in `execution/index.ts`:
`AntiSycophancyCircuit().execute()` at `:2200`, `RAGSystem` at `:2204`,
`ConvergenceScorer().compute()` at `:2207`, `MLSafetyFilter().evaluate()` at
`:2229`.

### 5.1 `ConvergenceScorer` (`safety/index.ts:110-311`)

Scores each +EV candidate market on 14 signals (`S01`-`S14`, `scoreMarket` at
`:115`), sums to a 0–24 `totalScore`, maps to a tier (`getTier`, `:111`,
`TIERS` table at `:90-108`):

| Tier | Score | Kelly multiplier |
|---|---|---|
| APEX | 18–23 | 1.0 (Full Kelly) |
| PRIME | 13–17 | 1.0 (Full Kelly) |
| VIABLE | 8–12 | 0.5 (Half Kelly) |
| MARGINAL | 4–7 | 0.25 (Quarter Kelly) |
| NOISE | 0–3 | 0 (no bet) |

Signal summary (points awarded when condition true, `scoreMarket:126-219`):
`S01` model/implied gap >8pt (3pt) · `S02` sharp-book consensus ≥3 books (3–4pt)
· `S03` reverse-line-move without sharp compression (2pt) · `S04` sharp
compression without RLM (2pt) · `S05` CLV survival probability >0.7 (1pt) ·
`S06` adjusted EV >9% after a 5pt haircut (2pt) · `S07` model probability ≥0.75
(2pt) · `S08` adversary+referee debate both endorse (2pt) · `S09` calibration
factor >1.0 (1pt) · `S10` RAG best-analogue similarity ≥0.8, same category, not
survivorship-biased (1pt, feeds from `RAGSystem`, §5.4) · `S11` crowd-wisdom
alignment >0.6 confidence (1pt) · `S12` fair-prob exceeds implied under high
variance-multiplier (1pt) · `S13` market not suspended and >1.5h to kickoff
(1pt) · `S14` implied-vs-model excess ≤3pt, else `0` with a flag, and >5pt is a
**hard `[NEGATIVE_EV_ALERT]`** (`compute:288`) that the caller must respect.
`compute()` (`:254`) also emits a `[LOW_DISCRIMINATION]` warning when the APEX
market beats the runner-up by ≤3 points, and a `noConvergence` flag below
score 8.

### 5.2 `MLSafetyFilter` (`safety/index.ts:351-694`)

17 filters (`S1`-`S17`, `evaluate:352`) gate `mlAllowed`; several are **hard
rejects** that short-circuit immediately rather than just lowering a score:
odds outside `[1.3, 1.7]` (S1, `:366`), goals environment xG ≤2.1 when xG data
exists (S7, `:431`), derby or key-injury red flag (S11, `:506`), high-upset
league membership (S13, `:537`), confirmed sharp-book fade delta >0.1 (S16,
`:555`), severe miscalibration `calibFactor` <0.7 (S17, `:599`). Non-hard-reject
filters need ≥70% pass rate for `mlAllowed` (`_buildResult:626-651`). Several
filters (S7 xG, S16 sharp delta, S17 calibration) explicitly **skip rather than
reject when the underlying data is unavailable** — read the `reason` string,
don't assume "skipped" means "passed for a good reason." `_computeDrawRisk`
(`:654-694`) separately scores draw risk 0–100 from λ-similarity, total xG,
league draw-rate, weather, and squad depletion, mapping to
EXTREME/VERY_HIGH/HIGH/MODERATE/LOW tiers; `VERY_HIGH`+ (score ≥61) sets
`mlBlocked = true`, which forces `mlAllowed = false` regardless of the filter
pass rate.

### 5.3 `AntiSycophancyCircuit` (`safety/index.ts:706-1170`)

Three-stage deterministic debate, no LLM in the current implementation
(`execute()` header comment: "Phase 2 will wire LLM for the challenge() path" —
still true as of 2026-07-08, verify before assuming otherwise):
`evFinderAgent` (`:707`) scores every +EV candidate 0–15+ on edge size, model
probability, variance flags, RLM/steam/sharp-compression tags, and
model-vs-implied gap, keeps the top 12. `adversarialAgent` (`:795`) critiques
each proposal — deducts confidence for high-variance environments with thin
edge, unconfirmed lineups close to kickoff, active drawdown penalty, longshot
confidence bands (D/E — **auto-veto**), and MES <0.85 with edge <0.08
(**auto-veto**, "vig noise" zone). `refereeAgent` (`:912`) issues the ground-truth
verdict per market, called from `:1043`.

### 5.4 `RAGSystem` (`rag/index.ts`)

Postmortem/analogue-retrieval store, StoragePort-backed (persists via
`STORAGE_KEYS.ragStore`, capped at 200 entries, `MAX_STORE:21`). Each resolved
fixture becomes a 12-dimensional L2-normalized embedding
(`createEmbedding:75-105`: home/away λ, fair-prob triple, top-market EV×10,
variance multiplier, MES, league hash, hours-to-KO bucket, market-type bit,
draw spread). `findSimilar` (`:147`) does cosine similarity (pre-normalized, so
a plain dot product) against the store to surface analogous past fixtures —
this is what feeds `ConvergenceScorer`'s `S10` signal (§5.1), including the
survivorship-bias check (top-5 analogues drawn exclusively from
Premier/Champions/La Liga/Bundesliga/Serie A trips a warning, not a hard block).

### 5.5 `swarm/index.ts` — advisory sub-agent voting

`runSwarm()` (`:99`) fans out N worker agents (Kimi K2.6 preferred, OpenRouter
fallback, one slot tries the local Claude Code CLI) that each vote on the best
pick from the eligible set; `aggregate()` (`:76`) does confidence-weighted
voting to a consensus + a divergence score. Worker count by tier
(`swarmWorkersForTier:38`): APEX=7, PRIME=5, VIABLE=3, MARGINAL/NOISE=0 (skipped
entirely). **This is advisory evidence only** — injected into the decision's
`softContext` as a `[SWARM_CONSENSUS]` / `[SWARM_HIGH_DIVERGENCE]` item
(`swarmToSoftContext:174`, divergence >0.4 trips the high-divergence flag); it
never sets `primaryPick` — `decide()` + `validateSelection()` remain the
authoritative arbiters per the file's own header comment.

### 5.6 `weighReversibility` — defined, unwired

`safety/index.ts:1172`. Exported from the barrel (`index.ts:288`) but has zero
call sites anywhere in `packages/` beyond its own definition and that
re-export — currently dead code, not part of the live decision path. Verify
before assuming it affects picks.

## 6. Dormant modules

- **`ratings/index.ts`** (`TeamRatingsEngine`, Elo + Constantinou & Fenton 2013
  pi-ratings) — ported from `archive/ORACLE_v2026_8_0.jsx §4:1323-1371`. Fully
  self-contained (StoragePort-backed Elo/pi caches, `update`/`updatePi`
  methods) but **zero `new TeamRatingsEngine(` call sites in `packages/`** —
  defined, never instantiated. Do not assume Elo/pi-ratings influence live
  picks without checking this first.
- **`gbm/index.ts`** (`blendGbmIntoFp`, XGBoost residual blend on top of Poisson
  fair probs) — this is not simply forgotten, it's deliberately gated: the
  module's own header states the currently-saved model **fails its own
  walk-forward significance gate** (RPS improvement −0.0012 vs. the +0.002
  threshold required, per `tools/gbm_residual.py`), so it stays inert until
  `OracleConfig.enableGbmResidual` is explicitly set true *and* a model that
  passes the gate is dropped into `.tmp/models/gbm_residual.json`. Independent
  of that flag, `blendGbmIntoFp` currently has **no call site** in `batch/`,
  `execution/`, `goalsV3/`, or `marketsV3/` — the wiring is not present even
  behind the flag. See `workflows/gbm_residual.md` for the rejection rationale
  (dated 2026-06-07, concluded calibration-signal-only, not a probability
  replacement).

## Changelog

- **2026-07-20** — Phase 4 λ fallback ladder (`feat/lambda-fallback-ladder`, stateful-rolling-elephant
  plan). NEW `marketsV3/lambdaFallback.ts`: `computeLambdaFallback()` — when `computeV3Lambdas`
  (goalsV3/lambda.ts) returns null (zero usable scoring signal for a side), tries progressively
  weaker, honestly-labeled λ sources instead of letting the fixture vanish from the slate: **F1**
  this fixture's own H2H over-2.5 hit rate (Poisson-inverted via bisection), **F2** each team's own
  season O2.5 hit-rate (independent of this pairing), **F3** the league baseline (always resolves —
  `v3LeaguePerTeamAvg` has a hardcoded default floor for any league string), **F4** market-implied via
  the devigged 1X2 book. F1-F3 are independent of the fixture's own odds, so a +EV pick priced off
  them is real; F4 derives λ FROM the fixture's own market, so pricing EV against it is circular —
  `analyzeFixtureMarketsV3` forces every F4-sourced outcome to `outcome:"below_gate"` +
  `gateReason:"lambda_market_implied"` (new `V3AllGateReason` member) so it can never reach
  `evMarkets`/`best`/`v3BestFallback`'s fill-to-39 pool but still surfaces in `v3Watchlist`
  (`outcome !== "done"`), labeled. **F3 always resolving means F4 is defensive-in-depth, not reachable
  through the real ladder today** — documented in-code rather than fabricating a test for it (same
  precedent as the Wave-2/X-carveout unreachable-branch findings below). **F5** (a single scraped O/U
  line's devigged probability, per the original plan) deliberately deferred — F4's devigged-1X2 book
  already covers every fixture that reaches pricing at all (no odds ⇒ no fixture in the pipeline),
  making it a strict superset of F5's coverage for a fraction of the anchored-line-parsing complexity.
  **§3.1b recency blend — found already shipped**, not built this pass: `sportyBetStats.ts`'s
  `blendRecencyScored()` (60/40 recent/season, `stats.recentGoals.{home,away}.scored_avg` with a
  form-string-decay fallback) was wired into `buildStatsOverride`'s `scoredPer90H/A` — which feeds
  `V3LambdaInput.homeScoredPer90/awayScoredPer90` directly — by the concurrent SportyBet
  stat-coverage session (`062b3e9`, same day) before this phase started; confirmed via `git log --
  packages/runtime/src/sportyBetStats.ts` rather than assumed. Not literally "venue-split" last-5 (the
  sidecar's `form.last5` is each team's last 5 matches overall, not filtered to home-only/away-only
  meetings — that specific cut of data does not exist in the Sportradar gismo feed) — using the real,
  honestly-labeled team-level recency signal instead of fabricating a venue-conditioned one that isn't
  scraped, per the plan's own explicit "verify the data exists first" gate. New tests:
  `test/lambdaFallback.test.ts` (11 per-rung unit tests) + 2 `marketsV3.test.ts` integration tests
  (zero-stats fixture yields an F3-labeled result instead of null; fully-statted fixture leaves
  `lambdaBasis`/`lambdaLabel` undefined — byte-identical to pre-Phase-4 output).
- **2026-07-16** — patterns-engine Wave 2, three phases stacked on Wave 1 (PR #69, merged): Phase 2
  (`feature/patterns-engine-wave2-gate`, `7810b38`), Phase 3 (`feature/patterns-engine-wave2-ah-pivot`,
  `41e98a8`, stacked on Phase 2), Phase 0 (`feature/patterns-engine-wave2-telemetry`, `fad1afc`, stacked
  on Phase 3) — not yet pushed/PR'd as of this entry, see handoff.md for exact commands.
  **Phase 2 — pattern-backed class-edge relaxation** (`evGate.ts`): `gateAllMarkets` gains
  `patternMode`/`patternBacked`/`patternStrength` opts. **The repo's SECOND deliberate gate
  relaxation** (after the X-carveout below) — relaxes ONLY `CLASS_GATE_BLEND`'s `minAdjEdgeBlend`,
  scaled by the Wave-1 detector's strength (`PATTERN_MIN_STRENGTH=0.3` floor, up to 50% relaxation at
  strength 1.0 via `PATTERN_EDGE_RELAX_MAX=0.5`). Every other bar (EV%, max odds, the raw absolute/
  relative caps, the noise gate) stays at full strength; adds an explicit `ev > 0` value floor ON TOP
  of the standard `blendEV >= evFloor` check (defensive-in-depth — provably redundant today since
  `evFloor` is always 0 and `blendEV < ev` whenever `rawEdge > 0`, but holds the line if `evFloor` is
  ever loosened below zero at a future call site). Three modes (`ORACLE_V3_PATTERNS`, default
  `shadow`): off (byte-identical), shadow (tags `patternRelaxed:"shadow_pass"`, never admits), on
  (admits, confidence floored at "medium", boosted by strength via `patternConfidence`).
  `analyzeFixtureMarkets.ts`'s `buildFixturePatternInput`/`sideMatches` build the per-fixture
  `PatternInput` and conservatively match each priced outcome's family+side against the detector's
  top pattern (anchored `descParse.ts` parsers — `sideOfDesc`/`dirOfDesc`/`lineOfDesc`, never a
  substring match; AH/DNB matching is side-only/line-insensitive, a documented limitation deferred to
  Phase 3's line-selection scope). **Fill-to-39**: `batch/index.ts` derives `v3BestFallback` (a
  fixture's best +EV candidate that failed ONLY the class_edge bar — `outcome==="below_gate" &&
  gateReason==="class_edge"`, NOT merely `outcome!=="done"`) for the slate pool
  (`slateOutputs.ts`'s tiered `buildMarketsV3SlateOutputs`, gate survivors always outrank fallbacks).
  **Independent Opus adversarial review caught a critical pre-merge bug**: the first fallback-filter
  draft used `outcome !== "done"`, which also admitted `"capped"`/`"noise"` outcomes — re-opening the
  exact fake-longshot-edge door (2026-07-09 HSH incident) the raw-edge caps exist to close. Fixed
  before commit; regression tests added (`marketsV3BatchIntegration.test.ts`). The review also found
  and fixed a corners line-match substring bug (`analyzeFixtureMarkets.ts`'s `sideMatches` now uses
  anchored `lineOfDesc`, not `.includes()`).
  **Phase 3 — Under→Asian Handicap pivot** (owner rule: NEVER recommend an Under market):
  `analyzeFixtureMarketsV3` unconditionally strips every `goals_ou`/`team_total` Under `EVMarket`
  entry before the final rank sort — not gated behind any flag or the legacy `LOW_SCORING` regime
  classifier. Deliberately does NOT synthesize a replacement price via `math/index.ts`'s
  `detectLowScoringRegime`/`asianHandicapPivot` (a documented, deliberate deviation from that
  function's literal mention in the original brief) — those recommend a theoretical AH line with no
  guaranteed real offered odds, and pricing an EV against odds nobody offers would be dishonest
  real-money math. The genuine "pivot" is structural: real `asian_handicap` outcomes are already
  priced+gated in the same per-outcome loop as every other market, so one already competes honestly
  in `evMarkets` on its own merit whenever it clears the gate — stripping the Under just lets it (or
  any other genuine survivor) surface as `best`. "Never drop": no fabrication — `best` is `null` when
  nothing else cleared the gate, same as any gate-dry fixture. `assessments`/`capped` stay untouched
  (Unders remain visible there for transparency). Also closed a cross-phase gap: Phase 2's
  `v3BestFallback` filter (sources from `assessments` directly, entirely outside this evMarkets-level
  strip) needed the identical `TOTALS_FAMILIES`+`dirOfDesc==="under"` exclusion added, or a near-miss
  Under could re-enter the actionable pool through the fill-to-39 back door.
  **Phase 0 — streak/last5Pts telemetry**: wires the sidecar's `form.streak` (signed win/loss run,
  direct passthrough) and `form.last5` (new `last5Points()` sum: 3/win+1/draw+0/loss) into
  `PatternInput.streakH/A`/`last5PtsH/A`, mirroring the existing `refereeCardsRate` 4-hop wiring
  precedent (`sportyBetStats.ts`'s `StatsOverride` → `RunState.telemetry` → `buildV3Input` →
  `V3AllMarketsInput` → `buildFixturePatternInput`). `h2hOversRate` (also named in the original brief)
  is explicitly deferred — it requires modifying the separate, rate-limited `h2h.ts` external-API
  module (its own 6h-cache/20-job-cap/football-data.org quota concerns), scoped out as its own
  follow-up rather than folded into this already-large wave.
  New tests: `patternGate.test.ts` (8, isolated gate-math invariants with hand-derived numeric
  scenarios), `patternsIntegration.test.ts` (3, full-pipeline integration),
  `underAhPivot.test.ts` (5, Under-strip/AH-survival/never-drop/never-fabricate/transparency,
  odds independently verified against a standalone Poisson/devig/gate replica before being committed).
  Engine 939/939, runtime 679/679, worker 65/65 at every commit; typecheck + biome clean throughout.
- **2026-07-11** — X-carveout (branch `feature/x-carveout`), same day, later than the Wave-4-accuracy
  entry below. New tri-state flag `ORACLE_V3_X_CARVEOUT` (config `v3XCarveout`; `off`/`shadow`/`on`,
  **default off**) — **the repo's FIRST deliberate gate relaxation** (patterns-engine Wave 2 above adds
  a second); every other flag in this codebase only raises bars. Background: Wave-4's
  `ORACLE_V3_BLEND_PRICING` made Class X exotics unreachable by
  construction (raw-space −5pt exotic penalty vs blend-space edges: max rawEdgeBlend=0.40×0.12=0.048,
  minus 0.05 ⇒ can never reach X's 0.02 blend floor). This carve-out re-evaluates ONLY the blend-edge
  floor, with the raw-space penalty rescaled into blend units (`X_CARVEOUT_PENALTY_RESCALE=1/3`, the
  same raw→blend ratio the class bars already use) — every other X bar stays at full strength and is
  NOT relaxed: `maxOdds≤15`, `blendEV≥12%`, the EV floor, raw absolute/relative edge caps + the noise
  gate (untouched, evaluated first, exactly as before), and the heightened-fixture X-exclusion
  (untouched). Additionally gates on data-quality conviction: confirmed real xG AND
  completeness≥0.8 (`X_CARVEOUT_MIN_COMPLETENESS=0.8`, ⇒ wModel≥0.37/0.40). Reachable window is
  deliberately narrow — shortish-odds exotics (roughly 3.0–3.5) with near-cap raw edge and near-full
  data quality; at long odds the 30% relative raw cap keeps X unreachable regardless. `shadow`: tags
  would-pass assessments (`xCarveout:"shadow_pass"`, carried into `V3AssessmentStat` for slate reports)
  without changing any outcome — this is the required first step. `on`: admits qualifiers, but pins
  `confidence:"medium"` (floor band, never higher) — a carve-out pick is never treated as high-confidence
  regardless of its raw numbers. Admitted picks stake/rank on `adjustedEdgeCarveout` (the rescaled
  carve-out edge, ≥0.02 by construction; `analyzeFixtureMarkets` swaps it in as the primary
  `adjustedEdge`) — the standard `adjustedEdgeBlend` is ≤ −0.002 for every X candidate and would
  zero-Kelly + bottom-rank the pick (Opus review finding, fixed pre-merge); shadow rows carry the
  same field as the counterfactual for ledger analysis. **Promotion bar is ledger evidence accumulated from shadow-tagged
  assessments across real slates — never a hand-flip**, same discipline as every other shadow-gated
  flag in this table (`ORACLE_V3_RATINGS`, `ORACLE_SHARP_FEED`, `ORACLE_CALIBRATION_LEDGER`).
  Implemented in `packages/engine/src/marketsV3/evGate.ts` (constants `X_CARVEOUT_PENALTY_RESCALE=1/3`,
  `X_CARVEOUT_MIN_COMPLETENESS=0.8`), threaded `env.ts` → `OracleConfig` → `buildV3Input` →
  `gateAllMarkets`; new test file `packages/engine/test/xCarveout.test.ts`. See
  `workflows/markets_v3.md`'s env-flag table for the full row.
- **2026-07-11** — Wave-4-accuracy (branch `feature/wave-4-accuracy`). Fixes the 2026-07-10 live
  pathologies. **Kelly staking wired** — `analyzeFixtureMarketsV3` picks now carry real
  `optimizedKelly` stakes via `v3AssessmentsToEvMarkets` (was hardcoded `stake:0` → every pick
  reported 0.0% Kelly). **Market-anchored blend pricing on ALL candidates** (`ORACLE_V3_BLEND_PRICING`,
  default on) — `evGate.ts` gains `CLASS_GATE_BLEND`/`CLASS_GATE_BLEND_HEIGHTENED` (rescaled ~1/3 raw
  bars; heightened ×1.30; Class X unreachable by construction (later same-day: default-off
  `ORACLE_V3_X_CARVEOUT` carve-out — see entry above)); gates/EV/confidence/ranking/stake use
  blended values, caps+noise stay on RAW edge (hard invariant). Kills fake soft-market edges (HSH).
  **Totals empirical blend** (`ORACLE_V3_TOTALS_EMPIRICAL`, default on) — goals O/U 1.5/2.5/3.5 blend
  hit-rates (goals counter only). **Eligibility rework** (`goalsV3/eligibility.ts`) — league whitelist
  demoted to non-gating `off_whitelist`; WC/internationals included; friendlies restricted to
  goals-Over markets (not discarded); derby→heightened. **News intel keyless** + real yield reporting.
  **Booking** anchored matcher (no wrong-market binds). **v5.1 prompt doc** + parity tests
  (`packages/{engine,runtime}/test/promptDocParity.test.ts`) make doc/constant drift a CI failure.
- **2026-07-10** — Refactor Wave 3, WS3-C hygiene sweep (branch `feature/wave-3`, P2-2/P2-3,
  comment-only — no executable-logic changes). `math/index.ts`: distinguished the §8.2 Skellam
  cross-check's Wilkens (2026) citation — **verified** (standard result: independent-Poisson goal
  margins are Skellam-distributed by construction) and correctly gated off-by-default behind
  `useSkellam` (`types.ts:200`, default `false`) — from `adaptiveVarianceRegime` (Antila 2024) and
  `leeRecoveryConstraint` (Lee 2025), which **stay flagged as house defaults**: both run
  UNCONDITIONALLY every pricing pass (no opt-out flag, feeding `execution/index.ts`'s
  `drawdownPenaltyFinal` via `_bindingRisk`) and neither citation/heuristic has been independently
  validated against ORACLE's own resolved-bet ledger. All three variants' doc comments now state
  their promotion bar explicitly: the same walk-forward/`significanceAcceptGate` treatment
  (minN=300, effect bar) already used to gate the ratings/GBM dormant variants. `gbm/index.ts`:
  added the same explicit gate pointer directly on `blendGbmIntoFp` (previously only stated at the
  module header) — do not wire a call site until `.tmp/models/gbm_residual_meta.json`'s
  `gate_passed` flag is true. `rag/index.ts`: found and documented a previously-unflagged dormant
  module — `PostmortemRegistry`/`postmortemRegistry` (pre-seeded with 4 confirmed 2026-03-10
  losses) has **zero live call sites** for `.check()`/`.formatWarning()` outside its own unit
  tests (verified via call-site grep across `packages/`), same unwired status as `safety/
  index.ts`'s `weighReversibility` (§5.6 below) — now documented at the class definition rather
  than silently assumed live. `safety/index.ts`: added the exact S02-S05 activation bar the
  existing `sharpSignalsEnabled` gating was missing — per Wave 2's WS2-C spec, `sharpFeedVerified`
  may only flip true after `runtime/sharpFeed.ts` demonstrates >=95% pick coverage over 7
  CONSECUTIVE slates (not a single clean slate); stated on both the SIGNAL TABLE comment and the
  `scoreMarket` parameter doc so it can't drift out of sync. No citations found needing correction
  in `safety/index.ts` (none present) or `rag/index.ts` (none present beyond well-known Benford's
  Law, unattributed to a specific paper by design). Module-index table above gained a row for
  `safety/pipeline.ts` (new this wave, WS3-A — not otherwise this workstream's file to edit).
- **2026-07-10** — Refactor Wave 2 (branch `feature/wave-2`, multi-workstream).
  **Per-segment calibration** (`calibration/index.ts`): `ORACLE_CALIBRATION_LEDGER=segment`
  mode accumulates `{n,wins,pSum}` factors scoped to `ORACLE_CALIBRATION_EPOCH_START`
  (default `2026-07-10`, the Wave-1 P0-2/P0-3 pricing-behavior boundary) so
  pre-epoch records don't poison segment factors derived from the new
  blend/penalty pricing. **pi-ratings blend, WS2-B, built but UNWIRED**
  (`ratings/index.ts`, `goalsV3/lambda.ts`, new `ratings/walkForward.ts`):
  `TeamRatingsEngine`'s `PiStore` gained a per-team `n` sample counter
  (`getPiN`, incremented in `updatePi`, missing `n` on old persisted data
  defaults to 0); new pure `ratingsXgd(homePi, awayPi)` derives a
  goal-difference-ish signal reusing `updatePi`'s own `/3` tanh
  normalization, and `buildRatingsLambdaInput(engine, home, away)` packages
  `{ratingsXgd, ratingsN}` for a caller. `goalsV3/lambda.ts`'s
  `V3LambdaInput` carries `ratingsXgd`/`ratingsN`; `computeV3Lambdas` gained
  a THIRD blend factor (after goals+xG, before HFA) behind
  `opts.ratingsBlend` (default **false**, opposite default of `xgBlend` —
  brand-new live-pricing input, opt-in only), weighted by new
  `ratingsBlendWeight(n, shrinkN)` = `min(0.25, 0.25) * n/(n+shrinkN)` — a
  HARD 0.25 ceiling that only asymptotically approaches, never reaches,
  unlike `xgBlendWeight`'s 0.5-ceiling linear ramp that hits its cap exactly
  at n=shrinkN. New `ratings/walkForward.ts` (`runRatingsWalkForward`)
  wraps `rankedProbabilityScore` + `significanceAcceptGate` into a reusable
  baseline-vs-candidate RPS harness. **As of this entry, NONE of this has a
  call site anywhere in `batch/`/`execution/`/`goalsV3/`/`marketsV3/`** —
  `opts.ratingsBlend` is never passed `true` by any caller yet, so
  `computeV3Lambdas`'s live output is unchanged. `ORACLE_V3_RATINGS`
  defaulting to `shadow` and actually wiring `buildRatingsLambdaInput` +
  `opts.ratingsBlend: true` into a real call site is explicitly Wave-3 scope,
  gated on the walk-forward harness clearing its +0.002 RPS bar against real
  historical data first (see `buildRatingsLambdaInput`'s own JSDoc for the
  exact contract). **Sharp feed + CLV persistence**
  (`runtime/sharpFeed.ts`, new `tools/fetch_sharp_odds.py`): sharp-reference
  odds capture (Odds API primary + Playwright/Google-AI-Mode fallback) gated
  `ORACLE_SHARP_FEED` (default `shadow`), persisting CLV records without yet
  flipping `sharpFeedVerified`. **v5 prompt adoption** (`decision/index.ts`):
  decision-layer prompt cascade updated to the v5 spec. **Telemetry additions
  (WS2-E, this entry's author)**: `runtime/columnFillReport.ts`'s
  `buildColumnFillReport()` — pure per-slate stats/xG/odds column-fill
  counter, run pre-pricing so data gaps are visible before completeness
  downgrades happen silently; `swarm/index.ts`'s `computeDisagreementRate()`
  — unweighted worker-dissent fraction, a second diagnostic alongside
  `SwarmResult.divergence`'s confidence-weighted metric, exported for a
  future ledger call site; `apps/worker/src/index.ts`'s new GBM
  re-validation cron (Sunday 03:00 WAT, internally gated to ~4 gameweeks) —
  runs `tools/gbm_residual.py` and logs the RPS-delta verdict vs the +0.002
  accept gate; **strictly read-only w.r.t. config** — it never flips
  `ORACLE_V3_RATINGS` or any other flag regardless of the result. See
  `workflows/markets_v3.md`'s flag table for the three new Wave-2 flags
  (`ORACLE_CALIBRATION_EPOCH_START`, `ORACLE_V3_RATINGS`, `ORACLE_SHARP_FEED`).
  **Known Wave-2 gap** (not this workstream's to close): `FixtureJobSuccess`/
  `BatchResult` (`batch/index.ts`) carry no per-fixture `safety.killCounts`
  or `evGate.gateReason` tally — the daily fixture report
  (`runtime/dailyFixtureReport.ts`) also runs at 09:30 WAT, before the
  09:35 WAT pricing batch even executes, so it structurally cannot surface
  either signal without either (a) a new post-batch report call site, or
  (b) wiring into `runtime/report.ts` (the report that already receives
  `BatchResult`) instead.
- **2026-07-10** — Refactor Wave 1 (branch `feature/wave-1`, 6 commits). **P0-2
  market-anchored blend** (`marketsV3/evGate.ts`): `gateAllMarkets` now computes
  `wModel = min(0.40, 0.15 + 0.15·completeness + 0.10·realXg)`,
  `pBlend = (1−w)·q_fair + w·P_model`, `blendEdge = pBlend·odds − 1` on every
  assessment; a **mandatory `blendEdge ≥ +5%` gate fires at odds ≥ 4.00** on top
  of the Class L/X bars (the longshot-inflation fix), tagged `model_hot_longshot`
  when it kills. `below_gate` is now reason-tagged (`gateReason`). `evFloor` is
  finally passed at the `analyzeFixtureMarkets.ts` call site (was defaulting to 0
  — latent bug). Flag `ORACLE_V3_BLEND` (default on; fields persisted in all
  modes). **P0-3/P0-4 safety** (`safety/index.ts`, `execution/index.ts`):
  MLSafetyFilter hard rejects (S1 odds-band, S7 low-xG, S11 derby/injury, S13
  upset-league, S16 sharp-fade, S17 miscalibration, draw-risk) become
  market-**family** stake downgrades via new `familyPenaltyMultiplier`, applied
  in `_run` after `MLSafetyFilter.evaluate({ mode })`; hard rejects survive only
  under `ORACLE_SAFETY_MODE=legacy` (rollback). Per-filter kill telemetry
  (`filters[]` + `killCounts`, previously built and discarded). `S01` is now
  graduated + sign-aware (≤5pt +3, 5–8pt 0, >8pt **−3**), reconciled with S14's
  `[NEGATIVE_EV_ALERT]`. S02–S05 zero-weighted until `sharpFeedVerified`.
  `weighReversibility` deleted (was dead). **LLM cascade** (`llm/`,
  `decision/index.ts`): local Claude Code CLI pinned to **Opus** (owner
  instruction), then Gemini 3.5 Flash, then OpenRouter **free tier** (GLM-5.2 →
  DeepSeek V4-Pro → V4-Flash → Gemma 4, each unverified `:free` slug backed by a
  verified free substitute); GLM-5.2 shadow path retired. Companion runtime work
  (P1-3 feed integrity, worker merge, v5 four-output delivery) lands in
  `@oracle/runtime` / `apps/worker` — see `workflows/markets_v3.md`.
- **2026-07-09** — PR-25 item 2: referee-assignment fetcher + cards shadow
  diagnostic. `tools/compute_referee_cards.py` (new) aggregates
  `.tmp/backfill/*.csv`'s existing `Referee`/`HY`/`AY`/`HR`/`AR` columns
  (zero new scraping) into a per-(league, referee) empirical-Bayes shrunk
  cards-per-game rate (count-based, NOT points-weighted — see the file's
  header for why that matters for unit-compatibility with the shadow
  diagnostic below), keyed by a first-initial+surname normaliser that
  bridges football-data.co.uk's abbreviated names ("R Jones") and
  premierleague.com's full names ("Rob Jones"). `tools/fetch_referee_
  assignments.py` (new) scrapes premierleague.com's "Match Officials for
  Matchweek N" articles (EPL only) — Playwright-required despite the
  referee text being static HTML, because the fixture/team-name half of
  each assignment only resolves via a client-side-rendered
  `embeddable-match-card` widget (verified live against a real matchweek
  page); no automated "find this week's article" discovery yet (documented
  limitation, not silently glossed over — see that file's header). Both
  fail-open (empty output, exit 0) per this repo's "missing data is never a
  blocker" convention. `scrape_fixtures.py`'s `enrich_sportybet_events` now
  merges a fixture-level (not home/away-split — one referee, both teams)
  `referee` block into the sidecar the same way as the existing xg/
  availability/weather tables. `sportyBetStats.ts`'s `StatsOverride` gained
  `refereeCardsRate`/`refereeName`/`refereeCardsRateSrc`, ungated like
  restH/restA (independent external data, not a team-sample statistic).
  New `marketsV3/refereeCardsShadow.ts` (`shadowRefereeCards`) — shadow-only
  (see `finishingRegression.ts`/`skewShrink.ts` precedent), compares the
  live cards Poisson model's total mean (`V3CardsMeans.total`) against the
  referee's independent rate and flags >15% divergence;
  `analyzeFixtureMarketsV3` computes it unconditionally (no new flag) and
  attaches it as `V3AllMarketsResult.refereeShadow` — never affects
  `ctx.cards`/`evMarkets`/`best`. Coverage caveat: EPL-only, so this fires
  far less often than skewShrink/finishingRegression.
- **2026-07-09** — PR-25 item 4: npxG/xAG as distinct shadow signals.
  `tools/build_xg_table.py` `_load_fbref_xg()` now also derives per-match
  `npxgf`/`xagf` (non-penalty xG / expected-assisted-goals) from
  `fetch_fbref.py`'s already-computed columns — zero new scraping.
  `scrape_fixtures.py` `_xg_for()` passes them through into the sidecar's xg
  block; `sportyBetStats.ts` surfaces `npxgfH/A`/`xagfH/A` on `StatsOverride`;
  `goalsV3/lambda.ts` `V3LambdaInput` carries `homeNpxgf`/`awayNpxgf` (NOT
  consumed by `computeV3Lambdas` — diagnostic input only). New
  `marketsV3/finishingRegression.ts` (`shadowFinishingRegression`) shadow-
  evaluates a team's actual scoring rate against its FBref npxG rate and
  flags >25% divergence; `analyzeFixtureMarketsV3` computes it unconditionally
  (no new flag, matching `skewShrink.ts`'s precedent) and attaches it as
  `V3AllMarketsResult.finishingShadow` — never affects lambdas/evMarkets/best.
  Coverage caveat: npxgf/xagf are FBref-only, absent for Understat/FotMob/
  Sofascore/AI-mode teams, so this fires far less often than skewShrink.
- **2026-07-08** — full-audit P3 per-league HFA. `tools/compute_league_baselines
  .py` now also fits per-league HFA (m = √(home gpg / away gpg), clamped
  [1.0, 1.30]) into the same JSON's `hfaByName`; `runtime/env.ts` `loadLakeHfa()`
  loads it into `config.v3HfaByLeague` when `ORACLE_V3_LAKE_HFA=on` (default off).
  `batch/index.ts` `buildV3Input` picks `v3HfaByLeague[job.league] ?? v3Hfa` for
  the all-markets λ HFA term (`opts.hfa` in `lambda.ts`, unchanged). Goals-only
  path still passes no HFA (pre-existing gap). Default off ⇒ global `v3Hfa`.
- **2026-07-08** — audit P0-2 lake baselines wired into the λ core.
  `goalsV3/lambda.ts` `v3LeaguePerTeamAvg` gained a third `lakeBaselines?`
  param (lookup order: ID-keyed override → lake-by-name → static
  `V3_LEAGUE_BASELINES` → `LEAGUE_PARAMS` → default); `computeV3Lambdas` opts
  and both `V3AnalyzeInput`/`V3AllMarketsInput` carry it, threaded from
  `config.v3LakeBaselines` in `batch/index.ts` + worker `goalsV3Pipeline.ts`.
  Loaded by `runtime/env.ts` `loadLakeBaselines()` from
  `.tmp/oracle-store/league_baselines.json` (produced by
  `tools/compute_league_baselines.py`) only when `ORACLE_V3_LAKE_BASELINES=on`
  (default off ⇒ static-only, byte-identical). Fails open to static on any load
  miss. See `workflows/markets_v3.md` env-flag table.
- **2026-07-08** — skill created. Navigation core (module index, pipeline
  shape, math quick-ref, Kelly-cap doc gap closed, EV-gate per-class
  correction) + first-ever documentation of `safety/`, `rag/`, `swarm/`,
  `ratings/` (dormant), `gbm/` (gated off, unwired). Companion fix: corrected
  the blanket "ev > 0.04" claim in `workflows/oracle_decision_rubric.md`
  (lines 24, 82).

**Maintenance**: if a PR touches
`packages/engine/src/{math,goalsV3,marketsV3,safety,calibration,ratings,rag,swarm,gbm}/**`,
update this skill's module-index table and/or add a changelog row here (see
CLAUDE.md's PR self-review checklist). Line numbers cited throughout are a map,
not gospel — grep the symbol name to confirm before trusting a constant.
