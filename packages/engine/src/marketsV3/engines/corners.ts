/** §3.9 — corners module (Negative Binomial), dormant unless BOTH the odds
 *  AND the supporting stats exist.
 *
 *  Corner counts are overdispersed relative to Poisson (variance exceeds the
 *  mean in real match data), so the spec models total and team corners as
 *  Negative Binomial with dispersion r ≈ 8–12 rather than plain Poisson.
 *  Priority lines per the mandate: alt totals O6.5/7.5, U12.5/13.5, team
 *  O2.5 — this module prices any line the feed offers, not just those.
 *
 *  PR-22: 1X2/handicap/range/odd-even/team-total variants (catalog ids
 *  162/165/169-172/900300-900301 "Corners 1X2"/"Corner Handicap"/"Corner
 *  Range"/team ranges/"Odd/Even Corners"/team totals) — built on a joint
 *  home×away grid (independent NB marginals; no documented correlation term
 *  for corners the way Dixon-Coles has one for goals) and priced with the
 *  SAME generic resultProbs/winPushSplit/sumWhere helpers the goals result
 *  engine already uses, since those are Matrix-generic, not goals-specific.
 *
 *  Pure math, no I/O. */

import type { Matrix } from "../../types.js";
import { resultProbs, sumWhere, winPushSplit } from "../grid.js";

export const CORNERS_R_MIN = 8;
export const CORNERS_R_MAX = 12;
export const CORNERS_R_DEFAULT = 10;

export function clampCornersDispersion(r?: number | null): number {
  if (r == null || !Number.isFinite(r)) return CORNERS_R_DEFAULT;
  return Math.min(CORNERS_R_MAX, Math.max(CORNERS_R_MIN, r));
}

/** Lanczos approximation (g=7, n=9) — standard, widely-used log-gamma. */
const LANCZOS_G = 7;
const LANCZOS_COEF = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function lgamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula for small x (not needed for our non-negative-integer
    // inputs but kept for numerical safety).
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  const xx = x - 1;
  let a = LANCZOS_COEF[0]!;
  const t = xx + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) a += LANCZOS_COEF[i]! / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/** NB(mean, r) PMF at k, via log-space to avoid overflow at larger k. Mean
 *  floored at 0.01 (matches math/index.ts's poissonPMF convention) rather
 *  than short-circuiting to 0 at mean<=0 — the old `mean<=0 → 0` guard made
 *  nbPMF(0, 0, r) return 0 instead of ~1, which inverted every derived tail
 *  (nbCDF/nbTailOver/nbTailUnder): a team truly averaging 0 corners priced as
 *  ~100% "over any line" instead of ~100% "under," a review-caught bug fixed
 *  before it ever fired in production (season corner/shots averages are
 *  never literally 0.0, but a thin early-season sample could get close). */
export function nbPMF(k: number, mean: number, r: number): number {
  if (k < 0) return 0;
  const m = Math.max(0.01, mean);
  const p = r / (r + m);
  const logPmf = lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(p) + k * Math.log(1 - p);
  return Math.exp(logPmf);
}

/** P(X ≤ k). */
export function nbCDF(k: number, mean: number, r: number): number {
  if (k < 0) return 0;
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += nbPMF(i, mean, r);
  return Math.min(1, sum);
}

/** P(X > line) for a half-line (X.5); whole lines use the ceil/exclusive
 *  convention consistently with the totals engine's push-free half-line path
 *  (corners odds are conventionally quoted on half lines only). */
export function nbTailOver(line: number, mean: number, r: number): number {
  const kMax = Math.ceil(line) - 1; // largest integer ≤ line
  return 1 - nbCDF(kMax, mean, r);
}

export function nbTailUnder(line: number, mean: number, r: number): number {
  return 1 - nbTailOver(line, mean, r);
}

export interface V3CornersInput {
  cornersForH?: number;
  cornersForA?: number;
  cornersAgainstH?: number;
  cornersAgainstA?: number;
  dispersion?: number;
}

export interface V3CornersMeans {
  total: number;
  home: number;
  away: number;
  r: number;
}

