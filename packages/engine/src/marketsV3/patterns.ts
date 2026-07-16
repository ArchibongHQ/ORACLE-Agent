/** all-markets pattern/trend detector — the deterministic "green-flag" engine.
 *
 *  Implements the owner's reference-doc analysis hierarchy (Recency/Momentum
 *  50%, Venue-Specific Splits 30%, Head-to-Head 15%, League Context 5%) and the
 *  four green-flag profiles: Heavy Superior, Goal Machines, Corner Kings, and
 *  Anomaly / Hidden-value. Pure math, no I/O — the wave-2 caller builds a
 *  PatternInput from V3AllMarketsInput and feeds the resulting PatternReport
 *  into the EV gate to relax the class-edge bar and re-rank pattern-backed
 *  picks (pattern-primary + a +EV value floor).
 *
 *  NEVER recommends an "Under" market (owner rule): a low-scoring / dominant
 *  read maps to the favoured side's Asian Handicap (line chosen by the wave-3
 *  pivot), and goal trends map to Over / BTTS-Yes.
 *
 *  Reuses `scoreV3Priority` (marketsV3/prioritise.ts) as the hierarchy-weighted
 *  context score rather than duplicating its streak / H2H-overs / mismatch /
 *  league-average heuristics. */

import type { MarketFamily } from "../markets/index.js";
import { scoreV3Priority, type V3PriorityInput } from "./prioritise.js";

/** Standalone, testable input — the wave-2 caller builds this from
 *  V3AllMarketsInput (venue-split lambda inputs + empirical block + corners/
 *  cards + devigged odds). Every field beyond the four venue-split goal rates
 *  is optional so the detector degrades gracefully on thin data. */
export interface PatternInput {
  // Venue-split goals per game (home team AT HOME, away team AWAY).
  homeScoredHome: number;
  homeConcededHome: number;
  awayScoredAway: number;
  awayConcededAway: number;
  // xG / xGA (optional).
  homeXg?: number;
  awayXg?: number;
  homeXga?: number;
  awayXga?: number;
  // Empirical venue-split rates, 0-1 (optional).
  ou25PctH?: number;
  ou25PctA?: number;
  bttsPctH?: number;
  bttsPctA?: number;
  csPctH?: number;
  csPctA?: number;
  ftsPctH?: number;
  ftsPctA?: number;
  // Corners for / against per game (optional).
  cornersForH?: number;
  cornersForA?: number;
  cornersAgainstH?: number;
  cornersAgainstA?: number;
  // Cards per game (optional).
  cardsAvgH?: number;
  cardsAvgA?: number;
  // League context (optional).
  leagueAvgGoals?: number;
  // Venue-split sample sizes (optional) — small n shrinks strength/confidence.
  nHome?: number;
  nAway?: number;
  // Market prices (optional) — for the "home favourite < 1.60" + hidden-value signals.
  homeOdds?: number;
  drawOdds?: number;
  awayOdds?: number;
  // Momentum / H2H (optional — wired by a later wave; degrade gracefully).
  streakH?: number;
  streakA?: number;
  last5PtsH?: number;
  last5PtsA?: number;
  h2hOversRate?: number;
  // Congestion (optional).
  restDaysMin?: number;
  // Market depth (optional) — # mapped families with usable stats.
  mappedFamiliesWithStats?: number;
}

export type PatternKind = "heavy_superior" | "goal_machine" | "corner_kings" | "anomaly";

export interface PatternHit {
  kind: PatternKind;
  /** 0-1 raw strength of this specific pattern (pre sample-size shrink). */
  score: number;
  side?: "home" | "away";
  recommendedFamily: MarketFamily | null;
  recommendedSide: string | null;
  rationale: string;
}

export interface PatternReport {
  patterns: PatternHit[];
  topPattern: PatternHit | null;
  /** 0-1 overall conviction: top pattern blended with the hierarchy-weighted
   *  priority context, then shrunk by the smaller venue sample size. */
  strength: number;
  recommendedFamily: MarketFamily | null;
  recommendedSide: string | null;
  confidence: "very_high" | "high" | "medium" | null;
  trapWarning: string | null;
}

