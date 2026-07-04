export type {
  BatchJobResult,
  BatchOptions,
  BatchResult,
  FixtureJob,
  FixtureJobError,
  FixtureJobSuccess,
} from "./batch/index.js";
export { parseFixtureList, runBatch } from "./batch/index.js";
export { runPool } from "./batch/pool.js";
export type {
  CalibrationRecord,
  PlattParams,
  SignificanceGateOptions,
  SignificanceGateResult,
} from "./calibration/index.js";
export {
  applyPlatt,
  CalibrationEngine,
  expectedCalibrationError,
  isotonicCalibrateFp,
  logLoss,
  plattScale,
  significanceAcceptGate,
} from "./calibration/index.js";
export type { DecisionResult } from "./decision/index.js";
export {
  buildEligibleBets,
  decide,
  logDisagreement,
  logPickDisagreement,
  validateSelection,
} from "./decision/index.js";
export type { MarketExecutorResult, MarketExecutorRiskParams } from "./decision/marketExecutor.js";
export { runAllMarketsLlmExecutor } from "./decision/marketExecutor.js";
export type { ExecutionResult, LeagueParam } from "./execution/index.js";
export { applyRankingMode, ExecutionEngine, getLeagueParams } from "./execution/index.js";
export type { GbmLiveInputs, GbmModel } from "./gbm/index.js";
export {
  blendGbmIntoFp,
  buildGbmFeatureVector,
  GBM_FEAT_COLS,
  loadGbmModel,
  predictGbm,
} from "./gbm/index.js";
export type {
  V3AnalyzeInput,
  V3EVMarket,
  V3FixtureOdds,
  V3FixtureResult,
  V3MarketAssessment,
  V3MarketMeta,
} from "./goalsV3/analyzeFixture.js";
export { analyzeGoalsFixtureV3, v3NbDispersion } from "./goalsV3/analyzeFixture.js";
export type {
  V3EdgeAssessment,
  V3GateOutcome,
  V3PenaltyFlags,
  V3Tier,
} from "./goalsV3/edgeGate.js";
export {
  devigOU,
  gateV3Edge,
  V3_EDGE_CAP_DEFAULT,
  V3_NOISE_GATE_DEFAULT,
  V3_PENALTY_PTS,
  V3_TIER_HEIGHTENED_FLOOR,
  V3_TIER_HIGH,
  V3_TIER_MEDIUM,
  V3_TIER_VERY_HIGH,
  v3PenaltyPts,
  v3Tier,
} from "./goalsV3/edgeGate.js";
export type { V3LambdaInput, V3Lambdas, V3TeamXg } from "./goalsV3/lambda.js";
export { computeV3Lambdas, V3_LEAGUE_BASELINES, v3LeaguePerTeamAvg } from "./goalsV3/lambda.js";
export type { Devigged1x2, MatchShape } from "./goalsV3/matchShape.js";
export { deriveMatchShape, SHAPE_LAMBDA_FLOOR } from "./goalsV3/matchShape.js";
export type { MarketCatalogEntry, MarketFamily } from "./markets/index.js";
export {
  devigThreeWay,
  devigTwoWay,
  familyOf,
  isPriceable,
  lookupMarket,
  MARKET_BY_ID,
  MARKET_CATALOG,
  PRICEABLE_FAMILIES,
} from "./markets/index.js";
export type {
  V3AllMarketsInput,
  V3AllMarketsResult,
  V3EmpiricalInputs,
  V3MarketOutcomeAssessment,
} from "./marketsV3/analyzeFixtureMarkets.js";
export { analyzeFixtureMarketsV3 } from "./marketsV3/analyzeFixtureMarkets.js";
export type { V3MarketClass } from "./marketsV3/classes.js";
export {
  CLASS_L_MAX_ODDS,
  CLASS_M_MAX_ODDS,
  CLASS_ORDER,
  CLASS_S_MAX_ODDS,
  classifyMarket,
  STRUCTURAL_X_FAMILIES,
} from "./marketsV3/classes.js";
export type { V3CardsInput, V3CardsMeans } from "./marketsV3/engines/cards.js";
export { cardsMeans, priceCardsOutcome } from "./marketsV3/engines/cards.js";
export type { V3CornersInput, V3CornersMeans } from "./marketsV3/engines/corners.js";
export {
  CORNERS_R_DEFAULT,
  CORNERS_R_MAX,
  CORNERS_R_MIN,
  clampCornersDispersion,
  cornersMeans,
  nbCDF,
  nbPMF,
  nbTailOver,
  nbTailUnder,
  priceCornersOutcome,
} from "./marketsV3/engines/corners.js";
export { priceExoticsOutcome } from "./marketsV3/engines/exotics.js";
export { V3_FIRST_HALF_SHARE_DEFAULT } from "./marketsV3/engines/half.js";
export { priceShapeOutcome } from "./marketsV3/engines/shape.js";
export { minuteShare, priceTimeWindow, V3_MINUTE_SHARE_TABLE } from "./marketsV3/engines/time.js";
export type { V3EngineCtx, V3Price } from "./marketsV3/engines/types.js";
export {
  blendEmpirical,
  EMPIRICAL_BLEND_N_CAP,
  EMPIRICAL_BLEND_W,
} from "./marketsV3/engines/types.js";
export type {
  V3AllGateOutcome,
  V3AllMarketsAssessment,
  V3AllMarketsPenaltyFlags,
  V3Confidence,
} from "./marketsV3/evGate.js";
export {
  allMarketsPenaltyPts,
  CLASS_GATE,
  CLASS_GATE_HEIGHTENED,
  gateAllMarkets,
  impliedQ,
  RELATIVE_CAP_ODDS_FLOOR,
  RELATIVE_CAP_RATIO,
  RELATIVE_CAP_RATIO_X,
  V3_ALLMARKETS_PENALTY_PTS,
  v3Confidence,
} from "./marketsV3/evGate.js";
export type {
  RouteCoverage,
  V3Engine,
  V3Route,
  V3Routing,
  V3Skip,
} from "./marketsV3/feedDictionary.js";
export { isSkip, parseSpecifier, routeCoverage, routeMarket } from "./marketsV3/feedDictionary.js";
export type { ResultProbs } from "./marketsV3/grid.js";
export {
  buildV3Grid,
  buildV3HalfGrid,
  poissonVector,
  resultProbs,
  sumWhere,
  V3_GRID_MAX_GOALS,
  winPushSplit,
} from "./marketsV3/grid.js";
export type {
  V3ChunkStatus,
  V3ClassMix,
  V3FinalSummaryInput,
  V3OutputB,
  V3OutputRow,
  V3SlateFixture,
} from "./marketsV3/outputs.js";
export {
  BEST_SINGLES_MAX,
  buildGateSurvivingPool,
  buildOutputA,
  buildOutputB,
  buildOutputC,
  buildOutputD,
  computeClassMix,
  formatChunkStatus,
  formatFinalSummary,
  MINI_ACCA_HAIRCUT,
  MINI_ACCA_MAX_LEGS,
  MINI_ACCA_MIN_LEGS,
  OUTPUT_A_MAX,
  OUTPUT_C_MAX,
  OUTPUT_C_MIN_ODDS,
  OUTPUT_D_MAX,
  OUTPUT_D_MIN_ODDS,
  RESPONSIBLE_GAMBLING_NOTE,
} from "./marketsV3/outputs.js";
export type { V3PriorityInput } from "./marketsV3/prioritise.js";
export {
  CONGESTION_MAX_DAYS,
  chunkV3,
  HIGH_LEAGUE_AVG_MIN,
  HOME_FAVOURITE_MAX_ODDS,
  MARKET_DEPTH_MIN,
  STREAK_MIN,
  scoreV3Priority,
  sortByV3Priority,
  V3_CHUNK_SIZE,
  V3_PRIORITY_WEIGHTS,
} from "./marketsV3/prioritise.js";
export type {
  AllMarketsSanityInput,
  GoalsSanityInput,
  V3SanityFlag,
  V3SanityResult,
} from "./marketsV3/sanity.js";
export {
  formatSanityFlags,
  goalsSlateSanityChecks,
  slateSanityChecks,
} from "./marketsV3/sanity.js";
export type { DualSplit } from "./marketsV3/split.js";
export { deriveDualSplit, SHAPE_DISAGREEMENT_DELTA } from "./marketsV3/split.js";
export * from "./math/index.js";
export type { PostmortemEntry, RAGEntry, RootCause } from "./rag/index.js";
export { PostmortemRegistry, postmortemRegistry, RAGSystem, ROOT_CAUSES } from "./rag/index.js";
export type { TeamRating } from "./ratings/index.js";
export { TeamRatingsEngine } from "./ratings/index.js";
export * from "./regime/index.js";
export type {
  ActionKind,
  AntiSycophancyResult,
  ConvergenceResult,
  MLSafetyResult,
  ReversibilityVeto,
} from "./safety/index.js";
export {
  AntiSycophancyCircuit,
  ConvergenceScorer,
  MLSafetyFilter,
  weighReversibility,
} from "./safety/index.js";
export type {
  AgentError,
  AgentErrorCode,
  AllMarketEntry,
  AllMarketOutcome,
  AnalysisRecord,
  ClvSourceQuality,
  DecisionContext,
  DecisionInput,
  DecisionOutput,
  DecisionReplay,
  DecisionShadow,
  EVMarket,
  FixtureOutcome,
  LiquidityTag,
  Matrix,
  OracleConfig,
  Outcome,
  PickRef,
  PickRefMarket,
  RankingMode,
  Regime,
  ResolutionRecord,
  ResolveOutcome,
  RunManifest,
  RunResult,
  RunState,
  ScoringRegime,
  SoftContextItem,
} from "./types.js";
export {
  ANALYSIS_SCHEMA_VERSION,
  RESOLUTION_SCHEMA_VERSION,
  RUN_MANIFEST_SCHEMA_VERSION,
} from "./types.js";
