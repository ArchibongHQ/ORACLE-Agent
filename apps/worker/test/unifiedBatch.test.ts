/** [Phase 5, scrape-triggered batch] unifiedBatch.ts consolidates three
 *  previously-duplicated call sites (09:35 WAT cron, the back-online hourly
 *  check, and the new scrape-complete hook) into one in-flight-guarded,
 *  freshness-gated entry point. These tests prove the two properties that
 *  actually matter for a shared entry point three independent triggers can
 *  all reach: (a) a second concurrent caller never starts a duplicate run
 *  (dedupe), and (b) a caller that arrives once today's batch already
 *  completed is a fast no-op (freshness), never a redundant re-run. */
import { beforeEach, describe, expect, it, vi } from "vitest";

let lastBatch: { at?: string } | undefined;

vi.mock("../src/workerUtils.js", () => ({
  readLastBatch: () => lastBatch,
  watDateString: (d: Date = new Date()) => d.toISOString().slice(0, 10),
}));

// awaitAcquireDailyJobOrTimeout is a no-op here (no acquire job is ever
// tracked in these tests) — real behavior is covered by acquireChain.test.ts
// and dailyAcquisition.test.ts's own fixture-report@enriched-followup suite;
// this file only needs it to resolve immediately so runUnifiedBatchOnce's
// own sequencing/dedupe/freshness logic is what's under test here.
vi.mock("../src/dailyAcquisition.js", () => ({
  ACQUIRE_CHAIN_TIMEOUT_MS: 20 * 60 * 1000,
  awaitAcquireDailyJobOrTimeout: () => Promise.resolve(),
}));

const runDailyBatchMock = vi.fn().mockResolvedValue(undefined);
const runGoalsBatchMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/dailyBatch.js", () => ({
  runDailyBatch: (...args: unknown[]) => runDailyBatchMock(...args),
}));
vi.mock("../src/goalsAccumulator.js", () => ({
  runGoalsBatch: (...args: unknown[]) => runGoalsBatchMock(...args),
}));

const { runUnifiedBatchOnce, isDailyBatchFreshForToday, _resetUnifiedBatch } = await import(
  "../src/unifiedBatch.js"
);

describe("runUnifiedBatchOnce", () => {
  beforeEach(() => {
    lastBatch = undefined;
    runDailyBatchMock.mockClear();
    runGoalsBatchMock.mockClear();
    _resetUnifiedBatch();
  });

  it("runs the daily->goals sequence, daily strictly before goals, when nothing has run today", async () => {
    const order: string[] = [];
    runDailyBatchMock.mockImplementationOnce(async () => {
      order.push("daily");
    });
    runGoalsBatchMock.mockImplementationOnce(async () => {
      order.push("goals");
    });

    await runUnifiedBatchOnce("cron");

    expect(order).toEqual(["daily", "goals"]);
    expect(runDailyBatchMock).toHaveBeenCalledWith("scheduled");
    expect(runGoalsBatchMock).toHaveBeenCalledWith("scheduled");
  });

  it("dedupes racing triggers — a second caller while the first is still in flight awaits the SAME run, never starts a duplicate", async () => {
    let resolveDaily!: () => void;
    runDailyBatchMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDaily = resolve;
        })
    );

    const first = runUnifiedBatchOnce("scrape-complete");
    // Give the first call a microtask turn to actually start (set the
    // in-flight guard) before the second one races in.
    await Promise.resolve();
    const second = runUnifiedBatchOnce("cron");

    resolveDaily();
    await Promise.all([first, second]);

    // Exactly one real run happened, not two — the racing "cron" trigger
    // observed the "scrape-complete" trigger's in-flight promise instead of
    // starting its own.
    expect(runDailyBatchMock).toHaveBeenCalledTimes(1);
    expect(runGoalsBatchMock).toHaveBeenCalledTimes(1);
  });

  it("is a fast no-op when today's batch already completed (freshness check), even for a later trigger", async () => {
    lastBatch = { at: new Date().toISOString() };

    await runUnifiedBatchOnce("back-online");

    expect(runDailyBatchMock).not.toHaveBeenCalled();
    expect(runGoalsBatchMock).not.toHaveBeenCalled();
  });

  it("re-reads the heartbeat fresh on every call — a run that completes between two triggers makes the SECOND one a no-op, not the first", async () => {
    // First call: nothing fresh yet, runs for real and (in this fake) never
    // itself updates the heartbeat file (that's dailyBatch's own job in
    // production, not unifiedBatch's) — so this test drives the freshness
    // transition explicitly instead, proving the read genuinely happens
    // per-call rather than being cached from the first invocation.
    await runUnifiedBatchOnce("scrape-complete");
    expect(runDailyBatchMock).toHaveBeenCalledTimes(1);

    lastBatch = { at: new Date().toISOString() };
    await runUnifiedBatchOnce("cron");

    expect(runDailyBatchMock).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it("dedupes all THREE real trigger points racing simultaneously — only one real run, whichever arrives first wins", async () => {
    let resolveDaily!: () => void;
    runDailyBatchMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDaily = resolve;
        })
    );

    // Mirrors index.ts's real shape: scrape-complete fires first on a normal
    // morning, with cron and back-online racing in behind it.
    const scrapeComplete = runUnifiedBatchOnce("scrape-complete");
    await Promise.resolve();
    const cron = runUnifiedBatchOnce("cron");
    const backOnline = runUnifiedBatchOnce("back-online");

    resolveDaily();
    await Promise.all([scrapeComplete, cron, backOnline]);

    expect(runDailyBatchMock).toHaveBeenCalledTimes(1);
    expect(runGoalsBatchMock).toHaveBeenCalledTimes(1);
  });

  it("clears the in-flight guard even when runDailyBatch throws, so a later trigger can retry — and the rejection propagates to the original caller", async () => {
    const boom = new Error("daily batch exploded");
    runDailyBatchMock.mockRejectedValueOnce(boom);

    await expect(runUnifiedBatchOnce("scrape-complete")).rejects.toThrow("daily batch exploded");
    // runGoalsBatch must never run after a daily-batch failure.
    expect(runGoalsBatchMock).not.toHaveBeenCalled();

    // Guard cleared — a later trigger (still same "day", heartbeat never
    // wrote since the mock never calls the real runDailyBatch) retries for
    // real instead of hanging on a permanently-stuck in-flight promise.
    runDailyBatchMock.mockResolvedValueOnce(undefined);
    await runUnifiedBatchOnce("cron");
    expect(runDailyBatchMock).toHaveBeenCalledTimes(2);
    expect(runGoalsBatchMock).toHaveBeenCalledTimes(1);
  });
});

describe("isDailyBatchFreshForToday", () => {
  it("is false when lastBatchAt is undefined", () => {
    expect(isDailyBatchFreshForToday(undefined)).toBe(false);
  });

  it("is false when lastBatchAt is from a prior WAT date", () => {
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect(isDailyBatchFreshForToday(yesterday)).toBe(false);
  });

  it("is true for a recent same-day timestamp, false once older than the 20h window", () => {
    expect(isDailyBatchFreshForToday(new Date().toISOString())).toBe(true);
    const staleButSameDay = new Date(Date.now() - 21 * 60 * 60 * 1000).toISOString();
    // 21h ago may or may not be "today" depending on the current WAT clock
    // position — only assert the 20h-window boundary when it genuinely is
    // still today's date, otherwise the date-mismatch branch above already
    // covers the false case.
    if (staleButSameDay.slice(0, 10) === new Date().toISOString().slice(0, 10)) {
      expect(isDailyBatchFreshForToday(staleButSameDay)).toBe(false);
    }
  });
});
