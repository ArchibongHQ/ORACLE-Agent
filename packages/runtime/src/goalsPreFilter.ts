/** Mechanical goals-opportunity pre-filter — stage 1 of the goals-discovery
 *  funnel (mechanical filter → Sonnet screen → Poisson engine → Opus arbiter →
 *  top-N cut). Cuts the full daily SportyBet pool (potentially 1000+ fixtures)
 *  down to a bounded candidate pool (~100-150) before the costlier Sonnet
 *  screening pass runs — same cost-bounding shape as FrugalGPT-style LLM
 *  cascading: cheap mechanical filter first, LLM only on the survivors.
 *
 *  Pure, synchronous, no I/O — same style as predictabilityScore() in
 *  selectFixtures.ts. Never excludes a fixture for lacking data; low/no-data
 *  fixtures sort to the bottom but remain in the pool (per explicit owner
 *  instruction — only the pool-size cap removes fixtures, not the score). */
import type { SportyBetEvent } from "./selectFixtures.js";
import { ORACLE_PRIORITY_LEAGUES } from "./selectFixtures.js";

/** Goals-rich leagues (2026 season-average goals/match research: Bundesliga 3.19,
 *  Eredivisie 3.12, Eliteserien 3.09, Swiss Super League 3.02, MLS 2.96, Chinese
 *  Super League 2.97, Scottish Premiership — all clear ~2.9+ vs a 2.71 global
 *  average across 29 leagues, 2022-2026). Checked before the general priority list. */
export const GOALS_RICH_LEAGUES: ReadonlySet<string> = new Set([
  "Bundesliga",
  "2. Bundesliga",
  "Eredivisie",
  "Eliteserien",
  "Swiss Super League",
  "MLS",
  "Chinese Super League",
  "Scottish Premiership",
  "Austrian Bundesliga",
  "Danish Superliga",
]);

export const DEFAULT_PRE_FILTER_POOL_SIZE = 130;

export interface GoalsPreFilterResult {
  event: SportyBetEvent;
  score: number;
  tier: "A" | "B" | "C";
}

/** League tier — checked in priority order. Tier A (goals-rich) wins over Tier B
 *  (senior/top/data-rich, e.g. top-5 European leagues + majors) even when a
 *  league happens to appear in both sets. */
function leagueTier(league: string | undefined): "A" | "B" | "C" {
  if (!league) return "C";
  if (GOALS_RICH_LEAGUES.has(league)) return "A";
  if (ORACLE_PRIORITY_LEAGUES.has(league)) return "B";
  return "C";
}

const TIER_SCORE: Record<"A" | "B" | "C", number> = { A: 40, B: 25, C: 10 };

/** Scores a fixture's goals-market opportunity, 0–100. Combines league tier with
 *  the data signals research confirms are the strongest O/U predictors short of
 *  shot-level xT/EPV (shots-on-target + corners outperform raw goals-count alone
 *  — see the LSE over/under profitability study). Missing data never zeroes the
 *  score to exclusion — it just forgoes that component's points. */
export function scoreGoalsPotential(event: SportyBetEvent): number {
  const stats = event.detail?.stats;
  let score = TIER_SCORE[leagueTier(event.league)];

  // Season O/U 2.5 hit-rate, both sides averaged (0–25 points; 100% hit rate → full).
  const overUnder = stats?.overunder;
  const homeOver25 = overUnder?.home?.over25_pct;
  const awayOver25 = overUnder?.away?.over25_pct;
  if (typeof homeOver25 === "number" || typeof awayOver25 === "number") {
    const vals = [homeOver25, awayOver25].filter((v): v is number => typeof v === "number");
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    score += Math.min(25, avg * 25);
  }

  // Shot volume + corners (possessionValue) — confirmed stronger O/U signal than
  // raw goals-count alone (0–20 points, normalized against a ~6 shots-on-target
  // + 5 corners/match reference band typical of an attacking team).
  const pv = stats?.possessionValue;
  const shotsOnTarget = [pv?.home?.shots_on_target_avg, pv?.away?.shots_on_target_avg].filter(
    (v): v is number => typeof v === "number"
  );
  const corners = [pv?.home?.corners_avg, pv?.away?.corners_avg].filter(
    (v): v is number => typeof v === "number"
  );
  if (shotsOnTarget.length > 0) {
    const avgShots = shotsOnTarget.reduce((a, b) => a + b, 0) / shotsOnTarget.length;
    score += Math.min(12, (avgShots / 6) * 12);
  }
  if (corners.length > 0) {
    const avgCorners = corners.reduce((a, b) => a + b, 0) / corners.length;
    score += Math.min(8, (avgCorners / 5) * 8);
  }

  // Direct season goals-scored average, both sides (0–15 points; 2.0+ goals/game
  // per side → full points).
  const goals = stats?.goals;
  const avgScored = [goals?.home?.avg_scored, goals?.away?.avg_scored].filter(
    (v): v is number => typeof v === "number"
  );
  if (avgScored.length > 0) {
    const avg = avgScored.reduce((a, b) => a + b, 0) / avgScored.length;
    score += Math.min(15, (avg / 2.0) * 15);
  }

  // Small data-presence confidence bonus (0–10) — more populated subtabs means
  // more confidence in the score above, but its absence never excludes a fixture.
  const subtabsPresent = [
    stats?.form,
    stats?.standings,
    stats?.goals,
    stats?.overunder,
    stats?.possessionValue,
  ].filter(Boolean).length;
  score += (subtabsPresent / 5) * 10;

  return Math.min(100, score);
}

/** Cuts the full daily SportyBet pool down to a bounded candidate pool, sorted
 *  by goals-opportunity score descending. Low/no-data fixtures sort lowest but
 *  are never excluded by the scoring itself — only the poolSize slice removes
 *  fixtures, exactly the ceiling-not-floor behavior selectGoalsAccumulator
 *  already uses for its own leg cap. */
export function preFilterGoalsCandidates(
  events: SportyBetEvent[],
  poolSize: number = DEFAULT_PRE_FILTER_POOL_SIZE
): GoalsPreFilterResult[] {
  const scored = events.map((event) => ({
    event,
    score: scoreGoalsPotential(event),
    tier: leagueTier(event.league),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, poolSize));
}
