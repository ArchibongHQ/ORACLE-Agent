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

// [Wave 4-accuracy] Since batch/index.ts now derives `eligible` from
// v3Result.assessments (via v3AssessmentsToEvMarkets — the Kelly-wiring fix,
// see batch/index.ts's usedV3 block), a mock that only sets `evMarkets` and
// leaves `assessments: []` no longer produces a live eligible candidate.
// This builds a matching "done" assessment from an EVMarket fixture so
// existing/new tests below stay representative of the real pipeline shape.
// biome-ignore lint/suspicious/noExplicitAny: test-only synthetic assessment
function v3DoneAssessmentFor(m: EVMarket, overrides: Record<string, any> = {}): any {
  return {
    family: m.family,
    marketId: "m1",
    marketName: m.cat,
    outcomeId: "o1",
    desc: m.label,
    odds: m.odds,
    mp: m.mp,
    q: m.ip,
    devigged: true,
    rawEdge: m.rawEdge,
    penaltyPts: 0,
    adjustedEdge: m.rankingScore,
    // `ev` (not just adjEvPct) must be set — buildEligibleBets (now applied
    // to the v3-derived `eligible` too, 2026-07-19 Under-ban widening) hard
    // -requires ev>0, matching the real V3MarketOutcomeAssessment shape
    // (evGate.ts) where `ev` is a required, always-populated field.
    ev: m.ev,
    adjEvPct: m.ev,
    cls: "M",
    outcome: "done",
    confidence: "medium",
    ...overrides,
  };
}

