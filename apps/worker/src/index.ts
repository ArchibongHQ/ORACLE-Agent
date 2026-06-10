/** ORACLE scheduled worker — thin cron shell.
 *  node-cron daily batch (09:00) + resolve-yesterday (14:00).
 *  All analysis/fixture/report logic lives in @oracle/runtime; this file only schedules. */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sendPuntPrompt } from "@oracle/bot";
import type { RunManifest } from "@oracle/engine";
import { buildNotifiers, notifyAll, summarizeBatch } from "@oracle/notify";
import {
  buildConfig,
  fetchTodaysFixtures,
  loadEnv,
  markPrompted,
  resolveDay,
  runAnalysis,
  shouldReprompt,
} from "@oracle/runtime";
import { GBrainAdapter } from "@oracle/storage";
import cron from "node-cron";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");

const env = loadEnv(join(ROOT, ".env"));
const config = buildConfig(env);
const DB_PATH = join(ROOT, ".tmp/gbrain");

// ── Job logging + heartbeat ───────────────────────────────────────────────────
// Every cron job runs through logJob so a failure is always visible in the log,
// and successful batch/resolve runs stamp .tmp/worker_heartbeat.json (read by
// the web /health endpoint) so a silently-dead worker is detectable.

const HEARTBEAT_FILE = join(ROOT, ".tmp", "worker_heartbeat.json");

function writeHeartbeat(event: string, detail: Record<string, unknown> = {}): void {
  try {
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(readFileSync(HEARTBEAT_FILE, "utf8")) as Record<string, unknown>;
    } catch {
      /* first write or corrupt file — start fresh */
    }
    current[event] = { at: new Date().toISOString(), ...detail };
    writeFileSync(HEARTBEAT_FILE, JSON.stringify(current, null, 2), "utf8");
  } catch (err) {
    process.stderr.write(`[worker] heartbeat write failed: ${String(err)}\n`);
  }
}

function logJob(name: string, fn: () => Promise<unknown>): void {
  const started = Date.now();
  process.stdout.write(`[worker] ${new Date().toISOString()} ${name}: start\n`);
  fn()
    .then(() => {
      const s = ((Date.now() - started) / 1000).toFixed(1);
      process.stdout.write(`[worker] ${new Date().toISOString()} ${name}: ok in ${s}s\n`);
    })
    .catch((err: unknown) => {
      const s = ((Date.now() - started) / 1000).toFixed(1);
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(
        `[worker] ${new Date().toISOString()} ${name}: FAILED after ${s}s — ${msg}\n`
      );
    });
}

// ── Fixture scraper ───────────────────────────────────────────────────────────

function scrapeFixtures(): Promise<number> {
  const python = process.platform === "win32" ? "python" : "python3";
  const script = join(ROOT, "tools", "scrape_fixtures.py");
  return new Promise((resolve) => {
    execFile(python, [script], { cwd: ROOT }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) process.stderr.write(`scrape_fixtures error: ${err.message}\n`);
      // Parse sportybet count from playwright summary line, e.g. "sportybet:12"
      const m = stdout.match(/sportybet:(\d+)/);
      resolve(m ? parseInt(m[1], 10) : 0);
    });
  });
}

// ── Lineup fetcher (API-Football, pre-batch) ─────────────────────────────────
// Best-effort: fetch_lineups.py writes .tmp/oracle-store/oracle_lineups.json,
// which enrichWithLineups (runtime) merges into softContext. Never blocks batch.

function fetchLineups(): Promise<void> {
  if (!config.apiFootballKey) return Promise.resolve();
  const python = process.platform === "win32" ? "python" : "python3";
  const script = join(ROOT, "tools", "fetch_lineups.py");
  return new Promise((resolve) => {
    execFile(python, [script], { cwd: ROOT }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) process.stderr.write(`fetch_lineups error: ${err.message}\n`);
      resolve(); // lineup fetch failure must never abort the batch
    });
  });
}

// ── SportyBet streak tracker ──────────────────────────────────────────────────

const STREAK_FILE = join(ROOT, ".tmp", "sportybet_streak.json");
const WORKFLOW_DOC = join(ROOT, "workflows", "scrape_fixtures.md");
const STREAK_THRESHOLD = 2;

function readStreak(): number {
  try {
    if (!existsSync(STREAK_FILE)) return 0;
    const data = JSON.parse(readFileSync(STREAK_FILE, "utf8")) as { streak?: number };
    return typeof data.streak === "number" ? data.streak : 0;
  } catch {
    return 0;
  }
}

function writeStreak(streak: number): void {
  try {
    writeFileSync(STREAK_FILE, JSON.stringify({ streak }), "utf8");
  } catch (_err) {}
}

