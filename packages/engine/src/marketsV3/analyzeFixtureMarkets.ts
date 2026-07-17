/** all-markets-analysis-prompt-v3 — deterministic all-markets orchestrator.
 *
 *  Per-fixture pipeline: §3.1 lambdas → §3.2 dual split (+ half-share split)
 *  → §0.2 feed-dictionary routing of the fixture's raw allMarkets catalogue →
 *  §3.3–§3.8 engines → §4.1 de-vig → §4.2 class → §5 tiered EV gate → the
 *  fixture's single best surviving selection (§4.3).
 *
 *  Zero LLM calls — pure deterministic script math, per the token-saving
 *  mandate. Pure function; all data arrives in the input struct. */

import type { V3PenaltyFlags } from "../goalsV3/edgeGate.js";
import {
  computeV3Lambdas,
  resolveRho,
  type V3LambdaInput,
  type V3Lambdas,
} from "../goalsV3/lambda.js";
import type { Devigged1x2 } from "../goalsV3/matchShape.js";
import { FAMILY_LABEL, familyOf, type MarketFamily } from "../markets/index.js";
import type { AllMarketEntry, EVMarket, Matrix } from "../types.js";
import { classifyMarket } from "./classes.js";
import { dirOfDesc, lineOfDesc, sideOfDesc } from "./descParse.js";
import { cardsMeans, priceCardsVariant } from "./engines/cards.js";
import { cornersMeans, priceCornersVariant } from "./engines/corners.js";
import { priceExoticsOutcome } from "./engines/exotics.js";
import { priceHalfOutcome, V3_FIRST_HALF_SHARE_DEFAULT } from "./engines/half.js";
import { priceResultOutcome } from "./engines/result.js";
import { priceShapeOutcome } from "./engines/shape.js";
import { priceShotsOutcome, shotsMeans } from "./engines/shots.js";
import { priceTimeWindow } from "./engines/time.js";
import { priceTotalsOutcome } from "./engines/totals.js";
import type { V3EngineCtx, V3Price } from "./engines/types.js";
import {
  gateAllMarkets,
  impliedQ,
  PATTERN_MIN_STRENGTH,
  PATTERN_RANK_BONUS,
  V3_EV_FLOOR_DEFAULT,
  type V3AllMarketsAssessment,
  type V3AllMarketsPenaltyFlags,
} from "./evGate.js";
import {
  isSkip,
  type RouteCoverage,
  routeCoverage,
  routeMarket,
  type V3Route,
} from "./feedDictionary.js";
import {
  type FinishingRegressionResult,
  shadowFinishingRegression,
} from "./finishingRegression.js";
import { buildV3Grid, buildV3HalfGrid } from "./grid.js";
import { detectPatterns, type PatternInput, type PatternReport } from "./patterns.js";
import { type RefereeCardsShadowResult, shadowRefereeCards } from "./refereeCardsShadow.js";
import { type DualSplit, deriveDualSplit } from "./split.js";

export interface V3EmpiricalInputs {
  bttsPctH?: number;
  bttsPctA?: number;
  csPctH?: number;
  csPctA?: number;
  ftsPctH?: number;
  ftsPctA?: number;
  /** Sample size (match count) behind the rates above — feeds the sample-scaled
   *  empirical blend (PR-3). */
  nH?: number;
  nA?: number;
  /** Season O/U hit-rates (0..1), venue split — feeds the totals engine's
   *  per-line marketStatMissing flag (PR-4). Not blended into totals pricing
   *  (totals stay model-only per §3.3), only a data-quality flag. */
  ou15PctH?: number;
  ou15PctA?: number;
  ou25PctH?: number;
  ou25PctA?: number;
  ou35PctH?: number;
  ou35PctA?: number;
}

