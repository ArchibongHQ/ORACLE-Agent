/** Phase 3 batch tests.
 *  Done criteria: 39-fixture batch completes with one error (batch does not abort),
 *  market whitelist filters correctly, progress events fire in order. */

import { MemoryAdapter, STORAGE_KEYS } from "@oracle/storage";
import { describe, expect, it, vi } from "vitest";
import type { FixtureJobError, FixtureJobSuccess } from "../src/batch/index.js";
import {
  buildV3Input,
  isRetriableNetworkError,
  parseFixtureList,
  runBatch,
  withRetry,
} from "../src/batch/index.js";
import { ExecutionEngine } from "../src/execution/index.js";
import type { AllMarketEntry, RunState } from "../src/types.js";

const INSTANT_BACKOFF = () => 0; // eliminates delay in retry tests

const RUN_ID = Date.now().toString(36);
const storage = new MemoryAdapter(`.tmp/batch-test-${RUN_ID}`);
const config = { geminiApiKey: "", claudeApiKey: "", bankroll: 1000 };
const deps = { storage, config };

// ── parseFixtureList ──────────────────────────────────────────────────────────

describe("parseFixtureList", () => {
  it("parses comma-separated format", () => {
    const result = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05T15:00:00Z");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ home: "Arsenal", away: "Chelsea", league: "Premier League" });
  });

  it("parses pipe-separated format", () => {
    const result = parseFixtureList("Real Madrid vs Barca | La Liga | 2026-06-05T20:00:00Z");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ home: "Real Madrid", away: "Barca", league: "La Liga" });
  });

  it("skips comment lines", () => {
    const input = "# matchday 38\nArsenal vs Chelsea, Premier League, 2026-06-05";
    expect(parseFixtureList(input)).toHaveLength(1);
  });

  it("skips blank lines", () => {
    const input = "\n\nArsenal vs Chelsea, Premier League, 2026-06-05\n\n";
    expect(parseFixtureList(input)).toHaveLength(1);
  });

  it("skips lines without vs separator", () => {
    const input = "Arsenal Chelsea, Premier League\nArsenal vs Chelsea, Premier League, 2026-06-05";
    expect(parseFixtureList(input)).toHaveLength(1);
  });

  it("parses multi-line list", () => {
    const input = [
      "Arsenal vs Chelsea, Premier League, 2026-06-05T15:00:00Z",
      "Real Madrid vs Barca, La Liga, 2026-06-05T20:00:00Z",
      "# comment",
      "Bayern Munich vs Dortmund, Bundesliga, 2026-06-06T18:30:00Z",
    ].join("\n");
    expect(parseFixtureList(input)).toHaveLength(3);
  });

  it("defaults league to Default when missing", () => {
    const result = parseFixtureList("Arsenal vs Chelsea");
    expect(result[0]?.league).toBe("Default");
  });
});

// ── runBatch ──────────────────────────────────────────────────────────────────

