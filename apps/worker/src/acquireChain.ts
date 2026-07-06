/** [audit fix, P0-4] Chaining handoff so the 09:35/09:40 cron slots (and the
 *  daily-batch back-online trigger) wait for the 09:30 acquire job to finish
 *  before starting their own heavy work, instead of firing on a fixed
 *  wall-clock offset — the existing `_acquireDailyInFlight` guard in
 *  index.ts only dedupes the underlying acquire_daily.py scrape call; it
 *  does not stop a dependent job's heavy LLM/analysis work from starting
 *  while acquireDailyJob's news-enrichment step is still running (real
 *  concurrent memory pressure on this box, the actual BSOD-class risk the
 *  audit flags — not just double-scraping).
 *
 *  Extracted as its own tiny, dependency-free module (no cron, no execFile,
 *  no fs) so this race/timeout logic is unit-testable without importing the
 *  rest of apps/worker/src/index.ts, which registers real cron jobs and
 *  timers at module load. */

let inFlight: Promise<unknown> | null = null;

/** Register a promise as "the acquire job currently running." Self-clears
 *  when the promise settles — a failed acquire job must not permanently
 *  block the chain (the caller's own error handling is unaffected; this
 *  module only observes settlement, never swallows the rejection). */
export function trackAcquireJob<T>(promise: Promise<T>): Promise<T> {
  inFlight = promise;
  promise.finally(() => {
    if (inFlight === promise) inFlight = null;
  });
  return promise;
}

/** Wait for the tracked acquire job to finish, up to `timeoutMs` — or return
 *  immediately when nothing is tracked (already finished, or never started
 *  this process — e.g. the lake was already fresh). Bounded so a hung/dead
 *  acquire job can't permanently starve the rest of the day's pipeline (the
 *  "fallback cron" requirement) — `onTimeout` fires once if the bound is hit,
 *  then the caller proceeds regardless, same as today's un-chained behavior. */
export async function awaitAcquireOrTimeout(
  timeoutMs: number,
  onTimeout?: () => void
): Promise<void> {
  const current = inFlight;
  if (!current) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve();
    }, timeoutMs);
  });
  // Swallow a rejection here — the caller of trackAcquireJob already handles
  // (logs/reports) the failure; this race only cares that settlement happened.
  await Promise.race([current.catch(() => undefined), timeout]);
  if (timer) clearTimeout(timer);
}

/** Test-only: reset module state between cases. */
export function _resetAcquireChain(): void {
  inFlight = null;
}
