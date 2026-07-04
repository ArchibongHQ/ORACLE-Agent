/** Shared context + result shape for the v3 probability engines (§3.3–§3.8).
 *  Built once per fixture by the orchestrator; engines are pure lookups over it. */

import type { Matrix } from "../../types.js";
import type { DualSplit } from "../split.js";
import type { V3CardsMeans } from "./cards.js";
import type { V3CornersMeans } from "./corners.js";

export interface V3EngineCtx {
  /** Full-time grid on the STATS split (§3.2) — result-class + totals (totals
   *  are split-invariant; μ is shared). */
  statsGrid: Matrix;
  /** Full-time grid on the ODDS-ANCHORED split (§3.2) — goals-shape markets. */
  shapeGrid: Matrix;
  mu: number;
  split: DualSplit;
  /** First-half goal share ρ (§3.6) and whether it fell back to the 0.44
   *  league default (⇒ −1 market-specific penalty on half markets). */
  fhShare: number;
  fhShareIsDefault: boolean;
  /** Half grids: [0] = 1H, [1] = 2H — stats split for result-type, odds split
   *  for shape-type half markets. Plain Poisson (no DC) per §3.6. */
  halfStats: [Matrix, Matrix];
  halfShape: [Matrix, Matrix];
  /** §3.5 empirical blend inputs (0..1 season rates), when typed through. */
  empirical: {
    bttsPctH?: number;
    bttsPctA?: number;
    csPctH?: number;
    csPctA?: number;
    ftsPctH?: number;
    ftsPctA?: number;
    /** Sample size (match count, capped at 5 by the recentGoals source) behind
     *  each side's empirical rates above — feeds blendEmpirical's sample-scaled
     *  weight (PR-3). */
    nH?: number;
    nA?: number;
    /** Season O/U hit-rates (0..1), venue split — feeds the totals engine's
     *  per-line marketStatMissing flag (PR-4), not blended into pricing. */
    ou15PctH?: number;
    ou15PctA?: number;
    ou25PctH?: number;
    ou25PctA?: number;
    ou35PctH?: number;
    ou35PctA?: number;
  };
  /** §3.9 conditional modules (PR-6) — null is the explicit dormant state
   *  (stats missing, or ORACLE_V3_CORNERS_CARDS=off withheld them upstream). */
  corners: V3CornersMeans | null;
  cards: V3CardsMeans | null;
}

export interface V3Price {
  p: number;
  /** True when p is the conditional p′ (push mass removed) — §3.3/§3.4. */
  conditional?: boolean;
  /** §5.3 market-specific stat missing (league-default ρ; shape market without
   *  its hit-rate). */
  marketStatMissing?: boolean;
  /** Result-class candidate — the §3.2 shape-disagreement penalty applies. */
  resultClass?: boolean;
}

/** §3.5 empirical blend: P_final = (1-w)·model + w·empirical.
 *  w = EMPIRICAL_BLEND_W by default; when a sample size `n` is supplied
 *  (PR-3, sample-scaled), w = EMPIRICAL_BLEND_W × min(n,5)/5 — a thin recent
 *  sample earns less trust. n omitted or ≥5 (the common case — recentGoals is
 *  a last-5 window) reproduces the original flat 0.3 weight exactly. */
export const EMPIRICAL_BLEND_W = 0.3;
export const EMPIRICAL_BLEND_N_CAP = 5;

export function blendEmpirical(model: number, empirical: number | undefined, n?: number): number {
  if (empirical === undefined || !Number.isFinite(empirical)) return model;
  const e = Math.min(1, Math.max(0, empirical));
  const w =
    n !== undefined && Number.isFinite(n)
      ? EMPIRICAL_BLEND_W *
        (Math.min(Math.max(n, 0), EMPIRICAL_BLEND_N_CAP) / EMPIRICAL_BLEND_N_CAP)
      : EMPIRICAL_BLEND_W;
  return model * (1 - w) + e * w;
}
