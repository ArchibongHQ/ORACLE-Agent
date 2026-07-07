import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LineupSummary } from "../src/lineups.js";
import type { SportyBetEvent } from "../src/selectFixtures.js";

// dailyStore is only needed by the generate-and-write path (not the pure renders);
// stub teamSlug so the in-memory render path stays pure.
vi.mock("../src/dailyStore.js", () => ({
  loadDailyNews: vi.fn(async () => []),
  teamSlug: (s: string) => s.toLowerCase().replace(/\s+/g, "_"),
}));

const {
  buildMarketRowGroups,
  computeXgCoverage,
  listFixtureReportFiles,
  renderFixturesWorkbook,
  renderMarketsWorkbook,
  writeFixtureReportFiles,
} = await import("../src/fixtureWorkbook.js");

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

/** A fixture whose markets carry ~6KB of incompressible (sha256-hex) outcome
 *  text, so DEFLATE-9 can't collapse it and small byte budgets force real
 *  multi-part splits. 30 markets × 3 outcomes = 90 rows per fixture. */
const BIG_EVENT_ROWS = 90;
function bigEvent(home: string, away: string): SportyBetEvent {
  const e = event(home, away);
  const odds = e.detail?.odds;
  if (odds) {
    odds.allMarkets = Array.from({ length: 30 }, (_, m) => ({
      id: String(m),
      name: `Market ${m}`,
      desc: `Market ${m}`,
      group: "Main",
      specifier: null,
      outcomes: Array.from({ length: 3 }, (_, o) => ({
        id: String(o),
        desc: createHash("sha256").update(`${home}|${m}|${o}`).digest("hex"),
        odds: "1.85",
      })),
    }));
  }
  return e;
}

