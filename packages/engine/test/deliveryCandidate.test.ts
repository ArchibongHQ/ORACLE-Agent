/** [Phase 2, two-tier slate] V3DeliveryCandidate + compareDeliveryRows —
 *  the pattern-first tie-break unit tests. Two-tier ASSEMBLY (tier
 *  composition, fill-to-39, capped-behind-class_edge) lives in
 *  packages/runtime/test/slateOutputs.test.ts (buildTwoTierSlate, which
 *  consumes these primitives); this file is scoped to the primitives
 *  themselves. */

import { compareDeliveryRows, type V3DeliveryCandidate } from "@oracle/engine";
import { describe, expect, it } from "vitest";

function candidate(overrides: Partial<V3DeliveryCandidate> = {}): V3DeliveryCandidate {
  return {
    fixtureId: "f1",
    home: "Home",
    away: "Away",
    league: "League",
    kickoff: "2026-01-01T15:00:00Z",
    marketName: "Over/Under",
    desc: "Over 2.5",
    cls: "M",
    mp: 0.55,
    odds: 2.1,
    q: 0.5,
    rawEdge: 0.05,
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

describe("compareDeliveryRows — pattern-first tie-break (owner-directed 2026-07-18)", () => {
  it("sorts a pattern-backed candidate BEFORE a non-pattern candidate, even with a lower adjustedEdge", () => {
    const patternBacked = candidate({
      fixtureId: "f1",
      adjustedEdge: 0.05,
      patternStrength: 0.4,
    });
    const nonPattern = candidate({ fixtureId: "f2", adjustedEdge: 0.15 });
    const sorted = [nonPattern, patternBacked].sort(compareDeliveryRows);
    expect(sorted[0]?.fixtureId).toBe("f1");
    expect(sorted[1]?.fixtureId).toBe("f2");
  });

  it("among two pattern-backed candidates, higher patternStrength wins regardless of adjustedEdge", () => {
    const strong = candidate({ fixtureId: "f1", adjustedEdge: 0.05, patternStrength: 0.8 });
    const weak = candidate({ fixtureId: "f2", adjustedEdge: 0.2, patternStrength: 0.3 });
    const sorted = [weak, strong].sort(compareDeliveryRows);
    expect(sorted[0]?.fixtureId).toBe("f1");
  });

  it("among two pattern-backed candidates with EQUAL patternStrength, falls through to adjustedEdge", () => {
    const higherEdge = candidate({ fixtureId: "f1", adjustedEdge: 0.15, patternStrength: 0.5 });
    const lowerEdge = candidate({ fixtureId: "f2", adjustedEdge: 0.05, patternStrength: 0.5 });
    const sorted = [lowerEdge, higherEdge].sort(compareDeliveryRows);
    expect(sorted[0]?.fixtureId).toBe("f1");
  });

  it("among two non-pattern candidates, falls through to the existing §7 tie-break (adjustedEdge)", () => {
    const higherEdge = candidate({ fixtureId: "f1", adjustedEdge: 0.15 });
    const lowerEdge = candidate({ fixtureId: "f2", adjustedEdge: 0.05 });
    const sorted = [lowerEdge, higherEdge].sort(compareDeliveryRows);
    expect(sorted[0]?.fixtureId).toBe("f1");
  });

  it("treats patternStrength: 0 as NOT pattern-backed — distinguishes explicit-zero from absent", () => {
    const zeroStrength = candidate({ fixtureId: "f1", adjustedEdge: 0.05, patternStrength: 0 });
    const noPatternField = candidate({ fixtureId: "f2", adjustedEdge: 0.15 });
    const sorted = [zeroStrength, noPatternField].sort(compareDeliveryRows);
    // Neither is pattern-backed (0 > 0 is false) — falls through to adjustedEdge,
    // so f2 (0.15) wins, NOT f1 (which would win if 0 were treated as "backed").
    expect(sorted[0]?.fixtureId).toBe("f2");
  });

  it("EV/edge machinery is a guide, never an override of a pattern-backed pick — a strongly-edged non-pattern candidate never outranks a weakly-patterned one", () => {
    const weakPattern = candidate({ fixtureId: "f1", adjustedEdge: 0.02, patternStrength: 0.05 });
    const hugeEdgeNoPattern = candidate({ fixtureId: "f2", adjustedEdge: 0.5 });
    const sorted = [hugeEdgeNoPattern, weakPattern].sort(compareDeliveryRows);
    expect(sorted[0]?.fixtureId).toBe("f1");
  });
});
