import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineupSummary } from "../src/lineups.js";
import type { SportyBetEvent } from "../src/selectFixtures.js";

vi.mock("../src/dailyStore.js", () => ({
  loadDailyNews: vi.fn(),
  teamSlug: (s: string) => s.toLowerCase().replace(/\s+/g, "_"),
}));

vi.mock("../src/travel.js", () => ({
  buildTravel: vi.fn(() => ({ telemetry: {} })),
}));

const { loadDailyNews } = await import("../src/dailyStore.js");
const { buildTravel } = await import("../src/travel.js");
const { buildNewsByTeam, renderDailyFixtureReport, writeDailyFixtureReport } = await import(
  "../src/dailyFixtureReport.js"
);

afterEach(() => vi.clearAllMocks());

function event(home: string, away: string, withStats = true): SportyBetEvent {
  return {
    home,
    away,
    marketCount: 10,
    league: "Premier League",
    kickoff_utc: "2026-06-25T15:00:00Z",
    detail: withStats
      ? {
          eventId: `e_${home}_${away}`,
          odds: {
            "1x2": { home: 1.85, draw: 3.4, away: 4.5 },
            ou25: { over: 1.9, under: 1.95 },
            btts: { yes: 1.8, no: 1.9 },
          },
          stats: {
            form: { home: { last5: "WWDLW", streak: 1 }, away: { last5: "LDWWL", streak: -1 } },
            standings: { home: { pos: 3, points: 40, gf: 30, ga: 12 }, away: { pos: 10 } },
            goals: { home: { avg_scored: 2.1, avg_conceded: 1.0 }, away: { avg_scored: 1.2 } },
            h2h: { total: 5, home_wins: 3, away_wins: 1, draws: 1 },
            xg: { home: { xgf: 2.0, xga: 1.1 } },
            overunder: { home: { over25_pct: 0.65 } },
            congestion: { home: { rest_days: 4, next_days: 3 } },
            possessionValue: { home: { shots_on_target_avg: 6, corners_avg: 5 } },
          },
          statscoverage: null,
        }
      : { eventId: `e_${home}_${away}`, odds: null, stats: null, statscoverage: null },
  };
}

function lineup(home: string, away: string): LineupSummary {
  return {
    home,
    away,
    home_formation: "4-3-3",
    away_formation: "4-4-2",
    home_xi_confirmed: true,
    away_xi_confirmed: false,
    home_starting_xi: ["Player A"],
    away_starting_xi: ["Player B"],
  };
}