describe("runBatch", () => {
  it("runs a small batch and returns correct counts", async () => {
    const jobs = parseFixtureList(
      [
        "Arsenal vs Chelsea, Premier League, 2026-06-05T15:00:00Z",
        "Real Madrid vs Barca, La Liga, 2026-06-05T20:00:00Z",
      ].join("\n")
    );

    const result = await runBatch(jobs, deps);

    expect(result.jobs).toHaveLength(2);
    expect(result.completedCount + result.errorCount).toBe(2);
    expect(result.rankingMode).toBe("CONFIDENCE_WEIGHTED");
    expect(typeof result.date).toBe("string");
  }, 15_000);

  it("does not abort when one fixture throws — errorCount increments", async () => {
    const spy = vi.spyOn(ExecutionEngine, "run").mockRejectedValueOnce(new Error("API timeout"));

    const jobs = parseFixtureList(
      [
        "BadFixture vs ErrorTeam, Premier League, 2026-06-05",
        "Arsenal vs Chelsea, Premier League, 2026-06-05",
      ].join("\n")
    );

    const result = await runBatch(jobs, deps);

    expect(result.errorCount).toBe(1);
    expect(result.completedCount).toBe(1);
    expect(result.jobs[0]?.status).toBe("error");
    expect((result.jobs[0] as { reason: string }).reason).toContain("API timeout");
    spy.mockRestore();
  });

  it("handles a 39-fixture batch without aborting even with one injected error", async () => {
    const spy = vi
      .spyOn(ExecutionEngine, "run")
      .mockRejectedValueOnce(new Error("fixture not found"));

    const lines = Array.from(
      { length: 39 },
      (_, i) =>
        `Team${i}A vs Team${i}B, Premier League, 2026-06-07T${String(i % 24).padStart(2, "0")}:00:00Z`
    );
    const jobs = parseFixtureList(lines.join("\n"));

    const result = await runBatch(jobs, deps, {
      onProgress: ({ completed, total }) => {
        expect(completed).toBeLessThanOrEqual(total);
      },
    });

    expect(result.jobs).toHaveLength(39);
    expect(result.errorCount).toBe(1);
    expect(result.completedCount).toBe(38);
    spy.mockRestore();
  }, 20_000);

  it("fires progress events from 0 to total", async () => {
    const events: Array<{ completed: number; total: number }> = [];
    const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");

    await runBatch(jobs, deps, { onProgress: (e) => events.push(e) });

    expect(events[0]?.completed).toBe(0);
    expect(events[events.length - 1]?.completed).toBe(1);
    expect(events[events.length - 1]?.total).toBe(1);
  });

  it("applies marketWhitelist — only matching categories returned", async () => {
    const mockResult: RunResult = {
      fp: { home: 0.45, draw: 0.28, away: 0.27 },
      evMarkets: [
        {
          cat: "1x2",
          label: "Home Win",
          market: "1x2",
          side: "Home Win",
          mp: 0.45,
          modelProb: 0.45,
          ip: 0.4,
          rawEdge: 0.05,
          ev: 0.05,
          odds: 2.5,
          stake: 0.02,
          stakeAmt: 20,
          rankingScore: 0.5,
          varianceMod: 1.0,
        },
        {
          cat: "Goals O/U",
          label: "Over 2.5",
          market: "Goals O/U",
          side: "Over 2.5",
          mp: 0.55,
          modelProb: 0.55,
          ip: 0.48,
          rawEdge: 0.07,
          ev: 0.07,
          odds: 2.1,
          stake: 0.03,
          stakeAmt: 30,
          rankingScore: 0.6,
          varianceMod: 1.0,
        },
      ],
      oddsAvailable: true,
      bayesian_lH: 1.5,
      bayesian_lA: 1.2,
      expectedScoreline: "1-1",
      portfolioCorrelation: null,
      correlatedParlayRisk: null,
    };

    const spy = vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(mockResult);

    const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");
    const result = await runBatch(jobs, deps, { marketWhitelist: ["Goals O/U"] });

    expect(result.jobs[0]?.status).toBe("ok");
    const job = result.jobs[0] as FixtureJobSuccess;
    expect(job.result.evMarkets).toHaveLength(1);
    expect(job.result.evMarkets[0]?.cat).toBe("Goals O/U");

    spy.mockRestore();
  });

  // [review fix — Wave 2] BatchOptions.integrityByFixture (v5 Rule 0.14
  // per-fixture stake downgrade) had zero test coverage — flagged by both
  // the testing and adversarial review passes as the most actionable gap
  // in the Wave-2 diff, given the hook is live in production (dailyBatch.ts
  // populates it) and directly affects staking.
  describe("integrityByFixture — v5 Rule 0.14 per-fixture downgrade", () => {
    function integrityMockResult(): RunResult {
      return {
        fp: { home: 0.45, draw: 0.28, away: 0.27 },
        evMarkets: [
          {
            cat: "1x2",
            label: "Home Win",
            market: "1x2",
            side: "Home Win",
            mp: 0.45,
            modelProb: 0.45,
            ip: 0.4,
            rawEdge: 0.05,
            ev: 0.05,
            odds: 2.5,
            stake: 0.02,
            stakeAmt: 20,
            rankingScore: 0.5,
            varianceMod: 1.0,
          },
          {
            cat: "Goals O/U",
            label: "Over 2.5",
            market: "Goals O/U",
            side: "Over 2.5",
            mp: 0.55,
            modelProb: 0.55,
            ip: 0.48,
            rawEdge: 0.07,
            ev: 0.07,
            odds: 2.1,
            stake: 0.03,
            stakeAmt: 30,
            rankingScore: 0.6,
            varianceMod: 1.0,
            veto: "PORTFOLIO_CORRELATION_VETO",
          },
        ],
        oddsAvailable: true,
        bayesian_lH: 1.5,
        bayesian_lA: 1.2,
        expectedScoreline: "1-1",
        portfolioCorrelation: null,
        correlatedParlayRisk: null,
      };
    }

    it("halves stake on every non-vetoed market for a 'flagged' fixture", async () => {
      const spy = vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(integrityMockResult());
      const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");
      const result = await runBatch(jobs, deps, {
        integrityByFixture: {
          "Arsenal|Chelsea": { verdict: "flagged", reason: "duplicate_block" },
        },
      });
      const job = result.jobs[0] as FixtureJobSuccess;
      const m1x2 = job.result.evMarkets.find((m) => m.cat === "1x2")!;
      expect(m1x2.stake).toBeCloseTo(0.01, 5);
      expect(m1x2.stakeAmt).toBeCloseTo(10, 5);
      spy.mockRestore();
    });

    it("leaves an already-vetoed market's stake untouched", async () => {
      const spy = vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(integrityMockResult());
      const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");
      const result = await runBatch(jobs, deps, {
        integrityByFixture: { "Arsenal|Chelsea": { verdict: "flagged" } },
      });
      const job = result.jobs[0] as FixtureJobSuccess;
      const vetoed = job.result.evMarkets.find((m) => m.cat === "Goals O/U")!;
      expect(vetoed.stake).toBeCloseTo(0.03, 5); // untouched — the pre-existing veto short-circuits the loop
      spy.mockRestore();
    });

    it("is a no-op when integrityByFixture has no entry for this fixture", async () => {
      const spy = vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(integrityMockResult());
      const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");
      const result = await runBatch(jobs, deps, {
        integrityByFixture: { "Some Other|Fixture": { verdict: "flagged" } },
      });
      const job = result.jobs[0] as FixtureJobSuccess;
      const m1x2 = job.result.evMarkets.find((m) => m.cat === "1x2")!;
      expect(m1x2.stake).toBeCloseTo(0.02, 5); // unchanged
      spy.mockRestore();
    });

    it("is a no-op when integrityByFixture is undefined (regression guard — pre-Wave-2 behavior)", async () => {
      const spy = vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(integrityMockResult());
      const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");
      const result = await runBatch(jobs, deps, {});
      const job = result.jobs[0] as FixtureJobSuccess;
      const m1x2 = job.result.evMarkets.find((m) => m.cat === "1x2")!;
      expect(m1x2.stake).toBeCloseTo(0.02, 5); // unchanged
      spy.mockRestore();
    });

    it("a 'clean' verdict entry (defensive — never actually emitted by runFeedIntegrity today) is a no-op", async () => {
      const spy = vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(integrityMockResult());
      const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");
      const result = await runBatch(jobs, deps, {
        integrityByFixture: { "Arsenal|Chelsea": { verdict: "clean" } },
      });
      const job = result.jobs[0] as FixtureJobSuccess;
      const m1x2 = job.result.evMarkets.find((m) => m.cat === "1x2")!;
      expect(m1x2.stake).toBeCloseTo(0.02, 5); // unchanged
      spy.mockRestore();
    });
  });

  it("respects rankingMode option", async () => {
    const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");
    const result = await runBatch(jobs, deps, { rankingMode: "MAX_EV" });
    expect(result.rankingMode).toBe("MAX_EV");
  });

  it("includes cost and errors fields in BatchResult", async () => {
    const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");
    const result = await runBatch(jobs, deps);
    expect(result.cost).toMatchObject({ estimatedUsd: 0, halted: false });
    expect(result.cost.ceilingUsd).toBeNull();
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("maps error to typed AgentErrorCode and populates errors array", async () => {
    const spy = vi
      .spyOn(ExecutionEngine, "run")
      .mockRejectedValue(new Error("429 rate limit exceeded"));
    const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");
    // maxRetries: 0 — test error classification only, not retry behaviour
    const result = await runBatch(jobs, deps, { maxRetries: 0 });
    const errJob = result.jobs[0] as FixtureJobError;
    expect(errJob.errorCode).toBe("RATE_LIMITED");
    expect(errJob.league).toBe("Premier League");
    expect(result.errors[0]?.code).toBe("RATE_LIMITED");
    expect(result.errors[0]?.retriable).toBe(true);
    spy.mockRestore();
  });

  it("dry-run skips execution and returns cost estimate", async () => {
    const jobs = parseFixtureList(
      [
        "Arsenal vs Chelsea, Premier League, 2026-06-05",
        "Real Madrid vs Barca, La Liga, 2026-06-05",
      ].join("\n")
    );
    const result = await runBatch(jobs, deps, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.completedCount).toBe(0);
    expect(result.errorCount).toBe(2);
    expect(result.cost.estimatedUsd).toBeGreaterThan(0);
    expect((result.jobs[0] as FixtureJobError).errorCode).toBe("DRY_RUN");
  });

  it("retries RATE_LIMITED fixture and succeeds on third attempt", async () => {
    let calls = 0;
    const mockOk: RunResult = {
      fp: { home: 0.45, draw: 0.28, away: 0.27 },
      evMarkets: [],
      oddsAvailable: true,
      bayesian_lH: 1.5,
      bayesian_lA: 1.2,
      expectedScoreline: "1-1",
      portfolioCorrelation: null,
      correlatedParlayRisk: null,
    };
    const spy = vi.spyOn(ExecutionEngine, "run").mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error("429 rate limit exceeded");
      return mockOk;
    });
    const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");
    const result = await runBatch(jobs, deps, { maxRetries: 3, backoffMs: INSTANT_BACKOFF });
    expect(result.completedCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(calls).toBe(3);
    spy.mockRestore();
  });

  it("records error after exhausting all retries", async () => {
    const spy = vi
      .spyOn(ExecutionEngine, "run")
      .mockRejectedValue(new Error("429 rate limit exceeded"));
    const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");
    const result = await runBatch(jobs, deps, { maxRetries: 2, backoffMs: INSTANT_BACKOFF });
    expect(result.errorCount).toBe(1);
    expect((result.jobs[0] as FixtureJobError).errorCode).toBe("RATE_LIMITED");
    // 1 original + 2 retries = 3 total calls
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it("surfaces cost.ceilingUsd when config sets a per-run ceiling", async () => {
    const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");
    const ceilConfig = { ...config, costCeilingUsd: { perRun: 1.0, perDay: 10 } };
    const result = await runBatch(jobs, { storage, config: ceilConfig });
    // No LLM calls (no API key), so cost stays 0 and ceiling is not hit
    expect(result.cost.ceilingUsd).toBe(1.0);
    expect(result.cost.halted).toBe(false);
    expect(result.cost.estimatedUsd).toBe(0);
  });

  it("totalRecommendedStakePct sums actionable stakes", async () => {
    const mockResult: RunResult = {
      fp: { home: 0.45, draw: 0.28, away: 0.27 },
      evMarkets: [
        {
          cat: "1x2",
          label: "Home Win",
          market: "1x2",
          side: "Home Win",
          mp: 0.55,
          modelProb: 0.55,
          ip: 0.4,
          rawEdge: 0.15,
          ev: 0.15,
          odds: 2.5,
          stake: 0.05,
          stakeAmt: 50,
          rankingScore: 0.8,
          varianceMod: 1.0,
        },
      ],
      oddsAvailable: true,
      bayesian_lH: 1.5,
      bayesian_lA: 1.2,
      expectedScoreline: "1-1",
      portfolioCorrelation: null,
      correlatedParlayRisk: null,
    };

    const spy = vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(mockResult);
    const jobs = parseFixtureList("Arsenal vs Chelsea, Premier League, 2026-06-05");
    const result = await runBatch(jobs, deps);
    expect(result.totalRecommendedStakePct).toBeGreaterThanOrEqual(0);
    spy.mockRestore();
  });
});

// [PR-10] withRetry/isRetriableNetworkError are now exported so callers outside
// this file (Telegram's post(), the worker's scrape execFile wrapper) can reuse
// the same primitive with their own retry predicate instead of a bespoke wrapper.
describe("withRetry (generalized, PR-10)", () => {
  it("defaults to the original RATE_LIMITED-only predicate when no shouldRetry is passed", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("boom — totally unrelated failure");
        },
        3,
        INSTANT_BACKOFF
      )
    ).rejects.toThrow("boom");
    expect(calls).toBe(1); // non-RATE_LIMITED error — no retry with the default predicate
  });

  it("retries on a custom predicate and succeeds once it stops matching", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("ENOTFOUND api.telegram.org");
        return "ok";
      },
      3,
      INSTANT_BACKOFF,
      isRetriableNetworkError
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("stops retrying and throws once a custom predicate returns false", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("HTTP 400 bad request");
        },
        3,
        INSTANT_BACKOFF,
        isRetriableNetworkError
      )
    ).rejects.toThrow("HTTP 400");
    expect(calls).toBe(1);
  });
});

