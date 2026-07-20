/** all-markets-analysis-prompt-v3 Phase 5 — the tiered EV gate.
 *
 *  Extends the goalsV3 §4 gate (goalsV3/edgeGate.ts penalty table, absolute
 *  edge cap, noise band) with the all-markets machinery:
 *
 *    Raw Edge      = P_model − q_implied   (conditional p′ where pushes exist —
 *                                           applied by the engines upstream)
 *    Adjusted Edge = Raw − Σ penalties
 *    Adjusted EV%  = Adjusted Edge ÷ q
 *
 *  Tiered qualification (§5.2 — a uniform bar would structurally exclude the
 *  mandated low-variance shorts; pure EV% ranking floods the list with
 *  longshots): S ≥ 3pts AND EV% ≥ 4 · M ≥ 5pts · L ≥ 6pts AND EV% ≥ 15 ·
 *  X ≥ 6pts (after the −5 class penalty) AND EV% ≥ 20 AND odds ≤ 15.
 *  Noise band |P − q| ≤ 2pts discards everywhere.
 *
 *  Caps (§5.4, "model too hot"): Raw > 12pts ⇒ capped (all classes);
 *  odds > 3.00 AND Raw/q > 40% ⇒ capped (exotics 30%). Capped selections are
 *  logged, never bet.
 *
 *  Penalties (§5.3): legacy goalsV3 flags + exotics −5 · market-specific stat
 *  missing −1 · shape disagreement −2 (result-class only, applied upstream).
 *
 *  Pure math, no I/O. */

import {
  V3_EDGE_CAP_DEFAULT,
  V3_NOISE_GATE_DEFAULT,
  type V3PenaltyFlags,
  v3PenaltyPts,
} from "../goalsV3/edgeGate.js";
import { devigTwoWay } from "../markets/index.js";
import type { V3MarketClass } from "./classes.js";

/** §5.3 additions on top of the goalsV3 table. Probability points (0.01 = 1pt). */
export interface V3AllMarketsPenaltyFlags extends V3PenaltyFlags {
  /** Class X structural penalty (−5). */
  exoticClass?: boolean;
  /** Market-specific stat missing (half markets on league-default ρ, shape
   *  markets without BTTS%/CS%/FTS% hit-rates) (−1). */
  marketStatMissing?: boolean;
  /** §3.2 stats-vs-odds split disagreement, result-class candidates only (−2). */
  shapeDisagreement?: boolean;
}

export const V3_ALLMARKETS_PENALTY_PTS = {
  exoticClass: 0.05,
  marketStatMissing: 0.01,
  shapeDisagreement: 0.02,
} as const;

export function allMarketsPenaltyPts(flags: V3AllMarketsPenaltyFlags): number {
  let pts = v3PenaltyPts(flags);
  if (flags.exoticClass) pts += V3_ALLMARKETS_PENALTY_PTS.exoticClass;
  if (flags.marketStatMissing) pts += V3_ALLMARKETS_PENALTY_PTS.marketStatMissing;
  if (flags.shapeDisagreement) pts += V3_ALLMARKETS_PENALTY_PTS.shapeDisagreement;
  return pts;
}

/** §5.2 class thresholds (adjusted edge in probability points, EV% as ratio). */
export const CLASS_GATE: Record<
  V3MarketClass,
  { minAdjEdge: number; minAdjEvPct: number | null; maxOdds: number | null }
> = {
  S: { minAdjEdge: 0.03, minAdjEvPct: 0.04, maxOdds: null },
  M: { minAdjEdge: 0.05, minAdjEvPct: null, maxOdds: null },
  L: { minAdjEdge: 0.06, minAdjEvPct: 0.15, maxOdds: null },
  X: { minAdjEdge: 0.06, minAdjEvPct: 0.2, maxOdds: 15 },
};

/** v4 heightened gates (§5.2 delta): stricter bars under HFA/hit-rate uncertainty.
 *  X excluded entirely; S/M/L gates raised; S/M drop EV% requirements. */
export const CLASS_GATE_HEIGHTENED: Record<
  V3MarketClass,
  { minAdjEdge: number; minAdjEvPct: number | null; maxOdds: number | null } | null
> = {
  S: { minAdjEdge: 0.05, minAdjEvPct: 0.07, maxOdds: null },
  M: { minAdjEdge: 0.08, minAdjEvPct: null, maxOdds: null },
  L: { minAdjEdge: 0.09, minAdjEvPct: 0.2, maxOdds: null },
  X: null, // X excluded in v4 heightened mode
};

/** §5.4 relative cap: odds > 3.00 and Raw/q above this ⇒ capped. */
export const RELATIVE_CAP_ODDS_FLOOR = 3.0;
export const RELATIVE_CAP_RATIO = 0.4;
export const RELATIVE_CAP_RATIO_X = 0.3;

/** True-EV floor at the offered price: modelP * odds - 1. The class thresholds
 *  above gate on probability-points/EV% vs. the de-vigged fair price, which is
 *  a different quantity from EV at the price actually offered — at a
 *  wide-margin book, a selection can clear every class bar in points/EV% terms
 *  while still being -EV at the real odds (e.g. odds 1.40 @ 8% margin, p=0.706
 *  clears the S-class gate at 3.17pts/4.7% while true EV = 0.706*1.40-1 =
 *  -1.16%). Requiring true EV > 0 in addition to the class gate closes that
 *  gap without touching the class tiers themselves (still used for confidence
 *  banding). Mirrors the legacy pipeline's already-correct `adjEV` gate
 *  (math/index.ts, p*odds-1-MOS) that this all-markets path never reused. */
