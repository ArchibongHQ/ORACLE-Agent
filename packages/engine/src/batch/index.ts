/** Batch runner — Phase 3.
 *  parseFixtureList: text → FixtureJob[]. runBatch: sequential, resilient, progress events. */

import type { StoragePort } from "@oracle/storage";
import type { CalibrationMetrics } from "../calibration/index.js";
import { makeCalibFactorResolver } from "../calibration/index.js";
import type { DecisionContext, FeedIntegritySignal, SlateSanitySignal } from "../decision/index.js";
import {
  buildEligibleBets,
  decide,
  logPickDisagreement,
  validateSelection,
} from "../decision/index.js";
import type { MarketExecutorRiskParams } from "../decision/marketExecutor.js";
import { applyConvergenceTierToStake, ExecutionEngine } from "../execution/index.js";
import { SHRINK_N } from "../goalsV3/lambda.js";
import { devigThreeWay, FAMILY_LABEL, type MarketFamily } from "../markets/index.js";
import {
  analyzeFixtureMarketsV3,
  sideMatches,
  type V3AllMarketsInput,
  type V3MarketOutcomeAssessment,
} from "../marketsV3/analyzeFixtureMarkets.js";
import type { V3AllMarketsAssessment } from "../marketsV3/evGate.js";
import { PATTERN_MIN_STRENGTH, PATTERN_RANK_BONUS } from "../marketsV3/evGate.js";
import { computeTailMarkets, type RouteCoverage } from "../marketsV3/feedDictionary.js";
import type { V3DeliveryCandidate, V3OutputCandidate } from "../marketsV3/outputs.js";
import { detectPatterns, type PatternInput, type PatternReport } from "../marketsV3/patterns.js";
import { buildRatingsLambdaInput, TeamRatingsEngine } from "../ratings/index.js";
import {
  buildSafetyShadowDiff,
  runSafetyPipeline,
  type SafetyPipelineResult,
  type SafetyShadowDiff,
  v3AssessmentsToEvMarkets,
} from "../safety/pipeline.js";
import { isUnderDesc } from "../safety/underBan.js";
import type {
  AgentError,
  AgentErrorCode,
  AllMarketEntry,
  DecisionOutput,
  DecisionReplay,
  DecisionShadow,
  EVMarket,
  OracleConfig,
  RankingMode,
  RunResult,
  RunState,
  SoftContextItem,
} from "../types.js";
import { computeMarketExecutorConcurrency } from "./marketExecutorConcurrency.js";

/** Build v3's per-fixture input from RunState.telemetry (populated by the
 *  runtime layer's buildStatsOverride — see sportyBetStats.ts) + the raw
 *  allMarkets catalogue already extracted for the Q4 executor. Returns null
 *  when there's nothing to analyze (no catalogue) — the caller fails open to
 *  the legacy eligible list in that case, same as every other soft-fail path
 *  in this pipeline. Exported for direct unit testing of the
 *  v3CornersCards/v3ShotsOu rollback-surface gating (review-caught gap —
 *  previously only the env-var→boolean parse was tested, not this function's
 *  actual withhold behavior). */
export function buildV3Input(
  job: { home: string; away: string; league: string; kickoff: string },
  state: RunState,
  allMarkets: AllMarketEntry[] | undefined,
  config?: {
    v3Hfa?: number;
    v3HfaByLeague?: Record<string, number>;
    v3VenueSplitUsed?: boolean;
    v3LambdaV5?: boolean;
    v3LakeBaselines?: Record<string, number>;
    v3GatesV4?: boolean;
    v3CornersCards?: boolean;
    v3CornersCardsExt?: boolean;
    v3ShotsOu?: boolean;
    /** [refactor P0-2] Market-anchored blend three-state — see OracleConfig.v3Blend. */
    v3Blend?: "off" | "shadow" | "on";
    /** [Wave 4-accuracy] See OracleConfig.v3BlendPricing. */
    v3BlendPricing?: "on" | "off";
    /** [Wave 4-accuracy] See OracleConfig.v3TotalsEmpirical. */
    v3TotalsEmpirical?: "on" | "off";
    /** [X-carveout] See OracleConfig.v3XCarveout. */
    v3XCarveout?: "off" | "shadow" | "on";
    /** [Wave 2] See OracleConfig.v3Patterns. */
    v3Patterns?: "off" | "shadow" | "on";
  },
  /** [Wave 3, WS3-A] Diagnostic-only pi-ratings signal (see ratings/index.ts's
   *  buildRatingsLambdaInput header) — attached to lambdaInput but never
   *  flips opts.ratingsBlend here (that stays a Wave-3-caller decision gated
   *  on the walk-forward harness, per that function's wiring contract). */
  ratingsInput?: { ratingsXgd: number; ratingsN: number }
): V3AllMarketsInput | null {
  if (!allMarkets?.length) return null;
  const t = state.telemetry ?? {};

  const devigged1x2 =
    t.hOdds && t.dOdds && t.aOdds
      ? (() => {
          const d = devigThreeWay(t.hOdds, t.dOdds, t.aOdds);
          return d ? { pHome: d[0], pDraw: d[1], pAway: d[2] } : null;
        })()
      : null;

  const h2hBlock = (t.rawStatsBlock as { h2h?: { total?: number } } | undefined)?.h2h;
  const hasLineups = (t.softContext ?? []).some((s) => s.kind === "lineup");

  return {
    fixtureId: `${job.home}::${job.away}::${job.kickoff}`,
    runId: "batch",
    home: job.home,
    away: job.away,
    league: job.league,
    kickoff: job.kickoff,
    lambdaInput: {
      league: job.league,
      homeScoredPer90: t.scoredPer90H ?? null,
      homeConcededPer90: t.concededPer90H ?? null,
      awayScoredPer90: t.scoredPer90A ?? null,
      awayConcededPer90: t.concededPer90A ?? null,
      nHome: t.nHome ?? null,
      nAway: t.nAway ?? null,
      homeXg: t.xgfH != null ? { xgf: t.xgfH, xga: t.xgaH } : null,
      awayXg: t.xgfA != null ? { xgf: t.xgfA, xga: t.xgaA } : null,
      homeNpxgf: t.npxgfH ?? null,
      awayNpxgf: t.npxgfA ?? null,
      // §8.2 (PR-6): tool-derived squad availability, not an LLM guess — was
      // wired into the goals-only pipeline only; the all-markets pipeline
      // silently priced every non-goals market without it until now.
      homeAvailabilityMult: t.homeAvailabilityMult ?? null,
      awayAvailabilityMult: t.awayAvailabilityMult ?? null,
      ratingsXgd: ratingsInput?.ratingsXgd ?? null,
      ratingsN: ratingsInput?.ratingsN ?? null,
    },
    devigged1x2,
    allMarkets,
    fhShareH: t.fhShareH,
    fhShareA: t.fhShareA,
    empirical: {
      bttsPctH: t.bttsPctH,
      bttsPctA: t.bttsPctA,
      csPctH: t.csPctH,
      csPctA: t.csPctA,
      ftsPctH: t.ftsPctH,
      ftsPctA: t.ftsPctA,
      nH: t.formNH,
      nA: t.formNA,
      ou15PctH: t.ouO15H,
      ou15PctA: t.ouO15A,
      ou25PctH: t.ouO25H,
      ou25PctA: t.ouO25A,
      ou35PctH: t.ouO35H,
      ou35PctA: t.ouO35A,
    },
    // §3.9 corners/cards stats — withheld when ORACLE_V3_CORNERS_CARDS=off so
    // the modules stay dormant (the rollback surface; routing is unconditional).
    ...(config?.v3CornersCards !== false
      ? {
          cornersForH: t.cornersForH,
          cornersForA: t.cornersForA,
          cornersAgainstH: t.cornersAgainstH,
          cornersAgainstA: t.cornersAgainstA,
          squadHeightH: t.squadHeightH,
          squadHeightA: t.squadHeightA,
          cardsAvgH: t.cardsAvgH,
          cardsAvgA: t.cardsAvgA,
        }
      : {}),
    // PR-22: shots-on-target stats — same withhold-on-off rollback surface.
    ...(config?.v3ShotsOu !== false ? { sotForH: t.sotForH, sotForA: t.sotForA } : {}),
    // PR-25 item 2, shadow-only — feeds refereeShadow, never ctx.cards/pricing.
    refereeCardsRate: t.refereeCardsRate,
    // [patterns-engine Wave 2, Phase 0] Feeds buildFixturePatternInput's
    // PatternInput.streakH/A + last5PtsH/A below (marketsV3/patterns.ts).
    streakH: t.streakH,
    streakA: t.streakA,
    last5PtsH: t.last5PtsH,
    last5PtsA: t.last5PtsA,
    // [2026-07-20] Feeds buildFixturePatternInput's PatternInput.h2hOversRate
    // (marketsV3/patterns.ts) — previously report-only, reconnected to the
    // live picker (see analyzeFixtureMarkets.ts's V3AllMarketsInput doc).
    h2hOversRate: t.h2hOversRate,
    penaltyFlags: {
      // Desktop-audit concept #3: graduated xG-missing penalty. Mutually
      // exclusive with xgMissingLargeSample — full -2pt only when the
      // raw-goals sample is ALSO thin (n<SHRINK_N either side); once both
      // sides clear SHRINK_N the raw-goals lambda is already fully trusted
      // (shrink() applies zero pull toward the league mean), so losing xG's
      // smoothing costs less: -1pt, same tier as xgEstimated.
      xgMissing: t.xgMode == null && ((t.nHome ?? 0) < SHRINK_N || (t.nAway ?? 0) < SHRINK_N),
      xgMissingLargeSample:
        t.xgMode == null && (t.nHome ?? 0) >= SHRINK_N && (t.nAway ?? 0) >= SHRINK_N,
      xgEstimated: t.xgMode === "estimated",
      h2hMissing: !((h2hBlock?.total ?? 0) > 0),
      lineupsUnconfirmed: !hasLineups,
      restEstimated: t.restH == null || t.restA == null,
      smallSample: (t.nHome ?? 99) < 5 || (t.nAway ?? 99) < 5,
    },
    // Full-audit P3: prefer the fixture league's lake-fitted HFA when present
    // (ORACLE_V3_LAKE_HFA=on), else the global v3Hfa. Undefined map ⇒ global.
    hfa: config?.v3HfaByLeague?.[job.league] ?? config?.v3Hfa,
    venueSplitUsed: config?.v3VenueSplitUsed,
    lambdaV5: config?.v3LambdaV5,
    // Lake-computed league baselines (audit P0-2) — undefined unless
    // ORACLE_V3_LAKE_BASELINES is on, so the static table stays authoritative
    // by default.
    lakeBaselines: config?.v3LakeBaselines,
    // Heightened bars are per-fixture (§1.2 youth/women/friendly/cup-final),
    // stamped as telemetry.v3Heightened by the PR-5a slate pre-filter — the
    // gates-v4 flag only enables the mechanism, it never heightens the slate.
    heightened: config?.v3GatesV4 !== false && t.v3Heightened === true,
    // Same ledger.metrics.dynamicRhoParams read the legacy engine already does
    // at execution/index.ts:1524 — only populated (mode="on") once calibration
    // has ≥30 resolved fixtures for this league; undefined otherwise, so the
    // v3 gate falls back to the static getLeagueParams baseRho unchanged.
    dynamicRho: state.ledger?.metrics?.dynamicRhoParams?.[job.league],
    v3CornersCardsExt: config?.v3CornersCardsExt,
    // [refactor P0-2] Market-anchored blend inputs (evGate.ts computeMarketBlend):
    blendMode: config?.v3Blend,
    // 0-1 scale (V3AllMarketsInput.completeness contract) — the slate pre-filter
    // (packages/runtime/src/marketsV3/slateGate.ts, owned by a different
    // workstream) is expected to stamp telemetry.v3Completeness at that same
    // 0-1 scale when it stamps telemetry.v3Heightened; read here via the
    // telemetry index signature since RunState.telemetry has no named field
    // for it. Absent (not yet stamped, or fixture bypassed the pre-filter)
    // ⇒ undefined ⇒ evGate.ts's computeMarketBlend treats it as 0 (strictest
    // wModel posture), never as a blocker.
    completeness: typeof t.v3Completeness === "number" ? t.v3Completeness : undefined,
    // Confirmed (non-estimated) xG provenance — reuses the same xgMode marker
    // the xgEstimated/xgMissing penalty flags above already read, so this is
    // an exact derivation, not an approximation: "empirical" means real xG
    // was actually supplied, not the SHRINK_N-gated raw-goals estimate.
    hasRealXg: t.xgMode === "empirical",
    // [Wave 4-accuracy] Both default "on" per OracleConfig's contract —
    // undefined config (e.g. tests constructing buildV3Input's 4th arg
    // manually) behaves the same as an explicit "on".
    blendPricing: config?.v3BlendPricing !== "off",
    totalsEmpirical: config?.v3TotalsEmpirical !== "off",
    // [X-carveout] default-off — undefined config behaves as "off"
    // (gateAllMarkets' own default).
    xCarveout: config?.v3XCarveout,
    // [Wave 2] pattern/trend detector shadow flag — undefined config behaves
    // as "off" (analyzeFixtureMarkets.ts's own default), byte-identical.
    v3Patterns: config?.v3Patterns,
  };
}

