/** ORACLE scheduled worker — thin cron shell.
 *  node-cron: acquire-daily@00:00 -> goals-batch immediately after (independent
 *  discovery funnel over the full SportyBet pool) -> daily all-markets batch
 *  @06:00 (independent) -> resolve-yesterday @14:00.
 *  All analysis/fixture/report logic lives in @oracle/runtime; this file only schedules. */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sendPuntPrompt } from "@oracle/bot";
import type { BatchResult, RunManifest } from "@oracle/engine";
import type { ActionablePick, BatchSummary } from "@oracle/notify";
import {
  buildAnalysisModelNote,
  buildNotifiers,
  notifyAll,
  sendTelegramDocument,
  summarizeBatch,
} from "@oracle/notify";
import {
  buildConfig,
  enrichWithH2H,
  enrichWithLineups,
  enrichWithNewsIntel,
  fetchTodaysFixtures,
  findSidecarDetail,
  fixturesPartitionExists,
  type GoalsSelectionResult,
  generateAndWriteDailyFixtureReport,
  loadEnv,
  loadSportyBetIndex,
  markPrompted,
  resolveDay,
  runAnalysis,
  runGoalsFunnel,
  selectGoalsAccumulator,
  shouldReprompt,
  sidecarKey,
  writeGoalsArtifact,
} from "@oracle/runtime";
import { MemoryAdapter } from "@oracle/storage";
import cron from "node-cron";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");

const env = loadEnv(join(ROOT, ".env"));
const config = buildConfig(env);
const STORE_PATH = join(ROOT, ".tmp/oracle-store");

// One-shot CLI mode: any of these flags runs a single job and exits, instead of
// starting the cron daemon. Detected up front so the cron schedules below are
// skipped — otherwise the registered timers keep the event loop alive forever
// and the process hangs after the job finishes (looking like a timeout).
const ONE_SHOT_FLAGS = [
  "--run-now",
  "--run-goals-now",
  "--refresh-kaggle",
  "--run-resolve",
  "--run-acquire-now",
] as const;
const IS_ONE_SHOT = process.argv.some((a) => ONE_SHOT_FLAGS.includes(a as never));

