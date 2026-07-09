import { describe, expect, it } from "vitest";
import type { SportyBetEventDetail } from "../src/selectFixtures.js";
import {
  blendRecencyScored,
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

  it("does NOT set the legacy xH/xA override when either team's sample is below MIN_PLAYED (data-quality gate) — but the ungated v3 raw fields (§3.1) still populate", () => {
    const d = detail({
      standings: { home: { played: 2 }, away: { played: 10 } },
      goals: {
        home: { avg_scored: 1.4, avg_conceded: 1.0 },
        away: { avg_scored: 0.8, avg_conceded: 1.6 },
      },
    });
    const override = buildStatsOverride(d);
    expect(override?.xH).toBeUndefined();
    expect(override?.xg_confidence).toBeUndefined();
    expect(override).toMatchObject({
      scoredPer90H: 1.4,
      concededPer90H: 1.0,
      scoredPer90A: 0.8,
      concededPer90A: 1.6,
      nHome: 2,
      nAway: 10,
    });
  });

  it("does NOT set the legacy xH/xA override when standings is missing entirely — v3 raw goals fields still populate (no nHome/nAway without a played count)", () => {
    const d = detail({
      goals: {
        home: { avg_scored: 1.4, avg_conceded: 1.0 },
        away: { avg_scored: 0.8, avg_conceded: 1.6 },
      },
    });
    const override = buildStatsOverride(d);
    expect(override?.xH).toBeUndefined();
    expect(override?.nHome).toBeUndefined();
    expect(override?.nAway).toBeUndefined();
    expect(override).toMatchObject({
      scoredPer90H: 1.4,
      concededPer90H: 1.0,
      scoredPer90A: 0.8,
      concededPer90A: 1.6,
    });
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

describe("buildStatsOverride — all-markets v3 additions", () => {
  it("prefers the venue-conditioned xG split when venueN meets the sample gate", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      xg: {
        home: { xgf: 1.8, xga: 0.9, venueXgf: 2.2, venueXga: 0.7, venueN: 5 },
        away: { xgf: 1.1, xga: 1.4, venueXgf: 0.8, venueXga: 1.6, venueN: 6 },
      },
    });
    expect(buildStatsOverride(d)).toMatchObject({
      xH: 2.2,
      xA: 0.8,
      xgMode: "empirical",
      xg_confidence: "high",
    });
  });

  it("ignores the venue split below the sample gate (falls back to season aggregate)", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      xg: {
        home: { xgf: 1.8, xga: 0.9, venueXgf: 2.2, venueXga: 0.7, venueN: 2 },
        away: { xgf: 1.1, xga: 1.4 },
      },
    });
    expect(buildStatsOverride(d)).toMatchObject({ xH: 1.8, xA: 1.1 });
  });

  it("downgrades league-mean-estimated xGA to estimated/medium instead of empirical/high", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      xg: {
        home: { xgf: 1.5, xga: 1.2, xgaSrc: "estimated" },
        away: { xgf: 1.0, xga: 1.1 },
      },
    });
    expect(buildStatsOverride(d)).toMatchObject({
      xH: 1.5,
      xA: 1.0,
      xgMode: "estimated",
      xg_confidence: "medium",
    });
  });

  it("downgrades a google_ai-sourced xG pair to estimated/medium (PR-19 fallback tier parity)", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      xg: {
        home: { xgf: 1.5, xga: 1.2, src: "google_ai" },
        away: { xgf: 1.0, xga: 1.1, src: "google_ai" },
      },
    });
    expect(buildStatsOverride(d)).toMatchObject({
      xH: 1.5,
      xA: 1.0,
      xgMode: "estimated",
      xg_confidence: "medium",
    });
  });

  it("downgrades even when only ONE side is google_ai-sourced (OR condition, not AND)", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      xg: {
        home: { xgf: 1.5, xga: 1.2, src: "google_ai" },
        away: { xgf: 1.0, xga: 1.1 }, // no src tag — real/pre-PR-19 source
      },
    });
    expect(buildStatsOverride(d)).toMatchObject({
      xgMode: "estimated",
      xg_confidence: "medium",
    });
  });

  it("types scoringConceding rates + first-half share through when the venue sample is thick enough", () => {
    const d = detail({
      scoringConceding: {
        home: {
          matches: 8,
          scored_avg: 2.0,
          goals_1h_avg: 0.9,
          btts_rate: 0.62,
          clean_sheet_rate: 0.25,
          failed_to_score_rate: 0.12,
        },
        away: {
          matches: 3, // below MIN_PLAYED_FOR_OVERRIDE → away side skipped
          btts_rate: 0.7,
        },
      },
    });
    const override = buildStatsOverride(d);
    expect(override).toMatchObject({
      bttsPctH: 0.62,
      csPctH: 0.25,
      ftsPctH: 0.12,
      fhShareH: expect.closeTo(0.45, 5),
    });
    expect(override?.bttsPctA).toBeUndefined();
  });

  it("types formNH/formNA from recentGoals' own match count (PR-3 sample-scaled blend)", () => {
    const d = detail({
      recentGoals: {
        home: { scored_avg: 1.4, conceded_avg: 0.8, n: 5 },
        away: { scored_avg: 0.9, conceded_avg: 1.2, n: 2 },
      },
    });
    const override = buildStatsOverride(d);
    expect(override).toMatchObject({ formNH: 5, formNA: 2 });
  });

  it("omits formNH/formNA when recentGoals is absent", () => {
    const d = detail({ standings: { home: { played: 10 }, away: { played: 10 } } });
    const override = buildStatsOverride(d);
    expect(override?.formNH).toBeUndefined();
    expect(override?.formNA).toBeUndefined();
  });

  it("clamps the first-half share to [0.2, 0.8]", () => {
    const d = detail({
      scoringConceding: {
        home: { matches: 8, scored_avg: 1.0, goals_1h_avg: 0.95 },
      },
    });
    expect(buildStatsOverride(d)?.fhShareH).toBe(0.8);
  });

  it("prefers recent-5 corners and carries corners-against; season fallback needs the sample gate", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      recentCorners: { home: 6.2 },
      recentCornersAgainst: { home: 3.4, away: 5.1 },
      possessionValue: {
        home: { corners_avg: 4.9 }, // shadowed by recent-5
        away: { corners_avg: 4.1 }, // fallback (no recent figure)
      },
    });
    expect(buildStatsOverride(d)).toMatchObject({
      cornersForH: 6.2,
      cornersForA: 4.1,
      cornersAgainstH: 3.4,
      cornersAgainstA: 5.1,
    });
  });

  it("skips the season-corners fallback and cards/O1.5/O2.5/O3.5 when the sample gate fails", () => {
    const d = detail({
      standings: { home: { played: 2 }, away: { played: 2 } },
      possessionValue: { home: { corners_avg: 4.9 }, away: { corners_avg: 4.1 } },
      disciplinary: { home: { yellow_avg: 2.1, red_avg: 0.1 } },
      overunder: {
        home: { over15_pct: 0.85, over25_pct: 0.7, over35_pct: 0.3 },
        away: { over15_pct: 0.8, over25_pct: 0.6, over35_pct: 0.25 },
      },
    });
    const override = buildStatsOverride(d);
    expect(override?.cornersForH).toBeUndefined();
    expect(override?.cardsAvgH).toBeUndefined();
    expect(override?.ouO15H).toBeUndefined();
    expect(override?.ouO25H).toBeUndefined();
    expect(override?.ouO35H).toBeUndefined();
  });

  it("sums yellow+red into cardsAvg and types O1.5/O2.5/O3.5 hit-rates under the sample gate (PR-4)", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      disciplinary: {
        home: { yellow_avg: 2.1, red_avg: 0.1 },
        away: { yellow_avg: 1.8 }, // no red figure → yellow only
      },
      overunder: {
        home: { over15_pct: 0.85, over25_pct: 0.7, over35_pct: 0.3 },
        away: { over15_pct: 0.8, over25_pct: 0.55, over35_pct: 0.25 },
      },
    });
    expect(buildStatsOverride(d)).toMatchObject({
      cardsAvgH: expect.closeTo(2.2, 5),
      cardsAvgA: 1.8,
      ouO15H: 0.85,
      ouO15A: 0.8,
      ouO25H: 0.7,
      ouO25A: 0.55,
      ouO35H: 0.3,
      ouO35A: 0.25,
    });
  });
});

