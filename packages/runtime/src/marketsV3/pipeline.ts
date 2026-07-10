/** all-markets-analysis-prompt-v3 §0/§1 — eligibility + weighted completeness
 *  gate for the ALL-MARKETS pipeline.
 *
 *  Reuses the goals-only v3 modules verbatim rather than duplicating them:
 *  `classifyEligibility` (league whitelist, SRL/virtual hard-discard,
 *  heightened youth/women/friendly/cup-final treatment) and `scoreCompleteness`
 *  (the exact §0.4 weighted gate: odds15/form15/scored15/conceded15/
 *  hitRate10/xg10/h2h10/lineups5/rest5, mandatory-block discard, <70 discard).
 *
 *  Known simplification (documented, not silent): §1.2's low-scoring-derby
 *  hard-discard is spec'd as "goals markets only — result markets may stand".
 *  `classifyEligibility` discards derbies outright for ALL markets, which is
 *  conservative rather than exactly spec-faithful — acceptable for launch
 *  since it only ever removes candidates, never admits bad ones; a market-
 *  aware split can follow if it proves too aggressive in practice.
 *
 *  This module is a standalone, tested gate — NOT yet wired into the worker's
 *  slate-level fixture filtering (that remains a follow-up; see workflows/
 *  markets_v3.md). The per-fixture engine integration in
 *  packages/engine/src/batch/index.ts fails open on thin data via v3's own
 *  penalty table instead, so a slate-level pre-filter is additive, not
 *  required for v3 to run correctly.
 *
 *  Pure, synchronous, no I/O. */

import {
  heightenedTrendsAligned,
  scoreCompleteness,
  type V3Completeness,
  type V3EnrichmentState,
} from "../goalsV3/completeness.js";
import {
  classifyEligibility,
  type V3Eligibility,
  type V3EligibilityStatus,
} from "../goalsV3/eligibility.js";
import type { SportyBetEvent, SportyBetEventDetail } from "../selectFixtures.js";

export type { V3Completeness, V3Eligibility, V3EligibilityStatus, V3EnrichmentState };
export { classifyEligibility, heightenedTrendsAligned };

export interface MarketsV3GateConfig {
  /** §0.4 weighted completeness floor (0-100) for normally-eligible fixtures. */
  completenessMin: number;
  /** Higher bar for §1.2 heightened fixtures (youth/women/friendly/cup-final). */
  heightenedMin: number;
}

/** ORACLE_MARKETS_V3_COMPLETENESS_MIN / ORACLE_MARKETS_V3_HEIGHTENED_MIN —
 *  separate env keys from the goals-only batch's GOALS_V3_* so the two
 *  pipelines can be tuned independently; same 70/85 spec defaults. */
export function buildMarketsV3GateConfig(
  env: Record<string, string | undefined>
): MarketsV3GateConfig {
  return {
    completenessMin: Number(env.ORACLE_MARKETS_V3_COMPLETENESS_MIN ?? 70),
    heightenedMin: Number(env.ORACLE_MARKETS_V3_HEIGHTENED_MIN ?? 85),
  };
}

export interface MarketsV3GateResult {
  eligibility: V3Eligibility;
  completeness: V3Completeness;
  /** [refactor P0-2] completeness.score normalized to the 0-1 scale
   *  packages/engine/src/marketsV3's blend gate expects (V3AllMarketsInput
   *  .completeness / evGate.ts's computeMarketBlend) — completeness.score
   *  itself stays 0-100 (V3_COMPLETENESS_WEIGHTS sums to 100) for backward
   *  compat with every existing completenessMin/heightenedMin comparison.
   *  Present on every branch below, including the discard paths, so a caller
   *  that stamps telemetry.v3Completeness from a non-passing gate result
   *  still gets a real number instead of undefined. */
  completenessScore01: number;
  /** True ⇒ fixture clears both the eligibility and completeness gates. */
  passes: boolean;
  /** Machine-readable reason when passes=false (for slate-level discard logs). */
  discardReason?:
    | "srl_virtual"
    | "not_whitelisted"
    | "missing_mandatory_odds"
    | "derby"
    | "mandatory_data_missing"
    | "below_completeness_floor"
    | "heightened_trends_not_aligned";
}

/** Run the full Phase 0/1 gate for one fixture. `enrich` carries the
 *  cross-cutting enrichment signals scoreCompleteness needs (H2H/lineups)
 *  that aren't in the raw SportyBet detail — same contract as the goals-only
 *  batch's call site. */
export function gateMarketsV3Fixture(
  event: SportyBetEvent,
  config: MarketsV3GateConfig,
  enrich: V3EnrichmentState = {}
): MarketsV3GateResult {
  const eligibility = classifyEligibility(event);
  const detail: SportyBetEventDetail | undefined = event.detail;
  const completeness = scoreCompleteness(detail, enrich);
  const completenessScore01 = completeness.score / 100;

  if (eligibility.status === "discard") {
    const reason = eligibility.reasons[0] as MarketsV3GateResult["discardReason"];
    return { eligibility, completeness, completenessScore01, passes: false, discardReason: reason };
  }

  if (completeness.mandatoryMissing.length > 0) {
    return {
      eligibility,
      completeness,
      completenessScore01,
      passes: false,
      discardReason: "mandatory_data_missing",
    };
  }

  const minScore =
    eligibility.status === "heightened" ? config.heightenedMin : config.completenessMin;
  if (completeness.score < minScore) {
    return {
      eligibility,
      completeness,
      completenessScore01,
      passes: false,
      discardReason: "below_completeness_floor",
    };
  }

  if (eligibility.status === "heightened" && !heightenedTrendsAligned(detail)) {
    return {
      eligibility,
      completeness,
      completenessScore01,
      passes: false,
      discardReason: "heightened_trends_not_aligned",
    };
  }

  return { eligibility, completeness, completenessScore01, passes: true };
}

export interface MarketsV3SlateSummary {
  total: number;
  passed: number;
  discardCounts: Record<string, number>;
}

/** Slate-level convenience: gate every event, tally discard reasons for a
 *  one-line batch log (`[markets-v3] gate: N → M survive (reason: k, ...)`). */
export function gateMarketsV3Slate(
  events: SportyBetEvent[],
  config: MarketsV3GateConfig,
  enrichByEvent: (event: SportyBetEvent) => V3EnrichmentState = () => ({})
): { results: MarketsV3GateResult[]; summary: MarketsV3SlateSummary } {
  const results = events.map((event) => gateMarketsV3Fixture(event, config, enrichByEvent(event)));
  const discardCounts: Record<string, number> = {};
  let passed = 0;
  for (const r of results) {
    if (r.passes) passed += 1;
    else if (r.discardReason)
      discardCounts[r.discardReason] = (discardCounts[r.discardReason] ?? 0) + 1;
  }
  return { results, summary: { total: events.length, passed, discardCounts } };
}
