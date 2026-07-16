/** all-markets-analysis-prompt-v3 P3 — pipeline.ts (eligibility + weighted
 *  completeness gate) tests. Confirms the reuse-not-duplication wiring onto
 *  goalsV3/{eligibility,completeness}.ts behaves as documented. */

import { describe, expect, it } from "vitest";
import {
  buildMarketsV3GateConfig,
  gateMarketsV3Fixture,
  gateMarketsV3Slate,
  restrictOddsToGoalsOverOnly,
} from "../src/marketsV3/pipeline.js";
import type { SportyBetEvent, SportyBetOdds } from "../src/selectFixtures.js";

function event(overrides: Partial<SportyBetEvent> = {}): SportyBetEvent {
  return {
    home: "Home FC",
    away: "Away FC",
    marketCount: 20,
    league: "Premier League",
    kickoff_utc: "2026-08-01T15:00:00Z",
    detail: {
      eventId: "sr:match:1",
      odds: {
        "1x2": { home: 1.8, draw: 3.6, away: 4.2 },
        ou25: { over: 1.9, under: 1.95 },
      },
      stats: {
        form: { home: { last5: "WWDLW" }, away: { last5: "LDWWL" } },
        goals: {
          home: { avg_scored: 1.8, avg_conceded: 1.0 },
          away: { avg_scored: 1.0, avg_conceded: 1.4 },
        },
        overunder: { home: { over25_pct: 0.55 }, away: { over25_pct: 0.5 } },
      },
      statscoverage: null,
    },
    ...overrides,
  };
}

describe("buildMarketsV3GateConfig", () => {
  it("defaults to the spec's 70/85 thresholds", () => {
    expect(buildMarketsV3GateConfig({})).toEqual({ completenessMin: 70, heightenedMin: 85 });
  });

  it("reads its own env keys, independent of the goals-only batch's GOALS_V3_*", () => {
    const cfg = buildMarketsV3GateConfig({
      ORACLE_MARKETS_V3_COMPLETENESS_MIN: "60",
      ORACLE_MARKETS_V3_HEIGHTENED_MIN: "90",
      GOALS_V3_COMPLETENESS_MIN: "50", // must NOT leak into this config
    });
    expect(cfg).toEqual({ completenessMin: 60, heightenedMin: 90 });
  });
});

