/** ORACLE scheduled worker — thin cron shell.
 *  node-cron daily batch (09:00) + resolve-yesterday (14:00).
 *  All analysis/fixture/report logic lives in @oracle/runtime; this file only schedules. */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import cron from 'node-cron';
import { GBrainAdapter } from '@oracle/storage';
import type { RunManifest } from '@oracle/engine';
import {
  loadEnv, buildConfig, fetchTodaysFixtures, runAnalysis, resolveDay,
} from '@oracle/runtime';
import { buildNotifiers, notifyAll, summarizeBatch } from '@oracle/notify';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '../../..');

const env = loadEnv(join(ROOT, '.env'));
const config = buildConfig(env);
const DB_PATH = join(ROOT, '.tmp/gbrain');

// ── Fixture scraper ───────────────────────────────────────────────────────────

function scrapeFixtures(): Promise<number> {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const script = join(ROOT, 'tools', 'scrape_fixtures.py');
  return new Promise((resolve) => {
    execFile(python, [script], { cwd: ROOT }, (err, stdout, stderr) => {
      if (stdout) console.log(`[oracle] ${stdout.trim()}`);
      if (stderr) console.warn(`[oracle] [scrape stderr] ${stderr.trim()}`);
      if (err) console.warn(`[oracle] Scrape failed (continuing): ${err.message}`);
      // Parse sportybet count from playwright summary line, e.g. "sportybet:12"
      const m = stdout.match(/sportybet:(\d+)/);
      resolve(m ? parseInt(m[1], 10) : 0);
    });
  });
}

// ── SportyBet streak tracker ──────────────────────────────────────────────────

const STREAK_FILE = join(ROOT, '.tmp', 'sportybet_streak.json');
const WORKFLOW_DOC = join(ROOT, 'workflows', 'scrape_fixtures.md');
const STREAK_THRESHOLD = 2;

function readStreak(): number {
  try {
    if (!existsSync(STREAK_FILE)) return 0;
    const data = JSON.parse(readFileSync(STREAK_FILE, 'utf8')) as { streak?: number };
    return typeof data.streak === 'number' ? data.streak : 0;
  } catch {
    return 0;
  }
}

function writeStreak(streak: number): void {
  try {
    writeFileSync(STREAK_FILE, JSON.stringify({ streak }), 'utf8');
  } catch (err) {
    console.warn(`[oracle] Could not write streak file: ${err}`);
  }
}

function promoteSportyBetStatus(): void {
  try {
    const doc = readFileSync(WORKFLOW_DOC, 'utf8');
    // Only rewrite if still marked Partial — idempotent
    if (!doc.includes('⚠️ Partial | WAT (UTC+1)')) return;
    const updated = doc.replace('⚠️ Partial | WAT (UTC+1)', '✅ Working | WAT (UTC+1)');
    writeFileSync(WORKFLOW_DOC, updated, 'utf8');
    console.log('[oracle] SportyBet scraper promoted to ✅ Working in workflows/scrape_fixtures.md');
  } catch (err) {
    console.warn(`[oracle] Could not promote SportyBet status: ${err}`);
  }
}

function checkSportyBetStreak(sportyBetCount: number): void {
  // Skip once already promoted
  try {
    const doc = readFileSync(WORKFLOW_DOC, 'utf8');
    if (doc.includes('✅ Working | WAT (UTC+1)')) return;
  } catch { return; }

  const streak = sportyBetCount > 0 ? readStreak() + 1 : 0;
  writeStreak(streak);
  console.log(`[oracle] SportyBet streak: ${streak}/${STREAK_THRESHOLD} (today: ${sportyBetCount} fixtures)`);

  if (streak >= STREAK_THRESHOLD) {
    promoteSportyBetStatus();
    writeStreak(0); // reset — no further tracking needed
  }
}

// ── Daily batch (09:00) ───────────────────────────────────────────────────────