export interface V3AllMarketsInput {
  fixtureId: string;
  runId: string;
  home: string;
  away: string;
  league: string;
  kickoff: string;
  lambdaInput: V3LambdaInput;
  devigged1x2: Devigged1x2 | null | undefined;
  allMarkets: AllMarketEntry[];
  fhShareH?: number;
  fhShareA?: number;
  empirical?: V3EmpiricalInputs;
  /** §3.9 conditional-module stats (PR-6) — feed V3EngineCtx.corners/.cards.
   *  The ORACLE_V3_CORNERS_CARDS rollback surface: buildV3Input forwards these
   *  only when the flag is on, so off ⇒ ctx stays null ⇒ dormant. */
  cornersForH?: number;
  cornersForA?: number;
  cornersAgainstH?: number;
  cornersAgainstA?: number;
  cardsAvgH?: number;
  cardsAvgA?: number;
  /** PR-22: 1x2/handicap/range/odd-even corners/cards variants. Default true
   *  (undefined ⇒ on) — ORACLE_V3_CORNERS_CARDS_EXT=off suppresses only these
   *  new variants; match/team-total O/U (the pre-PR-22 surface, gated by
   *  ORACLE_V3_CORNERS_CARDS above) are unaffected. */
  v3CornersCardsExt?: boolean;
  /** PR-22: shots-on-target module (engines/shots.ts) — season averages from
   *  sportyBetStats.ts's possessionValue block. Withheld (⇒ ctx.shots null,
   *  dormant) when ORACLE_V3_SHOTS_OU=off. */
  sotForH?: number;
  sotForA?: number;
  penaltyFlags: V3PenaltyFlags;
  edgeCap?: number;
  noiseGate?: number;
  xgBlend?: boolean;
  /** v3 HFA multiplier (§3.1a). Default 1.10. */
  hfa?: number;
  /** True when λ input uses venue-split data (suppress HFA). */
  venueSplitUsed?: boolean;
  /** λ v5 independent-side xG blend (ORACLE_V3_LAMBDA_V5). Default on. */
  lambdaV5?: boolean;
  /** Lake-computed league baselines (goals/game by league name) — prefer over
   *  the static V3_LEAGUE_BASELINES table when present (audit P0-2). */
  lakeBaselines?: Record<string, number>;
  /** v4 heightened gates: stricter bars, X excluded (PR-3). */
  heightened?: boolean;
  /** Per-league dynamic rho refit from the calibration ledger's observed
   *  scoreline frequencies (CalibrationMetrics.dynamicRhoParams, §8.1 NR-MLE).
   *  Falls back to the static getLeagueParams(league).baseRho when absent. */
  dynamicRho?: number;
  /** PR-25 item 2, shadow-only (see refereeCardsShadow.ts header) — the
   *  assigned referee's lake-computed shrunk cards-per-game rate
   *  (StatsOverride.refereeCardsRate). Never affects cardsAvgH/cardsAvgA,
   *  ctx.cards, or any priced cards outcome above — diagnostic-only input. */
  refereeCardsRate?: number;
  /** [refactor P0-2] Market-anchored blend (v5 §5.8) — see OracleConfig.v3Blend
   *  for the three-state contract. "off"/undefined ⇒ every gateAllMarkets call
   *  below runs with its own blendMode default ("off"), byte-identical to
   *  pre-P0-2 gating. */
  blendMode?: "off" | "shadow" | "on";
  /** [refactor P0-2] Weighted data-completeness, 0-1 SCALE (NOT the 0-100
   *  scale scoreCompleteness/MarketsV3GateResult.completeness.score use —
   *  producers must divide by 100 before setting this field). Absent ⇒ 0,
   *  the strictest wModel posture (see evGate.ts's computeMarketBlend). */
  completeness?: number;
  /** [refactor P0-2] True when this fixture's λ inputs include CONFIRMED,
   *  non-estimated xG (RunState.telemetry.xgMode === "empirical") — feeds
   *  wModel's +0.10 term. Absent/false ⇒ no xG-provenance credit. */
  hasRealXg?: boolean;
  /** [Wave 4-accuracy] v3BlendPricing (OracleConfig.v3BlendPricing) — see
   *  evGate.ts's gateAllMarkets opts.blendPricing for the full contract.
   *  Independent of blendMode above: forces the blend computation even when
   *  blendMode is "off". Default/absent ⇒ false, byte-identical gating AND
   *  byte-identical evMarket/assessment output to pre-Wave-4 behavior. */
  blendPricing?: boolean;
  /** [Wave 4-accuracy] v3TotalsEmpirical (OracleConfig.v3TotalsEmpirical) —
   *  threads into ctx.totalsEmpirical, gating engines/totals.ts's O/U
   *  1.5/2.5/3.5 empirical hit-rate blend. Absent behaves as true (default on
   *  per OracleConfig's contract) — set false explicitly to withhold. */
  totalsEmpirical?: boolean;
  /** [X-carveout] OracleConfig.v3XCarveout — high-conviction Class X exception
   *  to the blendPricing gate. See evGate.ts's X_CARVEOUT_PENALTY_RESCALE
   *  header for conditions. Absent/"off" ⇒ byte-identical gating. */
  xCarveout?: "off" | "shadow" | "on";
  /** [patterns-engine Wave 2] OracleConfig.v3Patterns — pattern-backed
   *  class-edge relaxation mode (marketsV3/patterns.ts detector → evGate.ts
   *  gateAllMarkets patternMode). "off"/undefined ⇒ byte-identical gating (the
   *  detector still runs for reporting but never relaxes a bar). "shadow" tags
   *  would-pass candidates; "on" admits pattern-backed picks over the
   *  strength-scaled relaxed class_edge bar. See analyzeFixtureMarketsV3 below
   *  for where the fixture PatternInput is built and detectPatterns is called. */
  v3Patterns?: "off" | "shadow" | "on";
}