describe("gateMarketsV3Fixture", () => {
  const cfg = buildMarketsV3GateConfig({});

  it("passes a well-formed, whitelisted, mandatory-complete fixture", () => {
    const result = gateMarketsV3Fixture(event(), cfg);
    expect(result.passes).toBe(true);
    expect(result.eligibility.status).toBe("eligible");
    expect(result.completeness.mandatoryMissing).toHaveLength(0);
  });

  it("discards SRL/virtual fixtures before completeness is even relevant", () => {
    const result = gateMarketsV3Fixture(event({ home: "Simulated Reality League FC" }), cfg);
    expect(result.passes).toBe(false);
    expect(result.discardReason).toBe("srl_virtual");
  });

  it("[Wave-4 WS-A3] no longer discards non-whitelisted leagues — passes with an off_whitelist annotation only", () => {
    const result = gateMarketsV3Fixture(event({ league: "Some Obscure Regional League" }), cfg);
    expect(result.passes).toBe(true);
    expect(result.eligibility.status).toBe("eligible");
    expect(result.eligibility.reasons).toContain("off_whitelist");
  });

  it("[patterns-engine Wave 1] unknown league with thin data now PASSES with a mandatory_data_missing annotation (no longer discarded)", () => {
    const result = gateMarketsV3Fixture(
      event({
        league: "Some Obscure Regional League",
        detail: {
          eventId: "e",
          odds: { "1x2": { home: 1.8, draw: 3.6, away: 4.2 }, ou25: { over: 1.9, under: 1.95 } },
          stats: null, // no form/scored/conceded — thin data, mandatory block incomplete
          statscoverage: null,
        },
      }),
      cfg
    );
    // Eligibility itself is unaffected by the league being off-list.
    expect(result.eligibility.status).toBe("eligible");
    expect(result.eligibility.reasons).toContain("off_whitelist");
    // [patterns-engine Wave 1 — Phase 5 "see every fixture"] Thin data no longer
    // discards — the fixture is analysed and the shortfall recorded as a
    // non-gating annotation.
    expect(result.passes).toBe(true);
    expect(result.annotations).toContain("mandatory_data_missing");
  });

  it("discards on missing mandatory odds even for a whitelisted league", () => {
    const result = gateMarketsV3Fixture(
      event({ detail: { eventId: "e", odds: null, stats: null, statscoverage: null } }),
      cfg
    );
    expect(result.passes).toBe(false);
    // classifyEligibility's own odds pre-check fires before completeness runs.
    expect(result.discardReason).toBe("missing_mandatory_odds");
  });

  it("[patterns-engine Wave 1] incomplete mandatory block now PASSES with a mandatory_data_missing annotation (was a discard)", () => {
    const result = gateMarketsV3Fixture(
      event({
        detail: {
          eventId: "e",
          odds: { "1x2": { home: 1.8, draw: 3.6, away: 4.2 }, ou25: { over: 1.9, under: 1.95 } },
          stats: null, // no form/scored/conceded/hitRate at all
          statscoverage: null,
        },
      }),
      cfg
    );
    expect(result.passes).toBe(true);
    expect(result.annotations).toContain("mandatory_data_missing");
  });

  it("[patterns-engine Wave 1] heightened fixture below the 85 floor now PASSES with a below_completeness_floor annotation (was a discard)", () => {
    const heightenedEvent = event({ home: "Home FC U19", away: "Away FC U19" });
    // Mandatory block alone scores 70 (odds+form+scored+conceded+hitRate),
    // clears the normal 70 floor but not the heightened 85 floor — a shortfall
    // that now annotates rather than discards.
    const result = gateMarketsV3Fixture(heightenedEvent, cfg);
    expect(result.eligibility.status).toBe("heightened");
    expect(result.passes).toBe(true);
    expect(result.annotations).toContain("below_completeness_floor");
  });

  it("respects a custom (looser) completenessMin from config", () => {
    const looseCfg = buildMarketsV3GateConfig({ ORACLE_MARKETS_V3_COMPLETENESS_MIN: "50" });
    const result = gateMarketsV3Fixture(event(), looseCfg);
    expect(result.passes).toBe(true);
  });
});

describe("gateMarketsV3Slate", () => {
  it("[patterns-engine Wave 1] tallies pass/discard/annotation counts across a mixed slate — only srl_virtual still discards", () => {
    const events = [
      event(),
      event({ home: "Simulated Reality League FC" }),
      event({ league: "Some Obscure Regional League" }),
      event({ home: "Home FC U19", away: "Away FC U19" }),
    ];
    const { summary } = gateMarketsV3Slate(events, buildMarketsV3GateConfig({}));
    expect(summary.total).toBe(4);
    // Only srl_virtual is still a hard discard. The off-list fixture passes
    // (off_whitelist is a non-gating eligibility annotation), and the
    // heightened youth fixture below the 85 floor now passes too — its
    // shortfall recorded as a below_completeness_floor annotation, not a drop.
    expect(summary.passed).toBe(3);
    expect(summary.discardCounts.srl_virtual).toBe(1);
    expect(summary.discardCounts.not_whitelisted).toBeUndefined();
    expect(summary.discardCounts.below_completeness_floor).toBeUndefined();
    expect(summary.annotationCounts.below_completeness_floor).toBe(1);
  });

  it("threads per-event enrichment (H2H/lineups) through to the completeness score", () => {
    const events = [event()];
    const { results } = gateMarketsV3Slate(events, buildMarketsV3GateConfig({}), () => ({
      h2hEnriched: true,
      lineupsAvailable: true,
    }));
    expect(results[0]!.completeness.score).toBeGreaterThan(70); // +10 h2h +5 lineups
  });
});

