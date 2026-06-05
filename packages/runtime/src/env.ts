/** Shared .env loader + OracleConfig builder.
 *  Lifted from apps/worker/src/index.ts (§ env loader). Keys from .env only — never hardcoded. */
import { readFileSync } from 'node:fs';
import type { OracleConfig, AgentError } from '@oracle/engine';

/** Parse a flat KEY=VALUE .env file into a record. Missing file → {} (never throws). */
export function loadEnv(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter(l => l.includes('=') && !l.startsWith('#'))
        .map(l => {
          const idx = l.indexOf('=');
          return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()] as [string, string];
        }),
    );
  } catch { return {}; }
}

/** Key diagnostics — maps config field → .env var name + human description. */
const KEY_MAP: Array<{
  field: keyof OracleConfig;
  envVar: string;
  description: string;
  retriable: boolean;
}> = [
  { field: 'claudeApiKey',       envVar: 'CLAUDE_API_KEY',         description: 'Claude Opus LLM decisions',         retriable: false },
  { field: 'geminiApiKey',       envVar: 'GEMINI_API_KEY',         description: 'Gemini fallback + acquisition',      retriable: false },
  { field: 'oddsApiKey',         envVar: 'ODDS_API_KEY',           description: 'live odds fetching and CLV',        retriable: false },
  { field: 'footballDataApiKey', envVar: 'FOOTBALL_DATA_API_KEY',  description: 'post-match result resolution',      retriable: false },
  { field: 'apiFootballKey',     envVar: 'API_FOOTBALL_KEY',       description: 'alternative fixture/lineup source', retriable: false },
];

/** Return an AgentError for each absent or empty config key, naming the exact .env variable.
 *  Non-fatal — the caller decides whether to block or warn. */
export function validateConfig(config: OracleConfig): AgentError[] {
  return KEY_MAP
    .filter(({ field }) => !config[field as keyof OracleConfig])
    .map(({ envVar, description }) => ({
      code: 'NO_DATA' as const,
      message: `Missing ${envVar} — required for ${description}. Add it to .env: ${envVar}=<your-key>`,
      retriable: false,
    }));
}

/** Build an OracleConfig from a parsed env record. Defaults: bankroll=1000, CONFIDENCE_WEIGHTED. */
export function buildConfig(env: Record<string, string>): OracleConfig {
  return {
    geminiApiKey:        env['GEMINI_API_KEY']        ?? '',
    claudeApiKey:        env['CLAUDE_API_KEY']         ?? '',
    openWeatherApiKey:   env['OPENWEATHER_API_KEY'],
    footballDataApiKey:  env['FOOTBALL_DATA_API_KEY'],
    apiFootballKey:      env['API_FOOTBALL_KEY'],
    oddsApiKey:          env['ODDS_API_KEY'],
    bankroll:            Number(env['BANKROLL'] ?? 1000),
    rankingMode:         'CONFIDENCE_WEIGHTED',
    // Web search fallback for odds when Odds API fails
    enableWebSearchOddsFallback: env['ENABLE_WEB_SEARCH_FALLBACK']?.toLowerCase() !== 'false',
    webOddsMinConsensus: Number(env['WEB_ODDS_MIN_CONSENSUS'] ?? 3),
    webOddsVarianceThreshold: Number(env['WEB_ODDS_VARIANCE_THRESHOLD'] ?? 0.025),
  };
}
