import { describe, expect, it } from "vitest";
import type { SportyBetEventDetail } from "../src/selectFixtures.js";
import {
  buildStatsOverride,
  buildStatsSoftContext,
  goalRateNudge,
  leaguePrior,
} from "../src/sportyBetStats.js";

function detail(stats: SportyBetEventDetail["stats"]): SportyBetEventDetail {
  return { eventId: "test", odds: null, stats, statscoverage: null };
}

describe("buildStatsOverride", () => {
  it("returns null when detail/stats is absent", () => {
    expect(buildStatsOverride(undefined)).toBeNull();
    expect(buildStatsOverride(detail(null))).toBeNull();
  });

  it("overrides xH/xA from xG when the sample is large enough (preferred over goals)", () => {
    const d = detail({
      standings: {
        home: { played: 10 },
        away: { played: 8 },
      },
      xg: {
        home: { xgf: 1.8, xga: 0.9 },
        away: { xgf: 1.1, xga: 1.4 },
      },
      goals: {
        home: { avg_scored: 1.2, avg_conceded: 1.1 },
        away: { avg_scored: 0.9, avg_conceded: 1.3 },
      },
    });
    const override = buildStatsOverride(d);
    expect(override).toMatchObject({
      xH: 1.8,
      xA: 1.1,
      xgMode: "empirical",
      xg_confidence: "high",
      oppGA_A: 1.3,
      oppGA_H: 1.1,
    });
  });

  it("falls back to goals averages when xG is absent, with medium confidence", () => {
    const d = detail({
      standings: { home: { played: 6 }, away: { played: 6 } },
      goals: {
        home: { avg_scored: 1.4, avg_conceded: 1.0 },
        away: { avg_scored: 0.8, avg_conceded: 1.6 },
      },
    });
    const override = buildStatsOverride(d);
    // No league passed → Default prior (homeAvg 1.5 / awayAvg 1.2).
    // n=6 < SHRINK_THRESHOLD(8) → w=0.75; xH=0.75*1.4+0.25*1.5=1.425, xA=0.75*0.8+0.25*1.2=0.9
    expect(override).toMatchObject({
      xH: expect.closeTo(1.425, 3),
      xA: expect.closeTo(0.9, 3),
      xg_confidence: "medium",
    });
  });

  it("does NOT override when either team's sample is below MIN_PLAYED (data-quality gate)", () => {
    const d = detail({
      standings: { home: { played: 2 }, away: { played: 10 } },
      goals: {
        home: { avg_scored: 1.4, avg_conceded: 1.0 },
        away: { avg_scored: 0.8, avg_conceded: 1.6 },
      },
    });
    expect(buildStatsOverride(d)).toBeNull();
  });

  it("does NOT override when standings is missing entirely (can't verify sample size)", () => {
    const d = detail({
      goals: {
        home: { avg_scored: 1.4, avg_conceded: 1.0 },
        away: { avg_scored: 0.8, avg_conceded: 1.6 },
      },
    });
    expect(buildStatsOverride(d)).toBeNull();
  });

  it("does NOT override xH/xA on a zero/sparse goals average, even with enough matches played", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      goals: {
        home: { avg_scored: 0, avg_conceded: 1.0 }, // zero — not real signal
        away: { avg_scored: 0.8, avg_conceded: 1.6 },
      },
    });
    const override = buildStatsOverride(d);
    // The headline xH/xA override is skipped, but oppGA (a softer, clamped SoS
    // adjustment derived from the separate avg_conceded field) still applies —
    // both teams' avg_conceded values are real, independent of home's avg_scored=0.
    expect(override?.xH).toBeUndefined();
    expect(override?.xA).toBeUndefined();
    expect(override).toMatchObject({ oppGA_H: 1.0, oppGA_A: 1.6 });
  });

  it("populates restH/restA from congestion regardless of the played gate (exact dates, not averages)", () => {
    const d = detail({
      congestion: {
        home: { rest_days: 3, next_days: 4 },
        away: { rest_days: 6 },
      },
    });
    const override = buildStatsOverride(d);
    // No goals/xG/standings at all → no xH/xA override, but rest still flows through.
    expect(override).toMatchObject({ restH: 3, restA: 6 });
  });

  it("supports a zero rest_days value (not treated as missing)", () => {
    const d = detail({ congestion: { home: { rest_days: 0 } } });
    expect(buildStatsOverride(d)).toMatchObject({ restH: 0 });
  });
});

