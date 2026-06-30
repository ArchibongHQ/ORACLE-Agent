import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRE_FILTER_POOL_SIZE,
  preFilterGoalsCandidates,
  scoreGoalsPotential,
} from "../src/goalsPreFilter.js";
import type { SportyBetEvent } from "../src/selectFixtures.js";

function event(
  home: string,
  away: string,
  league: string | undefined,
  detail?: SportyBetEvent["detail"]
): SportyBetEvent {
  return { home, away, marketCount: 10, league, detail };
}

const richStats: SportyBetEvent["detail"] = {
  eventId: "e1",
  odds: null,
  statscoverage: null,
  stats: {
    overunder: { home: { over25_pct: 0.7 }, away: { over25_pct: 0.65 } },
    possessionValue: {
      home: { shots_on_target_avg: 6, corners_avg: 5 },
      away: { shots_on_target_avg: 5, corners_avg: 4 },
    },
    goals: { home: { avg_scored: 2.2 }, away: { avg_scored: 1.8 } },
    form: { home: { last5: "WWWDW" }, away: { last5: "WDWWL" } },
    standings: { home: { pos: 1 }, away: { pos: 3 } },
  },
};

describe("scoreGoalsPotential", () => {
  it("ranks Tier A (goals-rich league) above Tier B (priority league) above Tier C, all else equal", () => {
    const a = scoreGoalsPotential(event("H", "A", "Bundesliga"));
    const b = scoreGoalsPotential(event("H", "A", "Premier League"));
    const c = scoreGoalsPotential(event("H", "A", "Some Regional League"));
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it("never returns a zero/excluding score for a fixture with no data at all", () => {
    const score = scoreGoalsPotential(event("H", "A", undefined));
    expect(score).toBeGreaterThan(0);
    expect(Number.isNaN(score)).toBe(false);
  });

  it("rich data (O/U hit-rate, shots, corners, goals avg) scores higher than no data, same league", () => {
    const rich = scoreGoalsPotential(event("H", "A", "Championship", richStats));
    const thin = scoreGoalsPotential(event("H", "A", "Championship"));
    expect(rich).toBeGreaterThan(thin);
  });

  it("caps at 100", () => {
    const score = scoreGoalsPotential(event("H", "A", "Bundesliga", richStats));
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe("preFilterGoalsCandidates", () => {
  it("never excludes a low/no-data fixture purely on data-absence — it sorts lower, not out", () => {
    const dataRich = event("Rich", "Team", "Premier League", richStats);
    const dataPoor = event("Poor", "Team", "Some Regional League");
    const result = preFilterGoalsCandidates([dataRich, dataPoor], 2);
    expect(result).toHaveLength(2);
    expect(result.some((r) => r.event.home === "Poor")).toBe(true);
  });

  it("sorts descending by score", () => {
    const events = [
      event("Low", "Team", "Some Regional League"),
      event("High", "Team", "Bundesliga", richStats),
      event("Mid", "Team", "Premier League"),
    ];
    const result = preFilterGoalsCandidates(events, 10);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.score).toBeGreaterThanOrEqual(result[i]!.score);
    }
  });

  it("caps the pool at poolSize even when more fixtures are available", () => {
    // Must generate strictly MORE fixtures than the pool size for the cap to be
    // exercised (DEFAULT_PRE_FILTER_POOL_SIZE was raised 130→1000 in PR #19).
    const events = Array.from({ length: DEFAULT_PRE_FILTER_POOL_SIZE + 200 }, (_, i) =>
      event(`Home${i}`, `Away${i}`, "Premier League")
    );
    const result = preFilterGoalsCandidates(events, DEFAULT_PRE_FILTER_POOL_SIZE);
    expect(result).toHaveLength(DEFAULT_PRE_FILTER_POOL_SIZE);
  });

  it("returns every fixture when the pool is smaller than poolSize", () => {
    const events = [event("A", "B", "Bundesliga"), event("C", "D", "Premier League")];
    const result = preFilterGoalsCandidates(events, DEFAULT_PRE_FILTER_POOL_SIZE);
    expect(result).toHaveLength(2);
  });
});
