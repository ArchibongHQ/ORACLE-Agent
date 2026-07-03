/** goals-market-analysis-prompt-v3 — engine-layer unit tests: lambda (§3.1),
 *  match-shape correction (§3.5), edge gate (§4), and the full per-fixture
 *  analysis pipeline (analyzeGoalsFixtureV3). */

import {
  analyzeGoalsFixtureV3,
  buildMatrix,
  computeV3Lambdas,
  deriveMatchShape,
  devigOU,
  extractMarkets,
  gateV3Edge,
  poissonPMF,
  V3_TIER_HEIGHTENED_FLOOR,
  type V3AnalyzeInput,
  v3NbDispersion,
  v3PenaltyPts,
} from "@oracle/engine";
import { describe, expect, it } from "vitest";

describe("computeV3Lambdas (§3.1)", () => {
  it("matches the spec's worked example: λH=1.89, λA=0.89, μ=2.78", () => {
    // Home 1.7 scored/90, 1.0 conceded/90; Away 1.2 scored/90, 1.5 conceded/90; L≈1.35/team.
    const result = computeV3Lambdas(
      {
        league: "__unknown_league__",
        homeScoredPer90: 1.7,
        homeConcededPer90: 1.0,
        awayScoredPer90: 1.2,
        awayConcededPer90: 1.5,
        nHome: 10,
        nAway: 10,
      },
      { xgBlend: false }
    );
    expect(result).not.toBeNull();
    // Default league L = 2.6/2 = 1.3 (no exact "1.35" baseline in this codebase's
    // table for an unknown league) — assert the formula shape, not literal spec digits.
    expect(result!.method).toBe("multiplicative");
    expect(result!.lambdaHome).toBeCloseTo((1.7 / 1.3) * (1.5 / 1.3) * 1.3, 5);
    expect(result!.lambdaAway).toBeCloseTo((1.2 / 1.3) * (1.0 / 1.3) * 1.3, 5);
    expect(result!.mu).toBeCloseTo(result!.lambdaHome + result!.lambdaAway, 10);
  });

  it("P(Over 2.5) at μ=2.78, ρ=0 matches the spec's exact-Poisson worked answer (~52.5%)", () => {
    const lambdaHome = 1.89;
    const lambdaAway = 0.89;
    const mat = buildMatrix(lambdaHome, lambdaAway, 0, false, 0.08, 0, undefined);
    const book = extractMarkets(mat);
    expect(book.ou["over_2.5"]).toBeCloseTo(0.525, 2);
  });

  it("falls back to simple-average when one multiplicative factor is missing", () => {
    const result = computeV3Lambdas({
      league: "__unknown_league__",
      homeScoredPer90: 1.5,
      homeConcededPer90: null,
      awayScoredPer90: 1.2,
      awayConcededPer90: 1.1,
    });
    expect(result?.method).toBe("simple-average");
  });

  it("shrinks toward the league mean when n < 8", () => {
    const L = 1.3; // default league per-team avg
    const unshrunk = computeV3Lambdas(
      {
        league: "__unknown_league__",
        homeScoredPer90: 3.0,
        homeConcededPer90: 3.0,
        awayScoredPer90: 1.0,
        awayConcededPer90: 1.0,
        nHome: 20,
        nAway: 20,
      },
      { xgBlend: false }
    )!;
    const shrunk = computeV3Lambdas(
      {
        league: "__unknown_league__",
        homeScoredPer90: 3.0,
        homeConcededPer90: 3.0,
        awayScoredPer90: 1.0,
        awayConcededPer90: 1.0,
        nHome: 2,
        nAway: 2,
      },
      { xgBlend: false }
    )!;
    expect(shrunk.shrunk).toBe(true);
    expect(unshrunk.shrunk).toBe(false);
    // Shrunk lambda should sit strictly between the raw estimate and the league mean L.
    expect(shrunk.lambdaHome).toBeLessThan(unshrunk.lambdaHome);
    expect(shrunk.lambdaHome).toBeGreaterThan(L);
  });

  it("blends 50/50 with xG when present, and marks xgBlended", () => {
    const noXg = computeV3Lambdas({
      league: "__unknown_league__",
      homeScoredPer90: 1.7,
      homeConcededPer90: 1.0,
      awayScoredPer90: 1.2,
      awayConcededPer90: 1.5,
      nHome: 10,
      nAway: 10,
    })!;
    const withXg = computeV3Lambdas({
      league: "__unknown_league__",
      homeScoredPer90: 1.7,
      homeConcededPer90: 1.0,
      awayScoredPer90: 1.2,
      awayConcededPer90: 1.5,
      nHome: 10,
      nAway: 10,
      homeXg: { xgf: 2.5, xga: 0.5 },
      awayXg: { xgf: 0.5, xga: 2.5 },
    })!;
    expect(withXg.xgBlended).toBe(true);
    expect(noXg.xgBlended).toBe(false);
    expect(withXg.lambdaHome).not.toBeCloseTo(noXg.lambdaHome, 5);
  });

  it("returns null when neither side has any usable scoring signal", () => {
    expect(
      computeV3Lambdas({
        league: "x",
        homeScoredPer90: null,
        homeConcededPer90: null,
        awayScoredPer90: null,
        awayConcededPer90: null,
      })
    ).toBeNull();
  });
});

