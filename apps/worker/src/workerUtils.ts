/** [PR-9, worker god-file split] Shared helpers used by index.ts AND by 2+ of
 *  the extracted pipeline modules (dailyAcquisition.ts, dailyBatch.ts,
 *  goalsAccumulator.ts, resolveYesterday.ts) — kept here instead of in index.ts
 *  so importing them never creates a circular import back into index.ts.
 *
 *  Four families:
 *   - WAT calendar helpers (watDateString/watYesterdayString/watMinutesSinceMidnight)
 *   - Heartbeat-file state (writeHeartbeat + the read-side helpers that share
 *     the same on-disk file) and the lake-freshness check built on top of it.
 *   - mergeBatchChunks: a pure BatchResult-merge helper shared by both
 *     dailyBatch.ts's runDailyBatch and goalsAccumulator.ts's legacy
 *     runGoalsBatch chunk loops. It lives here rather than in either pipeline
 *     file because dailyBatch.ts already imports buildGoalsCrossCheckHook from
 *     goalsV3Pipeline.ts, which in turn imports finalizeGoalsSelection from
 *     goalsAccumulator.ts — putting mergeBatchChunks in either dailyBatch.ts
 *     or goalsAccumulator.ts and importing it from the other would close a
 *     second, longer import cycle back into dailyBatch.ts.
 *   - runPythonScript [PR-10]: the shared execFile(python, [script]) wrapper
 *     every worker Python-tool call site used to reimplement inline, with an
 *     opt-in DNS-aware retry for the two real scrape entry points.
 */

import { type ExecFileException, execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BatchResult } from "@oracle/engine";
import { isRetriableNetworkError, withRetry } from "@oracle/engine";
import { fixturesPartitionExists } from "@oracle/runtime";
import { ROOT } from "./workerContext.js";

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
// cron.schedule() call in index.ts so the schedule no longer depends on the
// host's system clock (see the cron-daemon block's comment for the incident this fixes).
export const WAT_TZ = "Africa/Lagos";

export function watDateString(d: Date = new Date()): string {
  return new Date(d.getTime() + WAT_OFFSET_MS).toISOString().slice(0, 10);
}

export function watYesterdayString(d: Date = new Date()): string {
  return watDateString(new Date(d.getTime() - 86_400_000));
}

export function watMinutesSinceMidnight(d: Date = new Date()): number {
  const watDate = new Date(d.getTime() + WAT_OFFSET_MS);
  return watDate.getUTCHours() * 60 + watDate.getUTCMinutes();
}

// ── Job logging + heartbeat ───────────────────────────────────────────────────
// Every cron job runs through logJob (index.ts) so a failure is always visible
// in the log, and successful batch/resolve runs stamp .tmp/worker_heartbeat.json
// (read by the web /health endpoint) so a silently-dead worker is detectable.

export const HEARTBEAT_FILE = join(ROOT, ".tmp", "worker_heartbeat.json");

