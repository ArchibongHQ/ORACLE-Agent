/** @oracle/runtime — shared application layer.
 *  Env loading, fixture sourcing, the canonical analyse/resolve path, and HTML reporting.
 *  Consumed by apps/worker, apps/cli, and apps/web so no analysis logic is duplicated. */

export type { AnalyzeOptions, AnalyzeResult, ResolveDayResult } from "./analyze.js";
export { CLV_ELIGIBLE_LEAGUES, resolveDay, runAnalysis } from "./analyze.js";
export type { DailyFixtureReportDeps } from "./dailyFixtureReport.js";
export {
  buildNewsByTeam,
  renderDailyFixtureReport,
  writeDailyFixtureReport,
} from "./dailyFixtureReport.js";
export type { DailyNewsRow } from "./dailyStore.js";
export { fixturesPartitionExists, loadDailyNews, teamSlug } from "./dailyStore.js";
export { buildConfig, loadEnv, validateConfig } from "./env.js";
export type { FetchResult } from "./fixtures.js";
export {
  fetchFixtureByName,
  fetchTodaysFixtures,
  gameToFixtureJob,
  resolvePythonBin,
  SPORT_TO_LEAGUE,
} from "./fixtures.js";
export type { GoalsFunnelOptions, GoalsFunnelResult } from "./goalsFunnel.js";
export { runGoalsFunnel, sportyEventToFixtureJob } from "./goalsFunnel.js";
export type { GoalsPreFilterResult } from "./goalsPreFilter.js";
export {
  DEFAULT_PRE_FILTER_POOL_SIZE,
  GOALS_RICH_LEAGUES,
  preFilterGoalsCandidates,
  scoreGoalsPotential,
} from "./goalsPreFilter.js";
export type { GoalsScreenResult } from "./goalsScreen.js";
export {
  DEFAULT_SCREEN_BATCH_SIZE,
  mergeScreenedCandidates,
  screenGoalsCandidates,
} from "./goalsScreen.js";
export { enrichWithH2H } from "./h2h.js";
export type { HardwareCapabilities } from "./hardware.js";
export { detectHardware, isGpuCapable } from "./hardware.js";
export type { LineupSummary } from "./lineups.js";
export { enrichWithLineups, findLineupSummary, loadLineupSummaries } from "./lineups.js";
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
export { computeRealisedClv, formatClv, resolveRecords } from "./resolveFixtures.js";
export type { PuntResult } from "./runPunt.js";
export { formatPuntResult, runPuntAnalysis } from "./runPunt.js";
export type {
  SelectionCandidate,
  SelectionResult,
  SelectionStats,
  SportyBetIndex,
} from "./selectFixtures.js";
export {
  DEFAULT_MAX_FIXTURES_PER_RUN,
  loadSportyBetIndex,
  ORACLE_PRIORITY_LEAGUES,
  scoreFixture,
  selectFixtures,
  sidecarKey,
} from "./selectFixtures.js";
export type { GoalsLeg, GoalsSelectionResult, GoalsSelectOptions } from "./selectGoals.js";
export {
  DEFAULT_GOALS_MIN_CONFIDENCE,
  DEFAULT_GOALS_MIN_IMPLIED,
  DEFAULT_GOALS_TARGET_LEGS,
  GOALS_MARKETS,
  goalsDataGate,
  pickSafestGoalsLeg,
  selectGoalsAccumulator,
} from "./selectGoals.js";
