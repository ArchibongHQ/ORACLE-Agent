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

/** Read one positive-finite `Record<string, number>` field out of the lake
 *  artifact tools/compute_league_baselines.py writes at
 *  .tmp/oracle-store/league_baselines.json. Returns undefined on any miss
 *  (missing file, malformed JSON, no usable values) so the engine falls back to
 *  its static defaults. Never throws. Path is cwd-relative (the worker runs from
 *  repo root), matching the other .tmp artifact readers in runtime (dailyStore,
 *  analyze). */
function loadLakeField(
  path: string,
  field: "byName" | "hfaByName"
): Record<string, number> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const raw = parsed[field];
    if (!raw || typeof raw !== "object") return undefined;
    const out: Record<string, number> = {};
    for (const [league, val] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof val === "number" && Number.isFinite(val) && val > 0) out[league] = val;
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Lake-computed league goal baselines (audit P0-2) — the `byName` map. */
export function loadLakeBaselines(
  path = ".tmp/oracle-store/league_baselines.json"
): Record<string, number> | undefined {
  return loadLakeField(path, "byName");
}

/** Lake-fitted per-league HFA multipliers (full-audit P3) — the `hfaByName` map. */
export function loadLakeHfa(
  path = ".tmp/oracle-store/league_baselines.json"
): Record<string, number> | undefined {
  return loadLakeField(path, "hfaByName");
}

/** Build an OracleConfig from a parsed env record. Defaults: bankroll=1000, CONFIDENCE_WEIGHTED.
 *  On Railway, resource-throttled local defaults are automatically promoted to cloud values
 *  unless the env var is explicitly overridden in the Railway Variables panel.
 *  `leagueBaselinesPath` overrides where the lake-baselines/HFA artifact is read from — pass an
 *  absolute path when the caller's process.cwd() isn't the repo root (e.g. the worker's Servy
 *  service runs with cwd=apps/worker, so the bare relative default would silently miss the file
 *  tools/compute_league_baselines.py writes at <repo root>/.tmp/oracle-store/). */