// Run a single async job to completion, then flush stdio and exit deterministically.
// Flushing matters because stdout to a pipe (non-TTY parent) is async-buffered on
// some platforms. Use exitCode + natural exit rather than a bare process.exit():
// on Windows, calling process.exit() while undici's keep-alive sockets from a
// just-completed fetch() are mid-teardown trips a libuv assertion
// (`!(handle->flags & UV_HANDLE_CLOSING)`, src/win/async.c:94). Nothing else keeps
// the event loop alive in one-shot mode (cron timers are gated behind IS_ONE_SHOT),
// so setting exitCode and returning lets Node exit on its own once handles settle.
async function runOnce(label: string, job: () => Promise<void>): Promise<void> {
  try {
    await job();
    await flushStdio();
    process.exitCode = 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[worker] ${label} FAILED — ${msg}\n`);
    await flushStdio();
    process.exitCode = 1;
  }
}

// Resolve once both stdout and stderr have drained their write buffers.
function flushStdio(): Promise<void> {
  const drain = (s: NodeJS.WriteStream): Promise<void> =>
    s.writableLength === 0 ? Promise.resolve() : new Promise((r) => s.write("", () => r()));
  return Promise.all([drain(process.stdout), drain(process.stderr)]).then(() => undefined);
}

// ── Job logging + heartbeat ───────────────────────────────────────────────────
// Every cron job runs through logJob so a failure is always visible in the log,
// and successful batch/resolve runs stamp .tmp/worker_heartbeat.json (read by
// the web /health endpoint) so a silently-dead worker is detectable.

const HEARTBEAT_FILE = join(ROOT, ".tmp", "worker_heartbeat.json");
const BOT_HEARTBEAT_FILE = join(ROOT, ".tmp", "bot_heartbeat.json");

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

// Staleness alert: catches two distinct failure modes —
// (a) called once at startup, it flags "the daemon itself was dead" (the previous
//     process's lastBatch is already stale by the time a fresh process starts — this
//     is exactly what happened 2026-06-18→06-20, caught only by manual inspection);
// (b) called hourly while running, it flags "the daemon is alive but lastBatch hasn't
//     advanced" (a job silently hanging/erroring without tripping logJob's catch).
// It cannot detect "the daemon process itself has since died" from inside that same
// process — that requires an external watchdog (e.g. a Windows Service supervisor),
// which is a separate, larger change.
const HEARTBEAT_STALE_MS = 36 * 60 * 60 * 1000; // 36h — daily batch + some slack
let lastStaleAlertSentAt = 0;
const STALE_ALERT_REPEAT_MS = 12 * 60 * 60 * 1000; // don't re-alert more than every 12h

// Daily-batch back-online trigger: the 06:00 cron slot is a single point in
// time — if the worker process is mid-restart at exactly that minute (Servy
// auto-restart, machine sleep/wake, etc.) the whole day's run is silently
// skipped with no catch-up, unlike acquireDailyJob below which retries on
// every hourly tick until it succeeds. Confirmed in practice: 2026-06-25
// through 06-28 all missed the 06:00 slot, leaving oracle-{date}.html and the
// booking-eligible picks stale for days. Mirrors isLakeFreshForToday/
// LAKE_TRIGGER_REPEAT_MS below, but keyed off lastBatch instead of lastAcquire.
const DAILY_BATCH_STALE_MS = 20 * 60 * 60 * 1000; // ~20h — same-day batch is always fresher than this
let lastDailyBatchTriggerAt = 0;
const DAILY_BATCH_TRIGGER_REPEAT_MS = 6 * 60 * 60 * 1000; // don't retry a failing batch more than every 6h

function isDailyBatchFreshForToday(lastBatchAt: string | undefined): boolean {
  if (!lastBatchAt) return false;
  if (lastBatchAt.slice(0, 10) !== new Date().toISOString().slice(0, 10)) return false;
  return Date.now() - new Date(lastBatchAt).getTime() < DAILY_BATCH_STALE_MS;
}

// Lake-staleness back-online trigger: unlike the alert above, this actively
// re-runs acquisition rather than just notifying — so a daemon that was down
// across 00:00 catches up as soon as it restarts, instead of waiting for
// tomorrow's cron slot.
const LAKE_STALE_MS = 20 * 60 * 60 * 1000; // ~20h — same-day acquisition is always fresher than this
let lastLakeTriggerAt = 0;
const LAKE_TRIGGER_REPEAT_MS = 6 * 60 * 60 * 1000; // don't retry a failing acquisition more than every 6h

function readLastAcquire(): { at?: string; date?: string } | undefined {
  try {
    const current = JSON.parse(readFileSync(HEARTBEAT_FILE, "utf8")) as Record<
      string,
      { at?: string; date?: string } | undefined
    >;
    return current.lastAcquire;
  } catch {
    return undefined;
  }
}

/** True when today's Parquet-lake partition was written by a successful
 *  acquireDailyJob run within the last LAKE_STALE_MS — gates both the 06:00
 *  batch's gap-fill scrape and the back-online trigger below. */
function isLakeFreshForToday(): boolean {
  const lastAcquire = readLastAcquire();
  if (!lastAcquire?.date || !lastAcquire.at) return false;
  if (lastAcquire.date !== new Date().toISOString().slice(0, 10)) return false;
  if (Date.now() - new Date(lastAcquire.at).getTime() >= LAKE_STALE_MS) return false;
  // Heartbeat alone can lie if the lake directory was deleted/moved after a
  // successful acquisition stamped it — confirm the partition is still on disk.
  return fixturesPartitionExists(lastAcquire.date);
}

async function checkHeartbeatFreshness(): Promise<void> {
  let lastBatchAt: string | undefined;
  try {
    const current = JSON.parse(readFileSync(HEARTBEAT_FILE, "utf8")) as Record<
      string,
      { at?: string } | undefined
    >;
    lastBatchAt = current.lastBatch?.at;
  } catch {
    return; // no heartbeat file yet — nothing to compare against
  }

  // Checked before any lastBatch-related early return below, so a healthy
  // lastBatch never short-circuits this independent trigger.
  if (!isLakeFreshForToday() && Date.now() - lastLakeTriggerAt >= LAKE_TRIGGER_REPEAT_MS) {
    lastLakeTriggerAt = Date.now();
    process.stdout.write(
      "[worker] daily lake stale/missing — triggering back-online acquisition\n"
    );
    // After back-online acquisition completes, send the fixture report and fire the
    // goals batch immediately so a machine that was off across 00:00/09:30 WAT still
    // gets the report + picks as soon as it comes up — mirrors the 00:00 cron sequence.
    logJob("acquire-daily@back-online", async () => {
      await acquireDailyJob();
      await sendDailyFixtureReport();
      await runGoalsBatch("scheduled");
    });
  }

  // Same back-online pattern for the engine-decision daily batch — see
  // DAILY_BATCH_STALE_MS comment above for why this is needed independently
  // of the lake/acquire trigger above.
  if (
    !isDailyBatchFreshForToday(lastBatchAt) &&
    Date.now() - lastDailyBatchTriggerAt >= DAILY_BATCH_TRIGGER_REPEAT_MS
  ) {
    lastDailyBatchTriggerAt = Date.now();
    process.stdout.write(
      "[worker] daily batch stale/missing for today — triggering back-online run\n"
    );
    logJob("daily-batch@back-online", () => runDailyBatch("scheduled"));
  }

  if (!lastBatchAt) return;

  const ageMs = Date.now() - new Date(lastBatchAt).getTime();
  if (ageMs < HEARTBEAT_STALE_MS) return;
  if (Date.now() - lastStaleAlertSentAt < STALE_ALERT_REPEAT_MS) return;
  lastStaleAlertSentAt = Date.now();

  const ageHours = (ageMs / 3_600_000).toFixed(1);
  process.stderr.write(`[worker] STALE — lastBatch was ${ageHours}h ago (${lastBatchAt})\n`);

  const notifiers = buildNotifiers(env);
  if (!notifiers.length) return;
  const alertSummary: BatchSummary = {
    date: new Date().toISOString().slice(0, 10),
    analysed: 0,
    actionableCount: 0,
    errors: 0,
    actionable: [],
    alertText: `daily batch hasn't run in ${ageHours}h (last: ${lastBatchAt}) — worker may be down`,
  };
  await notifyAll(notifiers, alertSummary);
}

