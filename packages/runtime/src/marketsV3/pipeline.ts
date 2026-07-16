/** all-markets-analysis-prompt-v3 §0/§1 — eligibility + weighted completeness
 *  gate for the ALL-MARKETS pipeline.
 *
 *  Reuses the goals-only v3 modules verbatim rather than duplicating them:
 *  `classifyEligibility` (SRL/virtual hard-discard, missing-mandatory-odds
 *  discard, heightened youth/women/derby/friendly/cup-final treatment — the
 *  league whitelist is no longer a discard gate, see eligibility.ts's module
 *  docstring) and `scoreCompleteness` (the exact §0.4 weighted gate:
 *  odds15/form15/scored15/conceded15/hitRate10/xg10/h2h10/lineups5/rest5,
 *  mandatory-block discard, <70 discard).
 *
 *  [Wave-4 WS-A3] `restrictOddsToGoalsOverOnly` below is the choke point for
 *  friendlies' `marketRestriction: "goals_over_only"` (set by
 *  classifyEligibility) — applied to a survivor's `fetched.sportyBetOdds` by
 *  slateGate.ts's prefilterMarketsV3Jobs before the job is kept, so the
 *  restricted market table is what reaches pricing.
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
import type { SportyBetEvent, SportyBetEventDetail, SportyBetOdds } from "../selectFixtures.js";

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
  /** Machine-readable reason when passes=false (for slate-level discard logs).
   *  [Wave-4 WS-A3] "not_whitelisted" removed (whitelist no longer gates —
   *  off-list fixtures now carry a non-gating `off_whitelist` eligibility
   *  annotation instead) and "derby" removed (derbies are heightened, not
   *  discarded, per the same change). "already_kicked_off" added — produced
   *  by slateGate.ts's prefilterMarketsV3Jobs (kickoff ≤ now belt-and-braces
   *  guard), not by this module's own gateMarketsV3Fixture. */
  discardReason?:
    | "srl_virtual"
    | "missing_mandatory_odds"
    | "mandatory_data_missing"
    | "below_completeness_floor"
    | "heightened_trends_not_aligned"
    | "already_kicked_off";
  /** [patterns-engine Wave 1 — Phase 5 "see every fixture"] Non-gating
   *  data-quality flags carried on a PASSING result. `mandatory_data_missing`,
   *  `below_completeness_floor`, and `heightened_trends_not_aligned` no longer
   *  discard a fixture — the pricers degrade gracefully on thin data — so the
   *  shortfall is recorded here instead for observability + downstream
   *  confidence weighting. Empty/absent ⇒ full-data fixture. */
  annotations?: string[];
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

  // Real hard discards: only eligibility-level rejects (srl_virtual /
  // missing_mandatory_odds) truly cannot be analysed — a virtual/SRL fixture or
  // one with no priceable odds at all. Everything else falls through to
  // analysis (see the Phase 5 annotation block below).
  if (eligibility.status === "discard") {
    const reason = eligibility.reasons[0] as MarketsV3GateResult["discardReason"];
    return { eligibility, completeness, completenessScore01, passes: false, discardReason: reason };
  }

  // [patterns-engine Wave 1 — Phase 5 "see every fixture"] Data-completeness
  // shortfalls no longer DISCARD the fixture. The pricers degrade gracefully on
  // thin data (v3's own penalty table + empirical→model fallbacks), and the
  // owner requirement is that every scraped fixture with priceable odds reaches
  // analysis — over-filtering on data richness was starving the slate. Each
  // shortfall is recorded as a non-gating annotation instead.
  const annotations: string[] = [];
  if (completeness.mandatoryMissing.length > 0) {
    annotations.push("mandatory_data_missing");
  }
  const minScore =
    eligibility.status === "heightened" ? config.heightenedMin : config.completenessMin;
  if (completeness.score < minScore) {
    annotations.push("below_completeness_floor");
  }
  if (eligibility.status === "heightened" && !heightenedTrendsAligned(detail)) {
    annotations.push("heightened_trends_not_aligned");
  }

  return {
    eligibility,
    completeness,
    completenessScore01,
    passes: true,
    ...(annotations.length ? { annotations } : {}),
  };
}

