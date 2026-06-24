import type { LLMCallContext } from "@oracle/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalsPreFilterResult } from "../src/goalsPreFilter.js";

vi.mock("@oracle/llm", () => ({
  callClaude: vi.fn(),
  MODELS: { CLAUDE_SONNET: "claude-sonnet-4-6" },
}));

const { callClaude } = await import("@oracle/llm");
const { mergeScreenedCandidates, screenGoalsCandidates } = await import("../src/goalsScreen.js");

afterEach(() => vi.clearAllMocks());

function candidate(home: string, away: string, score: number): GoalsPreFilterResult {
  return {
    event: { home, away, marketCount: 10, league: "Premier League" },
    score,
    tier: "B",
  };
}

function ctx(): LLMCallContext {
  return { config: { claudeApiKey: "test-key", geminiApiKey: "", bankroll: 0 }, requestedAt: "" };
}

describe("screenGoalsCandidates", () => {
  it("returns screened=false for every entry when claudeApiKey is absent (fail-open)", async () => {
    const candidates = [candidate("A", "B", 50), candidate("C", "D", 40)];
    const noKeyCtx: LLMCallContext = {
      config: { claudeApiKey: "", geminiApiKey: "", bankroll: 0 },
      requestedAt: "",
    };
    const results = await screenGoalsCandidates(candidates, noKeyCtx);
    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.screened)).toBe(true);
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("falls open to unscreened when callClaude throws", async () => {
    vi.mocked(callClaude).mockRejectedValue(new Error("network down"));
    const candidates = [candidate("A", "B", 50), candidate("C", "D", 40)];
    const results = await screenGoalsCandidates(candidates, ctx());
    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.screened)).toBe(true);
  });

  it("falls open to unscreened when the response is unparseable", async () => {
    vi.mocked(callClaude).mockResolvedValue("not json at all");
    const candidates = [candidate("A", "B", 50)];
    const results = await screenGoalsCandidates(candidates, ctx());
    expect(results).toHaveLength(1);
    expect(results[0]!.screened).toBe(false);
  });

  it("parses a valid ranked response and maps batch-local indices back to global indices", async () => {
    vi.mocked(callClaude).mockResolvedValue(
      JSON.stringify({
        ranked: [
          { index: 1, rationale: "strong over 2.5 signal" },
          { index: 0, rationale: "weaker but still goals-positive" },
        ],
      })
    );
    const candidates = [candidate("A", "B", 50), candidate("C", "D", 80)];
    const results = await screenGoalsCandidates(candidates, ctx());
    expect(results).toHaveLength(2);
    const byIndex = new Map(results.map((r) => [r.index, r]));
    expect(byIndex.get(1)?.rank).toBe(0);
    expect(byIndex.get(0)?.rank).toBe(1);
    expect(results.every((r) => r.screened)).toBe(true);
  });

  it("dedups a duplicated index in the response, keeping the first (highest-ranked) occurrence", async () => {
    vi.mocked(callClaude).mockResolvedValue(
      JSON.stringify({
        ranked: [
          { index: 1, rationale: "first occurrence — should win" },
          { index: 1, rationale: "duplicate — should be dropped" },
          { index: 0, rationale: "ok" },
        ],
      })
    );
    const candidates = [candidate("A", "B", 50), candidate("C", "D", 80)];
    const results = await screenGoalsCandidates(candidates, ctx());
    // Exactly one entry for index 1, not two — the duplicate must not silently
    // demote or duplicate the candidate's rank.
    expect(results.filter((r) => r.index === 1)).toHaveLength(1);
    expect(results.find((r) => r.index === 1)?.rank).toBe(0);
  });

  it("handles a response wrapped in markdown code fences", async () => {
    vi.mocked(callClaude).mockResolvedValue(
      '```json\n{"ranked":[{"index":0,"rationale":"ok"}]}\n```'
    );
    const candidates = [candidate("A", "B", 50)];
    const results = await screenGoalsCandidates(candidates, ctx());
    expect(results[0]!.screened).toBe(true);
  });

  it("batches large pools and remaps indices per batch correctly", async () => {
    vi.mocked(callClaude).mockImplementation(async (prompt: string) => {
      // Each batch is screened independently — always rank in reverse within the batch.
      const batchLines = prompt.split("\n").filter((l) => /^\[\d+\]/.test(l));
      const ranked = batchLines
        .map((_, i) => i)
        .reverse()
        .map((i) => ({ index: i, rationale: "r" }));
      return JSON.stringify({ ranked });
    });
    const candidates = Array.from({ length: 5 }, (_, i) => candidate(`H${i}`, `A${i}`, 50 - i));
    const results = await screenGoalsCandidates(candidates, ctx(), 3);
    expect(results).toHaveLength(5);
    expect(callClaude).toHaveBeenCalledTimes(2); // batches of 3 + 2
    expect(results.every((r) => r.screened)).toBe(true);
  });
});

describe("mergeScreenedCandidates", () => {
  it("orders screened candidates by rank, then appends unscreened in original order", () => {
    const candidates = [candidate("A", "B", 10), candidate("C", "D", 90), candidate("E", "F", 50)];
    const screenResults = [
      { index: 0, screened: false },
      { index: 1, rank: 0, screened: true as const },
      { index: 2, rank: 1, screened: true as const },
    ];
    const merged = mergeScreenedCandidates(candidates, screenResults);
    expect(merged.map((c) => c.event.home)).toEqual(["C", "E", "A"]);
  });

  it("falls open to the original pre-filter order when every batch failed (all unscreened)", () => {
    const candidates = [candidate("A", "B", 90), candidate("C", "D", 50)];
    const screenResults = [
      { index: 0, screened: false },
      { index: 1, screened: false },
    ];
    const merged = mergeScreenedCandidates(candidates, screenResults);
    expect(merged.map((c) => c.event.home)).toEqual(["A", "C"]);
    expect(merged).toHaveLength(2);
  });
});
