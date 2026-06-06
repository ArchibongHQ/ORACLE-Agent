/** @oracle/runtime — shared application layer.
 *  Env loading, fixture sourcing, the canonical analyse/resolve path, and HTML reporting.
 *  Consumed by apps/worker, apps/cli, and apps/web so no analysis logic is duplicated. */

export { loadEnv, buildConfig, validateConfig } from './env.js';

export {
  fetchTodaysFixtures, fetchFixtureByName,
  gameToFixtureJob, SPORT_TO_LEAGUE,
} from './fixtures.js';
export type { FetchResult } from './fixtures.js';

export { renderReport, writeReport } from './report.js';

export { resolveRecords, computeRealisedClv } from './resolveFixtures.js';
export type { ResolveResult } from './resolveFixtures.js';

export { runAnalysis, resolveDay, CLV_ELIGIBLE_LEAGUES } from './analyze.js';
export type { AnalyzeOptions, AnalyzeResult, ResolveDayResult } from './analyze.js';

export { enrichWithH2H } from './h2h.js';