export interface V3MarketOutcomeAssessment extends V3AllMarketsAssessment {
  family: MarketFamily;
  marketId: string;
  marketName: string;
  outcomeId: string;
  desc: string;
  odds: number;
  mp: number;
  /** [Wave 4-accuracy] When v3BlendPricing is on, this outcome's `mp`/
   *  `rawEdge`/`adjustedEdge`/`ev` above are OVERWRITTEN with their blended
   *  equivalents (pBlend/rawEdgeBlend/adjustedEdgeBlend/blendEV) — see the
   *  per-outcome loop in analyzeFixtureMarketsV3 below for exactly where.
   *  This is the ONLY way to make safety/pipeline.ts's v3AssessmentsToEvMarkets
   *  (a different workstream's file, read-only to this change, which reads
   *  a.adjustedEdge/a.mp/a.rawEdge/a.ev directly) Kelly-stake off the
   *  anchored probability without editing that file. These four fields stash
   *  the TRUE model-only values that were displaced by the overwrite, so nothing
   *  is silently lost for any downstream consumer that wants the raw model
   *  read (R10 cross-check, v3Best/v3AssessmentStats reporting, calibration
   *  ledger). Present ONLY when the overwrite happened (v3BlendPricing on AND
   *  this candidate had blend fields — i.e. always, whenever blendPricing was
   *  requested, since evGate.ts computes blend unconditionally once asked). */
  mpModel?: number;
  rawEdgeModel?: number;
  adjustedEdgeModel?: number;
  evModel?: number;
}

