# ORACLE — Product Requirements & Technical Specification
### Omniscient Research & Analytical Computation for League Evaluation
**Document version:** 1.2.1 · **Target build:** v2027.0 · **Status:** ⚠️ HISTORICAL — Phase 0 complete

> **⚠️ Archive notice (2026-06-10).** Phase 0 extracted the monolith into `packages/` and this
> document's `line ~N` references are no longer valid (see §0 note). The pre-refactor monolith now
> lives in `archive/ORACLE_v2026_8_0.jsx`. For current architecture and commands read `README.md`,
> `VISION.md`, and `CLAUDE.md`; for operations read `workflows/`. This spec remains the rationale
> record for the objective function (§2), methodology gates (§8), and agent-ops contract (§11A).

> **Changelog v1.2 → v1.2.1 (data-source currency pass, June 2026).** Re-verified every source in §8.7/§14 against the live web. Corrections: **FiveThirtyEight removed** (SPI discontinued, dropped from `soccerdata`); `soccerdata` wrapped-source list updated (v1.9.0; adds ESPN/Sofascore/SoFIFA/WhoScored); **Understat** narrowed to top-5 leagues (RPL no longer listed, flagged to verify) and marked scraping-fragile; **FBref** flagged Cloudflare + tightened rate-limit (wrapper-only); **Kaggle** dataset is 27 countries / 42 leagues; **the-odds-api free tier (500 credits/mo ≈ 16 req/day)** added as a named §7/§11A.4 batch constraint — it cannot feed a full 39-fixture daily batch, forcing a Phase-3 paid-tier-vs-throttle decision.
>
> **Changelog v1.1 → v1.2.** Audit pass focused on **agent operability** (an agent that both builds and unattended-operates ORACLE) and on closing methodology gaps that could silently reintroduce overfitting. Changes: (1) **§6** now specifies a *soft-context ingestion feed* — the LLM decision role was justified by late news/lineups/motivation with no data source — and mandates deterministic decoding (`temperature=0`, pinned model, replayable prompt+response). (2) **§8.5** adds an **LLM training-data leakage protocol** (validate LLM picks only on post-cutoff/blinded fixtures) — scoring memorized historical outcomes was contaminating the one optimizer-touchable layer. (3) **§8.3/§8.5** add a **statistical-significance accept-gate** (min-N, bootstrap CI on the metric delta, effect-size floor) so no edit ships on a noisy point estimate. (4) **§2.3/§8.3** resolve the **thin-market calibration paradox** via hierarchical / partial-pooling shrinkage. (5) New **§11A — Agent Operations Contract** (run manifest, typed error taxonomy, idempotency keys, cost/rate-limit guardrails, the WAT `workflows/` SOP index). (6) **§8.3** treats CLV as a *quality-tagged proxy* given football-data's fixed-time "closing" lines. (7) New **Appendix B — Canonical Types**. (8) Resilience items folded into §3.1/§10 (schema versioning, ledger backup, GBrain fallback adapter, golden-master parity corpus). (9) §0 note: all JSX line numbers are pre-refactor coordinates, invalid after Phase 0.
>
> **Changelog v1.0 → v1.1.** Corrected the objective function. v1.0 made CLV the optimization target, which mismatched a forecasting engine to a market-timing metric, assumed a market efficiency the thin leagues lack, and invited proxy-gaming. v1.1 makes **calibration the optimization target, CLV a liquid-market-only gate, and profit the validation metric** — and reworks §2.3, §5, §6, §8.3–8.6 so every component derives from that one target. Added §8.7 (concrete data sources + backfill harness) and folded the graceful-xG-degradation and cross-source team-name requirements into the engine spec.

---

## 0. How to read this document

This is a hybrid **PRD + technical specification**. It is written to be implementation-grade: a capable engineering agent (Claude Code, Codex, or a human) should be able to build each section without further product clarification. Each feature section follows the same shape:

- **Goal** — what we are building and why.
- **Current state** — what exists in `ORACLE_v2026_8_0.jsx` today (file/line references where useful).
- **Spec** — the precise behaviour to implement.
- **Acceptance criteria** — testable conditions that define "done."

Where a decision was made by the product owner, it is marked **[DECIDED]**. Where the literature drove a choice, it is marked **[EVIDENCE]** with the source. Open items are marked **[OPEN]**.

> **Line-number note (v1.2).** Every `line ~N` / `§N in code` reference below points into the **pre-refactor** `ORACLE_v2026_8_0.jsx` monolith. Phase 0 (§3.1) extracts that file into packages, **invalidating all of these coordinates.** Treat them as archaeological pointers valid only against the frozen pre-refactor SHA of the `.jsx`. After Phase 0, the authoritative locations are the module paths in §3.1 and Appendix B (Canonical Types).

A note on scope discipline that governs the whole document: **ORACLE's value is its disciplined, auditable, deterministic quant core.** Every change below is constrained to preserve that. The LLM and any optimization layer operate *around* the math, never *as* the math.

---

## 1. Problem statement & background

### 1.1 What ORACLE is today

ORACLE is a quantitative football (soccer) betting analysis engine. For a single fixture it: ingests data (form, xG, injuries, weather, rest, live bookmaker odds), models the scoreline with a Poisson + Dixon–Coles matrix plus a zero-inflation layer, rates teams with Elo and pi-ratings, prices every betting market against the bookmaker, finds expected-value (EV) edges, sizes stakes with Kelly, stress-tests the result, and produces an LLM-written briefing with adversarial verification. It ships as a ~7,100-line single-file React component (`.jsx`).

### 1.2 The problems this document solves

1. **No real persistence.** Storage is faked in-memory (`_memStore`, §0a); state resets every session. This blocks backtesting, calibration over time, and learning.
2. **API-key fragility causes spurious "cannot find fixture" failures** (see §9).
3. **The ranking objective is implicitly "best odds," not "best bet."** ORACLE ranks markets by `rankingScore = ev × varianceMod` (line 4144), where EV scales with odds. This surfaces long-odds value over high-probability outcomes. The owner wants explicit, user-selectable objectives. (See §5.)
4. **No batch analysis or report output.** The engine runs one fixture per invocation; there is no way to queue 39 fixtures or emit an HTML report. (See §7.)
5. **The LLM advises but does not decide.** The owner wants the LLM to make the final market selection within hard math gates. (See §6.)
6. **No automated/scheduled operation.** Everything is manual and browser-bound. (See §11.)
7. **Accuracy ceiling.** The owner's north star is improving real predictive/financial performance. (See §4, §8.)

### 1.3 Audience & phasing

- **Now:** single power user (the owner), stealth, full control of infrastructure.
- **Later:** a real product with paying users, on a managed cloud backend, once accuracy is proven.

The architecture below is explicitly designed so the *later* state is a deployment change, not a rewrite.

---

## 2. Goals, non-goals, and the objective function

### 2.1 Goals

- Make ORACLE's decision objective **explicit, correct, and user-controllable**.
- Add **real persistence** so the system can learn and be evaluated over time.
- Add **batch fixture analysis with HTML output**.
- Let the **LLM make the final selection within hard, non-overridable math gates**.
- Improve accuracy via **evidence-based model upgrades** and a **disciplined, validation-gated prompt/skill optimization loop**.
- Add **scheduled, automated operation** as the final phase.

### 2.2 Non-goals

- Replacing the deterministic quant core with an end-to-end ML or LLM model. **[EVIDENCE]** Published models cluster near RPS ≈ 0.21 regardless of method (Hubáček et al.; the ML survey, arXiv:2403.07669), and bookmaker odds remain hard to beat — so a rewrite is high-risk, low-reward.
- Auto-optimizing the quant core with a ratchet/optimizer (overfitting risk; see §8.4).
- Building a sportsbook, handling real money movement, or providing regulated financial advice.

### 2.3 The objective function: one target, three roles **[DECIDED] [EVIDENCE]**

ORACLE optimizes a **single objective expressed as a causal chain**, not three competing metrics:

> **Calibrated probability → (in liquid markets) positive CLV → long-run profit.**

The chain runs one direction only. Each metric has a distinct, non-overlapping role:

- **Optimization target — calibration.** The quantity ORACLE actively optimizes is the calibration of its probability estimates against *actual match outcomes* (RPS as primary, plus reliability/calibration curves per league and per market). Calibration is the correct target for three reasons: it is measured against ground truth (outcomes are real and **cannot be gamed** — unlike a proxy); it matches what ORACLE *is* (a forecasting engine, not a market-timing engine); and it is **market-independent**, working identically in liquid and thin leagues. RPS is already ORACLE's primary metric — this elevates it to *the* optimization handle.
  - **Thin-market resolution (v1.2) [DECIDED].** "Market-independent" does not mean "estimable everywhere from local data." Thin leagues (lower divisions, women's football) are exactly where per-league sample counts are smallest, so a naive per-league reliability curve there is statistically empty — the same place CLV is also unavailable (it would otherwise be a double blind spot). ORACLE therefore estimates calibration with **hierarchical / partial pooling**: thin-league parameters shrink toward a tier-level (and ultimately global) prior, with shrinkage weight inversely proportional to that league's resolved-sample count. A league earns more of its own idiosyncratic calibration only as its sample grows. This is specified concretely in §8.3.
  - **Significance discipline (v1.2) [DECIDED].** Because the published RPS frontier is ≈ 0.21, genuine improvements are small deltas easily mimicked by noise. Any claim that calibration "improved" — for a model change (§8.4), a SkillOpt edit (§8.5), or a ranking-mode default (§5) — must clear a **statistical-significance gate**, not a point-estimate comparison (defined in §8.3/§8.5). Calibration is the handle we turn; this gate is what stops us turning it on noise.
- **Conditional execution gate — CLV.** Closing Line Value confirms the model's edge is being *captured* at the bet, but **only where the closing line is efficient**. **[EVIDENCE]** The closing line is the market's sharpest estimate of true probability in liquid markets, and average CLV of +1–2% is the most reliable indicator of a profitable process (bet-analytix; SportBot AI; boydsbets, 2025–26). Therefore CLV is applied as a gate/diagnostic **only in liquid markets** (major-league 1X2, primary Asian Handicap — where Pinnacle closing odds exist). In thin markets (lower divisions, women's football) the closing line is *not* efficient, so CLV is ignored there and the system relies on calibration plus realised results over larger samples.
- **Validation — profit/ROI.** Realised profit is the true goal but the *worst* optimization target: it is the noisiest, slowest signal, and optimizing it directly is precisely how systems overfit. Profit is the **lagging metric we confirm against** over large samples, never the handle we turn.

**Why this resolves the v1.0 incoherence:** every downstream component now derives from one target measured against reality. Ranking modes (§5) are risk-preference *views* over the same calibrated probabilities; the LLM decision (§6) is scored on the *calibration of its picks*; SkillOpt (§8.5) optimizes against *held-out calibration*; CLV and profit occupy distinct, non-competing roles. Nothing optimizes a gameable proxy.

---

## 3. System architecture (the spine)

### 3.1 The prerequisite refactor

**Goal.** Everything in this document depends on one structural move: **extract the engines from the `.jsx` into a pure TypeScript package with zero React imports, behind a storage interface.**

**Current state.** All engines (`MathEngine`, `ExecutionEngine`, `CalibrationEngine`, `TeamRatingsEngine`, `MarketMakerEngine`, `AntiSycophancyCircuit`, `RAGSystem`, `CrowdWisdomProtocol`, `ConvergenceScorer`, `MLSafetyFilter`, `TelemetryAdapter`) live inside one `.jsx` file and are exported at §17. Persistence is faked (`_memStore`, §0a). API keys are read from `window.__ORACLE_CORE__` state.

**Spec.**

```
@oracle/engine                 (pure TS, no React, no window, no fetch-of-keys)
  ├─ math/                      MathEngine, distributions, DC, bivariate Poisson, Skellam
  ├─ execution/                 ExecutionEngine, scanMarkets, ranking (§5)
  ├─ ratings/                   Elo + pi-ratings
  ├─ calibration/               CalibrationEngine, CLV, RPS, draw calibration
  ├─ safety/                    MLSafetyFilter, AntiSycophancyCircuit, ConvergenceScorer
  ├─ decision/                  NEW — the gated decision layer (§6)
  ├─ regime/                    low-scoring / draw engine (§4 enhancements)
  └─ types.ts                   shared types

@oracle/storage                 (interface + adapters)
  ├─ StoragePort (interface)    get/set/list/query — the ONLY persistence contract
  ├─ MemoryAdapter              current behaviour, for tests
  └─ GBrainAdapter              Phase 2 (§10)

@oracle/llm                     (provider abstraction)
  ├─ callClaude / callGemini    cascade, retries (existing logic, lifted)
  └─ keys from env/secrets, NEVER from window

@oracle/worker                  (Phase 3, §11) — headless runner, batch, scheduler

apps/web                        (the existing React UI, now a thin consumer)
```

**Hard rules.**
- The engine must run identically in a browser, a Node worker, and a backtest harness. No `window`, no `localStorage`, no direct key access inside `@oracle/engine`.
- All persistence goes through `StoragePort`. The engine never imports a concrete adapter.
- API keys are injected at the boundary, never embedded or read from UI state. **Secrets choice (v1.2) [DECIDED]:** Phase 0-1 (solo/stealth) uses a gitignored `.env` loaded by the entry-point and passed in as `OracleConfig`; the cloud/paying-user phase uses the host's secrets manager. One mechanism per environment, not a menu. **No component may log key material** — the telemetry writer (§12 in code) redacts any field whose name matches a key pattern before persisting or printing.

**Golden-master parity corpus (v1.2).** The "identical output to the browser" rule needs a behaviour-lock, not just the T1–T367 unit suite. Before refactor, capture a frozen corpus of representative `input → full-result` snapshots from the current `.jsx` (a spread of regimes: clear favourite, low-scoring/draw-risk, missing-odds, ambiguous fixture). Phase 0 passes only when the extracted engine reproduces every snapshot byte-for-byte (modulo documented float tolerance). This corpus is the regression oracle for the whole migration.

**Acceptance criteria.**
- `@oracle/engine` has zero imports from `react`, `window`, or any storage/network concrete.
- The existing test suite (T1–T367) passes against the extracted engine unchanged.
- A Node script can call `ExecutionEngine.run(state)` headlessly and get identical output to the browser for the same input.
- The golden-master corpus reproduces byte-for-byte (within documented tolerance) against the extracted engine.
- A grep for key material in any emitted log/manifest/report finds nothing.

### 3.2 Phased roadmap **[DECIDED: order 1→2→3]**

| Phase | Theme | Delivers | Depends on |
|-------|-------|----------|------------|
| **0** | Spine | Engine extraction, StoragePort, key handling | — |
| **1** | Accuracy | Ranking modes (§5), gated LLM decision (§6), model upgrades (§8), draw engine (§4), fixture-fix (§9) | Phase 0 |
| **2** | Persistence | GBrain adapter, real RAG, scored history ledger (§10) | Phase 0 |
| **3** | Automation | Batch + HTML (§7), scheduled worker, SkillOpt loop (§8.5) | Phases 1 & 2 |

> **Sequencing note (important):** the owner chose 1→2→3. The one genuine dependency: the **SkillOpt loop (§8.5)** and **CLV-gated evaluation (§8.3)** need accumulated *scored* history. v1.1 softens this — the **historical backfill harness (§8.7)** lets initial calibration be computed in Phase 1 from imported data, so calibration measurement and quant-core backtesting (§8.4) no longer wait for Phase 2 live accumulation. What still genuinely lands after Phase 2 is the *continuous* live-data accumulation that makes SkillOpt and per-league tuning robust. Everything else in Phase 1 ships independently.

---

## 4. The draw / low-scoring engine

**Goal.** Reliably identify fixtures likely to end as draws or low-scoring, and route them to markets a 0-0/1-0/0-1 cannot bust. The owner asked whether this exists — **it does, and it is one of ORACLE's strongest assets.** This section documents it and specifies evidence-based enhancements.

**Current state (already built, keep).**
- `MathEngine.detectLowScoringRegime(mat, lH, lA)` (line ~695) classifies a fixture as `LOW_SCORING` from the final matrix when E[goals] is suppressed, P(Under 2.5) is high, low-score mass is high, and there is no dominant favourite.
- A **draw-risk composite score** (§21 in code, 0–100) with a gate that blocks Money Line recommendations when `drawRisk ≥ VERY_HIGH`.
- `drawCalibrationFactor()` and a `drawCalibration` diagnostic that flags when predicted vs realised draw frequency diverges by >0.03 per league.
- A **computed Asian Handicap pivot** (`asianHandicapPivot`) that, in a low-scoring regime, deliberately routes to the AH/Under line a low score cannot bust, scored by settlement probability × accuracy.

**Spec — enhancements. [EVIDENCE]**
- **Adopt a true bivariate Poisson** for the joint scoreline (see §8.1). The current model uses independent Poisson + Dixon–Coles low-score correction; a bivariate Poisson with an explicit correlation term `λ3` models draws natively. *Karlis & Ntzoufras (2003); Sascha Wilkens (2026) — "Bivariate Poisson models address the disputed goal-independence assumption … improving the modelling of draws."* This directly strengthens the draw engine at its root.
- **Surface draw/low-score as a first-class output**, not just an internal gate. The decision layer (§6) and HTML report (§7) must show: `P(draw)`, `P(Under 2.5)`, `P(0-0)`, regime classification, and the recommended low-variance market.
- **Track draw-calibration in the persistent ledger** (§10) per league, so the >0.03 gap diagnostic accumulates real evidence over time.

**Acceptance criteria.**
- A known low-scoring fixture (two strong defences, no clear favourite) produces `regime = LOW_SCORING` and leads with the computed AH/Under pivot, never a 1X2 result bet.
- Draw probability and low-score diagnostics appear in both the decision output and the HTML report.
- The draw-calibration gap is recorded per league per resolved fixture.

---

## 5. Bet-ranking modes — risk-preference filters over calibrated probabilities

**Goal.** Let the user choose *how aggressively to act on the gap between ORACLE's calibrated probability and the market price*, according to risk appetite — **without changing the underlying objective (§2.3)**. This is the key correction from v1.0: the three modes are **not three competing objectives**. They are three *views* over the same calibrated probability distribution. Calibration (§2.3) produces trustworthy probabilities; the mode decides how to exploit the probability-vs-price gap.

**Current state.** `ExecutionEngine.scanMarkets` ends with `evs.sort((a,b)=>b.rankingScore-a.rankingScore)` (line 4266), where `rankingScore = ev × varianceMod` (line 4144) and `ev = modelProb × odds − 1`. Because EV scales multiplicatively with odds, longer-odds value is surfaced over higher-probability outcomes. This is correct for pure profit-seeking but is not what the owner intends as the default.

**Spec. [DECIDED]** Implement **three user-switchable ranking modes**, selectable per analysis from the UI, defaulting to the confidence-weighted mode. Each mode has a `?` tooltip with the explainer text below. **All three consume the *same* calibrated probabilities** from the model (`EV = calibratedProb × odds − 1`); they differ only in how they trade likelihood against price. This is what makes them coherent with a single objective.

| Mode | Formula (ranking key) | `?` explainer (UI tooltip) |
|------|----------------------|----------------------------|
| **Confidence-Weighted** *(DEFAULT)* | `EV × modelProb × varianceMod` | "Balances how *likely* a bet is with how *good the price* is. Favours outcomes that are both probable and good value — the recommended all-round setting." |
| **Max-Probability (EV-filtered)** | rank by `modelProb`, then drop any bet with `EV ≤ 0` | "Surfaces the *most likely* outcomes, but never at a losing price. Use when you care more about being right than about maximising long-run value." |
| **Max-EV** *(current behaviour)* | `EV × varianceMod` | "Pure value-hunting: where the bookmaker is most wrong, regardless of how likely. Highest long-run profit, but more long-odds bets and more variance." |

**Implementation detail.**
- Add `ORACLE_CONFIG.RANKING_MODE` with values `CONFIDENCE_WEIGHTED | MAX_PROBABILITY | MAX_EV`, default `CONFIDENCE_WEIGHTED`.
- `scanMarkets` computes all component fields (`ev`, `mp` = modelProb, `varianceMod`) already; only the final sort key changes. Keep `varianceMod` in all modes — it is the low-variance market-quality weighting and is orthogonal to the objective.
- For `MAX_PROBABILITY`, the `EV ≤ 0` filter is a hard drop, not a re-rank, so a 1.20-odds favourite with negative EV is never surfaced.
- The selected mode must be **recorded with every analysis** in the persistent ledger (§10) so backtests can compare modes on CLV/RPS/ROI.
- The UI exposes a mode switcher; switching re-ranks the already-computed `evMarkets` without re-running the engine (all component fields are present, so this is a client-side re-sort).

**Evaluation (corrected from v1.0).** A mode chooses *what to surface*; it is not itself the objective. Modes are compared along the §2.3 chain: **in liquid markets**, which mode delivers the best realised CLV; **in thin markets**, which delivers the best calibration-consistent ROI over larger samples (CLV not used there, as the closing line is inefficient). **[OPEN]** The per-league default-tuning now has a principled basis — tune defaults on liquid-market CLV where available, on calibration + ROI elsewhere — once §8.7 backfill and Phase 2 data exist.

**Acceptance criteria.**
- Three modes selectable from the UI, default = Confidence-Weighted, each with the `?` explainer.
- Switching mode re-ranks instantly without a new engine run.
- A unit test confirms: for a fixture with a 1.25-odds heavy favourite (−EV) and a 3.40-odds value underdog (+EV), `MAX_PROBABILITY` surfaces the favourite filtered out (because −EV → dropped, next-most-likely +EV bet leads), `MAX_EV` surfaces the underdog, and `CONFIDENCE_WEIGHTED` surfaces the bet with the best `EV × prob` product.
- The chosen mode is persisted with the analysis record.

---

## 6. LLM-gated final decision layer

**Goal.** Let the LLM make the **final market selection**, but **only within hard, non-overridable math gates** — it chooses among already-validated bets and can never resurrect a vetoed or negative-EV bet. **[DECIDED: "LLM makes final call within hard math gates."]**

**Current state.** The LLM (Claude primary, Gemini fallback) writes the briefing, runs the `AntiSycophancyCircuit` adversary, and does 3-pass verification voting. But the *gates are hard-coded instructions in the prompt* (e.g. "If `mlFilter.mlAllowed = false`, DO NOT recommend the Money Line"). The math effectively decides; the LLM narrates. The owner wants the LLM to actively choose — but safely.

**Spec.** Introduce a `decision/` module implementing a **constrained selection contract**:

1. **The engine produces a candidate set.** After `scanMarkets` and all safety filters, build `eligibleBets` = every market with `!veto && ev > 0 && passes MLSafetyFilter && passes ConvergenceScorer threshold`. Each candidate carries its full evidence (mp, ev, odds, varianceMod, rankingScore, regime flags, draw risk, sensitivity/fragility, adversary verdict).
2. **The LLM selects, it does not compute.** The LLM receives *only* `eligibleBets` plus the structured evidence, and must return a JSON selection: `{ primaryPick, altPick, confidence, rationale, rejectedAndWhy }`. It chooses *which* eligible bet to lead with and how to frame confidence.
3. **Hard gates are enforced in code, after the LLM responds — not by trusting the prompt.** A `validateSelection()` function rejects the LLM's pick if it is not in `eligibleBets`, was vetoed, is −EV, violates the correlated-parlay hard cap (ρ > 0.7), or contradicts an active regime gate (e.g. picks Money Line when `drawRisk ≥ VERY_HIGH` or `mlAllowed = false`). On rejection, the system falls back to the top-ranked eligible bet under the active ranking mode (§5) and logs the disagreement.
4. **The LLM can express "no bet."** If the LLM judges no eligible bet worth recommending, it may return `primaryPick = NO_BET` with rationale. This is always allowed (it is strictly more conservative).

**Why this is safe.** The LLM's freedom is bounded to *selection among options the math already approved*. It can make the read smarter but cannot create risk the math rejected.

**What the LLM uniquely adds (why this role is not hollow).** A fair objection to "LLM picks within gates" is that if the gates already reduce the set to validated, +EV, near-equivalent options, the LLM adds nothing. The resolution: the deterministic ranking (§5) sees only *quantified* features. The LLM's distinct job is to incorporate **soft, late, or contextual information the math cannot encode** — late team-news and lineup leaks, motivation (dead rubber vs relegation six-pointer), derby/rivalry dynamics, congested-fixture rotation, manager statements — and use it to choose among the top-N gate-passed candidates, or to step down to `NO_BET`. That is a real edge an LLM can supply and the matrix cannot.

**Soft-context ingestion (v1.2 — required, was unspecified) [DECIDED].** The edge above is real *only if the soft context is actually supplied to the model.* Without a feed, the LLM either adds nothing beyond §5's ranking or fabricates context that then sails through `validateSelection()` (which checks math, not the reasoning). Therefore the decision call must be fed an explicit, **timestamped `softContext` evidence block**, and the model is instructed to use *only* what is in that block:
- **Sources:** confirmed/probable lineups and injuries (api-football provides lineups, injuries, and team news; the-odds-api and footballData feeds carry some of this), plus a headlines pull for the fixture. Each item carries `source` and `observedAt`.
- **Anti-leakage at decision time:** every `softContext` item must satisfy `observedAt < kickoff`. In backtest/SkillOpt, items are filtered to the pre-kickoff window exactly as features are (§8.7) — and see the §8.5 LLM-leakage protocol for the orthogonal *training-data* leakage risk.
- **Empty-feed honesty:** if no soft context is available, the block is explicitly empty and the LLM is told so; it must not invent late news. A pick whose rationale cites soft context absent from the block is flagged in the disagreement log for review.
- **Degraded mode:** if the soft-context feed is unavailable, the decision still runs on quantified evidence; the record is tagged `softContext: 'NONE'` so the §8.5 evaluation can separate "LLM had context" from "LLM had none."

**Decoding determinism (v1.2 — required for auditability) [DECIDED].** §0 makes auditability a core value and §11 forbids "nondeterminism near stakes," so the selection call must be reproducible: **`temperature = 0`** (or the provider's nearest deterministic setting), a **pinned model version** recorded with the analysis, and the **exact prompt + raw response persisted** with every decision (§10) so any pick can be replayed and re-audited. A decision that cannot be replayed is treated as a defect.

**How its contribution is measured (why this is not circular).** v1.0 proposed scoring the LLM on CLV, which is gameable, and risked defining the signal in terms of the ranking baseline being changed. Corrected: over accumulated picks (the disagreement log, §10), the LLM's selections are scored on **calibration against actual outcomes** — across fixtures where the LLM deviated from the deterministic top pick, did its picks prove *better calibrated* (more right) than the baseline? Measured against outcomes, not CLV, and not against a moving ranking baseline. A single pick is noisy; the signal is the **aggregate**, which GBrain's ledger accumulates. This same aggregate is SkillOpt's training signal (§8.5).

**Provider behaviour.** Keep the existing Claude-primary / Gemini-fallback cascade. The selection call is a single structured-JSON request; parse defensively (strip code fences), and on parse failure fall back to the top-ranked eligible bet (never crash, never "cannot find fixture" — see §9).

**Acceptance criteria.**
- The LLM receives only gate-passed candidates; a unit test confirms a vetoed market is never in the LLM's input.
- `validateSelection()` rejects and logs any out-of-set, vetoed, −EV, or gate-violating pick, and falls back deterministically.
- A `NO_BET` return is honoured and surfaced to the user.
- The disagreement log (LLM pick vs deterministic top pick) is persisted (§10) and scored on **calibration against actual outcomes** in aggregate — this is the signal SkillOpt optimizes (§8.5).

---

## 7. Batch fixture analysis + HTML report + market-list input

**Goal.** Accept a list of fixtures (e.g. 39 games for today), analyse them sequentially, and emit an HTML report. Optionally accept a constrained list of bet markets to choose from. The owner confirmed all three are wanted.

**Current state.** `ExecutionEngine.run(state, ...)` analyses **one** fixture per call. There is no batch loop, no report generator, and market candidates come implicitly from whatever odds the bookmaker feed returned. The UI accepts a single free-text fixture query.

**Spec — 7.1 Batch input.**
- Accept input as either (a) a newline/CSV list of fixtures (`Home vs Away`, optional league hint, optional kickoff time), or (b) a structured array. Parse into `FixtureJob[]`.
- Process **sequentially** (not parallel) to respect API rate limits and keep the LLM cascade stable. Each job runs the full pipeline (telemetry → matrix → scan → safety → §6 decision).
- **Resilience:** one fixture failing (bad data, API miss) must not abort the batch. Capture per-job status `{ ok | skipped | error, reason }` and continue. This is the batch-level fix for the "cannot find fixture" failure (§9).
- Emit progress events so the UI/worker can show "12 / 39 analysed."
- **Cost & rate-limit guardrails (v1.2).** A batch makes paid calls (the-odds-api, Gemini, Claude) per fixture; an unbounded unattended run is a financial hazard. The batch runner enforces the **Agent Operations cost/rate contract (§11A)**: per-provider rate limits with exponential backoff, a per-run and per-day **cost ceiling** that halts the batch when exceeded (returning a partial manifest, not a crash), and a **dry-run estimate mode** that reports projected calls/cost before any live spend.

**Spec — 7.2 Market-list input (optional constraint). [EVIDENCE-aligned]**
- Allow the user to pass a **whitelist of candidate markets** (e.g. only `["1X2", "Over/Under 2.5", "BTTS", "Asian Handicap"]`). When present, `scanMarkets` scores only those markets; when absent, it scans all available (current behaviour).
- This *does* improve decision quality by focusing the candidate set and reducing multiple-comparisons noise — fewer markets means less chance of surfacing a spuriously high-EV exotic. It also makes batch output comparable across fixtures.

**Spec — 7.3 HTML report.**
- After a batch (or single run), render a **self-contained HTML file** (inline CSS, no external deps) to the outputs directory. One row/card per fixture, sorted by the active ranking mode's top-pick strength.
- Each fixture card shows: teams + league + kickoff; λH/λA; P(home/draw/away); regime flags (LOW_SCORING / draw risk); the **primary pick** with market, odds, model prob, EV, Kelly stake; the **alt pick**; the adversary's key objection; and a confidence band. Use colour only as a secondary cue (accessibility), never as the sole signal.
- Include a header summary: date, ranking mode used, number of fixtures, number of actionable bets, total recommended stake as % of bankroll, and a portfolio correlation note (flag if multiple picks are correlated, ρ > 0.7).
- The report is a presentational artifact only — all numbers come from the engine; the renderer computes nothing.

**Acceptance criteria.**
- A 39-fixture list completes end-to-end; a single bad fixture is reported as `skipped/error` and does not abort the run.
- The HTML file opens standalone in a browser with no network dependency and renders every fixture.
- When a market whitelist is supplied, no market outside it appears in any pick.
- The report header correctly reflects the active ranking mode and flags correlated picks.

---

## 8. Accuracy: evidence-based model upgrades + the optimization loop

**Goal.** Improve real predictive and financial performance, grounded in 2024–26 literature, while preserving auditability.

### 8.1 Bivariate Poisson core **[EVIDENCE]**
Add a true bivariate Poisson model (`λ1`, `λ2`, plus correlation `λ3`) as the joint scoreline generator, alongside the existing independent-Poisson + Dixon–Coles path (keep both behind a flag for A/B comparison). *Karlis & Ntzoufras (2003); Wilkens (2026): bivariate Poisson "improves the modelling of draws"; Michels et al. (2025): richer correlation patterns "can substantially improve fit."* This is the highest-value math upgrade and directly strengthens the draw engine (§4).

### 8.2 Skellam regression for supremacy/handicap markets **[EVIDENCE]**
For Asian Handicap and supremacy markets, add a Skellam (difference-of-two-Poissons) model. *Wilkens (2026): "the Skellam distribution … naturally models win-draw-loss results."* Use it to cross-check the AH pivot (§4) rather than replace the matrix-derived line.

### 8.3 Calibration-primary scoring; CLV as the liquid-market gate **[EVIDENCE + DECIDED]**
Per §2.3, **calibration against outcomes (RPS + per-league/per-market reliability curves) is the primary, optimized metric.** Separately, elevate the existing `clvProjection` to a first-class *persisted* field and use it as a **gate/diagnostic in liquid markets only**. After each fixture resolves, record realised CLV (model odds vs closing odds) where the market is liquid; in thin markets, skip CLV and rely on calibration + realised ROI. This requires a **per-league/per-market liquidity classification** (does reliable Pinnacle closing data exist? — drive it from the §8.7 odds source). Track calibration everywhere; track CLV per-league and per-ranking-mode only where liquidity qualifies. *bet-analytix / SportBot AI (2025–26): CLV is the reliable +EV indicator — in efficient markets.*

**Hierarchical / partial-pooling calibration (v1.2) [DECIDED].** Per the §2.3 thin-market resolution, reliability is *not* estimated independently per league. Structure: **global → tier → league.** Each league's reliability curve is a shrinkage blend of its own resolved samples and its parent (tier, then global) prior, with weight `w_league = n / (n + k)` where `n` is the league's resolved-fixture count and `k` is a pooling constant (a hyperparameter, tuned by the §8.4 walk-forward harness, never auto-optimized). A brand-new league inherits the tier prior almost entirely; an established liquid league trusts mostly its own curve. Reliability is reported with its `n` and effective shrinkage so a curve is never read as if it had data it doesn't.

**Significance accept-gate (v1.2) [DECIDED].** No calibration claim ships on a point estimate. To accept *any* change as a calibration improvement (model upgrade §8.4, SkillOpt edit §8.5, ranking-mode default §5): (1) a **minimum resolved-sample count** for the comparison (set per evaluation, never below a documented floor); (2) a **bootstrap confidence interval on the metric delta** (RPS, and reliability-curve error) — accept only if the improvement's CI lower bound is on the better side of zero; (3) an **effect-size floor** so a statistically-detectable but trivially-small gain does not justify added complexity. This gate is the operational form of §8.4's overfitting discipline.

**CLV is a quality-tagged proxy, not ground truth (v1.2) [DECIDED].** §8.7 establishes that football-data.co.uk "closing" odds are collected at fixed times and read off at kickoff — a proxy, not a tick-level close. Therefore each realised-CLV record carries a `clvSourceQuality` tag (`TICK_LEVEL | KICKOFF_PROXY | UNKNOWN`); the CLV gate **widens its tolerance band and requires a larger sample before firing on proxy-sourced lines**, and CLV never overrides calibration (which is measured against true outcomes). This keeps a noisy proxy from masquerading as the sharp signal the literature describes for genuinely efficient closes.

**Recalibration / drift cadence (v1.2) [DECIDED].** Football distributions drift across seasons (transfers, managerial change, rule tweaks). Calibration and the shrinkage curves are re-estimated on a **rolling window** and re-anchored **at each season boundary**; the active calibration snapshot is versioned (§10) so a model run records which calibration it used. Drift beyond a threshold on the live reliability curve raises a flag for manual walk-forward review (§8.4) — it never triggers an automatic core-parameter change.

### 8.4 What must NOT be auto-optimized **[DECIDED]**
The quant core — λ model, Dixon–Coles τ, dynamic ρ, Kelly fraction — is **tuned only by manual walk-forward backtesting with out-of-sample holdouts, scored on RPS (primary) and, in liquid markets, CLV (secondary).** The backtest is seeded from the historical backfill harness (§8.7) under strict walk-forward discipline (only data timestamped before kickoff). No ratchet/optimizer ever writes to core parameters. **[EVIDENCE]** Football is far from "physical truth"; ratchet-style optimizers overfit noisy targets (Karpathy autoresearch Issue #22; Shopify's flagged-overfit result). Published models already cluster at RPS ≈ 0.21, so the marginal gain from aggressive auto-tuning is small and the overfitting downside is large.

### 8.5 SkillOpt for the LLM decision layer **[EVIDENCE + DECIDED — clarified]**
Use Microsoft's **SkillOpt** (MIT; arXiv:2605.23904) to optimize the **markdown that governs the LLM decision layer (§6)** — the reasoning rubric, selection prompt, and adversary instructions — *not* the quant core.

**Why this is the right target, and why it doesn't slow live inference:** SkillOpt is a **build-time** training process. It runs offline over historical fixtures, proposes bounded edits to the skill file, and *keeps an edit only if it strictly improves a held-out validation score*. It adds **zero inference-time cost** — only the final `best_skill.md` ships. So restricting SkillOpt to the markdown does not constrain the live decision; it points the optimizer precisely *at* the LLM's decision-making brain (the rubric it uses to choose among gate-passed bets, §6) while keeping it away from stake math. *SkillOpt paper: "trains skills as external agent state … zero deployment inference overhead"; validation gate "accepts an edit only when it strictly improves a held-out validation score."*

**Non-negotiable safeguard:** SkillOpt requires a held-out validation set. v1.1 sources its *initial* set from the §8.7 historical backfill, so SkillOpt is no longer strictly blocked behind Phase 2 live accumulation — though ongoing live data makes it more robust. The validation gate is mandatory regardless of target — it is the one thing separating "training" from "appending text and hoping."

**LLM training-data leakage protocol (v1.2 — critical, was missing) [DECIDED].** The feature anti-leakage rule (§8.7, `timestamp < kickoff`) does **not** cover a second, LLM-specific leak: for any historical fixture inside the model's training-data window, the LLM may have *memorized the result*. Scoring "the calibration of the LLM's selections against outcomes" over such fixtures is contaminated — the model can look well-calibrated because it already knows who won — which would silently defeat §8.4's overfitting discipline at the exact layer SkillOpt is permitted to touch. Mandatory controls:
- **Cutoff partition.** The LLM-pick validation set uses **only fixtures dated after the decision model's training cutoff**; the cutoff is recorded with the run. Pre-cutoff fixtures may be used to optimize *deterministic* components but are excluded from scoring the *LLM's* selections.
- **Blinding (where post-cutoff data is thin).** Present the model with anonymized, date-stripped feature vectors (no team names, no date, no competition where identity would reveal the result) so it cannot retrieve a memorized outcome. A blinded run that scores no better than chance on identity-revealing cues is the validity check.
- **Live-forward preference.** The most trustworthy signal is genuinely live, post-deployment picks accumulating in the §10 ledger; historical backfill is the bootstrap, not the long-run gate.

**Significance gate (v1.2).** SkillOpt's "keep an edit only if it strictly improves the held-out score" is replaced by the §8.3 significance accept-gate: minimum-N, bootstrap CI on the calibration delta (accept only if the lower bound favours the edit), and an effect-size floor. A point-estimate improvement is **not** sufficient to keep an edit — this is what stops the rubric from learning noise.

**Optimization objective for SkillOpt (corrected from v1.0):** maximise the **held-out calibration of the LLM's selections against actual outcomes** (primary gate), with liquid-market CLV as a *secondary* gate only. v1.0 set CLV as the primary objective, which is gameable (the rubric could learn timing tricks rather than better judgement); scoring against outcomes removes that. The training signal is the §6 disagreement log scored in aggregate on outcomes — under the leakage protocol and significance gate above.

### 8.6 Optional / research tracks **[OPEN]**
**(a) Market-bias features [EVIDENCE].** The literature documents *exploitable* market biases worth encoding as model features: the favourite-longshot bias, and an **overreaction / "hot-hand" bias** in which match odds overreact to recent runs of results — teams that have underperformed their odds tend to be priced more generously, exploitable for sustained profit (*Wheatcroft, JQAS 2020*). Add a recent-form-overreaction feature (a COD-style statistic) as a calibration input. Low cost, evidence-backed, interpretable.
**(b) Gradient-boosting.** CatBoost/XGBoost on rating features is the current empirical leader (*the ML survey reports CatBoost + pi-ratings at RPS 0.1925 / 55.82% accuracy*), but gains over the Poisson + pi-ratings base are modest and sacrifice interpretability — a real cost for an auditable betting tool. Treat as an optional later experiment, evaluated on calibration, never as a core replacement.

**Acceptance criteria (§8).**
- Bivariate Poisson available behind a flag and A/B-comparable to the current path on **RPS (primary)** and liquid-market CLV (secondary) over a holdout.
- Skellam cross-check available for AH/supremacy markets.
- Calibration (RPS + reliability curves) recorded per resolved fixture, per league, per market; realised CLV recorded *only* where the market is classified liquid.
- A documented, repeatable walk-forward backtest harness exists for the quant core, seeded by §8.7 backfill; no optimizer writes to core parameters.
- SkillOpt runs only against the LLM markdown, only with a held-out validation gate scored on **outcome calibration**, with liquid-market CLV as a secondary gate.

### 8.7 Data sourcing & the historical backfill harness **[EVIDENCE]**

**Goal.** Source the historical data that calibration-as-target (§2.3, §8.3) and the quant-core backtest (§8.4) require, and build a backfill harness that imports it under strict anti-leakage discipline. Concrete, named sources follow; all are free or free-with-attribution unless noted.

**Keystone tool.** **`soccerdata`** (Python; the maintained successor to the dead Py2 `footballdata`) wraps **ClubElo, ESPN, FBref, football-data.co.uk, Sofascore, SoFIFA, Understat, and WhoScored** into pandas dataframes with matching identifiers and local caching. Use it as the primary ingestion layer. (`worldfootballR` is the R equivalent.) **Currency-verified June 2026:** v1.9.0 (Apr 2026), actively maintained (`probberechts/soccerdata`). **FiveThirtyEight has been dropped** — 538's soccer SPI was discontinued and is no longer a usable source; do not rely on it. Because `soccerdata` is scraping-based, expect breakage when upstream sites change — treat the scraped tiers (Understat, FBref) as best-effort, not hard dependencies.

**Tier 1 — results + odds (calibration backbone + CLV gate).**
- **football-data.co.uk** — gold standard, free public CSV, seasons 2000/01→current. Carries **Pinnacle closing odds** and **Asian-handicap** lines (`PSCH`, `PAHH`, `PAHA`). This is the CLV-gate source for liquid leagues. Caveat: odds are collected at fixed times (Fri/Tue); "closing" = the figure recorded at kickoff, a **proxy, not tick-level**.
- **Kaggle "Club Football Match Data (2000–2025)"** (`adamgbor/club-football-match-data-2000-2025`; GitHub mirror `xgabora/Club-Football-Match-Data-2000-2025`) — ready-made superset: results + stats + odds across **27 countries / 42 leagues** (verified June 2026, broader than v1.1's "27 leagues"), for a fast initial backfill beyond football-data.co.uk's core set.

**Tier 2 — xG / advanced features (the hard tier).**
- **Understat** — practical free xG (xG, npxG, xGChain, xGBuildup, shot-level). Hard limits: **2014/15 onward, top-5 leagues only** (EPL, La Liga, Bundesliga, Serie A, Ligue 1). *(June 2026: RPL/Russian Premier League no longer listed in current coverage — verify before relying on it.)* No official API; scraping-only and **breaks regularly** — wrap via `soccerdata` and treat as best-effort.
- **StatsBomb open-data** (GitHub `statsbomb/open-data`; `statsbombpy` for Python) — event-level JSON, free for research **with attribution + StatsBomb logo + acceptance of their User Agreement** (June 2026); limited selected competitions.
- **FBref** (Opta) — richest aggregate xG/xA, but **behind Cloudflare on every request**; reach **only via `soccerdata`/`worldfootballR`, never direct**. *(June 2026: rate-limiting tightened — wrappers now enforce a user-defined pause between page loads; expect slow, throttled pulls.)*

**Tier 3 — ratings.**
- **ClubElo** — free historical Elo, recalculated after every round, with full history, accessible via `soccerdata`. Backfill directly into `TeamRatingsEngine`.

**Live (already in ORACLE):** the-odds-api for current fixtures' odds. **Quota (verified June 2026):** free tier = **500 credits/month (~16 requests/day)**, where *credits ≠ requests* (a multi-market/multi-region `/odds` call costs several credits); paid tiers from **$30/mo (20K credits)**. **Build consequence:** the free tier **cannot feed a full 39-fixture daily batch** — it exhausts near ~16 fixtures. This is a named constraint for the §7 batch and the §11A.4 cost contract, and a Phase-3 prerequisite decision (paid tier vs throttled/prioritised batch), not a runtime surprise.

**Spec — the backfill harness.**
- Add a one-off/periodic import path that lands historical data into the persistence layer (§10) via `StoragePort` bulk-write.
- **Anti-leakage is the cardinal rule.** Every imported feature is stamped with the time it was knowable; the backtest may use only data with `timestamp < kickoff`. No season-aggregate xG, no rating that includes the match being predicted, no retrospectively-filled column.
- **Cross-source team-name mapping.** Build a reconciliation table mapping team identifiers across football-data.co.uk, Understat, ClubElo, and StatsBomb (extend the §9 alias set). `soccerdata` helps but is imperfect; this table is a required artifact.
- **Graceful xG degradation (engine requirement, not just data).** Because free xG covers only ~6 leagues from 2014/15, the `MathEngine` must fall back to a goals-based λ when xG is absent, and flag which path was used. ORACLE's 16-league + women's-football coverage means most fixtures will run *without* xG.
- **Liquidity tagging.** Mark each league/market as CLV-eligible (reliable Pinnacle closing data) or not — this drives the §8.3 gate.

**Licensing note → §12.** football-data.co.uk (free public) and StatsBomb (free, with attribution) are safe to build a commercial product on; scraped FBref/Understat data is ToS gray-area and may not be redistributable. Matters at the paying-user stage.

**Acceptance criteria.**
- A backfill run imports Tier-1 results+odds for the target leagues into persistence via `StoragePort`, with per-row knowable-time stamps.
- The backtest harness refuses (or flags) any feature lacking a `timestamp < kickoff` guarantee.
- A cross-source team-name mapping table exists and resolves the target leagues' teams across all Tier-1/Tier-2 sources.
- The engine produces a valid calibrated analysis for a league with **no xG data**, using the goals-based λ fallback, with the path flagged.
- Each league/market carries a liquidity tag consumed by the §8.3 CLV gate.

---

## 9. Fix: spurious "cannot find fixture" failures

**Goal.** Stop ORACLE refusing valid fixtures with a "cannot find fixture" error.

**Current state (root cause confirmed in code).** Three throw sites end the run:
- Line ~4747: `"Turn 1 failed: No fixture resolved."`
- Line ~4952: `"No fixture found matching query."`
- Line ~5505: `"No fixture found — check query format (e.g. 'Arsenal vs Chelsea')"`

These fire when the LLM-driven fixture-resolution step (Turn 1) returns no fixtures. That happens when: (a) **API keys are missing** — telemetry/odds calls return empty, so resolution has nothing to anchor to (`CrowdWisdomProtocol._emptyPayload` returns on `if (!apiKey)`, line ~1601); (b) the model fails to parse a non-standard query into a recognised fixture; or (c) the fixture genuinely isn't in the free-tier data window. So a *valid* fixture can be refused purely due to key/config fragility — exactly the spine problem (§3).

**Spec.**
1. **Fix key handling first (§3).** With keys injected at the boundary (not from `window`), the most common false-negative disappears.
2. **Separate "no data" from "no fixture."** Distinguish three outcomes explicitly: `RESOLVED` (proceed), `AMBIGUOUS` (multiple matches — ask the user to pick / return candidates), `NO_DATA` (keys/feed problem — surface a clear, actionable message naming the missing key, not "cannot find fixture").
3. **Graceful degradation.** If live odds are missing but team/form data exists, ORACLE should still produce a *probability* analysis (no EV/stake, clearly flagged "no odds — prediction only") rather than refusing entirely. This also serves the Max-Probability ranking mode (§5) when a user wants a pure prediction.
4. **Better query parsing.** Normalise team aliases (the `isPopularTeam` alias set already exists, line ~280 — extend it) and accept common formats before declaring failure.
5. **Never crash a batch (§7).** Within a batch, `NO_DATA`/`AMBIGUOUS` mark that one fixture as skipped with reason, and the run continues.

**Acceptance criteria.**
- With valid keys, a standard fixture ("Arsenal vs Chelsea") never returns "cannot find fixture."
- Missing-key failures produce a message naming the specific missing key and how to set it — never "cannot find fixture."
- A fixture with team data but no odds returns a prediction-only analysis, clearly labelled.
- Ambiguous queries return candidate matches, not a hard failure.

---

## 10. Phase 2: persistence & real RAG (GBrain)

**Goal.** Replace faked in-memory storage with durable persistence, and upgrade the RAG layer — enabling backtesting, calibration over time, and the §8.5 optimization loop.

**Current state.** `_memStore` (§0a) resets every session. `RAGSystem` (§7 in code) uses a 12-dim embedding with in-memory persistence. The frozen-odds registry, session registry, and postmortem registry are all volatile.

**Spec.**
- Implement `GBrainAdapter` against the `StoragePort` interface (§3.1). **[EVIDENCE]** GBrain (Garry Tan, OSS) stores knowledge as markdown in a git repo synced to Postgres, with hybrid vector + graph retrieval — "the graph returns chunks that are factually connected," with auto-linking on every write. This fits ORACLE's analogue retrieval (find similar past fixtures), postmortem store (failure patterns), and calibration ledger.
- **Local-first:** start with GBrain's PGLite option (~30s setup, no accounts) for stealth/solo use.
- **Cloud path:** migrate to Supabase Postgres when leaving stealth — same data layer, config change only (Session Pooler URL).
- **Single-vendor fallback (v1.2) [DECIDED].** GBrain is young OSS and is the named Phase 2 adapter; the `StoragePort` boundary already de-risks the build, but it must also de-risk *operation*. Specify a plain-Postgres (or PGLite-direct) `SqlAdapter` implementing the same interface as the contingency path, so a GBrain immaturity issue cannot strand persistence. The graph/auto-linking niceties degrade to vector-only similarity; nothing in the engine changes.
- **Schema versioning & migration (v1.2).** Every persisted record carries `schemaVersion`. Records evolve across phases (§5/§6/§8.3 fields arrive incrementally); a small migration step upgrades older records on read or via a one-shot pass. The active calibration snapshot is likewise versioned (`calibrationSnapshotId`, §8.3) so a run records exactly which calibration produced it.
- **Backup / export (v1.2).** The accumulated ledger *is* the system's entire learned value — losing it resets ORACLE to zero. GBrain's git-backed markdown gives a natural off-box copy; make it explicit: a periodic `StoragePort` export (NDJSON dump of analyses + resolutions) to a durable location, on the same schedule as the worker, retained independently of the live DB.
- **Bulk historical backfill (v1.1).** `StoragePort` must expose a bulk-write path so the §8.7 harness can seed the ledger from historical data, not only from incremental live runs. This lets initial calibration (§8.3) and quant-core backtesting (§8.4) be computed in Phase 1, before live accumulation — partly decoupling them from Phase 2 (see §3.2 sequencing note).
- **Persisted records (the scored history that Phase 1's §5/§6/§8.3/§8.5 depend on):**
  - every analysis: fixture, λ, probabilities, regime, ranking mode used, full `evMarkets`, the §6 LLM selection + the deterministic top pick (disagreement log), the frozen odds at analysis time, `runId`/`analysisId`/`schemaVersion`/`calibrationSnapshotId` (§11A.3), and the **decision-replay bundle** (exact prompt, raw LLM response, pinned model version, `softContext` presence — §6 determinism);
  - every resolution: actual result, realised CLV (vs closing odds) with `clvSourceQuality` (§8.3), RPS contribution, draw-calibration data point — **write-once** per fixture (§11A.3);
  - postmortems: failure patterns for the RAG to retrieve.

**Acceptance criteria.**
- State survives restart; a prior analysis is retrievable next session.
- Analogue retrieval returns relevant past fixtures via hybrid search.
- The scored ledger accumulates the fields §5/§6/§8.3/§8.5 require, including the decision-replay bundle.
- Swapping `MemoryAdapter` → `GBrainAdapter` → `SqlAdapter` requires no engine code change (interface compliance — all three pass the same `StoragePort` test suite).
- Every record carries `schemaVersion`; an older-schema record reads correctly after migration.
- A backup export can be produced and re-imported into an empty store, reproducing the ledger.

---

## 11. Phase 3: scheduled automation (the worker)

**Goal.** Run the analysis pipeline automatically on a schedule, feeding the persistent ledger continuously.

**Current state.** Everything is manual and browser-bound.

**Spec.**
- A headless `@oracle/worker` (Node) runs `@oracle/engine` on a schedule (`node-cron` to start — deterministic, no agent nondeterminism near stakes; **not** an autonomous agent framework).
- Daily flow: fetch today's fixtures → run the batch pipeline (§7) → write scored analyses to GBrain (§10) → emit the HTML report → (optional) notify.
- Post-match flow: when results are available, resolve open analyses, compute realised CLV/RPS, update calibration and ratings.
- **Same worker lifts to a managed cloud container** (Railway/Fly/Render) for the paying-users phase — deployment change, not rewrite (the engine is already headless from §3).
- **OpenClaw [OPEN/optional]:** OpenClaw could host orchestration if multi-agent routing is later wanted, but for scheduled deterministic runs a plain cron worker is simpler and safer. Defer unless a concrete need appears.

**Acceptance criteria.**
- The worker runs the full daily batch unattended and persists results.
- Post-match resolution updates CLV/RPS/ratings without manual intervention.
- The worker binds to localhost in stealth; keys come from env/secrets, never embedded.

---

## 11A. Agent Operations Contract **[DECIDED — new in v1.2]**

**Goal.** Make ORACLE *operable by an agent*, not just by a human at a browser. The rest of the document specifies what the engine computes; this section specifies the machine-facing surface an autonomous or semi-autonomous operator (the scheduled worker §11, or a Claude-Code-style agent running the WAT workflows) reads and writes to decide what to do next. Without it, the only output is human HTML (§7) and failures are opaque.

**11A.1 — Run manifest (machine-readable output).** Every batch/worker run emits a structured `RunManifest` JSON alongside the HTML report:
```
RunManifest {
  runId, startedAt, finishedAt, mode (RANKING_MODE), trigger ('scheduled'|'manual'|'backfill'),
  fixtures: FixtureOutcome[],         // one per job
  totals: { attempted, ok, skipped, errored, actionableBets, recommendedStakePct },
  cost:   { byProvider: {gemini, claude, oddsApi, ...}, totalUsd, ceilingUsd, halted: bool },
  errors: AgentError[],               // see 11A.2
  calibrationSnapshotId,              // which calibration/shrinkage version was active (§8.3/§10)
  schemaVersion
}
FixtureOutcome { fixtureId, home, away, kickoff, status, reason?, primaryPick?, softContext: 'PRESENT'|'NONE', analysisRef }
```
The HTML report is a *view*; the manifest is the *contract*. The agent reads the manifest to know what to retry, what to resolve later, and what to escalate.

**11A.2 — Typed error taxonomy.** §9's `RESOLVED | AMBIGUOUS | NO_DATA` covers fixture resolution only. The whole system shares one typed error enum so an operator can branch programmatically instead of string-matching:
```
AgentErrorCode =
  | 'NO_DATA'            // feed/key problem — names the missing key (§9)
  | 'AMBIGUOUS_FIXTURE'  // multiple matches — candidates attached (§9)
  | 'ODDS_UNAVAILABLE'   // degraded prediction-only path (§9)
  | 'RATE_LIMITED'       // provider backoff in effect (11A.4)
  | 'COST_CEILING_HIT'   // run halted by budget (11A.4)
  | 'LLM_PARSE_FAIL'     // decision JSON unparseable — deterministic fallback used (§6)
  | 'VALIDATION_REJECT'  // validateSelection() rejected the LLM pick (§6)
  | 'PERSISTENCE_FAIL'   // StoragePort write/read error (§10)
  | 'INTERNAL'           // unexpected — full trace captured
```
Each `AgentError` carries `{ code, fixtureId?, message, retriable: bool, detail }`. **No control-flow `throw` for an expected condition** — expected conditions are typed outcomes (this generalises the §9 fixture-fix to the whole pipeline).

**11A.3 — Idempotency & re-run semantics.** The worker may fire twice (overlap, retry, manual + scheduled). Defined to be safe:
- Analyses are keyed `analysisId = hash(fixtureId + kickoff + mode + calibrationSnapshotId)`; a re-run with identical inputs **upserts, never duplicates**.
- Resolution writes are **write-once** per `fixtureId`; a second resolution attempt is a no-op unless it carries corrected ground truth (which appends a correction record, preserving the original).
- A `runId` is recorded on every write so any record traces back to the run that produced it.

**11A.4 — Cost & rate-limit guardrails [DECIDED].** Binds §7 and §11:
- **Per-provider rate limits** with exponential backoff + jitter; on exhaustion emit `RATE_LIMITED` and continue with the next job rather than failing the run. **Worked constraint (June 2026):** the-odds-api free tier is **500 credits/mo ≈ 16 requests/day** — so an unthrottled 39-fixture daily batch (§7) exhausts it; the batch must prioritise fixtures by ranking-mode strength and stop cleanly at quota (or run on a paid tier). The per-provider budget is configured in `OracleConfig.costCeilingUsd` and the quota table.
- **Cost ceilings:** a per-run and a per-day USD ceiling. Crossing it halts further paid calls, emits `COST_CEILING_HIT`, and returns the partial manifest — never an unbounded spend, never a crash.
- **Dry-run estimate mode:** before a live batch, the agent can request a projection (`estimatedCalls`, `estimatedUsd`) and gate the live run on it. This is the machine-checkable form of the repo rule *"if the fix involves paid API calls, check before running."*

**11A.5 — The WAT `workflows/` SOP index.** The agent does not operate the engine ad hoc; it follows markdown SOPs (the project's Workflows→Agent→Tools layer). Each operation has one SOP, and each SOP names its inputs, the tool/entry-point it invokes, expected outputs (incl. the manifest), and edge-case handling:

| Operation | SOP | Invokes |
|---|---|---|
| Daily batch + report | `workflows/daily_run.md` | `apps/worker` batch (§7) |
| Resolve settled fixtures | `workflows/resolve.md` | worker post-match flow (§11) |
| Historical backfill | `workflows/backfill.md` | `tools/backfill_oracle.py` (§8.7) |
| Walk-forward backtest | `workflows/backtest.md` | `tools/walkforward_backtest.py` (§8.4) |
| SkillOpt loop | `workflows/skillopt.md` | `tools/skillopt.py` (§8.5) |

**Acceptance criteria (§11A).**
- Every run emits a `RunManifest` that round-trips (parse → re-serialize) and reflects per-fixture status, cost, and active calibration snapshot.
- No expected condition is signalled by a thrown exception; all are typed `AgentError`s with `retriable` set correctly.
- Running the same batch twice produces no duplicate analyses and no duplicate resolutions.
- A run that crosses the cost ceiling halts and returns a partial manifest with `cost.halted = true`, not an exception.
- Each operation in the SOP table has a corresponding `workflows/*.md` file that an operator can follow without reading engine source.

---

## 12. Risks & mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Auto-optimizer overfits noisy football data | High | Quant core never auto-optimized (§8.4); SkillOpt gated on held-out validation only (§8.5). |
| LLM makes a bad/unsafe pick | High | LLM chooses only among gate-passed candidates; `validateSelection()` enforces hard gates in code, not prompt (§6). |
| Accuracy gains are marginal (frontier already ~0.21 RPS) | Medium | Target is calibration (the root cause), not just hit-rate (§2.3); biggest leverage is selection, calibration, and market-bias features, not a model rewrite (§8). |
| Diminishing returns from a full ML rewrite | Medium | Keep ML as optional research track, not core (§8.6). |
| Key/config fragility refuses valid fixtures | Medium | Boundary key injection + NO_DATA vs NO_FIXTURE split + prediction-only degradation (§9). |
| Regulatory/jurisdiction exposure (betting) | Medium | **[OPEN]** Document the legal stance, jurisdiction limits, and "not financial advice" disclaimer before any paying-user launch. Confirm gambling-content rules for the deployment region. |
| Lookahead bias / data leakage in backfill makes the backtest lie | High | Strict walk-forward (`timestamp < kickoff`); harness flags any unstamped feature (§8.7). |
| **LLM training-data leakage inflates the decision layer's measured edge** | High | Validate LLM picks only on post-cutoff/blinded fixtures; prefer live-forward signal (§8.5 leakage protocol). |
| **"Improvement" accepted on noise (RPS frontier ≈ 0.21)** | High | Significance accept-gate — min-N + bootstrap CI lower-bound + effect-size floor; no edit on a point estimate (§8.3/§8.5). |
| **LLM decision role is hollow — no soft context actually supplied** | Medium | Mandatory timestamped `softContext` feed; honesty flag + degraded-mode tag; rationale citing absent context is flagged (§6). |
| **Unbounded paid-API spend in unattended runs** | Medium | Per-run/per-day cost ceiling halts the batch; dry-run estimate mode; per-provider backoff (§11A.4). |
| **Non-replayable LLM decision breaks auditability** | Medium | `temperature=0`, pinned model, prompt+response persisted for replay (§6). |
| **Ledger loss wipes all learned value** | Medium | Periodic off-box export; git-backed GBrain; `SqlAdapter` fallback (§10). |
| Scope creep across the named OSS tools | Low | Tools slot *into* the architecture (§3); none replaces the spine. Adopt only where it serves a named requirement. |

---

## 13. Open decisions for the owner

1. **[OPEN]** Per-league ranking-mode default tuning — defer until Phase 2 CLV data exists (§5).
2. **[OPEN]** Legal/jurisdiction stance and disclaimers before paying-user launch (§12).
3. **[OPEN]** Whether to pursue the gradient-boosting research track (§8.6).
4. **[OPEN]** OpenClaw orchestration — defer unless multi-agent routing is needed (§11).
5. **[OPEN — v1.2]** Concrete cost-ceiling values (per-run / per-day USD) and per-provider rate limits (§11A.4) — set once the owner picks a monthly budget.
6. **[OPEN — v1.2]** Pooling constant `k` and minimum-N / effect-size floors for the significance gate (§8.3/§8.5) — seed defaults from the §8.7 backfill, then tune via walk-forward.
7. **[OPEN — v1.2]** Soft-context provider choice and cost (§6) — api-football lineups/injuries vs a lighter news pull; confirm `observedAt` reliability for the anti-leakage guarantee.

---

## 14. Tool & literature appendix

**Verified OSS / methods referenced (all real, checked May 2026):**
- **SkillOpt** — Microsoft Research, MIT, arXiv:2605.23904. Text-space optimizer; trains a markdown skill file via validation-gated edits; zero deployment inference cost. → §8.5.
- **GBrain** (garrytan/gbrain) — markdown-in-git → Postgres, hybrid vector+graph retrieval. → §10.
- **GStack** (garrytan/gstack) — Claude Code skills harness (dev workflow, not embedded runtime). → optional dev tooling.
- **Karpathy AutoResearch** (karpathy/autoresearch, MIT) — ratchet loop; *cited as the overfitting cautionary case* for why the quant core is not auto-optimized. → §8.4.
- **OpenClaw** — OSS multi-agent CLI framework. → §11, optional/deferred.

**Football-modelling literature:**
- Karlis & Ntzoufras (2003) — bivariate Poisson for football. → §8.1.
- Wilkens (2026, German Bundesliga) — Skellam + bivariate Poisson; simple xG models vs the market. → §8.1, §8.2.
- Michels et al. (2025) — richer correlation structures improve fit. → §8.1.
- Hubáček, Šourek & Železný; ML survey (arXiv:2403.07669) — methods cluster at RPS ≈ 0.21; bookmaker odds hard to beat. → §2.2, §8.
- CLV literature (bet-analytix, SportBot AI, boydsbets, 2025–26) — CLV as the reliable +EV indicator. → §2.3, §8.3.
- Constantinou & Fenton — pi-ratings, RPS as the football-standard metric (already in ORACLE).
- Wheatcroft (JQAS 2020) — overreaction/"hot-hand" bias in soccer odds, exploitable. → §8.6(a).

**Data sources (re-verified June 2026, all free or free-with-attribution unless noted):**
- **`soccerdata`** (Python, v1.9.0) / **`worldfootballR`** (R) — unified wrappers over the sources below; both maintained. `soccerdata` now wraps ClubElo, ESPN, FBref, football-data.co.uk, Sofascore, SoFIFA, Understat, WhoScored. → §8.7 keystone.
- **football-data.co.uk** — free CSV results + Pinnacle closing + Asian-handicap odds, 2000/01→2025/26. → Tier 1, CLV gate.
- **Kaggle "Club Football Match Data (2000–2025)"** — 27-country / 42-league results+stats+odds superset (`adamgbor/...`). → Tier 1 backfill.
- **Understat** — free xG, 2014/15+, top-5 leagues only (RPL no longer listed — verify); scraping-only, fragile. → Tier 2.
- **StatsBomb open-data** (GitHub) — free event-level data; attribution + logo + User Agreement; limited comps. → Tier 2.
- **FBref** (Opta) — richest aggregate xG, Cloudflare-gated, tightened rate-limit (wrapper pause required; via `soccerdata`). → Tier 2.
- **ClubElo** — free historical Elo (`api.clubelo.com`), no auth, full history. → Tier 3, feeds `TeamRatingsEngine`.
- **the-odds-api** — live current-fixture odds (already integrated). Free tier 500 credits/mo (~16 req/day); paid from $30/mo. → live path, §11A.4 budget.
- ~~**FiveThirtyEight**~~ — **removed June 2026: SPI discontinued, dropped from `soccerdata`.** Not a usable source.

---

## 15. Appendix B — Canonical Types **[new in v1.2]**

The single source of truth for the contracts the engine, storage, LLM, and agent-operations layers
share. Prose elsewhere defers to these signatures; the build codegens/type-checks against them. (These
are the v1.2 baseline; Phase work may add fields, always via §10 `schemaVersion`.)

```typescript
// ── Boundary config (injected; never read from window/env inside @oracle/engine) ──
interface OracleConfig {
  geminiApiKey: string;
  claudeApiKey: string;
  openWeatherApiKey?: string;
  footballDataApiKey?: string;
  apiFootballKey?: string;
  oddsApiKey?: string;
  bankroll: number;
  rankingMode: RankingMode;            // default 'CONFIDENCE_WEIGHTED'
  useBivariatePoisson?: boolean;       // §8.1, default false
  useSkellam?: boolean;                // §8.2, default false
  costCeilingUsd?: { perRun: number; perDay: number };  // §11A.4
}

// ── Persistence: the ONLY persistence contract (§3.1) ──
interface StoragePort {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  list(prefix: string): Promise<string[]>;
  query<T>(filter: (item: T) => boolean): Promise<T[]>;
  bulkWrite<T>(key: string, items: T[]): Promise<void>;   // §8.7 backfill / §10
}

type RankingMode = 'CONFIDENCE_WEIGHTED' | 'MAX_PROBABILITY' | 'MAX_EV';   // §5

// ── §6 decision layer ──
interface SoftContextItem { kind: 'lineup'|'injury'|'news'|'motivation'; text: string; source: string; observedAt: string; }
interface DecisionInput  { eligibleBets: EVMarket[]; evidence: FixtureEvidence; softContext: SoftContextItem[] | 'NONE'; }
interface DecisionOutput { primaryPick: PickRef | 'NO_BET'; altPick?: PickRef; confidence: number; rationale: string; rejectedAndWhy: string[]; }
interface DecisionReplay { prompt: string; rawResponse: string; model: string; temperature: 0; }   // §6 determinism

// ── §11A agent-operations contract ──
type FixtureStatus = 'ok' | 'skipped' | 'error';
type AgentErrorCode =
  | 'NO_DATA' | 'AMBIGUOUS_FIXTURE' | 'ODDS_UNAVAILABLE' | 'RATE_LIMITED'
  | 'COST_CEILING_HIT' | 'LLM_PARSE_FAIL' | 'VALIDATION_REJECT'
  | 'PERSISTENCE_FAIL' | 'INTERNAL';
interface AgentError { code: AgentErrorCode; fixtureId?: string; message: string; retriable: boolean; detail?: unknown; }
type ResolveOutcome = 'RESOLVED' | 'AMBIGUOUS' | 'NO_DATA';                 // §9
type ClvSourceQuality = 'TICK_LEVEL' | 'KICKOFF_PROXY' | 'UNKNOWN';        // §8.3
type LiquidityTag = 'CLV_ELIGIBLE' | 'CALIBRATION_ONLY';                   // §8.3

interface FixtureJob { home: string; away: string; league?: string; kickoff?: string; }   // §7
interface FixtureOutcome {
  fixtureId: string; home: string; away: string; kickoff: string;
  status: FixtureStatus; reason?: string; primaryPick?: PickRef;
  softContext: 'PRESENT' | 'NONE'; analysisRef: string;
}
interface RunManifest {
  runId: string; startedAt: string; finishedAt: string;
  mode: RankingMode; trigger: 'scheduled' | 'manual' | 'backfill';
  fixtures: FixtureOutcome[];
  totals: { attempted: number; ok: number; skipped: number; errored: number; actionableBets: number; recommendedStakePct: number; };
  cost: { byProvider: Record<string, number>; totalUsd: number; ceilingUsd: number; halted: boolean; };
  errors: AgentError[];
  calibrationSnapshotId: string;
  schemaVersion: number;
}

// ── §10 ledger records (abbreviated; PickRef/EVMarket/FixtureEvidence defined in @oracle/engine/types.ts) ──
interface AnalysisRecord {
  analysisId: string; runId: string; schemaVersion: number; calibrationSnapshotId: string;
  fixtureId: string; home: string; away: string; league: string; kickoff: string;
  lambdaH: number; lambdaA: number; probabilities: { home: number; draw: number; away: number };
  regime: string; rankingMode: RankingMode; liquidityTag: LiquidityTag;
  evMarkets: EVMarket[]; llmPick: DecisionOutput; deterministicTopPick: PickRef;
  frozenOddsAtAnalysis: unknown; decisionReplay: DecisionReplay; softContext: 'PRESENT' | 'NONE';
}
interface ResolutionRecord {       // write-once per fixtureId (§11A.3)
  fixtureId: string; runId: string; schemaVersion: number;
  actualResult: 'H' | 'D' | 'A'; homeGoals: number; awayGoals: number;
  realisedCLV: number | null; clvSourceQuality: ClvSourceQuality;
  rpsContribution: number; drawCalibrationPoint: number;
}
```

---

*End of specification v1.2.1. Objective: calibration (optimized) → CLV (liquid-market gate) → profit (validation). Implementation order: §3 (spine, incl. golden-master) → §8.7 backfill + §5, §6 (soft-context + determinism), §9, §4, §8.1–8.4 (Phase 1) → §10 (Phase 2) → §7, §11, §11A (agent-ops), §8.5 (Phase 3). v1.2 adds the agent-operability layer (§11A), the LLM-leakage protocol (§8.5), the significance accept-gate (§8.3), hierarchical thin-market calibration (§2.3/§8.3), and Canonical Types (Appendix B).*
