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

  it("builds h2hMeetings with correct orientation and atCurrentVenue flag from team-name-matched meetings", () => {
    const event = arsenalChelseaEvent({
      detail: {
        eventId: "evt-h2h",
        odds: {},
        stats: {
          ...arsenalChelseaEvent().detail?.stats,
          h2h: {
            matches: [
              // Same orientation as the current fixture (Arsenal home) → atCurrentVenue.
              { home_team: "Arsenal", away_team: "Chelsea", home_goals: 3, away_goals: 1 },
              // Reversed orientation (Chelsea was home) → NOT atCurrentVenue; result flips.
              { home_team: "Chelsea", away_team: "Arsenal", home_goals: 2, away_goals: 0 },
            ],
          },
        },
        statscoverage: {},
      },
    });
    const meetings = buildReportPatternInput(event)?.input.h2hMeetings;
    expect(meetings).toHaveLength(2);
    expect(meetings?.[0]).toMatchObject({
      result: "home_win",
      atCurrentVenue: true,
      totalGoals: 4,
    });
    // Chelsea 2-0 Arsenal, from Arsenal's (current home's) perspective, is an away_win.
    expect(meetings?.[1]).toMatchObject({
      result: "away_win",
      atCurrentVenue: false,
      totalGoals: 2,
    });
  });

  it("skips reserve-team H2H meetings entirely — namesMatch's substring tolerance ('Barcelona' vs 'Barcelona B') is ambiguous in BOTH orientations, so this fails safe rather than guessing", () => {
    // A first-team-vs-reserve fixture is a real, common case in the
    // whitelisted lower-tier leagues. Because "barcelona" is a substring of
    // "barcelona b" regardless of which side it's assigned to, BOTH the
    // straight and reversed pairing test true — genuinely unresolvable via
    // name matching alone. The ambiguity guard must skip it (fail safe: no
    // H2H pattern data for this fixture) rather than silently pick a side.
    const event = arsenalChelseaEvent({
      home: "Barcelona",
      away: "Barcelona B",
      detail: {
        eventId: "evt-reserve",
        odds: {},
        stats: {
          ...arsenalChelseaEvent().detail?.stats,
          h2h: {
            matches: [
              { home_team: "Barcelona", away_team: "Barcelona B", home_goals: 2, away_goals: 1 },
            ],
          },
        },
        statscoverage: {},
      },
    });
    expect(buildReportPatternInput(event)?.input.h2hMeetings).toBeUndefined();
  });

  it("skips an H2H meeting missing a team name entirely (cannot confirm orientation)", () => {
    const event = arsenalChelseaEvent({
      detail: {
        eventId: "evt-no-names",
        odds: {},
        stats: {
          ...arsenalChelseaEvent().detail?.stats,
          h2h: { matches: [{ home_goals: 3, away_goals: 1 }] },
        },
        statscoverage: {},
      },
    });
    expect(buildReportPatternInput(event)?.input.h2hMeetings).toBeUndefined();
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

describe("summarizeGreenFlags — plain-English meanings (additive, display-only)", () => {
  it("attaches a static per-kind meaning string to every fired flag, independent of the detector's own rationale", () => {
    const summary = summarizeGreenFlags(arsenalChelseaEvent());
    expect(summary.flags.length).toBeGreaterThan(0);
    for (const f of summary.flags) {
      expect(f.meaning).toBeTruthy();
      expect(f.meaning).not.toBe(f.rationale); // meaning is static/generic, rationale is per-fixture
    }
  });

  it("attaches a meaning string to every fired trap flag, same length/order as trapFlags", () => {
    // T2 congestion: home short on rest, away well-rested.
    const event = arsenalChelseaEvent({
      detail: {
        eventId: "evt-trap",
        odds: arsenalChelseaEvent().detail?.odds,
        stats: {
          ...arsenalChelseaEvent().detail?.stats,
          congestion: { home: { rest_days: 2 }, away: { rest_days: 6 } },
        },
        statscoverage: {},
      },
    });
    const summary = summarizeGreenFlags(event);
    expect(summary.trapFlags.length).toBeGreaterThan(0);
    expect(summary.trapMeanings).toHaveLength(summary.trapFlags.length);
    for (const m of summary.trapMeanings) expect(m).toBeTruthy();
  });

  it("does not alter flags/sentence/trapWarning/recommended vs. the pre-existing detector output shape", () => {
    // Regression guard: the plain-English additions must be purely additive.
    const summary = summarizeGreenFlags(arsenalChelseaEvent());
    expect(summary.sentence).toBeTruthy();
    expect(summary.recommended).toBeTruthy();
    expect(typeof summary.strength).toBe("number");
  });
});

describe("summarizeGreenFlags — market evidence cross-check (additive, display-only)", () => {
  it("confirms the recommendation when a matching scraped market/outcome exists in allMarkets, including a non-typed 'exotic' market", () => {
    const event = arsenalChelseaEvent({
      detail: {
        eventId: "evt-evidence",
        odds: {
          ...arsenalChelseaEvent().detail?.odds,
          allMarkets: [
            {
              id: "18",
              name: "Over/Under",
              group: "Goals",
              outcomes: [
                { id: "18_1", desc: "Over 2.5", odds: "1.85" },
                { id: "18_2", desc: "Under 2.5", odds: "1.95" },
              ],
            },
            // An exotic/specials-family market present in the scrape but
            // irrelevant to this fixture's recommended family — must not be
            // mistaken for evidence.
            {
              id: "9999",
              name: "Some Exotic Special",
              group: "Specials",
              outcomes: [{ id: "9999_1", desc: "Yes", odds: "3.4" }],
            },
          ],
        },
        stats: arsenalChelseaEvent().detail?.stats,
        statscoverage: {},
      },
    });
    const summary = summarizeGreenFlags(event);
    // The Arsenal-vs-Chelsea worked example's top pattern is Heavy Superior
    // (asian_handicap), not goals_ou — this fixture's scraped allMarkets has
    // no canonical asian_handicap market (id 16), so evidence is correctly
    // "checked, not found", not "found". Assert the concrete recommendation
    // and evidence state instead of a silently-skippable conditional.
    expect(summary.recommended).toBe("asian_handicap Home");
    expect(summary.marketEvidence).not.toBeNull();
    expect(summary.marketEvidence?.found).toBe(false);
    expect(summary.marketEvidence?.familyMarketCount).toBe(0);
  });

  it("confirms a goals_ou recommendation from the real full-time goals market (id 18), matching the exact outcome text", () => {
    // half_share fires on fhShareH/fhShareA alone and recommends goals_ou
    // ("1H Over"/"2H Over") — build a fixture where it's the ONLY pattern
    // that can fire (neutral scoring/corners/odds everywhere else) so the
    // recommendation is deterministic, then scrape a real full-time O/U
    // market whose outcome text is expected NOT to match the half-specific
    // side text exactly (proving the substring match still requires the
    // recommended side string, not just family/id).
    const halfShareEvent = arsenalChelseaEvent({
      home: "Neutral A",
      away: "Neutral B",
      detail: {
        eventId: "evt-halfshare",
        odds: {
          "1x2": { home: 2.0, draw: 3.3, away: 3.6 }, // no clear favourite
          allMarkets: [
            {
              id: "18",
              name: "Over/Under",
              group: "Main",
              outcomes: [
                { id: "o1", desc: "1H Over", odds: "2.1" },
                { id: "o2", desc: "1H Under", odds: "1.7" },
              ],
            },
          ],
        },
        stats: {
          scoringConceding: {
            home: { matches: 6, scored_avg: 1.3, conceded_avg: 1.3 },
            away: { matches: 6, scored_avg: 1.3, conceded_avg: 1.3, goals_1h_avg: 1.1 },
          },
        },
        statscoverage: {},
      },
    });
    const summary = summarizeGreenFlags(halfShareEvent);
    expect(summary.recommended).toBe("goals_ou 1H Over");
    expect(summary.marketEvidence).not.toBeNull();
    expect(summary.marketEvidence?.found).toBe(true);
    expect(summary.marketEvidence?.matchedMarketIds).toEqual(["18"]);
    expect(summary.marketEvidence?.matchedOutcomes).toEqual(["1H Over"]);
  });

  it("does NOT treat a same-family-but-different-stat market (Offsides O/U, id 900396) as evidence for a goals recommendation — regression for the catalog's coarse family grouping", () => {
    // catalog.generated.ts classifies "Offsides Over/Under" (900396) under
    // the SAME MarketFamily ("goals_ou") as the real full-time goals total
    // (id 18) because both are Over/Under-shaped markets — a naive
    // family-wide scan would let a scraped offsides market falsely
    // "confirm" a goals lean. Only the canonical id (18) may count. Reuses
    // the deterministic half_share fixture from the test above (recommends
    // "goals_ou 1H Over") but scrapes only the offsides market.
    const event = arsenalChelseaEvent({
      home: "Neutral A",
      away: "Neutral B",
      detail: {
        eventId: "evt-offsides-fp",
        odds: {
          "1x2": { home: 2.0, draw: 3.3, away: 3.6 },
          allMarkets: [
            {
              id: "900396",
              name: "Offsides Over/Under",
              group: "Match",
              outcomes: [
                { id: "o1", desc: "1H Over", odds: "1.9" },
                { id: "o2", desc: "1H Under", odds: "1.9" },
              ],
            },
          ],
        },
        stats: {
          scoringConceding: {
            home: { matches: 6, scored_avg: 1.3, conceded_avg: 1.3 },
            away: { matches: 6, scored_avg: 1.3, conceded_avg: 1.3, goals_1h_avg: 1.1 },
          },
        },
        statscoverage: {},
      },
    });
    const summary = summarizeGreenFlags(event);
    expect(summary.recommended).toBe("goals_ou 1H Over");
    expect(summary.marketEvidence?.found).toBe(false);
    expect(summary.marketEvidence?.familyMarketCount).toBe(0);
    expect(summary.marketEvidence?.matchedMarketIds).not.toContain("900396");
  });

  it("confirms a Corner Kings recommendation from the real corners market (id 166) despite the catalog classifying it under family 'specials', not 'corners'", () => {
    // Regression for the catalog's own family/group disagreement: id 166
    // ("Corners - Over/Under") is catalogued with family:"specials" even
    // though it's the actual corners market — group:"Corners" is the real
    // signal. A family-equality guard on top of the id pin would zero out
    // every Corner Kings evidence check; this proves it doesn't. Corner
    // stats here reuse the exact worked example from
    // packages/engine/test/patterns.test.ts ("Corner Kings fires on a high
    // combined corner expectation") layered on a neutral goals/odds profile
    // so corner_kings is deterministically the only pattern that can fire.
    const cornersEvent = arsenalChelseaEvent({
      home: "Neutral A",
      away: "Neutral B",
      detail: {
        eventId: "evt-corners",
        odds: {
          "1x2": { home: 2.0, draw: 3.3, away: 3.6 },
          allMarkets: [
            {
              id: "166",
              name: "Corners - Over/Under",
              group: "Corners",
              outcomes: [
                { id: "c1", desc: "Over 12.5", odds: "1.9" },
                { id: "c2", desc: "Under 12.5", odds: "1.9" },
              ],
            },
          ],
        },
        stats: {
          scoringConceding: {
            home: { matches: 6, scored_avg: 1.3, conceded_avg: 1.3 },
            away: { matches: 6, scored_avg: 1.3, conceded_avg: 1.3 },
          },
          recentCorners: { home: 7.2, away: 6.4 },
          recentCornersAgainst: { home: 6.0, away: 6.8 },
        },
        statscoverage: {},
      },
    });
    const summary = summarizeGreenFlags(cornersEvent);
    // Combined expected corners = (7.2+6.8)/2 + (6.4+6.0)/2 = 13.2 → line
    // floor(13.2-1)+0.5 = 12.5, matching the scraped "Over 12.5" exactly.
    expect(summary.recommended).toBe("corners Over 12.5");
    expect(summary.marketEvidence).not.toBeNull();
    expect(summary.marketEvidence?.familyMarketCount).toBe(1);
    expect(summary.marketEvidence?.found).toBe(true);
    expect(summary.marketEvidence?.matchedMarketIds).toEqual(["166"]);
  });

  it("reports found=false with a familyMarketCount when the family is scraped but no outcome matches the side", () => {
    const event = arsenalChelseaEvent({
      detail: {
        eventId: "evt-noside",
        odds: {
          ...arsenalChelseaEvent().detail?.odds,
          allMarkets: [
            {
              id: "18",
              name: "Over/Under",
              group: "Goals",
              // Only a 4.5 line scraped — no outcome text will match a
              // recommendation like "Over 2.5".
              outcomes: [
                { id: "18_1", desc: "Over 4.5", odds: "3.2" },
                { id: "18_2", desc: "Under 4.5", odds: "1.3" },
              ],
            },
          ],
        },
        stats: arsenalChelseaEvent().detail?.stats,
        statscoverage: {},
      },
    });
    const summary = summarizeGreenFlags(event);
    if (summary.recommended?.startsWith("goals_ou")) {
      expect(summary.marketEvidence?.found).toBe(false);
      expect(summary.marketEvidence?.familyMarketCount).toBeGreaterThan(0);
    }
  });

  it("returns marketEvidence=null when the fixture has no scraped allMarkets at all", () => {
    const summary = summarizeGreenFlags(arsenalChelseaEvent()); // base fixture: no allMarkets
    expect(summary.recommended).toBeTruthy();
    expect(summary.marketEvidence).toBeNull();
  });

  it("never throws when allMarkets contains an unrecognised market id", () => {
    const event = arsenalChelseaEvent({
      detail: {
        eventId: "evt-unknown-id",
        odds: {
          ...arsenalChelseaEvent().detail?.odds,
          allMarkets: [{ id: "not-a-real-id", name: "?", group: "?", outcomes: [] }],
        },
        stats: arsenalChelseaEvent().detail?.stats,
        statscoverage: {},
      },
    });
    expect(() => summarizeGreenFlags(event)).not.toThrow();
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