/** [Phase 2A, patterns-legacy-pricer] Legacy-pricer sibling of
 *  analyzeFixtureMarkets.ts's buildFixturePatternInput — builds the SAME
 *  PatternInput TYPE directly from RunState.telemetry (the legacy pricer's
 *  own scope has no V3AllMarketsInput to read from). Reuses the identical
 *  telemetry field names buildV3Input already maps above wherever they
 *  overlap, per the plan's explicit "reuse, don't re-derive" instruction —
 *  this is NOT a second, drifting implementation, it's the same fields read
 *  a second time for a different consumer. Same null-return contract as
 *  buildFixturePatternInput: requires the four venue-split goal rates to be
 *  real numbers, else returns null (never fabricates a false signal from a
 *  0-fallback). Three deliberate field-source choices worth flagging:
 *   - nHome/nAway sourced from t.formNH/t.formNA (not t.nHome/t.nAway,
 *     a DIFFERENT lambda-input sample-size pair on the same telemetry
 *     object) — matches analyzeFixtureMarkets.ts's own choice exactly, so
 *     both PatternInput builders agree on which "n" the detector's
 *     sample-shrink math applies to.
 *   - homeOdds/drawOdds/awayOdds sourced directly from t.hOdds/t.dOdds/
 *     t.aOdds (the legacy engine's own established telemetry read, see
 *     execution/index.ts) rather than v3's extract1x2Odds(allMarkets) —
 *     simpler, and this fixture's allMarkets catalogue isn't in scope here
 *     the way it is in analyzeFixtureMarkets.ts.
 *   - NOT byte-identical to buildFixturePatternInput's actual field
 *     COVERAGE (adversarial review finding, 2026-07-20): this builder DOES
 *     map fhShareH/fhShareA (enabling detectHalfShare) even though
 *     buildFixturePatternInput currently does not — the two detectors can
 *     surface a different topPattern for the same fixture as a result. Not
 *     a safety issue (half_share only ever recommends a +EV goals_ou over,
 *     same ev>0-floor-bound-regardless guarantee every pattern kind has),
 *     just an intentional extra signal here worth being explicit isn't
 *     mirrored both ways yet.
 *  Exported for direct unit testing — same rationale as buildV3Input above. */
export function buildLegacyPatternInput(state: RunState, league: string): PatternInput | null {
  const t = state.telemetry ?? {};
  if (
    !Number.isFinite(t.scoredPer90H) ||
    !Number.isFinite(t.concededPer90H) ||
    !Number.isFinite(t.scoredPer90A) ||
    !Number.isFinite(t.concededPer90A)
  ) {
    return null;
  }
  return {
    homeScoredHome: t.scoredPer90H as number,
    homeConcededHome: t.concededPer90H as number,
    awayScoredAway: t.scoredPer90A as number,
    awayConcededAway: t.concededPer90A as number,
    homeXg: t.xgfH,
    awayXg: t.xgfA,
    homeXga: t.xgaH,
    awayXga: t.xgaA,
    ou25PctH: t.ouO25H,
    ou25PctA: t.ouO25A,
    bttsPctH: t.bttsPctH,
    bttsPctA: t.bttsPctA,
    csPctH: t.csPctH,
    csPctA: t.csPctA,
    ftsPctH: t.ftsPctH,
    ftsPctA: t.ftsPctA,
    fhShareH: t.fhShareH,
    fhShareA: t.fhShareA,
    cornersForH: t.cornersForH,
    cornersForA: t.cornersForA,
    cornersAgainstH: t.cornersAgainstH,
    cornersAgainstA: t.cornersAgainstA,
    cardsAvgH: t.cardsAvgH,
    cardsAvgA: t.cardsAvgA,
    nHome: t.formNH,
    nAway: t.formNA,
    homeOdds: t.hOdds,
    drawOdds: t.dOdds,
    awayOdds: t.aOdds,
    league,
    streakH: t.streakH,
    streakA: t.streakA,
    last5PtsH: t.last5PtsH,
    last5PtsA: t.last5PtsA,
    // leagueAvgGoals/h2hOversRate/restDaysMin/mappedFamiliesWithStats
    // intentionally absent — same rationale as buildFixturePatternInput's
    // own trailing comment: not cheaply available in this scope, and
    // detectPatterns degrades gracefully without them.
  };
}

/** [Phase 2A, patterns-legacy-pricer] Applies the SAME pattern-first ranking
 *  priority markets-v3 already gives its own candidates (evGate.ts's
 *  PATTERN_RANK_BONUS * strength boost, gated on sideMatches — the shared
 *  matcher exported from analyzeFixtureMarkets.ts, "one shared rule, two
 *  call sites, not a forked implementation") to the legacy pricer's
 *  evMarkets. Ranking/confidence ONLY: returns a NEW array (never mutates
 *  the input, matching stripUnderComponents' convention), re-sorted by the
 *  boosted rankingScore — it never changes any candidate's `ev`, so
 *  buildEligibleBets' ev>0 floor (decision/index.ts, called AFTER this on
 *  the returned array) is completely unaffected; this function has no power
 *  to admit or promote a −EV candidate, only to reorder already-priced ones.
 *  A defensive `m.ev > 0` re-check is included anyway (never boost a
 *  candidate that's going to be filtered out momentarily regardless) — belt
 *  and suspenders, not the actual enforcement point.
 *
 *  SCOPE BOUNDARY (found writing legacyPatternRanking.test.ts, documented
 *  rather than "fixed" — out of Phase 2A's stated file scope): reordering
 *  `eligible`'s array is real and visible to `eligible[0]` (the LLM
 *  briefing's "top eligible bet" framing) and `runSwarm`'s input order when
 *  an LLM decision tier is active — but decision/index.ts's
 *  `deterministicDecide` (the no-LLM-available fallback, used whenever no
 *  API key/DecisionContext is present, or the whole LLM cascade fails open)
 *  does its OWN independent `sort((a,b) => b.ev - a.ev)` over whatever it
 *  receives, ignoring incoming array order entirely. So on a fixture that
 *  falls all the way through to that fallback, this ranking boost changes
 *  `eligibleBets`' reported order but does NOT change which candidate
 *  becomes `primaryPick` — deterministicDecide's own ev-based tie-break
 *  still wins. That function is general-purpose (every decision path in the
 *  engine uses it, not legacy-pricer-specific) and outside the file scope
 *  the plan names for this phase; changing it is a separate, bigger-blast-
 *  radius decision left for later, not silently bundled into Phase 2A.
 *  Exported for direct unit testing — same rationale as buildV3Input above. */
export function applyLegacyPatternRanking(
  evMarkets: EVMarket[],
  patternReport: PatternReport
): EVMarket[] {
  const { recommendedFamily, recommendedSide, strength } = patternReport;
  if (!recommendedFamily || !recommendedSide) return evMarkets;
  return evMarkets
    .map((m) => {
      // Match on `.side` (falling back to `.label` only when side is truly
      // absent), NOT `.label` alone (adversarial review finding, 2026-07-20):
      // `.side` = `.label` is true for scanMarkets' family-gated BLOCKs
      // (execution/index.ts's check() closure sets `side: label`), but
      // FALSE for scanAllMarketsFallback — that path sets `label` to a
      // COMPOSITE string ("Total Goals Over/Under — Over 2.5") and `side`
      // to the CLEAN outcome desc ("Over 2.5") the shared sideMatches
      // matcher actually expects (the same clean shape V3's own call site
      // passes). Matching on the composite label silently broke matching
      // for every Scan-sourced candidate (dirOfDesc/lineOfDesc/exact-match
      // all fail on a string containing the market name) — not a −EV/floor
      // risk, but it made the feature quietly inert on exactly the
      // full-catalogue candidates it's meant to help.
      //
      // Also excludes `m.veto` explicitly (adversarial review finding):
      // execution/index.ts pushes capped/noise/MES-vetoed candidates with
      // `ev > 0` AND `rankingScore: -100` — the `m.ev > 0` check alone does
      // NOT exclude them (contrary to this function's own prior claim of
      // "never boost a candidate that's going to be filtered out
      // momentarily regardless"). buildEligibleBets strips `veto` downstream
      // regardless, so this was never a real −EV admission risk, but
      // boosting a −100-sentinel candidate contradicted the stated contract
      // and rested entirely on downstream filtering rather than this
      // function's own logic.
      if (
        m.ev > 0 &&
        !m.veto &&
        m.family === recommendedFamily &&
        sideMatches(m.side ?? m.label, recommendedSide, m.family)
      ) {
        return { ...m, rankingScore: m.rankingScore + PATTERN_RANK_BONUS * strength };
      }
      return m;
    })
    .sort((a, b) => b.rankingScore - a.rankingScore);
}

