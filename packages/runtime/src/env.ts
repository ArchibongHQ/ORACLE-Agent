/** Shared .env loader + OracleConfig builder.
 *  Lifted from apps/worker/src/index.ts (§ env loader). Keys from .env only — never hardcoded. */
import { readFileSync } from "node:fs";
import type { AgentError, OracleConfig } from "@oracle/engine";
import { detectHardware, isGpuCapable } from "./hardware.js";
import { DEFAULT_MAX_FIXTURES_PER_RUN } from "./selectFixtures.js";
import {
  DEFAULT_GOALS_MIN_CONFIDENCE,
  DEFAULT_GOALS_MIN_IMPLIED,
  DEFAULT_GOALS_TARGET_LEGS,
} from "./selectGoals.js";

/**
 * Parse a flat KEY=VALUE .env file into a record, then merge Railway process env on top.
 * On Railway, RAILWAY_ENVIRONMENT is injected automatically — we use it to promote the
 * three variables that are throttled locally (concurrency, swarm, booking) to cloud values,
 * unless they are already explicitly set in Railway's Variables panel.
 * Missing file → {} (never throws).
 */
export function loadEnv(path: string): Record<string, string> {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = Object.fromEntries(
      readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
        .map((l) => {
          const idx = l.indexOf("=");
          const key = l.slice(0, idx).trim();
          // Strip inline comments (# …) from values. Handles both bare values
          // ("true") and inline-commented forms ("true  # explanation").
          const raw = l.slice(idx + 1);
          const commentIdx = raw.indexOf(" #");
          const value = (commentIdx === -1 ? raw : raw.slice(0, commentIdx)).trim();
          return [key, value] as [string, string];
        })
    );
  } catch {
    /* no .env file — Railway supplies everything via process.env */
  }

  // On Railway, process.env is the source of truth (Variables panel).
  // Only merge process.env when actually running on Railway — locally, .env is authoritative
  // so shell variables don't silently override developer config.
  // Only promote to cloud-defaults when RAILWAY_ENVIRONMENT is exactly "production"
  // so that staging/PR-preview deployments keep safe conservative values.
  const railwayEnv = process.env.RAILWAY_ENVIRONMENT;
  const isCloud = !!(railwayEnv ?? process.env.RAILWAY_PROJECT_ID);
  const isProductionCloud =
    railwayEnv === "production" || (!railwayEnv && !!process.env.RAILWAY_PROJECT_ID);
  const merged: Record<string, string> = { ...fromFile };
  if (isCloud) {
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) merged[k] = v;
    }
  }

  // Auto-promote throttled local defaults → cloud values only in production.
  // Explicit Railway Variables panel entries always win (checked via process.env).
  if (isProductionCloud) {
    if (!process.env.BATCH_CONCURRENCY) merged.BATCH_CONCURRENCY = "8";
    if (!process.env.ENABLE_SWARM) merged.ENABLE_SWARM = "true";
    if (!process.env.ENABLE_SPORTYBET_BOOKING) merged.ENABLE_SPORTYBET_BOOKING = "true";
  }

  // Backfill process.env from the parsed .env file, like a real dotenv.config()
  // would. A handful of call sites outside this module's reach read gating flags
  // straight off process.env instead of the returned config object — e.g.
  // ORACLE_LOCAL_DECISION (packages/engine/src/decision/index.ts's arbitrate()),
  // ORACLE_RUNTIME/CLAUDE_BIN/CLAUDE_USERPROFILE (packages/llm/src/callClaudeCode.ts)
  // — and until now silently never saw .env-only values, so the local Claude Code
  // arbiter was unreachable however the .env file was configured. Only fills gaps;
  // never overrides an already-set OS-level var, so the Railway-wins policy above
  // is preserved.
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return merged;
}

/** Key diagnostics — maps config field → .env var name + human description. */
const KEY_MAP: Array<{
  field: keyof OracleConfig;
  envVar: string;
  description: string;
  retriable: boolean;
}> = [
  {
    field: "claudeApiKey",
    envVar: "CLAUDE_API_KEY",
    description: "Claude Opus LLM decisions",
    retriable: false,
  },
  {
    field: "geminiApiKey",
    envVar: "GEMINI_API_KEY",
    description: "Gemini fallback + acquisition",
    retriable: false,
  },
  {
    field: "oddsApiKey",
    envVar: "ODDS_API_KEY",
    description: "live odds fetching and CLV",
    retriable: false,
  },
  {
    field: "footballDataApiKey",
    envVar: "FOOTBALL_DATA_API_KEY",
    description: "post-match result resolution",
    retriable: false,
  },
  {
    field: "apiFootballKey",
    envVar: "API_FOOTBALL_KEY",
    description: "alternative fixture/lineup source",
    retriable: false,
  },
];