describe("isRetriableNetworkError", () => {
  it.each([
    "ENOTFOUND api.telegram.org",
    "fetch failed",
    "ETIMEDOUT",
    "ECONNRESET",
    "EAI_AGAIN",
  ])("matches %s", (msg) => {
    expect(isRetriableNetworkError(new Error(msg))).toBe(true);
  });

  it("does not match an unrelated error", () => {
    expect(isRetriableNetworkError(new Error("HTTP 400 bad request"))).toBe(false);
  });
});

// ── Concurrency safety (Level-1 swarm) ────────────────────────────────────────

describe("runBatch — concurrency safety", () => {
  it("RAG store grows by exactly N after an N-fixture parallel batch (no lost writes)", async () => {
    // Fresh isolated storage so the count is deterministic.
    const freshStorage = new MemoryAdapter(`.tmp/batch-rag-${Date.now().toString(36)}`);
    const freshDeps = { storage: freshStorage, config };

    const N = 12;
    const jobs = Array.from(
      { length: N },
      (_, i) => `Home${i} vs Away${i}, Premier League, 2026-06-05T15:00:00Z`
    ).join("\n");

    // High concurrency to maximize the chance of a read-modify-write race if the
    // withKeyLock around RAGSystem.addToStore regressed.
    await runBatch(parseFixtureList(jobs), freshDeps, { concurrency: N });

    const store = (await freshStorage.get<unknown[]>(STORAGE_KEYS.ragStore)) ?? [];
    expect(store.length).toBe(N);
  }, 30_000);

  it("processes fixtures in parallel and preserves input order in results", async () => {
    const freshStorage = new MemoryAdapter(`.tmp/batch-order-${Date.now().toString(36)}`);
    const jobs = parseFixtureList(
      [
        "Arsenal vs Chelsea, Premier League, 2026-06-05",
        "Real Madrid vs Barca, La Liga, 2026-06-05",
        "Bayern vs Dortmund, Bundesliga, 2026-06-05",
      ].join("\n")
    );

    const result = await runBatch(jobs, { storage: freshStorage, config }, { concurrency: 3 });

    expect(result.jobs).toHaveLength(3);
    expect(result.jobs[0]?.home).toBe("Arsenal");
    expect(result.jobs[1]?.home).toBe("Real Madrid");
    expect(result.jobs[2]?.home).toBe("Bayern");
  }, 30_000);
});

