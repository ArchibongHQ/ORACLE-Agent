/** Green-Flags report enrichment — maps a scraped sidecar fixture into the
 *  engine's deterministic pattern detector (marketsV3/patterns.ts) and
 *  summarizes the result for the daily fixtures-markets HTML page.
 *
 *  Purpose (owner instruction 2026-07-18): make the patterns/trends the engine
 *  sees VISIBLE per fixture in the delivered report, so a human can verify the
 *  day's picks were driven by those patterns.
 *
 *  What's genuinely shared vs. independently built (adversarial review finding,
 *  2026-07-18 — do not re-claim full parity without re-verifying this list):
 *  the pure `detectPatterns()` function IS the exact same code the pick
 *  engine calls — one source of truth for the pattern MATH. Its INPUT here is
 *  a second, best-effort builder (`buildReportPatternInput`), independent
 *  from the live pipeline's `buildFixturePatternInput`
 *  (packages/engine/src/marketsV3/analyzeFixtureMarkets.ts:392-441), because
 *  this module runs at report-generation time from the raw sidecar event,
 *  not from the live per-fixture `V3AllMarketsInput` the pick run actually
 *  used. Known, deliberate differences:
 *   - Core goal rates: the scored side is recency-blended via the SAME
 *     `blendRecencyScored` helper the live builder's caller uses
 *     (`sportyBetStats.ts`'s `buildStatsOverride`), so the two agree on the
 *     dominant numeric inputs; the conceded side stays flat-season on both,
 *     matching that same convention.
 *   - `leagueAvgGoals` here comes from the static `V3_LEAGUE_BASELINES`
 *     table — NOT lake-override-aware (the live run's `lakeBaselines` can
 *     override per league from runtime data this module doesn't have).
 *   - `h2hOversRate` / `restDaysMin` ARE computed here even though the live
 *     picker does not yet consume them (explicitly deferred at
 *     analyzeFixtureMarkets.ts:436-440) — meaning the report can show pattern
 *     context slightly AHEAD of what currently drives selection on these two
 *     fields, not behind. Flagged so a strength/trap-warning difference on
 *     these specifically is understood, not mistaken for a bug.
 *  Sample-size (`nHome`/`nAway`) also uses a different count (match-count
 *  fields available at report time) than the live run's empirical-block `n`.
 *
 *  Basis honesty: venue-split rates (scoringConceding) are preferred; when
 *  only overall season rates (goals.avg_*) exist the detector still runs but
 *  every flag is marked with a ° suffix (overall basis, lower trust) — the
 *  v6.2 §2.5.4 convention. Completeness is computed from actual field
 *  presence, never from the feed's own statscoverage self-assessment
 *  (sidecar data contract, PR #74). */
import {
  detectPatterns,
  buildFixtureAnalysisPanel as engineBuildFixtureAnalysisPanel,
  type FixtureAnalysisPanel,
  type H2hMeeting,
  lookupMarket,
  type MarketFamily,
  type PatternInput,
  type PatternKind,
  type PatternReport,
  type TrapFlag,
  type TrapKind,
  V3_LEAGUE_BASELINES,
} from "@oracle/engine";
import type { ScoringConcedingProfile, SportyBetEvent, SportyBetStats } from "./selectFixtures.js";
import { blendRecencyScored, last5Points } from "./sportyBetStats.js";
import { namesMatch } from "./teamNames.js";

export type GreenFlagBasis = "venue" | "overall";

export interface GreenFlagChip {
  /** Pattern kind from the engine detector — the full v6.2 catalog. */
  kind: PatternKind;
  /** Short chip label, e.g. "Heavy Superior (home)". */
  label: string;
  basis: GreenFlagBasis;
  /** 0-1 raw pattern score from the detector. */
  score: number;
  rationale: string;
  /** Plain-English "what this pattern kind means and why it matters" —
   *  static per kind (KIND_EXPLAINER), independent of this fixture's
   *  numbers. Purely additive/display-only: never read by the detector,
   *  never affects score/rationale/ranking (owner instruction 2026-07-19:
   *  do not alter the detection logic, only make it more explainable). */
  meaning: string;
}