export const V3_EV_FLOOR_DEFAULT = 0;

/** [refactor P0-2] Market-anchored blend (v5 §5.8, live-incident 2026-07-09 —
 *  unblended Poisson models overrating weak sides at long odds, e.g. fake
 *  +65-70% "edges" on 6.20/13.50 longshots). The de-vigged market price q.q is
 *  the prior; the model (modelP) nudges it by wModel. wModel scales with data
 *  quality — up to +0.15 for full completeness, +0.10 for confirmed
 *  (non-estimated) xG — off a 0.15 floor (closest to market = strictest, the
 *  correct posture when completeness/xG provenance is unknown/absent) and a
 *  hard 0.40 ceiling (the model may never out-weigh the market more than
 *  40/60). See computeMarketBlend below. */
export const V3_BLEND_W_FLOOR = 0.15;
export const V3_BLEND_W_COMPLETENESS_COEF = 0.15;
export const V3_BLEND_W_XG_COEF = 0.1;
export const V3_BLEND_W_CAP = 0.4;
/** §5.8 mandatory longshot gate: odds ≥ this floor additionally require
 *  blendEdge ≥ V3_BLEND_MIN_EDGE when blendMode === "on" (additive to the
 *  existing Class L/X bars — never a substitute for them). */
export const V3_BLEND_GATE_ODDS_FLOOR = 4.0;
export const V3_BLEND_MIN_EDGE = 0.05;

/** [Wave 4-accuracy] v3BlendPricing (OracleConfig.v3BlendPricing) rescaled
 *  class bars — active ONLY when gateAllMarkets' opts.blendPricing is true.
 *  Legacy CLASS_GATE/CLASS_GATE_HEIGHTENED above are UNTOUCHED (flag-off path
 *  stays byte-identical). Blended probabilities are anchored close to the
 *  de-vigged market price (wModel tops out at 0.40 — see computeMarketBlend),
 *  so the residual edge after blending is naturally much smaller than a raw
 *  modelP-vs-q edge; the point bars below are the exact per-class values the
 *  Wave-4 spec calls for (~1/3 of the raw CLASS_GATE point values), with
 *  independently-set (mostly lower) EV floors measured on blendEV rather than
 *  adjEvPct. Units: minAdjEdgeBlend in probability (0.01 = 1pt), same
 *  convention as CLASS_GATE.minAdjEdge. */
export const CLASS_GATE_BLEND: Record<
  V3MarketClass,
  { minAdjEdgeBlend: number; minBlendEvPct: number | null; maxOdds: number | null }
> = {
  S: { minAdjEdgeBlend: 0.01, minBlendEvPct: 0.04, maxOdds: null },
  M: { minAdjEdgeBlend: 0.015, minBlendEvPct: null, maxOdds: null },
  L: { minAdjEdgeBlend: 0.02, minBlendEvPct: 0.08, maxOdds: null },
  X: { minAdjEdgeBlend: 0.02, minBlendEvPct: 0.12, maxOdds: 15 },
};

/** [Wave 4-accuracy] Heightened blend bars — X excluded entirely (mirrors
 *  CLASS_GATE_HEIGHTENED's own X-exclusion). JUDGMENT CALL, flagged for
 *  review: the spec line this implements ("point bars ×0.30, EV floors on
 *  blendEV") is terse to the point of genuine ambiguity about direction. A
 *  literal ×0.30 multiplier would make heightened bars LAXER than the base
 *  table, which would contradict every other heightened gate in this file
 *  (all of them raise the bar, never lower it) and the entire point of
 *  "heightened" (stricter-data-uncertainty posture). This implementation
 *  reads "×0.30" as "a further 30% increase over the base blend bars" (i.e.
 *  ×1.30 of CLASS_GATE_BLEND) — stricter, consistent with CLASS_GATE_HEIGHTENED's
 *  own direction. Re-derive from the spec author if a different reading was
 *  intended; the numbers below are exact ×1.30 multiples of CLASS_GATE_BLEND. */
export const CLASS_GATE_BLEND_HEIGHTENED: Record<
  V3MarketClass,
  { minAdjEdgeBlend: number; minBlendEvPct: number | null; maxOdds: number | null } | null
> = {
  S: { minAdjEdgeBlend: 0.013, minBlendEvPct: 0.052, maxOdds: null },
  M: { minAdjEdgeBlend: 0.0195, minBlendEvPct: null, maxOdds: null },
  L: { minAdjEdgeBlend: 0.026, minBlendEvPct: 0.104, maxOdds: null },
  X: null, // X excluded in v4/blend heightened mode
};

