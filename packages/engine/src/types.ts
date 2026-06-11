/** Shared types for @oracle/engine. These are imported by oracle_math.ts and all engine modules. */

/** A 2D goal-probability matrix: matrix[homeGoals][awayGoals] = P(score). */
export type Matrix = number[][];

/** Performance regime for variance / momentum analysis. */
export type Regime = "NEUTRAL" | "MOMENTUM" | "MEAN_REVERSION" | "ACCELERATING" | "DECELERATING";

/** Draw / low-scoring regime classification (PRD §4). */
export type ScoringRegime = "NORMAL" | "LOW_SCORING";

/** Outcome space for 1X2 markets. */
export type Outcome = "home" | "draw" | "away";

/** Ranking modes — risk-preference filters over calibrated probabilities (PRD §5). */
export type RankingMode = "CONFIDENCE_WEIGHTED" | "MAX_PROBABILITY" | "MAX_EV";

/** Fixture resolution outcome (PRD §9, §11A.2). */
export type ResolveOutcome = "RESOLVED" | "AMBIGUOUS" | "NO_DATA";

/** Liquidity classification for CLV gate (PRD §8.3). */
export type LiquidityTag = "CLV_ELIGIBLE" | "CALIBRATION_ONLY";

/** CLV data quality (source of the "closing" odds, PRD §8.3 v1.2). */
export type ClvSourceQuality = "TICK_LEVEL" | "KICKOFF_PROXY" | "UNKNOWN";

/** Soft-context evidence item supplied to the LLM decision layer (PRD §6 v1.2). */
export interface SoftContextItem {
  kind: "lineup" | "injury" | "news" | "motivation";
  text: string;
  source: string;
  observedAt: string; // ISO-8601; must be < kickoff (anti-leakage)
}

/** The structured JSON the LLM decision layer must return (PRD §6, Appendix B). */
export interface DecisionOutput {
  primaryPick: PickRef | "NO_BET";
  altPick?: PickRef;
  confidence: number; // 0–1
  rationale: string;
  rejectedAndWhy: string[];
}

/** Exact LLM call bundle for audit replay (PRD §6 determinism, Appendix B). */
export interface DecisionReplay {
  prompt: string;
  rawResponse: string;
  model: string;
  temperature: 0;
}

/** Reference to a specific market + odds combination. */
export interface PickRef {
  market: string;
  side?: string;
  odds: number;
  stake?: number; // Kelly fraction, 0–1
}

/** An EV-positive market candidate surfaced by scanMarkets.
 *  cat/label are the canonical JSX field names; market/side/modelProb are backward-compat aliases. */
export interface EVMarket {
  cat: string; // market category: "Goals O/U", "Asian Handicap", etc.
  label: string; // specific bet: "Over 2.5", "AH Home +0.5", etc.
  market: string; // = cat  (kept for decision module compat)
  side?: string; // = label (kept for PickRef compat)
  mp: number; // model probability
  modelProb: number; // = mp   (kept for safety module compat)
  ip: number; // implied probability (1/odds)
  rawEdge: number; // mp - ip
  ev: number;
  odds: number;
  stake: number;
  stakeAmt: number;
  rankingScore: number;
  varianceMod: number;
  veto?: string | boolean;
}