export const PATTERN_THRESHOLDS = {
  // Heavy Superior (venue-split net-goals mismatch).
  hsHomeNetMin: 1.0,
  hsAwayNetMax: -0.3,
  hsGapMin: 2.0,
  hsGapFull: 3.5, // gap at which the pattern score saturates to ~1
  hsXgGapMin: 0.9,
  // Goal Machines.
  gmOu25Min: 0.7,
  gmBttsMin: 0.7,
  gmExpTotalMin: 2.7,
  gmExpTotalStrong: 3.1,
  gmExpTotalFull: 3.6,
  // Corner Kings.
  ckCombinedMin: 10.5,
  ckCombinedFull: 13.0,
  ckTeamMin: 6.5,
  // Anomaly / hidden value.
  anomalyNetGapMin: 1.0,
  anomalyUnderpricedOdds: 2.2,
  anomalyStreakMin: 3,
  // Sample-size shrink: min venue-n at which strength is fully trusted.
  fullTrustN: 8,
  noSampleShrink: 0.75, // multiplier applied when no sample-size info at all
  // Confidence tiers off `strength`.
  confVeryHigh: 0.7,
  confHigh: 0.5,
  confMedium: 0.3,
} as const;

const T = PATTERN_THRESHOLDS;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (x: number | undefined): number =>
  typeof x === "number" && Number.isFinite(x) ? x : 0;

/** Shrink factor in [0,1] from the smaller of the two venue sample sizes.
 *  Absent sample info ⇒ a moderate discount (not zero — venue goal rates are
 *  still meaningful), so the detector stays useful before Phase-0 wiring. */
function sampleShrink(nHome?: number, nAway?: number): number {
  if (nHome == null && nAway == null) return T.noSampleShrink;
  const n = Math.min(num(nHome), num(nAway));
  if (n <= 0) return T.noSampleShrink;
  return clamp01(n / T.fullTrustN);
}

function detectHeavySuperior(input: PatternInput): PatternHit | null {
  const homeNet = input.homeScoredHome - input.homeConcededHome;
  const awayNet = input.awayScoredAway - input.awayConcededAway;
  const gap = homeNet - awayNet; // > 0 ⇒ home superior, < 0 ⇒ away superior
  const xgGap =
    input.homeXg != null && input.awayXg != null ? input.homeXg - input.awayXg : undefined;

  const homeSuperior =
    (homeNet >= T.hsHomeNetMin && awayNet <= T.hsAwayNetMax) ||
    gap >= T.hsGapMin ||
    (xgGap != null && xgGap >= T.hsXgGapMin && gap > 0);
  const awaySuperior =
    (awayNet >= T.hsHomeNetMin && homeNet <= T.hsAwayNetMax) ||
    -gap >= T.hsGapMin ||
    (xgGap != null && -xgGap >= T.hsXgGapMin && gap < 0);

  if (!homeSuperior && !awaySuperior) return null;
  const side: "home" | "away" = gap >= 0 ? "home" : "away";
  const mag = Math.abs(gap);
  const score = clamp01((mag - T.hsGapMin * 0.5) / (T.hsGapFull - T.hsGapMin * 0.5));
  return {
    kind: "heavy_superior",
    score,
    side,
    recommendedFamily: "asian_handicap",
    recommendedSide: side === "home" ? "Home" : "Away",
    rationale: `Venue-split mismatch: ${side} net ${side === "home" ? homeNet.toFixed(2) : awayNet.toFixed(2)} vs opponent ${side === "home" ? awayNet.toFixed(2) : homeNet.toFixed(2)} (gap ${mag.toFixed(2)}/game) → Asian Handicap the dominant side.`,
  };
}

function detectGoalMachine(input: PatternInput): PatternHit | null {
  // Matchup-adjusted expected goals from venue splits.
  const expHome = (input.homeScoredHome + input.awayConcededAway) / 2;
  const expAway = (input.awayScoredAway + input.homeConcededHome) / 2;
  const expTotal = expHome + expAway;

  const ouStrong = num(input.ou25PctH) >= T.gmOu25Min || num(input.ou25PctA) >= T.gmOu25Min;
  const bttsStrong = num(input.bttsPctH) >= T.gmBttsMin && num(input.bttsPctA) >= T.gmBttsMin;

  const hit =
    expTotal >= T.gmExpTotalMin && (ouStrong || bttsStrong || expTotal >= T.gmExpTotalStrong);
  if (!hit) return null;

  const score = clamp01((expTotal - T.gmExpTotalMin) / (T.gmExpTotalFull - T.gmExpTotalMin));
  // Prefer Over 2.5 when the total drives it; fall back to BTTS Yes when the
  // signal is a two-sided both-score trend rather than a high total.
  const preferBtts = bttsStrong && !ouStrong && expTotal < T.gmExpTotalStrong;
  return {
    kind: "goal_machine",
    score,
    recommendedFamily: preferBtts ? "btts" : "goals_ou",
    recommendedSide: preferBtts ? "Yes" : "Over 2.5",
    rationale: `Goal trend: matchup-adjusted expected total ${expTotal.toFixed(2)} (Over-2.5 splits H ${num(input.ou25PctH).toFixed(2)}/A ${num(input.ou25PctA).toFixed(2)}) → ${preferBtts ? "BTTS Yes" : "Over 2.5"}.`,
  };
}

