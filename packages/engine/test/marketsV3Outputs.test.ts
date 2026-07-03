/** all-markets-analysis-prompt-v3 Phase 7/8 — slate-level output tests. */

import {
  BEST_SINGLES_MAX,
  buildGateSurvivingPool,
  buildOutputA,
  buildOutputB,
  buildOutputC,
  buildOutputD,
  computeClassMix,
  formatChunkStatus,
  formatFinalSummary,
  MINI_ACCA_HAIRCUT,
  MINI_ACCA_MAX_LEGS,
  MINI_ACCA_MIN_LEGS,
  OUTPUT_A_MAX,
  type V3MarketOutcomeAssessment,
  type V3SlateFixture,
} from "@oracle/engine";
import { describe, expect, it } from "vitest";

function assessment(overrides: Partial<V3MarketOutcomeAssessment> = {}): V3MarketOutcomeAssessment {
  return {
    q: 0.5,
    devigged: true,
    rawEdge: 0.08,
    penaltyPts: 0,
    adjustedEdge: 0.08,
    adjEvPct: 0.16,
    cls: "M",
    outcome: "done",
    confidence: "high",
    family: "goals_ou",
    marketId: "18",
    marketName: "Over/Under",
    outcomeId: "1",
    desc: "Over 2.5",
    odds: 2.1,
    mp: 0.55,
    ...overrides,
  };
}

function fixture(
  i: number,
  overrides: Partial<V3SlateFixture> & { best?: V3MarketOutcomeAssessment | null } = {}
): V3SlateFixture {
  return {
    fixtureId: `f${i}`,
    home: `Home${i}`,
    away: `Away${i}`,
    league: `League${i % 3}`,
    kickoff: new Date(2026, 0, 1, i).toISOString(),
    best: assessment(),
    ...overrides,
  };
}

describe("buildGateSurvivingPool", () => {
  it("drops fixtures with no surviving pick and sorts by adjustedEdge descending", () => {
    const fixtures: V3SlateFixture[] = [
      fixture(1, { best: assessment({ adjustedEdge: 0.05 }) }),
      fixture(2, { best: null }),
      fixture(3, { best: assessment({ adjustedEdge: 0.12 }) }),
    ];
    const pool = buildGateSurvivingPool(fixtures);
    expect(pool).toHaveLength(2);
    expect(pool[0]?.fixtureId).toBe("f3");
    expect(pool[1]?.fixtureId).toBe("f1");
  });

  it("tie-breaks equal adjustedEdge by class (S beats M), then model P, then earlier kickoff", () => {
    const base = { adjustedEdge: 0.08 };
    const fixtures: V3SlateFixture[] = [
      fixture(1, {
        kickoff: "2026-06-01T10:00:00Z",
        best: assessment({ ...base, cls: "M", mp: 0.5 }),
      }),
      fixture(2, {
        kickoff: "2026-06-01T08:00:00Z",
        best: assessment({ ...base, cls: "S", mp: 0.5 }),
      }),
      fixture(3, {
        kickoff: "2026-06-01T06:00:00Z",
        best: assessment({ ...base, cls: "S", mp: 0.6 }),
      }),
    ];
    const pool = buildGateSurvivingPool(fixtures);
    // f3 (S, mp 0.6) > f2 (S, mp 0.5) > f1 (M) — class beats kickoff, mp beats kickoff within same class.
    expect(pool.map((r) => r.fixtureId)).toEqual(["f3", "f2", "f1"]);
  });
});

describe("buildOutputA", () => {
  it("caps at 39 rows even when the pool is larger", () => {
    const fixtures = Array.from({ length: 50 }, (_, i) => fixture(i));
    const pool = buildGateSurvivingPool(fixtures);
    const outputA = buildOutputA(pool);
    expect(outputA).toHaveLength(OUTPUT_A_MAX);
  });

  it("returns fewer than 39 rows when fewer fixtures qualify — never padded", () => {
    const fixtures = [fixture(1), fixture(2, { best: null }), fixture(3)];
    const pool = buildGateSurvivingPool(fixtures);
    expect(buildOutputA(pool)).toHaveLength(2);
  });
});

describe("buildOutputB", () => {
  it("prefers Class S/M legs across different leagues, applies the 0.85 haircut", () => {
    const fixtures: V3SlateFixture[] = [
      fixture(1, { league: "A", best: assessment({ cls: "S", mp: 0.7, adjustedEdge: 0.1 }) }),
      fixture(2, { league: "B", best: assessment({ cls: "M", mp: 0.6, adjustedEdge: 0.09 }) }),
      fixture(3, { league: "C", best: assessment({ cls: "S", mp: 0.65, adjustedEdge: 0.08 }) }),
      fixture(4, { league: "D", best: assessment({ cls: "L", mp: 0.4, adjustedEdge: 0.07 }) }),
    ];
    const pool = buildGateSurvivingPool(fixtures);
    const outputA = buildOutputA(pool);
    const { miniAcca, miniAccaCombinedP, bestSingles } = buildOutputB(outputA);

    expect(miniAcca.length).toBeGreaterThanOrEqual(MINI_ACCA_MIN_LEGS);
    expect(miniAcca.length).toBeLessThanOrEqual(MINI_ACCA_MAX_LEGS);
    expect(miniAcca.every((r) => r.cls === "S" || r.cls === "M")).toBe(true); // Class L excluded while S/M cover the minimum
    const rawProduct = miniAcca.reduce((p, r) => p * r.mp, 1);
    expect(miniAccaCombinedP).toBeCloseTo(rawProduct * MINI_ACCA_HAIRCUT, 6);
    expect(bestSingles.length).toBeLessThanOrEqual(BEST_SINGLES_MAX);
    expect(bestSingles[0]?.fixtureId).toBe(outputA[0]?.fixtureId);
  });

  it("backfills below the S/M minimum from the wider pool rather than returning an empty mini-ACCA", () => {
    const fixtures: V3SlateFixture[] = [fixture(1, { best: assessment({ cls: "L" }) })];
    const outputA = buildOutputA(buildGateSurvivingPool(fixtures));
    const { miniAcca } = buildOutputB(outputA);
    expect(miniAcca).toHaveLength(0); // only 1 candidate total, below MINI_ACCA_MIN_LEGS(2) even after backfill
  });

  it("returns an empty mini-ACCA (not a padded one) when fewer than the minimum legs are available", () => {
    const outputA = buildOutputA(buildGateSurvivingPool([]));
    const { miniAcca, miniAccaCombinedP } = buildOutputB(outputA);
    expect(miniAcca).toEqual([]);
    expect(miniAccaCombinedP).toBe(0);
  });
});

