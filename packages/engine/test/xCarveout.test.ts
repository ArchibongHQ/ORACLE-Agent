/** [X-carveout, owner decision 2026-07-11] evGate.ts's high-conviction Class X
 *  exception to the v3BlendPricing gate — the counterpart to blendGate.test.ts's
 *  "DOCUMENTED CONTRADICTION" test, which proved Class X was structurally
 *  unreachable under blendPricing (the raw −5pt exotic penalty, calibrated in
 *  RAW-edge space, drags adjustedEdgeBlend to ≤ −0.002 against X's 0.02 floor).
 *  The carve-out re-evaluates ONLY the edge floor with the penalty rescaled by
 *  X_CARVEOUT_PENALTY_RESCALE (1/3, the same ratio CLASS_GATE_BLEND vs
 *  CLASS_GATE itself uses) — every other X bar (odds ≤ 15, blendEV ≥ 12%, EV
 *  floor, heightened exclusion) still applies at full strength, plus a
 *  data-quality conviction requirement (real xG + completeness ≥ 0.8).
 *
 *  computeMarketBlend, V3_BLEND_*, and X_CARVEOUT_* aren't on the
 *  @oracle/engine barrel yet — imported directly from the source module,
 *  matching blendGate.test.ts's own import style. */

import { describe, expect, it } from "vitest";
import { V3_EDGE_CAP_DEFAULT } from "../src/goalsV3/edgeGate.js";
import {
  CLASS_GATE_BLEND,
  gateAllMarkets,
  V3_BLEND_W_CAP,
  X_CARVEOUT_MIN_COMPLETENESS,
  X_CARVEOUT_PENALTY_RESCALE,
} from "../src/marketsV3/evGate.js";