describe("buildStatsOverride — v3 raw lambda inputs (§3.1, ungated by MIN_PLAYED)", () => {
  it("populates scoredPer90/concededPer90/xgf/xga/nHome/nAway even below the legacy sample gate", () => {
    const d = detail({
      standings: { home: { played: 2 }, away: { played: 3 } }, // below MIN_PLAYED_FOR_OVERRIDE(4)
      goals: {
        home: { avg_scored: 1.4, avg_conceded: 1.0 },
        away: { avg_scored: 0.8, avg_conceded: 1.6 },
      },
      xg: {
        home: { xgf: 1.5, xga: 0.9 },
        away: { xgf: 0.9, xga: 1.3 },
      },
    });
    const override = buildStatsOverride(d);
    // Legacy xH/xA override skipped (sample too thin)...
    expect(override?.xH).toBeUndefined();
    // ...but the raw v3 inputs still flow through, ungated.
    expect(override).toMatchObject({
      scoredPer90H: 1.4,
      concededPer90H: 1.0,
      scoredPer90A: 0.8,
      concededPer90A: 1.6,
      xgfH: 1.5,
      xgaH: 0.9,
      xgfA: 0.9,
      xgaA: 1.3,
      nHome: 2,
      nAway: 3,
    });
  });

  it("omits raw fields entirely when the underlying gismo data is absent", () => {
    const d = detail({ standings: { home: { played: 10 }, away: { played: 10 } } });
    const override = buildStatsOverride(d);
    expect(override?.scoredPer90H).toBeUndefined();
    expect(override?.xgfH).toBeUndefined();
  });

  it("passes through npxgf/xagf (PR-25 item 4) when present, ungated by MIN_PLAYED", () => {
    const d = detail({
      standings: { home: { played: 2 }, away: { played: 3 } }, // below MIN_PLAYED_FOR_OVERRIDE(4)
      xg: {
        home: { xgf: 1.5, xga: 0.9, npxgf: 1.3, xagf: 1.1 },
        away: { xgf: 0.9, xga: 1.3, npxgf: 0.8, xagf: 0.7 },
      },
    });
    const override = buildStatsOverride(d);
    expect(override).toMatchObject({
      npxgfH: 1.3,
      xagfH: 1.1,
      npxgfA: 0.8,
      xagfA: 0.7,
    });
  });

  it("omits npxgf/xagf when absent from the source (Understat/FotMob-only teams)", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      xg: { home: { xgf: 1.5, xga: 0.9 }, away: { xgf: 0.9, xga: 1.3 } },
    });
    const override = buildStatsOverride(d);
    expect(override?.npxgfH).toBeUndefined();
    expect(override?.xagfH).toBeUndefined();
    expect(override?.npxgfA).toBeUndefined();
    expect(override?.xagfA).toBeUndefined();
  });

  it("recency-blends scoredPer90H/A from recentGoals when present (PR-5, §8.1)", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      goals: {
        home: { avg_scored: 1.0, avg_conceded: 1.0 },
        away: { avg_scored: 1.0, avg_conceded: 1.0 },
      },
      recentGoals: {
        home: { scored_avg: 2.0, n: 5 },
        away: { scored_avg: 0.4, n: 5 },
      },
    });
    const override = buildStatsOverride(d);
    // RECENT_W=0.6: 2.0*0.6 + 1.0*0.4 = 1.6; 0.4*0.6 + 1.0*0.4 = 0.64
    expect(override?.scoredPer90H).toBeCloseTo(1.6, 5);
    expect(override?.scoredPer90A).toBeCloseTo(0.64, 5);
  });

  it("leaves scoredPer90H/A at the season average when no recency signal exists", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      goals: {
        home: { avg_scored: 1.4, avg_conceded: 1.0 },
        away: { avg_scored: 0.8, avg_conceded: 1.6 },
      },
    });
    const override = buildStatsOverride(d);
    expect(override?.scoredPer90H).toBe(1.4);
    expect(override?.scoredPer90A).toBe(0.8);
  });

  it("[PR-14] prefers scoringConceding venue split over season goals aggregate when sample is thick enough", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      goals: {
        home: { avg_scored: 1.0, avg_conceded: 1.0 },
        away: { avg_scored: 1.0, avg_conceded: 1.0 },
      },
      scoringConceding: {
        home: { matches: 8, scored_avg: 1.7, conceded_avg: 0.6 },
        away: { matches: 8, scored_avg: 0.5, conceded_avg: 1.9 },
      },
    });
    const override = buildStatsOverride(d);
    expect(override?.scoredPer90H).toBe(1.7);
    expect(override?.concededPer90H).toBe(0.6);
    expect(override?.scoredPer90A).toBe(0.5);
    expect(override?.concededPer90A).toBe(1.9);
  });

  it("[PR-14] falls back to the season aggregate when scoringConceding's own sample is too thin", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      goals: {
        home: { avg_scored: 1.0, avg_conceded: 1.0 },
        away: { avg_scored: 1.0, avg_conceded: 1.0 },
      },
      scoringConceding: {
        // Below MIN_PLAYED_FOR_OVERRIDE(4) — too thin to trust.
        home: { matches: 2, scored_avg: 5.0, conceded_avg: 0.1 },
        away: { matches: 2, scored_avg: 0.1, conceded_avg: 5.0 },
      },
    });
    const override = buildStatsOverride(d);
    expect(override?.scoredPer90H).toBe(1.0);
    expect(override?.concededPer90H).toBe(1.0);
    expect(override?.scoredPer90A).toBe(1.0);
    expect(override?.concededPer90A).toBe(1.0);
  });

  it("[PR-14] falls back to the season aggregate when scoringConceding is entirely absent", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      goals: {
        home: { avg_scored: 1.4, avg_conceded: 1.0 },
        away: { avg_scored: 0.8, avg_conceded: 1.6 },
      },
    });
    const override = buildStatsOverride(d);
    expect(override?.scoredPer90H).toBe(1.4);
    expect(override?.concededPer90H).toBe(1.0);
    expect(override?.scoredPer90A).toBe(0.8);
    expect(override?.concededPer90A).toBe(1.6);
  });

  it("populates home/awayAvailabilityMult from stats.availability (PR-6, §8.2)", () => {
    const d = detail({
      standings: { home: { played: 10 }, away: { played: 10 } },
      availability: {
        home: { idx: 0.72, keyPlayerPresent: 0 },
        away: { idx: 0.95 },
      },
    });
    const override = buildStatsOverride(d);
    expect(override?.homeAvailabilityMult).toBe(0.72);
    expect(override?.awayAvailabilityMult).toBe(0.95);
  });

  it("omits home/awayAvailabilityMult when stats.availability is absent", () => {
    const d = detail({ standings: { home: { played: 10 }, away: { played: 10 } } });
    const override = buildStatsOverride(d);
    expect(override?.homeAvailabilityMult).toBeUndefined();
    expect(override?.awayAvailabilityMult).toBeUndefined();
  });
});

