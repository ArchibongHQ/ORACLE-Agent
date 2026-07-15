/** ORACLE scheduled worker — thin cron shell.
 *  node-cron, single morning sequence (WAT = UTC+1): acquire-daily + fixture
 *  report @09:30 WAT -> unified batch @09:35 WAT (main all-markets batch,
 *  delivering the v5 Phase 7 four-output message + mini-ACCA appendix, then
 *  the goals-only discovery funnel over the full SportyBet pool, delivering
 *  its own single consolidated "goals supplement" message) -> resolve-
 *  yesterday + punt prompt @10:00 WAT (retries @12:00/13:00 WAT). The two
 *  09:35/09:40 slots were merged 2026-07-10 — daily and goals now run
 *  sequentially in one job instead of two clock-adjacent cron slots, making
 *  the goals pipeline's cross-batch-veto ordering dependency on the daily
 *  batch's RunManifests structural rather than a five-minute clock assumption.
 *  All analysis/fixture/report logic lives in @oracle/runtime; this file only schedules. */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sendPuntPrompt } from "@oracle/bot";
import { type BatchSummary, buildNotifiers, notifyAll } from "@oracle/notify";
import { markPrompted, SLIP_LABELS, shouldReprompt } from "@oracle/runtime";
import cron from "node-cron";
import { checkBuildFreshness, setStaleBuildNote } from "./buildFreshness.js";
import { loadCatalogOverlay } from "./catalogOverlay.js";
import {
  acquireDailyJob,
  awaitAcquireDailyJobOrTimeout,
  closingOddsSweepJob,
  runFotmobXgRefresh,
  runWeeklyKaggleRefresh,
  sendDailyFixtureReport,
} from "./dailyAcquisition.js";
import { runDailyBatch } from "./dailyBatch.js";
import { printEffectiveConfig } from "./effectiveConfig.js";
import { runGoalsBatch } from "./goalsAccumulator.js";
import { resolveYesterdayFixtures } from "./resolveYesterday.js";
import { config, env, MARKET_CATALOG_OVERLAY_PATH, PYTHON_BIN, ROOT } from "./workerContext.js";
import {
  HEARTBEAT_FILE,
  isLakeFreshForToday,
  logMemoryUsage,
  readFixtureReportState,
  runPythonScript,
  WAT_TZ,
  watDateString,
  watMinutesSinceMidnight,
} from "./workerUtils.js";

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

// PR-11: one-time startup dump of the resolved ORACLE_* flags, ahead of the
// IS_ONE_SHOT branch below so it prints for one-shot CLI runs too, not just
// the cron daemon — a misconfigured deploy should be visible from the first
// log line, not discovered hours later from unexplained behavior.
printEffectiveConfig();

// Build-freshness watchdog — flags any workspace package whose dist/ predates
// its own src/ (a rebuild was skipped/forgotten before this deploy started).
// Ahead of the IS_ONE_SHOT branch below, same rationale as printEffectiveConfig
// just above: a stale-dist deploy should be visible from the first log lines,
// for one-shot CLI runs too, not just the cron daemon. Never throws
// (checkBuildFreshness's own try/catch) and never blocks startup either way.
const staleBuildWarnings = checkBuildFreshness(ROOT);
for (const w of staleBuildWarnings) {
  process.stderr.write(`[build-freshness] WARN ${w}\n`);
}
if (staleBuildWarnings.length > 0) {
  setStaleBuildNote(`⚠️ build freshness: ${staleBuildWarnings.join("; ")}`);
}

// PR-21: runtime catalog overlay (markets observed since catalog.generated.ts
// was last regenerated) — loaded once at process start, ahead of the
// IS_ONE_SHOT branch below, so it's active for one-shot CLI runs too, not
// just the cron daemon. ORACLE_CATALOG_OVERLAY=on to enable (default off).
if (config.catalogOverlay) {
  const added = loadCatalogOverlay(join(ROOT, MARKET_CATALOG_OVERLAY_PATH));
  if (added > 0) process.stdout.write(`[catalog] overlay: +${added} ids\n`);
}

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
// WAT calendar (watDateString/watYesterdayString/watMinutesSinceMidnight/WAT_TZ)
// and writeHeartbeat live in ./workerUtils.js — see there for the WAT-vs-UTC
// incident this depends on getting right.