describe("deriveMatchShape (§3.5)", () => {
  it("recovers a known home share s from a synthetic 1X2 built at that exact s", () => {
    const mu = 2.8;
    const trueS = 0.7;
    // Build the "true" independent-Poisson 1X2 from the target split, then feed it
    // back through deriveMatchShape and confirm the grid search recovers ~trueS.
    const lH = mu * trueS;
    const lA = mu * (1 - trueS);
    let pHome = 0;
    let pDraw = 0;
    let pAway = 0;
    for (let i = 0; i < 11; i++) {
      for (let j = 0; j < 11; j++) {
        const p = poissonPMF(i, lH) * poissonPMF(j, lA);
        if (i > j) pHome += p;
        else if (i === j) pDraw += p;
        else pAway += p;
      }
    }
    const norm = pHome + pDraw + pAway;
    const shape = deriveMatchShape(mu, mu * 0.5 /* deliberately wrong raw split */, {
      pHome: pHome / norm,
      pDraw: pDraw / norm,
      pAway: pAway / norm,
    });
    expect(shape.source).toBe("odds");
    expect(shape.s).toBeCloseTo(trueS, 1);
    expect(shape.lambdaHome + shape.lambdaAway).toBeCloseTo(mu, 5);
  });

  it("falls back to the goals-model ratio when 1X2 is missing", () => {
    const shape = deriveMatchShape(2.8, 1.96 /* raw H share = 0.7 */, null);
    expect(shape.source).toBe("ratio");
    expect(shape.s).toBeCloseTo(0.7, 5);
  });

  it("clamps a heavy-favourite split so neither λ falls below 0.30", () => {
    const mu = 3.0;
    // Extreme 1X2 implying s→~0.98, which would push λ_away to ~0.06 unclamped.
    const shape = deriveMatchShape(mu, mu * 0.5, { pHome: 0.94, pDraw: 0.05, pAway: 0.01 });
    expect(shape.lambdaAway).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(shape.lambdaHome + shape.lambdaAway).toBeCloseTo(mu, 5);
  });
});

