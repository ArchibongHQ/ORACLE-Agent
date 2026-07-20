/** all-markets pattern/trend detector — the deterministic "green-flag" engine.
 *
 *  Implements the owner's reference-doc analysis hierarchy (Recency/Momentum
 *  50%, Venue-Specific Splits 30%, Head-to-Head 15%, League Context 5%) and
 *  the reference doc's full green-flag catalog (v6.2 §2.5.1): Heavy Superior
 *  (G1), Goal Machine (G2/G3), BTTS Banker (G4), Corner Kings (G5), Hidden
 *  Value / Fortress-vs-Nomad (G6), H2H Venue Dominance (G7), plus a
 *  first-half-share pattern for the "fast starter / slow starter" profile
 *  the owner asked to cover alongside HT/FT-adjacent markets (recommends a
 *  priceable 1H/2H total, not the unpriceable HT/FT combo market — v6.2
 *  §9.13 excludes HT/FT combos as unpriceable by the 90-minute grid). Also
 *  implements the doc's trap-flag catalog (§2.5.2) T1-T5 — T6/T7 are
 *  deliberately NOT implemented: no data source exists yet for last-3
 *  match-by-match results (T6) or cup-tie first-leg context (T7); per the
 *  doc's own Rule 0.16, a flag with no defining field is NOT-EVALUABLE, not
 *  faked. Pure math, no I/O — callers build a PatternInput from their own
 *  fixture data and feed the resulting PatternReport into ranking/confidence.
 *
 *  NEVER recommends an "Under" market (owner rule): a low-scoring / dominant
 *  read maps to the favoured side's Asian Handicap (line chosen by the wave-3
 *  pivot), and goal trends map to Over / BTTS-Yes.
 *
 *  Research grounding (2026-07-18, see project handoff plan for full
 *  citations): this pattern catalog is a human-interpretable heuristic
 *  overlay, NOT an independently backtested statistical model — sports
 *  betting literature is explicit that unvalidated rule-based systems carry
 *  real overfitting/data-snooping risk. Accordingly this module (and every
 *  caller) treats its output as a RANKING/CONFIDENCE signal only — it never
 *  overrides a candidate's +EV floor. That floor is absolute, with no
 *  exception for pattern strength (an intermediate design allowing a small,
 *  capped near-miss exception was proposed and explicitly rejected by the
 *  owner after reviewing this risk). Recency-weighting and xG-blending
 *  (already used elsewhere in this engine) ARE supported by 2024/2025
 *  research; the specific named pattern profiles and their exact thresholds
 *  are not — treat this catalog as informative context, not proof.
 *
 *  Reuses `scoreV3Priority` (marketsV3/prioritise.ts) as the hierarchy-weighted
 *  context score rather than duplicating its streak / H2H-overs / mismatch /
 *  league-average heuristics. */

import type { MarketFamily } from "../markets/index.js";
import { scoreV3Priority, type V3PriorityInput } from "./prioritise.js";

/** One historical H2H meeting, normalised to the CURRENT fixture's
 *  home/away perspective by the caller (callers do the team-name matching
 *  against their own H2H source; patterns.ts never sees raw team names). */
export interface H2hMeeting {
  /** Result from the CURRENT fixture's home team's perspective. */
  result: "home_win" | "away_win" | "draw";
  totalGoals: number;
  btts: boolean;
  /** True when this meeting was played at the CURRENT fixture's venue (the
   *  historical match's home side is also the current fixture's home side). */
  atCurrentVenue: boolean;
}