/** Goals-family MarketFamily values the R10 cross-check hook applies to.
 *  Mirrors packages/runtime/src/marketsV3/goalsCrossCheck.ts's
 *  GOALS_CROSSCHECK_FAMILIES — duplicated here (not imported) because engine
 *  never imports runtime; keep both in sync by hand if this set changes. */
const GOALS_CROSSCHECK_FAMILIES: ReadonlySet<MarketFamily> = new Set<MarketFamily>([
  "goals_ou",
  "team_total",
  "btts",
]);

/** Structurally identical to runtime's CrossCheckResult (goalsCrossCheck.ts) —
 *  defined fresh here since engine can't import that type from runtime.
 *  Runtime's crossCheckGoalsPick() return value satisfies this by duck typing. */
export interface V3CrossCheckOutcome {
  verdict: "agree" | "disagree" | "no_data";
  assessment: V3AllMarketsAssessment;
  survives: boolean;
  annotation: string;
}

/** DI hook (R10): given the fixture's top-ranked "done" goals-family pick
 *  (label/odds identify the exact market), the caller (runtime/worker layer,
 *  which alone has sidecar access to build a goals-engine input) returns a
 *  cross-check verdict, or null when it has no independent opinion (e.g. no
 *  sidecar mapping for this fixture) — null means "leave the pick untouched",
 *  same as a "no_data" verdict. */
export type GoalsCrossCheckFn = (
  pick: V3AllMarketsAssessment,
  label: string,
  odds: number,
  fixture: { home: string; away: string; league: string; kickoff: string }
) => V3CrossCheckOutcome | null;

/** R10 cross-check: re-verify the fixture's best goals-family v3 pick against
 *  the independent goals-only engine, mutating v3Result's assessments/
 *  evMarkets IN PLACE before anything downstream reads them — so usedV3's
 *  eligible slice and the v3Best/v3AssessmentStats projection (PR-5b) both see
 *  the corrected state with no extra wiring at either call site. */
function applyGoalsCrossCheck(
  v3Result: { assessments: V3MarketOutcomeAssessment[]; evMarkets: EVMarket[] },
  hook: GoalsCrossCheckFn,
  fixture: { home: string; away: string; league: string; kickoff: string }
): void {
  const topGoalsFamily = v3Result.assessments
    .filter((a) => a.outcome === "done" && GOALS_CROSSCHECK_FAMILIES.has(a.family))
    .sort((a, b) => b.adjustedEdge - a.adjustedEdge)[0];
  if (!topGoalsFamily) return;

  const outcome = hook(topGoalsFamily, topGoalsFamily.desc, topGoalsFamily.odds, fixture);
  if (outcome?.verdict !== "disagree") return;

  const idx = v3Result.assessments.findIndex(
    (a) => a.marketId === topGoalsFamily.marketId && a.outcomeId === topGoalsFamily.outcomeId
  );
  if (idx < 0) return;
  const original = v3Result.assessments[idx]!;
  // The hook's re-gated assessment carries the downgraded gate math; identity
  // fields stay the original's (the hook only knows the gate-shape subset).
  const merged: V3MarketOutcomeAssessment = {
    ...original,
    ...outcome.assessment,
    family: original.family,
    marketId: original.marketId,
    marketName: original.marketName,
    outcomeId: original.outcomeId,
    desc: original.desc,
    odds: original.odds,
    mp: original.mp,
  };
  v3Result.assessments[idx] = merged;

  const emIdx = v3Result.evMarkets.findIndex(
    (m) => m.label === original.desc && m.market === FAMILY_LABEL[original.family]
  );
  if (!outcome.survives) {
    // §4.4 re-pick semantics: remove the failed candidate; the next-best
    // surviving market (already ranked) naturally takes its place downstream.
    if (emIdx >= 0) v3Result.evMarkets.splice(emIdx, 1);
    return;
  }
  if (emIdx >= 0) {
    const em = v3Result.evMarkets[emIdx]!;
    v3Result.evMarkets[emIdx] = {
      ...em,
      rawEdge: merged.rawEdge,
      rankingScore: merged.adjustedEdge,
    };
    v3Result.evMarkets.sort((a, b) => b.rankingScore - a.rankingScore);
  }
}

import { AtomicCostTracker, runPool } from "./pool.js";

export interface FixtureJob {
  home: string;
  away: string;
  league: string;
  /** Canonical league ID (Sportradar tournament ID), when the source
   *  captured one — see goalsV3/lambda.ts's V3_LEAGUE_BASELINES_BY_ID. */
  leagueId?: string;
  kickoff: string; // ISO-8601 or YYYY-MM-DDTHH:mm:ssZ
  state?: RunState; // optional pre-populated telemetry / odds
}

export type V3AssessmentStat = {
  family: string;
  desc: string;
  outcome: string;
  rawEdge: number;
  /** adjustedEdge + cls (audit fix, Desktop concept #4): the minimum extra
   *  fields needed to shadow-evaluate a skew-shrunk assessment against its
   *  own class gate's minAdjEdge (CLASS_GATE[cls].minAdjEdge — minAdjEvPct
   *  is NOT re-checked, since that needs q/adjEvPct which aren't carried
   *  here) without storing the full modelP/q/odds/penaltyPts the live
   *  assessment carried — see marketsV3/skewShrink.ts's header comment for
   *  why rawEdge alone is enough to derive the shrunk adjustedEdge
   *  algebraically. */
  adjustedEdge: number;
  cls: string;
  /** [Wave 2] V3AllMarketsAssessment.gateReason (Wave 1) carried through so a
   *  slate-level report can tally why candidates didn't reach "done" —
   *  undefined on a passing assessment, same contract as the source field. */
  gateReason?: string;
  /** [X-carveout] V3AllMarketsAssessment.xCarveout carried through ("passed" |
   *  "shadow_pass") so slate reports can tally shadow/actual carve-out
   *  passes — undefined everywhere else. */
  xCarveout?: string;
};

export interface FixtureJobSuccess {
  status: "ok";
  analysisId: string; // deterministic idempotency key
  runId: string; // parent batch run
  fixtureId: string;
  home: string;
  away: string;
  league: string;
  kickoff: string;
  result: RunResult;
  decision: DecisionOutput;
  decisionReplay: DecisionReplay | null;
  eligibleBets: EVMarket[];
  primaryPick: EVMarket | null;
  /** True for the top-N by composite stats score (selection-time flag, carried
   *  through so callers can restrict a downstream pipeline — e.g. the goals
   *  accumulator — to the same top-N the LLM tier was gated on). Defaults to
   *  true when telemetry.llmEligible is absent (ad-hoc /analyze, single-fixture). */
  llmEligible: boolean;
  // ── Optional LLM-layer telemetry (for report surfacing; all may be absent) ──
  cvlStatus?: "APPROVED" | "OVERRIDE" | "VETO" | "SKIPPED"; // B2 verification verdict
  briefingFlags?: string[]; // B1 briefing flags (e.g. FRAMING_BIAS_DETECTED)
  swarmConsensus?: string; // Level-2 swarm consensus pick label
  swarmDivergence?: number; // 0–1; high = workers disagreed
  decisionShadow?: DecisionShadow; // GLM-5.2 shadow comparison, observability only
  agentVerification?: RunResult["agentVerification"]; // ORACLE_AGENT_VERIFY local-CLI check, observability only
  /** PR-5b: this fixture's single best v3 gate-surviving assessment (§4.3 — one
   *  per fixture), present only when v3 ran for this fixture and something
   *  survived with outcome "done". Feeds the slate-level Output A–D assembly
   *  (packages/runtime/src/marketsV3/slateOutputs.ts) without requiring the
   *  batch to retain every raw per-market assessment for the whole day. */
  v3Best?: V3OutputCandidate;
  /** [patterns-engine Wave 2] Fill-to-39 fallback — this fixture's best +EV
   *  (raw true EV `ev = mp·odds − 1 > 0`, the owner's value floor) candidate
   *  that did NOT clear the gate, so the slate Output-A pool can fill toward 39
   *  even on class-gate-dry fixtures instead of the tiny gate-survivor set
   *  (the 2026-07-15 0/4394 dryness). Derived + carried ONLY when v3Patterns is
   *  "shadow"/"on" (byte-identical projection when off). buildMarketsV3SlateOutputs
   *  uses `v3Best ?? v3BestFallback` as the fixture's pool representative when
   *  the fill flag is on; never used when v3Patterns is off. */
  v3BestFallback?: V3OutputCandidate;
  /** [Phase 2, two-tier slate] Delivery-shaped projection of v3Best (family +
   *  real Kelly stakePct sourced from v3AssessmentsToEvMarkets + mandatory
   *  trapWarning + basisLabel) — the Tier① (qualified) row this fixture
   *  contributes to the delivered slate, when it has one. Present under the
   *  same condition as v3Best. Never gates anything; purely a richer
   *  projection of the same already-gated candidate. */
  v3DeliveryBest?: V3DeliveryCandidate;
  /** [Phase 2, two-tier slate] EVERY +EV (`ev = mp·odds − 1 > 0`) assessment
   *  for this fixture that did NOT clear the gate (outcome !== "done"),
   *  each tagged with a human-readable `shortfall` (its gateReason, or
   *  "capped"/"noise" for the HSH-invariant-guarded outcomes) — the
   *  fixture's full Tier② (watchlist) contribution. Unlike v3BestFallback
   *  (single best class_edge-only candidate, kept for the existing
   *  fill-to-39 caller), this is the WIDENED set the plan's two-tier slate
   *  needs: any shortfall reason, not just class_edge, and every qualifying
   *  candidate, not just the single best. Capped/noise rows are included
   *  (transparency, v6.2 — demotions not deletions) but the two-tier slate
   *  assembly sorts them behind class_edge/ev_floor rows and they can never
   *  reach Tier①, regardless of pattern strength (the one line pattern
   *  strength can never cross). Never staked (Kelly against a gate-failed
   *  candidate is not meaningful) — stakePct is always 0 here. Derived only
   *  when v3Patterns is shadow/on (byte-identical empty array when off,
   *  matching v3BestFallback's existing gating). */
  v3Watchlist?: V3DeliveryCandidate[];
  /** PR-5b: compact projection (family/desc/outcome/rawEdge only) of EVERY v3
   *  assessment for this fixture (done/capped/discarded alike) — slate sanity
   *  check input (packages/marketsV3/sanity.ts's slateSanityChecks). */
  v3AssessmentStats?: V3AssessmentStat[];
  /** PR-20: this fixture's full route-coverage tally (routed/skipped/unrouted
   *  by engine and reason), present whenever v3 ran (same condition as
   *  v3Best/v3AssessmentStats) — feeds the slate-level rollupCoverage()
   *  (packages/runtime/src/marketsV3/slateOutputs.ts). */
  v3Coverage?: RouteCoverage;
  /** [Wave 2] MLSafetyFilter.evaluate()'s killCounts for this fixture (Wave 1,
   *  P0-3) — would-be-kill tally per filter id, populated regardless of
   *  safetyMode so telemetry never goes dark just because a filter was
   *  demoted from hard-reject to penalty. Feeds a slate-level report tally. */
  safetyKillCounts?: Record<string, number>;
  /** [Wave 3, WS3-A] Stage-2 dual-run shadow diff — legacy SafetyPipeline
   *  output vs a v3-adapted candidate set run through the same pipeline,
   *  present only when `usedV3` was true for this fixture. Diagnostic-only:
   *  never read by DecisionContext or anything upstream of this return —
   *  carried here purely so a run-manifest/report consumer can persist it
   *  (see safety/pipeline.ts's SafetyShadowDiff doc comment). */
  safetyShadowDiff?: SafetyShadowDiff;
}