// Cross-service staleness: the worker is the one daemon guaranteed to be running
// (it's the one with this check), so it also watches the Telegram bot's heartbeat
// (apps/bot/src/index.ts writeBotHeartbeat() — written after each successful
// getUpdates poll cycle, every ~50s normally). Sending the alert itself does NOT
// depend on the bot's poll loop: Telegram's sendMessage works from any process
// holding the token, so this can reach the owner even while the bot is down.
const BOT_HEARTBEAT_STALE_MS = 10 * 60 * 1000; // 10 min — generous vs. the ~50s poll cadence
let lastBotStaleAlertSentAt = 0;
const BOT_STALE_ALERT_REPEAT_MS = 60 * 60 * 1000; // re-alert hourly while still down (more urgent than the daily batch)

async function checkBotHeartbeatFreshness(): Promise<void> {
  let lastPollAt: string | undefined;
  let missing = false;
  try {
    const current = JSON.parse(readFileSync(BOT_HEARTBEAT_FILE, "utf8")) as { at?: string };
    lastPollAt = current.at;
    if (!lastPollAt) missing = true;
  } catch {
    missing = true; // never started, or the file was removed — also worth alerting on
  }

  const ageMs = missing ? Infinity : Date.now() - new Date(lastPollAt!).getTime();
  if (!missing && ageMs < BOT_HEARTBEAT_STALE_MS) return; // healthy — nothing to do
  if (Date.now() - lastBotStaleAlertSentAt < BOT_STALE_ALERT_REPEAT_MS) return;
  lastBotStaleAlertSentAt = Date.now();

  const detail = missing
    ? "no heartbeat recorded (bot never started, or .tmp/bot_heartbeat.json is missing)"
    : `last successful poll was ${(ageMs / 60_000).toFixed(0)}m ago (${lastPollAt})`;
  process.stderr.write(`[worker] BOT STALE — ${detail}\n`);

  const notifiers = buildNotifiers(env);
  if (!notifiers.length) return;
  const alertSummary: BatchSummary = {
    date: new Date().toISOString().slice(0, 10),
    analysed: 0,
    actionableCount: 0,
    errors: 0,
    actionable: [],
    alertText: `Telegram bot appears offline — ${detail}. Incoming commands (/run, /punt, /confirm, etc.) won't work until it's restarted.`,
  };
  await notifyAll(notifiers, alertSummary);
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

// ── Python interpreter resolution ────────────────────────────────────────────
// A bare "python"/"python3" relies on PATH resolution, which a Windows service
// host does not inherit the same way an interactive shell does (the install is
// only on this user's PATH, not the machine PATH) — causing a silent spawn
// ENOENT under Servy while working fine from a terminal. Resolve an absolute
// path up front so the scrapers/tools run identically in both contexts.
const PYTHON_BIN = resolvePythonBin();

function resolvePythonBin(): string {
  if (process.env.PYTHON_BIN && existsSync(process.env.PYTHON_BIN)) return process.env.PYTHON_BIN;
  if (process.platform === "win32") {
    const candidates = [
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python313", "python.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Python", "bin", "python.exe"),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    return "python"; // fall back to PATH resolution (works in an interactive shell)
  }
  return "python3";
}

// ── Fixture scraper ───────────────────────────────────────────────────────────

function scrapeFixtures(): Promise<number> {
  const python = PYTHON_BIN;
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
  const python = PYTHON_BIN;
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

// ── Daily acquisition (Parquet lake) ─────────────────────────────────────────
// tools/acquire_daily.py wraps the same SportyBet/Gismo scrape as scrapeFixtures()
// above, additionally writing the date-partitioned Parquet lake
// (.tmp/oracle-daily/) that packages/runtime/src/dailyStore.ts reads — the
// latency seam: a fresh lake lets fetchTodaysFixtures skip the live odds chain.
// It still writes the legacy JSON sidecar, so deleting the lake degrades back
// to today's exact existing behavior.

// Shared in-flight guard: acquireDailyJob (00:00 cron + back-online trigger)
// and runDailyBatch's gap-fill call both invoke acquireDaily() independently,
// gated by the same isLakeFreshForToday() check — if the 00:00 run is still
// in progress (or just failed) when the hourly/06:00 triggers fire, they'd
// otherwise spawn a second acquire_daily.py concurrently, the exact
// concurrent-write corruption mode (sportybet_today.json / Parquet
// partitions) this lake was built to avoid. A second caller awaits the
// in-flight run's result instead of starting its own.
let _acquireDailyInFlight: Promise<number> | null = null;

function acquireDaily(): Promise<number> {
  if (_acquireDailyInFlight) return _acquireDailyInFlight;
  const python = PYTHON_BIN;
  const script = join(ROOT, "tools", "acquire_daily.py");
  const run = new Promise<number>((resolve) => {
    execFile(python, [script], { cwd: ROOT }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) process.stderr.write(`acquire_daily error: ${err.message}\n`);
      const m = stdout.match(/acquired:(\d+)/);
      resolve(m ? parseInt(m[1], 10) : 0);
    });
  }).finally(() => {
    _acquireDailyInFlight = null;
  });
  _acquireDailyInFlight = run;
  return run;
}

// News enrichment runs as the second acquisition step (after fixtures land) —
// best-effort, never blocks. This is the ONLY place live news scraping happens:
// enrich_news.py populates the lake/file cache for ALL scraped fixtures here, so
// downstream analysis (the goals pipeline runs cacheOnly) reads pre-enriched data
// and never launches per-fixture live scraping mid-analysis.
function runNewsEnrichment(): Promise<void> {
  if (!config.enableNewsIntel) return Promise.resolve();
  const python = PYTHON_BIN;
  const script = join(ROOT, "tools", "enrich_news.py");
  return new Promise((resolve) => {
    execFile(python, [script], { cwd: ROOT }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) process.stderr.write(`enrich_news error: ${err.message}\n`);
      resolve();
    });
  });
}

