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

/** Goals-rich leagues (Tier A — 2.9+ goals/match average, 2022-2026 research).
 *  Sources: FBref, Transfermarkt, SoccerSTATS seasonal averages cross-checked
 *  across ≥2 sources. Checked before the general priority list.
 *
 *  Europe top: Bundesliga 3.19, Eredivisie 3.12, Eliteserien 3.09,
 *    Swiss SL 3.02, Urvalsdeild ~3.1, Danish Superliga ~2.92.
 *  Europe lower: 2. Bundesliga ~3.05, Eerste Divisie ~3.15, OBOS-ligaen ~3.0,
 *    Danish 1. Div ~2.95, Swedish Div 1/2 ~3.0, German Regionalliga ~3.2+.
 *  Asia/Oceania: NPL competitions (Australian state leagues) ~3.2+.
 *    Singapore PL ~2.9, Malaysia SL ~2.8 (borderline Tier A).
 *  Middle East: Qatar Stars League ~2.85 (borderline; high-temp fatigue suppresses
 *    summer goal counts, included for data richness not raw average).
 *  Americas: Bolivia PD ~3.3, USL League Two ~3.1, Liga MX ~2.7 (borderline).
 *  Nordic: Veikkausliiga ~2.9, Georgian Erovnuli ~3.0+, Kyrgyz PL ~3.2+.
 *  Africa/LatAm cups: Copa Chile, Copa Venezuela (early rounds ~3.5+).
 *  Cups (early rounds / mismatches): Faroe Islands Cup, Lithuanian Cup,
 *    Estonian Cup — mismatch rounds routinely hit 4-6 goals.
 */