const BOT_HEARTBEAT_FILE = join(ROOT, ".tmp", "bot_heartbeat.json");

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

// [audit fix, P0-4] Cap on how long the 09:35 unified batch (and its
// back-online equivalents) wait for the 09:30 acquire job before proceeding
// anyway (awaitAcquireDailyJobOrTimeout) — the "fallback cron" half of the
// fix: a hung/dead acquire job must not permanently starve the rest of the
// day's pipeline.
const ACQUIRE_CHAIN_TIMEOUT_MS = 20 * 60 * 1000; // 20 min

// [reliability fix] Hard ceiling on resolveYesterdayFixtures — confirmed live:
// a 2026-07-11 internet outage wedged this job 2+ hours with no ceiling at
// all (no job-level timeout existed anywhere in its call chain). Applied at
// every call site below (10:00 WAT cron, --run-now, --run-resolve), not just
// the cron slot, via resolveYesterdayWithTimeout.
const RESOLVE_YESTERDAY_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

/** Races resolveYesterdayFixtures() against RESOLVE_YESTERDAY_TIMEOUT_MS — same
 *  Promise.race idiom as acquireChain.ts's awaitAcquireOrTimeout, adapted here
 *  as a self-contained wrapper (no shared "in-flight" tracking needed since,
 *  unlike the acquire chain, nothing else waits on this particular job from a
 *  second call site). On timeout this logs and returns so the caller (logJob,
 *  or a one-shot --run-* invocation) isn't blocked — the underlying job is NOT
 *  cancelled, it keeps running in the background and its eventual result is
 *  discarded (see resolveFixtures.ts's own web-search-sweep cap and
 *  fixtures.ts's killProcessTree for the pieces of that background work that
 *  DO get torn down). The timer is cleared on whichever branch wins so a fast
 *  run doesn't hold the process open for the full 15 minutes in one-shot CLI
 *  mode — see runOnce's comment above on why the event loop must drain
 *  naturally here, not via process.exit(). */
