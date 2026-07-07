/** §3.9 — cards module (Poisson), dormant unless BOTH the odds AND the
 *  supporting stats exist.
 *
 *  Total cards ~ Poisson(mean = sum of both teams' cards/game). Referee-
 *  adjustment is spec-mentioned but not modeled here — no referee stats are
 *  typed through the acquisition layer yet, and the spec treats it as
 *  optional ("if referee stats exist"). Priority line: match cards U5.5 (or
 *  the feed's nearest ceiling line) — this module prices any line offered.
 *
 *  PR-22: 1X2/handicap/range/odd-even/team-total variants (catalog ids
 *  136/139/142-144/900304-900305 "Bookings 1X2"/"Bookings - Over/Under"/
 *  "Exact Bookings"/team exact-bookings/team totals; "Bookings Handicap" id
 *  900312) — same joint-grid + generic grid-helper approach as corners.ts
 *  (independent Poisson(home) × Poisson(away), no correlation term). "Total
 *  Booking Points" (id 138, points-weighted not count-weighted) and
 *  "Sending Off"/team Sending Off (ids 146-148, red-card-specific — no
 *  red-card rate is tracked separately from the aggregate cards average)
 *  are deliberately NOT priced here — pricing them off the count-based
 *  Poisson mean would silently use the wrong unit/signal (Rule 0: skip,
 *  don't guess). feedDictionary.ts routes both to no-grid-model.
 *
 *  Pure math, no I/O. */

import { poissonPMF } from "../../math/index.js";
import type { Matrix } from "../../types.js";
import { resultProbs, sumWhere, winPushSplit } from "../grid.js";

export interface V3CardsInput {
  cardsAvgH?: number;
  cardsAvgA?: number;
}

export interface V3CardsMeans {
  total: number;
  home: number;
  away: number;
}

/** Returns null (dormant) when either side's cards average is missing. */
export function cardsMeans(input: V3CardsInput): V3CardsMeans | null {
  const { cardsAvgH: home, cardsAvgA: away } = input;
  if (home == null || away == null || !Number.isFinite(home) || !Number.isFinite(away)) return null;
  return { total: home + away, home, away };
}

function poissonTailOver(line: number, mean: number): number {
  const kMax = Math.ceil(line) - 1;
  let cdf = 0;
  for (let k = 0; k <= kMax; k++) cdf += poissonPMF(k, mean);
  return 1 - Math.min(1, cdf);
}

/** Price "Over/Under X.5" for the match total or one side's card total. */
export function priceCardsOutcome(
  means: V3CardsMeans,
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
  const over = poissonTailOver(line, mean);
  return m[1] === "over" ? over : 1 - over;
}

// ── PR-22: joint grid + 1X2/handicap/range/odd-even variants ────────────────
// Mirrors corners.ts's PR-22 additions exactly (independent-marginals joint
// grid, generic resultProbs/winPushSplit/sumWhere from grid.ts) with Poisson
// marginals in place of NB — see that file's header comment for the
// independence rationale (no documented low-count correlation for cards
// either, same as corners).

export const CARDS_GRID_CAP = 20;

export function buildCardsGrid(means: V3CardsMeans, cap = CARDS_GRID_CAP): Matrix {
  const homeVec: number[] = [];
  const awayVec: number[] = [];
  let homeCum = 0;
  let awayCum = 0;
  for (let k = 0; k < cap; k++) {
    const ph = poissonPMF(k, means.home);
    const pa = poissonPMF(k, means.away);
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

/** "home" / "draw" / "away" — who takes more cards. */
function priceCards1X2(grid: Matrix, d: string): number | null {
  const { pHome, pDraw, pAway } = resultProbs(grid);
  if (d === "home") return pHome;
  if (d === "draw") return pDraw;
  if (d === "away") return pAway;
  return null;
}

/** "Home -2.5" / "Away +2.5" (Bookings Handicap, no parens) — same parser as
 *  corners.ts's priceCornersLikeHandicap (which also accepts the paren
 *  form), reused directly since the math is identical over a different grid. */
export function priceCardsLikeHandicap(grid: Matrix, d: string): number | null {
  const m = d.match(/^(home|away)\s*\(?\s*([+-]?[\d.]+)\)?$/);
  if (!m) return null;
  const side = m[1] as "home" | "away";
  const line = Number.parseFloat(m[2]!);
  const { pWin, pPush } = winPushSplit(grid, (h, a) => (side === "home" ? h - a : a - h) + line);
  if (!Number.isInteger(line)) return pWin;
  const denom = 1 - pPush;
  return denom > 0 ? pWin / denom : 0;
}

/** "0-3" / "4" (single-value bucket, Exact Bookings) / "12+" (open tail) over
 *  the match total or one team's count. */
export function priceCardsLikeRange(
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

/** PR-22 dispatcher: mirrors priceCornersVariant. `variant` undefined (or
 *  "team-total") falls back to the pre-PR-22 marginal-tail priceCardsOutcome.
 *  Accepts the full V3Route variant union (including "odd-even", a
 *  corners-only shape with no cards market to route it — feedDictionary.ts
 *  never actually produces it for the cards engine) purely so callers can
 *  pass route.variant directly without a narrowing cast; falls through to
 *  the default (unchanged O/U) branch if it were ever reached. */
export function priceCardsVariant(
  means: V3CardsMeans,
  desc: string,
  variant?: "1x2" | "handicap" | "range" | "odd-even" | "team-total",
  side?: "home" | "away"
): number | null {
  switch (variant) {
    case "1x2":
      return priceCards1X2(buildCardsGrid(means), desc);
    case "handicap":
      return priceCardsLikeHandicap(buildCardsGrid(means), desc);
    case "range":
      return priceCardsLikeRange(buildCardsGrid(means), desc, side);
    default:
      return priceCardsOutcome(means, desc, side);
  }
}