function avgDefined(...vals: Array<number | undefined>): number | undefined {
  const nums = vals.filter((v): v is number => v != null && Number.isFinite(v));
  if (!nums.length) return undefined;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Blends each side's own corners-won average with the opponent-side's
 *  corners-conceded average (the same "attack vs opponent defense" pattern
 *  used elsewhere in the codebase) for a matchup-adjusted mean. Returns null
 *  when neither signal exists for a side — dormant, not a guess. */
export function cornersMeans(input: V3CornersInput): V3CornersMeans | null {
  const home = avgDefined(input.cornersForH, input.cornersAgainstA);
  const away = avgDefined(input.cornersForA, input.cornersAgainstH);
  if (home === undefined || away === undefined) return null;
  return { total: home + away, home, away, r: clampCornersDispersion(input.dispersion) };
}

/** Price "Over/Under X.5" (match total) or a team-total corners outcome.
 *  `side` selects which mean to use; undefined = match total. */
export function priceCornersOutcome(
  means: V3CornersMeans,
  desc: string,
  side?: "home" | "away"
): number | null {
  const m = desc
    .toLowerCase()
    .trim()
    .match(/^(over|under)\s*([\d.]+)$/);
  if (!m) return null;
  const line = Number.parseFloat(m[2]!);
  const mean = side === "home" ? means.home : side === "away" ? means.away : means.total;
  return m[1] === "over" ? nbTailOver(line, mean, means.r) : nbTailUnder(line, mean, means.r);
}

// ── PR-22: joint grid + 1X2/handicap/range/odd-even variants ────────────────

/** Generous — corner counts essentially never reach this; the tail bucket
 *  (index CORNERS_GRID_CAP) folds in whatever residual mass remains so each
 *  marginal still sums to 1. */
export const CORNERS_GRID_CAP = 25;

/** Independent NB(home) × NB(away) joint grid. Corners have no documented
 *  low-count correlation correction analogous to Dixon-Coles for goals, so
 *  independence is the defensible baseline here — not a compromise, the
 *  literature default. */
export function buildCornersGrid(means: V3CornersMeans, cap = CORNERS_GRID_CAP): Matrix {
  const homeVec: number[] = [];
  const awayVec: number[] = [];
  let homeCum = 0;
  let awayCum = 0;
  for (let k = 0; k < cap; k++) {
    const ph = nbPMF(k, means.home, means.r);
    const pa = nbPMF(k, means.away, means.r);
    homeVec.push(ph);
    awayVec.push(pa);
    homeCum += ph;
    awayCum += pa;
  }
  homeVec.push(Math.max(0, 1 - homeCum));
  awayVec.push(Math.max(0, 1 - awayCum));
  const grid: number[][] = [];
  for (let i = 0; i <= cap; i++) {
    const row: number[] = [];
    for (let j = 0; j <= cap; j++) row.push((homeVec[i] ?? 0) * (awayVec[j] ?? 0));
    grid.push(row);
  }
  return grid;
}

/** "home" / "draw" / "away" — who wins the corner count. */
function priceCorners1X2(grid: Matrix, d: string): number | null {
  const { pHome, pDraw, pAway } = resultProbs(grid);
  if (d === "home") return pHome;
  if (d === "draw") return pDraw;
  if (d === "away") return pAway;
  return null;
}

/** "Home (+1.5)" / "Away (-1.5)" / "Home -2.5" (Corner Handicap uses parens;
 *  Bookings Handicap — same parser, reused by cards.ts — does not). Asian
 *  lines only (no half-integer push case observed in the catalog; whole
 *  lines fall back to the conditional win/(1-push) form same as goals AH). */
export function priceCornersLikeHandicap(grid: Matrix, d: string): number | null {
  const m = d.match(/^(home|away)\s*\(?\s*([+-]?[\d.]+)\)?$/);
  if (!m) return null;
  const side = m[1] as "home" | "away";
  const line = Number.parseFloat(m[2]!);
  const { pWin, pPush } = winPushSplit(grid, (h, a) => (side === "home" ? h - a : a - h) + line);
  if (!Number.isInteger(line)) return pWin; // half line: no push possible
  const denom = 1 - pPush;
  return denom > 0 ? pWin / denom : 0;
}

/** "0-8" / "9-11" (closed range) or "12+" / "7+" (open-ended tail) over the
 *  MATCH total (side undefined) or one team's count (side set — team ranges
 *  use the same bucket text shape). */
export function priceCornersLikeRange(
  grid: Matrix,
  d: string,
  side?: "home" | "away"
): number | null {
  const m = d.match(/^(\d+)(?:\s*-\s*(\d+))?(\+)?$/);
  if (!m) return null;
  const lo = Number.parseInt(m[1]!, 10);
  const openEnded = m[3] === "+";
  const hi = m[2] ? Number.parseInt(m[2], 10) : lo;
  const val = (h: number, a: number) => (side === "home" ? h : side === "away" ? a : h + a);
  return sumWhere(grid, (h, a) => {
    const v = val(h, a);
    return openEnded ? v >= lo : v >= lo && v <= hi;
  });
}

/** "Odd" / "Even" — parity of the MATCH total. */
function priceCornersLikeOddEven(grid: Matrix, d: string): number | null {
  if (d === "odd") return sumWhere(grid, (h, a) => (h + a) % 2 === 1);
  if (d === "even") return sumWhere(grid, (h, a) => (h + a) % 2 === 0);
  return null;
}

/** PR-22 dispatcher: routes to the right corners pricer for the given
 *  variant. `variant` undefined (or "team-total") falls back to the original
 *  marginal-tail priceCornersOutcome (match-total O/U, or team O/U via
 *  `side`) — the pre-PR-22 behavior, unchanged. */
export function priceCornersVariant(
  means: V3CornersMeans,
  desc: string,
  variant?: "1x2" | "handicap" | "range" | "odd-even" | "team-total",
  side?: "home" | "away"
): number | null {
  switch (variant) {
    case "1x2":
      return priceCorners1X2(buildCornersGrid(means), desc);
    case "handicap":
      return priceCornersLikeHandicap(buildCornersGrid(means), desc);
    case "range":
      return priceCornersLikeRange(buildCornersGrid(means), desc, side);
    case "odd-even":
      return priceCornersLikeOddEven(buildCornersGrid(means), desc);
    default:
      return priceCornersOutcome(means, desc, side);
  }
}