function resolveYesterdayWithTimeout(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      process.stderr.write(
        `[worker] resolve-yesterday timed out after ${RESOLVE_YESTERDAY_TIMEOUT_MS / 60_000}min — abandoning this run\n`
      );
      resolve();
    }, RESOLVE_YESTERDAY_TIMEOUT_MS);
  });
  return Promise.race([resolveYesterdayFixtures(), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isDailyBatchFreshForToday(lastBatchAt: string | undefined): boolean {
  if (!lastBatchAt) return false;
  if (watDateString(new Date(lastBatchAt)) !== watDateString()) return false;
  return Date.now() - new Date(lastBatchAt).getTime() < DAILY_BATCH_STALE_MS;
}

// Lake-staleness back-online trigger: unlike the alert above, this actively
// re-runs acquisition rather than just notifying — so a daemon that was down
// across 09:30 WAT catches up as soon as it restarts, instead of waiting for
// tomorrow's cron slot. Freshness window (LAKE_STALE_MS) lives in
// ./workerUtils.js's isLakeFreshForToday, imported above.
let lastLakeTriggerAt = 0;
const LAKE_TRIGGER_REPEAT_MS = 6 * 60 * 60 * 1000; // don't retry a failing acquisition more than every 6h

// readFixtureReportState/isLakeFreshForToday live in ./workerUtils.js — both
// read the same HEARTBEAT_FILE imported above.

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
    // After back-online acquisition completes, send the fixture report only —
    // deliberately does NOT also fire runGoalsBatch here [2026-07-10 cron
    // merge]. The daily-batch back-online trigger below now runs the full
    // unified daily->goals sequence, and both `if` blocks in this function
    // read `lastBatchAt` from the SAME heartbeat snapshot at the top of this
    // pass — a true back-online case (machine off across both 09:30 AND 09:35
    // WAT) has both the lake AND the daily batch stale simultaneously, so
    // both blocks fire in the same pass. Running runGoalsBatch from both
    // would double-run it for the same day. The daily-batch trigger's own
    // awaitAcquireDailyJobOrTimeout already waits for the acquireDailyJob this
    // block kicks off, so deferring the unified sequence to it is safe, not
    // just non-duplicating. (Known accepted gap: if runDailyBatch succeeds —
    // which writes the lastBatch heartbeat isDailyBatchFreshForToday checks —
    // but the chained runGoalsBatch then throws, no back-online trigger will
    // retry goals until the next calendar day; same class of gap as any other
    // logJob() failure here, which logs and does not auto-retry.)
    logJob("acquire-daily@back-online", async () => {
      await acquireDailyJob();
      await sendDailyFixtureReport();
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
    //
    // [2026-07-10 cron merge] This is now also the SOLE back-online path for
    // runGoalsBatch — the lake/acquire trigger above deliberately stopped
    // calling it (see that trigger's comment) so a back-online restart runs
    // the unified daily->goals sequence exactly once, mirroring the merged
    // 09:35 WAT cron job's own daily-then-goals order (structural dependency:
    // goals' cross-batch veto reads the RunManifests runDailyBatch just wrote).
    logJob("unified-batch@back-online", async () => {
      await awaitAcquireDailyJobOrTimeout(ACQUIRE_CHAIN_TIMEOUT_MS);
      await runDailyBatch("scheduled");
      await runGoalsBatch("scheduled");
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

// logMemoryUsage lives in ./workerUtils.js — instrumentation added while
// diagnosing the 2026-07-05 worker OOM (see oracle_machine_crash_2026_07_05 memory).

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

// ── GBM re-validation (Wave-2 telemetry, WS2-E) ─────────────────────────────
// tools/gbm_residual.py re-trains + walk-forward validates the residual GBM
// against Pinnacle-devigged closing odds and reports the RPS delta vs the
// +0.002 accept-gate threshold (PRD §8.3 / RPS_IMPROVEMENT_THRESHOLD in that
// script). This is intentionally cadenced to ~4 gameweeks (~28 days), not
// weekly: a gameweek's worth of new results barely moves a walk-forward RPS
// estimate, so re-running every 7 days would just burn CPU/log noise for no
// new signal. node-cron has no native "every N weeks" expression that stays
// aligned across month boundaries (cron's day-of-month field can't express
// "every 28 days" without drifting once months of differing length are
// involved), so this uses the simpler, more robust combination: a WEEKLY cron
// tick (same Sunday 03:00 WAT slot pattern as the other off-peak jobs in this
// file) gated by an internal last-run timestamp — the job itself is a no-op
// on any tick inside the 28-day window, and self-heals if a tick is missed
// (a dead process across several Sundays just runs late on the next tick,
// same back-online philosophy as the other staleness checks above).
//
// ⚠️ NON-NEGOTIABLE: this job NEVER flips ORACLE_V3_RATINGS, ORACLE_GBM_*, or
// any other config flag, no matter what the validation reports. Per this
// repo's standing rule, GBM/ratings graduate to shadow/live ONLY by a human
// reading this log and clearing the +0.002 RPS significance bar by hand —
// never by code. This job's ENTIRE job is to log the result somewhere a
// human will see it; it must not import or call anything from env.ts,
// workerContext.ts's config, or any flag-writing path.
const GBM_REVALIDATION_STATE_FILE = join(ROOT, ".tmp", "gbm_revalidation_state.json");
const GBM_REVALIDATION_INTERVAL_MS = 28 * 24 * 60 * 60 * 1000; // ~4 gameweeks

function shouldRunGbmRevalidation(): boolean {
  try {
    const raw = readFileSync(GBM_REVALIDATION_STATE_FILE, "utf8");
    const state = JSON.parse(raw) as { lastRunAt?: string };
    if (!state.lastRunAt) return true;
    return Date.now() - new Date(state.lastRunAt).getTime() >= GBM_REVALIDATION_INTERVAL_MS;
  } catch {
    return true; // no state file yet (first tick ever) or corrupt — run and (re)establish it
  }
}

function writeGbmRevalidationState(): void {
  try {
    const tmpPath = `${GBM_REVALIDATION_STATE_FILE}.tmp`;
    writeFileSync(
      tmpPath,
      JSON.stringify({ lastRunAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
    renameSync(tmpPath, GBM_REVALIDATION_STATE_FILE); // atomic, same pattern as writeProcessState above
  } catch (err) {
    process.stderr.write(`[gbm-revalidation] state write failed: ${String(err)}\n`);
  }
}

/** Runs tools/gbm_residual.py to completion and logs its RPS-delta verdict.
 *  Read-only w.r.t. config/flags — see the non-negotiable comment above. Same
 *  best-effort execFile pattern as the other Python-tool crons in this repo
 *  (see dailyAcquisition.ts's runFotmobXgRefresh): a failure here degrades to
 *  a stderr log line, never throws, never takes down the worker daemon. */
async function runGbmRevalidation(): Promise<void> {
  if (!shouldRunGbmRevalidation()) {
    process.stdout.write("[gbm-revalidation] skipped — last run within the 28-day window\n");
    return;
  }
  const python = PYTHON_BIN;
  const script = join(ROOT, "tools", "gbm_residual.py");
  const start = Date.now();
  const { err, stdout, stderr } = await runPythonScript(python, script, [], { cwd: ROOT });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (err) {
    process.stderr.write(`[gbm-revalidation] FAILED after ${elapsed}s — ${err.message}\n`);
    // Do NOT update the state timestamp on failure — a failed run should not
    // block a retry on the next weekly tick from re-attempting sooner than 28 days.
    return;
  }
  process.stdout.write(
    `[gbm-revalidation] done in ${elapsed}s — see PASS/FAIL verdict above vs the +0.002 RPS ` +
      "accept gate. Read-only: no flag was touched by this job regardless of the result.\n"
  );
  writeGbmRevalidationState();
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

  // 1. FotMob live-xG refresh — 02:00 WAT (PR-7). Standalone and off-peak by
  // design: runs acquire_daily.py --live-xg-refresh, which reads the
  // SportyBet sidecar already on disk (from the last acquire-daily run, not a
  // fresh scrape) for team names, then runs FotMob + build_xg_table. Its own
  // Playwright browser-page swarm (fetch_fotmob_batch) used to run INLINE
  // inside acquire-daily's 09:30 critical path, sequentially stacked after
  // that job's own SportyBet/BBC/Flashscore Playwright swarm — never
  // concurrent, but extending how long the process held multiple swarms'
  // memory (the actual pressure class behind the 2026-07-05 BSOD/OOM crisis).
  // Decoupled here so nothing else is scraping at 02:00; gated by
  // ORACLE_FETCH_LIVE_XG (default on now that the collision risk is gone).
  cron.schedule("0 2 * * *", () => logJob("fotmob-xg-refresh@02:00-WAT", runFotmobXgRefresh), {
    timezone: WAT_TZ,
  });

  // 2. Scrape + Intel Batch — 09:30 WAT. Bookmakers finalise their morning
  // lines and player props by ~09:00 WAT; 09:30 hits after the morning sync
  // completes and avoids the on-the-hour server spike. Writes the Parquet lake +
  // JSON sidecar (acquire_daily.py), runs news-intel enrichment, then sends the
  // fixture spreadsheet report to Telegram. This is now the ONLY acquisition job —
  // the old 00:00 scrape was removed so picks are sourced from one fresh morning
  // odds snapshot instead of two. Back-online: if the machine was off at this slot,
  // checkHeartbeatFreshness fires acquireDailyJob + report immediately on daemon
  // restart (see workerUtils.ts's isLakeFreshForToday/LAKE_STALE_MS); the unified
  // daily->goals sequence itself is deferred to the daily-batch back-online
  // trigger below, not fired from here — see that trigger's own comment for why.
  cron.schedule(
    "30 9 * * *",
    () =>
      logJob("acquire-daily@09:30-WAT", async () => {
        await acquireDailyJob();
        await sendDailyFixtureReport();
      }),
    { timezone: WAT_TZ }
  );

  // 3. Unified Batch — 09:35 WAT slot (merged 2026-07-10; previously two
  // adjacent cron slots, main all-markets @09:35 + goals-only @09:40). The
  // goals pipeline's cross-batch veto (goalsV3Pipeline.ts's
  // loadTodaysCompletedLegs) reads the RunManifests runDailyBatch just wrote —
  // daily MUST complete before goals starts. Five minutes of clock separation
  // happened to satisfy that in practice, but was never a guarantee (a slow
  // daily-batch chunk loop overrunning past :40 would race the goals cron
  // tick). Running them sequentially in one job makes the dependency
  // structural: goals literally cannot start until runDailyBatch's own await
  // resolves, not "usually five minutes later." Heavy work still waits (up to
  // ACQUIRE_CHAIN_TIMEOUT_MS) for the 09:30 acquire job to actually finish
  // instead of assuming a fixed delay was enough [audit fix, P0-4].
  // runDailyBatch's internal scrape is gap-fill-only (reuses the 09:30 lake
  // when fresh); runGoalsBatch's discovery funnel (mechanical pre-filter ->
  // Sonnet screen) runs over the FULL SportyBet pool independently of
  // whatever subset runDailyBatch analyzed, using the same fresh morning
  // odds. Delivery: runDailyBatch sends the v5 Phase 7 four-output message
  // (Outputs A-D + mini-ACCA appendix — see slateOutputs.ts); runGoalsBatch
  // sends its own single consolidated "goals supplement" message (was five
  // separate slips — see goalsAccumulator.ts's finalizeGoalsSelection).
  cron.schedule(
    "35 9 * * *",
    () =>
      logJob("unified-batch@09:35-WAT", async () => {
        await awaitAcquireDailyJobOrTimeout(ACQUIRE_CHAIN_TIMEOUT_MS);
        await runDailyBatch("scheduled");
        await runGoalsBatch("scheduled");
      }),
    { timezone: WAT_TZ }
  );

  // 4. Resolve yesterday's results — 10:00 WAT.
  cron.schedule(
    "0 10 * * *",
    () => logJob("resolve-yesterday@10:00-WAT", resolveYesterdayWithTimeout),
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

  // 9. Closing-odds sweep — every 5 min (PR-8a). Timezone pin is a no-op for
  // this cadence (minutes are timezone-invariant) — kept for consistency with
  // the hourly/10-min jobs above. Restart-safe: re-derives "who's due" from
  // storage every tick rather than tracking any in-memory per-fixture timer.
  cron.schedule("*/5 * * * *", () => logJob("closing-odds-sweep", closingOddsSweepJob), {
    timezone: WAT_TZ,
  });

  // 10. GBM re-validation — Sunday 03:00 WAT (weekly cron tick, internally
  // gated to ~4 gameweeks — see runGbmRevalidation's header comment for why
  // this shape was chosen over trying to express "every 28 days" in cron
  // syntax directly). Telemetry only: logs the tools/gbm_residual.py RPS-delta
  // verdict vs the +0.002 accept gate. NEVER auto-enables ORACLE_V3_RATINGS or
  // any other flag — see the loud warning on runGbmRevalidation itself.
  cron.schedule("0 3 * * 0", () => logJob("gbm-revalidation@sun-03:00-WAT", runGbmRevalidation), {
    timezone: WAT_TZ,
  });
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
    await resolveYesterdayWithTimeout();
  });
}

if (process.argv.includes("--run-goals-now")) {
  void runOnce("--run-goals-now", () => runGoalsBatch("manual"));
}

if (process.argv.includes("--refresh-kaggle")) {
  void runOnce("--refresh-kaggle", () => runWeeklyKaggleRefresh());
}

if (process.argv.includes("--run-resolve")) {
  void runOnce("--run-resolve", () => resolveYesterdayWithTimeout());
}

if (process.argv.includes("--run-report-now")) {
  void runOnce("--run-report-now", sendDailyFixtureReport);
}