/** Full 00:00 acquisition job: scrape -> lake write -> news enrichment ->
 *  heartbeat. Only stamps lastAcquire when fixtures were actually acquired, so
 *  a failed run leaves the lake-staleness check above free to keep retrying
 *  rather than masking the failure with a fresh timestamp. */
async function acquireDailyJob(): Promise<void> {
  const count = await acquireDaily();
  await runNewsEnrichment();
  if (count > 0) {
    writeHeartbeat("lastAcquire", { date: new Date().toISOString().slice(0, 10), fixtures: count });
  }
}

/** Daily raw-fixture-data report (item #5): every SportyBet fixture for the
 *  day + its accompanying odds/stats/lineups/news — independent of engine
 *  selection or the goals funnel. Generated + sent to Telegram as a document
 *  attachment immediately after the 00:00 scrape, before anything else
 *  (goals batch, daily batch) — per owner instruction "trigger immediately
 *  after scrape and before any other thing." Best-effort: a failure here
 *  (missing token, write error) is logged but never blocks the rest of the run. */
async function sendDailyFixtureReport(): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = await generateAndWriteDailyFixtureReport(today, join(ROOT, ".tmp/reports"));
    if (!result) {
      process.stdout.write("[fixture-report] no SportyBet fixtures available — skipping\n");
      return;
    }
    process.stdout.write(`[fixture-report] wrote ${result.path}\n`);

    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      await sendTelegramDocument(
        env.TELEGRAM_BOT_TOKEN,
        env.TELEGRAM_CHAT_ID,
        result.path,
        `ORACLE daily fixtures — ${today} (${result.fixtureCount} fixtures)`
      );
    }
  } catch (err) {
    process.stderr.write(
      `[fixture-report] FAILED — ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
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
  const python = PYTHON_BIN;
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
      ? join(process.env.USERPROFILE ?? "", ".kaggle", "kaggle.json")
      : join(process.env.HOME ?? "", ".kaggle", "kaggle.json");
  const hasEnvAuth = Boolean(process.env.KAGGLE_USERNAME) && Boolean(process.env.KAGGLE_KEY);
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
  // build_xg_table MUST run AFTER both fetch_fbref (adds xG columns) and fetch_xg
  // (Understat per-match CSVs) — it merges both into the rolling team-xG prior,
  // Understat winning on collisions, FBref extending coverage to WC/Brazil/etc.
  await runKaggleTool("xg-table", "build_xg_table.py");
  // Static venue table for the travel-friction + altitude engine features.
  await runKaggleTool("travel", "fetch_travel.py");

  const total = ((Date.now() - wall) / 1000).toFixed(1);
  process.stdout.write(`[kaggle-refresh] === weekly refresh complete in ${total}s ===\n`);
}

// ── Daily batch (06:00) ───────────────────────────────────────────────────────

/** Returns the analyzed batch, or null when there were no fixtures to analyze.
 *  The goals pipeline (runGoalsBatch) is fully independent of this batch as of
 *  the 2026-06-24 rewrite — it no longer sources picks from this batch's output. */
async function runDailyBatch(
  trigger: RunManifest["trigger"] = "scheduled"
): Promise<BatchResult | null> {
  if (isLakeFreshForToday()) {
    process.stdout.write("[batch] daily lake fresh — skipping gap-fill scrape\n");
  } else {
    process.stdout.write("[batch] daily lake missing/stale — running gap-fill acquisition\n");
    await acquireDaily();
  }
  await fetchLineups();
  const storage = new MemoryAdapter(STORE_PATH);

  // News intel runs when enabled; Perplexity key optional (Gemini AI-Mode fallback covers it).
  const newsKey = config.enableNewsIntel ? config.perplexityApiKey : undefined;
  const newsStorage = config.enableNewsIntel ? storage : undefined;
  const { jobs, source: _source } = await fetchTodaysFixtures(
    config.oddsApiKey,
    config.enableWebSearchOddsFallback,
    config.geminiApiKey,
    config.footballDataApiKey,
    newsKey,
    config.sharpApiIoKey,
    config.apiFootballKey,
    config.oddsApiIoKey,
    config.oddsPapiKey,
    config.sportsGameOddsKey,
    config.maxFixturesPerRun,
    newsStorage,
    config.webOddsMinConsensus,
    config.webOddsVarianceThreshold
  );

  if (!jobs.length) {
    return null;
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
  // resolveEventId looks up the sidecar's eventId for each pick — without it
  // every ActionablePick.eventId is undefined and bookAccumulator skips every leg.
  const sportyIndexForBooking = await loadSportyBetIndex(new Date().toISOString().slice(0, 10));
  const summary = summarizeBatch(batch, undefined, (home, away) =>
    sportyIndexForBooking
      ? findSidecarDetail(sportyIndexForBooking.detailByKey, home, away)?.eventId
      : undefined
  );
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

  return batch;
}

// ── Goals-only accumulator ─────────────────────────────────────────────────────
// As of 2026-06-24 (enhanced 2026-06-25): fully independent pipeline — its own
// SportyBet index read, its own discovery funnel (mechanical pre-filter ->
// Sonnet screen, over the FULL daily fixture pool, not the main batch's top-N),
// its own runAnalysis pass in goals-only-markets mode. selectGoalsAccumulator
// produces FIVE distinct outputs delivered as separate Telegram messages:
//   1. TOP PICKS (short slip, 4-9 legs, EV-maximized)
//   2. 39-LEG LOTTERY (long slip, up to 39 legs, correlation-aware greedy)
//   3. MINI-ACCA (2-4 legs, one per league, highest-edge)
//   4. OUTPUT B (top 5 legs with odds ≥ 4.00, ranked by edge)
//   5. OUTPUT C (top 3 legs with 2.50 ≤ odds < 4.00, ranked by edge)

const TOP_PICKS_TAG = "GOALS — TOP PICKS";
const LOTTERY_TAG = "GOALS — 39-LEG LOTTERY";
const MINI_ACCA_TAG = "GOALS — MINI-ACCA (cross-league, 2-4 legs)";
const OUTPUT_B_TAG = "GOALS — OUTPUT B (odds ≥ 4.00)";
const OUTPUT_C_TAG = "GOALS — OUTPUT C (odds 2.50–3.99)";

/** Builds an LLMCallContext for the Sonnet screening stage (goalsFunnel.ts) —
 *  same shape every other Claude-calling call site in this worker builds inline. */
function buildLlmCtx() {
  return {
    config: {
      claudeApiKey: config.claudeApiKey,
      geminiApiKey: config.geminiApiKey,
      bankroll: config.bankroll,
    },
    requestedAt: new Date().toISOString(),
  };
}

/** One slip → notify/booking cycle. Shared by the top-picks and 39-leg lottery
 *  sends so both go through the identical booking-gate + notify + error-handling
 *  path, just with a different tag/leg-set/combinedProb-odds pair. */
async function sendGoalsSlip(
  legs: GoalsSelectionResult["legs"],
  tag: string,
  date: string,
  analysed: number,
  errorCount: number,
  combinedProb: number,
  combinedOdds: number,
  logPrefix: string
): Promise<BatchSummary> {
  const actionable: ActionablePick[] = legs.map((l) => ({
    home: l.home,
    away: l.away,
    league: l.league,
    kickoff: l.kickoff,
    market: l.market,
    side: l.side,
    odds: l.odds,
    stakePct: 0, // accumulator leg — no per-leg Kelly stake
    confidence: l.mp,
    edge: l.edge,
    ...(l.eventId ? { eventId: l.eventId } : {}),
  }));

  const modelNote =
    actionable.length > 0 ? buildAnalysisModelNote(legs.map((l) => l.decisionModel)) : undefined;

  const summary: BatchSummary = {
    date: `${date} — ${tag}`,
    analysed,
    actionableCount: actionable.length,
    errors: errorCount,
    actionable,
    ...(actionable.length > 0 ? { combinedProb, combinedOdds } : {}),
    ...(modelNote ? { analysisModelNote: modelNote } : {}),
  };

  // ── SportyBet booking (off by default; never blocks delivery) ──────────────
  if (env.ENABLE_SPORTYBET_BOOKING === "true" && actionable.length > 0) {
    try {
      const { bookAccumulator } = await import("@oracle/booking");
      const booking = await bookAccumulator(actionable);
      if (booking.code) {
        summary.bookingCode = booking.code;
        summary.bookingLoadUrl = booking.loadUrl ?? undefined;
        summary.bookingUnmatched = booking.unmatched;
        if (booking.loadUrl)
          process.stdout.write(`[${logPrefix}-booking] ${booking.code}: ${booking.loadUrl}\n`);
        if (booking.unmatched.length)
          process.stderr.write(
            `[${logPrefix}-booking] ${booking.unmatched.length} leg(s) unmatched on SportyBet\n`
          );
      } else {
        summary.bookingError = booking.error ?? "no code returned";
      }
    } catch (err) {
      summary.bookingError = err instanceof Error ? err.message : String(err);
    }
  }

  // Notify — even with 0 legs (sends a "no goals slip today" note; never books empty).
  const notifiers = buildNotifiers(env);
  if (notifiers.length) {
    await notifyAll(notifiers, summary);
  }

  return summary;
}

/** Shared tail: turn a full goals selection into FIVE independent notify/booking
 *  cycles — top picks, 39-leg lottery, mini-ACCA, Output B, Output C. */
async function finalizeGoalsSelection(
  selection: GoalsSelectionResult,
  date: string,
  errorCount: number,
  trigger: RunManifest["trigger"]
): Promise<void> {
  process.stdout.write(
    `[goals] long=${selection.legs.length}/${selection.target} short=${selection.shortSlipLegs.length} ` +
      `miniAcca=${selection.miniAccaLegs.length} outputB=${selection.outputBLegs.length} outputC=${selection.outputCLegs.length} ` +
      `(over15=${selection.counts.over15} over25=${selection.counts.over25} ` +
      `teamover05=${selection.counts.teamOver05}; qualified=${selection.qualified} of ${selection.analysed})\n`
  );

  // 1. Top picks — short, EV-maximized, 4-9 legs (high-confidence bar).
  const topPicks = await sendGoalsSlip(
    selection.shortSlipLegs,
    TOP_PICKS_TAG,
    date,
    selection.analysed,
    errorCount,
    selection.shortSlipCombinedProb,
    selection.shortSlipCombinedOdds,
    "top-picks"
  );

  // 2. Lottery — long slip, up to 39 legs, greedy correlation-aware.
  const lottery = await sendGoalsSlip(
    selection.legs,
    LOTTERY_TAG,
    date,
    selection.analysed,
    errorCount,
    selection.combinedProb,
    selection.combinedOdds,
    "lottery"
  );

  // 3. Mini-ACCA — 2-4 legs, one per league, highest edge (always sent; if <2
  //    legs available the slip arrives as "no picks" rather than being skipped,
  //    consistent with the empty-slip notification pattern above).
  await sendGoalsSlip(
    selection.miniAccaLegs,
    MINI_ACCA_TAG,
    date,
    selection.analysed,
    errorCount,
    selection.miniAccaCombinedProb,
    selection.miniAccaCombinedOdds,
    "mini-acca"
  );

  // 4. Output B — top 5 legs with odds ≥ 4.00 (value/longshot tier).
  if (selection.outputBLegs.length > 0) {
    const bProb = selection.outputBLegs.reduce((acc, l) => acc * l.mp, 1);
    const bOdds = selection.outputBLegs.reduce((acc, l) => acc * l.odds, 1);
    await sendGoalsSlip(
      selection.outputBLegs,
      OUTPUT_B_TAG,
      date,
      selection.analysed,
      errorCount,
      bProb,
      bOdds,
      "output-b"
    );
  }

  // 5. Output C — top 3 legs with 2.50 ≤ odds < 4.00 (mid-range value tier).
  if (selection.outputCLegs.length > 0) {
    const cProb = selection.outputCLegs.reduce((acc, l) => acc * l.mp, 1);
    const cOdds = selection.outputCLegs.reduce((acc, l) => acc * l.odds, 1);
    await sendGoalsSlip(
      selection.outputCLegs,
      OUTPUT_C_TAG,
      date,
      selection.analysed,
      errorCount,
      cProb,
      cOdds,
      "output-c"
    );
  }

  writeHeartbeat("lastGoalsBatch", {
    trigger,
    analysed: selection.analysed,
    topPicksLegs: selection.shortSlipLegs.length,
    lotteryLegs: selection.legs.length,
    miniAccaLegs: selection.miniAccaLegs.length,
    outputBLegs: selection.outputBLegs.length,
    outputCLegs: selection.outputCLegs.length,
    target: selection.target,
    topPicksBooked: Boolean(topPicks.bookingCode),
    lotteryBooked: Boolean(lottery.bookingCode),
  });

  // Persist the full selection so apps/web's /goals route can show it — the
  // pipeline was previously worker -> Telegram/email only, zero web surface.
  try {
    await writeGoalsArtifact(selection, date, join(ROOT, ".tmp/goals"));
  } catch (err) {
    process.stderr.write(
      `[goals] WARN: artifact write failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  }
}