export interface GreenFlagSummary {
  flags: GreenFlagChip[];
  flagCount: number;
  /** Overall detector conviction 0-1 (0 when no pattern or no usable input). */
  strength: number;
  /** Field-presence completeness 0-1 over the detector-relevant input groups. */
  completeness: number;
  /** "venue" when venue-split goal rates fed the detector; "overall" when the
   *  season aggregates were the only goal-rate source; null when the fixture
   *  had no usable goal rates at all (detector not run). */
  basis: GreenFlagBasis | null;
  /** One-sentence dominant-trend summary; null when no pattern fired. */
  sentence: string | null;
  /** Single most-likely trap reason (backward-compatible — see trapFlags). */
  trapWarning: string | null;
  /** Every T1-T5 trap flag that fired (v6.2 §2.5.2) — rendered as individual
   *  red chips. Empty when nothing fired (not an error — most fixtures have
   *  no contradicting signal). */
  trapFlags: TrapFlag[];
  /** Plain-English "what this trap kind means" per fired trapFlags entry,
   *  same order/length as trapFlags — display-only, static per TrapKind. */
  trapMeanings: string[];
  recommended: string | null;
  /** Whether `recommended` was cross-checked against this fixture's actual
   *  scraped market list (event.detail.odds.allMarkets — every SportyBet
   *  market including exotic/specials/combo, not just the typed odds
   *  fields), and what was found. Display/audit-only: never fed back into
   *  detectPatterns or the recommendation itself — this answers "is the
   *  market the pattern leans on one SportyBet actually offered for this
   *  fixture", not "should the pattern have fired". */
  marketEvidence: MarketEvidence | null;
}

export interface MarketEvidence {
  /** true when at least one scraped market for this fixture's family+side
   *  matches the recommendation; false when the family exists in the scrape
   *  but no outcome matches the side; null-equivalent handled by the caller
   *  returning marketEvidence: null when the family isn't scraped at all. */
  found: boolean;
  /** Market ids (SportyBet) that matched, capped for display. */
  matchedMarketIds: string[];
  /** Human-readable outcome descriptions actually seen in the scrape for the
   *  matched markets, e.g. "Over 2.5" or the exotic market's own desc text. */
  matchedOutcomes: string[];
  /** Count of DISTINCT scraped markets in this fixture's recommended family
   *  (any side) — context for "how many of this fixture's ~900 markets are
   *  even in-family", regardless of side-match. */
  familyMarketCount: number;
}

const KIND_LABEL: Record<PatternKind, string> = {
  heavy_superior: "Heavy Superior",
  goal_machine: "Goal Machine",
  btts_banker: "BTTS Banker",
  corner_kings: "Corner Kings",
  anomaly: "Hidden Value",
  h2h_dominance: "H2H Dominance",
  half_share: "Fast/Slow Starter",
};

/** Static, plain-English "what this pattern means and why it matters" text
 *  per kind — display-only context for a reader who doesn't know the v6.2
 *  catalog by name. Does not vary per fixture (the per-fixture numbers are
 *  already in `rationale`); this is the definition, `rationale` is the
 *  evidence. Kept in one place so the wording stays consistent between the
 *  chip explainer and the one-sentence summary. */
