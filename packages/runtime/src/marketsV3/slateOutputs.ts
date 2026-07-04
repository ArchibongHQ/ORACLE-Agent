/** PR-5b — slate-level Outputs A–D + sanity assembly for the all-markets daily
 *  batch. Pure glue only: reduces a day's FixtureJobSuccess list (each
 *  carrying a compact v3Best/v3AssessmentStats projection populated by
 *  @oracle/engine's batch/index.ts processOne) through the existing pure
 *  @oracle/engine output builders — buildGateSurvivingPool/buildOutputA-D,
 *  slateSanityChecks. No new pricing/gating logic lives here. */

import {
  type AllMarketsSanityInput,
  buildGateSurvivingPool,
  buildOutputA,
  buildOutputB,
  buildOutputC,
  buildOutputD,
  type FixtureJobSuccess,
  formatSanityFlags,
  slateSanityChecks,
  type V3OutputB,
  type V3OutputRow,
  type V3SanityResult,
  type V3SlateFixture,
} from "@oracle/engine";

export interface MarketsV3SlateOutputs {
  pool: V3OutputRow[];
  outputA: V3OutputRow[];
  outputB: V3OutputB;
  outputC: V3OutputRow[];
  outputD: V3OutputRow[];
  sanity: V3SanityResult;
  sanityLine: string;
}

/** Build the day's slate-level v3 outputs from every successfully-analyzed
 *  fixture. Fixtures with no v3Best (v3 didn't run for them, or nothing
 *  survived) contribute best: null — buildGateSurvivingPool drops them, a
 *  valid, common outcome (never an error). */
export function buildMarketsV3SlateOutputs(jobs: FixtureJobSuccess[]): MarketsV3SlateOutputs {
  const fixtures: V3SlateFixture[] = jobs.map((j) => ({
    fixtureId: j.fixtureId,
    home: j.home,
    away: j.away,
    league: j.league,
    kickoff: j.kickoff,
    best: j.v3Best ?? null,
  }));
  const pool = buildGateSurvivingPool(fixtures);
  const outputA = buildOutputA(pool);
  const outputB = buildOutputB(outputA);
  const outputC = buildOutputC(pool);
  const outputD = buildOutputD(pool);
  // V3AssessmentStat.outcome is a plain `string` on the batch-carried projection
  // (packages/engine's batch/index.ts), narrower than that only inside the v3
  // gate itself — cast, not a real type hole, since every value that lands
  // there was already produced by V3AllGateOutcome upstream.
  const sanityInputs: AllMarketsSanityInput[] = jobs.flatMap(
    (j) => (j.v3AssessmentStats ?? []) as AllMarketsSanityInput[]
  );
  const sanity = slateSanityChecks(sanityInputs);
  return {
    pool,
    outputA,
    outputB,
    outputC,
    outputD,
    sanity,
    sanityLine: formatSanityFlags(sanity),
  };
}

/** §7-ranked replacement for the legacy league-tier+confidence 39-cap trim
 *  (apps/worker's runDailyBatch). Picks matching a v3Best-ranked fixture (by
 *  home::away key — unique within one batch run, no duplicate fixtures per
 *  run) sort by that rank; unmatched picks (v3 declined/fail-open for that
 *  fixture, or v3 wasn't live) sort AFTER every ranked pick, ordered by
 *  confidence descending among themselves — so a v3-off fixture is never
 *  silently preferred over one v3 actually priced and ranked. */
export function curateActionableByV3Outputs<
  T extends { home: string; away: string; confidence: number },
>(actionable: T[], outputA: V3OutputRow[], max: number): T[] {
  const rankByKey = new Map(outputA.map((r, i) => [`${r.home}::${r.away}`, i]));
  return [...actionable]
    .sort((a, b) => {
      const ra = rankByKey.get(`${a.home}::${a.away}`);
      const rb = rankByKey.get(`${b.home}::${b.away}`);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return b.confidence - a.confidence;
    })
    .slice(0, max);
}