/** The ONLY goals pipeline (2026-06-24 rewrite): independent of the main
 *  all-markets daily batch entirely — its own SportyBet index read, its own
 *  discovery funnel (mechanical pre-filter -> Sonnet screen, goalsFunnel.ts),
 *  its own runAnalysis pass in goals-only-markets mode. Per owner instruction,
 *  the funnel scans the FULL daily SportyBet pool (potentially 1000+ fixtures)
 *  for goals-market opportunity — not whatever subset the main batch happened
 *  to analyze for all markets. Runs as its own cron slot / --run-goals-now
 *  invocation, no longer derived from or chained after the main daily batch. */
async function runGoalsBatch(trigger: RunManifest["trigger"] = "manual"): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  let index = await loadSportyBetIndex(today);
  if (!index) {
    const sportyBetCount = await scrapeFixtures();
    checkSportyBetStreak(sportyBetCount);
    index = await loadSportyBetIndex(today);
  }
  if (!index?.events.length) {
    process.stdout.write("[goals] no SportyBet fixtures available — skipping\n");
    return;
  }

  // Filter to future kickoffs only — mirrors selectFixtures.ts:546-551.
  // Fixtures that have already started (ko ≤ now) cannot be booked; keeping
  // them pollutes the funnel, wastes LLM quota, and can produce stale slips.
  // Fail-open for events with no kickoff_utc (they appear on SportyBet as
  // "TBD" or intra-day entries without a confirmed time — keep them rather
  // than silently dropping potentially valid fixtures).
  const now = new Date();
  const futureEvents = index.events.filter((ev) => {
    if (!ev.kickoff_utc) return true;
    const ko = new Date(ev.kickoff_utc).getTime();
    return Number.isFinite(ko) && ko > now.getTime();
  });
  process.stdout.write(
    `[goals] funnel: ${index.events.length} raw SportyBet fixtures → ${futureEvents.length} future KOs\n`
  );
  if (!futureEvents.length) {
    process.stdout.write("[goals] no future-kickoff fixtures — skipping\n");
    return;
  }
  const funnelResult = await runGoalsFunnel(futureEvents, {
    llmCtx: buildLlmCtx(),
  });
  process.stdout.write(
    `[goals] funnel: preFiltered=${funnelResult.preFilteredCount} converted=${funnelResult.convertedCount}\n`
  );

  if (!funnelResult.jobs.length) {
    process.stdout.write("[goals] funnel produced no analyzable fixtures — skipping\n");
    return;
  }

  const storage = new MemoryAdapter(STORE_PATH);

  // H2H -> news intel (CACHE-ONLY) -> lineups. The goals pipeline consumes news
  // already enriched during the daily-scrape phase (enrich_news.py + the main batch's
  // live acquisition populate the lake / file cache / GBrain). It must NOT launch live
  // per-fixture Playwright/Claude scraping in the middle of its own analysis run —
  // that re-does work the scrape phase already did and serialises a heavy subprocess
  // into the hot path. cacheOnly:true reads lake/file/GBrain only, never the live
  // ensemble. H2H + lineups are local file reads (no live scraping) and stay as-is.
  const withH2H = await enrichWithH2H(funnelResult.jobs, config.footballDataApiKey);
  const withNews = config.enableNewsIntel
    ? await enrichWithNewsIntel(withH2H, { storage, cacheOnly: true })
    : withH2H;
  const enrichedJobs = await enrichWithLineups(withNews);

  const { batch } = await runAnalysis(
    enrichedJobs,
    { storage, config: { ...config, enableGoalsOnlyMode: true } },
    {
      trigger,
      writeReportToDisk: false, // this pipeline's report-equivalent is the goals-ACCA notify itself
      batchOptions: {
        concurrency: 2, // Windows OOM guard — full-parallel (default 8) SIGKILL's the process
        onProgress: ({ completed, total, current }) => {
          if (current) process.stdout.write(`[goals] ${completed}/${total}: ${current}\n`);
        },
      },
    }
  );

  // Build eventId lookup so the booking agent can navigate directly to each
  // fixture's detail page instead of scanning the paginated listing DOM.
  const eventIdByKey = new Map<string, string>();
  for (const ev of index.events) {
    if (ev.eventId) eventIdByKey.set(sidecarKey(ev.home, ev.away), ev.eventId);
  }

  const selection = selectGoalsAccumulator(batch.jobs, {
    minConfidence: config.goalsMinConfidence,
    minImplied: config.goalsMinImplied,
    target: config.goalsTargetLegs,
    detailByKey: index.detailByKey,
    eventIdByKey,
  });

  await finalizeGoalsSelection(selection, batch.date, batch.errorCount, trigger);
}

