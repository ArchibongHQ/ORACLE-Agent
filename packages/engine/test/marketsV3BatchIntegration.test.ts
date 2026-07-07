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

  it("threads telemetry.home/awayAvailabilityMult and ledger.metrics.dynamicRhoParams into buildV3Input's lambdaInput/dynamicRho (PR-5/PR-6)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    analyzeFixtureMarketsV3Mock.mockReturnValue(null); // return value irrelevant to this test

    const job = makeJob({
      telemetry: {
        scoredPer90H: 1.7,
        concededPer90H: 1.0,
        scoredPer90A: 1.2,
        concededPer90A: 1.5,
        homeAvailabilityMult: 0.72,
        awayAvailabilityMult: 0.95,
      },
      ledger: { metrics: { dynamicRhoParams: { "Premier League": -0.28 } } },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });

    await runBatch([job], { storage, config: { ...baseConfig, enableMarketsV3: "on" } });

    const call = analyzeFixtureMarketsV3Mock.mock.calls[0]![0];
    expect(call.lambdaInput).toMatchObject({
      homeAvailabilityMult: 0.72,
      awayAvailabilityMult: 0.95,
    });
    expect(call.dynamicRho).toBe(-0.28);
  });

  it("home/awayAvailabilityMult and dynamicRho are undefined/null when no ledger or availability telemetry exists", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    analyzeFixtureMarketsV3Mock.mockReturnValue(null);

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });

    await runBatch([job], { storage, config: { ...baseConfig, enableMarketsV3: "on" } });

    const call = analyzeFixtureMarketsV3Mock.mock.calls[0]![0];
    expect(call.lambdaInput.homeAvailabilityMult).toBeNull();
    expect(call.lambdaInput.awayAvailabilityMult).toBeNull();
    expect(call.dynamicRho).toBeUndefined();
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

  it("heightened is per-fixture: telemetry.v3Heightened stamp AND v3GatesV4 (PR-5a)", async () => {
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
    const stamped = makeJob({
      telemetry: { scoredPer90H: 1.7, v3Heightened: true },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    const unstamped = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });

    // Stamped fixture + gates-v4 default (unset) ⇒ heightened bars apply.
    await runBatch([stamped], { storage, config: { ...baseConfig, enableMarketsV3: "on" } });
    expect(analyzeFixtureMarketsV3Mock.mock.calls[0]![0].heightened).toBe(true);

    // No stamp ⇒ normal bars even with gates v4 on (the flag enables the
    // mechanism; §1.2 eligibility decides which fixtures it applies to).
    analyzeFixtureMarketsV3Mock.mockClear();
    await runBatch([unstamped], { storage, config: { ...baseConfig, enableMarketsV3: "on" } });
    expect(analyzeFixtureMarketsV3Mock.mock.calls[0]![0].heightened).toBe(false);

    // Rollback flag wins over the stamp.
    analyzeFixtureMarketsV3Mock.mockClear();
    await runBatch([stamped], {
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

describe("batch/index.ts — v3Best/v3AssessmentStats projection (PR-5b)", () => {
  function makeAssessment(overrides: {
    marketName: string;
    desc: string;
    family: string;
    outcome: string;
    rawEdge: number;
    adjustedEdge: number;
  }) {
    return {
      family: overrides.family,
      marketId: "m1",
      marketName: overrides.marketName,
      outcomeId: "o1",
      desc: overrides.desc,
      odds: 2.0,
      mp: 0.6,
      q: 0.5,
      devigged: true,
      rawEdge: overrides.rawEdge,
      penaltyPts: 0.01,
      adjustedEdge: overrides.adjustedEdge,
      adjEvPct: 0.1,
      cls: "M",
      outcome: overrides.outcome,
      confidence: "medium",
    };
  }

  it("picks the highest-adjustedEdge 'done' assessment as v3Best, and carries one compact v3AssessmentStats entry per assessment (done+capped alike)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const doneLow = makeAssessment({
      marketName: "Goals O/U",
      desc: "Over 2.5",
      family: "goals_ou",
      outcome: "done",
      rawEdge: 0.06,
      adjustedEdge: 0.05,
    });
    const doneHigh = makeAssessment({
      marketName: "Double Chance",
      desc: "Home or Draw",
      family: "double_chance",
      outcome: "done",
      rawEdge: 0.09,
      adjustedEdge: 0.08,
    });
    const capped = makeAssessment({
      marketName: "Asian Handicap",
      desc: "Home -1",
      family: "asian_handicap",
      outcome: "capped",
      rawEdge: 0.2,
      adjustedEdge: 0.18,
    });
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [doneLow, doneHigh, capped],
      capped: [capped],
      evMarkets: [v3EvMarket],
      best: v3EvMarket,
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
    expect(success.v3Best?.desc).toBe("Home or Draw");
    expect(success.v3Best?.adjustedEdge).toBeCloseTo(0.08);
    expect(success.v3AssessmentStats).toHaveLength(3);
    expect(success.v3AssessmentStats?.map((a) => a.outcome)).toEqual(["done", "done", "capped"]);
    expect(success.v3AssessmentStats?.map((a) => a.family)).toEqual([
      "goals_ou",
      "double_chance",
      "asian_handicap",
    ]);
  });

  it("populates v3Best/v3AssessmentStats in 'shadow' mode too (not gated on usedV3, which stays false there)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const done = makeAssessment({
      marketName: "Goals O/U",
      desc: "Over 2.5",
      family: "goals_ou",
      outcome: "done",
      rawEdge: 0.06,
      adjustedEdge: 0.05,
    });
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [done],
      capped: [],
      evMarkets: [v3EvMarket],
      best: v3EvMarket,
    });

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "shadow" },
    });

    const success = result.jobs[0] as FixtureJobSuccess;
    // shadow mode never sets usedV3/eligible from v3 — but the projection is
    // still populated, since it's free transparency, not an act-on-it decision.
    expect(success.eligibleBets?.[0]?.label).toBe("Over 2.5"); // legacy path, unchanged
    expect(success.v3Best?.desc).toBe("Over 2.5");
    expect(success.v3AssessmentStats).toHaveLength(1);
  });

  it("leaves v3Best/v3AssessmentStats undefined when v3 doesn't run (enableMarketsV3 off/unset, or no allMarkets catalogue)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const job = makeJob({ pipeline: { fetched: { sportyBetOdds: { allMarkets } } } });

    const result = await runBatch([job], { storage, config: baseConfig });

    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.v3Best).toBeUndefined();
    expect(success.v3AssessmentStats).toBeUndefined();
    expect(success.v3Coverage).toBeUndefined();
  });

  it("carries the fixture's full v3Coverage (PR-20), same populate-whenever-v3-ran condition as v3Best", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const coverage = {
      total: 42,
      routed: 30,
      byEngine: {
        totals: 20,
        result: 10,
        shape: 0,
        half: 0,
        time: 0,
        exotics: 0,
        corners: 0,
        cards: 0,
      },
      skipped: {
        "player-market": 5,
        "plain-1x2": 3,
        "non-goal-metric": 2,
        "corners-dormant": 1,
        "cards-dormant": 1,
        "settlement-variant": 0,
        "no-grid-model": 0,
        uncatalogued: 0,
        "bad-specifier": 0,
      },
      unrouted: { "Weird New Market": 2 },
    };
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage,
      assessments: [],
      capped: [],
      evMarkets: [v3EvMarket],
      best: v3EvMarket,
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
    expect(success.v3Coverage).toEqual(coverage);
  });
});

