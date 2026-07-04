/** PR-5a — slate-level all-markets pre-filter over sidecar-mapped fixtures.
 *
 *  Runs gateMarketsV3Fixture (eligibility + weighted completeness, reused
 *  verbatim from pipeline.ts) over every daily-batch job that maps to a
 *  SportyBet sidecar detail, BEFORE the chunk loop — dropping fixtures v3
 *  would discard anyway saves their entire engine+LLM analysis cost.
 *
 *  Fail-open contract (missing data is never a blocker):
 *  - job with no sidecar mapping ⇒ kept, untouched (the gate can't evaluate it)
 *  - any thrown error ⇒ the ORIGINAL job list is returned, summary null
 *  - every mapped fixture discarded AND nothing unmapped ⇒ caller should fail
 *    open to the ungated slate (an all-drop is more likely an upstream league-
 *    name/schema regression than a genuinely empty slate — see
 *    completenessInputs.ts for the same fear, instrumented)
 *
 *  Survivors are stamped `telemetry.v3Heightened` from their §1.2 eligibility
 *  class, completing the all-markets heightened wiring deferred in PR-3
 *  (buildV3Input consumes the stamp per fixture). Pure, synchronous, no I/O. */

import type { FixtureJob } from "@oracle/engine";
import { findSidecarDetail, type SportyBetEventDetail } from "../selectFixtures.js";
import {
  gateMarketsV3Fixture,
  type MarketsV3GateConfig,
  type V3EnrichmentState,
} from "./pipeline.js";

export interface SlateGateSummary {
  /** Sidecar-mapped fixtures the gate actually evaluated. */
  total: number;
  passed: number;
  discardCounts: Record<string, number>;
  /** Fixtures with no sidecar mapping — always kept, never evaluated. */
  unmapped: number;
}

export interface SlateGateOutcome {
  jobs: FixtureJob[];
  /** null ⇒ gate did not run (no sidecar index, or error fail-open) — `jobs`
   *  is the input list untouched. */
  summary: SlateGateSummary | null;
}

/** Mirror of the goals path's enrichment derivation (worker completeness gate):
 *  H2H presence from the fetched stats block, lineups from softContext. */
function deriveEnrichment(job: FixtureJob, completenessV4?: boolean): V3EnrichmentState {
  const fetched = job.state?.pipeline?.fetched as { stats?: { h2hN?: number } } | undefined;
  const softContext = job.state?.telemetry?.softContext ?? [];
  return {
    h2hEnriched: typeof fetched?.stats?.h2hN === "number",
    lineupsAvailable: softContext.some((item) => item.kind === "lineup"),
    completenessV4,
  };
}

function stampHeightened(job: FixtureJob, heightened: boolean): FixtureJob {
  return {
    ...job,
    state: {
      ...(job.state ?? {}),
      telemetry: { ...(job.state?.telemetry ?? {}), v3Heightened: heightened },
    },
  };
}

/** Gate a daily-batch job list against the v3 slate pre-filter. */
export function prefilterMarketsV3Jobs(
  jobs: FixtureJob[],
  detailByKey: Map<string, SportyBetEventDetail> | undefined,
  gateConfig: MarketsV3GateConfig,
  opts: { completenessV4?: boolean } = {}
): SlateGateOutcome {
  try {
    if (!detailByKey?.size) return { jobs, summary: null };
    const kept: FixtureJob[] = [];
    const discardCounts: Record<string, number> = {};
    let unmapped = 0;
    let mapped = 0;
    let passed = 0;
    for (const job of jobs) {
      const detail = findSidecarDetail(detailByKey, job.home, job.away);
      if (!detail) {
        unmapped += 1;
        kept.push(job);
        continue;
      }
      mapped += 1;
      const result = gateMarketsV3Fixture(
        {
          home: job.home,
          away: job.away,
          league: job.league,
          marketCount: detail.odds?.allMarkets?.length ?? 0,
          detail,
        },
        gateConfig,
        deriveEnrichment(job, opts.completenessV4)
      );
      if (!result.passes) {
        if (result.discardReason)
          discardCounts[result.discardReason] = (discardCounts[result.discardReason] ?? 0) + 1;
        continue;
      }
      passed += 1;
      kept.push(stampHeightened(job, result.eligibility.status === "heightened"));
    }
    return { jobs: kept, summary: { total: mapped, passed, discardCounts, unmapped } };
  } catch {
    return { jobs, summary: null };
  }
}

/** One-line batch log: `gate: N mapped → M survive (K unmapped pass; reason: n, …)`. */
export function formatSlateGateLog(summary: SlateGateSummary): string {
  const reasons = Object.entries(summary.discardCounts)
    .map(([reason, n]) => `${reason}: ${n}`)
    .join(", ");
  return (
    `gate: ${summary.total} mapped → ${summary.passed} survive ` +
    `(${summary.unmapped} unmapped pass through${reasons ? `; ${reasons}` : ""})`
  );
}
