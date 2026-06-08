/** CLI dispatch tests — route + arg parsing. Runtime/storage are mocked so no engine runs. */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────
const mockRunAnalysis = vi.fn();
const mockFetchToday = vi.fn();
const mockFetchByName = vi.fn();
const mockResolveDay = vi.fn();
const mockClose = vi.fn();

vi.mock("@oracle/storage", () => ({
  GBrainAdapter: class {
    close = mockClose;
  },
}));

vi.mock("@oracle/runtime", () => ({
  loadEnv: () => ({}),
  buildConfig: () => ({
    geminiApiKey: "",
    claudeApiKey: "",
    bankroll: 1000,
    rankingMode: "CONFIDENCE_WEIGHTED",
    oddsApiKey: "k",
    footballDataApiKey: "fd",
  }),
  fetchTodaysFixtures: (...a: unknown[]) => mockFetchToday(...a),
  fetchFixtureByName: (...a: unknown[]) => mockFetchByName(...a),
  runAnalysis: (...a: unknown[]) => mockRunAnalysis(...a),
  resolveDay: (...a: unknown[]) => mockResolveDay(...a),
}));

vi.mock("@oracle/engine", () => ({
  parseFixtureList: (text: string) =>
    text.trim() ? [{ home: "A", away: "B", league: "L", kickoff: "2026-06-05" }] : [],
}));

const { dispatch } = await import("../src/cli.js");

const fakeBatch = {
  date: "2026-06-05",
  rankingMode: "CONFIDENCE_WEIGHTED",
  jobs: [],
  actionableCount: 0,
  errorCount: 0,
};
const fakeResult = {
  batch: fakeBatch,
  records: [],
  manifest: { runId: "r1" },
  reportHtml: "<html>",
  reportPath: "/tmp/r.html",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRunAnalysis.mockResolvedValue(fakeResult);
});

// ── Pure routing (no engine) ──────────────────────────────────────────────────

describe("dispatch — routing", () => {
  it("help with no command", async () => {
    const r = await dispatch([]);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/Usage: oracle/);
  });

  it("help command", async () => {
    expect((await dispatch(["help"])).output).toMatch(/Commands:/);
  });

  it("unknown command → code 1", async () => {
    const r = await dispatch(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/Unknown command/);
  });

  it("fixture with no arg → usage error", async () => {
    const r = await dispatch(["fixture"]);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/Usage: oracle fixture/);
  });

  it("fixture with unparseable arg → parse error", async () => {
    const r = await dispatch(["fixture", "just one team"]);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/Could not parse/);
  });

  it("analyze with no file → usage error", async () => {
    const r = await dispatch(["analyze"]);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/Usage: oracle analyze/);
  });

  it("report prints a dated path", async () => {
    const r = await dispatch(["report", "--date", "2026-06-05"]);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/oracle-2026-06-05\.html/);
  });
});

// ── Commands that hit the (mocked) runtime ────────────────────────────────────

describe("dispatch — runtime delegation", () => {
  it("run with fixtures → calls runAnalysis, closes storage", async () => {
    mockFetchToday.mockResolvedValue({
      jobs: [{ home: "A", away: "B", league: "L", kickoff: "k" }],
      source: "api",
    });
    const r = await dispatch(["run"]);
    expect(mockRunAnalysis).toHaveBeenCalledOnce();
    expect(mockClose).toHaveBeenCalledOnce();
    expect(r.code).toBe(0);
  });

  it("run with no fixtures → code 1, no analysis", async () => {
    mockFetchToday.mockResolvedValue({ jobs: [], source: "empty" });
    const r = await dispatch(["run"]);
    expect(mockRunAnalysis).not.toHaveBeenCalled();
    expect(r.code).toBe(1);
  });

  it("fixture found → analyses single job", async () => {
    mockFetchByName.mockResolvedValue({
      home: "Arsenal",
      away: "Chelsea",
      league: "Premier League",
      kickoff: "k",
    });
    const r = await dispatch(["fixture", "Arsenal vs Chelsea", "--league", "Premier League"]);
    expect(mockFetchByName).toHaveBeenCalledWith("Arsenal", "Chelsea", "k", "Premier League");
    expect(mockRunAnalysis).toHaveBeenCalledOnce();
    expect(r.code).toBe(0);
  });

  it("fixture not found → code 1", async () => {
    mockFetchByName.mockResolvedValue(null);
    const r = await dispatch(["fixture", "Foo vs Bar"]);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/No odds found/);
  });

  it("--no-llm zeroes the LLM keys passed to runAnalysis", async () => {
    mockFetchByName.mockResolvedValue({ home: "A", away: "B", league: "L", kickoff: "k" });
    await dispatch(["fixture", "A vs B", "--no-llm"]);
    const [, deps] = mockRunAnalysis.mock.calls[0] as [
      unknown,
      { config: { claudeApiKey: string; geminiApiKey: string } },
    ];
    expect(deps.config.claudeApiKey).toBe("");
    expect(deps.config.geminiApiKey).toBe("");
  });

  it("resolve delegates to resolveDay", async () => {
    mockResolveDay.mockResolvedValue({
      date: "2026-06-04",
      candidates: 3,
      resolved: [1, 2],
      unmatched: [3],
    });
    const r = await dispatch(["resolve", "--date", "2026-06-04"]);
    expect(mockResolveDay).toHaveBeenCalled();
    expect(r.output).toMatch(/Resolved 2\/3/);
  });

  it("--json emits JSON for run", async () => {
    mockFetchToday.mockResolvedValue({
      jobs: [{ home: "A", away: "B", league: "L", kickoff: "k" }],
      source: "api",
    });
    const r = await dispatch(["run", "--json"]);
    expect(() => JSON.parse(r.output)).not.toThrow();
  });
});