const KIND_MEANING: Record<PatternKind, string> = {
  heavy_superior:
    "One side clearly outscores AND outdefends its opponent at this venue (goals for minus goals against, split home/away) — a real quality gap rather than a coin-flip, so the model leans that side's Asian Handicap instead of a straight-up bet.",
  goal_machine:
    "Both sides' venue-adjusted expected goals run high (from scoring/conceding rates and Over-2.5 history) — the fixture trends toward a high-scoring match, favouring Over 2.5 or BTTS Yes over a low-scoring outcome.",
  btts_banker:
    "Both teams have a high venue rate of scoring in the same match AND neither keeps clean sheets often — a distinct, stricter signal than Goal Machine (which can fire on a one-sided high-scoring game where BTTS is actually unlikely).",
  corner_kings:
    "One side or the fixture overall draws an unusually high combined corner count at this venue (corners for + opponent's corners against) — a set-piece/territory signal for the Corners Over market specifically, separate from the goals model.",
  anomaly:
    "The team that looks stronger on venue-split form (goal difference, streak) is priced by the market as if it weren't — either underpriced odds or a live win/loss streak the price hasn't caught up with. This is the model finding value the market may have missed, not a guaranteed win.",
  h2h_dominance:
    "Head-to-head history between these exact two teams — same side has won most recent meetings at this venue, or the last several meetings all went Over 2.5 / both-teams-scored regardless of current form. History repeating is weaker evidence than current-season form, so this pattern needs several qualifying meetings before it fires.",
  half_share:
    "One or both sides show a lopsided share of their goals coming in the first half vs second half (a genuine fast-starter or slow-starter tendency) — leans a 1st-half or 2nd-half Over/Under total, which is a market the engine can actually price (unlike HT/FT combo bets, which aren't priced by this model at all).",
};

const TRAP_MEANING: Record<TrapKind, string> = {
  T1: "A reported key-player absence undercuts the pattern's reliability — the historical rates that produced this flag assumed a full-strength side.",
  T2: "One side is playing on unusually short rest against a well-rested opponent — fatigue/rotation risk the pattern's season-average numbers don't account for.",
  T3: "The side the pattern favours has actually failed to beat this specific opponent in recent head-to-head meetings — a direct historical contradiction worth weighing against the general trend.",
  T4: "The favoured side's recent scoring rate has dropped well below its season baseline — the pattern may be reading stale form rather than current form.",
  T5: "A short-priced market favourite with weak recent form — the market may be pricing reputation/history rather than how the team is actually playing right now.",
};

const fin = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** H2H Over-2.5 hit rate from the sidecar's recent meetings; null under 3
 *  scored meetings (too thin to call a trend). */
function h2hOversRate(stats: SportyBetStats): number | null {
  const matches = stats.h2h?.matches;
  if (!matches?.length) return null;
  let n = 0;
  let overs = 0;
  for (const m of matches) {
    if (fin(m.home_goals) && fin(m.away_goals)) {
      n++;
      if (m.home_goals + m.away_goals > 2.5) overs++;
    }
  }
  return n >= 3 ? overs / n : null;
}

/** Maps the sidecar's raw H2H match-by-match detail into the engine's
 *  current-fixture-relative H2hMeeting[] (G7 + T3) — does the team-name
 *  matching here so patterns.ts never needs to know about team names. The
 *  scraper documents `matches[]` as already most-recent-first
 *  (tools/scrape_fixtures.py's gismo notes), so no re-sort is needed here.
 *
 *  Requires BOTH historical sides to unambiguously cross-match the current
 *  fixture's two sides (in either orientation) before accepting a meeting.
 *  A single-sided check is not safe: `namesMatch`'s substring tolerance
 *  matches a parent club's name against its own reserve side (e.g. a
 *  historical "Barcelona" meeting would namesMatch BOTH "Barcelona" and
 *  "Barcelona B" in a first-team-vs-reserve fixture, a real, common case in
 *  the whitelisted lower-tier leagues) — an ambiguous or inconsistent
 *  pairing is skipped, never guessed. */