function detectCornerKings(input: PatternInput): PatternHit | null {
  if (
    input.cornersForH == null ||
    input.cornersForA == null ||
    input.cornersAgainstH == null ||
    input.cornersAgainstA == null
  ) {
    return null;
  }
  const expHomeC = (input.cornersForH + input.cornersAgainstA) / 2;
  const expAwayC = (input.cornersForA + input.cornersAgainstH) / 2;
  const combined = expHomeC + expAwayC;
  const teamMax = Math.max(expHomeC, expAwayC);

  if (combined < T.ckCombinedMin && teamMax < T.ckTeamMin) return null;

  const combinedScore = clamp01(
    (combined - T.ckCombinedMin) / (T.ckCombinedFull - T.ckCombinedMin)
  );
  const teamScore = clamp01((teamMax - T.ckTeamMin) / (9 - T.ckTeamMin));
  const teamDriven = combined < T.ckCombinedMin;
  const score = teamDriven ? teamScore * 0.8 : Math.max(combinedScore, teamScore * 0.8);
  if (score <= 0) return null;

  if (teamDriven) {
    // A single dominant corner side — recommend that team's corners Over one
    // whole line below its expectation, floored to a real market line.
    const side: "home" | "away" = expHomeC >= expAwayC ? "home" : "away";
    const line = Math.max(4.5, Math.floor(teamMax - 1) + 0.5);
    return {
      kind: "corner_kings",
      score,
      side,
      recommendedFamily: "corners",
      recommendedSide: `${side === "home" ? "Home" : "Away"} Over ${line.toFixed(1)}`,
      rationale: `Corner skew: ${side} team expects ${teamMax.toFixed(1)} corners → ${side === "home" ? "Home" : "Away"} team corners Over ${line.toFixed(1)}.`,
    };
  }
  // Total-corners Over one whole line below the expected combined.
  const line = Math.max(8.5, Math.floor(combined - 1) + 0.5);
  return {
    kind: "corner_kings",
    score,
    recommendedFamily: "corners",
    recommendedSide: `Over ${line.toFixed(1)}`,
    rationale: `Corner skew: expected combined ${combined.toFixed(1)} (home ${expHomeC.toFixed(1)} / away ${expAwayC.toFixed(1)}) → total corners Over ${line.toFixed(1)}.`,
  };
}

function detectAnomaly(input: PatternInput): PatternHit | null {
  const homeNet = input.homeScoredHome - input.homeConcededHome;
  const awayNet = input.awayScoredAway - input.awayConcededAway;
  const netGap = homeNet - awayNet;

  // Venue-split favourite the market prices as an underdog (hidden value), or a
  // meaningful home streak against a weaker away side.
  const homeUnderpriced =
    netGap >= T.anomalyNetGapMin && num(input.homeOdds) >= T.anomalyUnderpricedOdds;
  const awayUnderpriced =
    -netGap >= T.anomalyNetGapMin && num(input.awayOdds) >= T.anomalyUnderpricedOdds;
  const homeStreak = num(input.streakH) >= T.anomalyStreakMin && netGap > 0;
  const awayStreak = num(input.streakA) >= T.anomalyStreakMin && netGap < 0;

  if (!homeUnderpriced && !awayUnderpriced && !homeStreak && !awayStreak) return null;
  const side: "home" | "away" = homeUnderpriced || homeStreak ? "home" : "away";
  const odds = side === "home" ? num(input.homeOdds) : num(input.awayOdds);
  // Score grows with how far the market underprices the venue-split favourite.
  const oddsEdge = odds > 0 ? clamp01((odds - T.anomalyUnderpricedOdds) / 2) : 0;
  const gapEdge = clamp01(Math.abs(netGap) / (T.hsGapMin * 1.5));
  const score = clamp01(0.4 + 0.35 * gapEdge + 0.25 * oddsEdge);
  return {
    kind: "anomaly",
    score,
    side,
    recommendedFamily: "dnb",
    recommendedSide: side === "home" ? "Home" : "Away",
    rationale: `Hidden value: ${side} is the venue-split favourite (net gap ${Math.abs(netGap).toFixed(2)}) but priced at ${odds ? odds.toFixed(2) : "n/a"} → Draw-No-Bet the ${side}.`,
  };
}