export interface MarketsV3SlateSummary {
  total: number;
  passed: number;
  discardCounts: Record<string, number>;
  /** [patterns-engine Wave 1 — Phase 5] Non-gating data-quality flags tallied
   *  across passing fixtures (mandatory_data_missing / below_completeness_floor
   *  / heightened_trends_not_aligned). Observability only — these fixtures are
   *  counted in `passed`, not dropped. */
  annotationCounts: Record<string, number>;
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
  const annotationCounts: Record<string, number> = {};
  let passed = 0;
  for (const r of results) {
    if (r.passes) {
      passed += 1;
      for (const a of r.annotations ?? []) annotationCounts[a] = (annotationCounts[a] ?? 0) + 1;
    } else if (r.discardReason)
      discardCounts[r.discardReason] = (discardCounts[r.discardReason] ?? 0) + 1;
  }
  return { results, summary: { total: events.length, passed, discardCounts, annotationCounts } };
}

type OverUnder = { over?: number | null; under?: number | null } | null | undefined;

/** Keep only the `over` side of an O/U pair, dropping `under`. */
function overOnly(ou: OverUnder): OverUnder {
  return ou ? { over: ou.over } : ou;
}

/** Same, applied to every line in a keyed O/U record (e.g. half.ht_ou's
 *  `{ "0.5": {over,under}, "1.5": {...} }` shape). */
function recordOverOnly(
  rec: Record<string, { over?: number | null; under?: number | null }> | null | undefined
): Record<string, { over?: number | null; under?: number | null }> | null | undefined {
  if (!rec) return rec;
  const out: Record<string, { over?: number | null; under?: number | null }> = {};
  for (const [line, v] of Object.entries(rec)) out[line] = overOnly(v) ?? {};
  return out;
}

/** [Wave-4 WS-A3] Choke point for `V3Eligibility.marketRestriction ===
 *  "goals_over_only"` (friendlies — see eligibility.ts's classifyEligibility
 *  step 2). Friendly defenses/rotation make RESULT markets unmodelable, but
 *  goals still flow at a modelable base rate, so the fixture's market table
 *  is rewritten down to exactly three Over-only families:
 *    - match goals O/U Over (ou15 / ou25 / ou35)
 *    - 1st-half match-total goals Over (half.ht_ou, per line)
 *    - team-total goals Over (tt_home_05 / tt_away_05)
 *  Every other family is dropped: "1x2" and its derivatives (dc/dnb/ah),
 *  btts, combo markets, 2nd-half and team-half exotics, and Under sides of
 *  the three kept families.
 *
 *  `allMarkets` (the generic 900+-entry catalogue — corners, cards, clean
 *  sheets, half-results, etc.) is dropped WHOLESALE rather than filtered:
 *  this codebase has no documented market-id → family map beyond gismo id
 *  "1" = 1X2 (see slateGate.ts's toMarketsBlockEntries comment), and per the
 *  no-invented-data constraint we don't build one here. Dropping it whole is
 *  the conservative choice — it can only remove candidate markets, never
 *  admit an out-of-policy one.
 *
 *  Called by slateGate.ts's prefilterMarketsV3Jobs against a survivor's
 *  `state.pipeline.fetched.sportyBetOdds` — the exact field
 *  packages/engine/src/batch/index.ts reads to build the pricing input
 *  (`state.pipeline?.fetched?.sportyBetOdds.allMarkets`), so rewriting it
 *  here is what actually keeps the restricted markets from reaching pricing. */
export function restrictOddsToGoalsOverOnly(
  odds: SportyBetOdds | null | undefined
): SportyBetOdds | null {
  if (!odds) return odds ?? null;
  return {
    ou15: overOnly(odds.ou15),
    ou25: overOnly(odds.ou25),
    ou35: overOnly(odds.ou35),
    tt_home_05: overOnly(odds.tt_home_05),
    tt_away_05: overOnly(odds.tt_away_05),
    half: odds.half ? { ht_ou: recordOverOnly(odds.half.ht_ou) } : odds.half,
  };
}