// [Under ban, 2026-07-19] Reproduces the exact production incident shape end
// -to-end through runBatch: the LEGACY ExecutionEngine.scanMarkets()/
// scanAllMarketsFallback() path (enableMarketsV3 unset/off, so v3 never runs)
// can price combo-family ("Home & Under 2.5") and half-family ("SH Under
// 1.5") Under legs alongside genuinely eligible candidates — before this fix
// none of the three pre-existing Under strips (all TOTALS_FAMILIES-only)
// ever touched this path, since it doesn't go through analyzeFixtureMarketsV3
// or v3AssessmentsToEvMarkets at all. buildEligibleBets (decision/index.ts)
// is the ONE function every legacy `eligible` list flows through
// (batch/index.ts's `let eligible = buildEligibleBets(evMarkets)`), which is
// exactly why the fix lives there.
describe("batch/index.ts — universal Under ban on the legacy pricer path (production incident reproduction)", () => {
  it("strips combo and half Under legs from a legacy ExecutionEngine.run() result, keeping the genuinely eligible non-Under candidates, with enableMarketsV3 unset (pure legacy path, no v3 involvement)", async () => {
    const comboUnder: EVMarket = {
      cat: "Combo",
      label: "Home & Under 2.5",
      market: "Combo",
      side: "Home & Under 2.5",
      family: "combo",
      mp: 0.5,
      modelProb: 0.5,
      ip: 0.3,
      rawEdge: 0.2,
      ev: 0.5, // deliberately huge EV — must still be stripped, proving the
      // ban isn't relying on the candidate losing on its own economic merits
      odds: 6.0,
      stake: 0.2,
      stakeAmt: 200,
      rankingScore: 0.5,
      varianceMod: 1,
    };
    const halfUnder: EVMarket = {
      cat: "Half",
      label: "SH Under 1.5",
      market: "Half",
      side: "SH Under 1.5",
      family: "half",
      mp: 0.6,
      modelProb: 0.6,
      ip: 0.4,
      rawEdge: 0.2,
      ev: 0.4,
      odds: 2.5,
      stake: 0.15,
      stakeAmt: 150,
      rankingScore: 0.4,
      varianceMod: 1,
    };
    const genuineDoubleChance: EVMarket = {
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
      stake: 0.03,
      stakeAmt: 30,
      rankingScore: 0.06,
      varianceMod: 1,
    };
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce({
      ...legacyRunResult,
      // Ranked so a naive top-N-by-score selection would pick the Unders
      // FIRST if the ban didn't fire — proves stripping, not mere reordering.
      evMarkets: [comboUnder, halfUnder, genuineDoubleChance],
    });
    const job = makeJob({ pipeline: { fetched: { sportyBetOdds: { allMarkets } } } });

    const result = await runBatch([job], { storage, config: baseConfig });

    expect(analyzeFixtureMarketsV3Mock).not.toHaveBeenCalled(); // confirms pure legacy path
    const success = result.jobs[0] as FixtureJobSuccess;
    const labels = success.eligibleBets?.map((m) => m.label) ?? [];
    expect(labels).not.toContain("Home & Under 2.5");
    expect(labels).not.toContain("SH Under 1.5");
    expect(labels).toContain("Home or Draw");
    expect(success.eligibleBets).toHaveLength(1);
    // The delivered primaryPick itself must never be an Under, end to end.
    expect(success.decision.primaryPick.side).toBe("Home or Draw");
  });

  it("delivers an honest NO_EDGE / empty pool when EVERY legacy candidate is an Under — never fabricates a non-Under pick or silently re-admits one", async () => {
    const comboUnder: EVMarket = {
      cat: "Combo",
      label: "Under 2.5 & BTTS No",
      market: "Combo",
      side: "Under 2.5 & BTTS No",
      family: "combo",
      mp: 0.55,
      modelProb: 0.55,
      ip: 0.4,
      rawEdge: 0.15,
      ev: 0.3,
      odds: 3.0,
      stake: 0.1,
      stakeAmt: 100,
      rankingScore: 0.3,
      varianceMod: 1,
    };
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce({
      ...legacyRunResult,
      evMarkets: [comboUnder],
    });
    const job = makeJob({ pipeline: { fetched: { sportyBetOdds: { allMarkets } } } });

    const result = await runBatch([job], { storage, config: baseConfig });

    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.eligibleBets ?? []).toHaveLength(0);
    expect(success.eligibleBets?.some((m) => m.label === "Under 2.5 & BTTS No")).not.toBe(true);
  });
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
      assessments: [v3DoneAssessmentFor(v3EvMarket)],
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
      assessments: many.map((m, i) => v3DoneAssessmentFor(m, { outcomeId: `o${i}` })),
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
      assessments: [v3DoneAssessmentFor(v3EvMarket)],
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

  it('PR-23 "unmapped" scope: does NOT demote the executor when v3 supplied candidates — narrows ctx.allMarkets to just the recoverable skip-tail instead', async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [v3DoneAssessmentFor(v3EvMarket)],
      capped: [],
      evMarkets: [v3EvMarket],
      best: v3EvMarket,
    });
    const routedEntry = allMarkets[0]!; // "Double Chance" — routes normally, NOT tail
    const tailEntry: AllMarketEntry = {
      id: "999999",
      name: "Some Uncatalogued Market",
      outcomes: [{ id: "1", desc: "Yes", odds: "1.9" }],
    };
    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets: [routedEntry, tailEntry] } } },
    });

    await runBatch([job], {
      storage,
      config: {
        ...baseConfig,
        enableMarketsV3: "on",
        enableLlmMarketExecutor: true,
        llmExecutorScope: "unmapped",
      },
    });

    // NOT suppressed (unlike "full" scope's demote, tested above).
    expect(runAllMarketsLlmExecutorMock).toHaveBeenCalledTimes(1);
    const ctxSeenByExecutor = runAllMarketsLlmExecutorMock.mock.calls[0]![0];
    // Only the tail entry — the routed "Double Chance" entry v3 already
    // handled is excluded, so the executor sweeps what v3 couldn't price
    // instead of re-analyzing the whole catalogue.
    expect(ctxSeenByExecutor.allMarkets).toEqual([tailEntry]);
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

