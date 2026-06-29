import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import type { LineupSummary } from "../src/lineups.js";
import type { SportyBetEvent } from "../src/selectFixtures.js";

// dailyStore is only needed by the generate-and-write path (not renderFixtureWorkbook);
// stub teamSlug so the in-memory render path stays pure.
vi.mock("../src/dailyStore.js", () => ({
  loadDailyNews: vi.fn(async () => []),
  teamSlug: (s: string) => s.toLowerCase().replace(/\s+/g, "_"),
}));

const { renderFixtureWorkbook } = await import("../src/fixtureWorkbook.js");

function event(home: string, away: string, withStats = true): SportyBetEvent {
  return {
    home,
    away,
    marketCount: 12,
    league: "Premier League",
    kickoff_utc: "2026-06-29T15:00:00Z",
    detail: withStats
      ? {
          eventId: `e_${home}_${away}`,
          odds: {
            "1x2": { home: 1.85, draw: 3.4, away: 4.5 },
            ou25: { over: 1.9, under: 1.95 },
            btts: { yes: 1.8, no: 1.9 },
            allMarkets: [
              {
                id: "1",
                name: "1X2",
                desc: "Match Result",
                group: "Main",
                specifier: null,
                outcomes: [
                  { id: "1", desc: "Home", odds: "1.85" },
                  { id: "2", desc: "Draw", odds: "3.40" },
                  { id: "3", desc: "Away", odds: "4.50" },
                ],
              },
              {
                id: "18",
                name: "Over/Under",
                desc: "Total",
                group: "Goals",
                specifier: "total=2.5",
                outcomes: [
                  { id: "12", desc: "Over 2.5", odds: "1.90" },
                  { id: "13", desc: "Under 2.5", odds: "1.95" },
                ],
              },
            ],
          },
          stats: {
            form: { home: { last5: "WWDLW", streak: 1 }, away: { last5: "LDWWL", streak: -1 } },
            standings: { home: { pos: 3, points: 40, gf: 30, ga: 12 }, away: { pos: 10 } },
            goals: { home: { avg_scored: 2.1, avg_conceded: 1.0 }, away: { avg_scored: 1.2 } },
            h2h: {
              total: 3,
              home_wins: 2,
              away_wins: 0,
              draws: 1,
              matches: [
                { home_goals: 2, away_goals: 0, winner: "home" },
                { home_goals: 1, away_goals: 1, winner: "draw" },
                { home_goals: 3, away_goals: 1, winner: "home" },
              ],
            },
            scoringConceding: {
              home: { btts_rate: 0.86, scoring_1h_rate: 1.0, goals_1h_avg: 0.6 },
            },
          },
          statscoverage: null,
        }
      : { eventId: `e_${home}_${away}`, odds: null, stats: null, statscoverage: null },
  };
}

const lineup: LineupSummary = {
  home: "Alpha",
  away: "Beta",
  home_formation: "4-3-3",
  away_formation: "4-4-2",
  home_xi_confirmed: true,
  away_xi_confirmed: false,
  home_starting_xi: ["Player A"],
  away_starting_xi: ["Player B"],
};

const deps = { lineups: [lineup], newsByTeam: new Map() };

describe("renderFixtureWorkbook", () => {
  it("produces a Fixtures sheet with one row per fixture and an H2H results column", () => {
    const wb = renderFixtureWorkbook(
      [event("Alpha", "Beta"), event("Gamma", "Delta", false)],
      "2026-06-29",
      deps
    );
    const fx = wb.getWorksheet("Fixtures");
    expect(fx).toBeDefined();
    // header row + 2 fixtures
    expect(fx?.rowCount).toBe(3);
    const headers = (fx?.getRow(1).values as unknown[]).filter(Boolean).map(String);
    expect(headers).toContain("Home");
    expect(headers).toContain("H2H results");
    expect(headers).toContain("BTTS%_H");
    // the joined H2H results string lands in the H2H results column for the first fixture
    const h2hCol = headers.indexOf("H2H results") + 1; // ExcelJS values[] is 1-based
    expect(String(fx?.getRow(2).getCell(h2hCol).value)).toBe("2-0; 1-1; 3-1");
  });

  it("produces a Markets sheet with one row per outcome", () => {
    const wb = renderFixtureWorkbook([event("Alpha", "Beta")], "2026-06-29", deps);
    const mk = wb.getWorksheet("Markets");
    expect(mk).toBeDefined();
    // header + 5 outcomes (3 for 1X2, 2 for O/U)
    expect(mk?.rowCount).toBe(6);
  });

  it("round-trips through xlsx serialization", async () => {
    const wb = renderFixtureWorkbook([event("Alpha", "Beta")], "2026-06-29", deps);
    const buf = await wb.xlsx.writeBuffer();
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(buf as ArrayBuffer);
    expect(wb2.getWorksheet("Fixtures")?.rowCount).toBe(2);
    expect(wb2.getWorksheet("Markets")?.rowCount).toBe(6);
  });
});
