/** PR-5b — slate-level Outputs A–D + sanity assembly for the all-markets daily
 *  batch. Pure glue only: reduces a day's FixtureJobSuccess list (each
 *  carrying a compact v3Best/v3AssessmentStats projection populated by
 *  @oracle/engine's batch/index.ts processOne) through the existing pure
 *  @oracle/engine output builders — buildGateSurvivingPool/buildOutputA-D,
 *  slateSanityChecks. No new pricing/gating logic lives here. */

import {
  type AllMarketsSanityInput,
  type BatchJobResult,
  buildGateSurvivingPool,
  buildOutputA,
  buildOutputB,
  buildOutputC,
  buildOutputD,
  type FixtureJobSuccess,
  formatSanityFlags,
  formatSkewShrinkShadow,
  type RouteCoverage,
  type RunManifest,
  shadowSkewShrink,
  slateSanityChecks,
  type V3Engine,
  type V3OutputB,
  type V3OutputRow,
  type V3SanityResult,
  type V3Skip,
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
  /** Desktop-audit concept #4, shadow-mode only (see engine's skewShrink.ts
   *  header) — null when sanity fired no skew flag, or every flagged pick
   *  would still clear its gate under shrinkage. Never affects pool/outputA-D. */
  skewShrinkLine: string | null;
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
  const skewShrink = shadowSkewShrink(sanityInputs, sanity);
  return {
    pool,
    outputA,
    outputB,
    outputC,
    outputD,
    sanity,
    sanityLine: formatSanityFlags(sanity),
    skewShrinkLine: formatSkewShrinkShadow(skewShrink),
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

function mergeCounts<K extends string>(
  a: Record<K, number>,
  b: Record<K, number>
): Record<K, number> {
  const out: Record<K, number> = { ...a };
  for (const k of Object.keys(b) as K[]) out[k] = (out[k] ?? 0) + b[k];
  return out;
}

const TOP_UNROUTED_LIMIT = 5;

export interface SlateMarketCoverage {
  /** Distinct market ENTRIES seen (one per SportyBet market id/specifier —
   *  routeCoverage() in feedDictionary.ts increments this once per entry). */
  total: number;
  /** Subset of `total` that routeMarket() mapped to an engine — entry-level,
   *  same unit as `total`. NOT directly comparable to `priced`/`gatePassed`
   *  below, which count individual OUTCOMES (a routed O/U or 1X2 entry has
   *  2-3 outcomes each) — `priced` can exceed `routed` on a normal slate. */
  routed: number;
  /** Count of OUTCOMES that reached a successful price+devig (regardless of
   *  gate verdict) — summed from each fixture's v3AssessmentStats, one entry
   *  per outcome, not per market. */
  priced: number;
  /** Subset of `priced` whose gate outcome was "done" (an actual EV
   *  candidate), summed across the slate. Outcome-level, same unit as `priced`. */
  gatePassed: number;
  byEngine: Record<V3Engine, number>;
  skipped: Record<V3Skip["reason"], number>;
  /** Merged unrouted market NAME -> slate-wide count, top-5 by count desc. */
  topUnrouted: Array<{ name: string; count: number }>;
}

/** Slate-wide rollup of every analyzed fixture's v3Coverage + v3AssessmentStats
 *  (PR-20) — merges routed/priced/gate-passed/unrouted tallies across the
 *  day's fixtures so the recoverable skip tail (no-grid-model/uncatalogued/
 *  bad-specifier) is visible in the Telegram summary + RunManifest instead of
 *  being computed per-fixture and discarded. Returns null when no fixture in
 *  the batch carried v3Coverage (v3 off, or nothing analyzed) — a valid,
 *  common outcome, never an error. */
export function rollupCoverage(jobs: FixtureJobSuccess[]): SlateMarketCoverage | null {
  const withCoverage = jobs.filter((j) => j.v3Coverage != null);
  if (!withCoverage.length) return null;

  let total = 0;
  let routed = 0;
  let priced = 0;
  let gatePassed = 0;
  let byEngine = {} as Record<V3Engine, number>;
  let skipped = {} as Record<V3Skip["reason"], number>;
  const unrouted: Record<string, number> = {};

  for (const job of withCoverage) {
    const c = job.v3Coverage as RouteCoverage;
    total += c.total;
    routed += c.routed;
    byEngine = mergeCounts(byEngine, c.byEngine);
    skipped = mergeCounts(skipped, c.skipped);
    for (const [name, count] of Object.entries(c.unrouted ?? {})) {
      unrouted[name] = (unrouted[name] ?? 0) + count;
    }
    for (const a of job.v3AssessmentStats ?? []) {
      priced += 1;
      if (a.outcome === "done") gatePassed += 1;
    }
  }

  const topUnrouted = Object.entries(unrouted)
    .sort(([, a], [, b]) => b - a)
    .slice(0, TOP_UNROUTED_LIMIT)
    .map(([name, count]) => ({ name, count }));

  return { total, routed, priced, gatePassed, byEngine, skipped, topUnrouted };
}

/** Telegram/log summary line — mirrors formatSanityFlags's plain-string
 *  convention (packages/engine/src/marketsV3/sanity.ts). Labels "entries" vs
 *  "outcomes" explicitly since `total`/`routed` (market-entry-level) and
 *  `priced`/`gatePassed` (outcome-level, 2-3x per routed entry) are different
 *  units — without the labels the line reads as a strictly-shrinking funnel,
 *  which it isn't (`priced` routinely exceeds `routed`). */
export function formatMarketCoverageNote(coverage: SlateMarketCoverage): string {
  const tail = coverage.topUnrouted.map((u) => `${u.name} (${u.count})`).join(", ");
  return (
    `markets: ${coverage.total} entries total / ${coverage.routed} routed / ` +
    `${coverage.priced} outcomes priced / ${coverage.gatePassed} gate-passed` +
    (tail ? `; top unrouted: ${tail}` : "")
  );
}

/** PR-20: assembles RunManifest.marketCoverage from a completed batch's jobs
 *  + the ORACLE_MARKETS_COVERAGE flag. Extracted as a small pure function
 *  (mirrors apps/worker/src/acquireChain.ts's dependency-free-module
 *  convention) so the flag-gating + successJobs filter + field-narrowing
 *  logic is unit-testable without mocking runAnalysis's full storage/
 *  calibration/report pipeline. Returns undefined when the flag is off or
 *  nothing in the batch carried v3Coverage — RunManifest.marketCoverage is
 *  additive/optional, so undefined means "omit the key", not "zero". */
export function buildManifestMarketCoverage(
  jobs: BatchJobResult[],
  marketsCoverageNote: boolean | undefined
): RunManifest["marketCoverage"] {
  if (marketsCoverageNote === false) return undefined;
  const successJobs = jobs.filter((j): j is FixtureJobSuccess => j.status === "ok");
  const coverage = rollupCoverage(successJobs);
  if (!coverage) return undefined;
  const { total, routed, priced, gatePassed, topUnrouted } = coverage;
  return { total, routed, priced, gatePassed, topUnrouted };
}
