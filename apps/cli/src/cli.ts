#!/usr/bin/env node
/** ORACLE CLI — `oracle <command>`.
 *  Thin wrapper over @oracle/runtime; every command delegates to the shared analysis path.
 *  Arg parsing uses node:util parseArgs (built-in, zero-dep). */
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GBrainAdapter } from '@oracle/storage';
import { parseFixtureList } from '@oracle/engine';
import type { OracleConfig, BatchResult, RankingMode, PickRef, BatchJobResult } from '@oracle/engine';
import {
  loadEnv, buildConfig, fetchTodaysFixtures, fetchFixtureByName,
  runAnalysis, resolveDay,
} from '@oracle/runtime';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '../../..');
const DB_PATH = join(ROOT, '.tmp/gbrain');
const REPORTS_DIR = join(ROOT, '.tmp/reports');

const HELP = `ORACLE CLI

Usage: oracle <command> [options]

Commands:
  run                     Fetch today's fixtures (Odds API) and analyse them
  fixture "Home vs Away"  Analyse a single fixture by name
  analyze <file>          Analyse a fixture list file (one "Home vs Away, League, Kickoff" per line)
  resolve                 Resolve a day's fixtures against actual results
  report                  Print (and optionally open) a generated HTML report
  help                    Show this help

Options:
  --date <YYYY-MM-DD>     Target date (run/resolve/report); defaults to today
  --league <name>         League hint for the fixture command (e.g. "Premier League")
  --mode <RankingMode>    Ranking mode (default CONFIDENCE_WEIGHTED)
  --no-llm                Force deterministic decisions (ignore Claude/Gemini keys)
  --open                  Open the report in the default browser (report command)
  --json                  Emit machine-readable JSON instead of a text summary
`;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadConfig(noLlm: boolean): OracleConfig {
  const config = buildConfig(loadEnv(join(ROOT, '.env')));
  if (noLlm) return { ...config, claudeApiKey: '', geminiApiKey: '' };
  return config;
}

function summarize(batch: BatchResult): string {
  const lines: string[] = [];
  lines.push(`ORACLE — ${batch.date} · mode=${batch.rankingMode} · ${batch.jobs.length} fixtures · ${batch.actionableCount} actionable · ${batch.errorCount} errors`);
  for (const j of batch.jobs as BatchJobResult[]) {
    if (j.status === 'error') {
      lines.push(`  ✗ ${j.home} vs ${j.away} — ERROR: ${j.reason}`);
      continue;
    }
    const pick = j.decision.primaryPick;
    if (pick === 'NO_BET') {
      lines.push(`  · ${j.home} vs ${j.away} — NO_BET`);
    } else {
      const p = pick as PickRef;
      const stake = p.stake != null ? ` ${(p.stake * 100).toFixed(1)}% Kelly` : '';
      lines.push(`  ✓ ${j.home} vs ${j.away} — ${p.market}${p.side ? ` (${p.side})` : ''} @ ${p.odds}${stake} · ${(j.decision.confidence * 100).toFixed(0)}% conf`);
    }
  }
  return lines.join('\n');
}

function splitFixture(s: string): { home: string; away: string } | null {
  const parts = s.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return null;
  const home = parts[0]!.trim(), away = parts[1]!.trim();
  if (!home || !away) return null;
  return { home, away };
}

function openInBrowser(path: string): void {
  const plat = process.platform;
  const [cmd, args] = plat === 'win32'
    ? ['cmd', ['/c', 'start', '', path]]
    : plat === 'darwin'
      ? ['open', [path]]
      : ['xdg-open', [path]];
  spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' }).unref();
}

export interface DispatchResult {
  code: number;
  output: string;
}