describe("batch/index.ts — Kelly wiring (Wave 4-accuracy)", () => {
  it("a gate-passing v3 pick carries a real Kelly stake (was stake:0/stakeAmt:0 before the fix), within the optimizedKelly hard cap", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    // v3Result.evMarkets itself still carries the stake:0 placeholder (that's
    // analyzeFixtureMarketsV3's own contract — it only gates/ranks) — the fix
    // is that batch/index.ts no longer uses this list verbatim for `eligible`.
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [v3DoneAssessmentFor(v3EvMarket)],
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
    const pick = success.eligibleBets?.find((m) => m.label === "Home or Draw");
    expect(pick).toBeDefined();
    // The mocked v3Result.evMarkets entry itself is still stake:0 — proves
    // `eligible` came from the Kelly-staked assessment derivation, not a
    // pass-through of v3Result.evMarkets.
    expect(v3EvMarket.stake).toBe(0);
    expect(pick!.stake).toBeGreaterThan(0);
    expect(pick!.stake).toBeLessThanOrEqual(0.15); // optimizedKelly's hard cap (math/index.ts)
    expect(pick!.stakeAmt).toBeCloseTo(pick!.stake * baseConfig.bankroll, 5);
  });

  it("a below_gate/capped assessment never reaches eligible with a stake — v3AssessmentsToEvMarkets filters to outcome==='done' only", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const notDone = v3DoneAssessmentFor(v3EvMarket, { outcome: "below_gate", confidence: null });
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [notDone],
      capped: [],
      evMarkets: [],
      best: null,
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
    // Fails open to the legacy candidate — v3 produced nothing staked.
    expect(success.eligibleBets?.[0]?.label).toBe("Over 2.5");
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
      // ev (not just adjEvPct) must be set — buildEligibleBets (now applied
      // to the v3-derived `eligible` too, 2026-07-19 Under-ban widening)
      // hard-requires ev>0. 0.2 = mp*odds-1 = 0.6*2.0-1, consistent with
      // this helper's own mp/odds above.
      ev: 0.2,
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

  it("HARD INVARIANT: never derives v3Best from a 'done' goals_ou/team_total Under assessment, even when it has the highest adjustedEdge (adversarial review finding, 2026-07-16 — v3Best sources from raw assessments, not the Under-stripped evMarkets analyzeFixtureMarketsV3 returns, so this exclusion must be applied here too or a gate-passing Under reaches the delivered slate output)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const doneUnder = makeAssessment({
      marketName: "Goals O/U",
      desc: "Under 2.5",
      family: "goals_ou",
      outcome: "done",
      rawEdge: 0.2,
      adjustedEdge: 0.18, // highest edge — would win v3Best if not excluded
    });
    const doneOver = makeAssessment({
      marketName: "Goals O/U",
      desc: "Over 1.5",
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
      assessments: [doneUnder, doneOver],
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
    expect(success.v3Best?.desc).toBe("Over 1.5");
    expect(success.v3Best?.desc).not.toBe("Under 2.5");
  });

  it("HARD INVARIANT: never derives `eligible`/eligibleBets from a 'done' goals_ou/team_total Under assessment (adversarial review finding, 2026-07-16 — v3AssessmentsToEvMarkets is the canonical Kelly staker feeding the live arbiter pool and primaryPick; analyzeFixtureMarketsV3 only strips Unders from its own evMarkets return value, leaving assessments untouched)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const doneUnder = makeAssessment({
      marketName: "Goals O/U",
      desc: "Under 2.5",
      family: "goals_ou",
      outcome: "done",
      rawEdge: 0.2,
      adjustedEdge: 0.18,
    });
    const doneOver = makeAssessment({
      marketName: "Goals O/U",
      desc: "Over 1.5",
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
      assessments: [doneUnder, doneOver],
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
    expect(success.eligibleBets?.some((m) => m.label === "Under 2.5")).toBe(false);
    expect(success.eligibleBets?.some((m) => m.label === "Over 1.5")).toBe(true);
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

// Gate-failed on the class-edge bar specifically (outcome "below_gate",
// gateReason "class_edge") but +EV at the true model price — the exact
// shape v3BestFallback is meant to surface for the slate pool. The fallback
// filter (batch/index.ts) requires BOTH outcome==="below_gate" AND
// gateReason==="class_edge" — see the HARD INVARIANT comment there
// (adversarial review, 2026-07-16): outcome/gateReason are overridable here
// specifically so the tests below can exercise "capped"/"noise"/other
// below_gate reasons and confirm they're excluded. Module-scoped (not
// describe-local) since the v3Watchlist describe block below (Phase 2,
// two-tier slate — a sibling of v3BestFallback, same underlying
// assessments) reuses it too.
function makeGateFailedAssessment(overrides: {
  marketName: string;
  desc: string;
  family: string;
  ev: number;
  adjustedEdge: number;
  outcome?: string;
  gateReason?: string;
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
    rawEdge: 0.06,
    penaltyPts: 0.01,
    adjustedEdge: overrides.adjustedEdge,
    adjEvPct: 0.1,
    ev: overrides.ev,
    cls: "M",
    outcome: overrides.outcome ?? "below_gate",
    gateReason: overrides.gateReason ?? "class_edge",
    confidence: null,
  };
}

describe("batch/index.ts — v3BestFallback fill-to-39 projection (patterns-engine Wave 2)", () => {
  it("derives v3BestFallback from the best +EV gate-failed assessment when v3Patterns is 'on'", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const failedButPositive = makeGateFailedAssessment({
      marketName: "Asian Handicap",
      desc: "Home -1",
      family: "asian_handicap",
      ev: 0.05,
      adjustedEdge: 0.02,
    });
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [failedButPositive],
      capped: [],
      evMarkets: [],
      best: null,
    });

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on", v3Patterns: "on" },
    });

    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.v3Best).toBeUndefined(); // nothing cleared the gate — fails open as before
    expect(success.v3BestFallback?.desc).toBe("Home -1");
    expect(success.v3BestFallback?.marketName).toBe("Asian Handicap");
    expect(success.v3BestFallback?.adjustedEdge).toBeCloseTo(0.02);
  });

  it("leaves v3BestFallback undefined when v3Patterns is off/absent, even with a +EV gate-failed candidate present", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const failedButPositive = makeGateFailedAssessment({
      marketName: "Asian Handicap",
      desc: "Home -1",
      family: "asian_handicap",
      ev: 0.05,
      adjustedEdge: 0.02,
    });
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [failedButPositive],
      capped: [],
      evMarkets: [],
      best: null,
    });

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    // v3Patterns absent from config — byte-identical to pre-Wave-2 behavior.
    const resultAbsent = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on" },
    });
    expect((resultAbsent.jobs[0] as FixtureJobSuccess).v3BestFallback).toBeUndefined();

    const resultOff = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on", v3Patterns: "off" },
    });
    expect((resultOff.jobs[0] as FixtureJobSuccess).v3BestFallback).toBeUndefined();
  });

  it("HARD INVARIANT: never derives v3BestFallback from a 'capped' or 'noise' outcome, even when +EV and higher-edge than a genuine class_edge candidate (adversarial review finding, 2026-07-16 — a capped/noise candidate's inflated edge must never re-enter the actionable pool via the fallback)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    // Mirrors the counter-example from the review: a capped "model too hot"
    // longshot has the LARGEST adjustedEdge of the three, so a naive
    // "outcome !== done" / "highest edge wins" filter would pick this one.
    const cappedFakeLongshot = makeGateFailedAssessment({
      marketName: "Match Result",
      desc: "Away",
      family: "match_result",
      ev: 0.86,
      adjustedEdge: 0.2,
      outcome: "capped",
      gateReason: "capped_absolute",
    });
    const noiseCandidate = makeGateFailedAssessment({
      marketName: "Over/Under",
      desc: "Over 2.5",
      family: "goals_ou",
      ev: 0.03,
      adjustedEdge: 0.005,
      outcome: "noise",
      gateReason: "noise",
    });
    const genuineClassEdge = makeGateFailedAssessment({
      marketName: "Asian Handicap",
      desc: "Home -1",
      family: "asian_handicap",
      ev: 0.05,
      adjustedEdge: 0.02,
      outcome: "below_gate",
      gateReason: "class_edge",
    });
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 3, routed: 3, byEngine: {}, skipped: {} },
      assessments: [cappedFakeLongshot, noiseCandidate, genuineClassEdge],
      capped: [cappedFakeLongshot],
      evMarkets: [],
      best: null,
    });

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on", v3Patterns: "on" },
    });

    const success = result.jobs[0] as FixtureJobSuccess;
    // The genuine class_edge candidate wins, DESPITE having the smallest edge
    // of the three — capped/noise are excluded outright, not merely outranked.
    expect(success.v3BestFallback?.desc).toBe("Home -1");
    expect(success.v3BestFallback?.marketName).toBe("Asian Handicap");
  });

  it("excludes a below_gate candidate whose gateReason is NOT class_edge (e.g. max_odds/ev_floor) — the fallback only surfaces what the class-edge relaxation itself would rescue", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const wrongReason = makeGateFailedAssessment({
      marketName: "Exotics",
      desc: "Correct Score 3-1",
      family: "exotics",
      ev: 0.3,
      adjustedEdge: 0.1,
      outcome: "below_gate",
      gateReason: "max_odds",
    });
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [wrongReason],
      capped: [],
      evMarkets: [],
      best: null,
    });

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on", v3Patterns: "on" },
    });

    expect((result.jobs[0] as FixtureJobSuccess).v3BestFallback).toBeUndefined();
  });
});

