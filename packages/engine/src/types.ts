/** Shared types for @oracle/engine. These are imported by oracle_math.ts and all engine modules. */

import type { FamilyLabel, MarketFamily } from "./markets/index.js";

/** The real value space of PickRef.market/EVMarket.market: FAMILY_LABEL display
 *  strings emitted by scanMarkets' `check()`, plus the two special-path literals
 *  set outside the family system (execution/index.ts scanAllMarketsFallback,
 *  decision/marketExecutor.ts). The decision/index.ts:64 "1x2" placeholder is a
 *  pre-existing casing mismatch against FAMILY_LABEL.match_result ("1X2") —
 *  carried through as-is, not fixed here. */
export type PickRefMarket = FamilyLabel | "1x2" | "AllMarkets Scan" | "LLM Market Executor";

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
  kind: "lineup" | "injury" | "news" | "motivation" | "stats";
  text: string;
  source: string;
  observedAt: string; // ISO-8601; must be < kickoff (anti-leakage)
}

/** Edge confidence grade — replaces "NO_BET" literal across all output surfaces.
 *  STRONG: EV ≥ 0.05; LEAN: 0 < EV < 0.05; NO_EDGE: EV ≤ 0 (honest no-edge verdict);
 *  MISSING_DATA: the final arbiter judged the evidence insufficient to decide either
 *  way — distinct from NO_EDGE (which means "evidence is sufficient and says no edge"). */
export type ConfidenceGrade = "STRONG" | "LEAN" | "NO_EDGE" | "MISSING_DATA";

/** The structured JSON the LLM decision layer must return (PRD §6, Appendix B). */
export interface DecisionOutput {
  primaryPick: PickRef;
  altPick?: PickRef;
  confidence: number; // 0–1 (numeric, for backward compat with existing callers)
  grade: ConfidenceGrade; // human-facing label derived from EV
  rationale: string;
  rejectedAndWhy: string[];
  /** Set when ORACLE_LOCAL_DECISION="true": whether the local-Claude final arbiter
   *  actually reviewed this pick. "unverified" means the arbiter call failed (binary
   *  missing, timeout, bad parse) and the pre-arbiter cascade pick was used as-is —
   *  callers/UI should label the output accordingly. Absent when the arbiter is off. */
  arbiterStatus?: "verified" | "unverified";
}

/** Exact LLM call bundle for audit replay (PRD §6 determinism, Appendix B).
 *  temperature is "default" only for the opt-in local-Claude-Code tier, which
 *  samples at the CLI's account default and has no knob to pin to 0 — every
 *  API tier still pins 0. Never write "default" without it being literally true. */
export interface DecisionReplay {
  prompt: string;
  rawResponse: string;
  model: string;
  temperature: 0 | "default";
}

/** Shadow comparison: GLM-5.2 evaluated in parallel with the real decision tier,
 *  never affecting primaryPick. Observability only. Absent when the OpenRouter
 *  key is missing or the shadow call fails (fail-open, non-fatal). */
export interface DecisionShadow {
  model: string; // OPENROUTER_MODELS.GLM_5_2
  pick: DecisionOutput;
  agree: boolean; // true when shadow.pick.primaryPick.market === real pick.primaryPick.market
}

/** Reference to a specific market + odds combination. */
export interface PickRef {
  market: PickRefMarket;
  side?: string;
  odds: number;
  stake?: number; // Kelly fraction, 0–1
}

/** One outcome of a raw SportyBet allMarkets entry (tools/scrape_fixtures.py's
 *  _parse_all_markets) — verbatim id/desc/odds straight from the API. */
export interface AllMarketOutcome {
  id: string;
  desc?: string | null;
  odds?: string | null;
}

/** One raw SportyBet market entry (900+ per liquid fixture). Generic capture of
 *  every market beyond the ~9 families scanMarkets() prices syntactically —
 *  shared between the deterministic generic combo-market pricer
 *  (execution/index.ts) and the LLM market-executor (decision/marketExecutor.ts),
 *  both of which need the exact same raw shape. */
export interface AllMarketEntry {
  id: string;
  name?: string | null;
  desc?: string | null;
  group?: string | null;
  specifier?: string | null;
  outcomes: AllMarketOutcome[];
}

/** An EV-positive market candidate surfaced by scanMarkets.
 *  cat/label are the canonical JSX field names; market/side/modelProb are backward-compat aliases. */