describe("renderDailyFixtureReport", () => {
  it("renders every fixture, even those with no stats at all", () => {
    const events = [event("A", "B"), event("C", "D", false)];
    const html = renderDailyFixtureReport(events, "2026-06-25", {
      lineups: [],
      newsByTeam: new Map(),
    });
    expect(html).toContain("A vs B");
    expect(html).toContain("C vs D");
    expect(html).toContain("ORACLE Daily Fixtures");
  });

  it("includes odds, form, standings, H2H, xG, O/U, congestion, possession sections", () => {
    const html = renderDailyFixtureReport([event("A", "B")], "2026-06-25", {
      lineups: [],
      newsByTeam: new Map(),
    });
    expect(html).toContain("1X2: H 1.85");
    expect(html).toContain("WWDLW");
    expect(html).toContain("pos 3");
    expect(html).toContain("home wins 3");
    expect(html).toContain("xGF 2");
    expect(html).toContain("Rest/congestion");
    expect(html).toContain("Shots/corners/poss.");
  });

  it("renders 'N/A — outside xG coverage' when xG is absent", () => {
    const html = renderDailyFixtureReport([event("C", "D", false)], "2026-06-25", {
      lineups: [],
      newsByTeam: new Map(),
    });
    expect(html).toContain("N/A — outside xG coverage");
  });

  it("renders lineup data when a matching summary exists", () => {
    const html = renderDailyFixtureReport([event("A", "B")], "2026-06-25", {
      lineups: [lineup("A", "B")],
      newsByTeam: new Map(),
    });
    expect(html).toContain("Confirmed");
    expect(html).toContain("Player A");
  });

  it("renders 'Not yet confirmed' for lineups when no summary matches", () => {
    const html = renderDailyFixtureReport([event("A", "B")], "2026-06-25", {
      lineups: [],
      newsByTeam: new Map(),
    });
    expect(html).toContain("Not yet confirmed");
  });

  it("renders 'No news intel' when no news rows exist for a team", () => {
    const html = renderDailyFixtureReport([event("A", "B")], "2026-06-25", {
      lineups: [],
      newsByTeam: new Map(),
    });
    expect(html).toContain("No news intel");
  });

  it("renders news rows when present, keyed by team slug", () => {
    const newsByTeam = new Map([["a", [{ source: "perplexity", summary: "Key striker injured" }]]]);
    const html = renderDailyFixtureReport([event("A", "B")], "2026-06-25", {
      lineups: [],
      newsByTeam,
    });
    expect(html).toContain("Key striker injured");
    expect(html).toContain("perplexity");
  });

  it("escapes HTML in team names", () => {
    const html = renderDailyFixtureReport([event("<script>", "B")], "2026-06-25", {
      lineups: [],
      newsByTeam: new Map(),
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders a Travel row when buildTravel reports km/altitude", () => {
    vi.mocked(buildTravel).mockReturnValueOnce({
      telemetry: { travelKm: 540, altitudeM: 1200 },
      soft: {
        kind: "news",
        text: "Travel/venue — away travel ≈ 540 km, venue altitude ≈ 1200 m.",
        source: "travel-table",
        observedAt: "",
      },
    });
    const html = renderDailyFixtureReport([event("A", "B")], "2026-06-25", {
      lineups: [],
      newsByTeam: new Map(),
    });
    expect(html).toContain("away travel ≈ 540 km");
    expect(html).toContain("venue altitude ≈ 1200 m");
  });

  it("omits the Travel row when buildTravel has nothing to report", () => {
    vi.mocked(buildTravel).mockReturnValue({ telemetry: {} });
    const html = renderDailyFixtureReport([event("A", "B")], "2026-06-25", {
      lineups: [],
      newsByTeam: new Map(),
    });
    expect(html).not.toContain("away travel");
  });

  it("renders a Motivation row for a low-stakes mid-table fixture", () => {
    const e = event("A", "B");
    e.detail!.stats!.standings = {
      home: { pos: 8, points: 35, gf: 20, ga: 18, played: 25 },
      away: { pos: 10, points: 32, gf: 18, ga: 19, played: 24 },
    };
    const html = renderDailyFixtureReport([e], "2026-06-25", {
      lineups: [],
      newsByTeam: new Map(),
    });
    expect(html).toContain("Motivation");
    expect(html).toContain("low-stakes");
  });

  it("omits the Motivation row for a normal title/relegation-relevant fixture", () => {
    const html = renderDailyFixtureReport([event("A", "B")], "2026-06-25", {
      lineups: [],
      newsByTeam: new Map(),
    });
    expect(html).not.toContain("low-stakes");
  });

  it("renders 100% data completeness for a fully-stocked fixture", () => {
    const html = renderDailyFixtureReport([event("A", "B")], "2026-06-25", {
      lineups: [],
      newsByTeam: new Map(),
    });
    expect(html).toContain("Data completeness");
    expect(html).toContain("100.0%");
  });

  it("renders the floored 50% data completeness for a fixture with no stats", () => {
    const html = renderDailyFixtureReport([event("C", "D", false)], "2026-06-25", {
      lineups: [],
      newsByTeam: new Map(),
    });
    expect(html).toContain("50.0%");
  });
});

describe("buildNewsByTeam", () => {
  it("fetches news for every team across all fixtures, keyed by slug", async () => {
    vi.mocked(loadDailyNews).mockImplementation(async (_dt, slug) =>
      slug === "a"
        ? [{ source: "perplexity", summary: "news for A", rawJson: "{}", scrapedAt: "" }]
        : []
    );
    const result = await buildNewsByTeam([event("A", "B")], "2026-06-25");
    expect(result.get("a")).toEqual([{ source: "perplexity", summary: "news for A" }]);
    expect(result.has("b")).toBe(false); // no rows returned for B — not added
  });

  it("returns an empty map when no team has news", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]);
    const result = await buildNewsByTeam([event("A", "B")], "2026-06-25");
    expect(result.size).toBe(0);
  });
});

describe("writeDailyFixtureReport", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oracle-fixture-report-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes to oracle-fixtures-{date}.html and returns the path", async () => {
    const path = await writeDailyFixtureReport("<html></html>", "2026-06-25", dir);
    expect(path).toBe(join(dir, "oracle-fixtures-2026-06-25.html"));
    expect(await readFile(path, "utf8")).toBe("<html></html>");
  });

  it("writes a collision-suffixed path when the primary already exists", async () => {
    const first = await writeDailyFixtureReport("<html>first</html>", "2026-06-25", dir);
    const second = await writeDailyFixtureReport("<html>second</html>", "2026-06-25", dir);
    expect(second).not.toBe(first);
    expect(await readFile(first, "utf8")).toBe("<html>first</html>");
    expect(await readFile(second, "utf8")).toBe("<html>second</html>");
  });
});