/** [X-carveout, owner decision 2026-07-11] High-conviction Class X exception
 *  to the blend gate — the ONLY deliberate gate RELAXATION in this file
 *  (every other flag raises bars). Rationale: under v3BlendPricing, Class X
 *  is unreachable by construction — rawEdgeBlend = wModel·rawEdge tops out at
 *  0.40 × 0.12 (V3_BLEND_W_CAP × V3_EDGE_CAP_DEFAULT) = 0.048, and the −5pt
 *  exotic penalty (calibrated in RAW-edge space, where the class bars are ~3×
 *  the blend bars) drags adjustedEdgeBlend to ≤ −0.002, below X's 0.02 floor
 *  (see blendGate.test.ts's "DOCUMENTED CONTRADICTION" test). The unit
 *  mismatch — blend-space edge, raw-space penalty — is the exact mechanism,
 *  so the carve-out re-evaluates ONLY the edge floor with the penalty
 *  rescaled by the same ~1/3 ratio the blend bars themselves use
 *  (CLASS_GATE_BLEND vs CLASS_GATE: S .01/.03, M .015/.05, L .02/.06).
 *  Every other X bar still applies at full strength: odds ≤ 15, blendEV ≥
 *  12%, the EV floor, the odds≥4 mandatory blend bar, raw caps/noise (which
 *  run first and are untouched), and the heightened X-exclusion. On top,
 *  data-quality conviction is required: confirmed real xG AND completeness ≥
 *  X_CARVEOUT_MIN_COMPLETENESS (⇒ wModel ≥ 0.37 of its 0.40 cap). The
 *  reachable window is deliberately narrow — shortish-odds exotics with a
 *  near-cap raw edge and near-full data quality; at long odds the 30%
 *  relative raw cap keeps X unreachable regardless of this flag. */
export const X_CARVEOUT_PENALTY_RESCALE = 1 / 3;
export const X_CARVEOUT_MIN_COMPLETENESS = 0.8;

/** [patterns-engine Wave 2, owner decision 2026-07-16] Pattern-backed
 *  class-edge relaxation — the SECOND deliberate gate RELAXATION in this file
 *  (after the X-carveout). When a fixture's deterministic green-flag detector
 *  (marketsV3/patterns.ts) fires a strong pattern whose recommended
 *  family+side matches this outcome, the CLASS_GATE_BLEND class_edge bar
 *  (minAdjEdgeBlend) is lowered by up to PATTERN_EDGE_RELAX_MAX, scaled by the
 *  detector's 0-1 strength. This is the owner-locked "pattern-primary + value
 *  floor" fix for the 0/4394 class_edge dryness (2026-07-15 evidence).
 *
 *  HARD INVARIANTS — the relaxation touches ONLY minAdjEdgeBlend. Every other
 *  bar stays at full strength: the absolute/relative caps + the noise gate
 *  (raw-edge, evaluated FIRST above the blend branch — a pattern can never
 *  rescue a capped/noise candidate), minBlendEvPct, maxOdds, and
 *  blendEV >= evFloor. On TOP of those, the pattern path adds an explicit
 *  VALUE FLOOR the standard blend gate does not itself require: the raw true EV
 *  `ev = modelP·odds − 1` must be strictly positive. Patterns relax the class
 *  bar; they NEVER admit a −EV pick. */
export const PATTERN_EDGE_RELAX_MAX = 0.5;
/** Minimum detector strength (0-1) that may relax the bar — mirrors
 *  patterns.ts's confMedium (below it the detector reports no usable
 *  confidence, so there is nothing to relax on). */
export const PATTERN_MIN_STRENGTH = 0.3;
/** Additive rankingScore bonus for an admitted pattern-backed pick, scaled by
 *  strength (applied at the analyzeFixtureMarkets call site, not here — it sets
 *  rankingScore). Sized to lift a pattern pick above an equivalent non-pattern
 *  pick without swamping genuinely large-edge picks (comparable to one class
 *  bar). */
export const PATTERN_RANK_BONUS = 0.02;

const clampPattern01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Confidence for an admitted pattern-backed pick: a monotonic boost off the
 *  detector strength that never lowers the standard blend band and never falls
 *  below "medium" (a relaxed-only pass sits right at the relaxed floor, so its
 *  standard band would be null — floor it to medium, honest but not banded up). */
function patternConfidence(strength: number, standard: V3Confidence | null): V3Confidence {
  const fromStrength: V3Confidence =
    strength >= 0.7 ? "very_high" : strength >= 0.5 ? "high" : "medium";
  const rank = (c: V3Confidence | null): number =>
    c === "very_high" ? 3 : c === "high" ? 2 : c === "medium" ? 1 : 0;
  return rank(fromStrength) >= rank(standard) ? fromStrength : (standard as V3Confidence);
}

export type V3Confidence = "very_high" | "high" | "medium";
export type V3AllGateOutcome = "done" | "capped" | "noise" | "below_gate";

/** Attributed reason a candidate failed/was excluded — additive to `outcome`
 *  (which stays exactly as-is for backward compat). Only ever set when the
 *  candidate does NOT reach "done"; undefined on a passing assessment. */
export type V3AllGateReason =
  | "class_edge"
  | "class_evpct"
  | "max_odds"
  | "ev_floor"
  | "heightened_x_excluded"
  | "model_hot_longshot"
  | "noise"
  | "capped_absolute"
  | "capped_relative"
  /** [Phase 4, λ fallback ladder] λ was derived from the F4 market-implied
   *  rung (marketsV3/lambdaFallback.ts) — pricing EV off a λ built from the
   *  fixture's own odds is circular, not a real edge. analyzeFixtureMarketsV3
   *  forces every outcome to this reason regardless of the gate's own
   *  verdict, so it can never reach evMarkets/best/v3BestFallback (the
   *  class_edge-only fill-to-39 pool) but still surfaces in v3Watchlist
   *  (outcome !== "done") for report transparency. */
  | "lambda_market_implied";