/** Route a parsed argv (without node/script) to a command. Returns exit code + text to print. */
export async function dispatch(argv: string[]): Promise<DispatchResult> {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { code: 0, output: HELP };
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      date:   { type: 'string' },
      league: { type: 'string' },
      mode:   { type: 'string' },
      'no-llm': { type: 'boolean', default: false },
      open:   { type: 'boolean', default: false },
      json:   { type: 'boolean', default: false },
    },
  });

  const noLlm = Boolean(values['no-llm']);
  const json = Boolean(values.json);
  const config = loadConfig(noLlm);
  if (values.mode) config.rankingMode = values.mode as RankingMode;

  switch (command) {
    case 'run': {
      const storage = new GBrainAdapter(DB_PATH);
      try {
        const { jobs, source } = await fetchTodaysFixtures(config.oddsApiKey);
        if (!jobs.length) return { code: 1, output: 'No fixtures available (Odds API empty and no cache).' };
        const result = await runAnalysis(jobs, { storage, config }, { trigger: 'manual', batchOptions: { rankingMode: config.rankingMode } });
        const out = json ? JSON.stringify({ source, ...result.manifest }, null, 2) : `${summarize(result.batch)}\n(source: ${source}) report → ${result.reportPath}`;
        return { code: 0, output: out };
      } finally { await storage.close(); }
    }

    case 'fixture': {
      const arg = positionals[0];
      if (!arg) return { code: 1, output: 'Usage: oracle fixture "Home vs Away" [--league L]' };
      const split = splitFixture(arg);
      if (!split) return { code: 1, output: `Could not parse "${arg}" — expected "Home vs Away".` };
      const storage = new GBrainAdapter(DB_PATH);
      try {
        const job = await fetchFixtureByName(split.home, split.away, config.oddsApiKey, values.league);
        if (!job) return { code: 1, output: `No odds found for ${split.home} vs ${split.away}${values.league ? ` in ${values.league}` : ''}.` };
        const result = await runAnalysis([job], { storage, config }, { trigger: 'manual', batchOptions: { rankingMode: config.rankingMode } });
        const out = json ? JSON.stringify(result.manifest, null, 2) : `${summarize(result.batch)}\nreport → ${result.reportPath}`;
        return { code: 0, output: out };
      } finally { await storage.close(); }
    }

    case 'analyze': {
      const file = positionals[0];
      if (!file) return { code: 1, output: 'Usage: oracle analyze <file>' };
      let text: string;
      try { text = await readFile(file, 'utf8'); }
      catch { return { code: 1, output: `Cannot read file: ${file}` }; }
      const jobs = parseFixtureList(text);
      if (!jobs.length) return { code: 1, output: `No fixtures parsed from ${file}.` };
      const storage = new GBrainAdapter(DB_PATH);
      try {
        const result = await runAnalysis(jobs, { storage, config }, { trigger: 'manual', batchOptions: { rankingMode: config.rankingMode } });
        const out = json ? JSON.stringify(result.manifest, null, 2) : `${summarize(result.batch)}\nreport → ${result.reportPath}`;
        return { code: 0, output: out };
      } finally { await storage.close(); }
    }

    case 'resolve': {
      const date = values.date ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const storage = new GBrainAdapter(DB_PATH);
      try {
        const r = await resolveDay(storage, { footballDataApiKey: config.footballDataApiKey, oddsApiKey: config.oddsApiKey }, date);
        if (json) return { code: 0, output: JSON.stringify(r, null, 2) };
        if (!config.footballDataApiKey) return { code: 1, output: 'No FOOTBALL_DATA_API_KEY in .env — cannot resolve.' };
        return { code: 0, output: `Resolved ${r.resolved.length}/${r.candidates} fixtures for ${date} (${r.unmatched.length} unmatched).` };
      } finally { await storage.close(); }
    }

    case 'report': {
      const date = values.date ?? today();
      const path = join(REPORTS_DIR, `oracle-${date}.html`);
      if (values.open) openInBrowser(path);
      return { code: 0, output: json ? JSON.stringify({ date, path }) : `Report: ${path}${values.open ? ' (opening…)' : ''}` };
    }

    default:
      return { code: 1, output: `Unknown command: ${command}\n\n${HELP}` };
  }
}

async function main(): Promise<void> {
  const { code, output } = await dispatch(process.argv.slice(2));
  console.log(output);
  process.exit(code);
}

// Run only when invoked directly (not when imported by tests)
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}
