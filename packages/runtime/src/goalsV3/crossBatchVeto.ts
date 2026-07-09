/** [PR-13, audit item] Cross-BATCH portfolio dedup.
 *
 *  The daily all-markets batch (09:35 WAT) and the goals-only v3 batch
 *  (09:40 WAT) run as two fully independent pipelines by design (resilience —
 *  a failure in one must never block the other). selectGoals.ts's
 *  greedyCorrelationAwareSelect already guards against a goals leg being too
 *  correlated with another leg from its OWN candidate pool
 *  (CROSS_FIXTURE_CORRELATION_REJECT = 0.3, same league + near-simultaneous
 *  kickoff — shared officiating climate/weather/matchday narrative risk).
 *  Nothing today runs that same check against the daily batch's
 *  ALREADY-COMMITTED picks — a goals leg on a fixture in the same league and
 *  kickoff window as an already-decided daily-batch pick carries the exact
 *  same correlated risk, just invisible because the two pipelines don't talk
 *  to each other.
 *
 *  This reuses the identical threshold/primitive as the intra-batch check
 *  (not a new, separately-calibrated cutoff) and only ever vetoes the goals
 *  batch's OWN candidates — the daily batch's picks (existingLegs) are
 *  already committed/sent by the time this runs and are never touched. */

import type { PortfolioLeg } from "@oracle/engine";
import { pairwiseCrossFixtureCorrelation } from "@oracle/engine";
import {
  CROSS_FIXTURE_CORRELATION_REJECT,
  computeMiniAccaStats,
  type GoalsLeg,
  type GoalsSelectionResult,
  toPortfolioLeg,
} from "../selectGoals.js";
import { dedupeLegs, slateLegKey } from "./slateArbiter.js";

/** legKey → reason, for every deduped leg in `selection` whose cross-fixture
 *  correlation with ANY existingLeg exceeds CROSS_FIXTURE_CORRELATION_REJECT.
 *  Empty existingLegs (daily batch hasn't run yet / its manifest is
 *  unavailable) short-circuits to no vetoes — fails open, exactly today's
 *  pre-PR-13 behavior.
 *
 *  Same-fixture override: pairwiseCrossFixtureCorrelation returns 0 for two
 *  legs on the SAME match (`a.home===b.home && a.away===b.away` — by design,
 *  since its intra-batch caller already dedupes same-fixture legs upstream).
 *  Cross-batch that assumption doesn't hold — the daily batch and goals batch
 *  can independently pick the identical match on two different markets,
 *  which is the single highest-correlation case there is, not a zero. Check
 *  same-fixture explicitly first rather than relying on the primitive. */
export function crossBatchVetoKeys(
  selection: GoalsSelectionResult,
  existingLegs: PortfolioLeg[]
): Map<string, string> {
  const vetoes = new Map<string, string>();
  if (existingLegs.length === 0) return vetoes;
  for (const leg of dedupeLegs(selection)) {
    const candidate = toPortfolioLeg(leg);
    for (const existing of existingLegs) {
      const sameFixture = candidate.home === existing.home && candidate.away === existing.away;
      const rho = sameFixture ? 1 : pairwiseCrossFixtureCorrelation(candidate, existing);
      if (rho > CROSS_FIXTURE_CORRELATION_REJECT) {
        const reason = sameFixture
          ? `same fixture as daily-batch pick ${existing.home} vs ${existing.away} (${existing.market})`
          : `cross-batch correlation ${rho.toFixed(2)} vs daily-batch pick ${existing.home} vs ${existing.away} (${existing.market})`;
        vetoes.set(slateLegKey(leg), reason);
        break;
      }
    }
  }
  return vetoes;
}

/** Applies the cross-batch veto — same keep()/recompute shape as
 *  applySlateVerdicts (slateArbiter.ts), veto-only (no flag annotation: this
 *  isn't an LLM soft-call, there's nothing to annotate for). */
export function applyCrossBatchVeto(
  selection: GoalsSelectionResult,
  vetoes: Map<string, string>
): GoalsSelectionResult {
  if (vetoes.size === 0) return selection;

  const keep = (legs: GoalsLeg[]): GoalsLeg[] =>
    legs.filter((leg) => !vetoes.has(slateLegKey(leg)));

  const legs = keep(selection.legs);
  const shortSlipLegs = keep(selection.shortSlipLegs);
  const miniAccaLegs = keep(selection.miniAccaLegs);
  const outputBLegs = keep(selection.outputBLegs);
  const outputCLegs = keep(selection.outputCLegs);

  const prod = (xs: GoalsLeg[], f: (l: GoalsLeg) => number): number =>
    xs.reduce((acc, l) => acc * f(l), 1);
  const droppedFromLong = legs.length !== selection.legs.length;
  const droppedFromShort = shortSlipLegs.length !== selection.shortSlipLegs.length;
  const droppedFromMini = miniAccaLegs.length !== selection.miniAccaLegs.length;
  const miniAccaStats = droppedFromMini ? computeMiniAccaStats(miniAccaLegs) : null;

  return {
    ...selection,
    legs,
    shortSlipLegs,
    miniAccaLegs,
    outputBLegs,
    outputCLegs,
    combinedProb: droppedFromLong ? prod(legs, (l) => l.mp) : selection.combinedProb,
    combinedOdds: droppedFromLong ? prod(legs, (l) => l.odds) : selection.combinedOdds,
    shortSlipCombinedProb: droppedFromShort
      ? prod(shortSlipLegs, (l) => l.mp)
      : selection.shortSlipCombinedProb,
    shortSlipCombinedOdds: droppedFromShort
      ? prod(shortSlipLegs, (l) => l.odds)
      : selection.shortSlipCombinedOdds,
    ...(miniAccaStats ?? {}),
  };
}
