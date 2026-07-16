/** [patterns-engine Wave 2] Integration coverage for analyzeFixtureMarkets.ts's
 *  wiring of the deterministic pattern detector (marketsV3/patterns.ts) into
 *  the per-fixture gate: computing the fixture PatternReport once, deriving
 *  per-outcome `patternBacked`, threading it into evGate.ts's gateAllMarkets
 *  (patternMode/patternBacked/patternStrength opts → patternRelaxed/
 *  patternRelaxedBar output), and the rankingScore boost at the evMarkets
 *  push site. PATTERN_MIN_STRENGTH/PATTERN_RANK_BONUS aren't on the
 *  @oracle/engine barrel yet — same pre-existing gap blendGate.test.ts
 *  documents for the sibling V3_BLEND_* constants — imported directly from
 *  the source module below.
 *
 *  Fixture derivation (goal-machine scenario, shared by cases (b)/(c)):
 *  venue-split goals homeScoredHome = awayScoredAway = 3.9,
 *  homeConcededHome = awayConcededAway = 0.5 give patterns.ts's own additive
 *  expTotal = (3.9+0.5)+(3.9+0.5) all /2 = 4.4 — past detectGoalMachine's
 *  gmExpTotalFull (3.6) saturation point, so topPattern.score clamps to
 *  exactly 1.0. The SAME four numbers, run through computeV3Lambdas'
 *  MULTIPLICATIVE λ formula against the "__unknown_league__" fallback
 *  per-team average L=1.3 ((1.45+1.15)/2, execution/index.ts's
 *  LEAGUE_PARAMS.Default), give λH=λA=(3.9*0.5)/1.3=1.5 exactly ⇒ mu=3.0 — a
 *  round number whose Poisson(3) upper tail is a standard, independently
 *  verifiable value: P(X<=2) = e^-3(1+3+4.5) = 0.4231901, so
 *  P(Over 2.5) = 0.5768099. dynamicRho:0 forces rho=0 (buildMatrix's
 *  dixonColesTau returns 1.0 whenever rho===0 — pure independent-Poisson
 *  grid, no Dixon-Coles adjustment, and mu=3.0 keeps the zip-boost condition
 *  (totalXG<1.5) false regardless), and nHome/nAway=10 (>= goalsV3/lambda.ts's
 *  SHRINK_N=8) keeps the small-sample λ shrink a no-op. totalsEmpirical:false
 *  keeps the Over/Under pricer model-only (its default-on empirical blend
 *  would otherwise mix in ou25PctH/A and perturb this hand-derived value).
 *
 *  With every priority-context lever left at its "off" default (no homeOdds/
 *  leagueAvgGoals/streak/h2h data supplied — none of those are threaded from
 *  V3AllMarketsInput yet, a later wave's scope) and no second pattern
 *  agreeing (heavy_superior/corner_kings/anomaly all null for this
 *  matchup — verified by hand below), detectPatterns' own strength formula
 *  (0.7*topScore + 0.3*priority) shrunk by sampleShrink(10,10)=1.0
 *  (empirical.nH/nA=10 >= patterns.ts's fullTrustN=8) comes out to EXACTLY
 *  0.7*1.0 + 0.3*0 = 0.7 — comfortably clear of PATTERN_MIN_STRENGTH (0.3).
 *
 *  Numeric assertions below prefer comparing the CODE's own reported fields
 *  to each other (e.g. evMarket.rankingScore vs assessment.adjustedEdge +
 *  PATTERN_RANK_BONUS * assessment.patternStrength) over asserting absolute
 *  hand-derived numbers, so a small residual in the manual derivation above
 *  can't produce a false pass/fail on the boost arithmetic itself; the
 *  hand-derived values are only load-bearing for the categorical claims
 *  (this candidate fails the standard bar but clears the relaxed one), which
 *  the comments above compute with a >=45%-of-window safety margin. */

import {
  type AllMarketEntry,
  analyzeFixtureMarketsV3,
  CLASS_GATE_BLEND,
  type V3AllMarketsInput,
} from "@oracle/engine";
import { describe, expect, it } from "vitest";
import { PATTERN_MIN_STRENGTH, PATTERN_RANK_BONUS } from "../src/marketsV3/evGate.js";