export interface V3AllMarketsAssessment {
  q: number;
  devigged: boolean;
  rawEdge: number;
  penaltyPts: number;
  adjustedEdge: number;
  /** Adjusted EV% = adjustedEdge / q (ROI proxy per unit staked). */
  adjEvPct: number;
  /** True EV at the offered price: modelP * odds - 1. See V3_EV_FLOOR_DEFAULT. */
  ev: number;
  cls: V3MarketClass;
  outcome: V3AllGateOutcome;
  confidence: V3Confidence | null;
  /** Which §5.4 cap fired, when outcome === "capped". */
  capReason?: "absolute" | "relative";
  /** Attributed failure reason — see V3AllGateReason. Additive; `outcome`
   *  remains the source of truth for pass/fail branching everywhere else. */
  gateReason?: V3AllGateReason;
  /** [refactor P0-2] market-anchored blend weight on modelP, 0.15-0.40 —
   *  present whenever blendMode !== "off" (both "shadow" and "on"), computed
   *  BEFORE any gate branching so it's persisted for the calibration ledger
   *  even on capped/noise/below_gate assessments. */
  wModel?: number;
  /** (1 - wModel)*q.q + wModel*modelP — the blended fair probability. */
  pBlend?: number;
  /** pBlend * odds - 1 — true EV at the offered price under the blended prior. */
  blendEdge?: number;
  /** blendEdge >= V3_BLEND_MIN_EDGE, independent of whether it was actually
   *  enforced (enforcement is odds>=4.00 AND blendMode==="on" only). */
  blendGatePass?: boolean;
  /** [Wave 4-accuracy] pBlend − q — the "probability-points" edge measured
   *  against the BLENDED prior instead of raw modelP. `rawEdge` above always
   *  stays the RAW value regardless of blendPricing — HARD INVARIANT, see
   *  gateAllMarkets' blendPricing branch. Present whenever blend was computed
   *  (blendMode !== "off" OR opts.blendPricing === true). */
  rawEdgeBlend?: number;
  /** rawEdgeBlend − penaltyPts (same penalty table `adjustedEdge` uses — the
   *  −5 exotic-class penalty etc. flow through identically). */
  adjustedEdgeBlend?: number;
  /** pBlend * odds − 1 — true EV at the offered price under the blended
   *  prior. Numerically identical to `blendEdge` above (both compute
   *  pBlend*odds-1); kept as a separate, distinctly-named field because
   *  v3BlendPricing's rescaled class gates/EV floor/confidence key off THIS
   *  name while `blendEdge`/`blendGatePass` keep their pre-existing
   *  odds>=4.00 mandatory-gate semantics completely untouched. */
  blendEV?: number;
  /** [X-carveout] Set ONLY when the high-conviction Class X carve-out (see
   *  X_CARVEOUT_PENALTY_RESCALE's header) evaluated this candidate as
   *  qualifying: "passed" = flag "on", candidate admitted (outcome "done",
   *  confidence pinned to "medium"); "shadow_pass" = flag "shadow", candidate
   *  would have been admitted but outcome stays "below_gate" (ledger evidence
   *  only). Undefined everywhere else — including every non-X class, flag
   *  "off", and X candidates that fail any carve-out condition. */
  xCarveout?: "passed" | "shadow_pass";
  /** [X-carveout] The rescaled-penalty edge the carve-out evaluated:
   *  rawEdgeBlend − penaltyPts·X_CARVEOUT_PENALTY_RESCALE (≥ the X blend
   *  floor 0.02 whenever set). Present exactly when xCarveout is set. For
   *  "passed" picks this — not the structurally-negative adjustedEdgeBlend —
   *  is what downstream staking/ranking uses (analyzeFixtureMarkets swaps it
   *  in as the primary adjustedEdge); for "shadow_pass" it's the
   *  counterfactual for ledger analysis. */
  adjustedEdgeCarveout?: number;
  /** [patterns-engine Wave 2] True when this outcome's family+side matches the
   *  fixture detector's top green-flag pattern (set by the analyzeFixtureMarkets
   *  caller). Echoed onto every assessment once patternMode !== "off" for
   *  reporting/ledger, independent of whether the relaxation fired. */
  patternBacked?: boolean;
  /** [patterns-engine Wave 2] The detector's 0-1 fixture pattern strength —
   *  present whenever patternBacked is set. */
  patternStrength?: number;
  /** [patterns-engine Wave 2] Set ONLY when the pattern class-edge relaxation
   *  was the deciding factor (candidate failed the standard CLASS_GATE_BLEND
   *  class_edge bar but clears the strength-scaled relaxed bar with every other
   *  bar + the ev>0 value floor intact). "passed" = flag "on", admitted
   *  (outcome "done"); "shadow_pass" = flag "shadow", would-admit but outcome
   *  stays "below_gate" (pool/ledger evidence only). Undefined otherwise. */
  patternRelaxed?: "passed" | "shadow_pass";
  /** [patterns-engine Wave 2] The strength-scaled relaxed class_edge bar the
   *  relaxation evaluated (≤ blendGate.minAdjEdgeBlend) — present exactly when
   *  patternRelaxed is set. */
  patternRelaxedBar?: number;
}

