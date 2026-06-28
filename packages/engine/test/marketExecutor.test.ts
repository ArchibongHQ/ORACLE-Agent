/** All-markets LLM executor tier (Q4b) tests.
 *  LLM path: mocked via vi.doMock('@oracle/llm') — same pattern as decision.test.ts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionContext } from "../src/decision/index.js";
import type { MarketExecutorRiskParams } from "../src/decision/marketExecutor.js";
import { runAllMarketsLlmExecutor } from "../src/decision/marketExecutor.js";
import type { AllMarketEntry } from "../src/types.js";

const ALL_MARKETS: AllMarketEntry[] = [
  {
    id: "999",
    name: "Correct Score",
    desc: null,
    group: null,
    specifier: null,
    outcomes: [
      { id: "1", desc: "2-1", odds: "8.5" },
      { id: "2", desc: "0-0", odds: "9.0" },
    ],
  },
];

const BASE_CTX: DecisionContext = {
  fixture: {
    home: "Arsenal",
    away: "Chelsea",
    league: "Premier League",
    kickoff: "2026-06-05T15:00:00Z",
  },
  fp: { home: 0.45, draw: 0.28, away: 0.27 },
  lambdaH: 1.45,
  lambdaA: 1.2,
  expectedScoreline: "1-1",
  regime: "STANDARD",
  convergenceTier: "MODERATE",
  convergenceScore: 72,
  mlAllowed: true,
  drawRisk: "MEDIUM",
  betTrigger: "YELLOW",
  portfolioCorrelation: null,
  allMarkets: ALL_MARKETS,
};

const RISK: MarketExecutorRiskParams = {
  dqs: 0.85,
  councilPenalty: false,
  varMultiplier: 1.0,
  drawdownPenalty: 1.0,
  calibFactor: 1.0,
  bankroll: 1000,
};

afterEach(() => {
  vi.doUnmock("@oracle/llm");
});

describe("runAllMarketsLlmExecutor", () => {
  it("returns null when ctx.allMarkets is absent", async () => {
    const result = await runAllMarketsLlmExecutor({ ...BASE_CTX, allMarkets: undefined }, RISK);
    expect(result).toBeNull();
  });

  it("returns null when not running locally (would otherwise spawn a real claude binary)", async () => {
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => false,
      callClaudeCode: vi.fn(),
    }));
    const result = await runAllMarketsLlmExecutor(BASE_CTX, RISK);
    expect(result).toBeNull();
  });

  it("builds a validated EVMarket + decision from a real market+outcome with positive edge", async () => {
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode: vi.fn().mockResolvedValue(
        JSON.stringify({
          marketId: "999",
          outcomeId: "1",
          estimatedProb: 0.25,
          rationale: "2-1 is the most probable scoreline given the lambdas.",
        })
      ),
    }));
    const result = await runAllMarketsLlmExecutor(BASE_CTX, RISK);
    expect(result).not.toBeNull();
    expect(result?.market.cat).toBe("LLM Market Executor");
    expect(result?.market.odds).toBe(8.5);
    expect(result?.market.mp).toBe(0.25);
    expect(result?.market.ev).toBeGreaterThan(0);
    expect(result?.decision.primaryPick.market).toBe("LLM Market Executor");
    expect(result?.decision.primaryPick.side).toBe("2-1");
    expect(result?.replay.model).toBe("claude-code-market-executor");
  });

  it("returns null when the LLM names a market/outcome id that doesn't exist in the catalogue", async () => {
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ marketId: "12345", outcomeId: "99", estimatedProb: 0.9, rationale: "x" })
        ),
    }));
    const result = await runAllMarketsLlmExecutor(BASE_CTX, RISK);
    expect(result).toBeNull();
  });

  it("returns null when the claimed probability doesn't clear positive EV against the real odds", async () => {
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode: vi.fn().mockResolvedValue(
        // 0-0 @ 9.0 implies ip=0.111 — a 0.05 model prob is well below break-even.
        JSON.stringify({ marketId: "999", outcomeId: "2", estimatedProb: 0.05, rationale: "x" })
      ),
    }));
    const result = await runAllMarketsLlmExecutor(BASE_CTX, RISK);
    expect(result).toBeNull();
  });

  it("returns null when the LLM reports no defensible edge anywhere", async () => {
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode: vi.fn().mockResolvedValue(
        JSON.stringify({
          marketId: null,
          outcomeId: null,
          estimatedProb: 0,
          rationale: "nothing clears the bar",
        })
      ),
    }));
    const result = await runAllMarketsLlmExecutor(BASE_CTX, RISK);
    expect(result).toBeNull();
  });

  it("fails open (returns null) when callClaudeCode throws", async () => {
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode: vi.fn().mockRejectedValue(new Error("spawn failed")),
    }));
    const result = await runAllMarketsLlmExecutor(BASE_CTX, RISK);
    expect(result).toBeNull();
  });

  it("fails open (returns null) when the response isn't valid JSON", async () => {
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode: vi.fn().mockResolvedValue("not json at all"),
    }));
    const result = await runAllMarketsLlmExecutor(BASE_CTX, RISK);
    expect(result).toBeNull();
  });
});