function promoteSportyBetStatus(): void {
  try {
    const doc = readFileSync(WORKFLOW_DOC, "utf8");
    // Only rewrite if still marked Partial — idempotent
    if (!doc.includes("⚠️ Partial | WAT (UTC+1)")) return;
    const updated = doc.replace("⚠️ Partial | WAT (UTC+1)", "✅ Working | WAT (UTC+1)");
    writeFileSync(WORKFLOW_DOC, updated, "utf8");
  } catch (_err) {}
}

function checkSportyBetStreak(sportyBetCount: number): void {
  // Skip once already promoted
  try {
    const doc = readFileSync(WORKFLOW_DOC, "utf8");
    if (doc.includes("✅ Working | WAT (UTC+1)")) return;
  } catch {
    return;
  }

  const streak = sportyBetCount > 0 ? readStreak() + 1 : 0;
  writeStreak(streak);

  if (streak >= STREAK_THRESHOLD) {
    promoteSportyBetStatus();
    writeStreak(0); // reset — no further tracking needed
  }
}

// ── Weekly Kaggle dataset refresh (Saturday 03:00 UTC) ────────────────────────

function runKaggleTool(label: string, scriptName: string, args: string[] = []): Promise<void> {
  const python = process.platform === "win32" ? "python" : "python3";
  const script = join(ROOT, "tools", scriptName);
  const start = Date.now();
  process.stdout.write(`[kaggle-refresh] ${label}: starting\n`);
  return new Promise((resolve) => {
    execFile(python, [script, ...args], { cwd: ROOT }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (err) {
        process.stderr.write(
          `[kaggle-refresh] ${label}: FAILED after ${elapsed}s — ${err.message}\n`
        );
      } else {
        process.stdout.write(`[kaggle-refresh] ${label}: done in ${elapsed}s\n`);
      }
      resolve(); // always resolve — one failure must not abort the rest
    });
  });
}

async function runWeeklyKaggleRefresh(): Promise<void> {
  const credPath =
    process.platform === "win32"
      ? join(process.env["USERPROFILE"] ?? "", ".kaggle", "kaggle.json")
      : join(process.env["HOME"] ?? "", ".kaggle", "kaggle.json");
  const hasEnvAuth = Boolean(process.env["KAGGLE_USERNAME"]) && Boolean(process.env["KAGGLE_KEY"]);
  if (!existsSync(credPath) && !hasEnvAuth) {
    process.stderr.write(
      `[kaggle-refresh] WARNING: no Kaggle credentials found (checked ${credPath} and KAGGLE_USERNAME/KAGGLE_KEY) — downloads will fail\n`
    );
  }

  process.stdout.write("[kaggle-refresh] === weekly refresh start ===\n");
  const wall = Date.now();

  await runKaggleTool("odds_timeseries", "fetch_odds_timeseries.py", [
    "--btb-dir",
    ".tmp/kaggle/beat-the-bookie",
    "--ah-dir",
    ".tmp/kaggle/ah-odds",
  ]);
  await runKaggleTool("spi", "fetch_spi.py");
  await runKaggleTool("fbref", "fetch_fbref.py");
  await runKaggleTool("transfermarkt", "fetch_transfermarkt.py", [
    "--player-scores-dir",
    ".tmp/kaggle/player-scores",
  ]);
  await runKaggleTool("xg", "fetch_xg.py", ["--kaggle-ppda-dir", ".tmp/kaggle/xg-ppda"]);

  const total = ((Date.now() - wall) / 1000).toFixed(1);
  process.stdout.write(`[kaggle-refresh] === weekly refresh complete in ${total}s ===\n`);
}

// ── Daily batch (09:00) ───────────────────────────────────────────────────────

async function runDailyBatch(trigger: RunManifest["trigger"] = "scheduled"): Promise<void> {
  const sportyBetCount = await scrapeFixtures();
  checkSportyBetStreak(sportyBetCount);
  await fetchLineups();
  const storage = new GBrainAdapter(DB_PATH);

  const newsKey = config.enableNewsIntel ? config.perplexityApiKey : undefined;
  const { jobs, source: _source } = await fetchTodaysFixtures(
    config.oddsApiKey,
    true,
    config.geminiApiKey,
    config.footballDataApiKey,
    newsKey,
    config.oddsPapiKey,
    config.apiFootballKey
  );

  if (!jobs.length) {
    await storage.close();
    return;
  }

  const { batch, records, reportPath } = await runAnalysis(
    jobs,
    { storage, config },
    {
      trigger,
      batchOptions: {
        onProgress: ({ completed, total, current }) => {
          if (current) process.stdout.write(`[batch] ${completed}/${total}: ${current}\n`);
        },
      },
    }
  );

  if (records.length > 0) process.stdout.write(`[batch] ${records.length} records persisted\n`);
  if (reportPath) process.stdout.write(`[batch] report: ${reportPath}\n`);
  if (batch.cost.halted)
    process.stderr.write("[batch] WARNING: cost cap halted the batch before completion\n");

  // ── SportyBet booking (off by default; never blocks delivery) ──────────────
  const summary = summarizeBatch(batch);
  if (env.ENABLE_SPORTYBET_BOOKING === "true" && summary.actionable.length > 0) {
    try {
      const { bookAccumulator } = await import("@oracle/booking");
      const booking = await bookAccumulator(summary.actionable);
      if (booking.code) {
        summary.bookingCode = booking.code;
        summary.bookingLoadUrl = booking.loadUrl ?? undefined;
        summary.bookingUnmatched = booking.unmatched;
        if (booking.loadUrl)
          process.stdout.write(`[booking] ${booking.code}: ${booking.loadUrl}\n`);
        if (booking.unmatched.length)
          process.stderr.write(
            `[booking] ${booking.unmatched.length} pick(s) unmatched on SportyBet\n`
          );
      } else {
        summary.bookingError = booking.error ?? "no code returned";
      }
    } catch (err) {
      summary.bookingError = err instanceof Error ? err.message : String(err);
    }
  }

  // Push actionable picks (+ booking code if available) to configured channels
  const notifiers = buildNotifiers(env);
  if (notifiers.length) {
    await notifyAll(notifiers, summary);
  }

  writeHeartbeat("lastBatch", {
    trigger,
    fixtures: jobs.length,
    records: records.length,
    halted: batch.cost.halted,
  });
  await storage.close();
}