/** [refactor P0-2] Pure blend math, factored out so it's independently
 *  testable against the v5 §5.8 worked examples. `completeness01` and
 *  `hasRealXg` default to the strictest posture (0 / false) when omitted —
 *  a missing data-quality signal must never earn the model extra trust. */
export function computeMarketBlend(
  modelP: number,
  q: number,
  odds: number,
  completeness01 = 0,
  hasRealXg = false
): { wModel: number; pBlend: number; blendEdge: number; blendGatePass: boolean } {
  const wModel = Math.min(
    V3_BLEND_W_CAP,
    V3_BLEND_W_FLOOR +
      V3_BLEND_W_COMPLETENESS_COEF * completeness01 +
      V3_BLEND_W_XG_COEF * (hasRealXg ? 1 : 0)
  );
  const pBlend = (1 - wModel) * q + wModel * modelP;
  const blendEdge = pBlend * odds - 1;
  return { wModel, pBlend, blendEdge, blendGatePass: blendEdge >= V3_BLEND_MIN_EDGE };
}

/** §5.5 confidence. M/L/X read the adjusted edge (X's Medium floor is 6pts —
 *  its gate floor); S reads Adjusted EV%. */
export function v3Confidence(
  cls: V3MarketClass,
  adjustedEdge: number,
  adjEvPct: number
): V3Confidence | null {
  if (cls === "S") {
    if (adjEvPct >= 0.1) return "very_high";
    if (adjEvPct >= 0.07) return "high";
    if (adjEvPct >= 0.04) return "medium";
    return null;
  }
  if (adjustedEdge >= 0.1) return "very_high";
  if (adjustedEdge >= 0.07) return "high";
  if (adjustedEdge >= (cls === "X" ? 0.06 : 0.05)) return "medium";
  return null;
}

/** [Wave 4-accuracy] Confidence bands under v3BlendPricing. JUDGMENT CALL: no
 *  explicit thresholds were specified by the spec line ("confidence...
 *  switch to blended"), so these are DERIVED from each class's own
 *  CLASS_GATE_BLEND floor rather than hardcoded — medium = right at the
 *  class's own gate floor (so passing the gate always yields at least
 *  "medium", never null), high = 1.4x the floor, very_high = 2.0x. Those
 *  ratios reproduce v3Confidence's own non-S flat thresholds (0.07/0.05=1.4,
 *  0.10/0.05=2.0) relative to its 0.05 base. S keys off blendEV (mirrors
 *  v3Confidence's own adjEvPct-based S branch); S's blendEV floor (0.04)
 *  equals v3Confidence's raw medium threshold, so the 1.75x/2.5x ratios here
 *  reproduce v3Confidence's existing 0.07/0.10 S thresholds exactly. */
export function v3ConfidenceBlend(
  cls: V3MarketClass,
  adjustedEdgeBlend: number,
  blendEV: number,
  gate: { minAdjEdgeBlend: number; minBlendEvPct: number | null }
): V3Confidence | null {
  if (cls === "S") {
    const floor = gate.minBlendEvPct;
    if (floor === null || floor <= 0) return null;
    if (blendEV >= floor * 2.5) return "very_high";
    if (blendEV >= floor * 1.75) return "high";
    if (blendEV >= floor) return "medium";
    return null;
  }
  const floor = gate.minAdjEdgeBlend;
  if (adjustedEdgeBlend >= floor * 2.0) return "very_high";
  if (adjustedEdgeBlend >= floor * 1.4) return "high";
  if (adjustedEdgeBlend >= floor) return "medium";
  return null;
}

/** Run the full Phase-5 gate for one selection. `modelP` must already be the
 *  conditional p′ where the market can push. When `heightened` is true, use v4
 *  heightened gates (stricter bars, X excluded). */