describe("renderFixturesWorkbook", () => {
  it("produces a Fixtures sheet with one row per fixture and an H2H results column", () => {
    const wb = renderFixturesWorkbook(
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
});

describe("computeXgCoverage", () => {
  function eventWithXg(
    home: string,
    away: string,
    xg: { home?: { xgf?: number; src?: string }; away?: { xgf?: number; src?: string } }
  ): SportyBetEvent {
    const e = event(home, away);
    if (e.detail?.stats) (e.detail.stats as Record<string, unknown>).xg = xg;
    return e;
  }

  it("counts a fixture covered only when BOTH sides have a numeric xgf, tallied by src", () => {
    const events = [
      eventWithXg("A", "B", {
        home: { xgf: 1.5, src: "understat" },
        away: { xgf: 1.1, src: "understat" },
      }),
      eventWithXg("C", "D", {
        home: { xgf: 1.2, src: "google_ai" },
        away: { xgf: 0.9, src: "google_ai" },
      }),
      eventWithXg("E", "F", { home: { xgf: 1.0 } }), // away side missing xgf — not covered
    ];
    expect(computeXgCoverage(events)).toEqual({
      covered: 2,
      total: 3,
      bySrc: { understat: 1, google_ai: 1 },
    });
  });

  it("tags a covered fixture 'unknown' when neither side carries a src, and 'mixed' when the two sides disagree", () => {
    const events = [
      eventWithXg("A", "B", { home: { xgf: 1.5 }, away: { xgf: 1.1 } }),
      eventWithXg("C", "D", {
        home: { xgf: 1.2, src: "understat" },
        away: { xgf: 0.9, src: "google_ai" },
      }),
    ];
    expect(computeXgCoverage(events)).toEqual({
      covered: 2,
      total: 2,
      bySrc: { unknown: 1, mixed: 1 },
    });
  });

  it("returns covered=0 and an empty bySrc map when no fixture has an xg block", () => {
    expect(computeXgCoverage([event("Alpha", "Beta", false)])).toEqual({
      covered: 0,
      total: 1,
      bySrc: {},
    });
  });
});

describe("ShotsOff/Blocked columns (PR-19)", () => {
  it("renders shots_off_target_avg and shots_blocked_avg alongside the existing SoT columns", () => {
    const e = event("Alpha", "Beta");
    if (e.detail?.stats) {
      (e.detail.stats as Record<string, unknown>).possessionValue = {
        home: { shots_on_target_avg: 5.2, shots_off_target_avg: 3.1, shots_blocked_avg: 1.4 },
        away: { shots_on_target_avg: 4.0, shots_off_target_avg: 2.2, shots_blocked_avg: 0.8 },
      };
    }
    const wb = renderFixturesWorkbook([e], "2026-06-29", deps);
    const fx = wb.getWorksheet("Fixtures");
    const headers = (fx?.getRow(1).values as unknown[]).filter(Boolean).map(String);
    for (const h of ["ShotsOff_H", "ShotsOff_A", "Blocked_H", "Blocked_A"]) {
      expect(headers).toContain(h);
    }
    const col = (name: string) => headers.indexOf(name) + 1;
    expect(fx?.getRow(2).getCell(col("ShotsOff_H")).value).toBe(3.1);
    expect(fx?.getRow(2).getCell(col("ShotsOff_A")).value).toBe(2.2);
    expect(fx?.getRow(2).getCell(col("Blocked_H")).value).toBe(1.4);
    expect(fx?.getRow(2).getCell(col("Blocked_A")).value).toBe(0.8);
  });

  it("renders null for the new columns when possessionValue is absent", () => {
    const wb = renderFixturesWorkbook([event("Gamma", "Delta", false)], "2026-06-29", deps);
    const fx = wb.getWorksheet("Fixtures");
    const headers = (fx?.getRow(1).values as unknown[]).filter(Boolean).map(String);
    const col = (name: string) => headers.indexOf(name) + 1;
    expect(fx?.getRow(2).getCell(col("ShotsOff_H")).value).toBeNull();
    expect(fx?.getRow(2).getCell(col("Blocked_A")).value).toBeNull();
  });
});

describe("buildMarketRowGroups", () => {
  it("groups per fixture with one row per outcome, skipping marketless fixtures", () => {
    const groups = buildMarketRowGroups([event("Alpha", "Beta"), event("Gamma", "Delta", false)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.home).toBe("Alpha");
    // 3 outcomes for 1X2 + 2 for O/U
    expect(groups[0]?.rows).toHaveLength(5);
    const first = groups[0]?.rows[0] ?? [];
    expect(first.slice(0, 4)).toEqual(["Alpha", "Beta", "1", "Match Result"]);
    // family (idx 4) comes from the engine market catalogue — only assert shape
    expect(typeof first[4]).toBe("string");
    expect(first.slice(5)).toEqual(["Main", "", "Home", "1.85"]);
  });
});

describe("renderMarketsWorkbook", () => {
  it("produces a Markets sheet with one row per outcome and round-trips through xlsx", async () => {
    const wb = renderMarketsWorkbook(buildMarketRowGroups([event("Alpha", "Beta")]), "2026-06-29");
    const mk = wb.getWorksheet("Markets");
    expect(mk).toBeDefined();
    // header + 5 outcomes (3 for 1X2, 2 for O/U)
    expect(mk?.rowCount).toBe(6);
    const buf = await wb.xlsx.writeBuffer();
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(buf as ArrayBuffer);
    expect(wb2.getWorksheet("Markets")?.rowCount).toBe(6);
  });
});

describe("writeFixtureReportFiles", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("writes one fixtures + one markets file when everything fits the budget", async () => {
    dir = await mkdtemp(join(tmpdir(), "oracle-wb-"));
    const files = await writeFixtureReportFiles([event("Alpha", "Beta")], "2026-06-29", deps, dir);
    expect(basename(files.fixturesPath)).toBe("oracle-fixtures-2026-06-29.xlsx");
    expect(files.marketsPaths.map((p) => basename(p))).toEqual(["oracle-markets-2026-06-29.xlsx"]);
  });

  it("writes no markets file when no fixture has markets", async () => {
    dir = await mkdtemp(join(tmpdir(), "oracle-wb-"));
    const files = await writeFixtureReportFiles(
      [event("Gamma", "Delta", false)],
      "2026-06-29",
      deps,
      dir
    );
    expect(files.marketsPaths).toEqual([]);
  });

  it("ships a single oversized part when one fixture alone blows the budget", async () => {
    dir = await mkdtemp(join(tmpdir(), "oracle-wb-"));
    // A lone fixture's markets can't be split below the fixture boundary; a
    // budget far under its ~7KB size must still ship exactly one part1of1
    // file rather than looping forever or fabricating extra parts.
    const files = await writeFixtureReportFiles(
      [bigEvent("Solo", "Opp")],
      "2026-06-29",
      deps,
      dir,
      512
    );
    expect(files.marketsPaths).toHaveLength(1);
    expect(basename(files.marketsPaths[0] as string)).toBe(
      "oracle-markets-2026-06-29-part1of1.xlsx"
    );
    expect(statSync(files.marketsPaths[0] as string).size).toBeGreaterThan(512);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(files.marketsPaths[0] as string);
    expect(wb.getWorksheet("Markets")?.rowCount).toBe(BIG_EVENT_ROWS + 1);
  });

  it("splits markets into fixture-aligned parts under the budget when over it", async () => {
    dir = await mkdtemp(join(tmpdir(), "oracle-wb-"));
    const events = Array.from({ length: 8 }, (_, i) => bigEvent(`Home${i}`, `Away${i}`));
    // ~6KB of incompressible text per fixture: the combined markets file blows a
    // 20KB budget, while a one-fixture part always fits.
    const budget = 20 * 1024;
    const files = await writeFixtureReportFiles(events, "2026-06-29", deps, dir, budget);
    expect(files.marketsPaths.length).toBeGreaterThan(1);
    const n = files.marketsPaths.length;
    files.marketsPaths.forEach((p, i) => {
      expect(basename(p)).toBe(`oracle-markets-2026-06-29-part${i + 1}of${n}.xlsx`);
    });
    // Parts respect fixture boundaries, cover all rows, and each stays under
    // budget with header + data intact.
    const seenRows: string[] = [];
    for (const p of files.marketsPaths) {
      expect(statSync(p).size).toBeLessThanOrEqual(budget);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(p);
      const mk = wb.getWorksheet("Markets");
      expect(mk).toBeDefined();
      expect(String(mk?.getRow(1).getCell(1).value)).toBe("Home");
      const homes = new Set<string>();
      mk?.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        homes.add(String(row.getCell(1).value));
        seenRows.push(`${row.getCell(1).value}|${row.getCell(8).value}`);
      });
      // every fixture's rows land in exactly one part
      const dataRows = (mk?.rowCount ?? 1) - 1;
      expect(dataRows % BIG_EVENT_ROWS).toBe(0);
      expect(homes.size).toBe(dataRows / BIG_EVENT_ROWS);
    }
    expect(seenRows).toHaveLength(events.length * BIG_EVENT_ROWS);
    expect(new Set(seenRows.map((r) => r.split("|")[0])).size).toBe(events.length);
  });

  it("suffixes the whole file set on filename collision", async () => {
    dir = await mkdtemp(join(tmpdir(), "oracle-wb-"));
    const first = await writeFixtureReportFiles([event("Alpha", "Beta")], "2026-06-29", deps, dir);
    const second = await writeFixtureReportFiles([event("Alpha", "Beta")], "2026-06-29", deps, dir);
    expect(basename(second.fixturesPath)).toMatch(/^oracle-fixtures-2026-06-29-\d+\.xlsx$/);
    const suffix = basename(second.fixturesPath).slice(
      "oracle-fixtures-2026-06-29".length,
      -".xlsx".length
    );
    expect(basename(second.marketsPaths[0] as string)).toBe(
      `oracle-markets-2026-06-29${suffix}.xlsx`
    );
    expect(first.fixturesPath).not.toBe(second.fixturesPath);
  });

  it("listFixtureReportFiles finds the primary set and orders parts", async () => {
    dir = await mkdtemp(join(tmpdir(), "oracle-wb-"));
    const events = Array.from({ length: 8 }, (_, i) => bigEvent(`Home${i}`, `Away${i}`));
    const written = await writeFixtureReportFiles(events, "2026-06-29", deps, dir, 20 * 1024);
    const listed = await listFixtureReportFiles("2026-06-29", dir);
    expect(listed?.fixturesPath).toBe(written.fixturesPath);
    expect(listed?.marketsPaths).toEqual(written.marketsPaths);
    expect(await listFixtureReportFiles("2020-01-01", dir)).toBeNull();
    // sanity: no stray files beyond the written set
    const names = await readdir(dir);
    expect(names.sort()).toEqual(
      [written.fixturesPath, ...written.marketsPaths].map((p) => basename(p)).sort()
    );
  });
});
