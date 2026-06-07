/** @oracle/runtime — shared application layer.
 *  Env loading, fixture sourcing, the canonical analyse/resolve path, and HTML reporting.
 *  Consumed by apps/worker, apps/cli, and apps/web so no analysis logic is duplicated. */

export type { AnalyzeOptions, AnalyzeResult, ResolveDayResult } from "./analyze.js";
export { CLV_ELIGIBLE_LEAGUES, resolveDay, runAnalysis } from "./analyze.js";
export { buildConfig, loadEnv, validateConfig } from "./env.js";
export type { FetchResult } from "./fixtures.js";
export {
  fetchFixtureByName,
  fetchTodaysFixtures,
  gameToFixtureJob,
  SPORT_TO_LEAGUE,
} from "./fixtures.js";
export { enrichWithH2H } from "./h2h.js";
export type { HardwareCapabilities } from "./hardware.js";
export { detectHardware, isGpuCapable } from "./hardware.js";
export { enrichWithNewsIntel } from "./newsIntel.js";
export type { CounterLeg, LegVerdict, PuntLeg } from "./punt.js";
export {
  ADJUST_MIN_CONFIDENCE_DELTA,
  counterSlip,
  loadedSlipToJobs,
  rawLegToMarketSide,
} from "./punt.js";
export type { PuntDayState } from "./puntState.js";
export { markFulfilled, markPrompted, readPuntState, shouldReprompt } from "./puntState.js";
export { renderReport, writeReport } from "./report.js";
export type { ResolveResult } from "./resolveFixtures.js";
export { computeRealisedClv, resolveRecords } from "./resolveFixtures.js";
export type { PuntResult } from "./runPunt.js";
export { formatPuntResult, runPuntAnalysis } from "./runPunt.js";
