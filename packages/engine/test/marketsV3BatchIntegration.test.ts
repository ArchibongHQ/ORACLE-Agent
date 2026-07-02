/** all-markets-analysis-prompt-v3 P3 — batch/index.ts wiring tests.
 *
 *  Verifies the integration SEAM (config.enableMarketsV3 → buildV3Input →
 *  analyzeFixtureMarketsV3 → eligible splice), not the v3 math itself (that's
 *  covered exhaustively in marketsV3.test.ts). Mocks analyzeFixtureMarketsV3
 *  so these tests are deterministic regardless of the real engine's output. */

import { MemoryAdapter } from "@oracle/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureJob, FixtureJobSuccess } from "../src/batch/index.js";
import { runBatch } from "../src/batch/index.js";
import { ExecutionEngine } from "../src/execution/index.js";
import type { AllMarketEntry, EVMarket, OracleConfig, RunResult } from "../src/types.js";

const analyzeFixtureMarketsV3Mock = vi.fn();
vi.mock("../src/marketsV3/analyzeFixtureMarkets.js", () => ({
  analyzeFixtureMarketsV3: (...args: unknown[]) => analyzeFixtureMarketsV3Mock(...args),
}));

const storage = new MemoryAdapter(`.tmp/marketsv3-batch-test-${Date.now().toString(36)}`);

const legacyEvMarket: EVMarket = {
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
};

const legacyRunResult: RunResult = {
  fp: { home: 0.45, draw: 0.28, away: 0.27 },
  evMarkets: [legacyEvMarket],
  oddsAvailable: true,
  bayesian_lH: 1.5,
  bayesian_lA: 1.2,
  expectedScoreline: "1-1",
  portfolioCorrelation: null,
  correlatedParlayRisk: null,
};

const v3EvMarket: EVMarket = {
  cat: "Double Chance",
  label: "Home or Draw",
  market: "Double Chance",
  side: "Home or Draw",
  family: "double_chance",
  mp: 0.82,
  modelProb: 0.82,
  ip: 0.76,
  rawEdge: 0.06,
  ev: 0.08,
  odds: 1.25,
  stake: 0,
  stakeAmt: 0,
  rankingScore: 0.06,
  varianceMod: 1,
};

const allMarkets: AllMarketEntry[] = [
  {
    id: "10",
    name: "Double Chance",
    outcomes: [
      { id: "1", desc: "Home or Draw", odds: "1.25" },
      { id: "2", desc: "Home or Away", odds: "1.10" },
      { id: "3", desc: "Draw or Away", odds: "2.10" },
    ],
  },
];

function makeJob(state: FixtureJob["state"]): FixtureJob {
  return {
    home: "Arsenal",
    away: "Chelsea",
    league: "Premier League",
    kickoff: "2026-06-05T15:00:00Z",
    state,
  };
}

const baseConfig: OracleConfig = { geminiApiKey: "", claudeApiKey: "", bankroll: 1000 };

beforeEach(() => {
  analyzeFixtureMarketsV3Mock.mockReset();
});

describe("batch/index.ts — enableMarketsV3 wiring", () => {
  it("never calls analyzeFixtureMarketsV3 when enableMarketsV3 is unset (default off at the OracleConfig level)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const job = makeJob({ pipeline: { fetched: { sportyBetOdds: { allMarkets } } } });

    const result = await runBatch([job], { storage, config: baseConfig });

    expect(analyzeFixtureMarketsV3Mock).not.toHaveBeenCalled();
    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.eligibleBets?.[0]?.label).toBe("Over 2.5"); // legacy candidate untouched
  });

  it("never calls analyzeFixtureMarketsV3 when enableMarketsV3 is explicitly 'off'", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const job = makeJob({ pipeline: { fetched: { sportyBetOdds: { allMarkets } } } });

    await runBatch([job], { storage, config: { ...baseConfig, enableMarketsV3: "off" } });

    expect(analyzeFixtureMarketsV3Mock).not.toHaveBeenCalled();
  });

  it("replaces eligible with v3's candidates when enableMarketsV3='on' and v3 returns survivors", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [],
      capped: [],
      evMarkets: [v3EvMarket],
      best: v3EvMarket,
    });

    const job = makeJob({
      telemetry: {
        scoredPer90H: 1.7,
        concededPer90H: 1.0,
        scoredPer90A: 1.2,
        concededPer90A: 1.5,
        nHome: 10,
        nAway: 10,
      },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });

    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on" },
    });

    expect(analyzeFixtureMarketsV3Mock).toHaveBeenCalledTimes(1);
    const call = analyzeFixtureMarketsV3Mock.mock.calls[0]![0];
    expect(call.allMarkets).toBe(allMarkets);
    expect(call.lambdaInput).toMatchObject({
      homeScoredPer90: 1.7,
      homeConcededPer90: 1.0,
      awayScoredPer90: 1.2,
      awayConcededPer90: 1.5,
      nHome: 10,
      nAway: 10,
    });

    const success = result.jobs[0] as FixtureJobSuccess;
    // eligibleBets reflects v3's candidate, not the legacy Over 2.5 pick.
    expect(success.eligibleBets?.some((m) => m.label === "Home or Draw")).toBe(true);
    // The engine's own reported evMarkets (report/telemetry) still shows the
    // legacy scanMarkets output — same convention as the Q4 executor splice.
    expect(success.result.evMarkets[0]?.label).toBe("Over 2.5");
  });

  it("runs v3 but keeps legacy eligible in 'shadow' mode (comparison instrumentation, no effect on the decision)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [],
      capped: [],
      evMarkets: [v3EvMarket],
      best: v3EvMarket,
    });

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7, concededPer90H: 1.0, scoredPer90A: 1.2, concededPer90A: 1.5 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });

    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "shadow" },
    });

    expect(analyzeFixtureMarketsV3Mock).toHaveBeenCalledTimes(1);
    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.eligibleBets?.[0]?.label).toBe("Over 2.5"); // legacy, unchanged
  });

  it("fails open to legacy eligible when v3 returns null (e.g. no λ model buildable)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    analyzeFixtureMarketsV3Mock.mockReturnValue(null);

    const job = makeJob({
      telemetry: {},
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });

    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on" },
    });

    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.eligibleBets?.[0]?.label).toBe("Over 2.5");
  });

  it("skips v3 entirely (no call) when the fixture has no allMarkets catalogue", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const job = makeJob({ telemetry: { scoredPer90H: 1.7 } }); // no pipeline.fetched.sportyBetOdds

    await runBatch([job], { storage, config: { ...baseConfig, enableMarketsV3: "on" } });

    expect(analyzeFixtureMarketsV3Mock).not.toHaveBeenCalled();
  });
});
