/** all-markets-analysis-prompt-v3 §2 — prioritisation score.
 *
 *  Processing-order ONLY — never a bet signal (the score never touches the
 *  EV gate or a probability). Legacy criteria retained + market-depth
 *  addition: home favourite <1.60 (+20) · league avg >2.8 (+15) · defensive
 *  mismatch (+20) · attacking mismatch (+15) · 3+ streak (+10) · H2H overs
 *  trend (+10) · congestion ≤3 days (+10) · market depth ≥3 mapped families
 *  with usable stats (+10). Descending order, chunks of 8–10.
 *
 *  Pure math, no I/O. */

export interface V3PriorityInput {
  homeOdds?: number | null;
  leagueAvgGoals?: number | null;
  /** |home net xG − away net xG| style mismatch signal, pre-computed by the
   *  caller (net = scored − conceded per game); large gap ⇒ defensive OR
   *  attacking mismatch depending on direction — both scored the same here
   *  since the spec doesn't distinguish which side is stronger, only that a
   *  clear mismatch exists. */
  defensiveMismatch?: boolean;
  attackingMismatch?: boolean;
  /** Either side's leading streak length (win or loss), signed magnitude. */
  streakLength?: number | null;
  h2hOversTrend?: boolean;
  restDaysMin?: number | null;
  /** Count of mapped market families with usable stats for this fixture. */
  mappedFamiliesWithStats?: number;
}

export const V3_PRIORITY_WEIGHTS = {
  homeFavourite: 20,
  highLeagueAvg: 15,
  defensiveMismatch: 20,
  attackingMismatch: 15,
  streak: 10,
  h2hOvers: 10,
  congestion: 10,
  marketDepth: 10,
} as const;

export const HOME_FAVOURITE_MAX_ODDS = 1.6;
export const HIGH_LEAGUE_AVG_MIN = 2.8;
export const STREAK_MIN = 3;
export const CONGESTION_MAX_DAYS = 3;
export const MARKET_DEPTH_MIN = 3;

export function scoreV3Priority(input: V3PriorityInput): number {
  let score = 0;
  if (
    typeof input.homeOdds === "number" &&
    Number.isFinite(input.homeOdds) &&
    input.homeOdds < HOME_FAVOURITE_MAX_ODDS
  ) {
    score += V3_PRIORITY_WEIGHTS.homeFavourite;
  }
  if (
    typeof input.leagueAvgGoals === "number" &&
    Number.isFinite(input.leagueAvgGoals) &&
    input.leagueAvgGoals > HIGH_LEAGUE_AVG_MIN
  ) {
    score += V3_PRIORITY_WEIGHTS.highLeagueAvg;
  }
  if (input.defensiveMismatch) score += V3_PRIORITY_WEIGHTS.defensiveMismatch;
  if (input.attackingMismatch) score += V3_PRIORITY_WEIGHTS.attackingMismatch;
  if (
    typeof input.streakLength === "number" &&
    Number.isFinite(input.streakLength) &&
    Math.abs(input.streakLength) >= STREAK_MIN
  ) {
    score += V3_PRIORITY_WEIGHTS.streak;
  }
  if (input.h2hOversTrend) score += V3_PRIORITY_WEIGHTS.h2hOvers;
  if (
    typeof input.restDaysMin === "number" &&
    Number.isFinite(input.restDaysMin) &&
    input.restDaysMin <= CONGESTION_MAX_DAYS
  ) {
    score += V3_PRIORITY_WEIGHTS.congestion;
  }
  if ((input.mappedFamiliesWithStats ?? 0) >= MARKET_DEPTH_MIN) {
    score += V3_PRIORITY_WEIGHTS.marketDepth;
  }
  return score;
}

/** Sort descending by priority score (stable — ties keep input order). */
export function sortByV3Priority<T>(items: T[], score: (item: T) => number): T[] {
  return items
    .map((item, idx) => ({ item, idx, s: score(item) }))
    .sort((a, b) => b.s - a.s || a.idx - b.idx)
    .map((x) => x.item);
}

/** §2 processing chunk size: 8–10. */
export const V3_CHUNK_SIZE = 10;

export function chunkV3<T>(items: T[], size: number = V3_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
