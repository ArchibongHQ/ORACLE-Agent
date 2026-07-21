/** Phase 5 (scrape-triggered batch) — the shared daily->goals sequence,
 *  extracted so three independent trigger points (09:35 WAT cron, the
 *  back-online hourly check, and a new immediate hook fired right after a
 *  successful morning scrape) all funnel through ONE in-flight-guarded,
 *  freshness-gated entry point instead of duplicating the same body at
 *  three call sites racing each other.
 *
 *  Whichever trigger reaches runUnifiedBatchOnce first does the real work;
 *  the others become no-ops — either the in-flight guard (a run is already
 *  underway) or the freshness check (today's batch already completed). The
 *  scrape-complete hook is the interesting new case: on a normal morning it
 *  reaches here first, well ahead of the 09:35 WAT cron tick, so the cron
 *  and back-online triggers become the redundant fallback path instead of
 *  the primary one — the batch now starts the moment data is actually
 *  ready, not on a fixed wall-clock guess of when that usually happens. */

import { ACQUIRE_CHAIN_TIMEOUT_MS, awaitAcquireDailyJobOrTimeout } from "./dailyAcquisition.js";
import { runDailyBatch } from "./dailyBatch.js";
import { runGoalsBatch } from "./goalsAccumulator.js";
import { readLastBatch, watDateString } from "./workerUtils.js";

/** Same-day freshness window for a completed unified batch — unchanged from
 *  index.ts's pre-Phase-5 DAILY_BATCH_STALE_MS, moved here since this module
 *  is now the one place that decides "should a batch run happen." */
const DAILY_BATCH_STALE_MS = 20 * 60 * 60 * 1000; // ~20h — same-day batch is always fresher than this

/** Exported so index.ts's checkHeartbeatFreshness can use the identical
 *  freshness rule for its own outer "should we even attempt a back-online
 *  trigger" gate — single source of truth, not two independently-maintained
 *  copies of the same 20h/same-WAT-date logic. */
export function isDailyBatchFreshForToday(lastBatchAt: string | undefined): boolean {
  if (!lastBatchAt) return false;
  if (watDateString(new Date(lastBatchAt)) !== watDateString()) return false;
  return Date.now() - new Date(lastBatchAt).getTime() < DAILY_BATCH_STALE_MS;
}

export type UnifiedBatchTrigger = "cron" | "back-online" | "scrape-complete";

let _unifiedBatchInFlight: Promise<void> | null = null;

/** Run the daily->goals sequence exactly once for today, no matter which
 *  trigger reaches this function first. Race-safe across all three trigger
 *  points: the in-flight guard makes a second concurrent caller await the
 *  SAME promise instead of starting a duplicate run; the freshness check
 *  (read fresh from the heartbeat file on every call, not cached) makes a
 *  later caller — once today's batch already completed via an earlier
 *  trigger — a fast no-op instead of a redundant re-run. */
export function runUnifiedBatchOnce(trigger: UnifiedBatchTrigger): Promise<void> {
  if (_unifiedBatchInFlight) {
    process.stdout.write(`[unified-batch] skip (${trigger}) — already running\n`);
    return _unifiedBatchInFlight;
  }
  if (isDailyBatchFreshForToday(readLastBatch()?.at)) {
    process.stdout.write(`[unified-batch] skip (${trigger}) — already fresh for today\n`);
    return Promise.resolve();
  }
  process.stdout.write(`[unified-batch] starting (trigger: ${trigger})\n`);
  const run = (async () => {
    await awaitAcquireDailyJobOrTimeout(ACQUIRE_CHAIN_TIMEOUT_MS);
    await runDailyBatch("scheduled");
    await runGoalsBatch("scheduled");
  })().finally(() => {
    _unifiedBatchInFlight = null;
  });
  _unifiedBatchInFlight = run;
  return run;
}

/** Test-only: reset module state between cases. */
export function _resetUnifiedBatch(): void {
  _unifiedBatchInFlight = null;
}
