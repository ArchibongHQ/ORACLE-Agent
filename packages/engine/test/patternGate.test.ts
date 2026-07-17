/** [patterns-engine Wave 2] Direct gateAllMarkets()-level coverage for the
 *  pattern-backed class-edge relaxation in evGate.ts — complements
 *  patternsIntegration.test.ts (which exercises the feature through the full
 *  analyzeFixtureMarketsV3 fixture pipeline) with precise, hand-derived inputs
 *  isolating each individual invariant the relaxation must never violate.
 *
 *  Written in response to an adversarial review pass (2026-07-16) that flagged
 *  zero coverage for: shadow mode staying below_gate, heightened+X exclusion
 *  under patternMode, and confirming minBlendEvPct/maxOdds are NOT relaxable
 *  (only minAdjEdgeBlend is). Every scenario below uses q*odds != 1 (a
 *  realistic vigged offered price against a devigged fair q) so `ev` and
 *  `blendEV` are genuinely distinct quantities, not coincidentally equal —
 *  see the per-test comments for the exact algebra.
 *
 *  PATTERN_MIN_STRENGTH/PATTERN_EDGE_RELAX_MAX aren't on the @oracle/engine
 *  barrel yet (same pre-existing gap blendGate.test.ts documents for the
 *  sibling V3_BLEND_* constants) — imported directly from the source module. */

import { CLASS_GATE_BLEND, gateAllMarkets } from "@oracle/engine";
import { describe, expect, it } from "vitest";
import { PATTERN_MIN_STRENGTH } from "../src/marketsV3/evGate.js";

