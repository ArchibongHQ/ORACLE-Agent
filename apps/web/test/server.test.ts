/** Web handleRequest tests — routing + body parsing. Runtime/engine mocked (no engine runs). */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchByName = vi.fn();
const mockRunAnalysis = vi.fn();
const mockParseList = vi.fn();
const mockReadGoalsArtifact = vi.fn();
const mockRunCommentBarInstruction = vi.fn();

vi.mock("@oracle/storage", () => ({ GBrainAdapter: class {} }));

vi.mock("@oracle/engine", () => ({
  parseFixtureList: (...a: unknown[]) => mockParseList(...a),
}));

vi.mock("@oracle/runtime", () => ({
  loadEnv: () => ({}),
  buildConfig: () => ({ oddsApiKey: "k", rankingMode: "CONFIDENCE_WEIGHTED" }),
  fetchFixtureByName: (...a: unknown[]) => mockFetchByName(...a),
  runAnalysis: (...a: unknown[]) => mockRunAnalysis(...a),
  readGoalsArtifact: (...a: unknown[]) => mockReadGoalsArtifact(...a),
  runCommentBarInstruction: (...a: unknown[]) => mockRunCommentBarInstruction(...a),
  SPORT_TO_LEAGUE: { soccer_epl: "Premier League", soccer_spain_la_liga: "La Liga" },
  ORACLE_PRIORITY_LEAGUES: ["Championship"],
  GOALS_RICH_LEAGUES: ["Eredivisie"],
  REPORT_CSS: "",
  pct: (n: number) => `${(n * 100).toFixed(1)}%`,
}));

const { handleRequest } = await import("../src/server.js");

const deps = {
  storage: {} as never,
  config: { oddsApiKey: "k", rankingMode: "CONFIDENCE_WEIGHTED" } as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRunAnalysis.mockResolvedValue({
    reportHtml: "<html>REPORT</html>",
    reportPath: "/tmp/r.html",
    batch: {},
    records: [],
    manifest: {},
  });
});

describe("GET routes", () => {
  it("GET / serves the search page", async () => {
    const r = await handleRequest("GET", "/", "", "", deps);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.body).toMatch(/ORACLE/);
    expect(r.body).toMatch(/Premier League/); // league option from mocked SPORT_TO_LEAGUE
  });

  it("GET /health returns ok json with worker heartbeat field", async () => {
    const r = await handleRequest("GET", "/health", "", "", deps);
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.body);
    expect(parsed.ok).toBe(true);
    expect(parsed).toHaveProperty("worker"); // null when the worker has never stamped a heartbeat
  });

  it("GET /reports/<bad date> → 400", async () => {
    const r = await handleRequest("GET", "/reports/not-a-date", "", "", deps);
    expect(r.status).toBe(400);
  });

  it("GET /reports/<missing> → 404", async () => {
    const r = await handleRequest("GET", "/reports/1999-01-01", "", "", deps);
    expect(r.status).toBe(404);
  });

  it("unknown route → 404", async () => {
    const r = await handleRequest("GET", "/nope", "", "", deps);
    expect(r.status).toBe(404);
  });
});

describe("GET /goals", () => {
  it("GET /goals with no artifact for today → renders empty-state page", async () => {
    mockReadGoalsArtifact.mockResolvedValue(null);
    const r = await handleRequest("GET", "/goals", "", "", deps);
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/Goals ACCA/);
    expect(r.body).toMatch(/No goals-ACCA run found/);
  });

  it("GET /goals/<date> with an artifact → renders the slips", async () => {
    mockReadGoalsArtifact.mockResolvedValue({
      date: "2026-06-20",
      generatedAt: "2026-06-20T08:30:00.000Z",
      selection: {
        legs: [],
        shortSlipLegs: [
          {
            home: "Arsenal",
            away: "Chelsea",
            league: "Premier League",
            kickoff: "2026-06-20T15:00:00Z",
            market: "Goals O/U",
            side: "Over 2.5",
            odds: 1.85,
            mp: 0.78,
            ip: 0.54,
            edge: 0.24,
          },
        ],
        target: 39,
        analysed: 50,
        qualified: 1,
        counts: { over15: 1, over25: 1, teamOver05: 0 },
        combinedProb: 0,
        combinedOdds: 0,
        shortSlipCombinedProb: 0.78,
        shortSlipCombinedOdds: 1.85,
        outputBLegs: [],
        outputCLegs: [],
        miniAccaLegs: [],
        miniAccaCombinedProb: 0,
        miniAccaCombinedOdds: 0,
      },
    });
    const r = await handleRequest("GET", "/goals/2026-06-20", "", "", deps);
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/Arsenal vs Chelsea/);
    expect(mockReadGoalsArtifact).toHaveBeenCalledWith("2026-06-20", expect.any(String));
  });

  it("GET /goals/<bad date> → 400", async () => {
    const r = await handleRequest("GET", "/goals/not-a-date", "", "", deps);
    expect(r.status).toBe(400);
  });
});