/** Hierarchy-weighted context score (0-1), reusing scoreV3Priority so the
 *  streak / H2H-overs / mismatch / league-average / congestion / market-depth
 *  heuristics aren't duplicated. */
function priorityContext(input: PatternInput): number {
  const homeNet = input.homeScoredHome - input.homeConcededHome;
  const awayNet = input.awayScoredAway - input.awayConcededAway;
  const netGap = homeNet - awayNet;
  const pin: V3PriorityInput = {
    homeOdds: input.homeOdds ?? null,
    leagueAvgGoals: input.leagueAvgGoals ?? null,
    // A clear venue-split net-goals gap is both a defensive and attacking mismatch.
    defensiveMismatch: Math.abs(netGap) >= T.hsGapMin,
    attackingMismatch: Math.abs(netGap) >= T.hsGapMin,
    streakLength: Math.max(num(input.streakH), num(input.streakA)) || null,
    h2hOversTrend: input.h2hOversRate != null ? input.h2hOversRate >= 0.6 : false,
    restDaysMin: input.restDaysMin ?? null,
    mappedFamiliesWithStats: input.mappedFamiliesWithStats ?? 0,
  };
  // scoreV3Priority sums to at most 100 (V3_PRIORITY_WEIGHTS). Normalise.
  return clamp01(scoreV3Priority(pin) / 100);
}

/** Detect all green-flag patterns for a fixture and rank them. Deterministic. */
export function detectPatterns(input: PatternInput): PatternReport {
  const hits = [
    detectHeavySuperior(input),
    detectGoalMachine(input),
    detectCornerKings(input),
    detectAnomaly(input),
  ].filter((h): h is PatternHit => h !== null && h.score > 0);

  hits.sort((a, b) => b.score - a.score);
  const topPattern = hits[0] ?? null;

  if (!topPattern) {
    return {
      patterns: [],
      topPattern: null,
      strength: 0,
      recommendedFamily: null,
      recommendedSide: null,
      confidence: null,
      trapWarning: null,
    };
  }

  const shrink = sampleShrink(input.nHome, input.nAway);
  const priority = priorityContext(input);
  // Blend the top pattern's raw score with the hierarchy-weighted context, then
  // shrink by the venue sample size. A small agreement bonus when ≥2 patterns fire.
  const agreementBonus = hits.length >= 2 ? 0.05 : 0;
  const strength = clamp01((0.7 * topPattern.score + 0.3 * priority + agreementBonus) * shrink);

  const confidence: PatternReport["confidence"] =
    strength >= T.confVeryHigh
      ? "very_high"
      : strength >= T.confHigh
        ? "high"
        : strength >= T.confMedium
          ? "medium"
          : null;

  return {
    patterns: hits,
    topPattern,
    strength,
    recommendedFamily: topPattern.recommendedFamily,
    recommendedSide: topPattern.recommendedSide,
    confidence,
    trapWarning: trapWarning(input, topPattern),
  };
}

/** The single most likely reason this pattern is a trap (reference-doc §"The
 *  Trap Warning"). Null when nothing obvious contradicts it. */
function trapWarning(input: PatternInput, top: PatternHit): string | null {
  const minN = Math.min(num(input.nHome), num(input.nAway));
  if ((input.nHome != null || input.nAway != null) && minN > 0 && minN < 3) {
    return `Thin venue sample (n=${minN}) — pattern strength discounted.`;
  }
  if (top.kind === "goal_machine" && input.h2hOversRate != null && input.h2hOversRate < 0.4) {
    return `H2H meetings trend Under (${(input.h2hOversRate * 100).toFixed(0)}% Over) despite goal-machine splits.`;
  }
  if (top.kind === "heavy_superior") {
    const favOdds = top.side === "home" ? num(input.homeOdds) : num(input.awayOdds);
    if (favOdds > 0 && favOdds < 1.4) {
      return `Market already prices the mismatch (${favOdds.toFixed(2)}) — thin value; the AH line matters.`;
    }
  }
  return null;
}
