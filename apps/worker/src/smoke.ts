/** Phase 0 smoke test — verifies the extracted engine runs headlessly.
 *  Must produce output without touching window/localStorage/React. */
import { ExecutionEngine } from '@oracle/engine';
import { MemoryAdapter } from '@oracle/storage';
import type { OracleConfig } from '@oracle/engine';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, '../../..', '.env');

function loadEnv(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(envPath, 'utf8')
        .split('\n')
        .filter(l => l.includes('=') && !l.startsWith('#'))
        .map(l => l.split('=').map(s => s.trim()) as [string, string]),
    );
  } catch { return {}; }
}

const env = loadEnv();

const config: OracleConfig = {
  geminiApiKey:        env['GEMINI_API_KEY']         ?? '',
  claudeApiKey:        env['CLAUDE_API_KEY']          ?? '',
  openWeatherApiKey:   env['OPENWEATHER_API_KEY'],
  footballDataApiKey:  env['FOOTBALL_DATA_API_KEY'],
  apiFootballKey:      env['API_FOOTBALL_KEY'],
  oddsApiKey:          env['ODDS_API_KEY'],
  bankroll:            Number(env['BANKROLL'] ?? 1000),
  rankingMode:         'CONFIDENCE_WEIGHTED',
};

const storage = new MemoryAdapter();
const result = await ExecutionEngine.run({}, { storage, config });

console.log('Smoke test passed.');
console.log('fp:', result.fp);
console.log('evMarkets:', result.evMarkets.length);
console.log('oddsAvailable:', result.oddsAvailable);