/** Return an AgentError for each absent or empty config key, naming the exact .env variable.
 *  Non-fatal — the caller decides whether to block or warn. */
export function validateConfig(config: OracleConfig): AgentError[] {
  return KEY_MAP.filter(({ field }) => !config[field as keyof OracleConfig]).map(
    ({ envVar, description }) => ({
      code: "NO_DATA" as const,
      message: `Missing ${envVar} — required for ${description}. Add it to .env: ${envVar}=<your-key>`,
      retriable: false,
    })
  );
}

/** True when running inside a Railway deployment (Railway injects this automatically). */
function isRailway(env: Record<string, string>): boolean {
  return !!env.RAILWAY_ENVIRONMENT || !!env.RAILWAY_PROJECT_ID;
}

/** Build an OracleConfig from a parsed env record. Defaults: bankroll=1000, CONFIDENCE_WEIGHTED.
 *  On Railway, resource-throttled local defaults are automatically promoted to cloud values
 *  unless the env var is explicitly overridden in the Railway Variables panel. */
export function buildConfig(env: Record<string, string>): OracleConfig {
  const hw = detectHardware();
  const gpuCapable = isGpuCapable(hw);
  const cloud = isRailway(env);
  const autoResearchRequested = env.ORACLE_AUTORESEARCH_ENABLED?.toLowerCase() === "true";
  const maxFixturesRaw = Math.floor(
    Number(env.MAX_FIXTURES_PER_RUN ?? DEFAULT_MAX_FIXTURES_PER_RUN)
  );

  // On Railway: promote conservative local defaults → full cloud values.
  // Explicit env vars always win — Railway Variables panel overrides these.
  const batchConcurrency = Number(env.BATCH_CONCURRENCY ?? (cloud ? 8 : 3));
  const enableSwarmFlag =
    env.ENABLE_SWARM !== undefined ? env.ENABLE_SWARM.toLowerCase() === "true" : cloud; // default true on Railway, false locally

  if (cloud) {
    process.stdout.write(
      `[config] Railway environment detected — cloud defaults active` +
        ` (concurrency=${batchConcurrency}, swarm=${enableSwarmFlag})\n`
    );
  }

  return {
    geminiApiKey: env.GEMINI_API_KEY ?? "",
    claudeApiKey: env.CLAUDE_API_KEY ?? "",
    perplexityApiKey: env.PERPLEXITY_API_KEY,
    kimiApiKey: env.KIMI_API_KEY,
    openrouterApiKey: env.OPENROUTER_API_KEY,
    openWeatherApiKey: env.OPENWEATHER_API_KEY,
    footballDataApiKey: env.FOOTBALL_DATA_API_KEY,
    apiFootballKey: env.API_FOOTBALL_KEY,
    oddsApiKey: env.ODDS_API_KEY,
    sharpApiIoKey: env.SHARPAPI_IO_KEY,
    oddsApiIoKey: env.ODDS_API_IO_KEY,
    oddsPapiKey: env.ODDSPAPI_KEY,
    sportsGameOddsKey: env.SPORTS_GAMEODDS_KEY,
    bankroll: Number(env.BANKROLL ?? 1000),
    rankingMode: "CONFIDENCE_WEIGHTED",
    // Web search fallback for odds when Odds API fails
    enableWebSearchOddsFallback: env.ENABLE_WEB_SEARCH_FALLBACK?.toLowerCase() !== "false",
    webOddsMinConsensus: Number(env.WEB_ODDS_MIN_CONSENSUS ?? 3),
    webOddsVarianceThreshold: Number(env.WEB_ODDS_VARIANCE_THRESHOLD ?? 0.025),
    // Web search fallback for match results when API-Football + football-data.org both miss
    enableWebSearchResultsFallback:
      env.ENABLE_WEB_SEARCH_RESULTS_FALLBACK?.toLowerCase() !== "false",
    webResultsMinConsensus: Number(env.WEB_RESULTS_MIN_CONSENSUS ?? 2),
    // T0 news intel + swarm — opt-in; on when the flag is set AND any provider key
    // is present. Gemini-only enables the Google AI-Mode fallback (no Perplexity needed).
    enableNewsIntel:
      env.ENABLE_NEWS_INTEL?.toLowerCase() === "true" &&
      (!!env.PERPLEXITY_API_KEY || !!env.GEMINI_API_KEY),
    enableSwarm: enableSwarmFlag && (!!env.KIMI_API_KEY || !!env.OPENROUTER_API_KEY),
    batchConcurrency,
    // Pre-analysis fixture cap — bounds per-run odds/LLM quota spend
    maxFixturesPerRun:
      Number.isFinite(maxFixturesRaw) && maxFixturesRaw >= 1
        ? maxFixturesRaw
        : DEFAULT_MAX_FIXTURES_PER_RUN,
    // Goals-only accumulator pipeline thresholds (runGoalsBatch)
    goalsMinConfidence: Number(env.GOALS_MIN_CONFIDENCE ?? DEFAULT_GOALS_MIN_CONFIDENCE),
    goalsMinImplied: Number(env.GOALS_MIN_IMPLIED ?? DEFAULT_GOALS_MIN_IMPLIED),
    goalsTargetLegs: Math.floor(Number(env.GOALS_TARGET_LEGS ?? DEFAULT_GOALS_TARGET_LEGS)),
    // Intentionally NOT read from ORACLE_GOALS_ONLY_MODE here. This flag is an
    // exception scoped to the goals-discovery pipeline alone (apps/worker's
    // runGoalsBatch reads the env var directly and applies it on its own
    // runAnalysis call). buildConfig() produces ONE shared config object reused
    // by every analysis call site (main daily batch, ad-hoc /analyze, CLI, web,
    // punt counter-analysis) — defaulting it to the env var here would silently
    // restrict every one of those paths to goals-only markets too.
    enableGoalsOnlyMode: false,
    // Hardware capabilities — detected at startup, never hardcoded
    hasNvidiaGpu: hw.hasNvidiaGpu,
    isVps: hw.isVps,
    // Autonomous SkillOpt loop: requires explicit opt-in AND GPU/VPS capability
    enableAutoResearch: autoResearchRequested && gpuCapable,
    // Negative Binomial overdispersion in score marginals (default ON, r=10 per
    // Karlis & Ntzoufras 2003 calibrated for professional football; set
    // USE_NEG_BINOM=false to revert to pure Poisson).
    useNegBinom: env.USE_NEG_BINOM?.toLowerCase() !== "false",
    nbDispersion: env.NB_DISPERSION ? Number(env.NB_DISPERSION) : 10,
    useMCRuin: env.USE_MC_RUIN?.toLowerCase() === "true",
    // All-markets LLM executor: when true, decide() routes llmEligible fixtures
    // through one Opus agent over the full raw allMarkets catalogue (no family
    // privileged), validated against real odds + audited by the arbiter, instead
    // of the family-gated deterministic cascade. Off → deterministic fallback.
    enableLlmMarketExecutor: env.ENABLE_LLM_MARKET_EXECUTOR?.toLowerCase() === "true",
    // v3 cap/noise gates on goals-family markets in the MAIN batch (see
    // OracleConfig.enableV3MainGates docstring). Shares the same threshold env
    // keys as the goals-only v3 batch (buildGoalsV3Config) so one number pair
    // governs "how hot is too hot" everywhere it's applied.
    enableV3MainGates: env.ORACLE_V3_MAIN_GATES?.toLowerCase() === "true",
    v3EdgeCap: Number(env.GOALS_V3_EDGE_CAP ?? 0.12),
    v3NoiseGate: Number(env.GOALS_V3_NOISE_GATE ?? 0.02),
    // all-markets-analysis-prompt-v3 deterministic engine (OracleConfig.
    // enableMarketsV3 docstring). Default ON per owner decision — v3 replaces
    // the legacy scanMarkets candidate set for every fixture, fail-open to
    // legacy on any v3 error/null. Set ORACLE_MARKETS_V3=off to roll back, or
    // =shadow to run v3 alongside legacy without acting on its output.
    enableMarketsV3: parseMarketsV3Mode(env.ORACLE_MARKETS_V3),
    // v4 HFA multiplier (§3.1a) — defaults 1.10 (10% home advantage). Set
    // ORACLE_V3_HFA=1.0 to disable during cold deploy.
    v3Hfa: env.ORACLE_V3_HFA ? Number(env.ORACLE_V3_HFA) : 1.1,
    // Venue-split data provenance flag — when true, input λ already incorporates
    // field advantage via true home/away splits (suppress HFA multiplier).
    // ORACLE_V3_VENUE_SPLIT=on to enable (default off = team-overall stats).
    v3VenueSplitUsed: env.ORACLE_V3_VENUE_SPLIT?.toLowerCase() === "on",
    // v4 gate deltas: heightened EV bars, exact-goals/multigoals routing, sanity checks.
    // ORACLE_V3_GATES_V4=off to restore v3 semantics (default on).
    v3GatesV4: env.ORACLE_V3_GATES_V4?.toLowerCase() !== "off",
    // v4 completeness: demotes O/U hit-rate out of the mandatory block (critical-tier
    // penalty instead of discard) + per-selection line hit-rates. Increases live pick
    // volume — ORACLE_V3_COMPLETENESS_V4=off restores hit-rate to the mandatory set
    // (default on).
    v3CompletenessV4: env.ORACLE_V3_COMPLETENESS_V4?.toLowerCase() !== "off",
    // PR-5a slate pre-filter: v3 eligibility+completeness gate over sidecar-mapped
    // fixtures before the daily chunk loop (fail-open). Only acts when
    // ORACLE_MARKETS_V3=on. ORACLE_MARKETS_V3_GATE=off analyzes the ungated slate
    // (default on).
    marketsV3Gate: env.ORACLE_MARKETS_V3_GATE?.toLowerCase() !== "off",
    // PR-5b: outputs assembly — off keeps the exact legacy 39-cap trim untouched
    // (regression pin). Only relevant when enableMarketsV3 === "on".
    marketsV3Outputs: env.ORACLE_MARKETS_V3_OUTPUTS?.toLowerCase() !== "off",
    // PR-6: corners/cards O/U pricing — off withholds the stats so the modules
    // stay dormant (byte-identical to pre-PR-6).
    v3CornersCards: env.ORACLE_V3_CORNERS_CARDS?.toLowerCase() !== "off",
    // PR-6: R10 goals cross-check on the all-markets batch — off skips the hook.
    v3GoalsCrossCheck: env.ORACLE_V3_GOALS_CROSSCHECK?.toLowerCase() !== "off",
    // PR-7: calibration feedback loop (off|shadow|on, default shadow). Write side
    // settles resolved picks into the ledger in shadow+on; read side only applies
    // calibFactor/isotonic when "on".
    calibrationLedger: parseCalibrationMode(env.ORACLE_CALIBRATION_LEDGER),
  };
}