// [Phase 2, two-tier slate] v3Watchlist is the WIDENED sibling of
// v3BestFallback above — deliberately contrasted here per the plan's
// "update the class_edge-only pins ... deliberately" instruction. Where
// v3BestFallback requires BOTH outcome==="below_gate" AND
// gateReason==="class_edge" (narrow, single-candidate, feeds only the
// fill-to-39 back door), v3Watchlist admits ANY below-gate +EV assessment
// (any gateReason, and capped/noise outcomes too — tagged, never hidden)
// as a full array, one entry per qualifying assessment, feeding the Tier②
// two-tier slate pool. Both fields coexist and are derived from the SAME
// v3Result.assessments in the SAME batch/index.ts block — this is not a
// replacement, the narrower field's existing tests above remain valid.
describe("batch/index.ts — v3Watchlist widened Tier② projection (Phase 2, two-tier slate)", () => {
  it("includes a below_gate candidate whose gateReason is NOT class_edge — the exact shape v3BestFallback's sibling test above excludes", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const wrongReasonForFallback = makeGateFailedAssessment({
      marketName: "Exotics",
      desc: "Correct Score 3-1",
      family: "exotics",
      ev: 0.3,
      adjustedEdge: 0.1,
      outcome: "below_gate",
      gateReason: "max_odds",
    });
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [wrongReasonForFallback],
      capped: [],
      evMarkets: [],
      best: null,
    });

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on", v3Patterns: "on" },
    });

    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.v3BestFallback).toBeUndefined(); // narrow field: correctly excludes
    expect(success.v3Watchlist).toHaveLength(1); // wide field: correctly includes
    expect(success.v3Watchlist?.[0]?.desc).toBe("Correct Score 3-1");
    expect(success.v3Watchlist?.[0]?.shortfall).toBe("max_odds");
  });

  it("includes a capped outcome, tagged with its capReason — transparency (v6.2: demotions, not deletions), never hidden", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const capped = {
      ...makeGateFailedAssessment({
        marketName: "Exotics",
        desc: "HT/FT Draw/Home",
        family: "exotics",
        ev: 0.4,
        adjustedEdge: 0.3,
        outcome: "capped",
      }),
      capReason: "absolute",
    };
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [capped],
      capped: [capped],
      evMarkets: [],
      best: null,
    });

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on", v3Patterns: "on" },
    });

    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.v3Watchlist).toHaveLength(1);
    expect(success.v3Watchlist?.[0]?.shortfall).toBe("capped (absolute)");
  });

  it("never includes an Under-desc candidate, even with a huge +EV — the universal Under ban applies to the watchlist too, not just Tier①", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const underCandidate = makeGateFailedAssessment({
      marketName: "Goals O/U",
      desc: "Under 2.5",
      family: "goals_ou",
      ev: 0.9,
      adjustedEdge: 0.5,
    });
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [underCandidate],
      capped: [],
      evMarkets: [],
      best: null,
    });

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on", v3Patterns: "on" },
    });

    expect((result.jobs[0] as FixtureJobSuccess).v3Watchlist).toEqual([]);
  });

  it("excludes a −EV below_gate candidate — the ev>0 floor applies to the watchlist too, no exception", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const negativeEv = makeGateFailedAssessment({
      marketName: "Asian Handicap",
      desc: "Home -1",
      family: "asian_handicap",
      ev: -0.02,
      adjustedEdge: 0.01,
    });
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [negativeEv],
      capped: [],
      evMarkets: [],
      best: null,
    });

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on", v3Patterns: "on" },
    });

    expect((result.jobs[0] as FixtureJobSuccess).v3Watchlist).toEqual([]);
  });

  it("populates v3Watchlist even when v3Patterns is off/absent — deliberately NOT gated on v3Patterns (adversarial review finding, 2026-07-20: v3Watchlist's own filter has no pattern dependency, and Phase 2's rollout flag is unifiedSlate, not v3Patterns — coupling it to v3Patterns would silently empty Tier② whenever an operator set ORACLE_V3_PATTERNS=off while Tier① kept populating normally)", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const qualifying = makeGateFailedAssessment({
      marketName: "Asian Handicap",
      desc: "Home -1",
      family: "asian_handicap",
      ev: 0.05,
      adjustedEdge: 0.02,
    });
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [qualifying],
      capped: [],
      evMarkets: [],
      best: null,
    });

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on" }, // v3Patterns absent
    });

    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.v3Watchlist).toHaveLength(1);
    expect(success.v3Watchlist?.[0]?.desc).toBe("Home -1");
    // v3BestFallback stays correctly gated on v3Patterns — unchanged,
    // pre-existing behavior, a genuinely different feature scope.
    expect(success.v3BestFallback).toBeUndefined();
  });

  it("v3BestFallback stays undefined when v3Patterns is explicitly 'off', even though v3Watchlist populates for the same fixture", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(legacyRunResult);
    const qualifying = makeGateFailedAssessment({
      marketName: "Asian Handicap",
      desc: "Home -1",
      family: "asian_handicap",
      ev: 0.05,
      adjustedEdge: 0.02,
    });
    analyzeFixtureMarketsV3Mock.mockReturnValue({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [qualifying],
      capped: [],
      evMarkets: [],
      best: null,
    });

    const job = makeJob({
      telemetry: { scoredPer90H: 1.7 },
      pipeline: { fetched: { sportyBetOdds: { allMarkets } } },
    });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on", v3Patterns: "off" },
    });

    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.v3BestFallback).toBeUndefined();
    expect(success.v3Watchlist).toHaveLength(1);
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
      // ev (not just adjEvPct) must be set — buildEligibleBets (now applied
      // to the v3-derived `eligible` too, 2026-07-19 Under-ban widening)
      // hard-requires ev>0. 0.2 = mp*odds-1 = 0.6*2.0-1, consistent with
      // this fixture's own mp/odds below.
      ev: 0.2,
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
