/** ORACLE scheduled worker — thin cron shell.
 *  node-cron daily batch (09:00) + resolve-yesterday (14:00).
 *  All analysis/fixture/report logic lives in @oracle/runtime; this file only schedules. */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sendPuntPrompt } from "@oracle/bot";
import type { RunManifest } from "@oracle/engine";
import type { ActionablePick, BatchSummary } from "@oracle/notify";
import { buildNotifiers, notifyAll, summarizeBatch } from "@oracle/notify";
import {
  buildConfig,
  fetchTodaysFixtures,
  loadEnv,
  loadSportyBetIndex,
  markPrompted,
  resolveDay,
  runAnalysis,
  selectGoalsAccumulator,
  shouldReprompt,
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
}

// ── Goals-only accumulator (08:30 UTC = 09:30 WAT) ────────────────────────────
// Independent pipeline: reuses the engine output but selects ONLY Over 1.5 /
// Over 2.5 / Team Over 0.5 legs whose data heavily supports goals, ranks them by
// model confidence, caps at goalsTargetLegs (a ceiling, never a fill target),
// books one SportyBet code, and pushes a goals-tagged Telegram message. Shares no
// state with runDailyBatch.

const GOALS_TAG = "GOALS ACCA (Over 1.5/2.5/Team 0.5)";

async function runGoalsBatch(trigger: RunManifest["trigger"] = "scheduled"): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  // Reuse a fresh sidecar; scrape only when stale (date !== today) to avoid a
  // redundant Playwright run when the 06:00/09:00 scrape already ran.
  let index = await loadSportyBetIndex(today);
  if (!index) {
    const sportyBetCount = await scrapeFixtures();
    checkSportyBetStreak(sportyBetCount);
    index = await loadSportyBetIndex(today);
  }

  const storage = new MemoryAdapter(STORE_PATH);
  const newsKey = config.enableNewsIntel ? config.perplexityApiKey : undefined;
  const newsStorage = config.enableNewsIntel ? storage : undefined;
  const { jobs } = await fetchTodaysFixtures(
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
    return;
  }

  const { batch, reportPath } = await runAnalysis(
    jobs,
    { storage, config },
    {
      trigger,
      batchOptions: {
        onProgress: ({ completed, total, current }) => {
          if (current) process.stdout.write(`[goals] ${completed}/${total}: ${current}\n`);
        },
      },
    }
  );

  const selection = selectGoalsAccumulator(batch.jobs, {
    minConfidence: config.goalsMinConfidence,
    minImplied: config.goalsMinImplied,
    target: config.goalsTargetLegs,
    detailByKey: index?.detailByKey,
  });

  process.stdout.write(
    `[goals] selected ${selection.legs.length}/${selection.target} ` +
      `(over15=${selection.counts.over15} over25=${selection.counts.over25} ` +
      `teamover05=${selection.counts.teamOver05}; qualified=${selection.qualified} of ${selection.analysed})\n`
  );

  const actionable: ActionablePick[] = selection.legs.map((l) => ({
    home: l.home,
    away: l.away,
    league: l.league,
    kickoff: l.kickoff,
    market: l.market,
    side: l.side,
    odds: l.odds,
    stakePct: 0, // accumulator leg — no per-leg Kelly stake
    confidence: l.mp,
  }));

  const summary: BatchSummary = {
    date: `${batch.date} — ${GOALS_TAG}`,
    analysed: selection.analysed,
    actionableCount: actionable.length,
    errors: batch.errorCount,
    actionable,
    ...(reportPath ? { reportUrl: reportPath } : {}),
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
          process.stdout.write(`[goals-booking] ${booking.code}: ${booking.loadUrl}\n`);
        if (booking.unmatched.length)
          process.stderr.write(
            `[goals-booking] ${booking.unmatched.length} leg(s) unmatched on SportyBet\n`
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

  writeHeartbeat("lastGoalsBatch", {
    trigger,
    analysed: selection.analysed,
    legs: selection.legs.length,
    target: selection.target,
    booked: Boolean(summary.bookingCode),
  });
}

// ── Resolve yesterday (14:00) ────────────────────────────────────────────────

async function resolveYesterdayFixtures(): Promise<void> {
  if (!config.footballDataApiKey && !config.apiFootballKey) {
    process.stderr.write(
      "[resolve] skipped — neither FOOTBALL_DATA_API_KEY nor API_FOOTBALL_KEY set\n"
    );
    return;
  }
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

  // Fixture scrape — standalone runs (12am, 6am, 11:45am)
  cron.schedule("0 0 * * *", () => logJob("scrape-fixtures@00:00", scrapeFixtures));
  cron.schedule("0 6 * * *", () => logJob("scrape-fixtures@06:00", scrapeFixtures));
  cron.schedule("45 11 * * *", () => logJob("scrape-fixtures@11:45", scrapeFixtures));

  // Goals-only accumulator (08:30 UTC = 09:30 WAT) — reuses fresh sidecar, scrapes if stale
  cron.schedule("30 8 * * *", () => logJob("goals-batch", () => runGoalsBatch("scheduled")));

  // Daily batch (09:00) — scrapeFixtures() runs as its first step
  cron.schedule("0 9 * * *", () => logJob("daily-batch", () => runDailyBatch("scheduled")));

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
