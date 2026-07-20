/** [Phase 2, two-tier slate] dailyBatch.ts's V3DeliveryCandidate → ActionablePick
 *  conversion — tested in isolation, since runDailyBatch's own dependency chain
 *  (scraping/LLM/external APIs) has no existing test harness for the surrounding
 *  orchestration. This is the pure, exported conversion logic the two-tier
 *  assembly (packages/runtime's buildTwoTierSlate, already covered by
 *  twoTierSlate.test.ts) hands off to for rendering. */

import type { V3DeliveryCandidate } from "@oracle/engine";
import { makeFixtureId } from "@oracle/engine";
import { describe, expect, it, vi } from "vitest";
import { deliveryCandidateToPick, findUnmappedLegacyPicks } from "../src/dailyBatch.js";

function deliveryCandidate(overrides: Partial<V3DeliveryCandidate> = {}): V3DeliveryCandidate {
  return {
    fixtureId: "f1",
    home: "Arsenal",
    away: "Chelsea",
    league: "Premier League",
    kickoff: "2026-01-01T15:00:00Z",
    marketName: "Goals O/U",
    desc: "Over 2.5",
    cls: "M",
    mp: 0.62,
    odds: 2.1,
    q: 0.5,
    rawEdge: 0.12,
    penaltyPts: 0,
    adjustedEdge: 0.08,
    adjEvPct: 0.16,
    confidence: "high",
    family: "goals_ou",
    stakePct: 2.5,
    trapWarning: "no contradicting signal detected",
    basisLabel: "venue",
    ...overrides,
  };
}

describe("deliveryCandidateToPick — Tier① (qualified)", () => {
  it("maps every field, using mp for confidence (never an LLM self-report)", () => {
    const c = deliveryCandidate({ mp: 0.71 });
    const pick = deliveryCandidateToPick(c, "qualified", () => undefined);
    expect(pick.home).toBe("Arsenal");
    expect(pick.away).toBe("Chelsea");
    expect(pick.league).toBe("Premier League");
    expect(pick.kickoff).toBe("2026-01-01T15:00:00Z");
    expect(pick.market).toBe("Goals O/U");
    expect(pick.side).toBe("Over 2.5");
    expect(pick.odds).toBe(2.1);
    expect(pick.stakePct).toBe(2.5);
    expect(pick.confidence).toBe(0.71); // = candidate.mp, not a separately-tracked field
  });

  it("carries trapWarning, never shortfall, on a qualified pick", () => {
    const c = deliveryCandidate({ trapWarning: "thin venue sample (2 home games)" });
    const pick = deliveryCandidateToPick(c, "qualified", () => undefined);
    expect(pick.trapWarning).toBe("thin venue sample (2 home games)");
    expect(pick.shortfall).toBeUndefined();
    expect(pick.tier).toBe("qualified");
  });

  it("resolves eventId via the injected resolver, keyed on home/away", () => {
    const resolver = vi.fn().mockReturnValue("sr:match:123");
    const pick = deliveryCandidateToPick(deliveryCandidate(), "qualified", resolver);
    expect(resolver).toHaveBeenCalledWith("Arsenal", "Chelsea");
    expect(pick.eventId).toBe("sr:match:123");
  });

  it("omits eventId (not undefined-valued) when the resolver returns nothing — sidecar-unmapped fixture", () => {
    const pick = deliveryCandidateToPick(deliveryCandidate(), "qualified", () => undefined);
    expect("eventId" in pick).toBe(false);
  });
});

describe("deliveryCandidateToPick — Tier② (watchlist)", () => {
  it("carries shortfall, never trapWarning, on a watchlist row", () => {
    const c = deliveryCandidate({ shortfall: "class_edge", stakePct: 0 });
    const pick = deliveryCandidateToPick(c, "watchlist", () => undefined);
    expect(pick.shortfall).toBe("class_edge");
    expect(pick.trapWarning).toBeUndefined();
    expect(pick.tier).toBe("watchlist");
    expect(pick.stakePct).toBe(0);
  });
});

// [Phase 2, two-tier slate] Regression coverage for the fixtureId key-format
// bug /gstack-review's testing + maintainability specialists caught: a legacy
// pick for a fixture that ALREADY has a real Tier① candidate must never be
// duplicated into the watchlist as "unmapped". Uses the REAL makeFixtureId
// (not a hand-rolled string) so this test would have failed against the
// original buggy `${home}::${away}::${kickoff}` comparison.
describe("findUnmappedLegacyPicks", () => {
  function legacyPick(home: string, away: string, kickoff: string) {
    return {
      home,
      away,
      kickoff,
      market: "1X2",
      side: "Home",
      odds: 1.8,
      stakePct: 2,
      confidence: 0.6,
    };
  }

  it("excludes a legacy pick whose fixture already has a Tier① or Tier② candidate", () => {
    const mappedFixtureId = makeFixtureId("Arsenal", "Chelsea", "2026-01-01T15:00:00Z");
    const legacy = [legacyPick("Arsenal", "Chelsea", "2026-01-01T15:00:00Z")];
    const tiered = [{ fixtureId: mappedFixtureId }];
    expect(findUnmappedLegacyPicks(legacy, tiered)).toEqual([]);
  });

  it("keeps a legacy pick whose fixture has NO tier1/tier2 candidate at all", () => {
    const legacy = [legacyPick("Liverpool", "Everton", "2026-01-02T15:00:00Z")];
    const tiered = [{ fixtureId: makeFixtureId("Arsenal", "Chelsea", "2026-01-01T15:00:00Z") }];
    expect(findUnmappedLegacyPicks(legacy, tiered)).toEqual(legacy);
  });

  it("handles a mixed batch — some fixtures mapped, some not", () => {
    const mapped = legacyPick("Arsenal", "Chelsea", "2026-01-01T15:00:00Z");
    const unmapped = legacyPick("Liverpool", "Everton", "2026-01-02T15:00:00Z");
    const tiered = [{ fixtureId: makeFixtureId("Arsenal", "Chelsea", "2026-01-01T15:00:00Z") }];
    expect(findUnmappedLegacyPicks([mapped, unmapped], tiered)).toEqual([unmapped]);
  });

  it("keeps every legacy pick when no fixture is mapped (v3 entirely dry)", () => {
    const legacy = [
      legacyPick("Arsenal", "Chelsea", "2026-01-01T15:00:00Z"),
      legacyPick("Liverpool", "Everton", "2026-01-02T15:00:00Z"),
    ];
    expect(findUnmappedLegacyPicks(legacy, [])).toEqual(legacy);
  });

  it("excludes every legacy pick when v3 mapped every fixture (the healthy/normal case)", () => {
    const legacy = [
      legacyPick("Arsenal", "Chelsea", "2026-01-01T15:00:00Z"),
      legacyPick("Liverpool", "Everton", "2026-01-02T15:00:00Z"),
    ];
    const tiered = [
      { fixtureId: makeFixtureId("Arsenal", "Chelsea", "2026-01-01T15:00:00Z") },
      { fixtureId: makeFixtureId("Liverpool", "Everton", "2026-01-02T15:00:00Z") },
    ];
    expect(findUnmappedLegacyPicks(legacy, tiered)).toEqual([]);
  });
});