// ── Resolve yesterday (14:00) ────────────────────────────────────────────────

async function resolveYesterdayFixtures(): Promise<void> {
  if (!config.footballDataApiKey) {
    process.stderr.write("[resolve] skipped — FOOTBALL_DATA_API_KEY not set\n");
    return;
  }
  const storage = new GBrainAdapter(DB_PATH);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const { candidates, resolved, unmatched } = await resolveDay(
    storage,
    {
      footballDataApiKey: config.footballDataApiKey,
      oddsApiKey: config.oddsApiKey,
      geminiApiKey: config.geminiApiKey,
    },
    yesterday
  );

  if (!candidates) {
    process.stdout.write(`[resolve] ${yesterday}: no candidate records\n`);
  } else {
    process.stdout.write(
      `[resolve] ${yesterday}: ${resolved.length}/${candidates} resolved, ${unmatched.length} unmatched\n`
    );
  }

  writeHeartbeat("lastResolve", { date: yesterday, candidates, resolved: resolved.length });
  await storage.close();
}

// ── Punt prompt (10:00, retry 12:00 / 13:00 until fulfilled) ──────────────────
// At 10:00 prompt unconditionally; at 12:00/13:00 only re-prompt if the user hasn't
// yet supplied a code (markFulfilled is called by the bot/web when a code is processed).

async function sendDailyPuntPrompt(retry: boolean): Promise<void> {
  if (retry && !shouldReprompt(ROOT)) return; // already fulfilled today
  markPrompted(ROOT);
  await sendPuntPrompt();
}

// Fixture scrape — standalone runs (12am, 6am, 11:45am)
cron.schedule("0 0 * * *", () => logJob("scrape-fixtures@00:00", scrapeFixtures));
cron.schedule("0 6 * * *", () => logJob("scrape-fixtures@06:00", scrapeFixtures));
cron.schedule("45 11 * * *", () => logJob("scrape-fixtures@11:45", scrapeFixtures));

// Daily batch (09:00) — scrapeFixtures() runs as its first step
cron.schedule("0 9 * * *", () => logJob("daily-batch", () => runDailyBatch("scheduled")));

cron.schedule("0 14 * * *", () => logJob("resolve-yesterday", resolveYesterdayFixtures));

// Weekly Kaggle refresh — Saturday 03:00 UTC
cron.schedule("0 3 * * 6", () => logJob("kaggle-refresh", runWeeklyKaggleRefresh));

// Punt prompt — 10:00 (first), 12:00 + 13:00 (retry only if no code received yet)
cron.schedule("0 10 * * *", () => logJob("punt-prompt", () => sendDailyPuntPrompt(false)));
cron.schedule("0 12 * * *", () => logJob("punt-prompt-retry", () => sendDailyPuntPrompt(true)));
cron.schedule("0 13 * * *", () => logJob("punt-prompt-retry", () => sendDailyPuntPrompt(true)));

// Graceful shutdown — stop cron schedules so the daemon exits cleanly under SIGINT/SIGTERM.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    process.stdout.write(`[worker] ${sig} received — stopping cron schedules\n`);
    for (const task of cron.getTasks().values()) task.stop();
    process.exit(0);
  });
}

if (process.argv.includes("--run-now")) {
  runDailyBatch("manual")
    .then(() => resolveYesterdayFixtures())
    .catch((err: unknown) => {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`[worker] --run-now FAILED — ${msg}\n`);
      process.exit(1);
    });
}

if (process.argv.includes("--refresh-kaggle")) {
  runWeeklyKaggleRefresh().catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[worker] --refresh-kaggle FAILED — ${msg}\n`);
    process.exit(1);
  });
}