describe("buildOutputC / buildOutputD", () => {
  it("splits the pool by the 4.00 odds boundary, ranked by adjustedEdge", () => {
    const fixtures: V3SlateFixture[] = [
      fixture(1, { best: assessment({ odds: 5.0, adjustedEdge: 0.06 }) }),
      fixture(2, { best: assessment({ odds: 3.0, adjustedEdge: 0.09 }) }),
      fixture(3, { best: assessment({ odds: 4.5, adjustedEdge: 0.1 }) }),
      fixture(4, { best: assessment({ odds: 1.8, adjustedEdge: 0.05 }) }), // below Output D floor
    ];
    const pool = buildGateSurvivingPool(fixtures);
    const outputC = buildOutputC(pool);
    const outputD = buildOutputD(pool);

    expect(outputC.map((r) => r.fixtureId)).toEqual(["f3", "f1"]); // both ≥4.00, f3 higher edge first
    expect(outputD.map((r) => r.fixtureId)).toEqual(["f2"]); // 2.50–3.99 only
  });

  it("may be empty when nothing in the pool matches the odds band", () => {
    const fixtures: V3SlateFixture[] = [fixture(1, { best: assessment({ odds: 1.5 }) })];
    const pool = buildGateSurvivingPool(fixtures);
    expect(buildOutputC(pool)).toEqual([]);
    expect(buildOutputD(pool)).toEqual([]);
  });

  it("caps Output C at 5 and Output D at 3", () => {
    const cFixtures = Array.from({ length: 8 }, (_, i) =>
      fixture(i, { best: assessment({ odds: 4.5, adjustedEdge: 0.1 - i * 0.001 }) })
    );
    const dFixtures = Array.from({ length: 6 }, (_, i) =>
      fixture(i + 10, { best: assessment({ odds: 3.0, adjustedEdge: 0.1 - i * 0.001 }) })
    );
    const pool = buildGateSurvivingPool([...cFixtures, ...dFixtures]);
    expect(buildOutputC(pool)).toHaveLength(5);
    expect(buildOutputD(pool)).toHaveLength(3);
  });
});

describe("computeClassMix", () => {
  it("tallies each class across the pool", () => {
    const fixtures: V3SlateFixture[] = [
      fixture(1, { best: assessment({ cls: "S" }) }),
      fixture(2, { best: assessment({ cls: "S" }) }),
      fixture(3, { best: assessment({ cls: "M" }) }),
      fixture(4, { best: assessment({ cls: "X" }) }),
    ];
    const pool = buildGateSurvivingPool(fixtures);
    expect(computeClassMix(pool)).toEqual({ S: 2, M: 1, L: 0, X: 1 });
  });
});

describe("formatChunkStatus (§8)", () => {
  it("matches the spec's exact format", () => {
    expect(
      formatChunkStatus({ chunkIndex: 3, done: 7, discard: 2, insufficient: 1, remaining: 12 })
    ).toBe("Chunk [3]: Done 7 | Discard 2 | Insufficient 1 | Remaining 12");
  });
});

describe("formatFinalSummary (§8)", () => {
  it("states a no-bet slate plainly rather than implying failure", () => {
    const summary = formatFinalSummary({
      totalFixtures: 40,
      qualifyingCount: 0,
      classMix: { S: 0, M: 0, L: 0, X: 0 },
      highestEdgePick: null,
      cappedCount: 0,
      dormantModules: ["corners: no stats in feed"],
      dataQualityNote: "sparse gismo coverage this slate",
    });
    expect(summary).toContain("Qualifying: 0 (no-bet slate — a valid outcome, not a failure)");
    expect(summary).toContain("Highest edge: none");
    expect(summary).toContain("probability estimates, not predictions");
  });

  it("renders the highest-edge pick and class mix when the slate qualifies", () => {
    const pick = {
      fixtureId: "f1",
      home: "Home",
      away: "Away",
      league: "Premier League",
      kickoff: new Date().toISOString(),
      marketName: "Over/Under",
      desc: "Over 2.5",
      cls: "M" as const,
      mp: 0.6,
      odds: 2.0,
      q: 0.5,
      rawEdge: 0.1,
      penaltyPts: 0,
      adjustedEdge: 0.1,
      adjEvPct: 0.2,
      confidence: "high" as const,
    };
    const summary = formatFinalSummary({
      totalFixtures: 20,
      qualifyingCount: 5,
      classMix: { S: 2, M: 2, L: 1, X: 0 },
      highestEdgePick: pick,
      cappedCount: 1,
      dormantModules: [],
      dataQualityNote: "good coverage",
    });
    expect(summary).toContain("Home vs Away — Over 2.5 (10.0pts, class M)");
    expect(summary).toContain("Class mix — S:2 M:2 L:1 X:0");
    expect(summary).toContain("Dormant modules: none");
    expect(summary).toContain("Capped selections (logged, never bet): 1");
  });
});