function buildH2hMeetings(event: SportyBetEvent, stats: SportyBetStats): H2hMeeting[] {
  const matches = stats.h2h?.matches;
  if (!matches?.length) return [];
  const out: H2hMeeting[] = [];
  for (const m of matches) {
    if (!fin(m.home_goals) || !fin(m.away_goals) || !m.home_team || !m.away_team) continue;
    const straightPairing =
      namesMatch(m.home_team, event.home) && namesMatch(m.away_team, event.away);
    const reversedPairing =
      namesMatch(m.home_team, event.away) && namesMatch(m.away_team, event.home);
    if (straightPairing === reversedPairing) continue; // ambiguous (both) or no match (neither)
    const homeIsCurrentHome = straightPairing;
    const currentHomeGoals = homeIsCurrentHome ? m.home_goals : m.away_goals;
    const currentAwayGoals = homeIsCurrentHome ? m.away_goals : m.home_goals;
    const result: H2hMeeting["result"] =
      currentHomeGoals > currentAwayGoals
        ? "home_win"
        : currentAwayGoals > currentHomeGoals
          ? "away_win"
          : "draw";
    out.push({
      result,
      totalGoals: m.home_goals + m.away_goals,
      btts: m.home_goals > 0 && m.away_goals > 0,
      atCurrentVenue: homeIsCurrentHome,
    });
  }
  return out;
}

/** Build the detector input from a scraped sidecar event. Returns null when
 *  no goal rates exist on either basis (detector would be meaningless). */