// Over 2.5 @ 1.80 / Under 2.5 @ 2.16 — additive devig (markets/devig.ts) gives
// q_over = (1/1.80 - 1/2.16 + 1)/2 ≈ 0.546296 (a ~1.85% overround, positive —
// see file header for the modelP derivation). rawEdge ≈ 0.030514: comfortably
// clear of the noiseGate (0.02), nowhere near the absolute (0.12) cap, and
// odds well under the RELATIVE_CAP_ODDS_FLOOR (3.0) so the relative cap is
// never even evaluated.
const TOTALS_MARKET: AllMarketEntry = {
  id: "18",
  name: "Over/Under",
  specifier: "total=2.5",
  outcomes: [
    { id: "1", desc: "Over 2.5", odds: "1.80" },
    { id: "2", desc: "Under 2.5", odds: "2.16" },
  ],
};

// A second, unrelated family (btts, not goals_ou) that clears the STANDARD
// CLASS_GATE_BLEND.M bar on its own (no pattern relaxation needed) — used as
// a family-mismatch "control" candidate for case (c) and to give the off-path
// evMarkets array at least one entry to check the rankingScore invariant on.
const BTTS_MARKET: AllMarketEntry = {
  id: "29",
  name: "GG/NG",
  outcomes: [
    { id: "1", desc: "Yes", odds: "1.90" },
    { id: "2", desc: "No", odds: "2.05" },
  ],
};

function goalMachineInput(v3Patterns?: "off" | "shadow" | "on"): V3AllMarketsInput {
  return {
    fixtureId: "f-pattern",
    runId: "r-pattern",
    home: "Home FC",
    away: "Away FC",
    league: "__unknown_league__",
    kickoff: new Date().toISOString(),
    lambdaInput: {
      league: "__unknown_league__",
      // homeScoredHome / homeConcededHome / awayScoredAway / awayConcededAway
      // in patterns.ts's PatternInput terms — see file header for both the
      // detector-strength and the λ derivations off these same four numbers.
      homeScoredPer90: 3.9,
      homeConcededPer90: 0.5,
      awayScoredPer90: 3.9,
      awayConcededPer90: 0.5,
      nHome: 10,
      nAway: 10,
    },
    devigged1x2: null, // deriveMatchShape falls back to the goals-model split (source "ratio") — shapeGrid == statsGrid
    allMarkets: [TOTALS_MARKET, BTTS_MARKET],
    penaltyFlags: {},
    dynamicRho: 0, // forces rho=0 — see file header
    empirical: {
      // Present (any value) only to avoid the marketStatMissing penalty on
      // the Over/Under and BTTS outcomes below — ou25PctH/A's VALUES don't
      // matter here since totalsEmpirical:false keeps totals model-only.
      ou25PctH: 0.65,
      ou25PctA: 0.6,
      bttsPctH: 0.55,
      bttsPctA: 0.5,
      nH: 10,
      nA: 10,
    },
    totalsEmpirical: false,
    // wModel ceiling (0.40 = 0.15 floor + 0.15*completeness(1) + 0.10*hasRealXg(true)).
    completeness: 1,
    hasRealXg: true,
    blendPricing: true,
    v3Patterns,
  };
}

type Result = NonNullable<ReturnType<typeof analyzeFixtureMarketsV3>>;

function findAssessment(result: Result, desc: string) {
  const a = result.assessments.find((x) => x.desc === desc);
  if (!a) throw new Error(`no assessment for desc ${desc}`);
  return a;
}
function findEvMarket(result: Result, side: string) {
  return result.evMarkets.find((m) => m.side === side);
}

