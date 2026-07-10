import { describe, expect, it } from "vitest";
import { buildColumnFillReport } from "../src/columnFillReport.js";
import type { SportyBetEvent } from "../src/selectFixtures.js";

function event(
  home: string,
  away: string,
  overrides: Partial<SportyBetEvent["detail"]> = {}
): SportyBetEvent {
  return {
    home,
    away,
    marketCount: 10,
    league: "Premier League",
    kickoff_utc: "2026-06-25T15:00:00Z",
    detail: {
      eventId: `e_${home}_${away}`,
      odds: null,
      stats: null,
      statscoverage: null,
      ...overrides,
    },
  };
}

function fullyStocked(home: string, away: string): SportyBetEvent {
  return event(home, away, {
    odds: {
      "1x2": { home: 1.85, draw: 3.4, away: 4.5 },
      allMarkets: [{ id: "1", outcomes: [{ id: "1", desc: "Over", odds: "1.9" }] }],
    },
    stats: {
      form: { home: { last5: "WWDLW" }, away: { last5: "LDWWL" } },
      goals: { home: { avg_scored: 2.1 }, away: { avg_scored: 1.2 } },
      h2h: { total: 5, home_wins: 3, away_wins: 1, draws: 1 },
      xg: { home: { xgf: 2.0, xga: 1.1 }, away: { xgf: 1.5, xga: 1.4 } },
      overunder: { home: { over25_pct: 0.65 } },
      availability: { home: { idx: 1 } },
    },
  });
}

describe("buildColumnFillReport", () => {
  it("returns the slateDate unchanged and a column per checkable field", () => {
    const report = buildColumnFillReport("2026-07-10", []);
    expect(report.slateDate).toBe("2026-07-10");
    expect(report.columns.length).toBeGreaterThan(0);
    for (const col of report.columns) {
      expect(col.total).toBe(0);
      expect(col.filled).toBe(0);
    }
  });

  it("counts every column as filled for a fully-stocked fixture", () => {
    const report = buildColumnFillReport("2026-07-10", [fullyStocked("A", "B")]);
    for (const col of report.columns) {
      expect(col.filled).toBe(1);
      expect(col.total).toBe(1);
    }
  });

  it("counts every column as unfilled for a fixture with no detail data at all", () => {
    const report = buildColumnFillReport("2026-07-10", [event("C", "D")]);
    for (const col of report.columns) {
      expect(col.filled).toBe(0);
      expect(col.total).toBe(1);
    }
  });

  it("computes correct per-column filled/total across a mixed fixture pool", () => {
    const fixtures = [fullyStocked("A", "B"), event("C", "D"), fullyStocked("E", "F")];
    const report = buildColumnFillReport("2026-07-10", fixtures);
    for (const col of report.columns) {
      expect(col.total).toBe(3);
      expect(col.filled).toBe(2);
    }
  });

  it("scores xG home/away independently when only one side has coverage", () => {
    const partialXg = event("G", "H", {
      stats: { xg: { home: { xgf: 1.8 } } }, // away xG absent
    });
    const report = buildColumnFillReport("2026-07-10", [partialXg]);
    const xgHome = report.columns.find((c) => c.column === "stats.xg.home");
    const xgAway = report.columns.find((c) => c.column === "stats.xg.away");
    expect(xgHome?.filled).toBe(1);
    expect(xgAway?.filled).toBe(0);
  });

  it("counts odds.allMarkets as unfilled when the array is present but empty", () => {
    const emptyMarkets = event("I", "J", { odds: { allMarkets: [] } });
    const report = buildColumnFillReport("2026-07-10", [emptyMarkets]);
    const allMarkets = report.columns.find((c) => c.column === "odds.allMarkets");
    expect(allMarkets?.filled).toBe(0);
  });

  it("never throws for fixtures with no detail object at all", () => {
    const bare: SportyBetEvent = { home: "K", away: "L", marketCount: 0 };
    expect(() => buildColumnFillReport("2026-07-10", [bare])).not.toThrow();
    const report = buildColumnFillReport("2026-07-10", [bare]);
    for (const col of report.columns) expect(col.filled).toBe(0);
  });
});