export function buildReportPatternInput(
  event: SportyBetEvent
): { input: PatternInput; basis: GreenFlagBasis; completeness: number } | null {
  const stats = event.detail?.stats;
  if (!stats) return null;

  const sc = stats.scoringConceding;
  const venueOk =
    fin(sc?.home?.scored_avg) &&
    fin(sc?.home?.conceded_avg) &&
    fin(sc?.away?.scored_avg) &&
    fin(sc?.away?.conceded_avg);
  const overallOk =
    fin(stats.goals?.home?.avg_scored) &&
    fin(stats.goals?.home?.avg_conceded) &&
    fin(stats.goals?.away?.avg_scored) &&
    fin(stats.goals?.away?.avg_conceded);
  if (!venueOk && !overallOk) return null;
  const basis: GreenFlagBasis = venueOk ? "venue" : "overall";

  const homeXgEntry = stats.xg?.home;
  const awayXgEntry = stats.xg?.away;
  // Prefer the venue-conditioned xG split when it exists (same preference as
  // buildStatsOverride's venue-xG gate), else the season aggregate.
  const pickXg = (e: typeof homeXgEntry, k: "xgf" | "xga"): number | undefined => {
    const venue = k === "xgf" ? e?.venueXgf : e?.venueXga;
    const season = k === "xgf" ? e?.xgf : e?.xga;
    if (fin(venue)) return venue;
    return fin(season) ? season : undefined;
  };

  const odds1x2 = event.detail?.odds?.["1x2"];
  const restH = stats.congestion?.home?.rest_days;
  const restA = stats.congestion?.away?.rest_days;
  const h2hRate = h2hOversRate(stats);

  // Recency-blend the scored side only (60/40 recent/season), conceded stays
  // flat-season — mirrors buildStatsOverride's scoredPer90H/A exactly
  // (sportyBetStats.ts:417-430) so this module's dominant numeric inputs
  // agree with what actually fed the live pick run.
  const rawScoredH = venueOk ? sc?.home?.scored_avg : stats.goals?.home?.avg_scored;
  const rawScoredA = venueOk ? sc?.away?.scored_avg : stats.goals?.away?.avg_scored;
  const blendedScoredH = blendRecencyScored(
    rawScoredH,
    stats.recentGoals?.home?.scored_avg,
    stats.form?.home?.last5
  );
  const blendedScoredA = blendRecencyScored(
    rawScoredA,
    stats.recentGoals?.away?.scored_avg,
    stats.form?.away?.last5
  );

  const input: PatternInput = venueOk
    ? {
        homeScoredHome: (blendedScoredH ?? sc?.home?.scored_avg) as number,
        homeConcededHome: sc?.home?.conceded_avg as number,
        awayScoredAway: (blendedScoredA ?? sc?.away?.scored_avg) as number,
        awayConcededAway: sc?.away?.conceded_avg as number,
        nHome: fin(sc?.home?.matches) ? sc?.home?.matches : undefined,
        nAway: fin(sc?.away?.matches) ? sc?.away?.matches : undefined,
      }
    : {
        homeScoredHome: (blendedScoredH ?? stats.goals?.home?.avg_scored) as number,
        homeConcededHome: stats.goals?.home?.avg_conceded as number,
        awayScoredAway: (blendedScoredA ?? stats.goals?.away?.avg_scored) as number,
        awayConcededAway: stats.goals?.away?.avg_conceded as number,
        nHome: fin(stats.standings?.home?.played) ? stats.standings?.home?.played : undefined,
        nAway: fin(stats.standings?.away?.played) ? stats.standings?.away?.played : undefined,
      };
  // leagueAvgGoals: static baseline table only — NOT lake-override-aware
  // (see header comment). Absent when the league isn't in the static table.
  if (event.league && fin(V3_LEAGUE_BASELINES[event.league])) {
    input.leagueAvgGoals = V3_LEAGUE_BASELINES[event.league];
  }

  input.homeXg = pickXg(homeXgEntry, "xgf");
  input.homeXga = pickXg(homeXgEntry, "xga");
  input.awayXg = pickXg(awayXgEntry, "xgf");
  input.awayXga = pickXg(awayXgEntry, "xga");
  // over25_pct / btts_rate / clean_sheet_rate / failed_to_score_rate are all
  // 0..1 in the sidecar (see buildStatsOverride's identical reads).
  if (fin(stats.overunder?.home?.over25_pct)) input.ou25PctH = stats.overunder?.home?.over25_pct;
  if (fin(stats.overunder?.away?.over25_pct)) input.ou25PctA = stats.overunder?.away?.over25_pct;
  if (fin(sc?.home?.btts_rate)) input.bttsPctH = sc?.home?.btts_rate;
  if (fin(sc?.away?.btts_rate)) input.bttsPctA = sc?.away?.btts_rate;
  if (fin(sc?.home?.clean_sheet_rate)) input.csPctH = sc?.home?.clean_sheet_rate;
  if (fin(sc?.away?.clean_sheet_rate)) input.csPctA = sc?.away?.clean_sheet_rate;
  if (fin(sc?.home?.failed_to_score_rate)) input.ftsPctH = sc?.home?.failed_to_score_rate;
  if (fin(sc?.away?.failed_to_score_rate)) input.ftsPctA = sc?.away?.failed_to_score_rate;

  // Corners: recent-5 preferred, season corners_avg fallback (for-only) —
  // mirrors buildStatsOverride's source order.
  const cForH = stats.recentCorners?.home ?? stats.possessionValue?.home?.corners_avg;
  const cForA = stats.recentCorners?.away ?? stats.possessionValue?.away?.corners_avg;
  if (fin(cForH)) input.cornersForH = cForH;
  if (fin(cForA)) input.cornersForA = cForA;
  if (fin(stats.recentCornersAgainst?.home))
    input.cornersAgainstH = stats.recentCornersAgainst?.home;
  if (fin(stats.recentCornersAgainst?.away))
    input.cornersAgainstA = stats.recentCornersAgainst?.away;

  const cards = (d: { yellow_avg?: number; red_avg?: number } | null | undefined) =>
    fin(d?.yellow_avg) ? d.yellow_avg + (fin(d?.red_avg) ? d.red_avg : 0) : undefined;
  input.cardsAvgH = cards(stats.disciplinary?.home);
  input.cardsAvgA = cards(stats.disciplinary?.away);

  if (fin(odds1x2?.home)) input.homeOdds = odds1x2?.home;
  if (fin(odds1x2?.draw)) input.drawOdds = odds1x2?.draw;
  if (fin(odds1x2?.away)) input.awayOdds = odds1x2?.away;
  if (fin(stats.form?.home?.streak)) input.streakH = stats.form?.home?.streak;
  if (fin(stats.form?.away?.streak)) input.streakA = stats.form?.away?.streak;
  const l5H = last5Points(stats.form?.home?.last5);
  const l5A = last5Points(stats.form?.away?.last5);
  if (l5H !== null) input.last5PtsH = l5H;
  if (l5A !== null) input.last5PtsA = l5A;
  if (h2hRate !== null) input.h2hOversRate = h2hRate;
  if (fin(restH) || fin(restA)) {
    input.restDaysMin = Math.min(fin(restH) ? restH : Infinity, fin(restA) ? restA : Infinity);
  }
  if (fin(restH)) input.restDaysH = restH;
  if (fin(restA)) input.restDaysA = restA;

  // First-half goal share (fast/slow-starter pattern + half_share detector) —
  // same fh/total ratio + clamp as buildStatsOverride's fhShare helper.
  const fhShareOf = (p: ScoringConcedingProfile | null | undefined) => {
    const fh = p?.goals_1h_avg;
    const total = p?.scored_avg;
    if (!fin(fh) || !fin(total) || total === 0) return undefined;
    return Math.min(0.8, Math.max(0.2, fh / total));
  };
  input.fhShareH = fhShareOf(sc?.home);
  input.fhShareA = fhShareOf(sc?.away);

  // Recent (last-5, proxying the doc's last-3) scored rate for T4.
  if (fin(stats.recentGoals?.home?.scored_avg)) {
    input.recentScoredH = stats.recentGoals?.home?.scored_avg;
  }
  if (fin(stats.recentGoals?.away?.scored_avg)) {
    input.recentScoredA = stats.recentGoals?.away?.scored_avg;
  }

  // Key-player availability (T1) — matchday-availability proxy, 0 = absent.
  if (stats.availability?.home?.keyPlayerPresent === 0) input.homeKeyPlayerOut = true;
  if (stats.availability?.away?.keyPlayerPresent === 0) input.awayKeyPlayerOut = true;

  // Per-meeting H2H (G7 + T3) — current-fixture-relative, team-name matched.
  const h2hMeetings = buildH2hMeetings(event, stats);
  if (h2hMeetings.length > 0) input.h2hMeetings = h2hMeetings;

  // Field-presence completeness over the detector-relevant input groups —
  // computed from what actually arrived, never the feed's self-assessment.
  const groups: boolean[] = [
    true, // goal rates (required to get here)
    fin(input.homeXg) && fin(input.awayXg),
    fin(input.ou25PctH) && fin(input.ou25PctA),
    fin(input.bttsPctH) && fin(input.bttsPctA),
    fin(input.cornersForH) && fin(input.cornersForA),
    fin(input.cardsAvgH) && fin(input.cardsAvgA),
    fin(input.streakH) && fin(input.streakA),
    input.h2hOversRate !== undefined,
    fin(input.homeOdds) && fin(input.awayOdds),
    fin(input.restDaysMin),
  ];
  const completeness = groups.filter(Boolean).length / groups.length;

  return { input, basis, completeness };
}

