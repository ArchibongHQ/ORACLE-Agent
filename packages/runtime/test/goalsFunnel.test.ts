import type { LLMCallContext } from "@oracle/llm";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@oracle/llm", () => ({
  callClaudeCode: vi.fn(),
  MODELS: { CLAUDE_SONNET: "claude-sonnet-4-6" },
}));

const { callClaudeCode: callClaude } = await import("@oracle/llm");
const { runGoalsFunnel, sportyEventToFixtureJob } = await import("../src/goalsFunnel.js");

import type { SportyBetEvent } from "../src/selectFixtures.js";

afterEach(() => vi.clearAllMocks());

function eventWithOdds(
  home: string,
  away: string,
  league = "Premier League",
  kickoff = "2026-06-25T15:00:00Z"
): SportyBetEvent {
  return {
    home,
    away,
    marketCount: 10,
    league,
    kickoff_utc: kickoff,
    detail: {
      eventId: `e_${home}_${away}`,
      odds: { "1x2": { home: 1.85, draw: 3.4, away: 4.5 } },
      stats: {
        goals: { home: { avg_scored: 2.0 }, away: { avg_scored: 1.5 } },
        overunder: { home: { over25_pct: 0.65 }, away: { over25_pct: 0.6 } },
      },
      statscoverage: null,
    },
  };
}

function eventWithoutOdds(home: string, away: string): SportyBetEvent {
  return {
    home,
    away,
    marketCount: 0,
    league: "Premier League",
    detail: { eventId: `e_${home}_${away}`, odds: null, stats: null, statscoverage: null },
  };
}

describe("sportyEventToFixtureJob", () => {
  it("converts an event with valid 1x2 odds into a FixtureJob", () => {
    const job = sportyEventToFixtureJob(eventWithOdds("A", "B"));
    expect(job).not.toBeNull();
    expect(job?.home).toBe("A");
    expect(job?.away).toBe("B");
    expect(job?.state?.pipeline?.fetched?.odds).toMatchObject({ home: 1.85, away: 4.5 });
    expect(job?.state?.telemetry?.llmEligible).toBe(true);
  });

  it("returns null when the event has no 1x2 odds block", () => {
    expect(sportyEventToFixtureJob(eventWithoutOdds("A", "B"))).toBeNull();
  });

  it("carries rawStatsBlock + travel/motivation telemetry — Phase 3.4 parity fix with the main pipeline", () => {
    // Before the fix, goals-acca legs reached the arbiter with no rawStatsBlock
    // (STEP-0 stats were dropped entirely for this path). Assert the fix sticks.
    const event = eventWithOdds("A", "B");
    const job = sportyEventToFixtureJob(event);
    expect(job?.state?.telemetry?.rawStatsBlock).toBe(event.detail?.stats);
    expect(job?.state?.telemetry?.softContext).toBeDefined();
  });

  it("returns null when the event has no detail at all", () => {
    const bare: SportyBetEvent = { home: "A", away: "B", marketCount: 0 };
    expect(sportyEventToFixtureJob(bare)).toBeNull();
  });
});

describe("runGoalsFunnel", () => {
  it("converts pre-filtered, odds-bearing events into ranked FixtureJob[]", async () => {
    const events = [
      eventWithOdds("A", "B", "Bundesliga"),
      eventWithOdds("C", "D", "Premier League"),
      eventWithoutOdds("E", "F"), // pre-filter keeps it (never excludes on data), conversion drops it
    ];
    const result = await runGoalsFunnel(events, { preFilterPoolSize: 10 });
    expect(result.totalFixtures).toBe(3);
    expect(result.preFilteredCount).toBe(3); // pre-filter never excludes
    expect(result.convertedCount).toBe(2); // conversion drops the odds-less one
    expect(result.jobs).toHaveLength(2);
    expect(callClaude).not.toHaveBeenCalled(); // no llmCtx supplied — screening stage skipped
  });

  it("skips the Sonnet screening stage entirely when no llmCtx is supplied", async () => {
    const events = [eventWithOdds("A", "B", "Bundesliga"), eventWithOdds("C", "D", "La Liga")];
    const result = await runGoalsFunnel(events);
    expect(callClaude).not.toHaveBeenCalled();
    expect(result.jobs).toHaveLength(2);
  });

  it("runs the Sonnet screening stage and reorders jobs by its ranking when llmCtx is supplied", async () => {
    vi.mocked(callClaude).mockResolvedValue(
      JSON.stringify({
        ranked: [
          { index: 1, rationale: "stronger" },
          { index: 0, rationale: "weaker" },
        ],
      })
    );
    const events = [eventWithOdds("A", "B", "Bundesliga"), eventWithOdds("C", "D", "La Liga")];
    const ctx: LLMCallContext = {
      config: { claudeApiKey: "k", geminiApiKey: "", bankroll: 0 },
      requestedAt: "",
    };
    const result = await runGoalsFunnel(events, { llmCtx: ctx });
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(result.jobs.map((j) => j.home)).toEqual(["C", "A"]); // C/D ranked first by Sonnet
  });

  it("falls open to the pre-filter order when the screening call fails", async () => {
    vi.mocked(callClaude).mockRejectedValue(new Error("network down"));
    const events = [eventWithOdds("A", "B", "Bundesliga"), eventWithOdds("C", "D", "La Liga")];
    const ctx: LLMCallContext = {
      config: { claudeApiKey: "k", geminiApiKey: "", bankroll: 0 },
      requestedAt: "",
    };
    const result = await runGoalsFunnel(events, { llmCtx: ctx });
    expect(result.jobs).toHaveLength(2); // never dropped, just unscreened order
  });
});