export function gateAllMarkets(
  modelP: number,
  q: { q: number; devigged: boolean },
  odds: number,
  cls: V3MarketClass,
  flags: V3AllMarketsPenaltyFlags,
  opts: {
    edgeCap?: number;
    noiseGate?: number;
    heightened?: boolean;
    evFloor?: number;
    /** [refactor P0-2] "off" (default here — callers opt in explicitly) skips
     *  the blend computation entirely, byte-identical to pre-P0-2 gating.
     *  "shadow" computes+returns the blend fields but never gates on them.
     *  "on" additionally enforces the odds>=4.00 mandatory blend bar below. */
    blendMode?: "off" | "shadow" | "on";
    /** 0-1 scale. Absent ⇒ 0 (the strictest wModel posture — see
     *  computeMarketBlend's header comment). */
    completeness?: number;
    hasRealXg?: boolean;
    /** [Wave 4-accuracy] v3BlendPricing (OracleConfig.v3BlendPricing) — when
     *  true, class gates/EV floor/confidence price off pBlend via the
     *  rescaled CLASS_GATE_BLEND(_HEIGHTENED) bars instead of raw modelP.
     *  Independent of blendMode: true here FORCES the blend computation even
     *  if blendMode is "off" (the two flags are separate contracts — see
     *  OracleConfig.v3BlendPricing vs v3Blend). Caps and the noise gate below
     *  ALWAYS evaluate raw rawEdge/q regardless of this flag — HARD
     *  INVARIANT: blending must never rescue a raw-capped/raw-noise
     *  candidate. Default false ⇒ byte-identical to pre-Wave-4 gating. */
    blendPricing?: boolean;
    /** [X-carveout] OracleConfig.v3XCarveout — high-conviction Class X
     *  exception to the blendPricing gate (see X_CARVEOUT_PENALTY_RESCALE's
     *  header for the full derivation and conditions). Only consulted inside
     *  the blendPricing branch for cls === "X" candidates that failed the
     *  standard CLASS_GATE_BLEND.X bar. "off" (default) ⇒ byte-identical to
     *  pre-carveout gating. */
    xCarveout?: "off" | "shadow" | "on";
    /** [patterns-engine Wave 2] OracleConfig.v3Patterns — pattern-backed
     *  class-edge relaxation mode. "off" (default) ⇒ byte-identical to
     *  pre-Wave-2 gating. "shadow" tags a would-pass candidate
     *  (patternRelaxed:"shadow_pass") without changing its outcome. "on"
     *  admits a pattern-backed candidate that clears the strength-scaled
     *  relaxed class_edge bar (+ every other bar + the ev>0 value floor). Only
     *  consulted in the blendPricing branch for patternBacked candidates. */
    patternMode?: "off" | "shadow" | "on";
    /** [patterns-engine Wave 2] True when this outcome's family+side matches
     *  the fixture detector's top-pattern recommendation (marketsV3/patterns.ts).
     *  The caller decides the match; this gate only trusts the flag. */
    patternBacked?: boolean;
    /** [patterns-engine Wave 2] The detector's 0-1 fixture pattern strength.
     *  Below PATTERN_MIN_STRENGTH the relaxation never fires. */
    patternStrength?: number;
  } = {}
): V3AllMarketsAssessment {
  const edgeCap = opts.edgeCap ?? V3_EDGE_CAP_DEFAULT;
  const noiseGate = opts.noiseGate ?? V3_NOISE_GATE_DEFAULT;
  const heightened = opts.heightened ?? false;
  const evFloor = opts.evFloor ?? V3_EV_FLOOR_DEFAULT;
  const blendMode = opts.blendMode ?? "off";
  const blendPricing = opts.blendPricing ?? false;
  const xCarveout = opts.xCarveout ?? "off";
  const patternMode = opts.patternMode ?? "off";
  const patternBacked = opts.patternBacked ?? false;
  const patternStrength = opts.patternStrength ?? 0;

  const rawEdge = modelP - q.q;
  const penaltyPts = allMarketsPenaltyPts(flags);
  const adjustedEdge = rawEdge - penaltyPts;
  const adjEvPct = q.q > 0 ? adjustedEdge / q.q : 0;
  const ev = modelP * odds - 1;

  // [refactor P0-2 / Wave 4-accuracy] Computed unconditionally whenever
  // blendMode !== "off" OR blendPricing is true (the two flags independently
  // require the blend math), BEFORE any gate branching below, so the fields
  // land on every outcome — capped/noise/below_gate included — for
  // calibration-ledger persistence in every mode.
  const blend =
    blendMode !== "off" || blendPricing
      ? computeMarketBlend(modelP, q.q, odds, opts.completeness ?? 0, opts.hasRealXg ?? false)
      : null;
  // [Wave 4-accuracy] See V3AllMarketsAssessment's field docs — blendEV is
  // numerically identical to blend.blendEdge (both pBlend*odds-1); kept as a
  // distinct field name so the v3BlendPricing gate below and the pre-existing
  // odds>=4.00 blendEdge gate read independently-named fields.
  const rawEdgeBlend = blend ? blend.pBlend - q.q : undefined;
  const adjustedEdgeBlend = blend ? rawEdgeBlend! - penaltyPts : undefined;
  const blendEV = blend ? blend.blendEdge : undefined;

  const base = {
    q: q.q,
    devigged: q.devigged,
    rawEdge,
    penaltyPts,
    adjustedEdge,
    adjEvPct,
    ev,
    cls,
    ...(blend
      ? {
          wModel: blend.wModel,
          pBlend: blend.pBlend,
          blendEdge: blend.blendEdge,
          blendGatePass: blend.blendGatePass,
          rawEdgeBlend,
          adjustedEdgeBlend,
          blendEV,
        }
      : {}),
    // [patterns-engine Wave 2] Echo the pattern signal onto every assessment
    // once the flag is active (shadow or on) so slate reports/the ledger can
    // see pattern coverage even on candidates the relaxation didn't decide.
    ...(patternMode !== "off" && patternBacked ? { patternBacked: true, patternStrength } : {}),
  };

  // v4 heightened: X excluded entirely — covers both the legacy raw path AND
  // the blendPricing path (CLASS_GATE_BLEND_HEIGHTENED.X is also null), since
  // this check runs before either gate table is consulted.
  if (heightened && cls === "X") {
    return {
      ...base,
      outcome: "below_gate",
      confidence: null,
      gateReason: "heightened_x_excluded",
    };
  }

  // HARD INVARIANT: caps + the noise gate ALWAYS evaluate the RAW edge, never
  // the blended one — a candidate the raw math would cap/discard as noise can
  // never be rescued by blend-anchored pricing, regardless of blendPricing.
  if (rawEdge > edgeCap) {
    return {
      ...base,
      outcome: "capped",
      confidence: null,
      capReason: "absolute",
      gateReason: "capped_absolute",
    };
  }
  const relRatio = cls === "X" ? RELATIVE_CAP_RATIO_X : RELATIVE_CAP_RATIO;
  if (odds > RELATIVE_CAP_ODDS_FLOOR && q.q > 0 && rawEdge / q.q > relRatio) {
    return {
      ...base,
      outcome: "capped",
      confidence: null,
      capReason: "relative",
      gateReason: "capped_relative",
    };
  }
  if (Math.abs(rawEdge) <= noiseGate) {
    return { ...base, outcome: "noise", confidence: null, gateReason: "noise" };
  }

  // [refactor P0-2] MANDATORY gate, blendMode "on" only: odds>=4.00
  // candidates must ALSO clear the blend-anchored EV bar — additive to
  // whichever class table below applies (legacy or v3BlendPricing), never a
  // relaxation of it. Unaffected by blendPricing itself.
  const blendGateRequired =
    blendMode === "on" && odds >= V3_BLEND_GATE_ODDS_FLOOR && blend !== null;
  const blendGateOk = !blendGateRequired || blend!.blendGatePass;

  // [Wave 4-accuracy] v3BlendPricing: class gates/EV floor/confidence switch
  // to the blended quantities via the rescaled CLASS_GATE_BLEND(_HEIGHTENED)
  // tables. Branches separately from the legacy raw path below (different
  // gate-table field names) — both share the identical caps/noise/
  // heightened-X-exclusion logic above and the same blendGateOk requirement.
  if (blendPricing && blend) {
    const blendGateTable = heightened ? CLASS_GATE_BLEND_HEIGHTENED : CLASS_GATE_BLEND;
    const blendGate = blendGateTable[cls];
    if (blendGate === null) {
      return {
        ...base,
        outcome: "below_gate",
        confidence: null,
        gateReason: "heightened_x_excluded",
      };
    }
    const classOk =
      adjustedEdgeBlend! >= blendGate.minAdjEdgeBlend &&
      (blendGate.minBlendEvPct === null || blendEV! >= blendGate.minBlendEvPct) &&
      (blendGate.maxOdds === null || odds <= blendGate.maxOdds) &&
      blendEV! >= evFloor;
    const passes = classOk && blendGateOk;

    if (!passes) {
      // [patterns-engine Wave 2] Pattern-backed class-edge relaxation (ALL
      // classes) — see PATTERN_EDGE_RELAX_MAX's header. Reached only AFTER the
      // raw caps + noise gate above (untouched) and the standard blend gate,
      // so it can never rescue a capped/noise candidate. Relaxes ONLY
      // minAdjEdgeBlend, scaled by strength; every OTHER bar stays at full
      // strength AND the raw true EV (ev = modelP·odds − 1) must be strictly
      // positive — the owner's explicit value floor.
      const patternEligible =
        patternMode !== "off" && patternBacked && patternStrength >= PATTERN_MIN_STRENGTH;
      const patternRelaxedBar = patternEligible
        ? blendGate.minAdjEdgeBlend * (1 - PATTERN_EDGE_RELAX_MAX * clampPattern01(patternStrength))
        : blendGate.minAdjEdgeBlend;
      const patternClassOk =
        patternEligible &&
        adjustedEdgeBlend! >= patternRelaxedBar &&
        (blendGate.minBlendEvPct === null || blendEV! >= blendGate.minBlendEvPct) &&
        (blendGate.maxOdds === null || odds <= blendGate.maxOdds) &&
        blendEV! >= evFloor &&
        ev > 0 && // HARD value floor: raw true EV at the offered price
        blendGateOk;
      if (patternClassOk && patternMode === "on") {
        return {
          ...base,
          outcome: "done",
          confidence: patternConfidence(
            patternStrength,
            v3ConfidenceBlend(cls, adjustedEdgeBlend!, blendEV!, blendGate)
          ),
          patternRelaxed: "passed",
          patternRelaxedBar,
        };
      }

      // [X-carveout] High-conviction Class X exception — see
      // X_CARVEOUT_PENALTY_RESCALE's header for the derivation. Reached only
      // when !heightened (the heightened X-exclusion returned above), AFTER
      // the raw caps/noise gates (untouched), and re-checks every standard X
      // bar EXCEPT the edge floor, which it re-evaluates with the raw-space
      // penalty rescaled into blend-space units. Data-quality conviction
      // (real xG + completeness) is required on top.
      // The rescaled-penalty edge the carve-out evaluates — and, for admitted
      // picks, the edge downstream staking/ranking must use: the standard
      // adjustedEdgeBlend is ≤ −0.002 for every X candidate by construction
      // (that's the unreachability this flag exists to bypass), so staking off
      // it would zero-Kelly and bottom-rank every admitted pick.
      const adjustedEdgeCarveout = rawEdgeBlend! - penaltyPts * X_CARVEOUT_PENALTY_RESCALE;
      const carveoutQualifies =
        cls === "X" &&
        xCarveout !== "off" &&
        blendGateOk &&
        (blendGate.maxOdds === null || odds <= blendGate.maxOdds) &&
        blendGate.minBlendEvPct !== null &&
        blendEV! >= blendGate.minBlendEvPct &&
        blendEV! >= evFloor &&
        (opts.hasRealXg ?? false) &&
        (opts.completeness ?? 0) >= X_CARVEOUT_MIN_COMPLETENESS &&
        adjustedEdgeCarveout >= blendGate.minAdjEdgeBlend;
      if (carveoutQualifies && xCarveout === "on") {
        // Confidence pinned to the floor band — a carve-out pass is by
        // construction right at the (rescaled) gate floor, never banded up.
        return {
          ...base,
          outcome: "done",
          confidence: "medium",
          xCarveout: "passed",
          adjustedEdgeCarveout,
        };
      }
      let gateReason: V3AllGateReason;
      if (adjustedEdgeBlend! < blendGate.minAdjEdgeBlend) gateReason = "class_edge";
      else if (blendGate.minBlendEvPct !== null && blendEV! < blendGate.minBlendEvPct)
        gateReason = "class_evpct";
      else if (blendGate.maxOdds !== null && odds > blendGate.maxOdds) gateReason = "max_odds";
      else if (blendEV! < evFloor) gateReason = "ev_floor";
      else gateReason = "model_hot_longshot"; // classOk but blendGateOk failed
      return {
        ...base,
        outcome: "below_gate",
        confidence: null,
        gateReason,
        // shadow_pass also carries the counterfactual edge so ledger analysis
        // can see what an admitted pick WOULD have staked/ranked on.
        ...(carveoutQualifies ? { xCarveout: "shadow_pass" as const, adjustedEdgeCarveout } : {}),
        // [patterns-engine Wave 2] shadow mode: would-admit under the relaxed
        // bar but the flag isn't "on", so the outcome stays below_gate; the
        // tag + bar are pool/ledger evidence only.
        ...(patternClassOk ? { patternRelaxed: "shadow_pass" as const, patternRelaxedBar } : {}),
      };
    }

    // [patterns-engine Wave 2] A standard blend pass that is ALSO pattern-backed
    // gets the same monotonic confidence boost (never lowers the standard band).
    // "on" only — shadow/off leave the standard band untouched.
    const stdBlendConf = v3ConfidenceBlend(cls, adjustedEdgeBlend!, blendEV!, blendGate);
    return {
      ...base,
      outcome: "done",
      confidence:
        patternBacked && patternMode === "on"
          ? patternConfidence(patternStrength, stdBlendConf)
          : stdBlendConf,
    };
  }

  const gateTable = heightened ? CLASS_GATE_HEIGHTENED : CLASS_GATE;
  const gate = gateTable[cls];
  if (gate === null) {
    return {
      ...base,
      outcome: "below_gate",
      confidence: null,
      gateReason: "heightened_x_excluded",
    };
  }

  const classOk =
    adjustedEdge >= gate.minAdjEdge &&
    (gate.minAdjEvPct === null || adjEvPct >= gate.minAdjEvPct) &&
    (gate.maxOdds === null || odds <= gate.maxOdds) &&
    ev >= evFloor;
  const passes = classOk && blendGateOk;

  if (!passes) {
    let gateReason: V3AllGateReason;
    if (adjustedEdge < gate.minAdjEdge) gateReason = "class_edge";
    else if (gate.minAdjEvPct !== null && adjEvPct < gate.minAdjEvPct) gateReason = "class_evpct";
    else if (gate.maxOdds !== null && odds > gate.maxOdds) gateReason = "max_odds";
    else if (ev < evFloor) gateReason = "ev_floor";
    else gateReason = "model_hot_longshot"; // classOk but blendGateOk failed
    return { ...base, outcome: "below_gate", confidence: null, gateReason };
  }

  return { ...base, outcome: "done", confidence: v3Confidence(cls, adjustedEdge, adjEvPct) };
}