// ── Resolve yesterday (14:00) ────────────────────────────────────────────────

async function resolveYesterdayFixtures(): Promise<void> {
  // No early-exit on missing keys — CLAUDE.md §6 no-data-blocker: resolveDay's
  // web-search consensus fallback (tools/scrape_match_results.py) always runs on
  // whatever the API chain can't resolve, including when both keys are absent.
  const storage = new MemoryAdapter(STORE_PATH);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const { candidates, resolved, unmatched } = await resolveDay(
    storage,
    {
      footballDataApiKey: config.footballDataApiKey,
      oddsApiKey: config.oddsApiKey,
      geminiApiKey: config.geminiApiKey,
      apiFootballKey: config.apiFootballKey,
    },
    yesterday,
    {
      enabled: config.enableWebSearchResultsFallback,
      minConsensus: config.webResultsMinConsensus,
    }
  );

  if (!candidates) {
    process.stdout.write(`[resolve] ${yesterday}: no candidate records\n`);
  } else {
    process.stdout.write(
      `[resolve] ${yesterday}: ${resolved.length}/${candidates} resolved, ${unmatched.length} unmatched\n`
    );
  }

  writeHeartbeat("lastResolve", { date: yesterday, candidates, resolved: resolved.length });
}

// ── Punt prompt (10:00, retry 12:00 / 13:00 until fulfilled) ──────────────────
// At 10:00 prompt unconditionally; at 12:00/13:00 only re-prompt if the user hasn't
// yet supplied a code (markFulfilled is called by the bot/web when a code is processed).

