/** Shared .env loader + OracleConfig builder.
 *  Lifted from apps/worker/src/index.ts (§ env loader). Keys from .env only — never hardcoded. */
import { readFileSync } from "node:fs";
import type { AgentError, OracleConfig } from "@oracle/engine";
import { detectHardware, isGpuCapable } from "./hardware.js";
import { DEFAULT_MAX_FIXTURES_PER_RUN } from "./selectFixtures.js";

/** Parse a flat KEY=VALUE .env file into a record. Missing file → {} (never throws). */
export function loadEnv(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.includes("=") && !l.startsWith("#"))
        .map((l) => {
          const idx = l.indexOf("=");
          return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()] as [string, string];
        })
    );
  } catch {
    return {};
  }
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

/** Build an OracleConfig from a parsed env record. Defaults: bankroll=1000, CONFIDENCE_WEIGHTED. */
export function buildConfig(env: Record<string, string>): OracleConfig {
  const hw = detectHardware();
  const gpuCapable = isGpuCapable(hw);
  const autoResearchRequested = env.ORACLE_AUTORESEARCH_ENABLED?.toLowerCase() === "true";
  const maxFixturesRaw = Math.floor(
    Number(env.MAX_FIXTURES_PER_RUN ?? DEFAULT_MAX_FIXTURES_PER_RUN)
  );

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
    sportsGameOddsKey: env.SPORTS_GAMEODDS_KEY,
    bankroll: Number(env.BANKROLL ?? 1000),
    rankingMode: "CONFIDENCE_WEIGHTED",
    // Web search fallback for odds when Odds API fails
    enableWebSearchOddsFallback: env.ENABLE_WEB_SEARCH_FALLBACK?.toLowerCase() !== "false",
    webOddsMinConsensus: Number(env.WEB_ODDS_MIN_CONSENSUS ?? 3),
    webOddsVarianceThreshold: Number(env.WEB_ODDS_VARIANCE_THRESHOLD ?? 0.025),
    // T0 news intel + swarm — opt-in; off unless the key is present and the flag set
    enableNewsIntel: env.ENABLE_NEWS_INTEL?.toLowerCase() === "true" && !!env.PERPLEXITY_API_KEY,
    enableSwarm:
      env.ENABLE_SWARM?.toLowerCase() === "true" &&
      (!!env.KIMI_API_KEY || !!env.OPENROUTER_API_KEY),
    batchConcurrency: Number(env.BATCH_CONCURRENCY ?? 8),
    // Pre-analysis fixture cap — bounds per-run odds/LLM quota spend
    maxFixturesPerRun:
      Number.isFinite(maxFixturesRaw) && maxFixturesRaw >= 1
        ? maxFixturesRaw
        : DEFAULT_MAX_FIXTURES_PER_RUN,
    // Hardware capabilities — detected at startup, never hardcoded
    hasNvidiaGpu: hw.hasNvidiaGpu,
    isVps: hw.isVps,
    // Autonomous SkillOpt loop: requires explicit opt-in AND GPU/VPS capability
    enableAutoResearch: autoResearchRequested && gpuCapable,
  };
}