export function writeHeartbeat(event: string, detail: Record<string, unknown> = {}): void {
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

// Fixture-report follow-up state: when sendDailyFixtureReport() blocks — either
// on no fixtures at all, or on marketsEmpty — it stamps fixtureReportPlaceholder
// (with a `reason` so the two distinct blocked states don't suppress each
// other's one-time Telegram notice on the same day) so the hourly heartbeat
// tick (checkHeartbeatFreshness, index.ts) knows to retry until the enriched
// spreadsheet ships (stamped as fixtureReportDelivered) — see
// dailyAcquisition.ts's sendDailyFixtureReport for both send sites.
export function readFixtureReportState(): {
  placeholderDate?: string;
  placeholderReason?: string;
  deliveredDate?: string;
} {
  try {
    const current = JSON.parse(readFileSync(HEARTBEAT_FILE, "utf8")) as Record<
      string,
      { date?: string; reason?: string } | undefined
    >;
    return {
      placeholderDate: current.fixtureReportPlaceholder?.date,
      placeholderReason: current.fixtureReportPlaceholder?.reason,
      deliveredDate: current.fixtureReportDelivered?.date,
    };
  } catch {
    return {};
  }
}

// Lake-staleness back-online trigger: unlike the plain staleness alert
// (checkHeartbeatFreshness, index.ts), this gates whether runDailyBatch
// (dailyBatch.ts) needs to re-run acquisition itself.
const LAKE_STALE_MS = 20 * 60 * 60 * 1000; // ~20h — same-day acquisition is always fresher than this

/** True when today's Parquet-lake partition was written by a successful
 *  acquireDailyJob run within the last LAKE_STALE_MS — gates both
 *  runDailyBatch's gap-fill scrape (dailyBatch.ts) and the back-online
 *  trigger in checkHeartbeatFreshness (index.ts). */
export function isLakeFreshForToday(): boolean {
  const lastAcquire = readLastAcquire();
  if (!lastAcquire?.date || !lastAcquire.at) return false;
  if (lastAcquire.date !== watDateString()) return false;
  if (Date.now() - new Date(lastAcquire.at).getTime() >= LAKE_STALE_MS) return false;
  // Heartbeat alone can lie if the lake directory was deleted/moved after a
  // successful acquisition stamped it — confirm the partition is still on disk.
  return fixturesPartitionExists(lastAcquire.date);
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
export function logMemoryUsage(label: string): void {
  const mem = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  process.stdout.write(
    `[mem] ${label} heapUsedMB=${mb(mem.heapUsed)} rssMB=${mb(mem.rss)} externalMB=${mb(mem.external)}\n`
  );
}

// ── Batch chunk merge ────────────────────────────────────────────────────────

/** Merge multiple BatchResult chunks (from the priority-ordered chunk loop) into a
 *  single BatchResult so downstream summarizeBatch / selectGoalsAccumulator callers
 *  see one unified result, identical to what a single runAnalysis call would return. */
export function mergeBatchChunks(chunks: BatchResult[]): BatchResult {
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

// ── Python tool runner ───────────────────────────────────────────────────────
// [PR-10] Consolidates the execFile(python, [script, ...args]) promise-wrapper
// shape that dailyAcquisition.ts (5x), dailyBatch.ts (1x), and
// goalsAccumulator.ts (1x) each reimplemented independently before this PR.

export interface PythonRunResult {
  err: ExecFileException | null;
  stdout: string;
  stderr: string;
}

// A spawned Python process's network failures speak a different vocabulary
// than Node's — requests/Playwright raise "getaddrinfo failed"/"Name or
// service not known"/"ERR_NAME_NOT_RESOLVED", landed in stderr, not in
// execFile's err.message (which is just "Command failed: ..."). Check both
// isRetriableNetworkError (Node-side, e.g. a bad PYTHON_BIN path) and this
// stderr pattern (Python-side) so a transient DNS/connection blip is caught
// whichever side reports it — the same failure class already observed for
// Telegram AND scrapers (oracle_dns_and_llm_session_limit_investigation).
function isRetriableScrapeFailure(err: ExecFileException | null, stderr: string): boolean {
  if (!err) return false;
  if (isRetriableNetworkError(err)) return true;
  return /getaddrinfo failed|name or service not known|err_name_not_resolved|failed to establish a new connection|max retries exceeded|connection aborted|err_connection/i.test(
    stderr
  );
}

/** Runs `python script args...` via execFile, resolving with `{ err, stdout,
 *  stderr }` — never rejects, matching every existing call site's own
 *  best-effort logging/degrade behavior (a failed tool run must never abort
 *  the caller's job). Pass retryOnNetworkError for the two real
 *  network-scrape entry points (acquireDaily, scrapeFixtures) to retry a
 *  transient DNS/connection failure (with backoff) before giving up — not
 *  worth it for the lower-stakes best-effort tools (kaggle refresh, lineups,
 *  closing-odds, fotmob-xg), which already degrade gracefully on any single
 *  failure. */
export function runPythonScript(
  python: string,
  script: string,
  args: string[],
  opts: { cwd: string; retryOnNetworkError?: boolean }
): Promise<PythonRunResult> {
  const attempt = (): Promise<PythonRunResult> =>
    new Promise((resolve) => {
      execFile(python, [script, ...args], { cwd: opts.cwd }, (err, stdout, stderr) => {
        resolve({ err, stdout, stderr });
      });
    });
  if (!opts.retryOnNetworkError) return attempt();
  let last: PythonRunResult = { err: null, stdout: "", stderr: "" };
  return withRetry(
    async () => {
      last = await attempt();
      if (isRetriableScrapeFailure(last.err, last.stderr)) throw last.err;
      return last;
    },
    2,
    (n) => 5_000 * 2 ** n,
    () => true // the wrapped fn above only throws when isRetriableScrapeFailure already said yes
  ).catch(() => last); // retries exhausted — resolve with the last real attempt, never reject
}