/** Bridge into the engine's "Data Analysis" panel (marketsV3/fixtureAnalysisPanel.ts)
 *  for the report layer — reuses the EXACT SAME PatternInput buildReportPatternInput
 *  already built for the Green Flags block (recency blending, league baselines, xG,
 *  corners, odds, etc), so this panel's numbers stay internally consistent with the
 *  green-flags read on the same fixture rather than re-deriving a second mapper.
 *  Named distinctly from the imported engine function (aliased above) to avoid a
 *  same-name shadow. Returns null when the fixture has no usable goal rates at all
 *  (mirrors buildReportPatternInput's own null contract). */
export function buildFixtureDataAnalysis(event: SportyBetEvent): FixtureAnalysisPanel | null {
  const built = buildReportPatternInput(event);
  if (!built) return null;
  return engineBuildFixtureAnalysisPanel(built.input, event.league ?? undefined);
}

const MAX_EVIDENCE_MARKETS = 6;

const norm = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, " ");

/** SportyBet market ids for the PLAIN/main version of each family a pattern
 *  recommendation can name — NOT "every market catalogued under this
 *  MarketFamily". MarketFamily is a coarse classification: e.g. "goals_ou"
 *  also covers Offsides O/U (900396), Early Goals (60180), and per-team
 *  Offsides (900568/900569), which all use "Over X.5"/"Under X.5" outcome
 *  text — a family-wide scan would let a scraped Offsides market falsely
 *  "confirm" a goals recommendation. Likewise "corners" is a declared
 *  MarketFamily value but the generated catalog never actually assigns it —
 *  real corners markets are classified "specials" with group "Corners"
 *  (tools/build_market_catalog.py), so family-only matching would make every
 *  Corner Kings recommendation permanently show "not found" even when
 *  corners odds were scraped. Pinning to the specific id(s) that represent
 *  the plain market closes both gaps. Source: packages/engine/src/markets/
 *  catalog.generated.ts (id → name/group/family). */
