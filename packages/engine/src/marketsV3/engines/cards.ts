/** §3.9 — cards module (Poisson), dormant unless BOTH the odds AND the
 *  supporting stats exist.
 *
 *  Total cards ~ Poisson(mean = sum of both teams' cards/game). Referee-
 *  adjustment is spec-mentioned but not modeled here — no referee stats are
 *  typed through the acquisition layer yet, and the spec treats it as
 *  optional ("if referee stats exist"). Priority line: match cards U5.5 (or
 *  the feed's nearest ceiling line) — this module prices any line offered.
 *
 *  Pure math, no I/O. */

import { poissonPMF } from "../../math/index.js";

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