/** Standalone, testable input — callers build this from their own fixture
 *  data (V3AllMarketsInput for the live pick engine, the scraped sidecar
 *  event for the report). Every field beyond the four venue-split goal
 *  rates is optional so the detector degrades gracefully on thin data. */
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
  // First-half goal share, 0-1 (optional) — fast-starter/slow-starter signal.
  fhShareH?: number;
  fhShareA?: number;
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
  // BTTS market prices (optional) — for the Data Analysis panel's model-vs-
  // market delta only; no pattern/trap check reads these.
  bttsYesOdds?: number;
  bttsNoOdds?: number;
  // League name (optional) — for Dixon-Coles rho resolution (resolveRho) in
  // the Data Analysis panel; unused by any pattern/trap detector.
  league?: string;
  // Momentum / H2H (optional — degrade gracefully when absent).
  streakH?: number;
  streakA?: number;
  last5PtsH?: number;
  last5PtsA?: number;
  h2hOversRate?: number;
  /** Per-meeting H2H detail (most-recent-first), for G7 + T3. Optional —
   *  callers without per-meeting data leave this unset; those checks
   *  become NOT-EVALUABLE rather than guessing from the aggregate rate. */
  h2hMeetings?: H2hMeeting[];
  // Congestion (optional).
  restDaysMin?: number;
  restDaysH?: number;
  restDaysA?: number;
  // Availability (optional) — T1 key-absence trap.
  homeKeyPlayerOut?: boolean;
  awayKeyPlayerOut?: boolean;
  /** Last-5 (proxying the doc's "last-3") scored rate — separate from
   *  homeScoredHome/awayScoredAway so T4 can compare recent-vs-baseline even
   *  when a caller's core fields are already recency-blended. Optional. */
  recentScoredH?: number;
  recentScoredA?: number;
  // Market depth (optional) — # mapped families with usable stats.
  mappedFamiliesWithStats?: number;
  /** [Phase 3, patterns-v62-core] §2.5.4 data-basis marker. "venue" — the
   *  four core scored/conceded fields (and their correlated ou25/btts/cs
   *  percentages) are a TRUE home-at-home/away-at-away split. "overall" —
   *  the same fields carry team-overall/pooled data (no split available
   *  upstream); a caller opts in explicitly by setting this. Undefined
   *  (existing callers that predate this field) behaves exactly like
   *  "venue" — full-strength thresholds, no confidence cap — so this is
   *  purely additive: only a caller that threads basis:"overall" sees the
   *  new, more conservative treatment. On "overall": heavy_superior/
   *  goal_machine/btts_banker/anomaly (the four detectors keyed directly off
   *  the core venue-split fields) use tightened OVERALL_TIGHTEN thresholds,
   *  their rationale gets a "°" marker, and detectPatterns caps confidence
   *  at "medium" regardless of strength (never "high"/"very_high" — v6.2's
   *  "no confidence uplift on overall basis" rule). corner_kings/
   *  h2h_dominance/half_share are untouched — their data (corners/H2H
   *  meetings/first-half share) has independent provenance, not the venue-
   *  split-vs-overall ambiguity this flag describes. */
  basis?: "venue" | "overall";
}

export type PatternKind =
  | "heavy_superior"
  | "goal_machine"
  | "btts_banker"
  | "corner_kings"
  | "anomaly"
  | "h2h_dominance"
  | "half_share";

export interface PatternHit {
  kind: PatternKind;
  /** 0-1 raw strength of this specific pattern (pre sample-size shrink). */
  score: number;
  side?: "home" | "away";
  recommendedFamily: MarketFamily | null;
  recommendedSide: string | null;
  rationale: string;
}

export type TrapKind = "T1" | "T2" | "T3" | "T4" | "T5";

export interface TrapFlag {
  kind: TrapKind;
  text: string;
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
  /** Single most-likely trap reason (backward-compatible field — the first
   *  entry of trapFlags when any fired, else the legacy single-check text). */
  trapWarning: string | null;
  /** Every trap flag that fired (T1-T5; T6/T7 not implemented — see header). */
  trapFlags: TrapFlag[];
  /** [Phase 3] Echoes PatternInput.basis; null when the caller didn't set it
   *  (pre-Phase-3 callers) — downstream ranking-bonus consumers (evGate.ts's
   *  patternBacked, batch/index.ts's applyLegacyPatternRanking call site)
   *  treat null the same as "venue" (unconditional bonus, unchanged
   *  behavior) and skip the bonus entirely only on "overall". */
  basis: "venue" | "overall" | null;
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
  // BTTS Banker (v6.2 G4) — both sides' venue BTTS% high AND neither keeps
  // clean sheets often; distinct from goal_machine's total-goals framing.
  bbBttsMin: 0.7,
  bbCsMax: 0.4,
  bbFull: 0.9, // BTTS% at which score saturates
  // Corner Kings.
  ckCombinedMin: 10.5,
  ckCombinedFull: 13.0,
  ckTeamMin: 6.5,
  // Anomaly / hidden value.
  anomalyNetGapMin: 1.0,
  anomalyUnderpricedOdds: 2.2,
  anomalyStreakMin: 3,
  // H2H Venue Dominance (v6.2 G7).
  h2hDomWinsOf4: 3,
  h2hDomMeetingsMin: 4,
  h2hDomOverLine: 2.5,
  // First-half share (fast-starter/slow-starter).
  halfShareGapMin: 0.15, // |fhShareH - fhShareA| beyond league-neutral (~0)
  halfShareNeutral: 0.44, // league-typical 1H share of full-match goals
  // Trap thresholds.
  t2RestMax: 3,
  t2RestRestedMin: 5,
  t4DipRatio: 0.4,
  t5FavOdds: 1.6,
  t5PpgMax: 1.2,
  // Sample-size shrink: min venue-n at which strength is fully trusted.
  fullTrustN: 8,
  noSampleShrink: 0.75, // multiplier applied when no sample-size info at all
  // Confidence tiers off `strength`.
  confVeryHigh: 0.7,
  confHigh: 0.5,
  confMedium: 0.3,
} as const;