export interface V3AllMarketsResult {
  lambdas: V3Lambdas;
  split: DualSplit;
  fhShare: number;
  fhShareIsDefault: boolean;
  coverage: RouteCoverage;
  /** Every gate-surviving OR capped assessment (report/transparency). */
  assessments: V3MarketOutcomeAssessment[];
  capped: V3MarketOutcomeAssessment[];
  /** Gate-surviving candidates, ranked by adjusted edge (best first). §4.3
   *  caps this to the fixture's single best per-run in the P6 output layer;
   *  the orchestrator returns the full survivor list so P3/P5 can splice
   *  whichever candidates they need into decide(). */
  evMarkets: EVMarket[];
  best: EVMarket | null;
  /** PR-25 item 2, shadow-only (see refereeCardsShadow.ts header) — never
   *  affects ctx.cards/evMarkets/best above. Null when either the cards
   *  module is dormant (no cardsAvgH/cardsAvgA), no referee was
   *  assigned/scraped for this fixture, or the divergence is below the
   *  module's report threshold. */
  refereeShadow: RefereeCardsShadowResult | null;
  /** PR-25 item 4, shadow-only (see finishingRegression.ts header) — never
   *  affects lambdas/evMarkets/best above. Empty candidates when neither side
   *  has FBref npxG coverage or neither diverges past the threshold. */
  finishingShadow: FinishingRegressionResult;
  /** [Wave 3, WS3-A] The stats-side scoreline grid already computed
   *  internally for market pricing — exposed so batch/index.ts's stage-2
   *  safety-pipeline shadow diff has a `Matrix` to pass into
   *  `CorrelationMatrix.compute` for v3's portfolio-correlation check (v3 has
   *  no other unified scoreline matrix the way the legacy engine's finalMat
   *  is one). Never used for pricing outside this file. */
  statsGrid: Matrix;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

function clampShare(v: number): number {
  return Math.min(0.8, Math.max(0.2, v));
}

function resolveFhShare(input: V3AllMarketsInput): { share: number; isDefault: boolean } {
  const { fhShareH, fhShareA } = input;
  if (typeof fhShareH === "number" && typeof fhShareA === "number") {
    return { share: clampShare((fhShareH + fhShareA) / 2), isDefault: false };
  }
  return { share: V3_FIRST_HALF_SHARE_DEFAULT, isDefault: true };
}

function priceOutcome(
  ctx: V3EngineCtx,
  route: V3Route,
  marketName: string,
  desc: string
): V3Price | null {
  switch (route.engine) {
    case "totals":
      return priceTotalsOutcome(ctx, route, desc, ctx.totalsEmpirical === true);
    case "result":
      return priceResultOutcome(ctx, route, marketName, desc);
    case "shape":
      return priceShapeOutcome(ctx, route, marketName, desc);
    case "half":
      return priceHalfOutcome(ctx, route, marketName, desc);
    case "time":
      return route.minute !== undefined ? priceTimeWindow(ctx.mu, route.minute, desc) : null;
    case "exotics":
      return priceExoticsOutcome(ctx, route, marketName, desc);
    case "corners": {
      if (!ctx.corners) return null;
      // PR-22: the new 1x2/handicap/range/odd-even variants are gated by
      // ORACLE_V3_CORNERS_CARDS_EXT; team-total/match-total O/U (the
      // pre-PR-22 surface) are unaffected — same "routing unconditional, ctx
      // gates pricing" convention ORACLE_V3_CORNERS_CARDS itself already uses.
      const newVariant =
        route.variant === "1x2" ||
        route.variant === "handicap" ||
        route.variant === "odd-even" ||
        route.variant === "range";
      if (newVariant && ctx.cornersCardsExt === false) return null;
      const p = priceCornersVariant(ctx.corners, desc, route.variant, route.side);
      return p !== null ? { p } : null;
    }
    case "cards": {
      if (!ctx.cards) return null;
      const newVariant =
        route.variant === "1x2" || route.variant === "handicap" || route.variant === "range";
      if (newVariant && ctx.cornersCardsExt === false) return null;
      const p = priceCardsVariant(ctx.cards, desc, route.variant, route.side);
      return p !== null ? { p } : null;
    }
    case "shots": {
      if (!ctx.shots) return null;
      const p = priceShotsOutcome(ctx.shots, desc, route.side);
      return p !== null ? { p } : null;
    }
    default:
      return null;
  }
}

const parseOdds = (raw: string | null | undefined): number | null => {
  const n = raw != null ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(n) && n > 1 ? n : null;
};

/** Devig context for one market: 2-way → the other outcome's odds; exactly
 *  3-way → the full outcome set (§4.1 normalise); else single-price. */
function impliedQFor(
  entry: AllMarketEntry,
  outcomeIdx: number,
  odds: number
): { q: number; devigged: boolean } | null {
  const oddsList = entry.outcomes.map((o) => parseOdds(o.odds));
  if (entry.outcomes.length === 2) {
    const other = oddsList[1 - outcomeIdx];
    return impliedQ(odds, other ?? undefined);
  }
  if (entry.outcomes.length === 3 && oddsList.every((o) => o !== null)) {
    return impliedQ(odds, undefined, oddsList as number[]);
  }
  return impliedQ(odds);
}

function isFiniteNum(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** [patterns-engine Wave 2] Best-effort clean 1X2 raw odds straight off the
 *  fixture's raw allMarkets catalogue. The plain-1X2 entry is routed to an
 *  explicit skip further down this same pipeline (feedDictionary.ts's
 *  "plain-1x2" reason, §3.4 insurance mandate) so it never reaches the
 *  per-outcome loop below — this reads it directly off the raw entry instead.
 *  `input.devigged1x2` (goalsV3/matchShape.ts) only exposes de-vigged
 *  PROBABILITIES (pHome/pDraw/pAway), never raw odds, so it cannot serve as a
 *  fallback odds source here — there is nothing to fall back to. Returns {}
 *  (every field undefined) unless all three sides parse as clean odds — a
 *  partial read is worse than none for the detector's anomaly signal, which
 *  keys directly off the favourite's raw price. */
function extract1x2Odds(allMarkets: AllMarketEntry[]): {
  homeOdds?: number;
  drawOdds?: number;
  awayOdds?: number;
} {
  for (const entry of allMarkets) {
    if (familyOf(entry.id) !== "match_result") continue;
    let homeOdds: number | undefined;
    let drawOdds: number | undefined;
    let awayOdds: number | undefined;
    for (const outcome of entry.outcomes) {
      const desc = (outcome.desc ?? "").toLowerCase().trim();
      const odds = parseOdds(outcome.odds);
      if (odds == null) continue;
      if (desc === "home" || desc === "1") homeOdds = odds;
      else if (desc === "draw" || desc === "x") drawOdds = odds;
      else if (desc === "away" || desc === "2") awayOdds = odds;
    }
    if (homeOdds != null && drawOdds != null && awayOdds != null) {
      return { homeOdds, drawOdds, awayOdds };
    }
  }
  return {};
}

/** [patterns-engine Wave 2] Build the fixture-level PatternInput once (see the
 *  detectPatterns call site in analyzeFixtureMarketsV3 below) from the same
 *  V3AllMarketsInput fields the rest of this pipeline already reads. Returns
 *  null (no pattern signal computed) when the four REQUIRED venue-split goal
 *  rates aren't present as real numbers — patterns.ts documents everything
 *  else as optional/degrading, but not these four; a 0-fallback here would
 *  fabricate a false superiority/mismatch signal rather than skip cleanly.
 *
 *  NOTE — V3LambdaInput has no dedicated "true venue split" vs "pooled
 *  team-overall" pair of fields; homeScoredPer90/homeConcededPer90/
 *  awayScoredPer90/awayConcededPer90 (§3.1's own λ formula input) are the
 *  closest genuine fields and serve double duty as either, distinguished only
 *  by the separate input.venueSplitUsed boolean (not carried per-field). Used
 *  as-is regardless of that flag: when it's pooled data rather than a true
 *  venue split, the resulting pattern is proportionally less precise, which
 *  is exactly what the detector's own sample-size shrink already discounts
 *  for (patterns.ts's sampleShrink). */
function buildFixturePatternInput(input: V3AllMarketsInput): PatternInput | null {
  const li = input.lambdaInput;
  if (
    !isFiniteNum(li.homeScoredPer90) ||
    !isFiniteNum(li.homeConcededPer90) ||
    !isFiniteNum(li.awayScoredPer90) ||
    !isFiniteNum(li.awayConcededPer90)
  ) {
    return null;
  }
  const odds = extract1x2Odds(input.allMarkets);
  return {
    homeScoredHome: li.homeScoredPer90,
    homeConcededHome: li.homeConcededPer90,
    awayScoredAway: li.awayScoredPer90,
    awayConcededAway: li.awayConcededPer90,
    homeXg: li.homeXg?.xgf ?? undefined,
    awayXg: li.awayXg?.xgf ?? undefined,
    homeXga: li.homeXg?.xga ?? undefined,
    awayXga: li.awayXg?.xga ?? undefined,
    ou25PctH: input.empirical?.ou25PctH,
    ou25PctA: input.empirical?.ou25PctA,
    bttsPctH: input.empirical?.bttsPctH,
    bttsPctA: input.empirical?.bttsPctA,
    csPctH: input.empirical?.csPctH,
    csPctA: input.empirical?.csPctA,
    ftsPctH: input.empirical?.ftsPctH,
    ftsPctA: input.empirical?.ftsPctA,
    cornersForH: input.cornersForH,
    cornersForA: input.cornersForA,
    cornersAgainstH: input.cornersAgainstH,
    cornersAgainstA: input.cornersAgainstA,
    cardsAvgH: input.cardsAvgH,
    cardsAvgA: input.cardsAvgA,
    leagueAvgGoals: input.lakeBaselines?.[input.league],
    nHome: input.empirical?.nH,
    nAway: input.empirical?.nA,
    homeOdds: odds.homeOdds,
    drawOdds: odds.drawOdds,
    awayOdds: odds.awayOdds,
    // streak/last5/h2h/restDaysMin/mappedFamiliesWithStats intentionally
    // absent — not yet threaded from V3AllMarketsInput (a later wave per this
    // wave's own task brief); detectPatterns degrades gracefully without them.
  };
}

/** [patterns-engine Wave 2] Conservative family-aware match between a priced
 *  outcome's desc and the detector's recommendedSide string. A false positive
 *  here relaxes the class-edge gate for the WRONG pick (real-money gate
 *  math), so every branch prefers returning false over guessing:
 *   - exact (case-insensitive) match always wins first.
 *   - btts: exact "yes"/"no" only (dirOfDesc/sideOfDesc don't parse this
 *     shape) — the exact check above already covers it.
 *   - asian_handicap/dnb/handicap: side-only, via descParse.ts's sideOfDesc
 *     (the same classifier sanity.ts's own result-skew check uses).
 *     KNOWN, ACCEPTED LIMITATION (adversarial review, 2026-07-16): patterns.ts
 *     never recommends a specific handicap LINE (detectHeavySuperior only
 *     names a side — "Home"/"Away" — deliberately, since line selection is the
 *     wave-3 AH-pivot's job, not this detector's), so this matches EVERY line
 *     on the recommended side (Home -3.5 and Home +0.5 both qualify). Bounded
 *     by the unrelaxed EV%/max-odds/value-floor bars on every line regardless
 *     — a wrong-line match still can't pass without genuine EV — but it does
 *     mean one green-flag broadens the relaxation across the whole side's AH
 *     book. Revisit once wave-3 lands a real recommended line to match against.
 *   - goals_ou/team_total: direction-only, via dirOfDesc. The detector only
 *     ever emits a fixed "Over 2.5" for goals_ou today (patterns.ts's
 *     detectGoalMachine), so this only widens beyond the exact line if a
 *     future pattern kind varies it — direction is still the correct axis to
 *     match on for a goal-trend recommendation.
 *   - corners: same side (when the recommendation names one) AND the
 *     recommended numeric line must match in desc EXACTLY (descParse.ts's
 *     anchored lineOfDesc, not a substring check).
 *   - anything else: exact match only (already checked above) — no guessing
 *     for a family none of the four current pattern kinds ever recommend. */
function sideMatches(desc: string, recommendedSide: string, family: MarketFamily): boolean {
  const rs = recommendedSide.trim();
  const rsLower = rs.toLowerCase();
  const descLower = desc.trim().toLowerCase();
  if (descLower === rsLower) return true;

  if (family === "asian_handicap" || family === "dnb" || family === "handicap") {
    const rsSide = sideOfDesc(rs);
    return rsSide !== null && sideOfDesc(desc) === rsSide;
  }
  if (family === "goals_ou" || family === "team_total") {
    const rsDir = dirOfDesc(rs);
    return rsDir !== null && dirOfDesc(desc) === rsDir;
  }
  if (family === "corners") {
    const rsSide = sideOfDesc(rs); // null for a total-corners recommendation
    if (rsSide !== null && sideOfDesc(desc) !== rsSide) return false;
    // Anchored line match (descParse.ts's lineOfDesc) — NOT a substring check:
    // `desc.includes(lineMatch[1])` would spuriously match "Over 8.5" against
    // "Over 18.5"/"Over 28.5" (adversarial review finding, 2026-07-16).
    const rsLine = lineOfDesc(rs);
    const descLine = lineOfDesc(desc);
    if (rsLine === null || descLine === null) return false;
    return descLine === rsLine && dirOfDesc(desc) === dirOfDesc(rs);
  }
  return false;
}

export function analyzeFixtureMarketsV3(input: V3AllMarketsInput): V3AllMarketsResult | null {
  const lambdas = computeV3Lambdas(input.lambdaInput, {
    xgBlend: input.xgBlend,
    hfa: input.hfa,
    venueSplitUsed: input.venueSplitUsed,
    lambdaV5: input.lambdaV5,
    lakeBaselines: input.lakeBaselines,
  });
  if (!lambdas) return null;

  const rho = resolveRho(input.league, input.dynamicRho);
  const split = deriveDualSplit(lambdas, input.devigged1x2);
  const statsGrid = buildV3Grid(split.stats.lambdaHome, split.stats.lambdaAway, rho);
  const shapeGrid = buildV3Grid(split.odds.lambdaHome, split.odds.lambdaAway, rho);

  const { share: fhShare, isDefault: fhShareIsDefault } = resolveFhShare(input);
  const halfPair = (lH: number, lA: number): [Matrix, Matrix] => [
    buildV3HalfGrid(lH * fhShare, lA * fhShare),
    buildV3HalfGrid(lH * (1 - fhShare), lA * (1 - fhShare)),
  ];

  const ctx: V3EngineCtx = {
    statsGrid,
    shapeGrid,
    mu: lambdas.mu,
    split,
    fhShare,
    fhShareIsDefault,
    halfStats: halfPair(split.stats.lambdaHome, split.stats.lambdaAway),
    halfShape: halfPair(split.odds.lambdaHome, split.odds.lambdaAway),
    empirical: input.empirical ?? {},
    corners: cornersMeans({
      cornersForH: input.cornersForH,
      cornersForA: input.cornersForA,
      cornersAgainstH: input.cornersAgainstH,
      cornersAgainstA: input.cornersAgainstA,
    }),
    cards: cardsMeans({ cardsAvgH: input.cardsAvgH, cardsAvgA: input.cardsAvgA }),
    cornersCardsExt: input.v3CornersCardsExt !== false,
    shots: shotsMeans({ sotForH: input.sotForH, sotForA: input.sotForA }),
    totalsEmpirical: input.totalsEmpirical !== false,
  };

  // [patterns-engine Wave 2] Compute the fixture's pattern report ONCE, before
  // the per-outcome loop — only when the flag is active. "off"/undefined
  // skips the detector entirely (patternReport stays null), so every
  // downstream read below (patternBacked/patternMode/rankingScore) is
  // byte-identical to pre-Wave-2 output on the flag-off path.
  let patternReport: PatternReport | null = null;
  if (input.v3Patterns && input.v3Patterns !== "off") {
    const patternInput = buildFixturePatternInput(input);
    if (patternInput) patternReport = detectPatterns(patternInput);
  }

  const coverage = routeCoverage(input.allMarkets);
  const assessments: V3MarketOutcomeAssessment[] = [];
  const capped: V3MarketOutcomeAssessment[] = [];
  const evMarkets: EVMarket[] = [];

  for (const entry of input.allMarkets) {
    const route = routeMarket(entry);
    if (isSkip(route)) continue;
    const marketName = entry.name ?? entry.desc ?? "";

    entry.outcomes.forEach((outcome, idx) => {
      const desc = outcome.desc ?? "";
      const odds = parseOdds(outcome.odds);
      if (!odds || !desc) return;
      const price = priceOutcome(ctx, route, marketName, desc);
      if (!price) return;

      const q = impliedQFor(entry, idx, odds);
      if (!q) return;

      const marketClass = classifyMarket(route.family, odds);
      const flags: V3AllMarketsPenaltyFlags = {
        ...input.penaltyFlags,
        exoticClass: marketClass === "X",
        marketStatMissing: price.marketStatMissing === true,
        shapeDisagreement: price.resultClass === true && split.shapeDisagreement,
      };

      // [patterns-engine Wave 2] This outcome is pattern-backed when the
      // fixture detector fired a strong-enough pattern (>= PATTERN_MIN_STRENGTH)
      // whose recommended family+side matches THIS outcome (sideMatches is
      // conservative by design — see its own header). patternReport is always
      // null on the flag-off path, so patternBacked is always false there.
      const patternBacked =
        patternReport != null &&
        patternReport.topPattern != null &&
        patternReport.strength >= PATTERN_MIN_STRENGTH &&
        patternReport.recommendedFamily === route.family &&
        patternReport.recommendedSide != null &&
        sideMatches(desc, patternReport.recommendedSide, route.family);

      const gate = gateAllMarkets(price.p, q, odds, marketClass, flags, {
        edgeCap: input.edgeCap,
        noiseGate: input.noiseGate,
        heightened: input.heightened,
        // Bug fix (review finding): evFloor was wired into gateAllMarkets'
        // pass condition but never actually passed by this, its only live
        // call site — the default was silently doing the work invisibly.
        // Explicit here so the contract is visible; V3_EV_FLOOR_DEFAULT (0)
        // is unchanged, so this is not a behavior change.
        evFloor: V3_EV_FLOOR_DEFAULT,
        blendMode: input.blendMode,
        completeness: input.completeness,
        hasRealXg: input.hasRealXg,
        blendPricing: input.blendPricing,
        xCarveout: input.xCarveout,
        patternMode: input.v3Patterns,
        patternBacked,
        patternStrength: patternReport?.strength ?? 0,
      });

      // [Wave 4-accuracy] When blendPricing is on, gate.pBlend/rawEdgeBlend/
      // adjustedEdgeBlend/blendEV are always populated (evGate.ts computes
      // blend unconditionally whenever blendPricing is requested) — swap them
      // in as the PRIMARY mp/rawEdge/adjustedEdge/ev values for both the
      // assessment and the evMarket below, per this file's own
      // V3MarketOutcomeAssessment doc comment. Off (or a candidate that
      // somehow lacks blend fields — defensive) ⇒ every value below is
      // exactly the pre-Wave-4 model-only quantity, byte-identical output.
      const useBlendPrimary = input.blendPricing === true && gate.pBlend !== undefined;
      const mpValue = useBlendPrimary ? gate.pBlend! : price.p;
      const rawEdgeValue = useBlendPrimary ? gate.rawEdgeBlend! : gate.rawEdge;
      // [X-carveout] An admitted carve-out pick stakes/ranks on the rescaled
      // edge the carve-out itself evaluated (≥ 0.02 by construction) — the
      // standard adjustedEdgeBlend is ≤ −0.002 for every X candidate (the
      // unreachability the flag bypasses), and passing that downstream would
      // zero-Kelly and bottom-rank the pick. Shadow passes stay on the honest
      // blend value (they never reach evMarkets anyway).
      const adjustedEdgeValue = useBlendPrimary
        ? gate.xCarveout === "passed" && gate.adjustedEdgeCarveout !== undefined
          ? gate.adjustedEdgeCarveout
          : gate.adjustedEdgeBlend!
        : gate.adjustedEdge;
      const evValue = useBlendPrimary ? gate.blendEV! : gate.ev;

      const assessment: V3MarketOutcomeAssessment = {
        ...gate,
        family: route.family,
        marketId: entry.id,
        marketName,
        outcomeId: outcome.id,
        desc,
        odds,
        mp: round3(mpValue),
        rawEdge: rawEdgeValue,
        adjustedEdge: adjustedEdgeValue,
        ev: evValue,
        ...(useBlendPrimary
          ? {
              mpModel: round3(price.p),
              rawEdgeModel: gate.rawEdge,
              adjustedEdgeModel: gate.adjustedEdge,
              evModel: gate.ev,
            }
          : {}),
      };
      assessments.push(assessment);
      if (gate.outcome === "capped") capped.push(assessment);
      if (gate.outcome !== "done" || !gate.confidence) return;

      const label = FAMILY_LABEL[route.family];
      // [patterns-engine Wave 2] Ranking boost — "on" mode only, and only for
      // an admitted (outcome "done", already guaranteed by the guard above)
      // pattern-backed pick. Scaled by detector strength so a marginal
      // pattern nudges the rank less than a strong one. Off/shadow modes (or
      // a non-pattern-backed pick) leave rankingScore exactly adjustedEdgeValue
      // — byte-identical to pre-Wave-2 output.
      const rankingScore =
        patternBacked && input.v3Patterns === "on"
          ? adjustedEdgeValue + PATTERN_RANK_BONUS * (patternReport?.strength ?? 0)
          : adjustedEdgeValue;
      evMarkets.push({
        cat: label,
        label: desc,
        market: label,
        side: desc,
        family: route.family,
        mp: mpValue,
        modelProb: mpValue,
        ip: gate.q,
        rawEdge: gate.rawEdge,
        ev: evValue,
        odds,
        stake: 0,
        stakeAmt: 0,
        rankingScore,
        varianceMod: 1,
      });
    });
  }

  evMarkets.sort((a, b) => b.rankingScore - a.rankingScore);

  const refereeShadow = shadowRefereeCards({
    modelCardsMean: ctx.cards?.total,
    refereeCardsRate: input.refereeCardsRate,
  });

  const finishingShadow = shadowFinishingRegression({
    homeNpxgf: input.lambdaInput.homeNpxgf,
    homeScoredPer90: input.lambdaInput.homeScoredPer90,
    awayNpxgf: input.lambdaInput.awayNpxgf,
    awayScoredPer90: input.lambdaInput.awayScoredPer90,
  });

  return {
    lambdas,
    split,
    fhShare,
    fhShareIsDefault,
    coverage,
    assessments,
    capped,
    evMarkets,
    best: evMarkets[0] ?? null,
    refereeShadow,
    finishingShadow,
    statsGrid,
  };
}