async function sendDailyPuntPrompt(retry: boolean): Promise<void> {
  if (retry && !shouldReprompt(ROOT)) return; // already fulfilled today
  markPrompted(ROOT);
  await sendPuntPrompt();
}

// Cron daemon — skipped entirely in one-shot CLI mode (see IS_ONE_SHOT above) so a
// single --run-* invocation exits cleanly instead of being held open by these timers.
if (!IS_ONE_SHOT) {
  // Catches "the daemon itself was dead" — the previous process's lastBatch is
  // already stale by the time this fresh process starts (see checkHeartbeatFreshness
  // comment above for the two failure modes this can and can't detect).
  void checkHeartbeatFreshness();
  cron.schedule("0 * * * *", () => void checkHeartbeatFreshness());

  // Bot heartbeat — checked far more often than the daily-batch check (every
  // 10 min vs hourly) since its own staleness threshold is 10 min, not 36h.
  void checkBotHeartbeatFreshness();
  cron.schedule("*/10 * * * *", () => void checkBotHeartbeatFreshness());

  // Daily acquisition (00:00) — Parquet lake + JSON sidecar via acquire_daily.py,
  // then news enrichment. The 06:00 batch below reads this lake first and only
  // falls back to its own gap-fill scrape when it's missing/stale. Per owner
  // instruction, immediately after this scrape — before anything else — the
  // raw fixture-data report is generated+sent, THEN the goals batch runs (its
  // own SportyBet index read, independent of the 06:00 all-markets batch).
  cron.schedule("0 0 * * *", () =>
    logJob("acquire-daily@00:00", async () => {
      await acquireDailyJob();
      await sendDailyFixtureReport();
      await runGoalsBatch("scheduled");
    })
  );

  // Daily SportyBet scrape — 09:30 WAT (= 08:30 UTC). Bookmakers finalise their
  // morning lines and player props by ~09:00 WAT; 09:30 hits after the morning sync
  // completes and avoids the on-the-hour server spike. Back-online: if the machine
  // was off at this slot, checkHeartbeatFreshness fires acquireDailyJob + goals
  // immediately on daemon restart (see LAKE_STALE_MS trigger above).
  cron.schedule("30 8 * * *", () =>
    logJob("acquire-daily@09:30-WAT", async () => {
      await acquireDailyJob();
      await sendDailyFixtureReport();
    })
  );

  // Goals-ACCA trigger — 09:40 WAT (= 08:40 UTC), 10 min after scrape starts.
  // runGoalsBatch reads the SportyBet index written by acquireDailyJob; if the
  // scrape is still in progress (in-flight guard) it waits for it via loadSportyBetIndex
  // fallback + scrapeFixtures() call inside runGoalsBatch itself.
  cron.schedule("40 8 * * *", () =>
    logJob("goals-batch@09:40-WAT", () => runGoalsBatch("scheduled"))
  );

  // Main all-markets daily batch (06:00) — independent of the goals pipeline
  // above (no longer chained/derived). Its internal scrape is gap-fill-only —
  // runDailyBatch only re-acquires when the 00:00 lake is missing/stale (see
  // isLakeFreshForToday).
  cron.schedule("0 6 * * *", () => logJob("daily-batch", () => runDailyBatch("scheduled")));

  cron.schedule("0 14 * * *", () => logJob("resolve-yesterday", resolveYesterdayFixtures));

  // Weekly Kaggle refresh — Saturday 03:00 UTC
  cron.schedule("0 3 * * 6", () => logJob("kaggle-refresh", runWeeklyKaggleRefresh));

  // Punt prompt — 10:00 (first), 12:00 + 13:00 (retry only if no code received yet)
  cron.schedule("0 10 * * *", () => logJob("punt-prompt", () => sendDailyPuntPrompt(false)));
  cron.schedule("0 12 * * *", () => logJob("punt-prompt-retry", () => sendDailyPuntPrompt(true)));
  cron.schedule("0 13 * * *", () => logJob("punt-prompt-retry", () => sendDailyPuntPrompt(true)));
}

// Graceful shutdown — stop cron schedules so the daemon exits cleanly under SIGINT/SIGTERM.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    process.stdout.write(`[worker] ${sig} received — stopping cron schedules\n`);
    for (const task of cron.getTasks().values()) task.stop();
    process.exit(0);
  });
}

if (process.argv.includes("--run-acquire-now")) {
  void runOnce("--run-acquire-now", () => acquireDailyJob());
}

if (process.argv.includes("--run-now")) {
  void runOnce("--run-now", async () => {
    await runDailyBatch("manual");
    await resolveYesterdayFixtures();
  });
}

if (process.argv.includes("--run-goals-now")) {
  void runOnce("--run-goals-now", () => runGoalsBatch("manual"));
}

if (process.argv.includes("--refresh-kaggle")) {
  void runOnce("--refresh-kaggle", () => runWeeklyKaggleRefresh());
}

if (process.argv.includes("--run-resolve")) {
  void runOnce("--run-resolve", () => resolveYesterdayFixtures());
}