describe("analyzeFixtureMarketsV3 — pattern-engine wiring (Wave 2)", () => {
  it("(a) off/undefined is byte-identical to the pre-Wave-2 pipeline: no pattern fields, rankingScore == adjustedEdge, and the pattern-eligible candidate stays below_gate", () => {
    const implicitOff = analyzeFixtureMarketsV3(goalMachineInput(undefined));
    const explicitOff = analyzeFixtureMarketsV3(goalMachineInput("off"));
    expect(implicitOff).not.toBeNull();
    expect(implicitOff).toEqual(explicitOff);

    const result = implicitOff!;
    const over = findAssessment(result, "Over 2.5");
    expect(over.patternBacked).toBeUndefined();
    expect(over.patternStrength).toBeUndefined();
    expect(over.patternRelaxed).toBeUndefined();
    expect(over.patternRelaxedBar).toBeUndefined();
    // Standard CLASS_GATE_BLEND.M class_edge bar (0.015) is not cleared by
    // this candidate's adjustedEdgeBlend (~0.0122) without the relaxation —
    // see file header for the derivation and safety margin.
    expect(over.adjustedEdge).toBeLessThan(CLASS_GATE_BLEND.M.minAdjEdgeBlend);
    expect(over.outcome).toBe("below_gate");
    expect(over.gateReason).toBe("class_edge");
    expect(findEvMarket(result, "Over 2.5")).toBeUndefined();

    // The BTTS "Yes" control candidate clears the standard bar on its own
    // (no pattern involved) in every mode — confirms rankingScore carries no
    // boost on the off path.
    const yes = findAssessment(result, "Yes");
    expect(yes.patternBacked).toBeUndefined();
    expect(yes.outcome).toBe("done");
    const yesMarket = findEvMarket(result, "Yes");
    expect(yesMarket).toBeDefined();
    expect(yesMarket!.rankingScore).toBe(yes.adjustedEdge);

    // Every surviving evMarket's rankingScore is exactly its own assessment's
    // adjustedEdge on the off path — the pattern ranking boost never applies.
    for (const m of result.evMarkets) {
      const a = result.assessments.find((x) => x.desc === m.side && x.odds === m.odds);
      expect(a).toBeDefined();
      expect(m.rankingScore).toBe(a!.adjustedEdge);
    }
  });

  it("(b) 'on': the pattern-backed Over 2.5 candidate is admitted via patternRelaxed with a boosted rankingScore, using the SAME numbers the off-path rejected", () => {
    const off = analyzeFixtureMarketsV3(goalMachineInput("off"))!;
    const on = analyzeFixtureMarketsV3(goalMachineInput("on"))!;

    const offOver = findAssessment(off, "Over 2.5");
    const onOver = findAssessment(on, "Over 2.5");

    // Identical pricing inputs on both runs — only v3Patterns differs.
    expect(onOver.rawEdge).toBeCloseTo(offOver.rawEdge, 10);
    expect(onOver.q).toBeCloseTo(offOver.q, 10);

    // The detector fired a strong, eligible pattern recommending exactly this
    // family+side (goal_machine → goals_ou / "Over 2.5").
    expect(onOver.patternBacked).toBe(true);
    expect(onOver.patternStrength).toBeGreaterThanOrEqual(PATTERN_MIN_STRENGTH);
    expect(onOver.patternStrength).toBeCloseTo(0.7, 1); // see file header derivation

    // The relaxed bar sits below the standard M bar, scaled by strength, and
    // this candidate's adjustedEdgeBlend clears the relaxed bar while still
    // failing the standard one — the class-edge relaxation, not a general
    // loosening, is what admits it.
    expect(onOver.patternRelaxedBar).toBeLessThan(CLASS_GATE_BLEND.M.minAdjEdgeBlend);
    expect(onOver.adjustedEdge).toBeLessThan(CLASS_GATE_BLEND.M.minAdjEdgeBlend);
    expect(onOver.adjustedEdge).toBeGreaterThanOrEqual(onOver.patternRelaxedBar!);
    expect(onOver.ev).toBeGreaterThan(0); // the hard value floor patterns.ts's relaxation adds on top

    expect(onOver.outcome).toBe("done");
    expect(onOver.patternRelaxed).toBe("passed");
    expect(onOver.confidence).not.toBeNull();

    // Surfaces in evMarkets (never did off-path) with a rankingScore boosted
    // by exactly PATTERN_RANK_BONUS * patternStrength over adjustedEdge —
    // compares the code's own reported fields, not a hand-derived absolute.
    const onOverMarket = findEvMarket(on, "Over 2.5");
    expect(onOverMarket).toBeDefined();
    expect(onOverMarket!.rankingScore).toBeCloseTo(
      onOver.adjustedEdge + PATTERN_RANK_BONUS * onOver.patternStrength!,
      10
    );
    expect(onOverMarket!.rankingScore).toBeGreaterThan(onOver.adjustedEdge);
  });

  it("(c) patternBacked is false for a non-matching side (same family) and a non-matching family — no false positives relaxing the gate for the wrong pick", () => {
    const on = analyzeFixtureMarketsV3(goalMachineInput("on"))!;

    // Same family (goals_ou) as the recommendation, opposite direction.
    const under = findAssessment(on, "Under 2.5");
    expect(under.patternBacked).toBeUndefined();
    expect(under.patternRelaxed).toBeUndefined();

    // Different family entirely (btts vs the recommended goals_ou) — clears
    // the standard bar on its own merit, never touched by the relaxation.
    const yes = findAssessment(on, "Yes");
    expect(yes.patternBacked).toBeUndefined();
    expect(yes.patternRelaxed).toBeUndefined();
    expect(yes.outcome).toBe("done");
    const yesMarket = findEvMarket(on, "Yes");
    expect(yesMarket).toBeDefined();
    expect(yesMarket!.rankingScore).toBe(yes.adjustedEdge); // no boost — not pattern-backed
  });
});
