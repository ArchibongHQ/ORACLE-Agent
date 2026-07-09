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