/** ORACLE_CALIBRATION_LEDGER → off|shadow|on. Default shadow (write-only, no live
 *  behaviour change) for the initial rollout window; explicit off disables the
 *  write side too. Unknown values fall back to the safe shadow default. */
function parseCalibrationMode(raw: string | undefined): "off" | "shadow" | "on" {
  const v = raw?.toLowerCase().trim();
  if (v === "off" || v === "on") return v;
  return "shadow";
}

function parseMarketsV3Mode(raw: string | undefined): "on" | "shadow" | "off" {
  const v = raw?.toLowerCase().trim();
  if (v === "off" || v === "shadow") return v;
  return "on";
}

/** goals-market-analysis-prompt-v3 settings scoped to the goals-only batch
 *  (runGoalsBatch) — not part of OracleConfig because @oracle/engine's
 *  goalsV3 modules take these as explicit call-site args, never read env
 *  directly. Single parse point, mirrors buildConfig()'s pattern. */
export interface GoalsV3Config {
  /** ORACLE_GOALS_V3 — master switch for the deterministic v3 goals path.
   *  false ⇒ legacy runGoalsFunnel/goalsScreen path, byte-identical to today. */
  enabled: boolean;
  /** §0.3 weighted completeness floor (0-100). Default 70 (mandatory block only). */
  completenessMin: number;
  /** §1.2 heightened-bar floor for youth/women/friendly/cup-final fixtures. */
  heightenedMin: number;
  /** §4.4 implausible-edge cap (raw edge above this ⇒ auto-discard). */
  edgeCap: number;
  /** §4.3 noise gate (|raw edge| at/below this ⇒ discard). */
  noiseGate: number;
  /** §3.1 optional 50/50 xG blend into the multiplicative lambda. */
  xgBlend: boolean;
  /** Slate arbiter callClaudeCode timeout (ms). */
  arbiterTimeoutMs: number;
  /** BTTS priced but excluded from slips until booking-agent label mapping is
   *  verified (locked plan conflict #6) — computed either way for the report. */
  enableBtts: boolean;
}

export function buildGoalsV3Config(env: Record<string, string>): GoalsV3Config {
  return {
    enabled: env.ORACLE_GOALS_V3?.toLowerCase() === "true",
    completenessMin: Number(env.GOALS_V3_COMPLETENESS_MIN ?? 70),
    heightenedMin: Number(env.GOALS_V3_HEIGHTENED_MIN ?? 85),
    edgeCap: Number(env.GOALS_V3_EDGE_CAP ?? 0.12),
    noiseGate: Number(env.GOALS_V3_NOISE_GATE ?? 0.02),
    xgBlend: env.GOALS_V3_XG_BLEND?.toLowerCase() !== "false",
    arbiterTimeoutMs: Number(env.GOALS_ARBITER_TIMEOUT_MS ?? 120_000),
    enableBtts: env.GOALS_V3_ENABLE_BTTS?.toLowerCase() === "true",
  };
}