describe("gateAllMarkets — Class X high-conviction carve-out (ORACLE_V3_X_CARVEOUT)", () => {
  it("reachability property: the 1/3-rescaled penalty makes X's blend edge floor reachable in principle, where the RAW (unscaled) penalty made it structurally impossible", () => {
    // Mirrors blendGate.test.ts's "DOCUMENTED CONTRADICTION": at wModel's 0.40
    // ceiling and the largest rawEdge that avoids the 12pt absolute cap,
    // rawEdgeBlend tops out at 0.40*0.12=0.048. The unscaled −5pt exotic
    // penalty drags that to −0.002, below X's 0.02 floor — unreachable.
    const maxPossibleRawEdgeBlend = V3_BLEND_W_CAP * V3_EDGE_CAP_DEFAULT;
    const exoticPenalty = 0.05;
    expect(maxPossibleRawEdgeBlend - exoticPenalty).toBeLessThan(
      CLASS_GATE_BLEND.X.minAdjEdgeBlend
    );

    // The carve-out rescales that same penalty by 1/3 (the same ratio
    // CLASS_GATE_BLEND.X/CLASS_GATE.X itself uses: .02/.06 ≈ 1/3) — this
    // reopens the window: 0.048 − 0.0167 ≈ 0.0313 ≥ 0.02.
    const rescaledFloor = maxPossibleRawEdgeBlend - exoticPenalty * X_CARVEOUT_PENALTY_RESCALE;
    expect(rescaledFloor).toBeCloseTo(0.0313, 3);
    expect(rescaledFloor).toBeGreaterThanOrEqual(CLASS_GATE_BLEND.X.minAdjEdgeBlend);
  });

  describe("worked example: modelP=0.425, q=0.333, odds=3.2, cls=X, exoticClass penalty", () => {
    // wModel=0.40 (full completeness+real xG) -> pBlend=0.3698 ->
    // rawEdgeBlend=0.0368 -> standard adjustedEdgeBlend = 0.0368-0.05 =
    // -0.0132 (fails X's 0.02 floor -> standard blend gate genuinely fails).
    // blendEV = 0.3698*3.2-1 ~= 0.1834 (clears X's 12% floor). Carve-out edge
    // = 0.0368 - 0.05/3 ~= 0.02013 (clears the 0.02 floor, barely).
    const modelP = 0.425;
    const q = { q: 0.333, devigged: true };
    const odds = 3.2;
    const flags = { exoticClass: true };

    it("flag 'on': qualifies -> outcome done, confidence pinned to medium, xCarveout 'passed'", () => {
      const gate = gateAllMarkets(modelP, q, odds, "X", flags, {
        blendPricing: true,
        xCarveout: "on",
        completeness: 1.0,
        hasRealXg: true,
      });
      // Sanity: confirm the derivation before trusting the outcome.
      expect(gate.rawEdge).toBeLessThan(0.12); // clears the absolute cap
      expect(gate.rawEdge! / q.q).toBeLessThanOrEqual(0.3); // clears X's relative cap
      expect(gate.wModel).toBeCloseTo(0.4, 5);
      expect(gate.adjustedEdgeBlend).toBeLessThan(CLASS_GATE_BLEND.X.minAdjEdgeBlend); // standard gate fails
      expect(gate.blendEV).toBeCloseTo(0.1834, 3);

      expect(gate.outcome).toBe("done");
      expect(gate.confidence).toBe("medium");
      expect(gate.xCarveout).toBe("passed");
      expect(gate.gateReason).toBeUndefined();

      // The admitted pick's staking/ranking edge: the rescaled carve-out edge
      // (rawEdgeBlend − penalty/3 ≈ 0.02013), NOT the negative
      // adjustedEdgeBlend — a positive edge is what keeps optimizedKelly from
      // zero-staking and bottom-ranking the pick downstream.
      expect(gate.adjustedEdgeCarveout).toBeCloseTo(0.02013, 4);
      expect(gate.adjustedEdgeCarveout).toBeGreaterThanOrEqual(CLASS_GATE_BLEND.X.minAdjEdgeBlend);
    });

    it("flag 'shadow': same inputs qualify but stay below_gate — normal gateReason attribution AND the shadow tag both persist", () => {
      const gate = gateAllMarkets(modelP, q, odds, "X", flags, {
        blendPricing: true,
        xCarveout: "shadow",
        completeness: 1.0,
        hasRealXg: true,
      });
      expect(gate.outcome).toBe("below_gate");
      expect(gate.gateReason).toBe("class_edge"); // explicit: correct gateReason attribution...
      expect(gate.xCarveout).toBe("shadow_pass"); // ...persists alongside the shadow tag
      expect(gate.confidence).toBeNull();
      // Shadow also carries the counterfactual staking edge for the ledger.
      expect(gate.adjustedEdgeCarveout).toBeCloseTo(0.02013, 4);
    });

    it("flag 'off' (and omitted entirely): below_gate, xCarveout undefined — byte-identical default", () => {
      const withOff = gateAllMarkets(modelP, q, odds, "X", flags, {
        blendPricing: true,
        xCarveout: "off",
        completeness: 1.0,
        hasRealXg: true,
      });
      const omitted = gateAllMarkets(modelP, q, odds, "X", flags, {
        blendPricing: true,
        completeness: 1.0,
        hasRealXg: true,
      });
      for (const gate of [withOff, omitted]) {
        expect(gate.outcome).toBe("below_gate");
        expect(gate.gateReason).toBe("class_edge");
        expect(gate.xCarveout).toBeUndefined();
      }
      expect(withOff).toEqual(omitted);
    });
  });

  describe("each carve-out condition individually violated (flag 'on') -> below_gate, no xCarveout tag", () => {
    it("(a) hasRealXg false", () => {
      const q = { q: 0.333, devigged: true };
      const gate = gateAllMarkets(
        0.425,
        q,
        3.2,
        "X",
        { exoticClass: true },
        {
          blendPricing: true,
          xCarveout: "on",
          completeness: 1.0,
          hasRealXg: false,
        }
      );
      expect(gate.outcome).toBe("below_gate");
      expect(gate.xCarveout).toBeUndefined();
    });

    it("(b) completeness 0.7 (below X_CARVEOUT_MIN_COMPLETENESS)", () => {
      expect(0.7).toBeLessThan(X_CARVEOUT_MIN_COMPLETENESS);
      const q = { q: 0.333, devigged: true };
      const gate = gateAllMarkets(
        0.425,
        q,
        3.2,
        "X",
        { exoticClass: true },
        {
          blendPricing: true,
          xCarveout: "on",
          completeness: 0.7,
          hasRealXg: true,
        }
      );
      expect(gate.outcome).toBe("below_gate");
      expect(gate.xCarveout).toBeUndefined();
    });

    it("(c) blendEV below 0.12 — odds 3.02 instead of 3.2 (rawEdge/q unaffected by odds, still clears the relative cap)", () => {
      const q = { q: 0.333, devigged: true };
      const odds = 3.02;
      const rawEdge = 0.425 - q.q;
      expect(rawEdge / q.q).toBeCloseTo(0.276, 3); // relative cap still clears (<=0.30)
      const gate = gateAllMarkets(
        0.425,
        q,
        odds,
        "X",
        { exoticClass: true },
        {
          blendPricing: true,
          xCarveout: "on",
          completeness: 1.0,
          hasRealXg: true,
        }
      );
      expect(gate.outcome).not.toBe("capped");
      expect(gate.blendEV).toBeCloseTo(0.1168, 3);
      expect(gate.blendEV).toBeLessThan(CLASS_GATE_BLEND.X.minBlendEvPct!);
      expect(gate.outcome).toBe("below_gate");
      expect(gate.xCarveout).toBeUndefined();
    });

    it("(d) rescaled edge below floor — modelP 0.40 instead of 0.425", () => {
      const q = { q: 0.333, devigged: true };
      const modelP = 0.4;
      const rawEdge = modelP - q.q;
      expect(rawEdge).toBeCloseTo(0.067, 3);
      const gate = gateAllMarkets(
        modelP,
        q,
        3.2,
        "X",
        { exoticClass: true },
        {
          blendPricing: true,
          xCarveout: "on",
          completeness: 1.0,
          hasRealXg: true,
        }
      );
      expect(gate.rawEdgeBlend).toBeCloseTo(0.0268, 3);
      const carveoutEdge = gate.rawEdgeBlend! - gate.penaltyPts * X_CARVEOUT_PENALTY_RESCALE;
      expect(carveoutEdge).toBeCloseTo(0.0101, 3);
      expect(carveoutEdge).toBeLessThan(CLASS_GATE_BLEND.X.minAdjEdgeBlend);
      expect(gate.outcome).toBe("below_gate");
      expect(gate.xCarveout).toBeUndefined();
    });
  });

  it("maxOdds bar survives the carve-out: odds 16 (> X's 15 ceiling) still fails even with a wildly-mispriced, cap-avoiding edge and flag 'on'", () => {
    const modelP = 0.425;
    const q = { q: 0.34, devigged: true };
    const odds = 16;
    const rawEdge = modelP - q.q;
    expect(rawEdge).toBeCloseTo(0.085, 3);
    expect(rawEdge / q.q).toBeLessThanOrEqual(0.3); // clears the relative cap
    const gate = gateAllMarkets(
      modelP,
      q,
      odds,
      "X",
      {},
      {
        blendPricing: true,
        xCarveout: "on",
        completeness: 1.0,
        hasRealXg: true,
      }
    );
    expect(gate.outcome).not.toBe("capped");
    // Both the class edge AND blendEV bars clear comfortably at these
    // odds/wModel — max_odds is the ONLY reason this fails.
    expect(gate.adjustedEdgeBlend).toBeGreaterThanOrEqual(CLASS_GATE_BLEND.X.minAdjEdgeBlend);
    expect(gate.blendEV).toBeGreaterThanOrEqual(CLASS_GATE_BLEND.X.minBlendEvPct!);
    expect(gate.outcome).toBe("below_gate");
    expect(gate.gateReason).toBe("max_odds");
    expect(gate.xCarveout).toBeUndefined();
  });

  it("long-odds unreachability: the relative cap fires before the carve-out is ever consulted", () => {
    const modelP = 0.2;
    const q = { q: 0.1, devigged: true };
    const odds = 9;
    const rawEdge = modelP - q.q;
    expect(rawEdge).toBeLessThan(0.12); // absolute cap does NOT fire
    expect(rawEdge / q.q).toBeGreaterThan(0.3); // relative cap DOES fire (X ratio 0.30)
    const gate = gateAllMarkets(
      modelP,
      q,
      odds,
      "X",
      { exoticClass: true },
      {
        blendPricing: true,
        xCarveout: "on",
        completeness: 1.0,
        hasRealXg: true,
      }
    );
    expect(gate.outcome).toBe("capped");
    expect(gate.capReason).toBe("relative");
    expect(gate.xCarveout).toBeUndefined();
  });

  it("absolute-cap hard invariant: raw edge > 12pts is capped regardless of the carve-out flag", () => {
    const modelP = 0.47;
    const q = { q: 0.333, devigged: true };
    const odds = 3.2;
    const rawEdge = modelP - q.q;
    expect(rawEdge).toBeGreaterThan(V3_EDGE_CAP_DEFAULT);
    const gate = gateAllMarkets(
      modelP,
      q,
      odds,
      "X",
      { exoticClass: true },
      {
        blendPricing: true,
        xCarveout: "on",
        completeness: 1.0,
        hasRealXg: true,
      }
    );
    expect(gate.outcome).toBe("capped");
    expect(gate.capReason).toBe("absolute");
    expect(gate.xCarveout).toBeUndefined();
  });

  it("heightened exclusion unaffected: worked-example inputs + heightened:true + flag 'on' -> below_gate/heightened_x_excluded, carve-out never consulted", () => {
    const q = { q: 0.333, devigged: true };
    const gate = gateAllMarkets(
      0.425,
      q,
      3.2,
      "X",
      { exoticClass: true },
      {
        blendPricing: true,
        xCarveout: "on",
        completeness: 1.0,
        hasRealXg: true,
        heightened: true,
      }
    );
    expect(gate.outcome).toBe("below_gate");
    expect(gate.gateReason).toBe("heightened_x_excluded");
    expect(gate.xCarveout).toBeUndefined();
  });

  it("non-X classes are never tagged: a Class L candidate failing its own blend gate with flag 'on' and full data quality stays untagged", () => {
    const modelP = 0.36;
    const q = { q: 0.333, devigged: true };
    const odds = 3.2;
    const gate = gateAllMarkets(
      modelP,
      q,
      odds,
      "L",
      {},
      {
        blendPricing: true,
        xCarveout: "on",
        completeness: 1.0,
        hasRealXg: true,
      }
    );
    // Verify it genuinely fails L's own bar {minAdjEdgeBlend: 0.02, minBlendEvPct: 0.08}
    // rather than passing for an unrelated reason.
    expect(gate.adjustedEdgeBlend).toBeLessThan(0.02);
    expect(gate.outcome).toBe("below_gate");
    expect(gate.gateReason).toBe("class_edge");
    expect(gate.xCarveout).toBeUndefined();
  });
});
