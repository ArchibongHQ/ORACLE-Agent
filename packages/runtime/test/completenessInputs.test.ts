import { describe, expect, it } from "vitest";
import {
  formatPopulationLog,
  inspectEvent,
  summarizeFieldPopulation,
  V3_TRACKED_FIELDS,
} from "../src/marketsV3/completenessInputs.js";
import type { SportyBetEvent, SportyBetEventDetail } from "../src/selectFixtures.js";

function event(detail?: Partial<SportyBetEventDetail>): SportyBetEvent {
  return {
    home: "A",
    away: "B",
    marketCount: 1,
    detail: detail
      ? { eventId: "e", odds: null, stats: null, statscoverage: null, ...detail }
      : undefined,
  };
}

const fullStats: SportyBetEventDetail["stats"] = {
  form: { home: { last5: "WWDLW" }, away: { last5: "LLDWW" } },
  goals: {
    home: { avg_scored: 1.5, avg_conceded: 1.0 },
    away: { avg_scored: 1.1, avg_conceded: 1.4 },
  },
  overunder: { home: { over25_pct: 0.6 }, away: { over25_pct: 0.5 } },
  xg: { home: { xgf: 1.6, xga: 1.0 }, away: { xgf: 1.2, xga: 1.3 } },
  h2h: { total: 4 },
  congestion: { home: { rest_days: 5 }, away: { rest_days: 7 } },
  scoringConceding: {
    home: {
      matches: 8,
      scored_avg: 1.5,
      goals_1h_avg: 0.6,
      btts_rate: 0.5,
      clean_sheet_rate: 0.3,
      failed_to_score_rate: 0.2,
    },
    away: {
      matches: 8,
      scored_avg: 1.1,
      goals_1h_avg: 0.5,
      btts_rate: 0.55,
      clean_sheet_rate: 0.2,
      failed_to_score_rate: 0.25,
    },
  },
  recentCorners: { home: 5.0, away: 4.2 },
  recentCornersAgainst: { home: 3.8, away: 5.5 },
  disciplinary: { home: { yellow_avg: 2.0 }, away: { yellow_avg: 1.5 } },
};

describe("inspectEvent", () => {
  it("marks every tracked field false on an empty event", () => {
    const present = inspectEvent(event());
    for (const field of V3_TRACKED_FIELDS) {
      expect(present[field], field).toBe(false);
    }
  });

  it("requires BOTH sides for two-team fields", () => {
    const present = inspectEvent(
      event({
        stats: {
          goals: { home: { avg_scored: 1.5, avg_conceded: 1.0 } }, // away missing
          recentCornersAgainst: { home: 3.8 }, // away missing
        },
      })
    );
    expect(present.scored).toBe(false);
    expect(present.cornersAgainst).toBe(false);
  });

  it("marks the full fixture's gate + market-specific fields present", () => {
    const present = inspectEvent(
      event({
        odds: { ou25: { over: 1.85, under: 1.95 } } as SportyBetEventDetail["odds"],
        stats: fullStats,
      })
    );
    const expectedTrue = V3_TRACKED_FIELDS.filter((f) => f !== "allMarketsFeed");
    for (const field of expectedTrue) {
      expect(present[field], field).toBe(true);
    }
    expect(present.allMarketsFeed).toBe(false); // no allMarkets list supplied
  });
});

describe("summarizeFieldPopulation", () => {
  it("computes per-field rates over a mixed slate", () => {
    const events = [
      event({ odds: { ou25: { over: 1.9, under: 1.9 } } as SportyBetEventDetail["odds"] }),
      event({ stats: { h2h: { total: 3 } } }),
      event(), // fully dark
      event({ stats: fullStats }),
    ];
    const pop = summarizeFieldPopulation(events);
    expect(pop.total).toBe(4);
    expect(pop.counts.odds).toBe(1);
    expect(pop.counts.h2h).toBe(2); // fullStats has h2h too
    expect(pop.rates.odds).toBe(0.25);
    expect(pop.rates.h2h).toBe(0.5);
  });

  it("returns zero rates for an empty slate without dividing by zero", () => {
    const pop = summarizeFieldPopulation([]);
    expect(pop.total).toBe(0);
    for (const field of V3_TRACKED_FIELDS) {
      expect(pop.rates[field]).toBe(0);
    }
  });
});

describe("formatPopulationLog", () => {
  it("flags mandatory gate inputs below the warn threshold with '!'", () => {
    const pop = summarizeFieldPopulation([event(), event({ stats: fullStats })]);
    const line = formatPopulationLog(pop);
    expect(line).toContain("fields(2 fixtures)");
    expect(line).toContain("odds=0%!"); // mandatory + dark → flagged
    expect(line).toContain("form=50%"); // 50% not below default 0.5 threshold
    expect(line).not.toContain("form=50%!");
    // Market-specific fields are never '!'-flagged, even when dark.
    expect(line).toContain("cards=50%");
  });
});
