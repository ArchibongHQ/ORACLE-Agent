/** @oracle/runtime — shared application layer.
 *  Env loading, fixture sourcing, the canonical analyse/resolve path, and HTML reporting.
 *  Consumed by apps/worker, apps/cli, and apps/web so no analysis logic is duplicated. */

export type { AnalyzeOptions, AnalyzeResult, ResolveDayResult } from "./analyze.js";
export { CLV_ELIGIBLE_LEAGUES, resolveDay, runAnalysis } from "./analyze.js";
export type {
  CommentBarAction,
  CommentBarActionType,
  CommentBarResult,
} from "./commentBarOrchestrator.js";
export { runCommentBarInstruction } from "./commentBarOrchestrator.js";
export type { DailyFixtureReportDeps } from "./dailyFixtureReport.js";
export {
  buildNewsByTeam,
  generateAndWriteDailyFixtureReport,
  renderDailyFixtureReport,
  writeDailyFixtureReport,
} from "./dailyFixtureReport.js";
export type { DailyNewsRow } from "./dailyStore.js";
export { fixturesPartitionExists, loadDailyNews, teamSlug } from "./dailyStore.js";
export type { GoalsV3Config } from "./env.js";
export { buildConfig, buildGoalsV3Config, loadEnv, validateConfig } from "./env.js";
export type { FetchResult } from "./fixtures.js";
export {
  fetchFixtureByName,
  fetchTodaysFixtures,
  gameToFixtureJob,
  resolvePythonBin,
  SPORT_TO_LEAGUE,
} from "./fixtures.js";
export type { FixtureWorkbookDeps } from "./fixtureWorkbook.js";
export {
  generateAndWriteFixtureWorkbook,
  renderFixtureWorkbook,
  writeFixtureWorkbook,
} from "./fixtureWorkbook.js";
export type { GoalsArtifact } from "./goalsArtifact.js";
export { readGoalsArtifact, writeGoalsArtifact } from "./goalsArtifact.js";
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
export type {
  V3Completeness,
  V3EnrichmentState,
  V3MandatoryField,
} from "./goalsV3/completeness.js";
export {
  heightenedTrendsAligned,
  scoreCompleteness,
  V3_COMPLETENESS_WEIGHTS,
} from "./goalsV3/completeness.js";
export type { V3Eligibility, V3EligibilityStatus } from "./goalsV3/eligibility.js";
export { classifyEligibility, GOALS_V3_WHITELIST } from "./goalsV3/eligibility.js";
export { byPredictabilityV3, scorePredictabilityV3 } from "./goalsV3/predictability.js";
export type { SlateArbiterVerdicts } from "./goalsV3/slateArbiter.js";
export {
  applySlateVerdicts,
  DEFAULT_GOALS_ARBITER_TIMEOUT_MS,
  reviewGoalsSlate,
  slateLegKey,
} from "./goalsV3/slateArbiter.js";
export type { CappedLogEntry, GoalsWorkbookInput } from "./goalsWorkbook.js";
export {
  generateAndWriteGoalsWorkbook,
  renderGoalsWorkbook,
  writeGoalsWorkbook,
} from "./goalsWorkbook.js";
export { enrichWithH2H } from "./h2h.js";
export type { HardwareCapabilities } from "./hardware.js";
export { detectHardware, isGpuCapable } from "./hardware.js";
export type { LineupSummary } from "./lineups.js";
export { enrichWithLineups, findLineupSummary, loadLineupSummaries } from "./lineups.js";
export type { V3FieldPopulation, V3TrackedField } from "./marketsV3/completenessInputs.js";
export {
  formatPopulationLog,
  inspectEvent,
  summarizeFieldPopulation,
  V3_TRACKED_FIELDS,
} from "./marketsV3/completenessInputs.js";
export { enrichWithNewsIntel } from "./newsIntel.js";
export type { CounterLeg, LegVerdict, PuntLeg } from "./punt.js";
export {
  ADJUST_MIN_CONFIDENCE_DELTA,
  counterSlip,
  loadedSlipToJobs,
  rawLegToMarketSide,
} from "./punt.js";
export type { PuntDayState, PuntSlipState } from "./puntState.js";
export {
  markFulfilled,
  markPrompted,
  readPuntState,
  SLIP_LABELS,
  shouldReprompt,
} from "./puntState.js";
export { CSS as REPORT_CSS, esc, pct, renderReport, writeReport } from "./report.js";
export type { ResolveResult } from "./resolveFixtures.js";
export { computeRealisedClv, formatClv, resolveRecords } from "./resolveFixtures.js";
export type { PuntResult } from "./runPunt.js";
export { formatPuntResult, runPuntAnalysis } from "./runPunt.js";
export type {
  SelectionCandidate,
  SelectionResult,
  SelectionStats,
  SportyBetEvent,
  SportyBetEventDetail,
  SportyBetIndex,
} from "./selectFixtures.js";
export {
  DEFAULT_MAX_FIXTURES_PER_RUN,
  findSidecarDetail,
  loadSportyBetIndex,
  ORACLE_PRIORITY_LEAGUES,
  scoreFixture,
  selectFixtures,
  sidecarKey,
} from "./selectFixtures.js";
export type { GoalsLeg, GoalsSelectionResult, GoalsSelectOptions } from "./selectGoals.js";
export {
  avgConceded,
  avgScored,
  DEFAULT_GOALS_MIN_CONFIDENCE,
  DEFAULT_GOALS_MIN_IMPLIED,
  DEFAULT_GOALS_TARGET_LEGS,
  GOALS_MARKETS,
  goalsDataGate,
  INTL_TOURNAMENT_RE,
  pickSafestGoalsLeg,
  selectGoalsAccumulator,
  V3_MINI_ACCA_HAIRCUT,
} from "./selectGoals.js";