describe("blendRecencyScored (PR-5, §8.1 temporal decay for v3 lambda inputs)", () => {
  it("returns the season average unchanged when neither recency signal exists", () => {
    expect(blendRecencyScored(1.4, undefined, undefined)).toBe(1.4);
  });

  it("returns null/undefined-safe when the season average itself is absent", () => {
    expect(blendRecencyScored(undefined, 2.0, "WWDLW")).toBeNull();
    expect(blendRecencyScored(null, 2.0, "WWDLW")).toBeNull();
  });

  it("prefers the real recentGoals signal at a 60/40 recent/season blend", () => {
    expect(blendRecencyScored(1.0, 2.0, undefined)).toBeCloseTo(1.6, 5);
  });

  it("falls back to form-string + applyTemporalDecay when recentGoals is absent", () => {
    const v = blendRecencyScored(1.4, undefined, "WWDLW");
    // A W-heavy last-5 pulls the decayed average above the flat season figure.
    expect(v).not.toBeNull();
    expect(v as number).toBeGreaterThan(1.4);
  });

  it("a losing-heavy form string pulls the decayed average below the season figure", () => {
    const v = blendRecencyScored(1.4, undefined, "LLDLL");
    expect(v).not.toBeNull();
    expect(v as number).toBeLessThan(1.4);
  });
});
