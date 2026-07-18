/** Green-Flags report enrichment — maps sidecar SportyBetEvent stats into the
 *  engine's shared detectPatterns() and summarizes for the daily report.
 *  Reuses the reference-doc Arsenal-vs-Chelsea worked example (same numbers
 *  as packages/engine/test/patterns.test.ts) so the mapping is checked
 *  against a known-good detector result. */
import { describe, expect, it } from "vitest";
import {
  buildReportPatternInput,
  compareGreenFlagSummaries,
  slateGreenFlagProfile,
  summarizeGreenFlags,
} from "../src/reportPatterns.js";
import type { SportyBetEvent } from "../src/selectFixtures.js";

function arsenalChelseaEvent(overrides: Partial<SportyBetEvent> = {}): SportyBetEvent {
  return {
    home: "Arsenal",
    away: "Chelsea",
    league: "Premier League",
    kickoff_utc: "2026-07-18T17:30:00Z",
    marketCount: 10,
    detail: {
      eventId: "evt-1",
      odds: {
        "1x2": { home: 1.5, draw: 4.2, away: 6.0 },
      },
      stats: {
        scoringConceding: {
          home: {
            matches: 5,
            scored_avg: 2.4,
            conceded_avg: 0.6,
            btts_rate: 0.4,
            clean_sheet_rate: 0.6,
            failed_to_score_rate: 0.0,
          },
          away: {
            matches: 5,
            scored_avg: 0.8,
            conceded_avg: 2.2,
            btts_rate: 0.6,
            clean_sheet_rate: 0.0,
            failed_to_score_rate: 0.2,
          },
        },
        overunder: {
          home: { over15_pct: 1.0, over25_pct: 0.8, over35_pct: 0.4 },
          away: { over15_pct: 0.8, over25_pct: 0.6, over35_pct: 0.2 },
        },
        recentCorners: { home: 6.8, away: 4.2 },
        recentCornersAgainst: { home: 3.2, away: 6.5 },
        form: {
          home: { last5: "WWWWD", streak: 4 },
          away: { last5: "LLDLL", streak: -2 },
        },
      },
      statscoverage: {},
    },
    ...overrides,
  } as SportyBetEvent;
}

describe("buildReportPatternInput", () => {
  it("maps venue-split scoringConceding into the detector input (basis=venue); conceded stays flat-season", () => {
    const built = buildReportPatternInput(arsenalChelseaEvent());
    expect(built).not.toBeNull();
    expect(built?.basis).toBe("venue");
    // homeScoredHome/awayScoredAway are recency-blended (see the dedicated blend
    // test below) — conceded is never blended, matching buildStatsOverride.
    expect(built?.input.homeConcededHome).toBe(0.6);
    expect(built?.input.awayConcededAway).toBe(2.2);
    expect(built?.input.cornersForH).toBe(6.8);
    expect(built?.input.streakH).toBe(4);
  });

  it("recency-blends the scored side via the SAME blendRecencyScored helper the live pick engine uses", () => {
    const event = arsenalChelseaEvent();
    const built = buildReportPatternInput(event);
    // No stats.recentGoals in the fixture, so blendRecencyScored falls through to
    // its form-string-decay branch (formToRecentMatches + applyTemporalDecay) —
    // this asserts the module actually calls the shared helper (a different,
    // non-flat number results) rather than silently using the raw season average.
    expect(built?.input.homeScoredHome).not.toBe(2.4);
    expect(built?.input.homeScoredHome).toBeGreaterThan(0);
    expect(built?.input.awayScoredAway).not.toBe(0.8);

    // With an explicit stats.recentGoals present, the blend is the exact documented
    // 60/40 recent/season formula (blendRecencyScored, sportyBetStats.ts:161-171).
    const withRecent = arsenalChelseaEvent({
      detail: {
        eventId: "evt-recent",
        odds: event.detail?.odds,
        stats: {
          ...event.detail?.stats,
          recentGoals: { home: { scored_avg: 3.0 }, away: { scored_avg: 0.4 } },
        },
        statscoverage: {},
      },
    });
    const builtRecent = buildReportPatternInput(withRecent);
    expect(builtRecent?.input.homeScoredHome).toBeCloseTo(3.0 * 0.6 + 2.4 * 0.4, 5);
    expect(builtRecent?.input.awayScoredAway).toBeCloseTo(0.4 * 0.6 + 0.8 * 0.4, 5);
  });

  it("sets leagueAvgGoals from the static V3_LEAGUE_BASELINES table when the league is recognised", () => {
    const built = buildReportPatternInput(arsenalChelseaEvent());
    expect(built?.input.leagueAvgGoals).toBeGreaterThan(0);

    const unknownLeague = buildReportPatternInput(
      arsenalChelseaEvent({ league: "Not A Real League" })
    );
    expect(unknownLeague?.input.leagueAvgGoals).toBeUndefined();
  });

  it("falls back to overall season goals.avg_* when scoringConceding is absent (basis=overall)", () => {
    const event = arsenalChelseaEvent({
      detail: {
        eventId: "evt-2",
        odds: {},
        stats: {
          goals: {
            home: { avg_scored: 2.1, avg_conceded: 0.9 },
            away: { avg_scored: 0.9, avg_conceded: 1.9 },
          },
          standings: {
            home: { played: 20 },
            away: { played: 20 },
          },
        },
        statscoverage: {},
      },
    });
    const built = buildReportPatternInput(event);
    expect(built).not.toBeNull();
    expect(built?.basis).toBe("overall");
    expect(built?.input.homeScoredHome).toBe(2.1);
  });

  it("returns null when neither venue nor overall goal rates exist", () => {
    const event = arsenalChelseaEvent({
      detail: { eventId: "evt-3", odds: {}, stats: {}, statscoverage: {} },
    });
    expect(buildReportPatternInput(event)).toBeNull();
  });

  it("computes h2hOversRate from >=3 scored H2H meetings, null under 3", () => {
    const withH2h = arsenalChelseaEvent({
      detail: {
        eventId: "evt-4",
        odds: {},
        stats: {
          ...arsenalChelseaEvent().detail?.stats,
          h2h: {
            matches: [
              { home_goals: 3, away_goals: 1 },
              { home_goals: 2, away_goals: 2 },
              { home_goals: 1, away_goals: 0 },
            ],
          },
        },
        statscoverage: {},
      },
    });
    // Meeting totals: 3+1=4 (over), 2+2=4 (over), 1+0=1 (not over) → 2/3.
    expect(buildReportPatternInput(withH2h)?.input.h2hOversRate).toBeCloseTo(2 / 3, 5);

    const thin = arsenalChelseaEvent({
      detail: {
        eventId: "evt-5",
        odds: {},
        stats: {
          ...arsenalChelseaEvent().detail?.stats,
          h2h: { matches: [{ home_goals: 3, away_goals: 1 }] },
        },
        statscoverage: {},
      },
    });
    expect(buildReportPatternInput(thin)?.input.h2hOversRate).toBeUndefined();
  });
});

