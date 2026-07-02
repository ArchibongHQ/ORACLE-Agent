/** goals-market-analysis-prompt-v3 §3.5 — match-shape correction (MANDATORY for
 *  BTTS and team totals in lopsided games).
 *
 *  Independent Poisson on the raw λ split overstates "both teams score" when one
 *  side is a clear favourite: goals concentrate on the favourite and the underdog
 *  blanks more often than season averages imply. The TOTAL μ from the goals model
 *  is kept (Over/Under markets are untouched); only the home/away SPLIT is
 *  re-derived from the de-vigged 1X2 odds:
 *
 *  Grid-search the home share s ∈ (0.05, 0.95): set λH = μ·s, λA = μ·(1−s),
 *  compute independent-Poisson P(home win)/P(away win) over a 0–10 score grid,
 *  and pick the s whose win probabilities best match the de-vigged 1X2. Clamp so
 *  neither λ falls below 0.30 (a heavy underdog still scores in ~25–30% of
 *  matches). Pure math, no I/O. */

import { poissonPMF } from "../math/index.js";

export interface Devigged1x2 {
  pHome: number;
  pDraw: number;
  pAway: number;
}

export interface MatchShape {
  lambdaHome: number;
  lambdaAway: number;
  /** Home share of μ actually used (post-clamp). */
  s: number;
  /** "odds" when the grid search ran; "ratio" when 1X2 was missing/degenerate
   *  and the goals-model split was kept as-is. */
  source: "odds" | "ratio";
}

const S_MIN = 0.05;
const S_MAX = 0.95;
const S_STEP = 0.01;
const GRID_GOALS = 11; // 0–10 per spec
/** §3.5 clamp: neither side's λ may fall below this. */
export const SHAPE_LAMBDA_FLOOR = 0.3;

/** Independent-Poisson win probabilities for a given λ split over a 0–10 grid. */
function winProbs(lH: number, lA: number): { pHome: number; pAway: number } {
  const pmfH: number[] = [];
  const pmfA: number[] = [];
  for (let k = 0; k < GRID_GOALS; k++) {
    pmfH.push(poissonPMF(k, lH));
    pmfA.push(poissonPMF(k, lA));
  }
  let pHome = 0;
  let pAway = 0;
  for (let i = 0; i < GRID_GOALS; i++) {
    for (let j = 0; j < GRID_GOALS; j++) {
      const p = pmfH[i] * pmfA[j];
      if (i > j) pHome += p;
      else if (j > i) pAway += p;
    }
  }
  return { pHome, pAway };
}

function validProb(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1;
}

/** Derive the odds-consistent λ split for BTTS/team-total pricing.
 *
 *  Fallback (spec-silent case, resolved in plan review): when the de-vigged 1X2
 *  is missing or degenerate, keep the goals model's own split
 *  (s = λH_raw / μ) — the correction is then a no-op rather than a guess. */
export function deriveMatchShape(
  mu: number,
  rawLambdaHome: number,
  devigged: Devigged1x2 | null | undefined
): MatchShape {
  const safeMu = Math.max(0.1, mu);
  const ratioS = Math.min(S_MAX, Math.max(S_MIN, rawLambdaHome / safeMu));

  const usable =
    devigged && validProb(devigged.pHome) && validProb(devigged.pDraw) && validProb(devigged.pAway);

  let s = ratioS;
  let source: MatchShape["source"] = "ratio";
  if (usable) {
    let bestErr = Number.POSITIVE_INFINITY;
    let bestS = ratioS;
    for (let cand = S_MIN; cand <= S_MAX + 1e-9; cand += S_STEP) {
      const { pHome, pAway } = winProbs(safeMu * cand, safeMu * (1 - cand));
      const err = (pHome - devigged.pHome) ** 2 + (pAway - devigged.pAway) ** 2;
      if (err < bestErr) {
        bestErr = err;
        bestS = cand;
      }
    }
    s = bestS;
    source = "odds";
  }

  // §3.5 clamp: neither λ below 0.30, μ preserved. Only possible when μ > 0.60;
  // below that both sides can't clear the floor, so split μ proportionally.
  let lH = safeMu * s;
  let lA = safeMu * (1 - s);
  if (safeMu > 2 * SHAPE_LAMBDA_FLOOR) {
    if (lH < SHAPE_LAMBDA_FLOOR) {
      lH = SHAPE_LAMBDA_FLOOR;
      lA = safeMu - SHAPE_LAMBDA_FLOOR;
    } else if (lA < SHAPE_LAMBDA_FLOOR) {
      lA = SHAPE_LAMBDA_FLOOR;
      lH = safeMu - SHAPE_LAMBDA_FLOOR;
    }
  }
  return { lambdaHome: lH, lambdaAway: lA, s: lH / safeMu, source };
}