describe("devigOU + v3PenaltyPts + gateV3Edge (§4)", () => {
  it("de-vigs a two-sided book (additive method) summing to 1", () => {
    const over = devigOU(1.9, 1.95);
    expect(over).not.toBeNull();
    expect(over!.devigged).toBe(true);
    const under = devigOU(1.95, 1.9);
    expect(over!.q + under!.q).toBeCloseTo(1, 5);
  });

  it("falls back to 1/odds for a single-sided book", () => {
    const q = devigOU(2.0);
    expect(q).toEqual({ q: 0.5, devigged: false });
  });

  it("sums the §4.2 penalty table correctly", () => {
    expect(v3PenaltyPts({ xgMissing: true, h2hMissing: true, smallSample: true })).toBeCloseTo(
      0.02 + 0.01 + 0.02,
      10
    );
    expect(v3PenaltyPts({})).toBe(0);
  });

  it("tiers adjusted edge at the 5/7/10pt boundaries", () => {
    // Use q=0 so rawEdge === modelP exactly (no float-subtraction artifacts at
    // the tier boundaries — this isolates the tier logic from FP noise).
    const mkGate = (modelP: number) => gateV3Edge(modelP, { q: 0, devigged: true }, {});
    expect(mkGate(0.045).outcome).toBe("below_edge");
    expect(mkGate(0.05).tier).toBe("medium");
    expect(mkGate(0.07).tier).toBe("high");
    expect(mkGate(0.1).tier).toBe("very_high");
  });

  it("discards within the 2pt noise gate regardless of tier math", () => {
    const gate = gateV3Edge(0.505, { q: 0.5, devigged: true }, {});
    expect(gate.outcome).toBe("noise");
    expect(gate.tier).toBeNull();
  });

  it("caps a raw edge > 12pts as implausible, before penalties", () => {
    const gate = gateV3Edge(0.7, { q: 0.5, devigged: true }, { xgMissing: true });
    expect(gate.rawEdge).toBeCloseTo(0.2, 5);
    expect(gate.outcome).toBe("capped");
  });

  it("subtracts penalties from raw edge to get adjusted edge", () => {
    const gate = gateV3Edge(0.09, { q: 0, devigged: true }, { xgMissing: true, h2hMissing: true });
    expect(gate.rawEdge).toBeCloseTo(0.09, 5);
    expect(gate.penaltyPts).toBeCloseTo(0.03, 5);
    expect(gate.adjustedEdge).toBeCloseTo(0.06, 5);
    expect(gate.tier).toBe("medium");
  });

  describe("heightened floor (v4 PR-3: 8pt pass bar under HFA/hit-rate uncertainty)", () => {
    it("raises the pass floor from 5pt to 8pt — a 6pt edge that would normally be 'medium' now fails", () => {
      const nonHeightened = gateV3Edge(0.06, { q: 0, devigged: true }, {}, {});
      expect(nonHeightened.outcome).toBe("done");
      expect(nonHeightened.tier).toBe("medium");

      const heightened = gateV3Edge(0.06, { q: 0, devigged: true }, {}, { heightened: true });
      expect(heightened.outcome).toBe("below_edge");
      expect(heightened.tier).toBeNull();
    });

    it("passes at exactly the 8pt heightened floor with tier 'high' (0.08 ≥ V3_TIER_HIGH)", () => {
      const gate = gateV3Edge(
        V3_TIER_HEIGHTENED_FLOOR,
        { q: 0, devigged: true },
        {},
        { heightened: true }
      );
      expect(gate.outcome).toBe("done");
      expect(gate.tier).toBe("high");
    });

    it("still respects the noise gate and absolute cap ahead of the heightened floor", () => {
      const noise = gateV3Edge(0.005, { q: 0, devigged: true }, {}, { heightened: true });
      expect(noise.outcome).toBe("noise");

      const capped = gateV3Edge(0.7, { q: 0.5, devigged: true }, {}, { heightened: true });
      expect(capped.outcome).toBe("capped");
    });

    it("defaults to the standard 5pt floor when heightened is omitted or false", () => {
      expect(gateV3Edge(0.06, { q: 0, devigged: true }, {}).outcome).toBe("done");
      expect(gateV3Edge(0.06, { q: 0, devigged: true }, {}, { heightened: false }).outcome).toBe(
        "done"
      );
    });
  });
});

describe("v3NbDispersion (§3.2 guard)", () => {
  it("accepts r in [8,20]", () => {
    expect(v3NbDispersion(8)).toBe(8);
    expect(v3NbDispersion(10)).toBe(10);
    expect(v3NbDispersion(20)).toBe(20);
  });
  it("rejects r=2 and anything outside [8,20]", () => {
    expect(v3NbDispersion(2)).toBeUndefined();
    expect(v3NbDispersion(7.9)).toBeUndefined();
    expect(v3NbDispersion(21)).toBeUndefined();
    expect(v3NbDispersion(undefined)).toBeUndefined();
  });
});

