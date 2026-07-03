/** all-markets-analysis-prompt-v3 §3.2 — the dual split (anti-circularity rule).
 *
 *  Two versions of the home/away split of μ = λH + λA:
 *
 *  - STATS split (straight from §3.1 lambdas) → RESULT-class markets (DC, DNB,
 *    handicaps, winning margin, HT/FT legs, half results, win-to-nil's win leg,
 *    correct score). Anchoring these to the market's own 1X2 would make their
 *    edge ≈ 0 by construction — the model would just re-quote the bookmaker.
 *  - ODDS-ANCHORED split (grid-search s so the grid's 1X2 matches the de-vigged
 *    1X2, λ ≥ 0.30 clamp — goalsV3 deriveMatchShape verbatim) → GOALS-SHAPE
 *    markets (BTTS, team totals, clean sheets, teams-to-score). There the
 *    anchor removes shape error while the total μ still carries the edge.
 *
 *  Cross-check: |Δ home share| > 0.15 ⇒ "shape disagreement" — result-class
 *  candidates take an extra −2 penalty (the market knows something the raw
 *  stats don't). Pure math, no I/O. */

import type { V3Lambdas } from "../goalsV3/lambda.js";
import { type Devigged1x2, deriveMatchShape, type MatchShape } from "../goalsV3/matchShape.js";

/** §3.2 disagreement threshold on the home-share delta. */
export const SHAPE_DISAGREEMENT_DELTA = 0.15;

export interface DualSplit {
  /** Stats-split lambdas (§3.1 verbatim) — result-class markets. */
  stats: { lambdaHome: number; lambdaAway: number };
  /** Odds-anchored lambdas (§3.5 machinery) — goals-shape markets. */
  odds: { lambdaHome: number; lambdaAway: number };
  /** Home share under each split (post-clamp). */
  statsShare: number;
  oddsShare: number;
  /** "odds" when the 1X2 anchor ran; "ratio" when it was missing/degenerate
   *  (the odds split then equals the stats split and disagreement is 0). */
  oddsSource: MatchShape["source"];
  /** |statsShare − oddsShare|. */
  shareDelta: number;
  /** True ⇒ −2 penalty on result-class candidates (§3.2 cross-check). */
  shapeDisagreement: boolean;
}

export function deriveDualSplit(
  lambdas: V3Lambdas,
  devigged1x2: Devigged1x2 | null | undefined
): DualSplit {
  const shape = deriveMatchShape(lambdas.mu, lambdas.lambdaHome, devigged1x2);
  const statsShare = lambdas.mu > 0 ? lambdas.lambdaHome / lambdas.mu : 0.5;
  const shareDelta = Math.abs(statsShare - shape.s);
  return {
    stats: { lambdaHome: lambdas.lambdaHome, lambdaAway: lambdas.lambdaAway },
    odds: { lambdaHome: shape.lambdaHome, lambdaAway: shape.lambdaAway },
    statsShare,
    oddsShare: shape.s,
    oddsSource: shape.source,
    shareDelta,
    shapeDisagreement: shape.source === "odds" && shareDelta > SHAPE_DISAGREEMENT_DELTA,
  };
}