const CANONICAL_FAMILY_MARKET_IDS: Partial<Record<MarketFamily, readonly string[]>> = {
  goals_ou: ["18"], // "Over/Under", group "Main" — full-time total goals.
  btts: ["29"], // "GG/NG", group "Main" — plain both-teams-to-score.
  dnb: ["11"], // "Draw No Bet", group "Main" — the real 2-way DNB market.
  asian_handicap: ["16"], // "Handicap", group "Main".
  corners: ["166"], // "Corners - Over/Under", group "Corners".
};

/** Cross-check a pattern recommendation ("goals_ou" / "Over 2.5") against
 *  this fixture's actual scraped market list — event.detail.odds.allMarkets,
 *  the generic capture of EVERY SportyBet market including exotic/specials/
 *  combo, not just the typed odds fields (owner instruction 2026-07-19: the
 *  Green Flags block should reflect what was actually offered on this
 *  fixture, not just a generic family/side name). Display/audit-only — never
 *  fed back into detectPatterns or the recommendation itself.
 *
 *  Matching is a normalised substring check against ONLY the canonical
 *  market id(s) for this family (see CANONICAL_FAMILY_MARKET_IDS) — not
 *  every market sharing the same coarse MarketFamily. SportyBet outcome
 *  `desc` text is already human-readable ("Over 2.5", "Home", "Yes"), so a
 *  case-insensitive substring match against the recommended side string is
 *  reliable without re-parsing specifiers, once scoped to the right market.
 *  Returns null when this fixture's scrape has no allMarkets at all (nothing
 *  to check against) — a genuinely different state from "checked, but no
 *  matching outcome found". Also returns null for a recommendedFamily this
 *  module has no canonical id for yet (fails safe: no evidence claim rather
 *  than a family-wide false match). */
function matchMarketEvidence(
  event: SportyBetEvent,
  family: MarketFamily,
  side: string
): MarketEvidence | null {
  const all = event.detail?.odds?.allMarkets;
  if (!all?.length) return null;
  const canonicalIds = CANONICAL_FAMILY_MARKET_IDS[family];
  if (!canonicalIds?.length) return null;

  const sideNorm = norm(side);
  const familyIds = new Set<string>();
  const matchedMarketIds: string[] = [];
  const matchedOutcomes: string[] = [];

  for (const m of all) {
    // Match on the pinned id alone, not id+family: the catalog's own family
    // classification disagrees with the MarketFamily this module cares about
    // for corners specifically (id 166 "Corners - Over/Under" is catalogued
    // as family "specials", not "corners" — see CANONICAL_FAMILY_MARKET_IDS
    // header comment). The id pin is already the precise selector; requiring
    // catalog-family agreement on top would silently zero out corners again.
    if (!canonicalIds.includes(m.id)) continue;
    if (!lookupMarket(m.id)) continue; // must still be a known, catalogued market
    familyIds.add(m.id);
    for (const o of m.outcomes ?? []) {
      const desc = o.desc ?? "";
      if (!desc) continue;
      const descNorm = norm(desc);
      // Side match: exact, or one contains the other (handles corner-kings'
      // "Home Over 8.5" vs a scraped desc of "Over 8.5" under a market
      // already specific to the home team, and half_share's "1H Over" vs a
      // scraped "Over 0.5" under a First Half group).
      if (descNorm === sideNorm || descNorm.includes(sideNorm) || sideNorm.includes(descNorm)) {
        if (matchedMarketIds.length < MAX_EVIDENCE_MARKETS) {
          matchedMarketIds.push(m.id);
          matchedOutcomes.push(desc);
        }
      }
    }
  }

  return {
    found: matchedOutcomes.length > 0,
    matchedMarketIds,
    matchedOutcomes,
    familyMarketCount: familyIds.size,
  };
}

