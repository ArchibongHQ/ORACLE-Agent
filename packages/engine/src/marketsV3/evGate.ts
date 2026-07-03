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

/** §5.4 relative cap: odds > 3.00 and Raw/q above this ⇒ capped. */
export const RELATIVE_CAP_ODDS_FLOOR = 3.0;
export const RELATIVE_CAP_RATIO = 0.4;
export const RELATIVE_CAP_RATIO_X = 0.3;

export type V3Confidence = "very_high" | "high" | "medium";
export type V3AllGateOutcome = "done" | "capped" | "noise" | "below_gate";

export interface V3AllMarketsAssessment {
  q: number;
  devigged: boolean;
  rawEdge: number;
  penaltyPts: number;
  adjustedEdge: number;
  /** Adjusted EV% = adjustedEdge / q (ROI proxy per unit staked). */
  adjEvPct: number;
  cls: V3MarketClass;
  outcome: V3AllGateOutcome;
  confidence: V3Confidence | null;
  /** Which §5.4 cap fired, when outcome === "capped". */
  capReason?: "absolute" | "relative";
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

/** Run the full Phase-5 gate for one selection. `modelP` must already be the
 *  conditional p′ where the market can push. */
export function gateAllMarkets(
  modelP: number,
  q: { q: number; devigged: boolean },
  odds: number,
  cls: V3MarketClass,
  flags: V3AllMarketsPenaltyFlags,
  opts: { edgeCap?: number; noiseGate?: number } = {}
): V3AllMarketsAssessment {
  const edgeCap = opts.edgeCap ?? V3_EDGE_CAP_DEFAULT;
  const noiseGate = opts.noiseGate ?? V3_NOISE_GATE_DEFAULT;

  const rawEdge = modelP - q.q;
  const penaltyPts = allMarketsPenaltyPts(flags);
  const adjustedEdge = rawEdge - penaltyPts;
  const adjEvPct = q.q > 0 ? adjustedEdge / q.q : 0;

  const base = { q: q.q, devigged: q.devigged, rawEdge, penaltyPts, adjustedEdge, adjEvPct, cls };

  if (rawEdge > edgeCap) {
    return { ...base, outcome: "capped", confidence: null, capReason: "absolute" };
  }
  const relRatio = cls === "X" ? RELATIVE_CAP_RATIO_X : RELATIVE_CAP_RATIO;
  if (odds > RELATIVE_CAP_ODDS_FLOOR && q.q > 0 && rawEdge / q.q > relRatio) {
    return { ...base, outcome: "capped", confidence: null, capReason: "relative" };
  }
  if (Math.abs(rawEdge) <= noiseGate) {
    return { ...base, outcome: "noise", confidence: null };
  }

  const gate = CLASS_GATE[cls];
  const passes =
    adjustedEdge >= gate.minAdjEdge &&
    (gate.minAdjEvPct === null || adjEvPct >= gate.minAdjEvPct) &&
    (gate.maxOdds === null || odds <= gate.maxOdds);
  if (!passes) return { ...base, outcome: "below_gate", confidence: null };

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
    const inv = 1 / odds + 1 / oppositeOdds;
    const margin = inv - 1;
    return { q: 1 / odds - margin / 2, devigged: true };
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
