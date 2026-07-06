/** [audit fix, P0-4] Unit tests for the acquire->batch chaining handoff.
 *  Extracted into its own dependency-free module (acquireChain.ts) precisely
 *  so this race/timeout logic is testable without importing the rest of
 *  apps/worker/src/index.ts (cron registrations, execFile calls, etc.). */
import { afterEach, describe, expect, it } from "vitest";
import { _resetAcquireChain, awaitAcquireOrTimeout, trackAcquireJob } from "../src/acquireChain.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("acquireChain — awaitAcquireOrTimeout", () => {
  afterEach(() => _resetAcquireChain());

  it("returns immediately when nothing is tracked", async () => {
    const start = Date.now();
    await awaitAcquireOrTimeout(5000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("resolves as soon as the tracked job finishes, well before the timeout", async () => {
    const d = deferred();
    trackAcquireJob(d.promise);
    let onTimeoutFired = false;
    const wait = awaitAcquireOrTimeout(5000, () => {
      onTimeoutFired = true;
    });
    setTimeout(() => d.resolve(), 10);
    await wait;
    expect(onTimeoutFired).toBe(false);
  });

  it("fires onTimeout and proceeds when the tracked job outlives the bound", async () => {
    const d = deferred();
    trackAcquireJob(d.promise); // never resolved in this test
    let onTimeoutFired = false;
    const start = Date.now();
    await awaitAcquireOrTimeout(20, () => {
      onTimeoutFired = true;
    });
    expect(onTimeoutFired).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    d.resolve(); // cleanup — avoid an unresolved-promise dangling into other tests
  });

  it("proceeds without throwing when the tracked job rejects", async () => {
    const d = deferred();
    trackAcquireJob(d.promise.catch(() => {})); // caller's own error handling, not this module's job
    d.reject(new Error("acquire_daily.py failed"));
    await expect(awaitAcquireOrTimeout(5000)).resolves.toBeUndefined();
  });

  it("self-clears after settlement — a later wait with nothing new tracked returns immediately", async () => {
    const d = deferred();
    trackAcquireJob(d.promise);
    d.resolve();
    await d.promise;
    // Give the tracked promise's own .finally() a microtask turn to clear state.
    await Promise.resolve();
    const start = Date.now();
    await awaitAcquireOrTimeout(5000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("a fresh trackAcquireJob call supersedes a still-settling previous one", async () => {
    const first = deferred();
    const second = deferred();
    trackAcquireJob(first.promise);
    trackAcquireJob(second.promise);
    let onTimeoutFired = false;
    const wait = awaitAcquireOrTimeout(5000, () => {
      onTimeoutFired = true;
    });
    second.resolve();
    await wait;
    expect(onTimeoutFired).toBe(false);
    first.resolve(); // cleanup
  });
});
