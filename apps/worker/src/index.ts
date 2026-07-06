/** ORACLE scheduled worker — thin cron shell.
 *  node-cron, single morning sequence (WAT = UTC+1): acquire-daily + fixture
 *  report @09:30 WAT -> main all-markets batch @09:35 WAT -> goals-only batch
 *  @09:40 WAT (independent discovery funnel over the full SportyBet pool) ->
 *  resolve-yesterday + punt prompt @10:00 WAT (retries @12:00/13:00 WAT).
 *  All analysis/fixture/report logic lives in @oracle/runtime; this file only schedules. */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sendPuntPrompt } from "@oracle/bot";
import {
  analyzeGoalsFixtureV3,
  type BatchJobResult,
  type BatchResult,
  type FixtureJobSuccess,
  formatSanityFlags,
  type GoalsCrossCheckFn,
  goalsSlateSanityChecks,
  type RunManifest,
  type V3AnalyzeInput,
  type V3FixtureOdds,
  type V3FixtureResult,
  v3NbDispersion,
} from "@oracle/engine";
import type { ActionablePick, BatchSummary } from "@oracle/notify";
import {
  buildAnalysisModelNote,
  buildNotifiers,
  GOALS_V3_RG_NOTE,
  notifyAll,
  sendTelegramDocument,
  sendTelegramText,
  summarizeBatch,
} from "@oracle/notify";
import {
  applySlateVerdicts,
  buildConfig,
  buildGoalsV3Config,
  buildMarketsV3GateConfig,
  buildMarketsV3SlateOutputs,
  classifyEligibility,
  crossCheckGoalsPick,
  curateActionableByV3Outputs,
  DEFAULT_LEDGER_MAX,
  deriveLineHitRates,
  enrichWithH2H,
  enrichWithLineups,
  enrichWithNewsIntel,
  fetchTodaysFixtures,
  findSidecarDetail,
  fixturesPartitionExists,
  formatCalibrationMetrics,
  formatSettlementBreakdown,
  formatSlateGateLog,
  type GoalsSelectionResult,
  generateAndWriteFixtureWorkbook,
  generateAndWriteGoalsWorkbook,
  heightenedTrendsAligned,
  loadEnv,
  loadSportyBetIndex,
  markPrompted,
  ORACLE_PRIORITY_LEAGUES,
  prefilterMarketsV3Jobs,
  resolveDay,
  reviewGoalsSlate,
  runAnalysis,
  runGoalsFunnel,
  SLIP_LABELS,
  type SportyBetEvent,
  type SportyBetEventDetail,
  type SportyBetIndex,
  scoreCompleteness,
  scorePredictabilityV3,
  selectGoalsAccumulator,
  shouldReprompt,
  sidecarKey,
  sportyEventToFixtureJob,
  writeGoalsArtifact,
} from "@oracle/runtime";
import { MemoryAdapter } from "@oracle/storage";
import cron from "node-cron";
import { awaitAcquireOrTimeout, trackAcquireJob } from "./acquireChain.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");

const env = loadEnv(join(ROOT, ".env"));
const config = buildConfig(env);
const goalsV3Config = buildGoalsV3Config(env);
const STORE_PATH = join(ROOT, ".tmp/oracle-store");

// Max fixtures per chunk loop iteration. Priority-sorted fixtures are analyzed
// in batches of this size; the loop stops as soon as 39 actionable picks are
// found — avoiding analysis of hundreds of low-priority fixtures when top leagues
// already provide enough edges. Applies to both daily batch and goals batch.
const ANALYSIS_CHUNK_SIZE = Math.max(1, Number(env.ANALYSIS_CHUNK_SIZE ?? 50));

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
  "--run-report-now",
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

// ── WAT calendar date ────────────────────────────────────────────────────────
// The whole schedule (cron slots, "today's" lake/report/heartbeat freshness,
// "yesterday's" resolve target) is defined in WAT (UTC+1, no DST) terms. Every
// "what date is it" computation in this file MUST use this — NOT
// `new Date().toISOString().slice(0, 10)`, which is a UTC calendar date and
// silently disagrees with the WAT one for the first hour of each WAT day
// (00:00-00:59 WAT = still "yesterday" in UTC). That mismatch was the root
// cause of the 2026-07-02 incident: the back-online staleness checks
// (isLakeFreshForToday/isDailyBatchFreshForToday) compared UTC dates, so the
// moment the UTC day rolled over at 01:00 WAT, yesterday's still-fresh
// acquisition looked "stale for today" and fired the full scrape+analysis+
// goals pipeline hours early — then the real 09:30 WAT slot fired again on
// top of it. Fixed 2026-07-02; see watDateString/watYesterdayString.
const WAT_OFFSET_MS = 60 * 60 * 1000; // UTC+1, no DST (W. Central Africa Standard Time)
// IANA zone matching WAT (UTC+1, no DST) — passed explicitly to every
// cron.schedule() call below so the schedule no longer depends on the host's
// system clock (see the cron-daemon block's comment for the incident this fixes).
const WAT_TZ = "Africa/Lagos";

function watDateString(d: Date = new Date()): string {
  return new Date(d.getTime() + WAT_OFFSET_MS).toISOString().slice(0, 10);
}

function watYesterdayString(d: Date = new Date()): string {
  return watDateString(new Date(d.getTime() - 86_400_000));
}

