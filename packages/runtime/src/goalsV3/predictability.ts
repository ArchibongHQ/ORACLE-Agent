/** goals-market-analysis-prompt-v3 Phase 2 — predictability score.
 *
 *  Sets the ORDER in which fixtures are analysed; it never decides a bet. The
 *  v3 rubric verbatim (0–100):
 *    Home favourite (1X2 < 1.60)                                +20
 *    League avg goals > 2.8                                     +15
 *    Defensive mismatch (one concedes >1.5 while other scores >1.5) +20
 *    Attacking mismatch (both score >1.5)                       +15
 *    Form streak (3+ consecutive W or L either side)            +10
 *    H2H trend (≥2 of last 3 went Over 2.5)                     +10
 *    Congestion (≤3 days rest either side)                      +10
 *
 *  Ties break on completeness (better-documented fixture first). The legacy
 *  scoreGoalsPotential stays on the legacy path only — the lean v3 path
 *  analyses every eligible fixture, so this score is purely cosmetic ordering
 *  for logs/reports and deterministic output stability.
 *
 *  Pure, synchronous, no I/O. */

import { v3LeaguePerTeamAvg } from "@oracle/engine";
import type { SportyBetEvent } from "../selectFixtures.js";

/** v3 §2 rubric. Returns 0–100. */
export function scorePredictabilityV3(event: SportyBetEvent): number {
  const detail = event.detail;
  const stats = detail?.stats;
  let score = 0;

  const homeOdds = detail?.odds?.["1x2"]?.home;
  if (typeof homeOdds === "number" && homeOdds > 1 && homeOdds < 1.6) score += 20;

  const leagueGpg = v3LeaguePerTeamAvg(event.league ?? "") * 2;
  if (leagueGpg > 2.8) score += 15;

  const g = stats?.goals;
  const hs = g?.home?.avg_scored;
  const hc = g?.home?.avg_conceded;
  const as_ = g?.away?.avg_scored;
  const ac = g?.away?.avg_conceded;
  const defMismatch =
    (typeof hc === "number" && hc > 1.5 && typeof as_ === "number" && as_ > 1.5) ||
    (typeof ac === "number" && ac > 1.5 && typeof hs === "number" && hs > 1.5);
  if (defMismatch) score += 20;
  if (typeof hs === "number" && hs > 1.5 && typeof as_ === "number" && as_ > 1.5) score += 15;

  const hStreak = stats?.form?.home?.streak;
  const aStreak = stats?.form?.away?.streak;
  if (
    (typeof hStreak === "number" && Math.abs(hStreak) >= 3) ||
    (typeof aStreak === "number" && Math.abs(aStreak) >= 3)
  ) {
    score += 10;
  }

  const h2hMatches = stats?.h2h?.matches ?? [];
  const last3 = h2hMatches.slice(0, 3);
  const overs = last3.filter(
    (m) =>
      typeof m.home_goals === "number" &&
      typeof m.away_goals === "number" &&
      m.home_goals + m.away_goals >= 3
  ).length;
  if (last3.length >= 2 && overs >= 2) score += 10;

  const hRest = stats?.congestion?.home?.rest_days;
  const aRest = stats?.congestion?.away?.rest_days;
  if ((typeof hRest === "number" && hRest <= 3) || (typeof aRest === "number" && aRest <= 3)) {
    score += 10;
  }

  return score;
}

/** Sort comparator: predictability desc, completeness desc as tiebreak. */
export function byPredictabilityV3<T>(
  scoreOf: (item: T) => number,
  completenessOf: (item: T) => number
): (a: T, b: T) => number {
  return (a, b) => scoreOf(b) - scoreOf(a) || completenessOf(b) - completenessOf(a);
}