describe("gateAllMarkets — pattern-backed class-edge relaxation (Wave 2), isolated invariants", () => {
  it("shadow mode: a candidate that clears the RELAXED edge bar (but not the standard one) stays below_gate — patternRelaxed is tagged 'shadow_pass', never admitted", () => {
    // q=0.50, odds=2.00 (fair, q*odds=1). modelP=0.54 -> rawEdge=0.04 (clears
    // noiseGate 0.02, under edgeCap 0.12; odds<3.0 so no relative cap).
    // completeness=1/hasRealXg=false -> wModel=0.30 -> rawEdgeBlend=0.012,
    // adjustedEdgeBlend=0.012 (penaltyPts=0) < CLASS_GATE_BLEND.M.minAdjEdgeBlend
    // (0.015) -> standard class_edge fails. At strength=0.7, patternRelaxedBar
    // = 0.015*(1-0.5*0.7) = 0.00975 <= 0.012 -> the relaxed bar clears.
    // blendEV = 0.512*2.0-1 = 0.024 >= evFloor(0); ev = 0.54*2-1 = 0.08 > 0.
    const gate = gateAllMarkets(
      0.54,
      { q: 0.5, devigged: true },
      2.0,
      "M",
      {},
      {
        blendPricing: true,
        completeness: 1,
        hasRealXg: false,
        patternMode: "shadow",
        patternBacked: true,
        patternStrength: 0.7,
      }
    );
    expect(gate.adjustedEdgeBlend).toBeCloseTo(0.012, 6);
    expect(gate.adjustedEdgeBlend!).toBeLessThan(CLASS_GATE_BLEND.M.minAdjEdgeBlend);
    expect(gate.ev).toBeGreaterThan(0);
    expect(gate.blendEV!).toBeGreaterThanOrEqual(0);

    // The relaxed bar is cleared (would-pass), but shadow mode must NEVER
    // change the outcome — only tag the counterfactual.
    expect(gate.outcome).toBe("below_gate");
    expect(gate.gateReason).toBe("class_edge");
    expect(gate.confidence).toBeNull();
    expect(gate.patternRelaxed).toBe("shadow_pass");
    expect(gate.patternRelaxedBar).toBeCloseTo(0.00975, 6);
    expect(gate.patternRelaxedBar!).toBeLessThan(CLASS_GATE_BLEND.M.minAdjEdgeBlend);
  });

  it("'on' mode admits the SAME candidate shadow only tagged — confirms shadow/on differ only in outcome, not in which candidates are eligible", () => {
    const shared = [0.54, { q: 0.5, devigged: true }, 2.0, "M", {}] as const;
    const on = gateAllMarkets(...shared, {
      blendPricing: true,
      completeness: 1,
      hasRealXg: false,
      patternMode: "on",
      patternBacked: true,
      patternStrength: 0.7,
    });
    expect(on.outcome).toBe("done");
    expect(on.patternRelaxed).toBe("passed");
    expect(on.confidence).not.toBeNull();
  });

  it("heightened + Class X: still excluded entirely regardless of patternMode/strength — patterns create no new path around the heightened X-exclusion", () => {
    const gate = gateAllMarkets(
      0.9,
      { q: 0.05, devigged: true },
      15,
      "X",
      {},
      {
        heightened: true,
        blendPricing: true,
        patternMode: "on",
        patternBacked: true,
        patternStrength: 1.0, // maximum possible strength — still must not matter
      }
    );
    expect(gate.outcome).toBe("below_gate");
    expect(gate.gateReason).toBe("heightened_x_excluded");
    expect(gate.patternRelaxed).toBeUndefined();
  });

  it("minBlendEvPct is NEVER relaxed — a Class L candidate whose (unrelaxed) EDGE already clears CLASS_GATE_BLEND.L but whose blendEV falls short of minBlendEvPct is rejected even at maximum pattern strength", () => {
    // q=0.30, odds=3.2 (a vigged price: q*odds=0.96, i.e. the raw market-fair
    // edge q*odds-1 = -0.04 -- NOT the fair-odds q*odds=1 case, so ev and
    // blendEV are genuinely distinct quantities here, not coincidentally equal).
    // modelP=0.375 -> ev = 0.375*3.2-1 = 0.20. rawEdge = 0.075 (clears
    // noiseGate; odds>3.0 so the relative cap DOES apply: rawEdge/q=0.25 <=
    // RELATIVE_CAP_RATIO(0.4) for a non-X class -- passes with margin).
    // completeness=1/hasRealXg=false -> wModel=0.30 -> rawEdgeBlend=0.0225,
    // adjustedEdgeBlend=0.0225 (penaltyPts=0) -- ALREADY >= L's minAdjEdgeBlend
    // (0.02), i.e. the edge bar needs no relaxation at all here. blendEV =
    // pBlend*odds-1 = 0.3225*3.2-1 = 0.032 -- clears evFloor(0) but falls well
    // short of L's minBlendEvPct (0.08). Even at strength=1.0 (max), the
    // pattern relaxation touches ONLY minAdjEdgeBlend -- it must not rescue
    // this minBlendEvPct shortfall.
    const gate = gateAllMarkets(
      0.375,
      { q: 0.3, devigged: true },
      3.2,
      "L",
      {},
      {
        blendPricing: true,
        completeness: 1,
        hasRealXg: false,
        patternMode: "on",
        patternBacked: true,
        patternStrength: 1.0,
      }
    );
    expect(gate.ev).toBeCloseTo(0.2, 6);
    expect(gate.adjustedEdgeBlend).toBeCloseTo(0.0225, 6);
    expect(gate.adjustedEdgeBlend!).toBeGreaterThanOrEqual(CLASS_GATE_BLEND.L.minAdjEdgeBlend);
    expect(gate.blendEV).toBeCloseTo(0.032, 6);
    expect(gate.blendEV!).toBeLessThan(CLASS_GATE_BLEND.L.minBlendEvPct!);

    expect(gate.outcome).toBe("below_gate");
    expect(gate.gateReason).toBe("class_evpct");
    expect(gate.patternRelaxed).toBeUndefined();
  });

  it("maxOdds is NEVER relaxed — a Class X candidate that clears the relaxed edge bar AND minBlendEvPct AND the value floor is still rejected when odds exceed CLASS_GATE_BLEND.X.maxOdds (15)", () => {
    // q=0.10, odds=20 (> X's maxOdds=15). rawEdge=0.026 (clears noiseGate;
    // odds>3.0 so relative cap applies for X at ratio 0.3: rawEdge/q=0.26 <=
    // 0.3, passes). completeness=1/hasRealXg=true -> wModel caps at 0.40 ->
    // rawEdgeBlend=0.0104, adjustedEdgeBlend=0.0104 < X's minAdjEdgeBlend
    // (0.02) -- standard edge fails. At strength=1.0 (max), patternRelaxedBar
    // = 0.02*(1-0.5*1) = 0.01 <= 0.0104 -- the relaxed edge bar clears. blendEV
    // and ev are both comfortably positive and above X's minBlendEvPct (0.12)
    // -- every OTHER bar is satisfied. Only maxOdds blocks it.
    const gate = gateAllMarkets(
      0.126,
      { q: 0.1, devigged: true },
      20,
      "X",
      {},
      {
        blendPricing: true,
        completeness: 1,
        hasRealXg: true,
        patternMode: "on",
        patternBacked: true,
        patternStrength: 1.0,
      }
    );
    expect(gate.adjustedEdgeBlend).toBeCloseTo(0.0104, 6);
    expect(gate.adjustedEdgeBlend!).toBeGreaterThanOrEqual(
      CLASS_GATE_BLEND.X.minAdjEdgeBlend * 0.5 // the strength=1.0 relaxed bar
    );
    expect(gate.blendEV!).toBeGreaterThan(CLASS_GATE_BLEND.X.minBlendEvPct!);
    expect(gate.ev).toBeGreaterThan(0);

    expect(gate.outcome).not.toBe("done");
    expect(gate.patternRelaxed).toBeUndefined();
  });

  it("the hard value floor (ev > 0) is enforced INDEPENDENTLY of blendEV>=evFloor — with an artificially loosened evFloor that blendEV alone would clear, a negative raw true EV still blocks the pattern admit", () => {
    // q=0.50, odds=1.80 (a vigged price BELOW fair 2.00: q*odds=0.90, raw
    // market-fair-edge q*odds-1=-0.10). modelP=0.54 -> rawEdge=0.04 (same
    // magnitude as test 1, clears noise/cap; odds<3.0 no relative cap). ev =
    // 0.54*1.8-1 = -0.028 (NEGATIVE). wModel=0.30 (completeness=1) ->
    // rawEdgeBlend=0.012, adjustedEdgeBlend=0.012 -- clears the strength=0.7
    // relaxed M bar (0.00975) exactly as in test 1. blendEV = 0.512*1.8-1 =
    // -0.0784 -- ALSO negative, but opts.evFloor is set to -1 here
    // (artificially loose) so blendEV(-0.0784) >= evFloor(-1) holds easily.
    // Absent the explicit `ev > 0` check this candidate's edge+blendEV-floor
    // conditions alone would admit it; the check must still block it.
    const gate = gateAllMarkets(
      0.54,
      { q: 0.5, devigged: true },
      1.8,
      "M",
      {},
      {
        blendPricing: true,
        completeness: 1,
        hasRealXg: false,
        evFloor: -1,
        patternMode: "on",
        patternBacked: true,
        patternStrength: 0.7,
      }
    );
    expect(gate.ev).toBeCloseTo(-0.028, 6);
    expect(gate.ev).toBeLessThanOrEqual(0);
    expect(gate.blendEV).toBeCloseTo(-0.0784, 4);
    expect(gate.blendEV!).toBeGreaterThanOrEqual(-1); // clears the loosened evFloor

    expect(gate.outcome).not.toBe("done");
    expect(gate.patternRelaxed).toBeUndefined();
  });

  it("patternStrength below PATTERN_MIN_STRENGTH never relaxes anything, even for an otherwise-eligible candidate", () => {
    const gate = gateAllMarkets(
      0.54,
      { q: 0.5, devigged: true },
      2.0,
      "M",
      {},
      {
        blendPricing: true,
        completeness: 1,
        hasRealXg: false,
        patternMode: "on",
        patternBacked: true,
        patternStrength: PATTERN_MIN_STRENGTH - 0.01,
      }
    );
    expect(gate.outcome).toBe("below_gate");
    expect(gate.patternRelaxed).toBeUndefined();
  });

  it("off mode: patternMode/patternBacked/patternStrength are silently ignored — byte-identical to calling gateAllMarkets with no pattern opts at all", () => {
    const withOff = gateAllMarkets(
      0.54,
      { q: 0.5, devigged: true },
      2.0,
      "M",
      {},
      {
        blendPricing: true,
        completeness: 1,
        hasRealXg: false,
        patternMode: "off",
        patternBacked: true,
        patternStrength: 1.0,
      }
    );
    const withNoPatternOpts = gateAllMarkets(
      0.54,
      { q: 0.5, devigged: true },
      2.0,
      "M",
      {},
      { blendPricing: true, completeness: 1, hasRealXg: false }
    );
    expect(withOff).toEqual(withNoPatternOpts);
    expect(withOff.patternBacked).toBeUndefined();
    expect(withOff.patternRelaxed).toBeUndefined();
  });
});