export interface FixtureJobError {
  status: "error";
  fixtureId: string;
  home: string;
  away: string;
  league: string;
  kickoff: string;
  reason: string;
  errorCode: AgentErrorCode;
  llmEligible: boolean;
}

export type BatchJobResult = FixtureJobSuccess | FixtureJobError;

export interface BatchResult {
  runId: string;
  calibrationSnapshotId: string;
  date: string; // YYYY-MM-DD
  rankingMode: RankingMode;
  dryRun?: boolean; // true when BatchOptions.dryRun was set
  jobs: BatchJobResult[];
  completedCount: number;
  errorCount: number;
  actionableCount: number;
  totalRecommendedStakePct: number;
  cost: { estimatedUsd: number; ceilingUsd: number | null; halted: boolean };
  errors: AgentError[];
}

export interface BatchOptions {
  rankingMode?: RankingMode;
  calibrationSnapshotId?: string; // defaults to "calib_YYYY-MM-DD"
  marketWhitelist?: string[];
  dryRun?: boolean; // skip execution; return cost estimate only (§11A)
  maxRetries?: number; // per-fixture retries on RATE_LIMITED (default 3; 0 = no retries)
  backoffMs?: (attempt: number) => number; // delay per retry attempt; default: exponential 1s/2s/4s ±10%
  concurrency?: number; // max fixtures processed in parallel (default config.batchConcurrency ?? 8)
  onProgress?: (event: { completed: number; total: number; current: string }) => void;
  /** [Wave 2, WS2-A] v5 Rule 0.14 feed-integrity verdicts, keyed by
   *  `${home}|${away}` (packages/runtime/src/marketsV3/slateGate.ts's
   *  fixtureIntegrityKey convention) — the caller computes this via
   *  prefilterMarketsV3Jobs's SlateGateOutcome.integrityReport +
   *  checkFixtureIntegrity() (packages/runtime/src/feedIntegrity.ts) BEFORE
   *  calling runBatch, then threads the per-fixture verdicts through here.
   *  DEFERRED cross-file wiring: apps/worker/src/dailyBatch.ts (a different
   *  file/workstream, out of this change's scope) does not yet populate this
   *  option — the receiving side (this option + the processOne wiring it
   *  feeds) is ready for it. Contaminated fixtures should never reach here
   *  in practice (slateGate.ts's "on" mode discards them upstream, before
   *  its survivors are ever turned into FixtureJobs) — "flagged" is the
   *  expected live value; a stray "contaminated" entry (e.g. slateGate's
   *  "shadow" mode) is treated the same as "flagged" defensively below
   *  (stake downgrade, never silently ignored, never a second hard reject
   *  this late in the pipeline). */
  integrityByFixture?: Record<string, FeedIntegritySignal>;
  /** [Wave 2, WS2-A] Slate-wide sanity result (marketsV3/sanity.ts's
   *  slateSanityChecks), shared across every fixture in this batch.
   *  DEFERRED — nothing in this file computes it: processOne runs one
   *  fixture at a time (parallelized via runPool), and slateSanityChecks
   *  needs every fixture's v3AssessmentStats already collected, which only
   *  exist AFTER the whole batch completes. Computing it live inside this
   *  loop would require restructuring runBatch into two passes (engine+v3
   *  first, LLM arbiter second) — a real architectural change, not a
   *  surgical wiring pass. This option lets a caller that already has a
   *  slate-wide result (e.g. a prior run, or its own two-pass
   *  orchestration) thread it through today. */
  slateSanity?: SlateSanitySignal;
}

/** Parse newline-delimited fixture list.
 *  Accepted formats:
 *    "Home vs Away, League, Kickoff"
 *    "Home vs Away | League | Kickoff"
 *  Lines starting with '#' and blank lines are skipped. */
export function parseFixtureList(input: string): FixtureJob[] {
  const jobs: FixtureJob[] = [];
  for (const raw of input.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const sep = line.includes("|") ? "|" : ",";
    const parts = line.split(sep).map((p) => p.trim());
    if (parts.length < 1) continue;

    const vsMatch = (parts[0] ?? "").match(/^(.+?)\s+vs\.?\s+(.+)$/i);
    if (!vsMatch) continue;

    const home = vsMatch[1]?.trim();
    const away = vsMatch[2]?.trim();
    if (!home || !away) continue;

    jobs.push({
      home,
      away,
      league: parts[1] ?? "Default",
      kickoff: parts[2] ?? new Date().toISOString(),
    });
  }
  return jobs;
}

// Conservative per-call cost for claude-opus-4-8 (~1K input + 200 output tokens)
const LLM_COST_ESTIMATE_USD_PER_CALL = 0.05;

// Max v3 candidates handed to the arbiter per fixture (evMarkets is already
// ranked best-first by adjusted edge) — see the enableMarketsV3 wiring in
// processOne. Small enough to keep the arbiter prompt trivial, generous
// enough that a real close-call second-best market is never silently dropped.
const V3_ARBITER_CANDIDATE_LIMIT = 5;

function classifyError(msg: string): AgentErrorCode {
  if (/429|rate.?limit/i.test(msg)) return "RATE_LIMITED";
  if (/no.?data|not.?found|no fixture/i.test(msg)) return "NO_DATA";
  if (/odds/i.test(msg)) return "ODDS_UNAVAILABLE";
  if (/ambiguous/i.test(msg)) return "AMBIGUOUS_FIXTURE";
  return "INTERNAL";
}

export function makeFixtureId(home: string, away: string, kickoff: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
  return `${slug(home)}_vs_${slug(away)}_${kickoff.replace(/\D/g, "").slice(0, 12)}`;
}

function makeRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Deterministic per-analysis ID — enables safe upserts (PRD §11A.3). */
function makeAnalysisId(
  fixtureId: string,
  rankingMode: string,
  calibrationSnapshotId: string
): string {
  return `${fixtureId}:${rankingMode}:${calibrationSnapshotId}`;
}

/** [PR-10, generalized retry] Matches transient DNS/transport failures — the
 *  same failure class observed for both Telegram sends and SportyBet scrapes
 *  (host-wide intermittent DNS; see oracle_dns_and_llm_session_limit_investigation).
 *  A delayed retry helps here (the resolver gets time to recover); an
 *  immediate alternate-transport fallback alone does not. */
export function isRetriableNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg);
}

/** Retries fn up to maxRetries times with exponential backoff, on whichever
 *  errors shouldRetry accepts. Defaults to the original RATE_LIMITED-only
 *  predicate so the existing call site below is unchanged; pass a different
 *  predicate (e.g. isRetriableNetworkError) to reuse this for other transient
 *  failure classes instead of writing a bespoke retry wrapper per caller. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  backoffMs: (attempt: number) => number,
  shouldRetry: (err: unknown) => boolean = (err) =>
    classifyError(err instanceof Error ? err.message : String(err)) === "RATE_LIMITED"
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!shouldRetry(err) || attempt >= maxRetries) throw err;
      await new Promise<void>((r) => setTimeout(r, backoffMs(attempt)));
      attempt++;
    }
  }
}

/** Run a batch of fixture jobs sequentially.
 *  One job failing never aborts the batch — it produces { status: 'error' } instead. */
/** PR-8: whether a fixture's convergence tier may spend on the optional LLM extras
 *  (briefing / swarm / CVL). "apex" restricts extras to APEX-tier fixtures only;
 *  "all" (or unset legacy) defers to the route's own per-tier decisions. */
function extrasTierAllowed(tier: string, mode: "apex" | "all" | undefined): boolean {
  return mode === "all" ? true : tier === "APEX";
}