/** [Phase 3, §2.5.4] Tightening applied to the four venue-split-keyed
 *  detectors (heavy_superior, goal_machine, btts_banker, anomaly) when
 *  PatternInput.basis === "overall" — pooled team-overall data conflates
 *  true home/away effects into one number, so a larger raw signal is
 *  required before trusting it the same as a genuine venue split. */
export const OVERALL_TIGHTEN = {
  /** Multiplicative tightening for net-goal-gap / xG-gap thresholds
   *  (heavy_superior, anomaly). */
  gapMult: 1.3,
  /** Multiplicative tightening for expected-total-goals thresholds
   *  (goal_machine). */
  totalMult: 1.1,
  /** Additive tightening for 0-1 percentage-rate thresholds (ou25%/btts%
   *  minimums, btts_banker's clean-sheet-rate maximum). */
  pctAdd: 0.05,
  /** Additive tightening for the anomaly detector's underpriced-odds bar —
   *  require a larger market mismatch before trusting it. */
  oddsAdd: 0.15,
  /** Additive tightening for the anomaly detector's streak-length bar. */
  streakAdd: 1,
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
  const overall = input.basis === "overall";
  const homeNetMin = overall ? T.hsHomeNetMin * OVERALL_TIGHTEN.gapMult : T.hsHomeNetMin;
  const awayNetMax = overall ? T.hsAwayNetMax * OVERALL_TIGHTEN.gapMult : T.hsAwayNetMax;
  const gapMin = overall ? T.hsGapMin * OVERALL_TIGHTEN.gapMult : T.hsGapMin;
  const gapFull = overall ? T.hsGapFull * OVERALL_TIGHTEN.gapMult : T.hsGapFull;
  const xgGapMin = overall ? T.hsXgGapMin * OVERALL_TIGHTEN.gapMult : T.hsXgGapMin;

  const homeNet = input.homeScoredHome - input.homeConcededHome;
  const awayNet = input.awayScoredAway - input.awayConcededAway;
  const gap = homeNet - awayNet; // > 0 ⇒ home superior, < 0 ⇒ away superior
  const xgGap =
    input.homeXg != null && input.awayXg != null ? input.homeXg - input.awayXg : undefined;

  const homeSuperior =
    (homeNet >= homeNetMin && awayNet <= awayNetMax) ||
    gap >= gapMin ||
    (xgGap != null && xgGap >= xgGapMin && gap > 0);
  const awaySuperior =
    (awayNet >= homeNetMin && homeNet <= awayNetMax) ||
    -gap >= gapMin ||
    (xgGap != null && -xgGap >= xgGapMin && gap < 0);

  if (!homeSuperior && !awaySuperior) return null;
  const side: "home" | "away" = gap >= 0 ? "home" : "away";
  const mag = Math.abs(gap);
  const score = clamp01((mag - gapMin * 0.5) / (gapFull - gapMin * 0.5));
  return {
    kind: "heavy_superior",
    score,
    side,
    recommendedFamily: "asian_handicap",
    recommendedSide: side === "home" ? "Home" : "Away",
    rationale: `Venue-split mismatch: ${side} net ${side === "home" ? homeNet.toFixed(2) : awayNet.toFixed(2)} vs opponent ${side === "home" ? awayNet.toFixed(2) : homeNet.toFixed(2)} (gap ${mag.toFixed(2)}/game) → Asian Handicap the dominant side.${overall ? " (overall-basis°, not a true venue split)" : ""}`,
  };
}

