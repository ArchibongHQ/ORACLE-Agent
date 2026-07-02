/** all-markets-analysis-prompt-v3 §3.1 — the score grid and its cell-sum
 *  helpers. Every result, shape, margin, and exotic probability in the v3
 *  engine is a sum over cells of an independent-Poisson (Dixon–Coles-corrected
 *  at full time) score grid P(i,j), i,j = 0..10.
 *
 *  Pure math, no I/O. */

import { buildMatrix, poissonPMF } from "../math/index.js";
import type { Matrix } from "../types.js";

/** 0..10 per spec §3.1. */
export const V3_GRID_MAX_GOALS = 10;

/** Full-time grid: Dixon–Coles low-score correction kept (locked goalsV3 plan
 *  decision — DC strictly improves the 0-0/1-0/0-1/1-1 cells; exact tails are
 *  preserved). No ZIP layer, no Sarmanov. */
export function buildV3Grid(lambdaHome: number, lambdaAway: number, rho: number): Matrix {
  return buildMatrix(lambdaHome, lambdaAway, rho, false, 0.08, 0);
}

/** Half grid: plain independent Poisson (rho = 0) — the DC correction is a
 *  full-time low-score phenomenon and has no half-time calibration. */
export function buildV3HalfGrid(lambdaHome: number, lambdaAway: number): Matrix {
  return buildMatrix(lambdaHome, lambdaAway, 0, false, 0.08, 0);
}

/** Σ P(i,j) over cells satisfying the predicate. */
export function sumWhere(mat: Matrix, pred: (home: number, away: number) => boolean): number {
  let p = 0;
  for (let i = 0; i < mat.length; i++) {
    const row = mat[i];
    if (!row) continue;
    for (let j = 0; j < row.length; j++) {
      if (pred(i, j)) p += row[j] ?? 0;
    }
  }
  return p;
}

export interface ResultProbs {
  pHome: number;
  pDraw: number;
  pAway: number;
}

/** 1X2 read off the grid (§3.4). */
export function resultProbs(mat: Matrix): ResultProbs {
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  for (let i = 0; i < mat.length; i++) {
    const row = mat[i];
    if (!row) continue;
    for (let j = 0; j < row.length; j++) {
      const p = row[j] ?? 0;
      if (i > j) pHome += p;
      else if (i === j) pDraw += p;
      else pAway += p;
    }
  }
  return { pHome, pDraw, pAway };
}

/** Win/push split for a goal-difference condition (handicap engines). The
 *  `margin` passed to the predicate is home − away. */
export function winPushSplit(
  mat: Matrix,
  adjustedMargin: (home: number, away: number) => number
): { pWin: number; pPush: number } {
  let pWin = 0;
  let pPush = 0;
  const EPS = 0.01;
  for (let i = 0; i < mat.length; i++) {
    const row = mat[i];
    if (!row) continue;
    for (let j = 0; j < row.length; j++) {
      const p = row[j] ?? 0;
      if (!p) continue;
      const adj = adjustedMargin(i, j);
      if (adj > EPS) pWin += p;
      else if (Math.abs(adj) <= EPS) pPush += p;
    }
  }
  return { pWin, pPush };
}

/** Marginal PMF of one Poisson side over 0..V3_GRID_MAX_GOALS (half engines,
 *  HSH). Tail mass above the grid max is folded into the last bucket so the
 *  distribution sums to 1. */
export function poissonVector(lambda: number): number[] {
  const v: number[] = [];
  let cum = 0;
  for (let k = 0; k < V3_GRID_MAX_GOALS; k++) {
    const p = poissonPMF(k, lambda);
    v.push(p);
    cum += p;
  }
  v.push(Math.max(0, 1 - cum));
  return v;
}