describe("batch/index.ts — R10 goals cross-check (PR-6)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: test-only synthetic assessment
  function goalsAssessment(over: Record<string, any> = {}): any {
    return {
      family: "goals_ou",
      marketId: "m1",
      marketName: "Goals O/U",
      outcomeId: "o1",
      desc: "Over 2.5",
      odds: 2.0,
      mp: 0.6,
      q: 0.5,
      devigged: true,
      rawEdge: 0.09,
      penaltyPts: 0.01,
      adjustedEdge: 0.08,
      adjEvPct: 0.16,
      cls: "M",
      outcome: "done",
      confidence: "high",
      ...over,
    };
  }

  function goalsEvMarket(desc: string, rankingScore: number, rawEdge: number): EVMarket {
    return {
      cat: "Goals O/U",
      label: desc,
      market: "Goals O/U",
      side: desc,
      family: "goals_ou",
      mp: 0.6,
      modelProb: 0.6,
      ip: 0.5,
      rawEdge,
      ev: 0.05,
      odds: 2.0,
      stake: 0,
      stakeAmt: 0,
      rankingScore,
      varianceMod: 1,
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: test-only synthetic v3 result
  function mockV3(assessments: any[], evMarkets: EVMarket[]): void {
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments,
      capped: [],
      evMarkets,
      best: evMarkets[0] ?? null,
    });
  }

  const crossCheckJob = () =>
    makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });

  it("drops the top goals pick and re-picks the next-best surviving market on disagree+!survives", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const top = goalsAssessment({ desc: "Over 2.5", adjustedEdge: 0.08, outcomeId: "o-top" });
    const next = goalsAssessment({ desc: "Over 1.5", adjustedEdge: 0.05, outcomeId: "o-next" });
    mockV3(
      [top, next],
      [goalsEvMarket("Over 2.5", 0.08, 0.09), goalsEvMarket("Over 1.5", 0.05, 0.06)]
    );
    const hook = vi.fn().mockReturnValue({
      verdict: "disagree",
      survives: false,
      assessment: { ...top, outcome: "below_gate", adjustedEdge: 0.06, confidence: null },
      annotation: "dropped",
    });

    const result = await runBatch([crossCheckJob()], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on" },
      goalsCrossCheck: hook,
    });

    // Hook saw the top goals-family candidate (highest adjustedEdge), by label+odds.
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]![1]).toBe("Over 2.5");
    expect(hook.mock.calls[0]![2]).toBe(2.0);
    const success = result.jobs[0] as FixtureJobSuccess;
    // Over 2.5 removed from eligible; the already-ranked Over 1.5 takes its place.
    expect(success.eligibleBets?.some((m) => m.label === "Over 2.5")).toBe(false);
    expect(success.eligibleBets?.[0]?.label).toBe("Over 1.5");
    // v3Best (derived from done assessments) is now Over 1.5, since the dropped
    // pick's assessment outcome was rewritten to below_gate.
    expect(success.v3Best?.desc).toBe("Over 1.5");
  });

  it("downgrades in place (edge + ranking) on disagree+survives, keeping the pick", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const top = goalsAssessment({ desc: "Over 2.5", adjustedEdge: 0.08 });
    mockV3([top], [goalsEvMarket("Over 2.5", 0.08, 0.09)]);
    const hook = vi.fn().mockReturnValue({
      verdict: "disagree",
      survives: true,
      assessment: { ...top, adjustedEdge: 0.06, rawEdge: 0.07, penaltyPts: 0.03 },
      annotation: "downgraded",
    });

    const result = await runBatch([crossCheckJob()], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on" },
      goalsCrossCheck: hook,
    });

    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.eligibleBets?.[0]?.label).toBe("Over 2.5"); // survives, still eligible
    expect(success.v3Best?.desc).toBe("Over 2.5");
    expect(success.v3Best?.adjustedEdge).toBeCloseTo(0.06); // downgraded edge, not 0.08
  });

  it("leaves the pick untouched on agree", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const top = goalsAssessment({ desc: "Over 2.5", adjustedEdge: 0.08 });
    mockV3([top], [goalsEvMarket("Over 2.5", 0.08, 0.09)]);
    const hook = vi.fn().mockReturnValue({
      verdict: "agree",
      survives: true,
      assessment: top,
      annotation: "goals-verified",
    });

    const result = await runBatch([crossCheckJob()], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on" },
      goalsCrossCheck: hook,
    });

    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.v3Best?.adjustedEdge).toBeCloseTo(0.08); // unchanged
    expect(success.eligibleBets?.[0]?.label).toBe("Over 2.5");
  });

  it("leaves the pick untouched when the hook returns null (no independent opinion)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const top = goalsAssessment({ desc: "Over 2.5", adjustedEdge: 0.08 });
    mockV3([top], [goalsEvMarket("Over 2.5", 0.08, 0.09)]);
    const hook = vi.fn().mockReturnValue(null);

    const result = await runBatch([crossCheckJob()], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on" },
      goalsCrossCheck: hook,
    });

    expect(hook).toHaveBeenCalledTimes(1);
    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.v3Best?.adjustedEdge).toBeCloseTo(0.08);
  });

  it("skips the cross-check entirely when ORACLE_V3_GOALS_CROSSCHECK is off (v3GoalsCrossCheck=false)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const top = goalsAssessment({ desc: "Over 2.5", adjustedEdge: 0.08 });
    mockV3([top], [goalsEvMarket("Over 2.5", 0.08, 0.09)]);
    const hook = vi.fn();

    await runBatch([crossCheckJob()], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on", v3GoalsCrossCheck: false },
      goalsCrossCheck: hook,
    });

    expect(hook).not.toHaveBeenCalled();
  });

  it("never fires for a non-goals-family top pick (double_chance)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const dc = goalsAssessment({
      family: "double_chance",
      marketName: "Double Chance",
      desc: "Home or Draw",
      odds: 1.25,
      adjustedEdge: 0.08,
    });
    mockV3(
      [dc],
      [
        {
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
          rankingScore: 0.08,
          varianceMod: 1,
        },
      ]
    );
    const hook = vi.fn();

    await runBatch([crossCheckJob()], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on" },
      goalsCrossCheck: hook,
    });

    expect(hook).not.toHaveBeenCalled();
  });
});