function detectGoalMachine(input: PatternInput): PatternHit | null {
  const overall = input.basis === "overall";
  const expTotalMin = overall ? T.gmExpTotalMin * OVERALL_TIGHTEN.totalMult : T.gmExpTotalMin;
  const expTotalStrong = overall
    ? T.gmExpTotalStrong * OVERALL_TIGHTEN.totalMult
    : T.gmExpTotalStrong;
  const expTotalFull = overall ? T.gmExpTotalFull * OVERALL_TIGHTEN.totalMult : T.gmExpTotalFull;
  const ou25Min = overall ? T.gmOu25Min + OVERALL_TIGHTEN.pctAdd : T.gmOu25Min;
  const bttsMin = overall ? T.gmBttsMin + OVERALL_TIGHTEN.pctAdd : T.gmBttsMin;

  // Matchup-adjusted expected goals from venue splits.
  const expHome = (input.homeScoredHome + input.awayConcededAway) / 2;
  const expAway = (input.awayScoredAway + input.homeConcededHome) / 2;
  const expTotal = expHome + expAway;

  const ouStrong = num(input.ou25PctH) >= ou25Min || num(input.ou25PctA) >= ou25Min;
  const bttsStrong = num(input.bttsPctH) >= bttsMin && num(input.bttsPctA) >= bttsMin;

  const hit = expTotal >= expTotalMin && (ouStrong || bttsStrong || expTotal >= expTotalStrong);
  if (!hit) return null;

  const score = clamp01((expTotal - expTotalMin) / (expTotalFull - expTotalMin));
  // Prefer Over 2.5 when the total drives it; fall back to BTTS Yes when the
  // signal is a two-sided both-score trend rather than a high total.
  const preferBtts = bttsStrong && !ouStrong && expTotal < expTotalStrong;
  return {
    kind: "goal_machine",
    score,
    recommendedFamily: preferBtts ? "btts" : "goals_ou",
    recommendedSide: preferBtts ? "Yes" : "Over 2.5",
    rationale: `Goal trend: matchup-adjusted expected total ${expTotal.toFixed(2)} (Over-2.5 splits H ${num(input.ou25PctH).toFixed(2)}/A ${num(input.ou25PctA).toFixed(2)}) → ${preferBtts ? "BTTS Yes" : "Over 2.5"}.${overall ? " (overall-basis°, not a true venue split)" : ""}`,
  };
}

/** v6.2 G4 — BTTS Banker: both sides' venue BTTS% high AND neither keeps
 *  clean sheets often. Distinct from goal_machine (which is total-goals-led
 *  and can fire on a high-scoring one-sided game where BTTS is actually
 *  unlikely) — this is specifically a both-teams-score signal. */
