/** Shared context + result shape for the v3 probability engines (§3.3–§3.8).
 *  Built once per fixture by the orchestrator; engines are pure lookups over it. */

import type { Matrix } from "../../types.js";
import type { DualSplit } from "../split.js";

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
  };
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

/** §3.5 empirical blend: P_final = 0.7·model + 0.3·empirical. */
export const EMPIRICAL_BLEND_W = 0.3;

export function blendEmpirical(model: number, empirical: number | undefined): number {
  if (empirical === undefined || !Number.isFinite(empirical)) return model;
  const e = Math.min(1, Math.max(0, empirical));
  return model * (1 - EMPIRICAL_BLEND_W) + e * EMPIRICAL_BLEND_W;
}