// ── buildV3Input — v3CornersCards/v3ShotsOu rollback-surface gating ────────
// (review-caught gap: only the env-var→boolean parse was tested, never that
// buildV3Input actually withholds the fields when the flag is off.)

describe("buildV3Input — corners/cards/shots rollback surface", () => {
  const job = { home: "Home FC", away: "Away FC", league: "Premier League", kickoff: "2026-08-01" };
  const allMarkets: AllMarketEntry[] = [{ id: "1", name: "1X2", outcomes: [] }];
  const state: RunState = {
    telemetry: {
      cornersForH: 5.2,
      cornersForA: 4.1,
      cornersAgainstH: 3.8,
      cornersAgainstA: 4.9,
      cardsAvgH: 2.1,
      cardsAvgA: 1.8,
      sotForH: 5.4,
      sotForA: 3.9,
    },
  };

  it("threads corners/cards/shots stats through by default (flags undefined ⇒ on)", () => {
    const input = buildV3Input(job, state, allMarkets);
    expect(input).toMatchObject({
      cornersForH: 5.2,
      cornersForA: 4.1,
      cornersAgainstH: 3.8,
      cornersAgainstA: 4.9,
      cardsAvgH: 2.1,
      cardsAvgA: 1.8,
      sotForH: 5.4,
      sotForA: 3.9,
    });
  });

  it("withholds corners/cards when v3CornersCards=false (rollback surface actually works)", () => {
    const input = buildV3Input(job, state, allMarkets, { v3CornersCards: false });
    expect(input?.cornersForH).toBeUndefined();
    expect(input?.cornersForA).toBeUndefined();
    expect(input?.cornersAgainstH).toBeUndefined();
    expect(input?.cornersAgainstA).toBeUndefined();
    expect(input?.cardsAvgH).toBeUndefined();
    expect(input?.cardsAvgA).toBeUndefined();
    // Shots is a separate flag — must be unaffected by v3CornersCards alone.
    expect(input?.sotForH).toBe(5.4);
    expect(input?.sotForA).toBe(3.9);
  });

  it("withholds shots when v3ShotsOu=false, independently of v3CornersCards", () => {
    const input = buildV3Input(job, state, allMarkets, { v3ShotsOu: false });
    expect(input?.sotForH).toBeUndefined();
    expect(input?.sotForA).toBeUndefined();
    // Corners/cards is a separate flag — must be unaffected by v3ShotsOu alone.
    expect(input?.cornersForH).toBe(5.2);
    expect(input?.cardsAvgH).toBe(2.1);
  });

  it("withholds all three when both flags are false", () => {
    const input = buildV3Input(job, state, allMarkets, {
      v3CornersCards: false,
      v3ShotsOu: false,
    });
    expect(input?.cornersForH).toBeUndefined();
    expect(input?.cardsAvgH).toBeUndefined();
    expect(input?.sotForH).toBeUndefined();
  });
});
