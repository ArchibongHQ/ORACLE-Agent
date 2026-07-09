/** [PR-10] TelegramNotifier.post()'s retry-on-transient-network-failure path —
 *  a separate file from notify.test.ts because it needs to mock node:https
 *  (the postViaHttps fallback), which no other notify test exercises. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchSummary } from "../src/index.js";

const httpsRequestMock = vi.fn();
vi.mock("node:https", () => ({
  request: (...args: unknown[]) => httpsRequestMock(...args),
}));

// Imported after the mock so TelegramNotifier picks up the mocked node:https.
const { TelegramNotifier } = await import("../src/index.js");

const summary: BatchSummary = {
  date: "2026-06-05",
  analysed: 1,
  actionableCount: 0,
  errors: 0,
  actionable: [],
  reportUrl: "http://localhost:8787/reports/2026-06-05",
};

/** Fails the same way real https.request would on a DNS/connection blip —
 *  emits an 'error' event asynchronously rather than ever calling the response callback. */
function failingHttpsRequest() {
  const req = {
    on(event: string, handler: (err: Error) => void) {
      if (event === "error") setTimeout(() => handler(new Error("connect ECONNREFUSED")), 0);
      return req;
    },
    write: () => {},
    end: () => {},
    destroy: () => {},
  };
  return req;
}

describe("TelegramNotifier retry (PR-10)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    httpsRequestMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // withRetry's real exponential backoff (1s + 2s ≈ 3s) runs unmocked here —
  // bump the per-test timeout rather than fake-timer the multi-layer
  // fetch->https->withRetry chain.
  it("retries a transient fetch+https double failure and succeeds once fetch recovers", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error("fetch failed");
      return { ok: true, status: 200, text: async () => "" };
    });
    httpsRequestMock.mockImplementation(failingHttpsRequest);

    await new TelegramNotifier("T", "C").notify(summary);

    expect(calls).toBe(3); // 1 original + 2 retries before fetch recovered
    expect(httpsRequestMock).toHaveBeenCalledTimes(2); // only the 2 failed attempts fell back to https
  }, 10_000);

  it("gives up after exhausting retries when both transports stay down", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));
    httpsRequestMock.mockImplementation(failingHttpsRequest);

    await expect(new TelegramNotifier("T", "C").notify(summary)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 original + 2 retries, then give up
  }, 10_000);

  it("does not retry a non-network HTTP error (e.g. 403) — no wasted attempts", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "Forbidden" });
    // notify() itself still retries once on a generic non-ok response (existing
    // behavior, unrelated to PR-10) — assert post()/attemptPost only ran once
    // per notify()-level attempt, i.e. https was never touched for an HTTP-level error.
    await expect(new TelegramNotifier("T", "C").notify(summary)).rejects.toThrow(/HTTP 403/);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });
});