export interface EVMarket {
  cat: string; // market category: "Goals O/U", "Asian Handicap", etc.
  label: string; // specific bet: "Over 2.5", "AH Home +0.5", etc.
  market: PickRefMarket; // = cat  (kept for decision module compat)
  side?: string; // = label (kept for PickRef compat)
  /** Canonical ORACLE market family. Set by all scanMarkets BLOCKs and the
   *  allMarkets fallback scan. Absent only for the 1x2 placeholder pick. */
  family?: MarketFamily;
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
  oddsPapiKey?: string; // structured free-odds fallback (OddsPapi v4, Pinnacle/SBOBet)
  sportsGameOddsKey?: string; // structured free-odds fallback (SportsGameOdds, Pinnacle)
  bankroll: number;
  rankingMode?: RankingMode; // default CONFIDENCE_WEIGHTED
  useBivariatePoisson?: boolean; // PRD §8.1, default false
  useSkellam?: boolean; // PRD §8.2, default false
  useNegBinom?: boolean; // NB overdispersion in score marginals, default false
  nbDispersion?: number; // NB dispersion param r (default 10; larger → closer to Poisson)
  useMCRuin?: boolean; // blend simulated ruin probability into varMultiplier, default false
  costCeilingUsd?: { perRun: number; perDay: number }; // PRD §11A.4
  // Feature flags (Phase 1+, all default false/undefined)
  usePiRatingsCanonical?: boolean;
  enableCalibratedZip?: boolean;
  quarantineMarketVelocity?: boolean;
  enableSoftmaxBlend?: boolean;
  xgPrimaryWeight?: number; // default 0.40
  lowScoreZipWeight?: number; // default 0.08
  // Web search fallback for odds (when Odds API fails)
  enableWebSearchOddsFallback?: boolean; // default true
  webOddsMinConsensus?: number; // default 3
  webOddsVarianceThreshold?: number; // default 0.025 (±2.5%)
  // Web search fallback for match results (when API-Football + football-data.org both miss)
  enableWebSearchResultsFallback?: boolean; // default true
  webResultsMinConsensus?: number; // default 2 (goals are exact integers, not within-variance)
  // B-layer feature flags (all default false)
  enableBriefing?: boolean; // B1: Claude Opus + Gemini temp ensemble briefing
  enableCVL?: boolean; // B2: Claude Sonnet adversarial verification
  // T0 + swarm (all default false/undefined)
  enableNewsIntel?: boolean; // T0: Perplexity Sonar news/injury/lineup intelligence
  enableSwarm?: boolean; // Level-2: per-fixture sub-agent swarm (APEX/PRIME)
  batchConcurrency?: number; // Level-1: max concurrent fixtures (default 8)
  maxFixturesPerRun?: number; // pre-analysis fixture selection cap (default 50)
  // Goals-only accumulator pipeline (runGoalsBatch) — gates per-leg selection
  goalsMinConfidence?: number; // model `mp` floor per goals leg (default 0.75)
  goalsMinImplied?: number; // implied-prob floor per goals leg (default 0.70)
  goalsTargetLegs?: number; // max legs in the goals accumulator (default 39)
  // When true, scanMarkets only computes goals-shaped markets (Goals O/U, Asian 2
  // Goals, Team Total) and BTTS — AH/DNB/Double-Chance/Win-Either-Half/First-Half
  // are skipped entirely (not computed, not just filtered from output). Temporary
  // pivot to prove prediction accuracy in goal markets before re-expanding scope.
  enableGoalsOnlyMode?: boolean;
  // GBM residual model (tools/gbm_residual.py) — TS inference shim in ./gbm/index.ts.
  // Default OFF: the currently-saved model fails its own walk-forward significance
  // gate (gate_passed=false in .tmp/models/gbm_residual_meta.json — RPS improvement
  // -0.0012 vs the +0.002 threshold). Wiring is built and tested; only flip this on
  // once a retrained model actually clears the gate.
  enableGbmResidual?: boolean;
  gbmModelPath?: string; // default ".tmp/models/gbm_residual.json"
  gbmBlendWeight?: number; // default 0.15 — low-weight nudge, same shape as the Skellam blend
  // Hardware capabilities (populated at runtime boundary, never inside @oracle/engine)
  isVps?: boolean; // ORACLE_IS_VPS=true or systemd-detect-virt detects VM
  hasNvidiaGpu?: boolean; // nvidia-smi available and returned a GPU name
  enableAutoResearch?: boolean; // ORACLE_AUTORESEARCH_ENABLED=true + GPU/VPS required
  // All-markets LLM execution tier (decision/marketExecutor.ts) — default OFF.
  // When on, an LLM agent (local Claude Code CLI) reasons over the FULL raw
  // allMarkets catalogue (900+ entries on a liquid fixture) plus the engine's
  // own parameters for every llmEligible fixture, REPLACING the eligibleBets-
  // constrained decide() cascade rather than augmenting it — per owner
  // instruction, no market family is privileged over any other for consideration.
  // Concurrency is hardware-aware locally (computeMarketExecutorConcurrency) and
  // scales to ~1 agent per fixture on VPS, where it also ignores costCeilingUsd
  // (uncapped spend on VPS is an explicit owner choice, not an oversight).
  enableLlmMarketExecutor?: boolean;
  // goals-market-analysis-prompt-v3 gates applied to goals-family markets
  // (Goals O/U, Team Total, BTTS) in the MAIN batch's scanMarkets admission —
  // the noise gate and the §4.4 implausible-edge cap, without the goals-batch
  // penalty table (penalty inputs are sidecar/goals-specific). Default OFF;
  // ships behind its own flag until the goals-only batch (which always runs
  // these gates) is proven in production. Non-goals families are untouched.
  enableV3MainGates?: boolean;
  v3EdgeCap?: number; // default 0.12 — raw edge above this vetoes with reason "v3-cap"
  v3NoiseGate?: number; // default 0.02 — |rawEdge| at/below this vetoes with reason "v3-noise"
  // all-markets-analysis-prompt-v3 — deterministic all-markets engine
  // (marketsV3/analyzeFixtureMarketsV3). "on": replaces the legacy scanMarkets
  // eligibleBets with v3's gate-surviving candidates for this fixture (fails
  // open to legacy eligible on any v3 error/null — a missing/thin data point
  // never blocks the batch). "shadow": v3 still runs (for future comparison
  // instrumentation) but its output is discarded; legacy eligible is used
  // unchanged. "off"/undefined: v3 doesn't run at all — zero overhead,
  // byte-identical to pre-v3 behavior. Default "on" (owner decision).
  enableMarketsV3?: "on" | "shadow" | "off";
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
    // ── all-markets-analysis-prompt-v3 typed market-specific stats, populated
    // by the runtime's buildStatsOverride (previously rawStatsBlock prose only).
    // §3.5 shape-engine empirical blend inputs (0..1 season rates, venue split):
    bttsPctH?: number;
    bttsPctA?: number;
    csPctH?: number;
    csPctA?: number;
    ftsPctH?: number;
    ftsPctA?: number;
    /** §3.6 half-engine ρ inputs: first-half share of each team's goals (0..1). */
    fhShareH?: number;
    fhShareA?: number;
    /** §3.9 corners module (Negative Binomial) inputs, per game. */
    cornersForH?: number;
    cornersForA?: number;
    cornersAgainstH?: number;
    cornersAgainstA?: number;
    /** §3.9 cards module (Poisson) inputs: total cards per game. */
    cardsAvgH?: number;
    cardsAvgA?: number;
    /** §2 prioritisation / §1.2 heightened-trend inputs: season O2.5 hit-rate. */
    ouO25H?: number;
    ouO25A?: number;
    softContext?: SoftContextItem[];
    /** Raw structured per-category stats passthrough (see DecisionContext.rawStatsBlock) —
     *  same loose-passthrough convention as rawOddsPayload. */
    rawStatsBlock?: Record<string, unknown>;
    // ── all-markets-analysis-prompt-v3 §3.1 raw multiplicative-λ inputs.
    // Deliberately separate from xH/xA (the legacy Alpha-model's already-
    // blended output) — v3 runs its OWN multiplicative+shrinkage+xG-blend from
    // these raw per-90 rates, independent of and ungated by the legacy
    // override's MIN_PLAYED threshold (v3 has its own shrinkage/sample logic).
    scoredPer90H?: number;
    concededPer90H?: number;
    scoredPer90A?: number;
    concededPer90A?: number;
    xgfH?: number;
    xgaH?: number;
    xgfA?: number;
    xgaA?: number;
    nHome?: number;
    nAway?: number;
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
  decisionReplay: DecisionReplay | null; // prompt + rawResponse + model + temperature (0, or "default" for local-Claude-Code)
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
  /** Raw structured per-category fixture data (form/standings/goals/h2h/xg/
   *  overunder/congestion/possessionValue + H2H scorelines where available) —
   *  passthrough from RunState.telemetry.rawStatsBlock. Engine-agnostic
   *  (Record<string, unknown>, same convention as rawOddsPayload) since the
   *  concrete shape (SportyBetStats) is defined in @oracle/runtime, which
   *  @oracle/engine cannot import without a circular dependency. Consumed only
   *  by the arbiter prompt builder to give it raw data alongside the existing
   *  distilled softContext prose. */
  rawStatsBlock?: Record<string, unknown>;
  /** Raw SportyBet allMarkets catalogue (900+ entries on a liquid fixture) —
   *  passthrough from fetched.sportyBetOdds.allMarkets. Consumed by the
   *  all-markets LLM executor tier (decision/marketExecutor.ts) when
   *  config.enableLlmMarketExecutor is on; ignored otherwise. */
  allMarkets?: AllMarketEntry[];
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
  pick: PickRef | null;
  grade: ConfidenceGrade | null;
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
  /** Set only when ORACLE_AGENT_VERIFY="true" and a local Claude Code runtime
   *  verified this fixture's engine output against the scraped evidence. */
  agentVerification?: {
    lambdasConsistent: boolean;
    topMarketSupported: boolean;
    flags: string[];
    orchestratorNote: string;
  };
  /** Coverage of the raw SportyBet allMarkets catalogue against the canonical
   *  market index (packages/engine/src/markets). Lets the daily report show how
   *  much of what the book published the engine recognises and can price.
   *  Undefined when the fixture carried no allMarkets payload. */
  marketCoverage?: MarketCoverage;
  [key: string]: unknown;
};

/** How a fixture's raw allMarkets entries map onto the canonical index:
 *  priced ≤ priceable ≤ inCatalog ≤ total. `total` counts distinct market
 *  entries (not per-outcome). */
export interface MarketCoverage {
  total: number; // raw allMarkets entries seen
  inCatalog: number; // entries whose market id is in the canonical index
  priceable: number; // entries whose catalog family has a deterministic model
  priced: number; // entries that actually produced an EV candidate
}