/** The config injected at the system boundary — never read from window/process.env inside @oracle/engine. */
export interface OracleConfig {
  geminiApiKey: string;
  claudeApiKey: string;
  perplexityApiKey?: string; // T0 news/team intelligence (Perplexity Sonar)
  kimiApiKey?: string; // swarm worker model (Kimi K2.6 via Moonshot)
  openrouterApiKey?: string; // Tier 2/3 fallbacks via OpenRouter (single key, optional)
  openWeatherApiKey?: string;
  footballDataApiKey?: string;
  apiFootballKey?: string;
  oddsApiKey?: string;
  sharpApiIoKey?: string; // structured free-odds fallback (SharpAPI.io, sharp books)
  oddsApiIoKey?: string; // structured free-odds fallback (Odds-API.io, 100 req/hr free)
  sportsGameOddsKey?: string; // structured free-odds fallback (SportsGameOdds, Pinnacle)
  bankroll: number;
  rankingMode?: RankingMode; // default CONFIDENCE_WEIGHTED
  useBivariatePoisson?: boolean; // PRD §8.1, default false
  useSkellam?: boolean; // PRD §8.2, default false
  costCeilingUsd?: { perRun: number; perDay: number }; // PRD §11A.4
  // Feature flags (Phase 1+, all default false/undefined)
  usePiRatingsCanonical?: boolean;
  enableCalibratedZip?: boolean;
  enableLowScoreRegime?: boolean;
  enableAhPivot?: boolean;
  quarantineMarketVelocity?: boolean;
  enableSoftmaxBlend?: boolean;
  xgPrimaryWeight?: number; // default 0.40
  lowScoreZipWeight?: number; // default 0.08
  // Web search fallback for odds (when Odds API fails)
  enableWebSearchOddsFallback?: boolean; // default true
  webOddsMinConsensus?: number; // default 3
  webOddsVarianceThreshold?: number; // default 0.025 (±2.5%)
  // B-layer feature flags (all default false)
  enableBriefing?: boolean; // B1: Claude Opus + Gemini temp ensemble briefing
  enableCVL?: boolean; // B2: Claude Sonnet adversarial verification
  // T0 + swarm (all default false/undefined)
  enableNewsIntel?: boolean; // T0: Perplexity Sonar news/injury/lineup intelligence
  enableSwarm?: boolean; // Level-2: per-fixture sub-agent swarm (APEX/PRIME)
  batchConcurrency?: number; // Level-1: max concurrent fixtures (default 8)
  // Hardware capabilities (populated at runtime boundary, never inside @oracle/engine)
  isVps?: boolean; // ORACLE_IS_VPS=true or systemd-detect-virt detects VM
  hasNvidiaGpu?: boolean; // nvidia-smi available and returned a GPU name
  enableAutoResearch?: boolean; // ORACLE_AUTORESEARCH_ENABLED=true + GPU/VPS required
}

/** Input state for ExecutionEngine.run() — all fields optional for incremental construction. */
export interface RunState {
  telemetry?: {
    piH?: number;
    piA?: number;
    xH?: number;
    xA?: number;
    restH?: number;
    restA?: number;
    travelKm?: number;
    altitudeM?: number;
    hoursToKO?: number;
    hOdds?: number;
    dOdds?: number;
    aOdds?: number;
    ohO?: number;
    oaO?: number;
    broll?: number;
    peakBroll?: number;
    injPenH?: number;
    injPenA?: number;
    motivationScore?: number;
    isDerby?: boolean;
    xgMode?: "empirical" | "estimated";
    xg_confidence?: "low" | "medium" | "high";
    xg_sources_count?: number;
    rawOddsPayload?: Record<string, unknown>;
    oppGA_H?: number;
    oppGA_A?: number;
    softContext?: SoftContextItem[];
    [key: string]: unknown;
  };
  pipeline?: {
    fixture?: {
      home?: string;
      away?: string;
      league?: string;
      date?: string;
      [key: string]: unknown;
    };
    fetched?: Record<string, unknown>;
  };
  ledger?: {
    bets?: Array<{ outcome?: string; [key: string]: unknown }>;
    metrics?: {
      calibFactor?: number;
      bbnParams?: Record<string, unknown>;
      dynamicRhoParams?: Record<string, number>;
      zipCoeffs?: unknown;
      ahAccuracy?: Record<string, unknown>;
      [key: string]: unknown;
    };
  };
}

// ── Phase 2 Scored History Ledger ─────────────────────────────────────────────

/** Increment when AnalysisRecord shape changes — write-once per record. */
export const ANALYSIS_SCHEMA_VERSION = 1;

/** Full analysis snapshot stored after each ExecutionEngine.run() call (PRD §11, Appendix B). */
export interface AnalysisRecord {
  // ── Appendix B identity fields ──────────────────────────────────────────────
  analysisId: string; // hash(fixtureId:rankingMode:calibrationSnapshotId) — idempotency key
  runId: string; // per-batch run identifier
  schemaVersion: number; // always ANALYSIS_SCHEMA_VERSION
  calibrationSnapshotId: string; // which calibration was active (e.g. "calib_2026-06-02")
  // ── Fixture fields ──────────────────────────────────────────────────────────
  fixtureId: string;
  home: string;
  away: string;
  league: string;
  kickoff: string; // ISO-8601
  // ── Model output ────────────────────────────────────────────────────────────
  lambdaH: number;
  lambdaA: number;
  probabilities: { home: number; draw: number; away: number };
  regime: string;
  rankingMode: RankingMode;
  liquidityTag: LiquidityTag;
  evMarkets: EVMarket[];
  // ── Decision layer ──────────────────────────────────────────────────────────
  llmPick: DecisionOutput | null;
  deterministicTopPick: EVMarket | null;
  decisionReplay: DecisionReplay | null; // prompt + rawResponse + model + temperature=0
  // ── Provenance ──────────────────────────────────────────────────────────────
  frozenOddsAtAnalysis: Record<string, unknown> | null;
  analysedAt: string; // ISO-8601
}

