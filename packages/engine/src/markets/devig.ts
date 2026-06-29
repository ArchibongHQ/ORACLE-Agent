/** Additive devig: strips bookmaker margin from a set of decimal odds covering
 *  one mutually-exclusive market, returning fair probabilities that sum to 1.
 *
 *  Method choice (researched, not assumed — see workflows/ for citations):
 *  multiplicative (proportional) scaling is the textbook-simple approach but is
 *  consistently the weakest predictor in empirical comparisons against real
 *  bookmaker data, because it spreads the margin in proportion to each side's
 *  implied probability — which bakes in the assumption that the bookmaker's
 *  margin is evenly *proportional* rather than concentrated against longshots.
 *  Real markets (including 2024-2026 top-5-league football data) show a
 *  favourite-longshot bias: short-priced favourites are underpriced (true rate
 *  exceeds implied) and longshots are overpriced (true rate below implied) —
 *  the opposite of what proportional scaling assumes. The additive method
 *  (subtract an equal share of the margin from each side, in probability
 *  space) corrects for this and is mathematically identical to the Shin (1993)
 *  method for exactly two-way markets — Shin's iterative solver only diverges
 *  from additive once a market has 3+ outcomes with skewed odds. Since BTTS
 *  and DNB (the only markets wired to devig today) are pure two-way books,
 *  additive gets Shin-grade accuracy with O(1) arithmetic, no iteration. */

/** Devig a 2-way market via the additive method. Returns [fairProbA, fairProbB]
 *  summing to 1. Either leg missing/invalid (<=1) returns undefined. */
export function devigTwoWay(
  oddsA: number | undefined,
  oddsB: number | undefined
): [number, number] | undefined {
  if (!oddsA || !oddsB || oddsA <= 1 || oddsB <= 1) return undefined;
  const pA = 1 / oddsA;
  const pB = 1 / oddsB;
  const margin = pA + pB - 1;
  const half = margin / 2;
  return [pA - half, pB - half];
}

/** Devig a 3-way market (e.g. 1X2) via the additive method. Returns
 *  [fairHome, fairDraw, fairAway] summing to 1. Any missing/invalid leg
 *  returns undefined.
 *
 *  Note: for 3-way markets, additive is a simpler approximation of Shin, not
 *  an exact equivalent — it's used here only as a fallback when synthesizing
 *  1X2 from DNB (see sidecarOdds.ts), where the alternative is no fair-price
 *  signal at all, not a choice between additive and a more accurate method
 *  already in place. */
export function devigThreeWay(
  oddsHome: number | undefined,
  oddsDraw: number | undefined,
  oddsAway: number | undefined
): [number, number, number] | undefined {
  if (!oddsHome || !oddsDraw || !oddsAway || oddsHome <= 1 || oddsDraw <= 1 || oddsAway <= 1) {
    return undefined;
  }
  const pH = 1 / oddsHome;
  const pD = 1 / oddsDraw;
  const pA = 1 / oddsAway;
  const margin = pH + pD + pA - 1;
  const third = margin / 3;
  return [pH - third, pD - third, pA - third];
}
