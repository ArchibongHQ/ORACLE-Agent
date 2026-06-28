import { afterEach, describe, expect, it, vi } from "vitest";

const mockIsLocalRuntime = vi.fn();
const mockCallClaudeCode = vi.fn();
const mockLoadSportyBetIndex = vi.fn();
const mockReadGoalsArtifact = vi.fn();
const mockFetchFixtureByName = vi.fn();
const mockRunAnalysis = vi.fn();

vi.mock("@oracle/llm", () => ({
  callClaudeCode: (...a: unknown[]) => mockCallClaudeCode(...a),
  isLocalRuntime: () => mockIsLocalRuntime(),
}));

vi.mock("../src/selectFixtures.js", () => ({
  loadSportyBetIndex: (...a: unknown[]) => mockLoadSportyBetIndex(...a),
}));

vi.mock("../src/goalsArtifact.js", () => ({
  readGoalsArtifact: (...a: unknown[]) => mockReadGoalsArtifact(...a),
}));

vi.mock("../src/fixtures.js", () => ({
  fetchFixtureByName: (...a: unknown[]) => mockFetchFixtureByName(...a),
}));

vi.mock("../src/analyze.js", () => ({
  runAnalysis: (...a: unknown[]) => mockRunAnalysis(...a),
}));

const { runCommentBarInstruction } = await import("../src/commentBarOrchestrator.js");

afterEach(() => vi.clearAllMocks());

describe("runCommentBarInstruction", () => {
  it("reports unavailable when Claude Code is not on this runtime", async () => {
    mockIsLocalRuntime.mockReturnValue(false);
    const r = await runCommentBarInstruction("summarize today", "2026-06-20");
    expect(r.understood).toBe(false);
    expect(r.resultText).toMatch(/not available/);
    expect(mockCallClaudeCode).not.toHaveBeenCalled();
  });

  it("reports unsupported when the LLM classifies it as unsupported", async () => {
    mockIsLocalRuntime.mockReturnValue(true);
    mockCallClaudeCode.mockResolvedValue('{"action":"unsupported"}');
    const r = await runCommentBarInstruction("book me a flight", "2026-06-20");
    expect(r.action).toBe("unsupported");
    expect(r.understood).toBe(true);
  });

  it("summarize action reads the SportyBet index and goals artifact for that date", async () => {
    mockIsLocalRuntime.mockReturnValue(true);
    mockCallClaudeCode.mockResolvedValue('{"action":"summarize"}');
    mockLoadSportyBetIndex.mockResolvedValue({
      date: "2026-06-20",
      events: [
        { home: "A", away: "B", league: "Premier League", marketCount: 5 },
        { home: "C", away: "D", league: "La Liga", marketCount: 5 },
      ],
    });
    mockReadGoalsArtifact.mockResolvedValue(null);
    const r = await runCommentBarInstruction("summarize today's fixtures", "2026-06-20");
    expect(r.action).toBe("summarize");
    expect(r.resultText).toMatch(/2 fixture\(s\) across 2 league\(s\)/);
    expect(mockLoadSportyBetIndex).toHaveBeenCalledWith("2026-06-20");
  });

  it("filter_league action filters events by the extracted league", async () => {
    mockIsLocalRuntime.mockReturnValue(true);
    mockCallClaudeCode.mockResolvedValue('{"action":"filter_league","league":"La Liga"}');
    mockLoadSportyBetIndex.mockResolvedValue({
      date: "2026-06-20",
      events: [
        {
          home: "A",
          away: "B",
          league: "Premier League",
          marketCount: 5,
          kickoff_utc: "2026-06-20T15:00:00Z",
        },
        {
          home: "C",
          away: "D",
          league: "La Liga",
          marketCount: 5,
          kickoff_utc: "2026-06-20T18:00:00Z",
        },
      ],
    });
    const r = await runCommentBarInstruction("only show La Liga", "2026-06-20");
    expect(r.action).toBe("filter_league");
    expect(r.resultText).toMatch(/C vs D/);
    expect(r.resultText).not.toMatch(/A vs B/);
  });

  it("reanalyze_fixture without deps reports it cannot run", async () => {
    mockIsLocalRuntime.mockReturnValue(true);
    mockCallClaudeCode.mockResolvedValue(
      '{"action":"reanalyze_fixture","home":"Arsenal","away":"Chelsea"}'
    );
    const r = await runCommentBarInstruction("reanalyze Arsenal vs Chelsea", "2026-06-20");
    expect(r.action).toBe("reanalyze_fixture");
    expect(r.resultText).toMatch(/requires storage\/config/);
    expect(mockFetchFixtureByName).not.toHaveBeenCalled();
  });

  it("reanalyze_fixture with deps fetches odds and runs analysis", async () => {
    mockIsLocalRuntime.mockReturnValue(true);
    mockCallClaudeCode.mockResolvedValue(
      '{"action":"reanalyze_fixture","home":"Arsenal","away":"Chelsea"}'
    );
    mockFetchFixtureByName.mockResolvedValue({
      home: "Arsenal",
      away: "Chelsea",
      league: "Premier League",
      kickoff: "2026-06-20T15:00:00Z",
    });
    mockRunAnalysis.mockResolvedValue({ reportHtml: "<!DOCTYPE html>...</html>" });
    const deps = { storage: {} as never, config: { oddsApiKey: "k" } as never };
    const r = await runCommentBarInstruction("reanalyze Arsenal vs Chelsea", "2026-06-20", deps);
    expect(r.action).toBe("reanalyze_fixture");
    expect(r.resultText).toBe("<!DOCTYPE html>...</html>");
    expect(mockFetchFixtureByName).toHaveBeenCalledWith("Arsenal", "Chelsea", "k");
  });
});