describe("[Wave-4 WS-A3] restrictOddsToGoalsOverOnly (friendly market-restriction choke point)", () => {
  const fullOdds: SportyBetOdds = {
    "1x2": { home: 1.8, draw: 3.6, away: 4.2 },
    ou25: { over: 1.9, under: 1.95 },
    ou15: { over: 1.2, under: 4.5 },
    ou35: { over: 3.1, under: 1.35 },
    tt_home_05: { over: 1.3, under: 3.2 },
    tt_away_05: { over: 1.6, under: 2.2 },
    btts: { yes: 1.8, no: 1.9 },
    dc: { "1x": 1.2, "12": 1.1, x2: 1.5 },
    dnb: { home: 1.6, away: 2.2 },
    ah: { home: 1.9, away: 1.9, line: -0.5 },
    half: {
      win_either_half: { home: { yes: 1.4, no: 2.8 } },
      both_halves_ou: { "0.5": { over: 1.1, under: 6.0 } },
      ht_ou: { "0.5": { over: 1.3, under: 3.1 }, "1.5": { over: 2.1, under: 1.6 } },
      h2_ou: { "0.5": { over: 1.2, under: 3.8 } },
      ht_team_ou: { home: { "0.5": { over: 1.5, under: 2.4 } } },
    },
    combo: {
      "1x2_btts": { home_yes: "3.0", home_no: "2.5" },
    },
    allMarkets: [
      { id: "1", outcomes: [{ id: "1", odds: "1.8" }] },
      { id: "999", name: "Corners Over/Under", outcomes: [{ id: "over", odds: "1.9" }] },
    ],
  };

  it("removes 1X2 and every derivative family (dc/dnb/ah/btts/combo)", () => {
    const r = restrictOddsToGoalsOverOnly(fullOdds);
    expect(r?.["1x2"]).toBeUndefined();
    expect(r?.dc).toBeUndefined();
    expect(r?.dnb).toBeUndefined();
    expect(r?.ah).toBeUndefined();
    expect(r?.btts).toBeUndefined();
    expect(r?.combo).toBeUndefined();
  });

  it("drops the generic allMarkets catalogue wholesale (no id→family map to filter it safely)", () => {
    const r = restrictOddsToGoalsOverOnly(fullOdds);
    expect(r?.allMarkets).toBeUndefined();
  });

  it("retains match-goals O/U Over lines only, dropping Under", () => {
    const r = restrictOddsToGoalsOverOnly(fullOdds);
    expect(r?.ou15).toEqual({ over: 1.2 });
    expect(r?.ou25).toEqual({ over: 1.9 });
    expect(r?.ou35).toEqual({ over: 3.1 });
    expect(r?.ou25?.under).toBeUndefined();
  });

  it("retains team-total Over outcomes only", () => {
    const r = restrictOddsToGoalsOverOnly(fullOdds);
    expect(r?.tt_home_05).toEqual({ over: 1.3 });
    expect(r?.tt_away_05).toEqual({ over: 1.6 });
  });

  it("retains 1st-half match-total goals Over lines only, dropping every other half family", () => {
    const r = restrictOddsToGoalsOverOnly(fullOdds);
    expect(r?.half?.ht_ou).toEqual({ "0.5": { over: 1.3 }, "1.5": { over: 2.1 } });
    expect(r?.half?.win_either_half).toBeUndefined();
    expect(r?.half?.both_halves_ou).toBeUndefined();
    expect(r?.half?.h2_ou).toBeUndefined();
    expect(r?.half?.ht_team_ou).toBeUndefined();
  });

  it("passes through null/undefined odds unchanged", () => {
    expect(restrictOddsToGoalsOverOnly(null)).toBeNull();
    expect(restrictOddsToGoalsOverOnly(undefined)).toBeNull();
  });
});
