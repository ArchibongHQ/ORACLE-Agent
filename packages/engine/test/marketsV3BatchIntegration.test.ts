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

const runAllMarketsLlmExecutorMock = vi.fn();
vi.mock("../src/decision/marketExecutor.js", () => ({
  runAllMarketsLlmExecutor: (...args: unknown[]) => runAllMarketsLlmExecutorMock(...args),
}));

// decide() dynamically imports @oracle/llm at every cascade tier — leaving it
// unmocked means each test pays a real transform/load cost for that whole
// package graph (callBriefing/callGemini/callKimi/callOpenRouter/...), which
// is slow and CI-runner-dependent enough to blow past vitest's 5s default
// timeout under parallel turbo load. Same convention as decision.test.ts.
vi.mock("@oracle/llm", () => ({
  isLocalRuntime: () => false,
  callClaudeCode: vi.fn().mockResolvedValue(null),
  callOpenRouterJson: vi.fn().mockResolvedValue(null),
  callGeminiDecision: vi.fn().mockResolvedValue(null),
  MODELS: { CLAUDE_OPUS: "claude-opus" },
  OPENROUTER_MODELS: { GLM_5_2: "glm-5.2", GLM_5_1: "glm-5.1" },
  _resetClaudeCodeCaches: vi.fn(),
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
  runAllMarketsLlmExecutorMock.mockReset();
  runAllMarketsLlmExecutorMock.mockResolvedValue(null); // fail-open: Q4 declines by default
});

function v3EvMarketAt(rank: number): EVMarket {
  return {
    cat: "Goals O/U",
    label: `Candidate ${rank}`,
    market: "Goals O/U",
    side: `Candidate ${rank}`,
    family: "goals_ou",
    mp: 0.6,
    modelProb: 0.6,
    ip: 0.5,
    rawEdge: 0.1 - rank * 0.01, // descending, matches evMarkets' own sort order
    ev: 0.05,
    odds: 2.0,
    stake: 0,
    stakeAmt: 0,
    rankingScore: 0.1 - rank * 0.01,
    varianceMod: 1,
  };
}

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

  it("caps eligible at the top V3_ARBITER_CANDIDATE_LIMIT(5) candidates when v3 returns more", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const many = Array.from({ length: 8 }, (_, i) => v3EvMarketAt(i));
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [],
      capped: [],
      evMarkets: many,
      best: many[0],
    });

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on" },
    });

    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.eligibleBets).toHaveLength(5);
    expect(success.eligibleBets?.map((m) => m.label)).toEqual([
      "Candidate 0",
      "Candidate 1",
      "Candidate 2",
      "Candidate 3",
      "Candidate 4",
    ]);
  });

  it("demotes the Q4 all-markets LLM executor when v3 supplies this fixture's candidates, even if enableLlmMarketExecutor=true", async () => {
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
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on", enableLlmMarketExecutor: true },
    });

    expect(runAllMarketsLlmExecutorMock).not.toHaveBeenCalled();
  });

  it("leaves the Q4 executor enabled when v3 produced nothing for this fixture (fail-open, not a blanket suppression)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    analyzeFixtureMarketsV3Mock.mockReturnValue(null); // v3 declines

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on", enableLlmMarketExecutor: true },
    });

    // decideConfig falls back to the unmodified config (usedV3=false), so the
    // Q4 branch's own gate (config.enableLlmMarketExecutor) still applies —
    // it's exercised here (called), independent of whatever it itself returns.
    expect(runAllMarketsLlmExecutorMock).toHaveBeenCalledTimes(1);
  });

  it("threads config.v3GatesV4 through to v3Input.heightened (PR-3) — defaults true when unset", async () => {
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
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });

    await runBatch([job], { storage, config: { ...baseConfig, enableMarketsV3: "on" } });
    expect(analyzeFixtureMarketsV3Mock.mock.calls[0]![0].heightened).toBe(true);

    analyzeFixtureMarketsV3Mock.mockClear();
    await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on", v3GatesV4: false },
    });
    expect(analyzeFixtureMarketsV3Mock.mock.calls[0]![0].heightened).toBe(false);
  });

  it("leaves the Q4 executor enabled in 'shadow' mode (v3 never suppresses the legacy LLM tier there)", async () => {
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
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "shadow", enableLlmMarketExecutor: true },
    });

    expect(runAllMarketsLlmExecutorMock).toHaveBeenCalledTimes(1);
  });
});