function detectBttsBanker(input: PatternInput): PatternHit | null {
  const overall = input.basis === "overall";
  const bttsMin = overall ? T.bbBttsMin + OVERALL_TIGHTEN.pctAdd : T.bbBttsMin;
  const csMax = overall ? T.bbCsMax - OVERALL_TIGHTEN.pctAdd : T.bbCsMax;

  const bttsH = input.bttsPctH;
  const bttsA = input.bttsPctA;
  if (bttsH == null || bttsA == null) return null;
  const bttsOk = bttsH >= bttsMin && bttsA >= bttsMin;
  if (!bttsOk) return null;
  const csOk = num(input.csPctH) < csMax && num(input.csPctA) < csMax;
  if (!csOk) return null;

  const minBtts = Math.min(bttsH, bttsA);
  const score = clamp01((minBtts - bttsMin) / (T.bbFull - bttsMin));
  return {
    kind: "btts_banker",
    score,
    recommendedFamily: "btts",
    recommendedSide: "Yes",
    rationale: `BTTS trend: venue BTTS H ${bttsH.toFixed(2)} / A ${bttsA.toFixed(2)}, clean-sheet rates both below ${(csMax * 100).toFixed(0)}% → BTTS Yes.${overall ? " (overall-basis°, not a true venue split)" : ""}`,
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
  const overall = input.basis === "overall";
  const netGapMin = overall ? T.anomalyNetGapMin * OVERALL_TIGHTEN.gapMult : T.anomalyNetGapMin;
  const underpricedOdds = overall
    ? T.anomalyUnderpricedOdds + OVERALL_TIGHTEN.oddsAdd
    : T.anomalyUnderpricedOdds;
  const streakMin = overall ? T.anomalyStreakMin + OVERALL_TIGHTEN.streakAdd : T.anomalyStreakMin;

  const homeNet = input.homeScoredHome - input.homeConcededHome;
  const awayNet = input.awayScoredAway - input.awayConcededAway;
  const netGap = homeNet - awayNet;

  // Venue-split favourite the market prices as an underdog (hidden value), or a
  // meaningful home streak against a weaker away side. This covers both the
  // original doc's "Anomalies & Hidden Value" (odds-mismatch framing) and
  // v6.2's G6 "Fortress-vs-Nomad" (streak framing) in one detector — the
  // sidecar only carries a signed win/loss streak, not a literal "unbeaten"
  // run length, so the streak condition is a data-realistic approximation of
  // G6's ">=5-game unbeaten home / >=4-game winless away" wording.
  const homeUnderpriced = netGap >= netGapMin && num(input.homeOdds) >= underpricedOdds;
  const awayUnderpriced = -netGap >= netGapMin && num(input.awayOdds) >= underpricedOdds;
  const homeStreak = num(input.streakH) >= streakMin && netGap > 0;
  const awayStreak = num(input.streakA) >= streakMin && netGap < 0;

  if (!homeUnderpriced && !awayUnderpriced && !homeStreak && !awayStreak) return null;
  const side: "home" | "away" = homeUnderpriced || homeStreak ? "home" : "away";
  const odds = side === "home" ? num(input.homeOdds) : num(input.awayOdds);
  // Score grows with how far the market underprices the venue-split favourite.
  const oddsEdge = odds > 0 ? clamp01((odds - underpricedOdds) / 2) : 0;
  // Scale is T.hsGapMin (a DIFFERENT detector's threshold), not this
  // detector's own netGapMin — deliberately preserved as the pre-existing,
  // already-shipped venue-basis scale (byte-identical) rather than switched
  // to netGapMin, which would silently change already-shipped venue-basis
  // scores too, not just the new overall-basis path (adversarial review
  // raised this as a cosmetic tightening-consistency question, 2026-07-20;
  // the safer fix scales the SAME constant by the SAME tightening ratio on
  // overall basis only, leaving venue basis untouched).
  const gapEdgeScale = overall ? T.hsGapMin * OVERALL_TIGHTEN.gapMult : T.hsGapMin;
  const gapEdge = clamp01(Math.abs(netGap) / (gapEdgeScale * 1.5));
  const score = clamp01(0.4 + 0.35 * gapEdge + 0.25 * oddsEdge);
  return {
    kind: "anomaly",
    score,
    side,
    recommendedFamily: "dnb",
    recommendedSide: side === "home" ? "Home" : "Away",
    rationale: `Hidden value: ${side} is the venue-split favourite (net gap ${Math.abs(netGap).toFixed(2)}) but priced at ${odds ? odds.toFixed(2) : "n/a"} → Draw-No-Bet the ${side}.${overall ? " (overall-basis°, not a true venue split)" : ""}`,
  };
}

/** v6.2 G7 — H2H Venue Dominance: same side won >=3 of the last 4 meetings
 *  AT THIS VENUE, or an unbroken H2H over/BTTS pattern across >=4 meetings
 *  (any venue). NOT-EVALUABLE (returns null) without per-meeting H2H data —
 *  never inferred from the aggregate h2hOversRate alone. */
function detectH2hDominance(input: PatternInput): PatternHit | null {
  const meetings = input.h2hMeetings;
  if (!meetings || meetings.length === 0) return null;

  const atVenue = meetings.filter((m) => m.atCurrentVenue).slice(0, 4);
  if (atVenue.length >= T.h2hDomMeetingsMin) {
    const homeWins = atVenue.filter((m) => m.result === "home_win").length;
    const awayWins = atVenue.filter((m) => m.result === "away_win").length;
    if (homeWins >= T.h2hDomWinsOf4 || awayWins >= T.h2hDomWinsOf4) {
      const side: "home" | "away" = homeWins >= T.h2hDomWinsOf4 ? "home" : "away";
      const wins = side === "home" ? homeWins : awayWins;
      return {
        kind: "h2h_dominance",
        score: clamp01(0.5 + 0.15 * (wins - T.h2hDomWinsOf4)),
        side,
        recommendedFamily: "dnb",
        recommendedSide: side === "home" ? "Home" : "Away",
        rationale: `H2H venue dominance: ${side} won ${wins}/${atVenue.length} meetings at this venue → Draw-No-Bet the ${side}.`,
      };
    }
  }

  const last4 = meetings.slice(0, 4);
  if (last4.length >= T.h2hDomMeetingsMin) {
    const allOver = last4.every((m) => m.totalGoals > T.h2hDomOverLine);
    const allBtts = last4.every((m) => m.btts);
    if (allOver || allBtts) {
      return {
        kind: "h2h_dominance",
        score: 0.55,
        recommendedFamily: allBtts && !allOver ? "btts" : "goals_ou",
        recommendedSide: allBtts && !allOver ? "Yes" : "Over 2.5",
        rationale: `H2H trend: unbroken ${allOver ? "Over 2.5" : "BTTS"} pattern across the last ${last4.length} meetings → ${allBtts && !allOver ? "BTTS Yes" : "Over 2.5"}.`,
      };
    }
  }
  return null;
}

/** First-half-share pattern (the owner's "HT/FT"-adjacent category) — a
 *  genuine fast-starter/slow-starter asymmetry from each side's share of
 *  goals scored in the first half. Recommends a priceable 1H/2H total, NOT
 *  the HT/FT combo market itself (v6.2 §9.13: HT/FT is unpriceable by the
 *  90-minute grid — the pattern informs a priceable half-market lean). */
function detectHalfShare(input: PatternInput): PatternHit | null {
  if (input.fhShareH == null && input.fhShareA == null) return null;
  const fhH = input.fhShareH ?? T.halfShareNeutral;
  const fhA = input.fhShareA ?? T.halfShareNeutral;
  const avgShare = (fhH + fhA) / 2;
  const gap = avgShare - T.halfShareNeutral;
  if (Math.abs(gap) < T.halfShareGapMin) return null;

  const score = clamp01(Math.abs(gap) / (T.halfShareNeutral * 0.5));
  const fastStart = gap > 0;
  return {
    kind: "half_share",
    score,
    recommendedFamily: "goals_ou",
    recommendedSide: fastStart ? "1H Over" : "2H Over",
    rationale: `First-half share: combined 1H goal share ${avgShare.toFixed(2)} vs league-neutral ${T.halfShareNeutral.toFixed(2)} → ${fastStart ? "fast-starting" : "slow-starting"} fixture, lean ${fastStart ? "1H Over" : "2H Over"}.`,
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

/** v6.2 §5.9 concordance/discordance. Two independent effects, applied
 *  together but computed separately:
 *   - Concordance: when ≥2 fired patterns (the top pattern plus at least one
 *     other) share the SAME side, a second independently-derived green flag
 *     corroborating the same team is a genuinely stronger signal than the
 *     top pattern alone — lifts confidence exactly one band
 *     (medium→high→very_high, capped at very_high). Side-neutral patterns
 *     (goal_machine/btts_banker/half_share, and corner_kings' total-corners
 *     variant) never carry a `.side` and so can never contribute to or
 *     block concordance — only patterns that name a favoured team count.
 *   - Discordance: a fired trap flag from T3/T4/T5 — the three traps that
 *     specifically question the FAVOURED side's reliability (H2H hasn't
 *     beaten this opponent, recent scoring dip, false-favourite pricing) —
 *     costs a small strength penalty (1pt = 0.01, the same probability-point
 *     unit the rest of the engine's edge math uses) and is promoted to the
 *     front of trapFlags/trapWarning ahead of any non-contradicting trap
 *     (T1/T2 stay purely informational — they don't reference the favoured
 *     side's reliability the way T3-T5 do, so they never trigger this).
 *  Never touches admission: strength/confidence/trapWarning are
 *  ranking/labeling signals only, consumed by callers that ALSO enforce the
 *  ev>0 floor independently — this function has no way to admit or exclude
 *  a candidate. */
export function applyConcordance(
  hits: PatternHit[],
  top: PatternHit,
  strength: number,
  confidence: PatternReport["confidence"],
  trapFlags: TrapFlag[]
): { strength: number; confidence: PatternReport["confidence"]; trapFlags: TrapFlag[] } {
  let liftedConfidence = confidence;
  if (top.side != null && confidence != null) {
    const concordantCount = hits.filter((h) => h.side === top.side).length;
    if (concordantCount >= 2) {
      const bands: NonNullable<PatternReport["confidence"]>[] = ["medium", "high", "very_high"];
      const i = bands.indexOf(confidence);
      if (i >= 0 && i < bands.length - 1) liftedConfidence = bands[i + 1] as typeof confidence;
    }
  }

  const DISCORDANT_TRAPS: ReadonlySet<TrapKind> = new Set(["T3", "T4", "T5"]);
  const discordant = trapFlags.find((f) => DISCORDANT_TRAPS.has(f.kind));
  const discountedStrength = discordant ? clamp01(strength - 0.01) : strength;
  const orderedTrapFlags = discordant
    ? [discordant, ...trapFlags.filter((f) => f !== discordant)]
    : trapFlags;

  return {
    strength: discountedStrength,
    confidence: liftedConfidence,
    trapFlags: orderedTrapFlags,
  };
}

/** Detect all green-flag patterns for a fixture and rank them. Deterministic. */
export function detectPatterns(input: PatternInput): PatternReport {
  const hits = [
    detectHeavySuperior(input),
    detectGoalMachine(input),
    detectBttsBanker(input),
    detectCornerKings(input),
    detectAnomaly(input),
    detectH2hDominance(input),
    detectHalfShare(input),
  ].filter((h): h is PatternHit => h !== null && h.score > 0);

  hits.sort((a, b) => b.score - a.score);
  const topPattern = hits[0] ?? null;

  const basis = input.basis ?? null;

  if (!topPattern) {
    return {
      patterns: [],
      topPattern: null,
      strength: 0,
      recommendedFamily: null,
      recommendedSide: null,
      confidence: null,
      trapWarning: null,
      trapFlags: [],
      basis,
    };
  }

  const shrink = sampleShrink(input.nHome, input.nAway);
  const priority = priorityContext(input);
  // Blend the top pattern's raw score with the hierarchy-weighted context, then
  // shrink by the venue sample size. A small agreement bonus when ≥2 patterns fire.
  const agreementBonus = hits.length >= 2 ? 0.05 : 0;
  const strength = clamp01((0.7 * topPattern.score + 0.3 * priority + agreementBonus) * shrink);

  const rawConfidence: PatternReport["confidence"] =
    strength >= T.confVeryHigh
      ? "very_high"
      : strength >= T.confHigh
        ? "high"
        : strength >= T.confMedium
          ? "medium"
          : null;

  const trapFlags = detectTrapFlags(input, topPattern);

  // v6.2 §5.9 concordance/discordance — see applyConcordance's own header.
  const concordant = applyConcordance(hits, topPattern, strength, rawConfidence, trapFlags);

  // §2.5.4: "no confidence uplift on overall basis" — applied LAST, after
  // concordance's own lift, so overall-basis reports can never exceed
  // "medium" via any mechanism (concordance included).
  const confidence: PatternReport["confidence"] =
    basis === "overall" && concordant.confidence != null ? "medium" : concordant.confidence;

  return {
    patterns: hits,
    topPattern,
    strength: concordant.strength,
    recommendedFamily: topPattern.recommendedFamily,
    recommendedSide: topPattern.recommendedSide,
    confidence,
    trapWarning: concordant.trapFlags[0]?.text ?? legacyTrapWarning(input, topPattern),
    trapFlags: concordant.trapFlags,
    basis,
  };
}

/** Whichever side the top pattern (or, failing that, the market) favours —
 *  "the model-favoured side" the doc's T3/T4 reference. Null when neither
 *  the pattern nor the odds give a clear favourite. */
function favouredSide(input: PatternInput, top: PatternHit): "home" | "away" | null {
  if (top.side) return top.side;
  const h = input.homeOdds;
  const a = input.awayOdds;
  if (h != null && a != null && h !== a) return h < a ? "home" : "away";
  return null;
}

/** v6.2 §2.5.2 trap flags T1-T5. Every check is NOT-EVALUABLE (contributes
 *  nothing) when its defining field is absent — never inferred. T6 (last-3
 *  match-by-match style-clash) and T7 (second-leg tie state) are not
 *  implemented: no data source exists for either in this engine yet. */
function detectTrapFlags(input: PatternInput, top: PatternHit): TrapFlag[] {
  const flags: TrapFlag[] = [];
  const fav = favouredSide(input, top);

  // T1 — Key Absence.
  if (input.homeKeyPlayerOut || input.awayKeyPlayerOut) {
    const side = input.homeKeyPlayerOut ? "home" : "away";
    flags.push({
      kind: "T1",
      text: `Key player reported out (${side}) — confirm before trusting this pattern.`,
    });
  }

  // T2 — Distraction/Congestion.
  if (input.restDaysH != null && input.restDaysA != null) {
    if (input.restDaysH <= T.t2RestMax && input.restDaysA >= T.t2RestRestedMin) {
      flags.push({
        kind: "T2",
        text: `Home side short on rest (${input.restDaysH}d) vs away well-rested (${input.restDaysA}d) — congestion risk.`,
      });
    } else if (input.restDaysA <= T.t2RestMax && input.restDaysH >= T.t2RestRestedMin) {
      flags.push({
        kind: "T2",
        text: `Away side short on rest (${input.restDaysA}d) vs home well-rested (${input.restDaysH}d) — congestion risk.`,
      });
    }
  } else if (input.restDaysMin != null && input.restDaysMin < T.t2RestMax) {
    flags.push({
      kind: "T2",
      text: `Short rest (${input.restDaysMin}d) for at least one side — congestion/rotation risk.`,
    });
  }

  // T3 — H2H Anomaly: the favoured side has failed to beat this opponent in
  // >=3 consecutive meetings.
  if (fav && input.h2hMeetings && input.h2hMeetings.length >= 3) {
    const last3 = input.h2hMeetings.slice(0, 3);
    const favWinResult = fav === "home" ? "home_win" : "away_win";
    const favNeverWon = last3.every((m) => m.result !== favWinResult);
    if (favNeverWon) {
      flags.push({
        kind: "T3",
        text: `${fav === "home" ? "Home" : "Away"} has failed to beat this opponent in the last ${last3.length} meetings despite being favoured.`,
      });
    }
  }

  // T4 — Scoring Dip: favoured side's recent (proxy: last-5) scored rate is
  // well below its season/blended baseline.
  if (fav) {
    const recent = fav === "home" ? input.recentScoredH : input.recentScoredA;
    const baseline = fav === "home" ? input.homeScoredHome : input.awayScoredAway;
    if (recent != null && baseline > 0 && recent <= baseline * T.t4DipRatio) {
      flags.push({
        kind: "T4",
        text: `${fav === "home" ? "Home" : "Away"} recent scoring (${recent.toFixed(2)}) is well below its baseline (${baseline.toFixed(2)}) — scoring dip.`,
      });
    }
  }

  // T5 — False Favourite: short-priced favourite with weak recent venue form.
  const checkFalseFav = (
    odds: number | undefined,
    pts: number | undefined,
    label: string
  ): TrapFlag | null => {
    if (odds == null || odds > T.t5FavOdds || pts == null) return null;
    const ppg = pts / 5;
    if (ppg > T.t5PpgMax) return null;
    return {
      kind: "T5",
      text: `${label} priced as a strong favourite (${odds.toFixed(2)}) but recent form PPG only ${ppg.toFixed(2)} — market may be pricing reputation over form.`,
    };
  };
  const t5 =
    checkFalseFav(input.homeOdds, input.last5PtsH, "Home") ??
    checkFalseFav(input.awayOdds, input.last5PtsA, "Away");
  if (t5) flags.push(t5);

  return flags;
}

/** The original single-check trap logic, kept as the fallback source for
 *  `trapWarning` when no T1-T5 flag fired but this narrower, pattern-specific
 *  check still applies (thin sample, or a goal-machine/heavy-superior-specific
 *  contradiction not covered by the general T-series). */
function legacyTrapWarning(input: PatternInput, top: PatternHit): string | null {
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
