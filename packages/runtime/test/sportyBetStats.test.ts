import { describe, expect, it } from "vitest";
import type { SportyBetEventDetail } from "../src/selectFixtures.js";
import { buildStatsOverride, buildStatsSoftContext } from "../src/sportyBetStats.js";

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
    expect(override).toMatchObject({ xH: 1.4, xA: 0.8, xg_confidence: "medium" });
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
});