export async function runBatch(
  jobs: FixtureJob[],
  deps: { storage: StoragePort; config: OracleConfig; goalsCrossCheck?: GoalsCrossCheckFn },
  options: BatchOptions = {}
): Promise<BatchResult> {
  const {
    onProgress,
    marketWhitelist,
    rankingMode = "CONFIDENCE_WEIGHTED",
    integrityByFixture,
    slateSanity,
  } = options;
  const maxRetries = options.maxRetries ?? 3;
  const backoffMs =
    options.backoffMs ??
    ((attempt: number) => {
      const base = 2 ** attempt * 1000;
      return base * (1 + (Math.random() * 0.2 - 0.1));
    });
  const runId = makeRunId();
  const calibrationSnapshotId =
    options.calibrationSnapshotId ?? `calib_${new Date().toISOString().slice(0, 10)}`;
  const config: OracleConfig = { ...deps.config, rankingMode };
  const ceilingUsd = config.costCeilingUsd?.perRun ?? null;

  // §11A dry-run: no API calls; returns a cost estimate based on job count
  if (options.dryRun) {
    const dryJobs: BatchJobResult[] = jobs.map((job) => ({
      status: "error" as const,
      fixtureId: makeFixtureId(job.home, job.away, job.kickoff),
      home: job.home,
      away: job.away,
      league: job.league,
      kickoff: job.kickoff,
      reason: "DRY_RUN — estimate only",
      errorCode: "DRY_RUN" as AgentErrorCode,
      llmEligible: job.state?.telemetry?.llmEligible !== false,
    }));
    return {
      runId,
      calibrationSnapshotId,
      date: new Date().toISOString().slice(0, 10),
      rankingMode,
      dryRun: true,
      jobs: dryJobs,
      completedCount: 0,
      errorCount: dryJobs.length,
      actionableCount: 0,
      totalRecommendedStakePct: 0,
      cost: {
        estimatedUsd: parseFloat((jobs.length * LLM_COST_ESTIMATE_USD_PER_CALL).toFixed(4)),
        ceilingUsd,
        halted: false,
      },
      errors: [],
    };
  }

  const agentErrors: AgentError[] = [];
  const total = jobs.length;
  // Q4c: the all-markets LLM executor tier is a real per-fixture process spawn,
  // not a cheap API call — when it's on, concurrency follows the owner-specified
  // hardware-aware budget (2-3 local, ~1/fixture on VPS) instead of the normal
  // batchConcurrency default, since that default predates this tier and was
  // sized for cheap network calls, not local CLI spawns.
  const marketExecutorActive = config.enableLlmMarketExecutor === true;
  const concurrency = marketExecutorActive
    ? computeMarketExecutorConcurrency(total, config.isVps)
    : Math.max(1, options.concurrency ?? config.batchConcurrency ?? 8);
  // Per owner instruction: uncapped spend on VPS specifically for this tier —
  // scheduling never halts on the cost ceiling there. Local runs keep the
  // existing ceiling behavior unchanged (concurrency is already low there).
  const uncappedOnVps = marketExecutorActive && config.isVps === true;
  const costTracker = new AtomicCostTracker(LLM_COST_ESTIMATE_USD_PER_CALL, ceilingUsd);
  let completedCounter = 0;

  // [Wave 3, WS3-A] TeamRatingsEngine instantiation (WS2-B built the engine +
  // buildRatingsLambdaInput but never wired a call site — see ratings/
  // index.ts's "Wiring contract for the Wave-3 caller" header). Hydrated ONCE
  // per batch (not per fixture) per the file's own hydrate-once/persist-at-end
  // pattern. Gated off entirely when ORACLE_V3_RATINGS=off so a disabled flag
  // costs zero storage reads. This only threads `{ratingsXgd, ratingsN}` into
  // buildV3Input's lambdaInput — it deliberately does NOT flip
  // `opts.ratingsBlend: true` at the analyzeFixtureMarketsV3 call site (that
  // file is a different workstream's ownership this wave, and per the
  // wiring contract, ratingsBlend may only go live after the walk-forward
  // harness clears its +0.002 RPS bar — no evidence that's happened yet), so
  // this stays a shadow diagnostic input with zero effect on any live λ,
  // matching `ORACLE_V3_RATINGS`'s default `"shadow"`.
  const ratingsEngine = config.v3Ratings !== "off" ? new TeamRatingsEngine(deps.storage) : null;
  if (ratingsEngine) await ratingsEngine.hydrate();

  // Per-fixture work — identical logic to the previous sequential body, now
  // runnable concurrently. Returns a BatchJobResult (never throws).
  async function processOne(job: FixtureJob): Promise<BatchJobResult> {
    const fixtureId = makeFixtureId(job.home, job.away, job.kickoff);
    // Computed once, before the try, so both the success and error paths agree —
    // default true when absent (e.g. ad-hoc /analyze, single-fixture).
    const llmEligible = job.state?.telemetry?.llmEligible !== false;
    try {
      return await withRetry(
        async (): Promise<FixtureJobSuccess> => {
          const state: RunState = {
            ...(job.state ?? {}),
            pipeline: {
              ...(job.state?.pipeline ?? {}),
              fixture: {
                home: job.home,
                away: job.away,
                league: job.league,
                date: job.kickoff,
                ...(job.state?.pipeline?.fixture ?? {}),
              },
            },
          };

          const runResult = await ExecutionEngine.run(state, { storage: deps.storage, config });

          let evMarkets = runResult.evMarkets;
          if (marketWhitelist && marketWhitelist.length > 0) {
            const wl = marketWhitelist.map((s) => s.toLowerCase());
            evMarkets = evMarkets.filter((m) =>
              wl.some((w) => m.cat.toLowerCase().includes(w) || m.label.toLowerCase().includes(w))
            );
          }

          // [Phase 2A, patterns-legacy-pricer] Pattern-aware ranking for the
          // legacy pricer path — closes the last pattern-blind gap in
          // delivery (markets-v3, below, already calls detectPatterns; this
          // fixture's LEGACY evMarkets never saw it before, and this is what
          // eligible falls back to on any fixture where v3 was dry or off).
          // Ranking/confidence boost only, same absolute rule as Phase 2's
          // two-tier slate — buildEligibleBets' ev>0 floor (line ~950 below)
          // is untouched by this block; it can only reorder candidates that
          // already pass it, never rescue one that doesn't. Gated on
          // v62Patterns, NOT v3Patterns (a deliberately separate flag — see
          // OracleConfig.v62Patterns's doc comment): "shadow" (default)
          // computes the pattern report but never reorders, matching the
          // shadow-never-applies convention v3Patterns itself established;
          // "on" applies the boost. SCOPE NOTES (see
          // applyLegacyPatternRanking's own doc comment for the full
          // explanation of the first): (1) this reorders `eligible`'s
          // array — real, visible effect on the LLM briefing framing and
          // swarm input order — but does NOT override decision/index.ts's
          // deterministicDecide own independent ev-based tie-break on
          // fixtures that fall through to that no-LLM fallback; changing
          // that general-purpose function is outside this phase's scope.
          // (2) buildLegacyPatternInput's null-return contract (missing
          // venue-split rates) is the SAME contract analyzeFixtureMarketsV3
          // dry-runs on, so on a fixture that fell to the legacy path
          // BECAUSE those rates were missing, this ranking is inert too —
          // an accepted tradeoff (fabricating a signal from missing data
          // would be worse), flagged so a future session doesn't mistake a
          // near-zero legacy-path match rate for a bug. (3) "shadow" mode
          // computes legacyPatternReport but persists no evidence anywhere
          // (unlike v3Patterns' patternRelaxed:"shadow_pass" ledger tally) —
          // a real gap if this flag is ever soak-tested before flipping to
          // "on", named here as a follow-up rather than silently expanding
          // this phase's scope to add ledger telemetry infrastructure.
          if (config.v62Patterns && config.v62Patterns !== "off") {
            const legacyPatternInput = buildLegacyPatternInput(state, job.league);
            const legacyPatternReport = legacyPatternInput
              ? detectPatterns(legacyPatternInput)
              : null;
            if (
              config.v62Patterns === "on" &&
              legacyPatternReport?.topPattern &&
              legacyPatternReport.strength >= PATTERN_MIN_STRENGTH
            ) {
              evMarkets = applyLegacyPatternRanking(evMarkets, legacyPatternReport);
            }
          }

          // [Wave 2, WS2-A + review follow-up] v5 Rule 0.14 per-fixture
          // integrity hook — installed per feedIntegrity.ts's "installed at
          // the top of batch processOne" integration note. "flagged" (and,
          // defensively, a stray "contaminated" that reaches here despite
          // slateGate.ts's "on" mode discarding those upstream) downgrades
          // every non-vetoed candidate's stake fixture-wide by a flat 0.5x —
          // same magnitude S11/S13/S16 use in familyPenaltyMultiplier — via
          // applyConvergenceTierToStake, never a hard reject.
          //
          // LIVE, not a no-op: apps/worker/src/dailyBatch.ts (same Wave-2
          // diff) populates BatchOptions.integrityByFixture from
          // prefilterMarketsV3Jobs's integrityReport, so this branch fires in
          // production the moment this merges. It is an ADDITIONAL
          // multiplicative factor, not folded into familyPenaltyMultiplier's
          // own internal Math.min — a fixture that already carries a
          // convergence-tier cut and a safety-family penalty will have this
          // 0.5x applied on top of both (multiplicative stacking, no combined
          // floor). This is the same multiplicative-stacking pattern
          // execution/index.ts already uses for convergence-tier ×
          // family-penalty (Wave 1) — not a regression Wave 2 introduces, and
          // always stake-conservative (compounding can only shrink a stake,
          // never grow one). Whether independent risk multipliers should be
          // unified behind one floor instead of stacked is a legitimate open
          // design question — deferred to Wave 3, not fixed here.
          const integrityVerdict = integrityByFixture?.[`${job.home}|${job.away}`];
          if (integrityVerdict && integrityVerdict.verdict !== "clean") {
            for (const m of evMarkets) {
              if (m.veto) continue;
              applyConvergenceTierToStake(m, 0.5);
            }
          }

          const filteredResult: RunResult = { ...runResult, evMarkets };
          let eligible = buildEligibleBets(evMarkets);

          // Build context for LLM decision layer
          const convResult = runResult.convergence as Record<string, unknown> | undefined;
          const mlResult = runResult.mlFilter as Record<string, unknown> | undefined;
          const debateRes = runResult.debate as Record<string, unknown> | undefined;
          const regimeRes = runResult.lowScoreRegime as Record<string, unknown> | undefined;
          const allMarkets = (
            state.pipeline?.fetched?.sportyBetOdds as { allMarkets?: AllMarketEntry[] } | undefined
          )?.allMarkets;

          const decisionCtx: DecisionContext = {
            fixture: { home: job.home, away: job.away, league: job.league, kickoff: job.kickoff },
            fp: runResult.fp,
            lambdaH: (runResult.bayesian_lH as number | undefined) ?? 0,
            lambdaA: (runResult.bayesian_lA as number | undefined) ?? 0,
            expectedScoreline: String(runResult.expectedScoreline ?? "?"),
            regime: String(regimeRes?.regime ?? "STANDARD"),
            convergenceTier: String(convResult?.tier ?? "UNKNOWN"),
            convergenceScore: Number(convResult?.score ?? 0),
            mlAllowed: mlResult?.mlAllowed !== false,
            drawRisk: String(mlResult?.drawRisk ?? "MEDIUM"),
            betTrigger: String(debateRes?.betTrigger ?? "YELLOW"),
            portfolioCorrelation: runResult.portfolioCorrelation,
            hoursToKO: state.telemetry?.hoursToKO,
            softContext: state.telemetry?.softContext as SoftContextItem[] | undefined,
            rawStatsBlock: state.telemetry?.rawStatsBlock as Record<string, unknown> | undefined,
            allMarkets,
            integrity: integrityVerdict,
            slateSanity,
          };

          // all-markets-analysis-prompt-v3 deterministic engine (config.
          // enableMarketsV3). "on": replaces `eligible` with v3's gate-surviving
          // candidates for THIS fixture — fails open to the legacy list on any
          // v3 error/empty-result (missing data is never a blocker). "shadow":
          // v3 runs but its output is discarded, legacy `eligible` is used
          // unchanged (comparison instrumentation only). "off": skipped
          // entirely — zero overhead, byte-identical to pre-v3 behavior.
          //
          // Cap at V3_ARBITER_CANDIDATE_LIMIT (top-ranked first — evMarkets is
          // already sorted best-first by adjusted edge): the arbiter reads
          // whatever lands in `eligible`, and a handful of gate-survivors keeps
          // its prompt a token-cost rounding error next to the Q4 catalogue
          // dump this replaces, without losing any real candidate (spec §7
          // Output A only ever keeps ONE selection per fixture anyway).
          // Risk multipliers the engine already computed for THIS fixture, reused
          // so the all-markets LLM executor tier's Kelly stake (Q4b) — and, as
          // of Wave 3, the v3-adapted shadow-safety-pipeline stake below — are
          // consistent with every other stake the engine produces, not a
          // separate guess.
          const mcResult = runResult.mc as { varMultiplier?: number } | undefined;
          // [Wave 2, WS2-A] Per-(league,family)-segment calibFactor resolver —
          // mirrors execution/index.ts's calibFactorForFamily construction
          // exactly (same makeCalibFactorResolver call, same fallback object
          // shape) so the Q4 executor's Kelly stake stays consistent with
          // every other stake this fixture's ExecutionEngine.run() produced.
          // Byte-identical to the old flat `calibFactor` read for every mode
          // except "segment". [Wave 3, WS3-A] Moved earlier (was defined right
          // before the "Two-tier gate" comment) so the usedV3/v3Result block
          // below can reuse it for the stage-2 shadow-diff Kelly staking
          // instead of duplicating a second resolver.
          const calibMetricsForExecutor: CalibrationMetrics =
            (job.state?.ledger?.metrics as unknown as CalibrationMetrics | undefined) ??
            ({ calibFactor: 1.0, segmentCalibFactors: {}, leagueData: {} } as CalibrationMetrics);
          const calibResolverForExecutor = makeCalibFactorResolver(calibMetricsForExecutor, {
            calibrationLedger: config.calibrationLedger,
          });
          const marketExecutorRisk: MarketExecutorRiskParams = {
            dqs: (runResult.dqs as number | undefined) ?? 0.85,
            councilPenalty: (runResult.councilPenalty as boolean | undefined) ?? false,
            varMultiplier: mcResult?.varMultiplier ?? 1.0,
            drawdownPenalty: (runResult.drawdownPenalty as number | undefined) ?? 1.0,
            calibFactorFor: (family) =>
              family
                ? calibResolverForExecutor(job.league, family)
                : calibMetricsForExecutor.calibFactor,
            bankroll: config.bankroll,
          };

          let usedV3 = false;
          let v3Best: V3OutputCandidate | undefined;
          let v3BestFallback: V3OutputCandidate | undefined;
          let v3DeliveryBest: V3DeliveryCandidate | undefined;
          let v3Watchlist: V3DeliveryCandidate[] | undefined;
          let v3AssessmentStats: V3AssessmentStat[] | undefined;
          let v3Coverage: RouteCoverage | undefined;
          let safetyShadowDiff: SafetyShadowDiff | undefined;
          if (config.enableMarketsV3 && config.enableMarketsV3 !== "off") {
            // [Wave 3, WS3-A] Diagnostic-only pi-ratings data threading — see
            // the ratingsEngine header comment above runBatch's processOne
            // definition. Never flips any gate, never changes lambdas.
            const ratingsInput = ratingsEngine
              ? buildRatingsLambdaInput(ratingsEngine, job.home, job.away)
              : undefined;
            const v3Input = buildV3Input(job, state, allMarkets, config, ratingsInput);
            const v3Result = v3Input ? analyzeFixtureMarketsV3(v3Input) : null;
            // R10 cross-check (PR-6): mutate BEFORE the eligible slice and the
            // v3Best derivation below so both see the corrected state.
            if (v3Result && config.v3GoalsCrossCheck !== false && deps.goalsCrossCheck) {
              applyGoalsCrossCheck(v3Result, deps.goalsCrossCheck, {
                home: job.home,
                away: job.away,
                league: job.league,
                kickoff: job.kickoff,
              });
            }
            // [Wave 4-accuracy] Kelly wiring fix: v3Result.evMarkets carries
            // stake:0/stakeAmt:0 placeholders (analyzeFixtureMarketsV3 only
            // gates/ranks, it never stakes — see that file's header). Every
            // v3 pick showed 0.0% Kelly as a result. v3AssessmentsToEvMarkets
            // (safety/pipeline.ts) is the canonical Kelly staker; call it
            // ONCE here, AFTER applyGoalsCrossCheck above (cross-check
            // mutates v3Result.assessments in place — order matters, this
            // must see the corrected state), and reuse the SAME result for
            // both `eligible` below and the stage-2 shadow-safety-pipeline
            // diagnostic further down (previously computed twice
            // independently — deduped now). Same rankingScore-descending
            // shape v3Result.evMarkets already sorted to (both derive from
            // the identical assessments, filtered to outcome==="done"), so
            // arbiter candidate identity/order is unchanged — only stakes
            // move 0→real.
            const v3StakedEvMarkets = v3Result
              ? v3AssessmentsToEvMarkets(v3Result.assessments, {
                  bankroll: marketExecutorRisk.bankroll,
                  dqs: marketExecutorRisk.dqs,
                  councilPenalty: marketExecutorRisk.councilPenalty,
                  varMultiplier: marketExecutorRisk.varMultiplier,
                  drawdownPenalty: marketExecutorRisk.drawdownPenalty,
                  calibFactorFor: marketExecutorRisk.calibFactorFor,
                })
              : [];
            if (config.enableMarketsV3 === "on" && v3StakedEvMarkets.length) {
              // buildEligibleBets (not just its Under-strip half) re-applied
              // here deliberately: this REASSIGNS `eligible`, replacing the
              // legacy-path list buildEligibleBets already cleaned above
              // (line ~775) — v3AssessmentsToEvMarkets's own Under guard
              // only covers TOTALS_FAMILIES (goals_ou/team_total), the same
              // narrow gap safety/underBan.ts's header documents, so without
              // this the universal ban would silently not apply to v3's
              // (the DEFAULT-on) path. Re-filtering already-gated v3
              // candidates on !veto/ev>0 is a no-op for every legitimate
              // entry — only an Under (which should never have been staked
              // to begin with) is ever actually removed here. Strip BEFORE
              // slicing to V3_ARBITER_CANDIDATE_LIMIT — v3StakedEvMarkets is
              // already sorted best-first, so stripping after would silently
              // shrink the candidate pool below the limit whenever an Under
              // happened to rank inside the original top-N.
              eligible = buildEligibleBets(v3StakedEvMarkets).slice(0, V3_ARBITER_CANDIDATE_LIMIT);
              usedV3 = true;
            }
            // Populated whenever v3 ran ("on" OR "shadow") — shadow-mode
            // transparency is free; the WORKER decides whether to ACT on
            // v3Best/v3AssessmentStats (gated there on enableMarketsV3 === "on").
            if (v3Result) {
              v3Coverage = v3Result.coverage;
              // [Phase 3, Under->AH pivot — adversarial review finding,
              // 2026-07-16; widened to the family-agnostic isUnderDesc,
              // 2026-07-19 — see safety/underBan.ts header] v3Best sources
              // from raw `assessments`, not the Under-stripped
              // `evMarkets`/`best` analyzeFixtureMarketsV3 returns — this
              // exclusion is the same one v3BestFallback already applies
              // below, applied here too so a gate-passing Under can't win
              // v3Best and flow into slateOutputs.ts's tier-1 pool (the
              // actual delivered picks).
              const bestAssessment = v3Result.assessments
                .filter((a) => a.outcome === "done" && !isUnderDesc(a.desc))
                .sort((a, b) => b.adjustedEdge - a.adjustedEdge)[0];
              if (bestAssessment) {
                v3Best = {
                  marketName: bestAssessment.marketName,
                  desc: bestAssessment.desc,
                  cls: bestAssessment.cls,
                  mp: bestAssessment.mp,
                  odds: bestAssessment.odds,
                  q: bestAssessment.q,
                  rawEdge: bestAssessment.rawEdge,
                  penaltyPts: bestAssessment.penaltyPts,
                  adjustedEdge: bestAssessment.adjustedEdge,
                  adjEvPct: bestAssessment.adjEvPct,
                  confidence: bestAssessment.confidence,
                };
                // [Phase 2, two-tier slate] Delivery-shaped projection: real
                // stakePct sourced from v3StakedEvMarkets (the SAME canonical
                // Kelly staker feeding `eligible` above — never re-derived).
                // Matched by desc AND family — desc alone is NOT a safe join
                // key (adversarial review finding, 2026-07-20): raw outcome
                // desc strings like "Yes"/"No"/"Home"/"Away"/"Over 2.5" can
                // legitimately recur across different families in one
                // fixture's assessment set (v3AssessmentsToEvMarkets sets
                // family: a.family on every staked EVMarket — pipeline.ts —
                // so it's always available for the match). A desc-only match
                // could silently attach the wrong staked EVMarket's stake to
                // this delivered pick — real money on the wrong number.
                // Falls back to 0 only if the match somehow misses (e.g. the
                // staker's own veto/ev>0 re-filter dropped it) — never
                // fabricates a nonzero stake.
                const stakedMatch = v3StakedEvMarkets.find(
                  (m) => m.side === bestAssessment.desc && m.family === bestAssessment.family
                );
                v3DeliveryBest = {
                  ...v3Best,
                  fixtureId: makeFixtureId(job.home, job.away, job.kickoff),
                  home: job.home,
                  away: job.away,
                  league: job.league,
                  kickoff: job.kickoff,
                  family: bestAssessment.family,
                  stakePct: stakedMatch ? stakedMatch.stake * 100 : 0,
                  trapWarning: "no contradicting signal detected",
                  basisLabel: "venue",
                  ...(bestAssessment.patternStrength !== undefined
                    ? { patternStrength: bestAssessment.patternStrength }
                    : {}),
                };
              }
              // [patterns-engine Wave 2] Fill-to-39 fallback projection — only
              // derived when v3Patterns is shadow/on (byte-identical otherwise,
              // v3BestFallback stays undefined). Value floor uses the RAW model
              // EV, not the blend-overwritten `ev` field: when blendPricing is
              // on, V3MarketOutcomeAssessment.ev is overwritten with blendEV and
              // the true model EV is stashed in evModel (see that type's doc
              // comment) — `rawEv` recovers it so the floor is always mp·odds−1.
              // HARD INVARIANT (adversarial review finding, 2026-07-16): only
              // `outcome === "below_gate"` with `gateReason === "class_edge"`
              // qualifies — NOT `outcome !== "done"`, which would also admit
              // "capped"/"noise" outcomes. Those exist specifically to kill
              // fake-edge longshots (the 2026-07-09 HSH incident); a capped
              // candidate's inflated adjustedEdge would otherwise sort to the
              // TOP of the fallback pool and re-admit exactly what evGate.ts's
              // raw-edge caps/noise gate exists to block. Also restricting to
              // gateReason "class_edge" (not every below_gate reason) matches
              // this feature's own scope — it relaxes ONLY the class-edge bar,
              // so the fallback pool should surface ONLY candidates that bar
              // alone is blocking, not e.g. a max-odds or ev-floor reject.
              // [Phase 3, Under->AH pivot; widened to the family-agnostic
              // isUnderDesc, 2026-07-19 — see safety/underBan.ts header]
              // ALSO excludes ANY-family Under candidates — same owner rule
              // analyzeFixtureMarketsV3 enforces on evMarkets itself (never
              // recommend an Under). This fallback pool sources from
              // batch/index.ts, entirely outside that evMarkets-level
              // filter, so it needs the identical exclusion here or a
              // near-miss Under could re-enter the actionable pool through
              // the fill-to-39 back door.
              // rawEv hoisted above the v3Patterns gate below — v3Watchlist
              // (Phase 2, two-tier slate) needs it too and is deliberately
              // NOT gated on v3Patterns (adversarial review finding,
              // 2026-07-20: v3Watchlist's own filter has no pattern
              // dependency, and Phase 2's rollout flag is unifiedSlate, not
              // v3Patterns — gating it on v3Patterns meant ORACLE_V3_PATTERNS=off
              // would silently empty Tier② while Tier① kept populating
              // normally, an unrelated-flag coupling nobody was warned
              // about). v3BestFallback stays gated on v3Patterns below,
              // unchanged — that field is genuinely part of the
              // patterns-engine fill-to-39 feature, a different scope.
              const rawEv = (a: V3MarketOutcomeAssessment) => a.evModel ?? a.ev;
              if (config.v3Patterns && config.v3Patterns !== "off") {
                const bestFallbackAssessment = v3Result.assessments
                  .filter(
                    (a) =>
                      rawEv(a) > 0 &&
                      a.outcome === "below_gate" &&
                      a.gateReason === "class_edge" &&
                      !isUnderDesc(a.desc)
                  )
                  .sort((a, b) => b.adjustedEdge - a.adjustedEdge)[0];
                if (bestFallbackAssessment) {
                  v3BestFallback = {
                    marketName: bestFallbackAssessment.marketName,
                    desc: bestFallbackAssessment.desc,
                    cls: bestFallbackAssessment.cls,
                    mp: bestFallbackAssessment.mp,
                    odds: bestFallbackAssessment.odds,
                    q: bestFallbackAssessment.q,
                    rawEdge: bestFallbackAssessment.rawEdge,
                    penaltyPts: bestFallbackAssessment.penaltyPts,
                    adjustedEdge: bestFallbackAssessment.adjustedEdge,
                    adjEvPct: bestFallbackAssessment.adjEvPct,
                    confidence: bestFallbackAssessment.confidence,
                  };
                }
              }
              // [Phase 2, two-tier slate] Widened Tier② pool — every +EV
              // (ev = mp·odds−1 > 0, the owner's absolute value floor,
              // never relaxed regardless of tier or pattern strength)
              // assessment that did NOT clear the gate, ANY shortfall
              // reason (not just class_edge — that restriction is specific
              // to v3BestFallback's narrower fill-to-39 role above).
              // Capped/noise rows ARE included here (v6.2 transparency:
              // demotions, not deletions — design decision 3) but tagged
              // with their real shortfall so the slate-assembly layer can
              // sort them last and keep the 2026-07-09 HSH invariant that
              // they can never reach Tier① intact. Never staked (0 here
              // always — Kelly against a gate-failed candidate isn't
              // meaningful; the two-tier slate layer never shows a stake
              // for a watchlist row regardless of this value). Runs
              // whenever v3 ran for this fixture — NOT gated on v3Patterns
              // (see comment above the v3Patterns `if` block).
              v3Watchlist = v3Result.assessments
                .filter((a) => rawEv(a) > 0 && a.outcome !== "done" && !isUnderDesc(a.desc))
                .map((a) => ({
                  fixtureId: makeFixtureId(job.home, job.away, job.kickoff),
                  home: job.home,
                  away: job.away,
                  league: job.league,
                  kickoff: job.kickoff,
                  marketName: a.marketName,
                  desc: a.desc,
                  cls: a.cls,
                  mp: a.mp,
                  odds: a.odds,
                  q: a.q,
                  rawEdge: a.rawEdge,
                  penaltyPts: a.penaltyPts,
                  adjustedEdge: a.adjustedEdge,
                  adjEvPct: a.adjEvPct,
                  confidence: a.confidence,
                  family: a.family,
                  stakePct: 0,
                  shortfall:
                    a.outcome === "capped"
                      ? `capped (${a.capReason ?? "limit"})`
                      : (a.gateReason ?? a.outcome),
                  trapWarning: "no contradicting signal detected",
                  basisLabel: "venue" as const,
                  ...(a.patternStrength !== undefined
                    ? { patternStrength: a.patternStrength }
                    : {}),
                }));
              v3AssessmentStats = v3Result.assessments.map((a) => ({
                family: a.family,
                desc: a.desc,
                outcome: a.outcome,
                rawEdge: a.rawEdge,
                adjustedEdge: a.adjustedEdge,
                cls: a.cls,
                gateReason: a.gateReason,
                xCarveout: a.xCarveout,
              }));
            }
            // [Wave 3, WS3-A] Stage-2 dual-run shadow diff — DIAGNOSTIC ONLY.
            // When v3 supplied this fixture's candidate set, additionally run
            // the same SafetyPipeline stage over a Kelly-staked adaptation of
            // v3's gate-surviving assessments, and log a structured diff
            // against the legacy pipeline's already-computed output (which
            // ran inside ExecutionEngine._run above, BEFORE this file ever
            // sees the fixture). DecisionContext (built below) reads
            // `runResult`/`convResult`/`mlResult` — the LEGACY pipeline's
            // fields — untouched by anything in this block; this shadow run
            // never writes back into `runResult`, `eligible`, or `evMarkets`.
            // Never allowed to fail the real batch job (best-effort try/catch
            // around a diagnostic side-channel).
            if (usedV3 && v3Result) {
              try {
                // [Wave 4-accuracy] Reuses v3StakedEvMarkets computed above
                // (same v3AssessmentsToEvMarkets call, deduped — was called a
                // second time independently here pre-Wave-4).
                const v3EvMarkets = v3StakedEvMarkets;
                const v3SafetyResult = await runSafetyPipeline({
                  evMarkets: v3EvMarkets,
                  // v3 has no single unified scoreline matrix the way the
                  // legacy engine's finalMat is — statsGrid (the empirical-
                  // stats-split grid) is the closest analogue for
                  // CorrelationMatrix.compute's portfolio-correlation check.
                  matrix: v3Result.statsGrid,
                  telemetry: (state.telemetry ?? {}) as Record<string, unknown>,
                  calibFactorFor: marketExecutorRisk.calibFactorFor,
                  // Same fixture-level context as the legacy run (λ, odds,
                  // mes, drawRisk factors are shared) with ONLY the candidate
                  // set swapped for v3's — AntiSycophancy/RAG/Convergence/
                  // MLSafetyFilter read match-level fields duck-typed off
                  // this object, not the candidate identities.
                  context: { ...runResult, evMarkets: v3EvMarkets } as unknown as Record<
                    string,
                    unknown
                  >,
                  fetched: (state.pipeline?.fetched ?? {}) as Record<string, unknown>,
                  storage: deps.storage,
                  sharpCompressionTag: Boolean(runResult.sharpCompressionTag),
                  skipSensitivity: false,
                  safetyMode: config.safetyMode ?? "penalty",
                  sharpFeedVerified: config.sharpFeedVerified ?? false,
                  expectedScoreline: String(runResult.expectedScoreline ?? "?"),
                  home: job.home,
                  away: job.away,
                });
                const legacySafetyResult = {
                  evMarkets: runResult.evMarkets,
                  portfolioCorrelation: runResult.portfolioCorrelation,
                  correlatedParlayRisk: runResult.correlatedParlayRisk,
                  debate: (runResult.debate ?? {}) as Record<string, unknown>,
                  convergence: runResult.convergence,
                  mlFilter: runResult.mlFilter,
                } as unknown as SafetyPipelineResult;
                safetyShadowDiff = buildSafetyShadowDiff(legacySafetyResult, v3SafetyResult);
              } catch {
                /* diagnostic-only shadow run — never let it affect the real batch job */
              }
            }
          }
          // Demote the Q4 all-markets LLM catalogue-dump executor when v3
          // supplied this fixture's candidates — v3 IS the deterministic
          // all-markets answer (Rule 0: script math, not LLM probability
          // estimation), so paying for a second full-catalogue LLM pass over
          // the same fixture would be pure waste. Legacy behavior (including
          // an operator-enabled Q4 executor) is untouched when v3 is off,
          // shadow, or produced nothing for this fixture.
          //
          // PR-23: under "unmapped" scope, don't demote — instead narrow what
          // the executor sees (via a scoped decisionCtx at the decide() call
          // below) to just this fixture's recoverable skip-tail, so it sweeps
          // markets v3 couldn't price rather than re-analyzing the whole
          // catalogue v3 already handled. "full" scope keeps the original
          // demote (a second full-catalogue pass is still pure waste there).
          const unmappedTailScope = usedV3 && config.llmExecutorScope === "unmapped";
          const decideConfig =
            usedV3 && !unmappedTailScope ? { ...config, enableLlmMarketExecutor: false } : config;

          // Two-tier gate: only the top-N fixtures (by composite stats score,
          // flagged llmEligible at selection, computed once above processOne's
          // try block) reach the paid/slow LLM layers (briefing, swarm, decide,
          // CVL). Every other fixture still gets the full deterministic engine
          // analysis but skips all LLM calls.

          // B7: route based on convergence tier
          let briefingText: string | undefined;
          let briefingFlags: string[] | undefined; // captured for report surfacing
          let swarmConsensus: string | undefined; // captured for report surfacing
          let swarmDivergenceVal: number | undefined; // captured for report surfacing
          let swarmDivergence = false; // set true when swarm workers strongly disagree
          try {
            const { routeFixture } = await import("@oracle/llm");
            const route = routeFixture(String(convResult?.tier ?? "VIABLE"));

            // B1: optional briefing layer for APEX/PRIME fixtures
            if (
              llmEligible &&
              route.useBriefing &&
              config.enableBriefing &&
              extrasTierAllowed(route.tier, config.llmExtrasTiers) &&
              (config.claudeApiKey || config.geminiApiKey || config.openrouterApiKey)
            ) {
              try {
                const { callBriefing } = await import("@oracle/llm");
                const briefingPrompt = `Provide a brief pre-match analysis for ${job.home} vs ${job.away} (${job.league}).
Convergence tier: ${route.tier}. Top eligible bet: ${eligible[0]?.label ?? "none"} @ ${eligible[0]?.odds ?? "N/A"}.
Keep it under 200 words. Identify the single most important risk factor.`;
                const llmCtx = {
                  config: {
                    claudeApiKey: config.claudeApiKey,
                    geminiApiKey: config.geminiApiKey,
                    openrouterApiKey: config.openrouterApiKey,
                    bankroll: config.bankroll,
                  },
                  requestedAt: new Date().toISOString(),
                };
                const briefing = await callBriefing(briefingPrompt, llmCtx);
                briefingText = briefing.text;
                if (briefing.flags.length) {
                  briefingFlags = briefing.flags;
                  decisionCtx.softContext = [
                    ...(decisionCtx.softContext ?? []),
                    ...briefing.flags.map((f) => ({
                      kind: "news" as const,
                      text: `[BRIEFING_FLAG] ${f}`,
                      source: "callBriefing",
                      observedAt: new Date().toISOString(),
                    })),
                  ];
                }
              } catch {
                /* non-fatal */
              }
            }

            // Level-2 swarm: fan out sub-agent voters for high-conviction fixtures.
            // AUGMENTS the decision only — injects advisory consensus + divergence into
            // softContext. It never sets primaryPick; decide()/validateSelection remain authoritative.
            if (
              llmEligible &&
              route.swarmWorkers > 0 &&
              config.enableSwarm &&
              extrasTierAllowed(route.tier, config.llmExtrasTiers) &&
              (config.kimiApiKey || config.openrouterApiKey)
            ) {
              try {
                const { runSwarm, swarmToSoftContext } = await import("../swarm/index.js");
                const swarm = await runSwarm(
                  route.swarmWorkers,
                  { home: job.home, away: job.away, league: job.league, kickoff: job.kickoff },
                  eligible,
                  config,
                  decisionCtx.softContext
                );
                if (swarm) {
                  decisionCtx.softContext = [
                    ...(decisionCtx.softContext ?? []),
                    ...swarmToSoftContext(swarm),
                  ];
                  swarmDivergence = swarm.highDivergence;
                  swarmConsensus = swarm.consensusPick;
                  swarmDivergenceVal = swarm.divergence;
                }
              } catch {
                /* non-fatal */
              }
            }
          } catch {
            /* non-fatal — llm module unavailable */
          }

          // PR-23: the executor only ever reads ctx.allMarkets (buildPrompt's
          // draft-cascade prompt does not) — narrowing it here is sufficient
          // to scope the sweep, no other decide() behavior is affected. An
          // empty tail (v3 routed/priced everything) or a non-llmEligible
          // fixture both naturally no-op: runAllMarketsLlmExecutor's own
          // `!ctx.allMarkets?.length` guard covers the former, decide()'s
          // existing `!useDeterministicDraft` gate covers the latter.
          const decisionCtxForDecide = unmappedTailScope
            ? { ...decisionCtx, allMarkets: computeTailMarkets(allMarkets ?? []) }
            : decisionCtx;

          const {
            decision: rawDecision,
            replay: decisionReplay,
            shadow: decisionShadow,
            eligibleBets: executedEligible,
          } = await decide(
            eligible,
            decisionCtxForDecide,
            decideConfig,
            !llmEligible, // force deterministic for fixtures outside the top-N
            marketExecutorRisk,
            {
              // PR-8 posture A: skip the paid draft cascade when v3 already priced
              // the candidate set (inert when v3 off — usedV3 is false); skip the
              // per-fixture arbiter for fixtures outside the top-N.
              skipDraftLlm: usedV3 && config.v3DeterministicDraft === true,
              skipArbiter: !llmEligible,
            }
          );
          // Widened by one synthetic EVMarket only when the Q4 all-markets LLM
          // executor tier supplied the draft — identical to `eligible` otherwise.
          const effectiveEligible = executedEligible ?? eligible;
          const mlFilter = { mlAllowed: decisionCtx.mlAllowed, drawRisk: decisionCtx.drawRisk };
          const decision = validateSelection(rawDecision, effectiveEligible, mlFilter);
          // PR-23 review fix: effectiveEligible[0] is only the true top-EV pick
          // in "full" scope (direct-draft-forcing). Under "unmapped" scope the
          // executor candidate is spliced to index 0 regardless of its own EV
          // rank (decision/index.ts), so array position no longer implies EV
          // rank. Sort explicitly wherever "the top pick" is needed instead of
          // trusting array order; effectiveEligible itself stays untouched
          // (unsorted) since validateSelection/eligibleBets consumers below
          // don't assume any particular order.
          const evSortedEligible = [...effectiveEligible].sort((a, b) => b.ev - a.ev);

          // B2: optional CVL adversarial verification
          let cvlStatus: "APPROVED" | "OVERRIDE" | "VETO" | "SKIPPED" | undefined;
          try {
            const { routeFixture } = await import("@oracle/llm");
            const route = routeFixture(String(convResult?.tier ?? "VIABLE"));
            // Swarm high-divergence escalates to a CVL pass even on lower tiers.
            const cvlTriggered =
              (route.useCVL || swarmDivergence) &&
              config.enableCVL &&
              extrasTierAllowed(route.tier, config.llmExtrasTiers);
            if (
              llmEligible &&
              cvlTriggered &&
              (config.claudeApiKey || config.openrouterApiKey) &&
              rawDecision.grade !== "NO_EDGE"
            ) {
              const { callVerification } = await import("@oracle/llm");
              const cvlPrompt = `Primary pick: ${JSON.stringify(rawDecision.primaryPick)}. Rationale: ${rawDecision.rationale}. EV markets: ${JSON.stringify(evSortedEligible.slice(0, 3))}`;
              const llmCtx = {
                config: {
                  claudeApiKey: config.claudeApiKey,
                  geminiApiKey: config.geminiApiKey,
                  openrouterApiKey: config.openrouterApiKey,
                  bankroll: config.bankroll,
                },
                requestedAt: new Date().toISOString(),
              };
              const cvl = await callVerification(cvlPrompt, llmCtx);
              cvlStatus = cvl.status;
              if (cvl.status === "VETO") {
                // CVL VETO downgrades grade; primaryPick (best market) stays for reporting
                decision.grade = "LEAN";
                decision.rationale = `CVL VETO: ${cvl.rationale}`;
              }
            }
          } catch {
            /* non-fatal */
          }

          // Log when LLM disagrees with deterministic top (SkillOpt training signal)
          await logPickDisagreement(deps.storage, rawDecision, evSortedEligible[0] ?? null, {
            ...job,
            fixtureId,
          });
          void briefingText; // full briefing text retained for future report body rendering

          const primaryPick =
            effectiveEligible.find((m) => m.market === decision.primaryPick.market) ?? null;

          const analysisId = makeAnalysisId(fixtureId, rankingMode, calibrationSnapshotId);
          return {
            status: "ok" as const,
            analysisId,
            runId,
            fixtureId,
            home: job.home,
            away: job.away,
            league: job.league,
            kickoff: job.kickoff,
            result: filteredResult,
            decision,
            decisionReplay,
            decisionShadow,
            eligibleBets: effectiveEligible,
            primaryPick,
            llmEligible,
            cvlStatus,
            briefingFlags,
            swarmConsensus,
            swarmDivergence: swarmDivergenceVal,
            agentVerification: filteredResult.agentVerification,
            v3Best,
            v3BestFallback,
            v3DeliveryBest,
            v3Watchlist,
            v3AssessmentStats,
            v3Coverage,
            safetyKillCounts: mlResult?.killCounts as Record<string, number> | undefined,
            safetyShadowDiff,
          };
        },
        maxRetries,
        backoffMs
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const code = classifyError(reason);
      agentErrors.push({ code, fixtureId, message: reason, retriable: code === "RATE_LIMITED" });
      return {
        status: "error",
        fixtureId,
        home: job.home,
        away: job.away,
        league: job.league,
        kickoff: job.kickoff,
        reason,
        errorCode: code,
        llmEligible,
      };
    }
  }

  // Initial progress event (completed: 0) — preserves the pre-loop semantics
  // callers relied on under the old sequential runner.
  onProgress?.({
    completed: 0,
    total,
    current: jobs[0] ? `${jobs[0].home} vs ${jobs[0].away}` : "",
  });

  // Level-1 swarm: process up to `concurrency` fixtures in parallel.
  // Results preserve input order. Cost ceiling stops scheduling new fixtures
  // (in-flight ones finish); per-key storage locks keep RAG/logs race-free.
  const poolResults = await runPool(jobs, concurrency, processOne, {
    onSettled: (i, r) => {
      // Charge only billable (LLM) decisions toward the ceiling. The GLM-5.2
      // shadow call and the ORACLE_AGENT_VERIFY local-CLI check (when present)
      // are each a second billable request — without this they'd silently
      // spend past costCeilingUsd.perRun unnoticed.
      if (r.status === "ok" && r.decisionReplay !== null) {
        costTracker.charge();
        if (r.decisionShadow) costTracker.charge();
        if (r.agentVerification) costTracker.charge();
      }
      onProgress?.({
        completed: ++completedCounter,
        total,
        current: `${jobs[i]?.home} vs ${jobs[i]?.away}`,
      });
    },
    shouldStop: () => (uncappedOnVps ? false : costTracker.halted),
  });

  // runPool leaves holes for fixtures skipped after a cost-ceiling halt — drop them.
  const results = poolResults.filter((r): r is BatchJobResult => r != null);
  // costTracker.halted can still flip true on uncapped-VPS runs once spend
  // crosses the ceiling (charge() sets it unconditionally) — but shouldStop
  // above never acted on it there, so reporting halted=true would be a false
  // alarm. Force it false in that case to reflect what actually happened.
  const costHalted = uncappedOnVps ? false : costTracker.halted;
  if (costHalted) {
    agentErrors.push({
      code: "COST_CEILING_HIT",
      message: `Per-run cost ceiling $${(ceilingUsd ?? 0).toFixed(2)} reached — stopped scheduling after ${results.filter((r) => r.status === "ok").length} fixture(s)`,
      retriable: false,
    });
  }

  onProgress?.({ completed: total, total, current: "" });

  const successful = results.filter((r): r is FixtureJobSuccess => r.status === "ok");
  const actionable = successful.filter((r) => r.decision.grade !== "NO_EDGE");
  const totalStakePct = actionable.reduce(
    (sum, r) => sum + (r.decision.primaryPick.stake ?? 0) * 100,
    0
  );

  return {
    runId,
    calibrationSnapshotId,
    date: new Date().toISOString().slice(0, 10),
    rankingMode,
    jobs: results,
    completedCount: successful.length,
    errorCount: results.filter((r) => r.status === "error").length,
    actionableCount: actionable.length,
    totalRecommendedStakePct: parseFloat(totalStakePct.toFixed(2)),
    cost: { estimatedUsd: costTracker.spent, ceilingUsd, halted: costHalted },
    errors: agentErrors,
  };
}