function watMinutesSinceMidnight(d: Date = new Date()): number {
  const watDate = new Date(d.getTime() + WAT_OFFSET_MS);
  return watDate.getUTCHours() * 60 + watDate.getUTCMinutes();
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

// ── Crash-loop guard ─────────────────────────────────────────────────────────
// Servy's recoveryAction=RestartService (maxRestartAttempts=0, i.e. unbounded)
// relaunches a crashed worker unconditionally. If the crash happens inside the
// back-online batch itself (e.g. the 2026-07-05 OOM during runDailyBatch's
// [select]/[scrape] phase), the fresh process starts, checkHeartbeatFreshness
// sees the batch still isn't fresh for today, and immediately re-triggers the
// same expensive batch — a tight restart loop with no backoff. Confirmed in
// practice: 11 restarts in ~13 minutes on 2026-07-03 (~65s apart, matching how
// fast each attempt re-crashed). This guard detects "the previous process
// died within CRASH_LOOP_WINDOW_MS of starting, without a clean SIGINT/SIGTERM
// exit" and, if so, holds off the back-online retriggers for
// CRASH_LOOP_COOLDOWN_MS so Servy's restarts don't just keep re-running
// straight into the same crash.
const PROCESS_STATE_FILE = join(ROOT, ".tmp", "worker_process_state.json");
const CRASH_LOOP_WINDOW_MS = 3 * 60 * 1000; // previous start died within 3 min = crash, not a long healthy run
const CRASH_LOOP_COOLDOWN_MS = 10 * 60 * 1000; // hold off back-online retriggers this long after a detected crash loop

let crashLoopCooldownUntil = 0;

// event/at (not startedAt/cleanExit) so "when" always means the same thing —
// a prior startedAt/cleanExit shape read "start time" on one write path and
// "exit time" on the other, a latent trap for any future uptime-based check.
function writeProcessState(event: "start" | "clean-exit"): void {
  try {
    const tmpPath = `${PROCESS_STATE_FILE}.tmp`;
    writeFileSync(
      tmpPath,
      JSON.stringify({ event, at: new Date().toISOString() }, null, 2),
      "utf8"
    );
    // Atomic rename so a crash mid-write (the exact OOM/BSOD scenario this
    // guard exists to catch) can't leave a truncated file that the next
    // start's JSON.parse chokes on and silently treats as "never ran before".
    renameSync(tmpPath, PROCESS_STATE_FILE);
  } catch (err) {
    process.stderr.write(`[worker] process-state write failed: ${String(err)}\n`);
  }
}

// Fire-and-forget so a slow Telegram send never delays startup — every other
// staleness alert in this file (checkHeartbeatFreshness, checkBotHeartbeatFreshness)
// pushes through the same buildNotifiers/notifyAll pipeline; crash-loop detection
// was stderr-only (Servy log only), which pages nobody if the underlying crash is
// deterministic and the loop just keeps recurring every cooldown window instead.
async function alertCrashLoopDetected(
  prevAt: string | undefined,
  cooldownUntil: number
): Promise<void> {
  const notifiers = buildNotifiers(env);
  if (!notifiers.length) return;
  const alertSummary: BatchSummary = {
    date: watDateString(),
    analysed: 0,
    actionableCount: 0,
    errors: 0,
    actionable: [],
    alertText: `worker crash loop detected — previous start (${
      prevAt ?? "unknown, corrupt state file"
    }) did not exit cleanly and died within ${
      CRASH_LOOP_WINDOW_MS / 1000
    }s. Holding off back-online batch retriggers until ${new Date(cooldownUntil).toISOString()}.`,
  };
  await notifyAll(notifiers, alertSummary);
}

function checkCrashLoopOnStartup(): void {
  let raw: string | null = null;
  try {
    raw = readFileSync(PROCESS_STATE_FILE, "utf8");
  } catch {
    /* no previous state file — first start, nothing to detect */
  }
  if (raw !== null) {
    let armCooldown = false;
    let prevAt: string | undefined;
    try {
      const prev = JSON.parse(raw) as { event?: string; at?: string };
      prevAt = prev.at;
      if (
        prev.event === "start" &&
        prev.at &&
        Date.now() - new Date(prev.at).getTime() < CRASH_LOOP_WINDOW_MS
      ) {
        armCooldown = true;
      }
    } catch {
      // Corrupt/truncated file — can't rule out a mid-write crash, so don't
      // treat it the same as a clean first start.
      armCooldown = true;
    }
    if (armCooldown) {
      crashLoopCooldownUntil = Date.now() + CRASH_LOOP_COOLDOWN_MS;
      process.stderr.write(
        `[worker] crash loop detected (previous start ${
          prevAt ?? "unknown (corrupt state file)"
        } did not exit cleanly and died within ${
          CRASH_LOOP_WINDOW_MS / 1000
        }s) — holding off back-online batch retriggers until ${new Date(
          crashLoopCooldownUntil
        ).toISOString()}\n`
      );
      void alertCrashLoopDetected(prevAt, crashLoopCooldownUntil);
    }
  }
  writeProcessState("start");
}

function markCleanExit(): void {
  writeProcessState("clean-exit");
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

// Daily-batch back-online trigger: the 09:35 WAT cron slot is a single point
// in time — if the worker process is mid-restart at exactly that minute (Servy
// auto-restart, machine sleep/wake, etc.) the whole day's run is silently
// skipped with no catch-up, unlike acquireDailyJob below which retries on
// every hourly tick until it succeeds. Confirmed in practice: 2026-06-25
// through 06-28 all missed the (then-06:00 UTC) slot, leaving oracle-{date}.html
// and the booking-eligible picks stale for days. Mirrors isLakeFreshForToday/
// LAKE_TRIGGER_REPEAT_MS below, but keyed off lastBatch instead of lastAcquire.
const DAILY_BATCH_STALE_MS = 20 * 60 * 60 * 1000; // ~20h — same-day batch is always fresher than this
let lastDailyBatchTriggerAt = 0;
const DAILY_BATCH_TRIGGER_REPEAT_MS = 6 * 60 * 60 * 1000; // don't retry a failing batch more than every 6h
// Slot floors for the back-online triggers below: "today has no data yet" is
// true and expected for every minute before the scheduled cron slot, so
// without this floor the first hourly tick after WAT midnight (~00:00-01:00
// WAT) always mistook "too early" for "missed" and fired the whole
// acquire+report+goals-batch chain hours ahead of schedule, every night —
// confirmed nightly in .tmp/servy_worker_stdout.log back to at least 2026-06-24,
// independent of any crash-loop. Mirrors the actual cron minutes below
// (30/35 past 9 WAT).
const ACQUIRE_SLOT_MINUTES = 9 * 60 + 30; // 09:30 WAT
const DAILY_BATCH_SLOT_MINUTES = 9 * 60 + 35; // 09:35 WAT

// [audit fix, P0-4] Cap on how long the 09:35/09:40 cron slots wait for the
// 09:30 acquire job before proceeding anyway (awaitAcquireDailyJobOrTimeout) —
// the "fallback cron" half of the fix: a hung/dead acquire job must not
// permanently starve the rest of the day's pipeline.
const ACQUIRE_CHAIN_TIMEOUT_MS = 20 * 60 * 1000; // 20 min

function isDailyBatchFreshForToday(lastBatchAt: string | undefined): boolean {
  if (!lastBatchAt) return false;
  if (watDateString(new Date(lastBatchAt)) !== watDateString()) return false;
  return Date.now() - new Date(lastBatchAt).getTime() < DAILY_BATCH_STALE_MS;
}

// Lake-staleness back-online trigger: unlike the alert above, this actively
// re-runs acquisition rather than just notifying — so a daemon that was down
// across 09:30 WAT catches up as soon as it restarts, instead of waiting for
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

// Fixture-report follow-up state: when sendDailyFixtureReport() blocks on
// marketsEmpty it stamps fixtureReportPlaceholder so the hourly heartbeat tick
// below knows to retry until the enriched spreadsheet ships (stamped as
// fixtureReportDelivered) — see sendDailyFixtureReport for the send side.
function readFixtureReportState(): { placeholderDate?: string; deliveredDate?: string } {
  try {
    const current = JSON.parse(readFileSync(HEARTBEAT_FILE, "utf8")) as Record<
      string,
      { date?: string } | undefined
    >;
    return {
      placeholderDate: current.fixtureReportPlaceholder?.date,
      deliveredDate: current.fixtureReportDelivered?.date,
    };
  } catch {
    return {};
  }
}

/** True when today's Parquet-lake partition was written by a successful
 *  acquireDailyJob run within the last LAKE_STALE_MS — gates both the 09:35
 *  WAT batch's gap-fill scrape and the back-online trigger below. */
function isLakeFreshForToday(): boolean {
  const lastAcquire = readLastAcquire();
  if (!lastAcquire?.date || !lastAcquire.at) return false;
  if (lastAcquire.date !== watDateString()) return false;
  if (Date.now() - new Date(lastAcquire.at).getTime() >= LAKE_STALE_MS) return false;
  // Heartbeat alone can lie if the lake directory was deleted/moved after a
  // successful acquisition stamped it — confirm the partition is still on disk.
  return fixturesPartitionExists(lastAcquire.date);
}

async function checkHeartbeatFreshness(): Promise<void> {
  // Called at startup and hourly (cron.schedule("0 * * * *", ...) below) — this
  // doubles as an hourly baseline memory reading independent of which jobs ran,
  // so a steady hour-over-hour climb is visible even on an hour with no batch.
  logMemoryUsage("hourly-tick");

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
  if (
    !isLakeFreshForToday() &&
    watMinutesSinceMidnight() >= ACQUIRE_SLOT_MINUTES &&
    Date.now() - lastLakeTriggerAt >= LAKE_TRIGGER_REPEAT_MS &&
    Date.now() >= crashLoopCooldownUntil
  ) {
    lastLakeTriggerAt = Date.now();
    process.stdout.write(
      "[worker] daily lake stale/missing — triggering back-online acquisition\n"
    );
    // After back-online acquisition completes, send the fixture report and fire the
    // goals batch immediately so a machine that was off across 09:30 WAT still gets
    // the report + picks as soon as it comes up — mirrors the 09:30 WAT cron sequence.
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
    watMinutesSinceMidnight() >= DAILY_BATCH_SLOT_MINUTES &&
    Date.now() - lastDailyBatchTriggerAt >= DAILY_BATCH_TRIGGER_REPEAT_MS &&
    Date.now() >= crashLoopCooldownUntil
  ) {
    lastDailyBatchTriggerAt = Date.now();
    process.stdout.write(
      "[worker] daily batch stale/missing for today — triggering back-online run\n"
    );
    // [audit fix, P0-4] This trigger and the lake/acquire back-online trigger
    // above are two independent `if` blocks that can both fire in the same
    // checkHeartbeatFreshness() pass (e.g. a machine coming back online with
    // both the lake AND the batch stale) — without this handoff, this
    // logJob's runDailyBatch could start concurrently with the other one's
    // acquireDailyJob, the same race the cron-slot fix addresses below.
    logJob("daily-batch@back-online", async () => {
      await awaitAcquireDailyJobOrTimeout(ACQUIRE_CHAIN_TIMEOUT_MS);
      await runDailyBatch("scheduled");
    });
  }

  // Fixture-report enrichment follow-up: sendDailyFixtureReport() sent today's
  // "blocked by data depth" placeholder but hasn't yet delivered the enriched
  // spreadsheet — retry every hour until allMarkets lands. sendDailyFixtureReport
  // is idempotent here: still-empty re-checks just re-skip without re-pinging.
  const reportState = readFixtureReportState();
  const todayStr = watDateString();
  if (reportState.placeholderDate === todayStr && reportState.deliveredDate !== todayStr) {
    logJob("fixture-report@enriched-followup", sendDailyFixtureReport);
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
    date: watDateString(),
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
    date: watDateString(),
    analysed: 0,
    actionableCount: 0,
    errors: 0,
    actionable: [],
    alertText: `Telegram bot appears offline — ${detail}. Incoming commands (/run, /punt, /confirm, etc.) won't work until it's restarted.`,
  };
  await notifyAll(notifiers, alertSummary);
}

// ── Memory telemetry ─────────────────────────────────────────────────────────
// Instrumentation-only, added while diagnosing the 2026-07-05 worker OOM
// (crashed at ~509-517MB, before the Servy heap-ceiling fix was corrected from
// a stale 512MB to the intended 2048MB — see oracle_machine_crash_2026_07_05
// memory). The real daily fixture pool is O(100-250), not the ~18.5k first
// assumed, so rather than redesign loadSportyBetIndex/gating against an
// unconfirmed problem, this logs real before/after numbers per job phase so a
// future OOM (or steady hour-over-hour growth) can be pinned to a specific
// phase instead of guessed at.
function logMemoryUsage(label: string): void {
  const mem = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  process.stdout.write(
    `[mem] ${label} heapUsedMB=${mb(mem.heapUsed)} rssMB=${mb(mem.rss)} externalMB=${mb(mem.external)}\n`
  );
}

function logJob(name: string, fn: () => Promise<unknown>): void {
  const started = Date.now();
  process.stdout.write(`[worker] ${new Date().toISOString()} ${name}: start\n`);
  logMemoryUsage(`${name}:start`);
  fn()
    .then(() => {
      const s = ((Date.now() - started) / 1000).toFixed(1);
      process.stdout.write(`[worker] ${new Date().toISOString()} ${name}: ok in ${s}s\n`);
      logMemoryUsage(`${name}:ok`);
    })
    .catch((err: unknown) => {
      const s = ((Date.now() - started) / 1000).toFixed(1);
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(
        `[worker] ${new Date().toISOString()} ${name}: FAILED after ${s}s — ${msg}\n`
      );
      logMemoryUsage(`${name}:failed`);
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

// Shared in-flight guard: acquireDailyJob (09:30 WAT cron + back-online trigger)
// and runDailyBatch's gap-fill call both invoke acquireDaily() independently,
// gated by the same isLakeFreshForToday() check — if the 09:30 WAT run is still
// in progress (or just failed) when the hourly/09:35 WAT triggers fire, they'd
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

/** Full 09:30 WAT acquisition job: scrape -> lake write -> news enrichment ->
 *  heartbeat. Only stamps lastAcquire when fixtures were actually acquired, so
 *  a failed run leaves the lake-staleness check above free to keep retrying
 *  rather than masking the failure with a fresh timestamp.
 *
 *  [audit fix, P0-4] Tracked via trackAcquireJob so the 09:35/09:40 cron slots
 *  (and the daily-batch back-online trigger) can await its actual completion
 *  instead of firing on a fixed wall-clock offset — see acquireChain.ts. */
function acquireDailyJob(): Promise<void> {
  return trackAcquireJob(
    (async () => {
      const count = await acquireDaily();
      await runNewsEnrichment();
      if (count > 0) {
        writeHeartbeat("lastAcquire", { date: watDateString(), fixtures: count });
      }
    })()
  );
}

/** [audit fix, P0-4] Wait for acquireDailyJob (up to ACQUIRE_CHAIN_TIMEOUT_MS)
 *  before starting the caller's own heavy work — logs and proceeds anyway if
 *  the bound is hit (the "fallback cron" requirement). */
function awaitAcquireDailyJobOrTimeout(timeoutMs: number): Promise<void> {
  return awaitAcquireOrTimeout(timeoutMs, () => {
    process.stdout.write(
      `[worker] acquire-daily still running after ${Math.round(timeoutMs / 60000)}min — proceeding anyway\n`
    );
  });
}

/** Daily raw-fixture-data report (item #5): every SportyBet fixture for the
 *  day + its accompanying odds/stats/lineups/news — independent of engine
 *  selection or the goals funnel. Generated + sent to Telegram as a document
 *  attachment immediately after the 09:30 WAT scrape, before anything else
 *  (goals batch, daily batch) — per owner instruction "trigger immediately
 *  after scrape and before any other thing." Best-effort: a failure here
 *  (missing token, write error) is logged but never blocks the rest of the run. */
// Guards against the lake-stale back-online chain (acquireDailyJob ->
// sendDailyFixtureReport) and the hourly enriched-followup retry firing this
// concurrently — both are fire-and-forget logJob calls with no shared lock,
// so without this they could both pass the marketsEmpty check at once and
// double-send the Telegram document.
let fixtureReportInFlight = false;

async function sendDailyFixtureReport(): Promise<void> {
  if (fixtureReportInFlight) {
    process.stdout.write("[fixture-report] skip — already running\n");
    return;
  }
  fixtureReportInFlight = true;
  const startedAt = new Date();
  const today = watDateString(startedAt);
  const hasCreds = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  process.stdout.write(`[fixture-report] start ${startedAt.toISOString()} (creds=${hasCreds})\n`);
  try {
    // Spreadsheets (.xlsx) replace the old HTML report — a small Fixtures file
    // (one row per fixture, every captured field) plus per-outcome Markets
    // file(s), split under the Telegram per-file size budget.
    const result = await generateAndWriteFixtureWorkbook(today, join(ROOT, ".tmp/reports"));
    if (!result) {
      // No-fixtures is a real, reportable state — surface it loudly (was a silent
      // return that made "the report never fired" indistinguishable from a crash).
      process.stderr.write("[fixture-report] WARN no SportyBet fixtures available for today\n");
      if (hasCreds) {
        await sendTelegramText(
          env.TELEGRAM_BOT_TOKEN as string,
          env.TELEGRAM_CHAT_ID as string,
          `ORACLE — no SportyBet fixtures found for ${today}.`
        );
      }
      return;
    }
    if (result.marketsEmpty) {
      // Markets depth not yet enriched — the report cron raced the scrape's
      // allMarkets pass (the historical cause of header-only "Markets" sheets).
      // Don't silently push a marketless report; flag the block once via
      // Telegram and let the hourly heartbeat retry (readFixtureReportState/
      // checkHeartbeatFreshness above) send the real spreadsheet once enriched.
      process.stderr.write(
        `[fixture-report] WARN allMarkets not yet enriched for ${today} (${result.fixtureCount} fixtures) — skipping push; hourly retry will deliver the full report\n`
      );
      const alreadyFlagged = readFixtureReportState().placeholderDate === today;
      if (hasCreds && !alreadyFlagged) {
        await sendTelegramText(
          env.TELEGRAM_BOT_TOKEN as string,
          env.TELEGRAM_CHAT_ID as string,
          `ORACLE — ${today} full-lake report BLOCKED: market depth not yet enriched (NO accumulated enriched data). Will auto-send the full spreadsheet once ready.`
        );
      }
      if (!alreadyFlagged) writeHeartbeat("fixtureReportPlaceholder", { date: today });
      return;
    }
    const allPaths = [result.fixturesPath, ...result.marketsPaths];
    for (const p of allPaths) {
      const kb = Math.round(statSync(p).size / 1024);
      process.stdout.write(`[fixture-report] wrote ${p} (${kb}KB)\n`);
    }

    if (hasCreds) {
      const total = allPaths.length;
      const partCount = result.marketsPaths.length;
      await sendTelegramDocument(
        env.TELEGRAM_BOT_TOKEN as string,
        env.TELEGRAM_CHAT_ID as string,
        result.fixturesPath,
        `ORACLE daily fixtures (spreadsheet) — ${today} (${result.fixtureCount} fixtures) [file 1/${total}]`
      );
      for (let i = 0; i < result.marketsPaths.length; i++) {
        await sendTelegramDocument(
          env.TELEGRAM_BOT_TOKEN as string,
          env.TELEGRAM_CHAT_ID as string,
          result.marketsPaths[i] as string,
          `ORACLE daily markets — ${today} [file ${i + 2}/${total}${partCount > 1 ? `, part ${i + 1} of ${partCount}` : ""}]`
        );
      }
      process.stdout.write(
        `[fixture-report] delivered ${total} file(s) to Telegram in ${Date.now() - startedAt.getTime()}ms\n`
      );
      writeHeartbeat("fixtureReportDelivered", { date: today });
    } else {
      // Was a silent skip — now explicit so an unconfigured box is obvious in logs.
      process.stderr.write(
        `[fixture-report] WARN Telegram creds missing — spreadsheets on disk at ${allPaths.join(", ")}, not delivered\n`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[fixture-report] FAILED — ${msg}\n`);
    // Best-effort failure ping so a delivery failure is visible in the chat, not
    // just buried in service logs.
    if (hasCreds) {
      await sendTelegramText(
        env.TELEGRAM_BOT_TOKEN as string,
        env.TELEGRAM_CHAT_ID as string,
        `ORACLE — daily fixture report FAILED for ${today}: ${msg}`
      ).catch(() => {});
    }
  } finally {
    fixtureReportInFlight = false;
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

// ── Daily batch (09:35 WAT) ─────────────────────────────────────────────────

/** Merge multiple BatchResult chunks (from the priority-ordered chunk loop) into a
 *  single BatchResult so downstream summarizeBatch / selectGoalsAccumulator callers
 *  see one unified result, identical to what a single runAnalysis call would return. */
function mergeBatchChunks(chunks: BatchResult[]): BatchResult {
  if (!chunks.length) throw new Error("mergeBatchChunks: no chunks to merge");
  const first = chunks[0]!;
  return {
    runId: first.runId,
    calibrationSnapshotId: first.calibrationSnapshotId,
    date: first.date,
    rankingMode: first.rankingMode,
    ...(first.dryRun != null ? { dryRun: first.dryRun } : {}),
    jobs: chunks.flatMap((c) => c.jobs),
    completedCount: chunks.reduce((s, c) => s + c.completedCount, 0),
    errorCount: chunks.reduce((s, c) => s + c.errorCount, 0),
    actionableCount: chunks.reduce((s, c) => s + c.actionableCount, 0),
    totalRecommendedStakePct: chunks.reduce((s, c) => s + c.totalRecommendedStakePct, 0),
    cost: {
      estimatedUsd: chunks.reduce((s, c) => s + c.cost.estimatedUsd, 0),
      ceilingUsd: first.cost.ceilingUsd,
      halted: chunks.some((c) => c.cost.halted),
    },
    errors: chunks.flatMap((c) => c.errors),
  };
}

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

  // ── PR-5a: v3 slate pre-filter (eligibility + completeness, fail-open) ────
  // Drops fixtures the v3 gate would discard anyway BEFORE any engine/LLM
  // spend. Only acts when v3 is live ("on") AND ORACLE_MARKETS_V3_GATE is on;
  // sidecar-unmapped fixtures always pass through, and an all-drop fails open
  // to the ungated slate (more likely an upstream league-name/schema
  // regression than a genuinely empty slate). Survivors carry the per-fixture
  // telemetry.v3Heightened stamp the heightened EV bars key off.
  // The index is loaded here (not at the booking block) so both uses share one read.
  const sportyIndex = await loadSportyBetIndex(watDateString());
  logMemoryUsage("daily-batch:sportyIndex-loaded");
  let gatedJobs = jobs;
  if (config.enableMarketsV3 === "on" && config.marketsV3Gate !== false) {
    const { jobs: survivors, summary } = prefilterMarketsV3Jobs(
      jobs,
      sportyIndex?.detailByKey,
      buildMarketsV3GateConfig(env),
      { completenessV4: config.v3CompletenessV4 }
    );
    if (summary) process.stdout.write(`[markets-v3] ${formatSlateGateLog(summary)}\n`);
    if (survivors.length > 0) {
      gatedJobs = survivors;
    } else {
      process.stderr.write(
        "[markets-v3] gate dropped every fixture — failing open to the ungated slate\n"
      );
    }
  }

  // Priority-ordered chunk loop: jobs are already sorted by selectFixtures (tier 0
  // priority leagues first, then tier 1, then by data-completeness + score within tier).
  // Analyze in chunks of ANALYSIS_CHUNK_SIZE; stop as soon as 39 actionable picks
  // accumulate — avoids wasting Claude calls on low-priority fixtures when top leagues
  // already deliver enough edges. Safety net (the 39-curation block below) trims any
  // overshoot when a single chunk yields more than 39 actionable.
  const batchChunks: BatchResult[] = [];
  const allRecords: unknown[] = [];
  let finalReportPath: string | undefined;

  // PR-6 R10: cross-check hook (goals-family picks re-verified against the
  // independent goals engine). Built once over the shared sidecar index;
  // undefined when the flag is off or no index loaded (⇒ engine skips it).
  const goalsCrossCheck = buildGoalsCrossCheckHook(sportyIndex?.detailByKey);

  for (let i = 0; i < gatedJobs.length; i += ANALYSIS_CHUNK_SIZE) {
    const chunk = gatedJobs.slice(i, i + ANALYSIS_CHUNK_SIZE);
    const chunkIdx = Math.floor(i / ANALYSIS_CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(gatedJobs.length / ANALYSIS_CHUNK_SIZE);
    process.stdout.write(
      `[batch] chunk ${chunkIdx}/${totalChunks}: fixtures ${i + 1}–${i + chunk.length} of ${gatedJobs.length}\n`
    );
    const analyzedSoFar = batchChunks.reduce((s, c) => s + c.completedCount, 0);
    const {
      batch: chunkBatch,
      records: chunkRecords,
      reportPath: chunkReportPath,
    } = await runAnalysis(
      chunk,
      { storage, config, goalsCrossCheck },
      {
        trigger,
        writeReportToDisk: i === 0, // only first chunk writes the HTML report
        batchOptions: {
          onProgress: ({ completed, current }) => {
            if (current)
              process.stdout.write(
                `[batch] ${analyzedSoFar + completed}/${gatedJobs.length}: ${current}\n`
              );
          },
        },
      }
    );
    batchChunks.push(chunkBatch);
    allRecords.push(...(chunkRecords as unknown[]));
    if (chunkReportPath) finalReportPath = chunkReportPath;

    const cumulativeActionable = batchChunks.reduce((s, c) => s + c.actionableCount, 0);
    process.stdout.write(
      `[batch] chunk ${chunkIdx} done — ${chunkBatch.completedCount} analyzed, ` +
        `${chunkBatch.actionableCount} actionable this chunk, ${cumulativeActionable} total\n`
    );

    if (cumulativeActionable >= 39) {
      const done = batchChunks.reduce((s, c) => s + c.completedCount, 0);
      process.stdout.write(
        `[batch] 39 actionable reached after ${done}/${gatedJobs.length} fixtures — stopping early\n`
      );
      break;
    }
  }
  logMemoryUsage("daily-batch:chunk-loop-done");

  const batch = mergeBatchChunks(batchChunks);
  const records = allRecords;
  const reportPath = finalReportPath;

  if (records.length > 0) process.stdout.write(`[batch] ${records.length} records persisted\n`);
  if (reportPath) process.stdout.write(`[batch] report: ${reportPath}\n`);
  if (batch.cost.halted)
    process.stderr.write("[batch] WARNING: cost cap halted the batch before completion\n");

  // ── SportyBet booking (off by default; never blocks delivery) ──────────────
  // resolveEventId looks up the sidecar's eventId for each pick — without it
  // every ActionablePick.eventId is undefined and bookAccumulator skips every leg.
  // sportyIndex was loaded once before the pre-filter; reused here.
  const summary = summarizeBatch(batch, undefined, (home, away) =>
    sportyIndex ? findSidecarDetail(sportyIndex.detailByKey, home, away)?.eventId : undefined
  );

  // ── PR-5b: v3 slate outputs A–D + sanity (fail-open to the legacy trim) ──
  if (config.enableMarketsV3 === "on" && config.marketsV3Outputs !== false) {
    const successJobs = batch.jobs.filter((j): j is FixtureJobSuccess => j.status === "ok");
    const v3Outputs = buildMarketsV3SlateOutputs(successJobs);
    process.stdout.write(
      `[markets-v3] ALL-MARKETS OUTPUT A:${v3Outputs.outputA.length} ` +
        `B:${v3Outputs.outputB.miniAcca.length}legs C:${v3Outputs.outputC.length} ` +
        `D:${v3Outputs.outputD.length} — ${v3Outputs.sanityLine}\n`
    );
    if (summary.actionable.length > 39) {
      summary.actionable = curateActionableByV3Outputs(summary.actionable, v3Outputs.outputA, 39);
      summary.actionableCount = summary.actionable.length;
    }
    summary.sanityNote = v3Outputs.sanityLine;
  } else if (summary.actionable.length > 39) {
    // Legacy trim — BYTE-IDENTICAL to pre-PR-5b. Only path when v3 outputs
    // are off or v3 isn't live ("on") — this is the regression pin.
    const tierOf = (league: string) => (ORACLE_PRIORITY_LEAGUES.has(league) ? 0 : 1);
    summary.actionable = [...summary.actionable]
      .sort((a, b) => tierOf(a.league) - tierOf(b.league) || b.confidence - a.confidence)
      .slice(0, 39);
    summary.actionableCount = summary.actionable.length;
  }

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
  logPrefix: string,
  v3Meta?: { arbiterStatus: "verified" | "unverified"; cappedCount: number },
  sanityNote?: string
): Promise<BatchSummary> {
  // v3 legs carry mp = model probability (unchanged) but ActionablePick.edge is
  // what formatSummaryText renders as the edge/tier line — feed it the ADJUSTED
  // edge on the v3 path so the slip shows the §4 gate's edge, not the raw mp−ip.
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
    edge: v3Meta ? (l.adjustedEdge ?? l.edge) : l.edge,
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
    ...(v3Meta
      ? {
          arbiterStatus: v3Meta.arbiterStatus,
          ...(v3Meta.cappedCount > 0 ? { cappedCount: v3Meta.cappedCount } : {}),
          rgNote: GOALS_V3_RG_NOTE,
        }
      : {}),
    ...(sanityNote ? { sanityNote } : {}),
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
  trigger: RunManifest["trigger"],
  v3Meta?: { arbiterStatus: "verified" | "unverified"; cappedCount: number; sanityLine?: string }
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
    "top-picks",
    v3Meta
  );

  // 2. Lottery — long slip, up to 39 legs, greedy correlation-aware. The fullest
  // slate view, so the sanity note (slate-wide, would just repeat on every
  // other filtered subset) rides this send only.
  const lottery = await sendGoalsSlip(
    selection.legs,
    LOTTERY_TAG,
    date,
    selection.analysed,
    errorCount,
    selection.combinedProb,
    selection.combinedOdds,
    "lottery",
    v3Meta,
    v3Meta?.sanityLine
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
    "mini-acca",
    v3Meta
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
      "output-b",
      v3Meta
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
      "output-c",
      v3Meta
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
    await writeGoalsArtifact(
      selection,
      date,
      join(ROOT, ".tmp/goals"),
      v3Meta ? { v3: true, ...v3Meta } : undefined
    );
  } catch (err) {
    process.stderr.write(
      `[goals] WARN: artifact write failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  }
}

// ── goals-market-analysis-prompt-v3 pipeline ────────────────────────────────
// Deterministic replacement for the legacy funnel (mechanical filter -> Sonnet
// screen -> runAnalysis ensemble -> per-fixture arbiter): v3's phases run as
// pure TypeScript (eligibility, weighted completeness, multiplicative-Poisson
// lambdas + match-shape correction, the §4 edge gate) with LLM usage cut to
// ONE slate-level arbiter call reviewing the assembled selection. Gated by
// ORACLE_GOALS_V3; false leaves runGoalsBatch's legacy path byte-identical.

/** Extract the goals-relevant decimal odds from a sidecar detail into the
 *  shape analyzeGoalsFixtureV3 prices. Missing markets simply stay null —
 *  the engine's devigOU already treats a null odds field as "not priceable". */
function buildV3Odds(detail: SportyBetEventDetail | undefined): V3FixtureOdds {
  const o = detail?.odds;
  return {
    over15: o?.ou15?.over ?? null,
    under15: o?.ou15?.under ?? null,
    over25: o?.ou25?.over ?? null,
    under25: o?.ou25?.under ?? null,
    homeTotalOver05: o?.tt_home_05?.over ?? null,
    awayTotalOver05: o?.tt_away_05?.over ?? null,
    bttsYes: o?.btts?.yes ?? null,
    bttsNo: o?.btts?.no ?? null,
    home1x2: o?.["1x2"]?.home ?? null,
    draw1x2: o?.["1x2"]?.draw ?? null,
    away1x2: o?.["1x2"]?.away ?? null,
  };
}

/** §3.1 sample size behind the season averages — standings.played is the
 *  season sample; recentGoals.n (last-5 window) is the fallback when a lower
 *  division only exposes a rolling window. */
function v3SampleSize(
  detail: SportyBetEventDetail | undefined,
  side: "home" | "away"
): number | null {
  const played = detail?.stats?.standings?.[side]?.played;
  if (typeof played === "number" && played > 0) return played;
  const n = detail?.stats?.recentGoals?.[side]?.n;
  return typeof n === "number" && n > 0 ? n : null;
}

function v3FixtureId(home: string, away: string, kickoff: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
  return `${slug(home)}_vs_${slug(away)}_${kickoff.replace(/\D/g, "").slice(0, 12)}`;
}

/** Prefer the venue-conditioned xG split (tools/build_xg_table.py) over the
 *  season aggregate when present — a strictly better prior per the type's own
 *  docstring (SportyBetXgEntry.venueXgf/venueXga). */
function v3TeamXg(
  entry:
    | { xgf?: number; xga?: number | null; venueXgf?: number | null; venueXga?: number | null }
    | null
    | undefined
): { xgf?: number | null; xga?: number | null } | null {
  if (!entry) return null;
  return {
    xgf: entry.venueXgf ?? entry.xgf ?? null,
    xga: entry.venueXga ?? entry.xga ?? null,
  };
}

/** Assemble the goals-only v3 engine's per-fixture input from a sidecar detail.
 *  Shared by the goals-v3 batch AND the daily all-markets R10 cross-check hook
 *  (PR-6), so the cross-check re-prices each candidate against the byte-
 *  identical input the goals engine would have used on its own. `gating`
 *  carries the completeness-scorer outputs the caller already computed. */
function buildGoalsV3Input(
  detail: SportyBetEventDetail | undefined,
  fixture: { home: string; away: string; league: string; leagueId?: string; kickoff: string },
  runId: string,
  gating: {
    penaltyFlags: V3AnalyzeInput["penaltyFlags"];
    completeness: number;
    sources: string[];
    heightened: boolean;
  }
): V3AnalyzeInput {
  return {
    fixtureId: v3FixtureId(fixture.home, fixture.away, fixture.kickoff),
    runId,
    home: fixture.home,
    away: fixture.away,
    league: fixture.league,
    kickoff: fixture.kickoff,
    odds: buildV3Odds(detail),
    lambdaInput: {
      league: fixture.league,
      leagueId: fixture.leagueId,
      homeScoredPer90: detail?.stats?.goals?.home?.avg_scored ?? null,
      homeConcededPer90: detail?.stats?.goals?.home?.avg_conceded ?? null,
      awayScoredPer90: detail?.stats?.goals?.away?.avg_scored ?? null,
      awayConcededPer90: detail?.stats?.goals?.away?.avg_conceded ?? null,
      nHome: v3SampleSize(detail, "home"),
      nAway: v3SampleSize(detail, "away"),
      homeXg: v3TeamXg(detail?.stats?.xg?.home),
      awayXg: v3TeamXg(detail?.stats?.xg?.away),
    },
    penaltyFlags: gating.penaltyFlags,
    completeness: gating.completeness,
    sources: gating.sources,
    nbDispersion: config.useNegBinom ? v3NbDispersion(config.nbDispersion) : undefined,
    xgBlend: goalsV3Config.xgBlend,
    edgeCap: goalsV3Config.edgeCap,
    noiseGate: goalsV3Config.noiseGate,
    // NOTE: unlike the main all-markets batch (batch/index.ts's buildV3Input),
    // this goals-only path does not currently pass hfa/venueSplitUsed — a
    // pre-existing gap (goals-only fixtures get no HFA term at all) outside
    // this fix's scope; flagging for a follow-up rather than fixing inline.
    lambdaV5: config.v3LambdaV5,
    heightened: gating.heightened,
    lineHitRates: deriveLineHitRates(detail),
  };
}

/** Build the R10 goals cross-check hook (PR-6) for the daily all-markets batch.
 *  Returns undefined (⇒ cross-check disabled) when the flag is off or no
 *  sidecar index is available. The hook rebuilds each fixture's goals-only
 *  input from its sidecar detail and defers to crossCheckGoalsPick; a fixture
 *  with no sidecar mapping yields null (no independent opinion). Standard
 *  (non-heightened) goals bars are used — the more lenient floor, which
 *  agrees more and over-drops less, matching the plan's "no hard veto" intent. */
function buildGoalsCrossCheckHook(
  detailByKey: Map<string, SportyBetEventDetail> | undefined
): GoalsCrossCheckFn | undefined {
  if (config.v3GoalsCrossCheck === false || !detailByKey) return undefined;
  return (pick, label, odds, fixture) => {
    const detail = findSidecarDetail(detailByKey, fixture.home, fixture.away);
    if (!detail) return null;
    const lineupsAvailable = false; // daily hook has no per-fixture job.state here
    const completeness = scoreCompleteness(detail, {
      lineupsAvailable,
      completenessV4: config.v3CompletenessV4,
    });
    const goalsInput = buildGoalsV3Input(detail, fixture, "crosscheck", {
      penaltyFlags: completeness.penaltyFlags,
      completeness: completeness.score,
      sources: completeness.sources,
      heightened: false,
    });
    return crossCheckGoalsPick(pick, label, odds, goalsInput);
  };
}

/** Best-effort transparency log for §4.4 capped selections (raw edge > cap,
 *  auto-discarded, never bet). A write failure here must never fail the run —
 *  same convention as writeGoalsArtifact. */
async function writeV3CappedLog(
  capped: Array<{
    home: string;
    away: string;
    league: string;
    label: string;
    rawEdge: number;
    rationale: string;
  }>,
  date: string
): Promise<void> {
  if (capped.length === 0) return;
  try {
    const outDir = join(ROOT, ".tmp/goals");
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, `v3-capped-${date}.json`),
      JSON.stringify({ date, generatedAt: new Date().toISOString(), capped }, null, 2),
      "utf8"
    );
  } catch (err) {
    process.stderr.write(
      `[goals-v3] WARN: capped-log write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

/** goals-market-analysis-prompt-v3 end-to-end: eligibility (union whitelist +
 *  hard discards) -> enrichment (H2H/newsIntel cache-only/lineups, reused as-is
 *  from the legacy path) -> weighted completeness gate (<70 discard) ->
 *  predictability ordering -> deterministic per-fixture analysis (v3 lambdas +
 *  Dixon-Coles matrix + match-shape BTTS correction + §4 edge gate, NO
 *  per-fixture LLM) -> selectGoalsAccumulator(v3) -> ONE slate arbiter call ->
 *  the same five Telegram slips the legacy path sends. */
async function runGoalsBatchV3(
  futureEvents: SportyBetEvent[],
  index: SportyBetIndex,
  trigger: RunManifest["trigger"]
): Promise<void> {
  const date = watDateString();

  // ── Phase 1 — eligibility ─────────────────────────────────────────────────
  const classified = futureEvents.map((event) => ({ event, elig: classifyEligibility(event) }));
  const survivors = classified.filter((c) => c.elig.status !== "discard");
  process.stdout.write(
    `[goals-v3] eligibility: ${futureEvents.length} → ${survivors.length} survive ` +
      `(${futureEvents.length - survivors.length} discarded)\n`
  );
  if (!survivors.length) {
    process.stdout.write("[goals-v3] no eligible fixtures — skipping\n");
    return;
  }

  // Build FixtureJobs for enrichment reuse (H2H/newsIntel/lineups all operate
  // on FixtureJob[] — same functions the legacy path calls, unmodified).
  const preJobs = survivors
    .map(({ event }) => ({ event, job: sportyEventToFixtureJob(event) }))
    .filter(
      (
        x
      ): x is {
        event: SportyBetEvent;
        job: NonNullable<ReturnType<typeof sportyEventToFixtureJob>>;
      } => x.job !== null
    );
  if (!preJobs.length) {
    process.stdout.write("[goals-v3] no fixtures with priceable odds — skipping\n");
    return;
  }

  const storage = new MemoryAdapter(STORE_PATH);
  const withH2H = await enrichWithH2H(
    preJobs.map((x) => x.job),
    config.footballDataApiKey
  );
  const withNews = config.enableNewsIntel
    ? await enrichWithNewsIntel(withH2H, { storage, cacheOnly: true })
    : withH2H;
  const enrichedJobs = await enrichWithLineups(withNews);

  // ── Phase 0 — weighted completeness gate ─────────────────────────────────
  const eligByKey = new Map(
    classified.map((c) => [sidecarKey(c.event.home, c.event.away), c.elig])
  );
  let completenessDiscards = 0;
  let heightenedDiscards = 0;
  const gated: Array<{
    event: SportyBetEvent;
    job: (typeof preJobs)[number]["job"];
    completeness: ReturnType<typeof scoreCompleteness>;
    /** §1.2 heightened eligibility — per-fixture input to the v4 8pt pass floor. */
    heightened: boolean;
  }> = [];
  for (let i = 0; i < preJobs.length; i++) {
    const { event } = preJobs[i]!;
    const job = enrichedJobs[i]!;
    const detail = event.detail;
    const h2hEnriched =
      typeof (job.state?.pipeline?.fetched as { stats?: { h2hN?: number } } | undefined)?.stats
        ?.h2hN === "number";
    const lineupsAvailable = (job.state?.telemetry?.softContext ?? []).some(
      (item) => item.kind === "lineup"
    );
    const completeness = scoreCompleteness(detail, {
      h2hEnriched,
      lineupsAvailable,
      completenessV4: config.v3CompletenessV4,
    });
    const elig = eligByKey.get(sidecarKey(event.home, event.away));
    const minScore =
      elig?.status === "heightened" ? goalsV3Config.heightenedMin : goalsV3Config.completenessMin;
    const heightenedOk = elig?.status !== "heightened" || heightenedTrendsAligned(detail);
    if (
      completeness.mandatoryMissing.length > 0 ||
      completeness.score < minScore ||
      !heightenedOk
    ) {
      if (elig?.status === "heightened") heightenedDiscards++;
      else completenessDiscards++;
      continue;
    }
    gated.push({ event, job, completeness, heightened: elig?.status === "heightened" });
  }
  process.stdout.write(
    `[goals-v3] completeness: ${preJobs.length} → ${gated.length} survive ` +
      `(${completenessDiscards} below floor, ${heightenedDiscards} heightened-bar failed)\n`
  );
  if (!gated.length) {
    process.stdout.write("[goals-v3] no fixtures cleared the completeness gate — skipping\n");
    return;
  }

  // ── Phase 2 — predictability ordering (cosmetic; lean path analyzes all) ──
  gated.sort(
    (a, b) =>
      scorePredictabilityV3(a.event) - scorePredictabilityV3(b.event) ||
      a.completeness.score - b.completeness.score
  );
  gated.reverse();

  // ── Phases 3–4 — deterministic per-fixture analysis + edge gate ──────────
  const runId = `run_v3_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const jobs: BatchJobResult[] = [];
  const results: V3FixtureResult[] = [];
  const cappedLog: Array<{
    home: string;
    away: string;
    league: string;
    label: string;
    rawEdge: number;
    rationale: string;
  }> = [];
  let analysisErrors = 0;
  for (const { event, job, completeness, heightened } of gated) {
    const detail = event.detail;
    const input = buildGoalsV3Input(detail, job, runId, {
      penaltyFlags: completeness.penaltyFlags,
      completeness: completeness.score,
      sources: completeness.sources,
      // Per-fixture (§1.2 eligibility class), not slate-wide: the gates-v4 flag
      // enables the heightened mechanism, eligibility decides who it applies to.
      heightened: config.v3GatesV4 !== false && heightened,
    });
    const result = analyzeGoalsFixtureV3(input);
    if (!result) {
      analysisErrors++;
      continue;
    }
    jobs.push(result.job);
    results.push(result);
    for (const c of result.capped) {
      cappedLog.push({
        home: job.home,
        away: job.away,
        league: job.league,
        label: c.label,
        rawEdge: c.rawEdge,
        rationale: c.rationale,
      });
    }
  }
  process.stdout.write(
    `[goals-v3] analyzed ${jobs.length}/${gated.length} fixtures (${analysisErrors} errors, ${cappedLog.length} capped selections)\n`
  );
  await writeV3CappedLog(cappedLog, date);

  const goalsSanityLine = formatSanityFlags(
    goalsSlateSanityChecks(results.flatMap((r) => r.assessments))
  );
  process.stdout.write(`[goals-v3] ${goalsSanityLine}\n`);

  // ── Phase 6 — selection ───────────────────────────────────────────────────
  const eventIdByKey = new Map<string, string>();
  for (const ev of index.events) {
    if (ev.eventId) eventIdByKey.set(sidecarKey(ev.home, ev.away), ev.eventId);
  }
  let selection = selectGoalsAccumulator(jobs, {
    minConfidence: config.goalsMinConfidence,
    minImplied: config.goalsMinImplied,
    target: config.goalsTargetLegs,
    detailByKey: index.detailByKey,
    eventIdByKey,
    v3: true,
  });

  // ── One slate-level LLM call ──────────────────────────────────────────────
  const verdicts = await reviewGoalsSlate(selection, { timeoutMs: goalsV3Config.arbiterTimeoutMs });
  process.stdout.write(
    `[goals-v3] slate arbiter: ${verdicts.status} — ${verdicts.drops.size} dropped, ${verdicts.flags.size} flagged\n`
  );
  selection = applySlateVerdicts(selection, verdicts);

  // LLM-readable workbook (Analysis/Slips/Capped/META_JSON) — best-effort,
  // never blocks slip delivery. Sent alongside the five Telegram slips.
  try {
    const workbookPath = await generateAndWriteGoalsWorkbook(
      { selection, results, capped: cappedLog, date, arbiterStatus: verdicts.status },
      join(ROOT, ".tmp/reports")
    );
    process.stdout.write(`[goals-v3] wrote ${workbookPath}\n`);
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      await sendTelegramDocument(
        env.TELEGRAM_BOT_TOKEN,
        env.TELEGRAM_CHAT_ID,
        workbookPath,
        `ORACLE goals v3 analysis (spreadsheet) — ${date} (${jobs.length} fixtures analyzed)`
      );
    }
  } catch (err) {
    process.stderr.write(
      `[goals-v3] WARN: workbook write/send failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`
    );
  }

  await finalizeGoalsSelection(selection, date, analysisErrors, trigger, {
    arbiterStatus: verdicts.status,
    cappedCount: cappedLog.length,
    sanityLine: goalsSanityLine,
  });
}

/** The ONLY goals pipeline (2026-06-24 rewrite): independent of the main
 *  all-markets daily batch entirely — its own SportyBet index read, its own
 *  discovery funnel (mechanical pre-filter -> Sonnet screen, goalsFunnel.ts),
 *  its own runAnalysis pass in goals-only-markets mode. Per owner instruction,
 *  the funnel scans the FULL daily SportyBet pool (potentially 1000+ fixtures)
 *  for goals-market opportunity — not whatever subset the main batch happened
 *  to analyze for all markets. Runs as its own cron slot / --run-goals-now
 *  invocation, no longer derived from or chained after the main daily batch.
 *
 *  ORACLE_GOALS_V3=true switches to the deterministic v3 pipeline
 *  (runGoalsBatchV3) immediately after the future-kickoff filter below —
 *  everything from the funnel onward is legacy-only when the flag is off. */
async function runGoalsBatch(trigger: RunManifest["trigger"] = "manual"): Promise<void> {
  const today = watDateString();
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

  if (goalsV3Config.enabled) {
    await runGoalsBatchV3(futureEvents, index, trigger);
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

  // Hard-tier sort: priority leagues first, then others. The chunk loop below then
  // analyzes from the top of this list and stops as soon as 39 actionable legs are
  // found — mirrors the daily batch approach and avoids analyzing hundreds of
  // lower-priority fixtures when priority leagues provide enough edges.
  const sortedEnrichedJobs = [...enrichedJobs].sort(
    (a, b) =>
      (ORACLE_PRIORITY_LEAGUES.has(a.league) ? 0 : 1) -
      (ORACLE_PRIORITY_LEAGUES.has(b.league) ? 0 : 1)
  );

  const goalsBatchChunks: BatchResult[] = [];
  for (let i = 0; i < sortedEnrichedJobs.length; i += ANALYSIS_CHUNK_SIZE) {
    const chunk = sortedEnrichedJobs.slice(i, i + ANALYSIS_CHUNK_SIZE);
    const chunkIdx = Math.floor(i / ANALYSIS_CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(sortedEnrichedJobs.length / ANALYSIS_CHUNK_SIZE);
    process.stdout.write(
      `[goals] chunk ${chunkIdx}/${totalChunks}: fixtures ${i + 1}–${i + chunk.length} of ${sortedEnrichedJobs.length}\n`
    );
    const analyzedSoFar = goalsBatchChunks.reduce((s, c) => s + c.completedCount, 0);
    const { batch: chunkBatch } = await runAnalysis(
      chunk,
      { storage, config },
      {
        trigger,
        writeReportToDisk: false,
        batchOptions: {
          concurrency: 3,
          onProgress: ({ completed, current }) => {
            if (current)
              process.stdout.write(
                `[goals] ${analyzedSoFar + completed}/${sortedEnrichedJobs.length}: ${current}\n`
              );
          },
        },
      }
    );
    goalsBatchChunks.push(chunkBatch);

    const cumulativeActionable = goalsBatchChunks.reduce((s, c) => s + c.actionableCount, 0);
    process.stdout.write(
      `[goals] chunk ${chunkIdx} done — ${chunkBatch.completedCount} analyzed, ` +
        `${chunkBatch.actionableCount} actionable this chunk, ${cumulativeActionable} total\n`
    );
    if (cumulativeActionable >= 39) {
      const done = goalsBatchChunks.reduce((s, c) => s + c.completedCount, 0);
      process.stdout.write(
        `[goals] 39 actionable reached after ${done}/${sortedEnrichedJobs.length} fixtures — stopping early\n`
      );
      break;
    }
  }

  const batch = mergeBatchChunks(goalsBatchChunks);

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

// ── Resolve yesterday (10:00 WAT) ───────────────────────────────────────────

async function resolveYesterdayFixtures(): Promise<void> {
  // No early-exit on missing keys — CLAUDE.md §6 no-data-blocker: resolveDay's
  // web-search consensus fallback (tools/scrape_match_results.py) always runs on
  // whatever the API chain can't resolve, including when both keys are absent.
  const storage = new MemoryAdapter(STORE_PATH);
  const yesterday = watYesterdayString();

  const { candidates, resolved, unmatched, ledgerAppended, calibrationMetrics, ledgerByFamily } =
    await resolveDay(
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
      },
      {
        mode: config.calibrationLedger,
        maxLedger: Number(process.env.ORACLE_LEDGER_MAX ?? DEFAULT_LEDGER_MAX),
      }
    );

  if (!candidates) {
    process.stdout.write(`[resolve] ${yesterday}: no candidate records\n`);
  } else {
    process.stdout.write(
      `[resolve] ${yesterday}: ${resolved.length}/${candidates} resolved, ${unmatched.length} unmatched\n`
    );
  }

  // PR-7: surface the calibration ledger update + accuracy metrics on the resolve run.
  if (calibrationMetrics) {
    process.stdout.write(
      `[calibration] ${config.calibrationLedger ?? "shadow"}: +${ledgerAppended ?? 0} settled — ${formatCalibrationMetrics(calibrationMetrics)}\n`
    );
  }
  // [audit fix] surface the per-family settle/skip breakdown so a ledger
  // that's silently biased toward 1x2-derivable families is visible in the
  // resolve log, not indistinguishable from a healthy one.
  if (ledgerByFamily) {
    const line = formatSettlementBreakdown(ledgerByFamily);
    if (line) process.stdout.write(`[calibration] ${line}\n`);
  }

  writeHeartbeat("lastResolve", {
    date: yesterday,
    candidates,
    resolved: resolved.length,
    ledgerAppended: ledgerAppended ?? 0,
    calibResolvedCount: calibrationMetrics?.resolvedCount ?? 0,
  });
}

// ── Punt prompts (10:00 WAT, retry 12:00 / 13:00 WAT until each slip is fulfilled) ──
// Two named slips per day (SLIP_LABELS — "39 Billion - Universe" and "9z 40 ACCA"),
// each prompted/retried independently. At 10:00 WAT both prompt unconditionally;
// at 12:00/13:00 WAT a slip only re-prompts if it hasn't yet received a code
// (order-based: markFulfilled, called by the bot/web when a code is processed,
// closes out whichever slip is still pending).

async function sendDailyPuntPrompt(retry: boolean): Promise<void> {
  for (let slipIndex = 0; slipIndex < SLIP_LABELS.length; slipIndex++) {
    if (retry && !shouldReprompt(ROOT, slipIndex)) continue; // already fulfilled today
    markPrompted(ROOT, slipIndex);
    await sendPuntPrompt(slipIndex);
  }
}

// Cron daemon — skipped entirely in one-shot CLI mode (see IS_ONE_SHOT above) so a
// single --run-* invocation exits cleanly instead of being held open by these timers.
if (!IS_ONE_SHOT) {
  // Must run before checkHeartbeatFreshness so a detected crash loop already
  // gates that very first back-online check, not just subsequent hourly ticks.
  checkCrashLoopOnStartup();

  // Catches "the daemon itself was dead" — the previous process's lastBatch is
  // already stale by the time this fresh process starts (see checkHeartbeatFreshness
  // comment above for the two failure modes this can and can't detect).
  void checkHeartbeatFreshness();
  void checkBotHeartbeatFreshness();

  // Every schedule below is pinned to explicit WAT (timezone: WAT_TZ) so the
  // fire time is correct regardless of the host's system clock — node-cron
  // otherwise evaluates cron expressions against the process's LOCAL
  // timezone, which silently produced a one-hour-early schedule here (this
  // box's local clock already IS WAT, so "30 8 * * *" fired at 08:30 WAT
  // local, not the intended 09:30 WAT the comments described as "08:30 UTC").
  // Fixed 2026-07-02 alongside the watDateString() staleness-date fix above —
  // see that comment for the related incident this schedule shift caused.

  // 1. Scrape + Intel Batch — 09:30 WAT. Bookmakers finalise their morning
  // lines and player props by ~09:00 WAT; 09:30 hits after the morning sync
  // completes and avoids the on-the-hour server spike. Writes the Parquet lake +
  // JSON sidecar (acquire_daily.py), runs news-intel enrichment, then sends the
  // fixture spreadsheet report to Telegram. This is now the ONLY acquisition job —
  // the old 00:00 scrape was removed so picks are sourced from one fresh morning
  // odds snapshot instead of two. Back-online: if the machine was off at this slot,
  // checkHeartbeatFreshness fires acquireDailyJob + goals immediately on daemon
  // restart (see LAKE_STALE_MS trigger above).
  cron.schedule(
    "30 9 * * *",
    () =>
      logJob("acquire-daily@09:30-WAT", async () => {
        await acquireDailyJob();
        await sendDailyFixtureReport();
      }),
    { timezone: WAT_TZ }
  );

  // 2. Main Daily Batch — 09:35 WAT slot, but its heavy work now waits (up to
  // ACQUIRE_CHAIN_TIMEOUT_MS) for the 09:30 acquire job to actually finish
  // instead of assuming 5 minutes was enough [audit fix, P0-4]. Full LLM
  // all-markets analysis -> HTML report + Telegram. Its internal scrape is
  // gap-fill-only — runDailyBatch only re-acquires when the 09:30 lake is
  // missing/stale (see isLakeFreshForToday), so this normally reuses the lake the
  // job above just wrote.
  cron.schedule(
    "35 9 * * *",
    () =>
      logJob("daily-batch@09:35-WAT", async () => {
        await awaitAcquireDailyJobOrTimeout(ACQUIRE_CHAIN_TIMEOUT_MS);
        await runDailyBatch("scheduled");
      }),
    { timezone: WAT_TZ }
  );

  // 3. Goals batch — 09:40 WAT slot, same chained-not-clocked handoff as the
  // daily batch above [audit fix, P0-4]. Independent discovery funnel
  // (mechanical pre-filter -> Sonnet screen) over the full SportyBet pool,
  // using the same fresh morning odds the lake above wrote. runGoalsBatch
  // reads the SportyBet index written by acquireDailyJob; if the scrape is
  // still in progress (in-flight guard) it waits for it via loadSportyBetIndex
  // fallback + scrapeFixtures() call inside runGoalsBatch itself.
  cron.schedule(
    "40 9 * * *",
    () =>
      logJob("goals-batch@09:40-WAT", async () => {
        await awaitAcquireDailyJobOrTimeout(ACQUIRE_CHAIN_TIMEOUT_MS);
        await runGoalsBatch("scheduled");
      }),
    { timezone: WAT_TZ }
  );

  // 4. Resolve yesterday's results — 10:00 WAT.
  cron.schedule(
    "0 10 * * *",
    () => logJob("resolve-yesterday@10:00-WAT", resolveYesterdayFixtures),
    { timezone: WAT_TZ }
  );

  // 5. Punt prompt — 10:00 WAT (first), 12:00 WAT + 13:00 WAT (retry only if no
  // code received yet). Runs alongside resolve-yesterday above; independent jobs,
  // no shared state.
  cron.schedule(
    "0 10 * * *",
    () => logJob("punt-prompt@10:00-WAT", () => sendDailyPuntPrompt(false)),
    { timezone: WAT_TZ }
  );
  cron.schedule(
    "0 12 * * *",
    () => logJob("punt-prompt-retry@12:00-WAT", () => sendDailyPuntPrompt(true)),
    { timezone: WAT_TZ }
  );
  cron.schedule(
    "0 13 * * *",
    () => logJob("punt-prompt-retry@13:00-WAT", () => sendDailyPuntPrompt(true)),
    { timezone: WAT_TZ }
  );

  // 6. Weekly Kaggle refresh — Saturday 04:00 WAT.
  cron.schedule("0 4 * * 6", () => logJob("kaggle-refresh", runWeeklyKaggleRefresh), {
    timezone: WAT_TZ,
  });

  // 7. Heartbeat freshness check — every hour, on the hour (timezone is a
  // no-op for an every-hour cadence, but pinned for consistency).
  cron.schedule("0 * * * *", () => void checkHeartbeatFreshness(), { timezone: WAT_TZ });

  // 8. Bot heartbeat check — every 10 min (its own staleness threshold is
  // 10 min, not the 36h daily-batch threshold, so it needs tighter polling).
  cron.schedule("*/10 * * * *", () => void checkBotHeartbeatFreshness(), { timezone: WAT_TZ });
}

// Graceful shutdown — stop cron schedules so the daemon exits cleanly under SIGINT/SIGTERM.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    process.stdout.write(`[worker] ${sig} received — stopping cron schedules\n`);
    for (const task of cron.getTasks().values()) task.stop();
    // Only the daemon writes PROCESS_STATE_FILE (checkCrashLoopOnStartup is
    // gated the same way) — a one-shot invocation signaled mid-run must not
    // stamp cleanExit:true over the daemon's own crash-loop tracking.
    if (!IS_ONE_SHOT) markCleanExit();
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

if (process.argv.includes("--run-report-now")) {
  void runOnce("--run-report-now", sendDailyFixtureReport);
}