export const GOALS_RICH_LEAGUES: ReadonlySet<string> = new Set([
  // ── Europe top flights ────────────────────────────────────────────────────
  "Bundesliga",
  "Eredivisie",
  "Eliteserien",
  "Swiss Super League",
  "Danish Superliga",
  "Urvalsdeild",
  // ── Europe lower divisions ────────────────────────────────────────────────
  "2. Bundesliga",
  "Eerste Divisie",
  "OBOS-ligaen",
  "Swedish Division 1",
  "Swedish Division 2",
  "Danish 1. Division",
  "Regionalliga Bayern",
  "Regionalliga Nord",
  "Regionalliga Nordost",
  "Regionalliga Südwest",
  "Regionalliga West",
  // ── Nordic / Baltic / Caucasus ────────────────────────────────────────────
  "Veikkausliiga",
  "Erovnuli Liga",
  "Kyrgyz Premier League",
  // ── Asia / Oceania / Middle East ──────────────────────────────────────────
  "NPL Queensland",
  "NPL New South Wales",
  "NPL Victoria",
  "Singapore Premier League",
  "Malaysia Super League",
  "Qatar Stars League",
  // ── Africa ───────────────────────────────────────────────────────────────
  "Tanzania Premier League",
  "Syrian Premier League",
  // ── Americas ─────────────────────────────────────────────────────────────
  "Bolivia Primera Division",
  "USL League Two",
  "Copa Chile",
  "Copa Venezuela",
  // ── Cups (early rounds / mismatches) ─────────────────────────────────────
  "Faroe Islands Cup",
  "Lithuanian Cup",
  "Estonian Cup",
  // ── Existing goals-rich entries ───────────────────────────────────────────
  "MLS",
  "Chinese Super League",
  "Scottish Premiership",
  "Austrian Bundesliga",
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

/** Scores a fixture's goals-market opportunity, 0–100+. Combines league tier
 *  with seven evidence layers. Score deliberately exceeds 100 when multiple
 *  strong signals align — the final Math.min(100, score) cap keeps the output
 *  bounded while allowing high-signal fixtures to saturate naturally.
 *
 *  Signal weights (approximate; can accumulate past 100 before cap):
 *    League tier A/B/C         : 40 / 25 / 10
 *    O/U 2.5 season hit-rate   : 0–20  (both sides averaged)
 *    Shot volume + corners      : 0–20  (SoT 0-12, corners 0-8)
 *    Season goals avg (scored)  : 0–15
 *    Home-favourite signal      : +15   (moneyline < 1.60 → lopsided → goals)
 *    Attacking mismatch         : +12   (both sides avg_scored > 1.5)
 *    Defensive mismatch         : +10   (one concedes >1.5 & other scores >1.5)
 *    Form streak                : +8    (either team on 3+ win/loss streak)
 *    Rest / congestion          : +6    (either team ≤3 rest days)
 *    Data-presence bonus        : 0–8
 *
 *  Missing data never zeroes the score — it just forgoes that component's pts. */
export function scoreGoalsPotential(event: SportyBetEvent): number {
  const stats = event.detail?.stats;
  const detail = event.detail;
  let score = TIER_SCORE[leagueTier(event.league)];

  // ── O/U 2.5 season hit-rate (0–20 points) ────────────────────────────────
  const overUnder = stats?.overunder;
  const homeOver25 = overUnder?.home?.over25_pct;
  const awayOver25 = overUnder?.away?.over25_pct;
  if (typeof homeOver25 === "number" || typeof awayOver25 === "number") {
    const vals = [homeOver25, awayOver25].filter((v): v is number => typeof v === "number");
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    score += Math.min(20, avg * 20);
  }

  // ── Shot volume + corners (possessionValue) (0–20 points) ────────────────
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

  // ── Season goals-scored average, both sides (0–15 points) ─────────────────
  const goals = stats?.goals;
  const homeScored = goals?.home?.avg_scored;
  const awayScored = goals?.away?.avg_scored;
  const scoredVals = [homeScored, awayScored].filter((v): v is number => typeof v === "number");
  if (scoredVals.length > 0) {
    const avg = scoredVals.reduce((a, b) => a + b, 0) / scoredVals.length;
    score += Math.min(15, (avg / 2.0) * 15);
  }

  // ── Home-favourite signal (+15) ────────────────────────────────────────────
  // Short home odds (<1.60) signal a lopsided match — the heavy favourite presses
  // high, the underdog counter-attacks, and total goal counts are empirically
  // elevated vs. near-evenly-matched fixtures (Shin & Sung 2015, EPL study).
  const odds1x2 = detail?.odds?.["1x2"];
  if (odds1x2 && Array.isArray(odds1x2)) {
    const homeOutcome = odds1x2.find(
      (o) =>
        typeof o === "object" &&
        o !== null &&
        "id" in o &&
        String((o as { id: unknown }).id) === "1"
    ) as { odds?: string | null } | undefined;
    const homeOdds = homeOutcome?.odds ? Number(homeOutcome.odds) : NaN;
    if (Number.isFinite(homeOdds) && homeOdds > 1 && homeOdds < 1.6) score += 15;
  }

  // ── Attacking mismatch (+12): both sides avg_scored > 1.5 ─────────────────
  if (
    typeof homeScored === "number" &&
    homeScored > 1.5 &&
    typeof awayScored === "number" &&
    awayScored > 1.5
  ) {
    score += 12;
  }

  // ── Defensive mismatch (+10): one team concedes >1.5 AND other scores >1.5 ─
  const homeConceded = goals?.home?.avg_conceded;
  const awayConceded = goals?.away?.avg_conceded;
  if (
    typeof homeConceded === "number" &&
    typeof awayConceded === "number" &&
    typeof homeScored === "number" &&
    typeof awayScored === "number"
  ) {
    const defMismatch =
      (homeConceded > 1.5 && awayScored > 1.5) || (awayConceded > 1.5 && homeScored > 1.5);
    if (defMismatch) score += 10;
  }

  // ── Form streak (+8): either team on a 3+ win or loss run ─────────────────
  const form = stats?.form;
  const homeStreak = form?.home?.streak;
  const awayStreak = form?.away?.streak;
  if (
    (typeof homeStreak === "number" && Math.abs(homeStreak) >= 3) ||
    (typeof awayStreak === "number" && Math.abs(awayStreak) >= 3)
  ) {
    score += 8;
  }

  // ── Rest / congestion (+6): either team ≤3 rest days ─────────────────────
  const congestion = stats?.congestion;
  const homeRest = congestion?.home?.rest_days;
  const awayRest = congestion?.away?.rest_days;
  if (
    (typeof homeRest === "number" && homeRest <= 3) ||
    (typeof awayRest === "number" && awayRest <= 3)
  ) {
    score += 6;
  }

  // ── Data-presence confidence bonus (0–8) ──────────────────────────────────
  const subtabsPresent = [
    stats?.form,
    stats?.standings,
    stats?.goals,
    stats?.overunder,
    stats?.possessionValue,
  ].filter(Boolean).length;
  score += (subtabsPresent / 5) * 8;

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