describe("POST /comment", () => {
  it("missing date or instruction → 400", async () => {
    const r = await handleRequest(
      "POST",
      "/comment",
      "instruction=summarize",
      "application/x-www-form-urlencoded",
      deps
    );
    expect(r.status).toBe(400);
    expect(mockRunCommentBarInstruction).not.toHaveBeenCalled();
  });

  it("malformed date (path-traversal attempt) → 400, never reaches the orchestrator", async () => {
    const r = await handleRequest(
      "POST",
      "/comment",
      `date=${encodeURIComponent("../../../../etc/passwd")}&instruction=summarize`,
      "application/x-www-form-urlencoded",
      deps
    );
    expect(r.status).toBe(400);
    expect(mockRunCommentBarInstruction).not.toHaveBeenCalled();
  });

  it("summarize action → renders landing page with the result text", async () => {
    mockRunCommentBarInstruction.mockResolvedValue({
      understood: true,
      action: "summarize",
      resultText: "3 fixture(s) across 2 league(s).",
    });
    const r = await handleRequest(
      "POST",
      "/comment",
      "date=2026-06-20&instruction=summarize+today",
      "application/x-www-form-urlencoded",
      deps
    );
    expect(mockRunCommentBarInstruction).toHaveBeenCalledWith(
      "summarize today",
      "2026-06-20",
      deps
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/3 fixture\(s\) across 2 league\(s\)/);
  });

  it("reanalyze_fixture action returning a full report → serves it standalone", async () => {
    mockRunCommentBarInstruction.mockResolvedValue({
      understood: true,
      action: "reanalyze_fixture",
      resultText: "<!DOCTYPE html><html><body>REPORT</body></html>",
    });
    const r = await handleRequest(
      "POST",
      "/comment",
      "date=2026-06-20&instruction=reanalyze+Arsenal+vs+Chelsea",
      "application/x-www-form-urlencoded",
      deps
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe("<!DOCTYPE html><html><body>REPORT</body></html>");
  });
});

describe("POST /analyze", () => {
  it("empty body → 400", async () => {
    const r = await handleRequest(
      "POST",
      "/analyze",
      "",
      "application/x-www-form-urlencoded",
      deps
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Nothing to analyse/);
  });

  it("unparseable query → 400", async () => {
    const r = await handleRequest(
      "POST",
      "/analyze",
      "query=oneword",
      "application/x-www-form-urlencoded",
      deps
    );
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Could not parse/);
  });

  it("query with no odds match → 200 notice", async () => {
    mockFetchByName.mockResolvedValue(null);
    const r = await handleRequest(
      "POST",
      "/analyze",
      "query=Foo+vs+Bar",
      "application/x-www-form-urlencoded",
      deps
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/No odds found/);
    expect(mockRunAnalysis).not.toHaveBeenCalled();
  });

  it("query found → analyses and returns report html", async () => {
    mockFetchByName.mockResolvedValue({
      home: "Arsenal",
      away: "Chelsea",
      league: "Premier League",
      kickoff: "k",
    });
    const r = await handleRequest(
      "POST",
      "/analyze",
      "query=Arsenal+vs+Chelsea&league=Premier+League",
      "application/x-www-form-urlencoded",
      deps
    );
    expect(mockFetchByName).toHaveBeenCalledWith("Arsenal", "Chelsea", "k", "Premier League");
    expect(mockRunAnalysis).toHaveBeenCalledOnce();
    expect(r.body).toMatch(/REPORT/);
  });

  it("pasted list → parseFixtureList → analyses", async () => {
    mockParseList.mockReturnValue([{ home: "A", away: "B", league: "L", kickoff: "k" }]);
    const body = `list=${encodeURIComponent("A vs B, L, 2026-06-05")}`;
    const r = await handleRequest(
      "POST",
      "/analyze",
      body,
      "application/x-www-form-urlencoded",
      deps
    );
    expect(mockParseList).toHaveBeenCalled();
    expect(mockRunAnalysis).toHaveBeenCalledOnce();
    expect(r.body).toMatch(/REPORT/);
  });

  it("escapes HTML in error notices (XSS regression)", async () => {
    const payload = "x<script>alert(1)</script><img src=x onerror=alert(1)>"; // no "vs" → hits the parse-error notice that echoes the query
    const r = await handleRequest(
      "POST",
      "/analyze",
      `query=${encodeURIComponent(payload)}`,
      "application/x-www-form-urlencoded",
      deps
    );
    expect(r.status).toBe(400);
    expect(r.body).not.toContain("<script>");
    expect(r.body).not.toContain("<img");
    expect(r.body).toContain("&lt;script&gt;");
  });

  it("accepts JSON body", async () => {
    mockFetchByName.mockResolvedValue({ home: "A", away: "B", league: "L", kickoff: "k" });
    const r = await handleRequest(
      "POST",
      "/analyze",
      JSON.stringify({ query: "A vs B" }),
      "application/json",
      deps
    );
    expect(mockRunAnalysis).toHaveBeenCalledOnce();
    expect(r.status).toBe(200);
  });
});
