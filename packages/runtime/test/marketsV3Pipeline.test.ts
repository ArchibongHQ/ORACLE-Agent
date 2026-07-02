/** all-markets-analysis-prompt-v3 P3 — pipeline.ts (eligibility + weighted
 *  completeness gate) tests. Confirms the reuse-not-duplication wiring onto
 *  goalsV3/{eligibility,completeness}.ts behaves as documented. */

import { describe, expect, it } from "vitest";
import {
  buildMarketsV3GateConfig,
  gateMarketsV3Fixture,
  gateMarketsV3Slate,
} from "../src/marketsV3/pipeline.js";
import type { SportyBetEvent } from "../src/selectFixtures.js";

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

  it("discards non-whitelisted leagues", () => {
    const result = gateMarketsV3Fixture(event({ league: "Some Obscure Regional League" }), cfg);
    expect(result.passes).toBe(false);
    expect(result.discardReason).toBe("not_whitelisted");
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

  it("discards when the mandatory completeness block is incomplete despite eligible odds", () => {
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
    expect(result.passes).toBe(false);
    expect(result.discardReason).toBe("mandatory_data_missing");
  });

  it("applies the heightened bar (85) for youth/women/friendly/cup-final fixtures", () => {
    const heightenedEvent = event({ home: "Home FC U19", away: "Away FC U19" });
    // Mandatory block alone scores 70 (odds+form+scored+conceded+hitRate),
    // clears the normal 70 floor but not the heightened 85 floor.
    const result = gateMarketsV3Fixture(heightenedEvent, cfg);
    expect(result.eligibility.status).toBe("heightened");
    expect(result.passes).toBe(false);
    expect(result.discardReason).toBe("below_completeness_floor");
  });

  it("respects a custom (looser) completenessMin from config", () => {
    const looseCfg = buildMarketsV3GateConfig({ ORACLE_MARKETS_V3_COMPLETENESS_MIN: "50" });
    const result = gateMarketsV3Fixture(event(), looseCfg);
    expect(result.passes).toBe(true);
  });
});

describe("gateMarketsV3Slate", () => {
  it("tallies pass/discard counts across a mixed slate", () => {
    const events = [
      event(),
      event({ home: "Simulated Reality League FC" }),
      event({ league: "Some Obscure Regional League" }),
      event({ home: "Home FC U19", away: "Away FC U19" }),
    ];
    const { summary } = gateMarketsV3Slate(events, buildMarketsV3GateConfig({}));
    expect(summary.total).toBe(4);
    expect(summary.passed).toBe(1);
    expect(summary.discardCounts.srl_virtual).toBe(1);
    expect(summary.discardCounts.not_whitelisted).toBe(1);
    expect(summary.discardCounts.below_completeness_floor).toBe(1);
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