describe("buildStatsSoftContext", () => {
  it("returns [] when there is no stats data", () => {
    expect(buildStatsSoftContext(undefined)).toEqual([]);
    expect(buildStatsSoftContext(detail(null))).toEqual([]);
  });

  it("renders a single 'stats' soft-context item summarising all available blocks", () => {
    const d = detail({
      form: {
        home: { name: "Arsenal", last5: "WWWDL", streak: 3 },
        away: { name: "Chelsea", last5: "LLDWW", streak: -2 },
      },
      standings: {
        home: { pos: 1, points: 50, played: 20, gf: 50, ga: 10 },
        away: { pos: 10, points: 28, played: 20, gf: 25, ga: 24 },
      },
      goals: {
        home: { avg_scored: 2.2, avg_conceded: 0.6 },
        away: { avg_scored: 1.1, avg_conceded: 1.3 },
      },
      h2h: { total: 5, home_wins: 4, away_wins: 0, draws: 1 },
      overunder: { home: { over25_pct: 0.7 }, away: { over25_pct: 0.4 } },
      congestion: { home: { rest_days: 5, next_days: 7 }, away: { rest_days: 2, next_days: 3 } },
    });
    const items = buildStatsSoftContext(d, "2026-06-20T00:00:00Z");
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("stats");
    expect(items[0]!.source).toBe("sportybet-sidecar");
    expect(items[0]!.observedAt).toBe("2026-06-20T00:00:00Z");
    const text = items[0]!.text;
    expect(text).toContain("Arsenal");
    expect(text).toContain("H2H (last 5 meetings)");
    expect(text).toContain("home wins 4");
    expect(text).toContain("70%"); // over25_pct rendered as a percentage
  });

  it("omits H2H from the text when total is 0 (empty history, not real signal)", () => {
    const d = detail({ h2h: { total: 0, home_wins: 0, away_wins: 0, draws: 0 } });
    const items = buildStatsSoftContext(d);
    expect(items).toEqual([]);
  });

  it("appends H2H match-by-match results to the H2H line", () => {
    const d = detail({
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
    });
    const text = buildStatsSoftContext(d)[0]!.text;
    expect(text).toContain("recent results 2-0, 1-1, 3-1");
  });

  it("renders possessionValue and recentCorners blocks when present", () => {
    const d = detail({
      possessionValue: {
        home: {
          shots_on_target_avg: 6,
          shots_off_target_avg: 3,
          shots_blocked_avg: 2,
          corners_avg: 5,
          possession_pct_avg: 53,
        },
        away: {
          shots_on_target_avg: 4,
          shots_off_target_avg: 2,
          shots_blocked_avg: 1,
          corners_avg: 3,
          possession_pct_avg: 47,
        },
      },
      recentCorners: { home: 5.4, away: 3.2 },
    });
    const items = buildStatsSoftContext(d);
    expect(items).toHaveLength(1);
    const text = items[0]!.text;
    expect(text).toContain("Season shot volume");
    expect(text).toContain("6 SoT");
    expect(text).toContain("53% poss");
    expect(text).toContain("Recent corners (last 5) — Home: 5.4 | Away: 3.2");
  });
});

describe("goalRateNudge", () => {
  it("returns 1.0 (no-op) when no over/under or BTTS signal is present", () => {
    expect(goalRateNudge(detail({}), "home")).toBe(1.0);
    expect(goalRateNudge(undefined, "home")).toBe(1.0);
  });

  it("treats a real 0% over25_pct as the strongest down-signal, not as missing", () => {
    // A team with a genuine 0% O2.5 rate is the most extreme low-scoring signal
    // possible — must clamp to the floor, not fall through to the 1.0 no-op.
    const d = detail({ overunder: { home: { over25_pct: 0 } } });
    expect(goalRateNudge(d, "home")).toBe(0.9);
  });

  it("nudges up for a high-scoring profile and down for a low one, clamped to [0.9,1.1]", () => {
    const high = detail({
      overunder: { home: { over25_pct: 0.9 } },
      scoringConceding: { home: { btts_rate: 0.9 } },
    });
    const low = detail({
      overunder: { home: { over25_pct: 0.1 } },
      scoringConceding: { home: { btts_rate: 0.1 } },
    });
    const up = goalRateNudge(high, "home");
    const down = goalRateNudge(low, "home");
    expect(up).toBeGreaterThan(1.0);
    expect(up).toBeLessThanOrEqual(1.1);
    expect(down).toBeLessThan(1.0);
    expect(down).toBeGreaterThanOrEqual(0.9);
  });

  it("never exceeds the [0.9,1.1] clamp even at extreme inputs", () => {
    const extreme = detail({
      overunder: { home: { over25_pct: 1 } },
      scoringConceding: { home: { btts_rate: 1 } },
    });
    expect(goalRateNudge(extreme, "home")).toBe(1.1);
  });
});

describe("leaguePrior", () => {
  it("uses the researched table for a known league", () => {
    expect(leaguePrior("Premier League")).toEqual({ homeAvg: 1.55, awayAvg: 1.18 });
  });

  it("derives a prior from the standings table for an uncovered league", () => {
    // Uncovered league name → fall through to standings-derived (gf/played, ga/played).
    const d = detail({
      standings: {
        home: { gf: 30, ga: 20, played: 14 }, // 2.14 scored, 1.43 conceded
        away: { gf: 14, ga: 24, played: 14 }, // 1.0 scored, 1.71 conceded
      },
    });
    const prior = leaguePrior("Faroe Islands Premier League", d);
    // homeAvg ≈ (2.14 + 1.71)/2 ≈ 1.93 ; awayAvg ≈ (1.0 + 1.43)/2 ≈ 1.21
    expect(prior.homeAvg).toBeCloseTo(1.93, 1);
    expect(prior.awayAvg).toBeCloseTo(1.21, 1);
  });

  it("falls back to Default when neither table nor standings can resolve", () => {
    expect(leaguePrior("Some Unknown League", detail({}))).toEqual({ homeAvg: 1.5, awayAvg: 1.2 });
  });
});