function sentence(report: PatternReport, basis: GreenFlagBasis): string | null {
  const top = report.topPattern;
  if (!top) return null;
  const deg = basis === "overall" ? "°" : "";
  const names = report.patterns
    .map((p) => `${KIND_LABEL[p.kind]}${p.side ? ` (${p.side})` : ""}${deg}`)
    .join(" + ");
  const rec =
    report.recommendedFamily && report.recommendedSide
      ? ` → leans ${report.recommendedFamily} ${report.recommendedSide}`
      : "";
  return `${names}${rec} (strength ${(report.strength * 100).toFixed(0)}%).`;
}

/** Run the shared detector over one sidecar fixture and summarize. Never
 *  throws; a fixture with no usable stats gets an empty summary. */
export function summarizeGreenFlags(event: SportyBetEvent): GreenFlagSummary {
  const empty: GreenFlagSummary = {
    flags: [],
    flagCount: 0,
    strength: 0,
    completeness: 0,
    basis: null,
    sentence: null,
    trapWarning: null,
    trapFlags: [],
    trapMeanings: [],
    recommended: null,
    marketEvidence: null,
  };
  try {
    const built = buildReportPatternInput(event);
    if (!built) return empty;
    const report = detectPatterns(built.input);
    const flags: GreenFlagChip[] = report.patterns.map((p) => ({
      kind: p.kind,
      label: `${KIND_LABEL[p.kind]}${p.side ? ` (${p.side})` : ""}`,
      basis: built.basis,
      score: p.score,
      rationale: p.rationale,
      meaning: KIND_MEANING[p.kind],
    }));
    const marketEvidence =
      report.recommendedFamily && report.recommendedSide
        ? matchMarketEvidence(event, report.recommendedFamily, report.recommendedSide)
        : null;
    return {
      flags,
      flagCount: flags.length,
      strength: report.strength,
      completeness: built.completeness,
      basis: built.basis,
      sentence: sentence(report, built.basis),
      trapWarning: report.trapWarning,
      trapFlags: report.trapFlags,
      trapMeanings: report.trapFlags.map((t: TrapFlag) => TRAP_MEANING[t.kind as TrapKind]),
      recommended:
        report.recommendedFamily && report.recommendedSide
          ? `${report.recommendedFamily} ${report.recommendedSide}`
          : null,
      marketEvidence,
    };
  } catch {
    return empty; // report enrichment must never break report generation
  }
}

/** Sort key for the report listing: most green flags first; venue basis
 *  outranks overall° at equal counts; then strength, then completeness. */
export function compareGreenFlagSummaries(a: GreenFlagSummary, b: GreenFlagSummary): number {
  if (b.flagCount !== a.flagCount) return b.flagCount - a.flagCount;
  const basisRank = (s: GreenFlagSummary) =>
    s.basis === "venue" ? 2 : s.basis === "overall" ? 1 : 0;
  if (basisRank(b) !== basisRank(a)) return basisRank(b) - basisRank(a);
  if (b.strength !== a.strength) return b.strength - a.strength;
  return b.completeness - a.completeness;
}

/** Slate-level dominant-trends line, e.g.
 *  "Slate profile: 14 Goal Machine · 9 Heavy Superior · 6 Corner Kings · 3 Hidden Value (of 122 fixtures)".
 *  Null when no fixture raised any flag. */
export function slateGreenFlagProfile(
  summaries: GreenFlagSummary[],
  fixtureCount: number
): string | null {
  const counts = new Map<GreenFlagChip["kind"], number>();
  for (const s of summaries) {
    for (const f of s.flags) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${KIND_LABEL[kind]}`);
  return `Slate profile: ${parts.join(" · ")} (of ${fixtureCount} fixtures)`;
}
