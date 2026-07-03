/** §3.9 — corners module (Negative Binomial), dormant unless BOTH the odds
 *  AND the supporting stats exist.
 *
 *  Corner counts are overdispersed relative to Poisson (variance exceeds the
 *  mean in real match data), so the spec models total and team corners as
 *  Negative Binomial with dispersion r ≈ 8–12 rather than plain Poisson.
 *  Priority lines per the mandate: alt totals O6.5/7.5, U12.5/13.5, team
 *  O2.5 — this module prices any line the feed offers, not just those.
 *
 *  Pure math, no I/O. */

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

/** NB(mean, r) PMF at k, via log-space to avoid overflow at larger k. */
export function nbPMF(k: number, mean: number, r: number): number {
  if (k < 0 || mean <= 0) return 0;
  const p = r / (r + mean);
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