async function runDailyBatch(trigger: RunManifest['trigger'] = 'scheduled'): Promise<void> {
  console.log(`[oracle] Daily batch start — ${new Date().toISOString()}`);
  const sportyBetCount = await scrapeFixtures();
  checkSportyBetStreak(sportyBetCount);
  const storage = new GBrainAdapter(DB_PATH);

  const { jobs, source } = await fetchTodaysFixtures(config.oddsApiKey, true, config.geminiApiKey);
  console.log(`[oracle] ${jobs.length} fixtures (source: ${source})`);

  if (!jobs.length) {
    console.warn('[oracle] No fixtures — skipping batch');
    await storage.close();
    return;
  }

  const { batch, records, reportPath } = await runAnalysis(jobs, { storage, config }, {
    trigger,
    batchOptions: {
      onProgress: ({ completed, total, current }) => {
        if (current) console.log(`[oracle] [${completed + 1}/${total}] ${current}`);
      },
    },
  });

  if (records.length > 0) console.log(`[oracle] Wrote ${records.length} analysis records (upsert on analysisId)`);
  if (reportPath) console.log(`[oracle] Report → ${reportPath}`);
  console.log(`[oracle] Done — ${batch.completedCount} ok / ${batch.errorCount} errors / ${batch.actionableCount} actionable`);
  if (batch.cost.halted) {
    console.warn(`[oracle] COST CEILING HIT — batch halted at $${batch.cost.estimatedUsd.toFixed(2)} (ceiling $${batch.cost.ceilingUsd?.toFixed(2)})`);
  }

  // ── SportyBet booking (off by default; never blocks delivery) ──────────────
  const summary = summarizeBatch(batch);
  if (env['ENABLE_SPORTYBET_BOOKING'] === 'true' && summary.actionable.length > 0) {
    try {
      const { bookAccumulator } = await import('@oracle/booking');
      const booking = await bookAccumulator(summary.actionable);
      if (booking.code) {
        summary.bookingCode = booking.code;
        summary.bookingLoadUrl = booking.loadUrl ?? undefined;
        summary.bookingUnmatched = booking.unmatched;
        console.log(`[oracle] SportyBet acca booked → ${booking.code} (total odds ${booking.totalOdds})`);
        if (booking.loadUrl) console.log(`[oracle] Load URL: ${booking.loadUrl}`);
        if (booking.unmatched.length) {
          console.warn(`[oracle] ${booking.unmatched.length} pick(s) unmatched on SportyBet: ${booking.unmatched.map(p => `${p.home} vs ${p.away}`).join(', ')}`);
        }
      } else {
        summary.bookingError = booking.error ?? 'no code returned';
        console.warn(`[oracle] SportyBet booking produced no code: ${summary.bookingError}`);
      }
    } catch (err) {
      summary.bookingError = err instanceof Error ? err.message : String(err);
      console.warn(`[oracle] Booking stage failed (non-fatal): ${summary.bookingError}`);
    }
  }

  // Push actionable picks (+ booking code if available) to configured channels
  const notifiers = buildNotifiers(env);
  if (notifiers.length) {
    await notifyAll(notifiers, summary);
  }

  await storage.close();
}

// ── Resolve yesterday (14:00) ────────────────────────────────────────────────

async function resolveYesterdayFixtures(): Promise<void> {
  if (!config.footballDataApiKey) {
    console.warn('[oracle] No FOOTBALL_DATA_API_KEY — skipping resolution');
    return;
  }

  console.log(`[oracle] Resolution run — ${new Date().toISOString()}`);
  const storage = new GBrainAdapter(DB_PATH);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const { candidates, resolved, unmatched } = await resolveDay(
    storage,
    { footballDataApiKey: config.footballDataApiKey, oddsApiKey: config.oddsApiKey, geminiApiKey: config.geminiApiKey },
    yesterday,
  );

  if (!candidates) {
    console.log(`[oracle] No records to resolve for ${yesterday}`);
  } else if (resolved.length) {
    console.log(`[oracle] Wrote ${resolved.length} resolution records (${unmatched.length} unmatched)`);
  } else {
    console.warn(`[oracle] No fixtures resolved — ${unmatched.length} unmatched`);
  }

  await storage.close();
}

// ── Cron schedule ─────────────────────────────────────────────────────────────

console.log('[oracle] Worker started. Scheduled: scrape@00:00/06:00/11:45, batch+scrape@09:00, resolve@14:00 (local time)');

// Fixture scrape — standalone runs (12am, 6am, 11:45am)
cron.schedule('0 0 * * *',  () => { scrapeFixtures().catch(e => console.error('[oracle] Scrape error:', e)); });
cron.schedule('0 6 * * *',  () => { scrapeFixtures().catch(e => console.error('[oracle] Scrape error:', e)); });
cron.schedule('45 11 * * *',() => { scrapeFixtures().catch(e => console.error('[oracle] Scrape error:', e)); });

// Daily batch (09:00) — scrapeFixtures() runs as its first step
cron.schedule('0 9 * * *', () => {
  runDailyBatch('scheduled').catch(e => console.error('[oracle] Batch error:', e));
});

cron.schedule('0 14 * * *', () => {
  resolveYesterdayFixtures().catch(e => console.error('[oracle] Resolution error:', e));
});

if (process.argv.includes('--run-now')) {
  runDailyBatch('manual')
    .then(() => resolveYesterdayFixtures())
    .catch(e => { console.error(e); process.exit(1); });
}
