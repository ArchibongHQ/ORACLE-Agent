/** §3.7 — time engine (early-minutes markets).
 *
 *  Scoring is not uniform: early minutes carry disproportionately few goals.
 *  Cumulative share-of-FT-goals table (spec verbatim):
 *    0–10′: 8% · 0–15′: 13% · 0–30′: 29% · 0–45′: 44% · 0–50′: 52% ·
 *    0–60′: 61% · 0–75′: 79%.
 *  μ_[0,m] = share(m) × μ. Matched to the feed's `minsnr=M|total=X` /
 *  `minute=M|total=X` exactly — no interpolation for an off-table minute
 *  (nearest published cutoff wins; the spec table is not continuous). */

import { poissonPMF } from "../../math/index.js";
import type { V3Price } from "./types.js";

/** Cumulative share of full-time goals scored by minute m (spec §3.7 table). */
export const V3_MINUTE_SHARE_TABLE: Array<[number, number]> = [
  [10, 0.08],
  [15, 0.13],
  [30, 0.29],
  [45, 0.44],
  [50, 0.52],
  [60, 0.61],
  [75, 0.79],
];

/** Nearest published cutoff at or above `minute`; falls back to the highest
 *  entry when `minute` exceeds the table (still a valid early-goals window). */
export function minuteShare(minute: number): number | null {
  if (!Number.isFinite(minute) || minute <= 0) return null;
  let bestCutoff: number | null = null;
  let bestShare: number | null = null;
  for (const [m, share] of V3_MINUTE_SHARE_TABLE) {
    if (m >= minute && (bestCutoff === null || m < bestCutoff)) {
      bestCutoff = m;
      bestShare = share;
    }
  }
  if (bestShare !== null) return bestShare;
  // Beyond the table's last cutoff (75′): use the last known share as a floor.
  return V3_MINUTE_SHARE_TABLE[V3_MINUTE_SHARE_TABLE.length - 1]?.[1] ?? null;
}

/** Price an early-window Over/Under X.5 total-goals condition. Half-lines
 *  only (the table's granularity doesn't support push handling). */
export function priceTimeWindow(mu: number, minute: number, desc: string): V3Price | null {
  const share = minuteShare(minute);
  if (share === null) return null;
  const m = desc
    .toLowerCase()
    .trim()
    .match(/^(over|under)\s*([\d.]+)$/);
  if (!m) return null;
  const muWindow = share * mu;
  const line = Number.parseFloat(m[2]!);
  // Exact tail via cumulative Poisson (not a joint grid — home/away split has
  // no early-minute calibration; total-goals-in-window only).
  let pUnder = 0;
  const ceilLine = Math.ceil(line);
  for (let k = 0; k < ceilLine; k++) pUnder += poissonPMF(k, muWindow);
  return { p: m[1] === "over" ? 1 - pUnder : pUnder };
}