/** Increment when ResolutionRecord shape changes — write-once per record. */
export const RESOLUTION_SCHEMA_VERSION = 1;

/** Resolution record written after the match result is known (PRD §10, Appendix B). */
export interface ResolutionRecord {
  fixtureId: string;
  runId: string; // resolveDay run identifier (PRD Appendix B)
  schemaVersion: number; // always RESOLUTION_SCHEMA_VERSION
  actualResult: "home" | "draw" | "away";
  homeGoals: number;
  awayGoals: number;
  realisedCLV: number | null; // null when liquidityTag !== CLV_ELIGIBLE
  clvSourceQuality: ClvSourceQuality; // provenance tag for the closing-odds proxy (PRD §8.3)
  rpsContribution: number; // rankedProbabilityScore(forecast, actualResult)
  drawCalibrationPoint: { league: string; predicted: number; realised: number } | null;
  resolvedAt: string; // ISO-8601
}

/** Input to the LLM decision layer (PRD §6, Appendix B). */
export interface DecisionInput {
  eligibleBets: EVMarket[];
  evidence: DecisionContext; // fixture context — DecisionContext is the evidence block
  softContext: SoftContextItem[] | "NONE";
}

/** Fixture evidence block alias (PRD Appendix B uses DecisionContext by another name). */
export interface DecisionContext {
  fixture: { home: string; away: string; league: string; kickoff: string };
  fp: { home: number; draw: number; away: number };
  lambdaH: number;
  lambdaA: number;
  expectedScoreline: string;
  regime: string;
  convergenceTier: string;
  convergenceScore: number;
  mlAllowed: boolean;
  drawRisk: string;
  betTrigger: string;
  portfolioCorrelation: number | null;
  softContext?: SoftContextItem[];
}

// ── §11A Agent Ops Contract ────────────────────────────────────────────────────

export const RUN_MANIFEST_SCHEMA_VERSION = 1;

/** Typed error taxonomy for all agent operations (PRD §11A). */
export type AgentErrorCode =
  | "NO_DATA"
  | "AMBIGUOUS_FIXTURE"
  | "ODDS_UNAVAILABLE"
  | "RATE_LIMITED"
  | "COST_CEILING_HIT"
  | "LLM_PARSE_FAIL"
  | "VALIDATION_REJECT"
  | "PERSISTENCE_FAIL"
  | "DRY_RUN"
  | "INTERNAL";

/** Structured agent error with typed code and retriability signal. */
export interface AgentError {
  code: AgentErrorCode;
  fixtureId?: string;
  message: string;
  retriable: boolean;
  detail?: unknown;
}

/** Per-fixture outcome line in a RunManifest. */
export interface FixtureOutcome {
  fixtureId: string;
  home: string;
  away: string;
  league: string;
  kickoff: string;
  status: "ok" | "error";
  pick: PickRef | "NO_BET" | null;
  confidence: number | null;
  errorCode: AgentErrorCode | null;
  errorMessage: string | null;
  stakePct: number | null;
}

/** Emitted once per batch — machine-readable audit log of the entire run (PRD §11A). */
export interface RunManifest {
  runId: string;
  schemaVersion: number; // always RUN_MANIFEST_SCHEMA_VERSION
  startedAt: string; // ISO-8601
  finishedAt: string; // ISO-8601
  mode: RankingMode;
  trigger: "scheduled" | "manual" | "backfill";
  calibrationSnapshotId: string;
  fixtures: FixtureOutcome[];
  totals: {
    analysed: number;
    actionable: number;
    errors: number;
    totalRecommendedStakePct: number;
  };
  cost: {
    estimatedUsd: number | null;
    ceilingUsd: number | null;
    halted: boolean;
  };
  errors: AgentError[];
}

/** Output of ExecutionEngine.run(). Index signature allows spread of fixture fields. */
export type RunResult = {
  fp: { home: number; draw: number; away: number };
  evMarkets: EVMarket[];
  oddsAvailable: boolean;
  bayesian_lH: number;
  bayesian_lA: number;
  expectedScoreline: string;
  portfolioCorrelation: number | null;
  correlatedParlayRisk: Array<{ a: string; b: string; rho: number }> | null;
  [key: string]: unknown;
};