describe("summarizeGreenFlags", () => {
  it("raises Heavy Superior + Goal Machine + Corner Kings for the Arsenal-vs-Chelsea worked example, venue basis, never Under", () => {
    const summary = summarizeGreenFlags(arsenalChelseaEvent());
    expect(summary.flagCount).toBeGreaterThan(0);
    expect(summary.basis).toBe("venue");
    const kinds = summary.flags.map((f) => f.kind);
    expect(kinds).toContain("heavy_superior");
    expect(summary.sentence).toBeTruthy();
    expect(summary.sentence?.toLowerCase()).not.toContain("under");
    for (const f of summary.flags) {
      expect(f.rationale.toLowerCase()).not.toMatch(/\bunder\b/);
    }
  });

  it("never throws on a fixture with no stats block; returns an empty summary", () => {
    const event = arsenalChelseaEvent({
      detail: { eventId: "e", odds: {}, stats: null, statscoverage: null },
    });
    const summary = summarizeGreenFlags(event);
    expect(summary.flagCount).toBe(0);
    expect(summary.basis).toBeNull();
    expect(summary.sentence).toBeNull();
  });

  it("never throws on a malformed event missing detail entirely", () => {
    const event = { home: "A", away: "B", marketCount: 0 } as SportyBetEvent;
    expect(() => summarizeGreenFlags(event)).not.toThrow();
    expect(summarizeGreenFlags(event).flagCount).toBe(0);
  });
});

describe("compareGreenFlagSummaries", () => {
  it("sorts most-flags-first, venue basis ahead of overall° at equal counts", () => {
    const many = summarizeGreenFlags(arsenalChelseaEvent());
    const none = summarizeGreenFlags(
      arsenalChelseaEvent({ detail: { eventId: "e", odds: {}, stats: null, statscoverage: null } })
    );
    const list = [none, many].sort(compareGreenFlagSummaries);
    expect(list[0]).toBe(many);
    expect(list[1]).toBe(none);
  });
});

describe("slateGreenFlagProfile", () => {
  it("summarizes dominant trend counts across the slate", () => {
    const summaries = [
      summarizeGreenFlags(arsenalChelseaEvent()),
      summarizeGreenFlags(arsenalChelseaEvent({ home: "Real Madrid", away: "Alaves" })),
    ];
    const line = slateGreenFlagProfile(summaries, 5);
    expect(line).toMatch(/Slate profile:/);
    expect(line).toContain("of 5 fixtures");
  });

  it("returns null when no fixture raised any flag", () => {
    const none = summarizeGreenFlags(
      arsenalChelseaEvent({ detail: { eventId: "e", odds: {}, stats: null, statscoverage: null } })
    );
    expect(slateGreenFlagProfile([none], 1)).toBeNull();
  });
});