/** §4.1 implied probability for one outcome.
 *  - `oppositeOdds` present (clean two-way pair) → additive de-vig.
 *  - `outcomeSetOdds` with ≥3 entries (DC legs, HSH, margin buckets) →
 *    normalise the full set: q_k = (1/o_k) / Σ(1/o_j).
 *  - Neither → q = 1/o (single price — harder, conservative bar). */
export function impliedQ(
  odds: number,
  oppositeOdds?: number | null,
  outcomeSetOdds?: number[] | null
): { q: number; devigged: boolean } | null {
  if (!odds || !Number.isFinite(odds) || odds <= 1) return null;
  if (oppositeOdds && Number.isFinite(oppositeOdds) && oppositeOdds > 1) {
    const pair = devigTwoWay(odds, oppositeOdds);
    if (pair) return { q: pair[0], devigged: true };
  }
  if (outcomeSetOdds && outcomeSetOdds.length >= 3) {
    const valid = outcomeSetOdds.filter((o) => Number.isFinite(o) && o > 1);
    if (valid.length === outcomeSetOdds.length) {
      const total = valid.reduce((s, o) => s + 1 / o, 0);
      if (total > 0) return { q: 1 / odds / total, devigged: true };
    }
  }
  return { q: 1 / odds, devigged: false };
}
