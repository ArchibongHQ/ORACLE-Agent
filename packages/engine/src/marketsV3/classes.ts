/** all-markets-analysis-prompt-v3 §4.2 — market classes (variance taxonomy).
 *
 *  | S — Insurance/short | odds ≤ 1.50, single-event, grid-robust |
 *  | M — Main            | 1.51–3.00, single-event                |
 *  | L — Long            | > 3.00, single-event                   |
 *  | X — Exotic          | any odds; multi-condition or scoreline-exact |
 *
 *  X is STRUCTURAL (per the spec's examples: Correct Score, HT/FT, all "&"
 *  combos, Multiscores, exact goals) — an exotic at short odds is still X and
 *  still pays the −5 class penalty; a single-event longshot above 8.00 stays L
 *  (the §5.4 relative cap handles implausible longshot edges, not the class).
 *
 *  Pure classification, no I/O. */

import type { MarketFamily } from "../markets/index.js";

export type V3MarketClass = "S" | "M" | "L" | "X";

/** Families that are structurally exotic (scoreline-exact or multi-condition)
 *  regardless of price. `specials`/`exotic` are catch-alls the feed dictionary
 *  mostly skips (player props etc.); anything from them that survives routing
 *  is by definition multi-condition. */
export const STRUCTURAL_X_FAMILIES: ReadonlySet<MarketFamily> = new Set<MarketFamily>([
  "correct_score",
  "exact_goals",
  "ht_ft",
  "combo",
  "specials",
  "exotic",
]);

export const CLASS_S_MAX_ODDS = 1.5;
export const CLASS_M_MAX_ODDS = 3.0;
export const CLASS_L_MAX_ODDS = 8.0;

export function classifyMarket(family: MarketFamily, odds: number): V3MarketClass {
  if (STRUCTURAL_X_FAMILIES.has(family)) return "X";
  if (odds <= CLASS_S_MAX_ODDS) return "S";
  if (odds <= CLASS_M_MAX_ODDS) return "M";
  return "L";
}

/** §7 tie-break order: lower-variance class wins. */
export const CLASS_ORDER: Record<V3MarketClass, number> = { S: 0, M: 1, L: 2, X: 3 };