export function buildConfig(
  env: Record<string, string>,
  leagueBaselinesPath?: string
): OracleConfig {
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

  // Audit P0-2: lake-computed league baselines override the static table only
  // when ORACLE_V3_LAKE_BASELINES=on. Default off ⇒ undefined ⇒ static-only
  // (byte-identical to prior behavior). The startup line makes the flip visible
  // in the effective-config log and warns if the flag is on but the artifact is
  // missing (run tools/compute_league_baselines.py first).
  const lakeBaselinesOn = env.ORACLE_V3_LAKE_BASELINES?.toLowerCase() === "on";
  const v3LakeBaselines = lakeBaselinesOn
    ? leagueBaselinesPath
      ? loadLakeBaselines(leagueBaselinesPath)
      : loadLakeBaselines()
    : undefined;
  if (lakeBaselinesOn) {
    const n = v3LakeBaselines ? Object.keys(v3LakeBaselines).length : 0;
    process.stdout.write(
      n > 0
        ? `[config] ORACLE_V3_LAKE_BASELINES on — ${n} lake baselines override the static table\n`
        : `[config] ORACLE_V3_LAKE_BASELINES on but no usable .tmp/oracle-store/league_baselines.json — static table retained\n`
    );
  }

  // Full-audit P3: lake-fitted per-league HFA overrides the global v3Hfa only
  // when ORACLE_V3_LAKE_HFA=on. Default off ⇒ undefined ⇒ global v3Hfa applies.
  const lakeHfaOn = env.ORACLE_V3_LAKE_HFA?.toLowerCase() === "on";
  const v3HfaByLeague = lakeHfaOn
    ? leagueBaselinesPath
      ? loadLakeHfa(leagueBaselinesPath)
      : loadLakeHfa()
    : undefined;
  if (lakeHfaOn) {
    const n = v3HfaByLeague ? Object.keys(v3HfaByLeague).length : 0;
    process.stdout.write(
      n > 0
        ? `[config] ORACLE_V3_LAKE_HFA on — ${n} per-league HFA multipliers override the global v3Hfa\n`
        : `[config] ORACLE_V3_LAKE_HFA on but no usable hfaByName in .tmp/oracle-store/league_baselines.json — global v3Hfa retained\n`
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
    // T0 news intel + swarm — opt-in; on whenever the flag is set. No provider key
    // is required: a missing key is never a blocker (owner rule) — keyless mode
    // runs the Google AI-Mode scrape + local-Claude reshape ensemble tier instead
    // of Perplexity Sonar/Gemini.
    enableNewsIntel: env.ENABLE_NEWS_INTEL?.toLowerCase() === "true",
    // Gates the post-enrichment cloud data sync (tools/sync_cloud_news.py).
    cloudNewsSync: env.ORACLE_CLOUD_NEWS_SYNC?.toLowerCase() === "true",
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
    // PR-23: ENABLE_LLM_MARKET_EXECUTOR is now tri-state ("true"/"unmapped"/
    // anything else) — llmExecutorScope carries the parsed value,
    // enableLlmMarketExecutor stays a plain boolean (true for both "full" and
    // "unmapped") since most call sites only ever need the on/off signal.
    enableLlmMarketExecutor: parseLlmExecutorScope(env.ENABLE_LLM_MARKET_EXECUTOR) !== "off",
    llmExecutorScope: parseLlmExecutorScope(env.ENABLE_LLM_MARKET_EXECUTOR),
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
    // λ v5 independent-side xG blend (goalsV3/lambda.ts) — default on, was an
    // unwired always-on option prior to this flag existing. Set
    // ORACLE_V3_LAMBDA_V5=off to restore the prior both-sides-only blend.
    v3LambdaV5: env.ORACLE_V3_LAMBDA_V5?.toLowerCase() !== "off",
    // Audit P0-2: lake-computed baselines (loaded above, gated on
    // ORACLE_V3_LAKE_BASELINES=on). Undefined ⇒ static V3_LEAGUE_BASELINES only.
    v3LakeBaselines,
    // Full-audit P3: lake-fitted per-league HFA (gated on ORACLE_V3_LAKE_HFA=on).
    // Undefined ⇒ global v3Hfa applies everywhere.
    v3HfaByLeague,
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
    // PR-20: slate-wide route-coverage rollup — telemetry only, default on.
    marketsCoverageNote: env.ORACLE_MARKETS_COVERAGE?.toLowerCase() !== "off",
    // PR-21: runtime catalog overlay — default OFF (see OracleConfig.catalogOverlay).
    catalogOverlay: env.ORACLE_CATALOG_OVERLAY?.toLowerCase() === "on",
    // PR-6: corners/cards O/U pricing — off withholds the stats so the modules
    // stay dormant (byte-identical to pre-PR-6).
    v3CornersCards: env.ORACLE_V3_CORNERS_CARDS?.toLowerCase() !== "off",
    // PR-22: 1x2/handicap/range/odd-even corners/cards variants — default on.
    v3CornersCardsExt: env.ORACLE_V3_CORNERS_CARDS_EXT?.toLowerCase() !== "off",
    // PR-22: shots-on-target O/U module — default on.
    v3ShotsOu: env.ORACLE_V3_SHOTS_OU?.toLowerCase() !== "off",
    // PR-6: R10 goals cross-check on the all-markets batch — off skips the hook.
    v3GoalsCrossCheck: env.ORACLE_V3_GOALS_CROSSCHECK?.toLowerCase() !== "off",
    // PR-7: calibration feedback loop (off|shadow|on, default shadow). Write side
    // settles resolved picks into the ledger in shadow+on; read side only applies
    // calibFactor/isotonic when "on".
    calibrationLedger: parseCalibrationMode(env.ORACLE_CALIBRATION_LEDGER),
    // PR-8 posture A: skip the paid draft LLM cascade when v3 supplied candidates
    // (arbiter still reviews top-N). Default on — ORACLE_V3_DETERMINISTIC_DRAFT=off
    // restores the full LLM draft cascade.
    v3DeterministicDraft: env.ORACLE_V3_DETERMINISTIC_DRAFT?.toLowerCase() !== "off",
    // PR-8: optional LLM extras (briefing/swarm/CVL) tier scope. Default "apex".
    llmExtrasTiers: env.ORACLE_LLM_EXTRAS_TIERS?.toLowerCase() === "all" ? "all" : "apex",
    // PR-8: make the previously-dead B1 briefing / B2 CVL layers explicit + opt-in
    // (they were never set in buildConfig, so always undefined = off). Default off —
    // posture A keeps the paid extras gated; ENABLE_BRIEFING/ENABLE_CVL=true opts in.
    enableBriefing: env.ENABLE_BRIEFING?.toLowerCase() === "true",
    enableCVL: env.ENABLE_CVL?.toLowerCase() === "true",
    // [refactor P0-2] Market-anchored blend (v5 §5.8). Default ON per the
    // change list: blend fields persist on every assessment in shadow+on;
    // the odds≥4.00 blendEdge ≥ +5% gate enforces only when "on".
    v3Blend: parseTriState(env.ORACLE_V3_BLEND, "on"),
    // [refactor P0-3] Safety posture: "penalty" (default) = mis-scoped hard
    // rejects become family penalties/tier downgrades; "legacy" = rollback.
    safetyMode: env.ORACLE_SAFETY_MODE?.toLowerCase() === "legacy" ? "legacy" : "penalty",
    // [refactor P1-3] Feed-integrity stage (Rule 0.14). Default ON —
    // contamination is an integrity-class hard reject.
    feedIntegrity: parseTriState(env.ORACLE_FEED_INTEGRITY, "on"),
    // [refactor P1-4] Sharp-reference feed verification latch. Default false —
    // flipped manually (ORACLE_SHARP_FEED_VERIFIED=true) only after the feed
    // meets its documented coverage criteria; gates ConvergenceScorer S02-S05.
    sharpFeedVerified: env.ORACLE_SHARP_FEED_VERIFIED?.toLowerCase() === "true",
    // [refactor P0-1, Wave 2] ISO date marking the Wave-1 deploy — the P0-2/P0-3
    // pricing-behavior boundary. Per-segment calibration (calibrationLedger
    // "segment" mode) must only accumulate {n,wins,pSum} from picks stamped
    // on/after this date; pre-epoch records reflect the OLD (pre-blend,
    // pre-penalty) pricing and would poison segment factors if mixed in.
    calibrationEpochStart: env.ORACLE_CALIBRATION_EPOCH_START?.trim() || "2026-07-10",
    // [refactor P1-1, Wave 2] pi-ratings blend into goalsV3 lambda. Default
    // shadow — diagnostic deltas only; live only after clearing the +0.002 RPS
    // walk-forward significance bar (never hand-flipped, see plan's standing
    // rules).
    v3Ratings: parseTriState(env.ORACLE_V3_RATINGS, "shadow"),
    // [refactor P1-4, Wave 2] Sharp-reference odds feed (Odds API primary +
    // Playwright/Google-AI-Mode fallback). Default shadow — persists CLV
    // records without yet being the criterion that flips sharpFeedVerified.
    sharpFeed: parseTriState(env.ORACLE_SHARP_FEED, "shadow"),
    // [refactor P1-2, Wave 3] SafetyPipeline extraction (stage 1) + dual-run
    // shadow diff (stage 2). "shadow" (default) = the extracted pipeline runs
    // alongside legacy _run when usedV3, logging a structured diff into the
    // run manifest — DecisionContext still reads legacy output. "on" would
    // make SafetyPipeline authoritative (Wave 4 territory, gated on golden
    // tests + dual-run diff review, never hand-flipped early).
    v3Safety: parseTriState(env.ORACLE_V3_SAFETY, "shadow"),
    // [refactor P1-2, Wave 3] Rollback lever for the legacy pricer
    // (scanMarkets/scanAllMarketsFallback) — "on" (default) keeps it live;
    // "off" is Wave 4's eventual cutover flag, gated on a ≥7-slate parity
    // report + UNPRICED_BY_DESIGN registry closing the coverage gap.
    legacyPricer: env.ORACLE_LEGACY_PRICER?.toLowerCase() === "off" ? "off" : "on",
    // [Wave 4-accuracy] Market-anchored blend pricing for ALL v3 candidates —
    // "on" (default, owner decision after Phase-0 replay); "off" = legacy
    // raw-edge gating, byte-identical rollback.
    v3BlendPricing: env.ORACLE_V3_BLEND_PRICING?.toLowerCase() === "off" ? "off" : "on",
    // [Wave 4-accuracy] Empirical hit-rate blend for totals O/U half-lines
    // (goals counter only). "on" (default, owner decision).
    v3TotalsEmpirical: env.ORACLE_V3_TOTALS_EMPIRICAL?.toLowerCase() === "off" ? "off" : "on",
    // [X-carveout 2026-07-11] High-conviction Class X exception to the blend
    // gate. Default OFF (owner decision — this is a gate RELAXATION, unlike
    // every other flag): flip to "shadow" first for ledger evidence of
    // would-pass X candidates, then "on" only on evidence.
    v3XCarveout: parseTriState(env.ORACLE_V3_X_CARVEOUT, "off"),
    // [patterns-engine Wave 1] Pattern/trend-detection gate — "shadow"
    // (default) computes and logs pattern signals without gating picks;
    // "on" makes them gating (later wave); "off" disables entirely.
    v3Patterns: parseTriState(env.ORACLE_V3_PATTERNS, "shadow"),
    // [Phase 2, two-tier slate] "on" (default) = delivered slate is the
    // pattern-first two-tier pool; "legacy" = pre-Phase-2 behavior, the
    // escape hatch (mirrors ORACLE_SAFETY_MODE's two-state parse pattern
    // above — this is a two-state, not tri-state, flag, so it doesn't use
    // parseTriState).
    unifiedSlate: env.ORACLE_UNIFIED_SLATE?.toLowerCase() === "legacy" ? "legacy" : "on",
    // [Phase 2A, patterns-legacy-pricer] Governs the v6.2 pattern catalog
    // everywhere OUTSIDE markets-v3 (legacy pricer ranking now, Phase 3's
    // trap flags later) — distinct from v3Patterns above. "shadow" (default)
    // computes but never reorders; "on" applies the ranking boost.
    v62Patterns: parseTriState(env.ORACLE_V62_PATTERNS, "shadow"),
  };
}

/** Shared off|shadow|on parser for the refactor flags — unknown values fall
 *  back to the flag's documented default rather than a global constant. */
function parseTriState(
  raw: string | undefined,
  dflt: "off" | "shadow" | "on"
): "off" | "shadow" | "on" {
  const v = raw?.toLowerCase().trim();
  if (v === "off" || v === "shadow" || v === "on") return v;
  return dflt;
}

/** ORACLE_CALIBRATION_LEDGER → off|shadow|on|segment. Default shadow (write-only,
 *  no live behaviour change) for the initial rollout window; explicit off
 *  disables the write side too. [Wave 2] "segment" is the per-segment live mode
 *  (WS2-A) — calibFactorFor returns a segment-specific factor once its gate
 *  passes, global factor otherwise; ops flip to it only after verifying one
 *  clean slate of dual raw_p/calib_p persistence post-Wave-2. Unknown values
 *  fall back to the safe shadow default. */
function parseCalibrationMode(raw: string | undefined): "off" | "shadow" | "on" | "segment" {
  const v = raw?.toLowerCase().trim();
  if (v === "off" || v === "on" || v === "segment") return v;
  return "shadow";
}

function parseMarketsV3Mode(raw: string | undefined): "on" | "shadow" | "off" {
  const v = raw?.toLowerCase().trim();
  if (v === "off" || v === "shadow") return v;
  return "on";
}

// PR-23: tri-state ENABLE_LLM_MARKET_EXECUTOR. "true" ("full") preserves the
// pre-PR-23 behavior exactly; "unmapped" is the new skip-tail-only scope;
// anything else (including unset) is "off" — same default as before.
function parseLlmExecutorScope(raw: string | undefined): "full" | "unmapped" | "off" {
  const v = raw?.toLowerCase().trim();
  if (v === "true") return "full";
  if (v === "unmapped") return "unmapped";
  return "off";
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
