/** goals-market-analysis-prompt-v3 Phase 4 — market edge (the gate).
 *
 *  q_implied: de-vig the Over/Under pair when both sides are priced (additive
 *  method ≡ Shin for two-way books — see markets/devig.ts); single-sided books
 *  use q = 1/odds, a deliberately harder bar since it still contains margin.
 *
 *  Raw Edge      = P_model − q_implied
 *  Adjusted Edge = Raw Edge − data-quality penalties (§4.2 table)
 *
 *  Gates, in order (§4.3–§4.4):
 *    1. Implausible-edge cap: raw edge > 12 pts pre-penalty ⇒ auto-discard the
 *       selection ("model too hot to trust") — logged, never bet; the caller
 *       falls back to the fixture's next-best market under the cap.
 *    2. Noise gate: |P_model − q| ≤ 2 pts ⇒ discard regardless.
 *    3. Tier table on adjusted edge: ≥10 Very High · 7–10 High · 5–7 Medium ·
 *       <5 discard.
 *
 *  Pure math, no I/O. */

import { devigTwoWay } from "../markets/index.js";

/** §4.2 data-quality penalty flags. All penalties are expressed in probability
 *  points (0.01 = 1 pt). `xgEstimated` is the plan-adopted extension for
 *  AI-Mode-sourced xG: −1 pt, between "have real xG" (0) and "missing" (−2).
 *  PR-2 v4 deltas: `hfaDefaultUsed` and `hitRateMissing`. */
export interface V3PenaltyFlags {
  xgMissing?: boolean;
  xgEstimated?: boolean;
  h2hMissing?: boolean;
  lineupsUnconfirmed?: boolean;
  restEstimated?: boolean;
  /** Model built on < 5 games of data. */
  smallSample?: boolean;
  /** HFA default (1.10) used instead of venue-split data (PR-2 v4). */
  hfaDefaultUsed?: boolean;
  /** Hit-rate missing for the evaluated line (PR-4 v4 wiring, applied PR-4). */
  hitRateMissing?: boolean;
}

export const V3_PENALTY_PTS: Record<keyof V3PenaltyFlags, number> = {
  xgMissing: 0.02,
  xgEstimated: 0.01,
  h2hMissing: 0.01,
  lineupsUnconfirmed: 0.01,
  restEstimated: 0.01,
  smallSample: 0.02,
  hfaDefaultUsed: 0.01,
  hitRateMissing: 0.01,
};

export const V3_EDGE_CAP_DEFAULT = 0.12;
export const V3_NOISE_GATE_DEFAULT = 0.02;
/** §4.3 tier bounds on ADJUSTED edge. */
export const V3_TIER_MEDIUM = 0.05;
export const V3_TIER_HIGH = 0.07;
export const V3_TIER_VERY_HIGH = 0.1;

export type V3Tier = "very_high" | "high" | "medium";
export type V3GateOutcome = "done" | "capped" | "noise" | "below_edge";

export interface V3EdgeAssessment {
  q: number;
  /** True when q came from a de-vigged two-sided book (fair); false = 1/odds. */
  devigged: boolean;
  rawEdge: number;
  penaltyPts: number;
  adjustedEdge: number;
  tier: V3Tier | null;
  outcome: V3GateOutcome;
}

/** Implied probability for one side of an O/U-style two-way book (§4.1). */
export function devigOU(
  odds: number,
  oppositeOdds?: number | null
): { q: number; devigged: boolean } | null {
  if (!odds || !Number.isFinite(odds) || odds <= 1) return null;
  if (oppositeOdds && Number.isFinite(oppositeOdds) && oppositeOdds > 1) {
    const pair = devigTwoWay(odds, oppositeOdds);
    if (pair) return { q: pair[0], devigged: true };
  }
  return { q: 1 / odds, devigged: false };
}

/** Sum the §4.2 penalty table over the set flags. */
export function v3PenaltyPts(flags: V3PenaltyFlags): number {
  let pts = 0;
  for (const key of Object.keys(V3_PENALTY_PTS) as Array<keyof V3PenaltyFlags>) {
    if (flags[key]) pts += V3_PENALTY_PTS[key];
  }
  return pts;
}

export function v3Tier(adjustedEdge: number): V3Tier | null {
  if (adjustedEdge >= V3_TIER_VERY_HIGH) return "very_high";
  if (adjustedEdge >= V3_TIER_HIGH) return "high";
  if (adjustedEdge >= V3_TIER_MEDIUM) return "medium";
  return null;
}

/** Run the full Phase-4 gate for one selection. */
export function gateV3Edge(
  modelP: number,
  q: { q: number; devigged: boolean },
  flags: V3PenaltyFlags,
  opts: { edgeCap?: number; noiseGate?: number } = {}
): V3EdgeAssessment {
  const edgeCap = opts.edgeCap ?? V3_EDGE_CAP_DEFAULT;
  const noiseGate = opts.noiseGate ?? V3_NOISE_GATE_DEFAULT;

  const rawEdge = modelP - q.q;
  const penaltyPts = v3PenaltyPts(flags);
  const adjustedEdge = rawEdge - penaltyPts;

  let outcome: V3GateOutcome;
  let tier: V3Tier | null = null;
  if (rawEdge > edgeCap) {
    outcome = "capped"; // §4.4 — model too hot to trust, never bet
  } else if (Math.abs(rawEdge) <= noiseGate) {
    outcome = "noise"; // §4.3 — within noise of the market, not edge
  } else {
    tier = v3Tier(adjustedEdge);
    outcome = tier ? "done" : "below_edge";
  }
  return { q: q.q, devigged: q.devigged, rawEdge, penaltyPts, adjustedEdge, tier, outcome };
}