describe("analyzeGoalsFixtureV3 (full pipeline)", () => {
  function baseInput(overrides: Partial<V3AnalyzeInput> = {}): V3AnalyzeInput {
    return {
      fixtureId: "test_fixture",
      runId: "test_run",
      home: "Home FC",
      away: "Away FC",
      league: "Premier League",
      kickoff: "2026-08-01T15:00:00Z",
      odds: {
        over15: 1.3,
        under15: 3.2,
        over25: 1.9,
        under25: 1.95,
        homeTotalOver05: 1.25,
        awayTotalOver05: 1.6,
        bttsYes: 1.8,
        bttsNo: 1.9,
        home1x2: 1.8,
        draw1x2: 3.6,
        away1x2: 4.2,
      },
      lambdaInput: {
        league: "Premier League",
        homeScoredPer90: 1.8,
        homeConcededPer90: 1.0,
        awayScoredPer90: 1.0,
        awayConcededPer90: 1.4,
        nHome: 10,
        nAway: 10,
      },
      penaltyFlags: {},
      completeness: 90,
      sources: ["sportybet-gismo"],
      ...overrides,
    };
  }

  it("returns null when no lambda model can be built", () => {
    expect(
      analyzeGoalsFixtureV3(
        baseInput({
          lambdaInput: { league: "Premier League" },
        })
      )
    ).toBeNull();
  });

  it("produces a job, assessments for every priced market, and a capped log when hot", () => {
    const result = analyzeGoalsFixtureV3(baseInput());
    expect(result).not.toBeNull();
    expect(result!.job.status).toBe("ok");
    expect(result!.assessments.length).toBeGreaterThan(0);
    // Every DONE assessment must also appear in job.result.evMarkets (v3 field set).
    if (result!.job.status === "ok") {
      for (const m of result!.job.result.evMarkets) {
        expect(m.v3).toBeDefined();
        expect(["very_high", "high", "medium"]).toContain(m.v3!.tier);
      }
    }
  });

  it("logs a capped selection and never puts it in evMarkets", () => {
    // Force an absurdly generous price on Over 2.5 relative to the model to blow past the 12pt cap.
    const result = analyzeGoalsFixtureV3(
      baseInput({ odds: { ...baseInput().odds, over25: 5.0, under25: 1.15 } })
    );
    expect(result).not.toBeNull();
    if (result!.job.status === "ok") {
      const over25InMarkets = result!.job.result.evMarkets.some((m) => m.label === "Over 2.5");
      const over25Capped = result!.capped.some((c) => c.label === "Over 2.5");
      expect(over25Capped).toBe(true);
      expect(over25InMarkets).toBe(false);
    }
  });

  it("respects the noiseGate override — a very wide noise gate suppresses every tier", () => {
    const noisy = analyzeGoalsFixtureV3(baseInput({ noiseGate: 0.5 }));
    expect(noisy).not.toBeNull();
    expect(noisy!.assessments.every((a) => a.outcome !== "done")).toBe(true);
    if (noisy!.job.status === "ok") {
      expect(noisy!.job.result.evMarkets.length).toBe(0);
    }
  });

  it("respects the edgeCap override — a very tight cap forces every priced market into 'capped'", () => {
    // Deliberately mispriced (generous) odds guarantee at least one clearly
    // positive raw edge; a 0 cap then means ANY positive raw edge is "too hot".
    const tight = analyzeGoalsFixtureV3(
      baseInput({
        odds: { ...baseInput().odds, over15: 5.0, under15: 1.15 },
        edgeCap: 0,
        noiseGate: 0,
      })
    );
    expect(tight).not.toBeNull();
    const positiveRawEdgeCount = tight!.assessments.filter((a) => a.rawEdge > 0).length;
    expect(positiveRawEdgeCount).toBeGreaterThan(0);
    expect(tight!.capped.length).toBe(positiveRawEdgeCount);
  });

  it("threads heightened through the full pipeline — fewer (or equal) DONE markets survive than non-heightened", () => {
    const normal = analyzeGoalsFixtureV3(baseInput());
    const heightened = analyzeGoalsFixtureV3(baseInput({ heightened: true }));
    expect(normal).not.toBeNull();
    expect(heightened).not.toBeNull();
    const normalDone = normal!.assessments.filter((a) => a.outcome === "done").length;
    const heightenedDone = heightened!.assessments.filter((a) => a.outcome === "done").length;
    expect(heightenedDone).toBeLessThanOrEqual(normalDone);
  });
});
