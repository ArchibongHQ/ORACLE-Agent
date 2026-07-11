/** [Wave 4-accuracy] Grid property tests for v3BlendPricing's HARD INVARIANT:
 *  caps and the noise gate ALWAYS evaluate the RAW edge (modelP - q), never
 *  the blended one — a candidate the raw math would cap/discard as noise can
 *  NEVER be rescued into "done" by blend-anchored pricing, for any
 *  combination of modelP/q/odds/penalty-flags/completeness/hasRealXg/class.
 *
 *  This complements blendGate.test.ts's hand-picked scenario tests with a
 *  sweep across a grid of inputs — the point isn't precise numeric
 *  expectations (those are blendGate.test.ts's job) but a structural
 *  property that must hold everywhere: flipping blendPricing on can only
 *  ever make a class-gate verdict MORE conservative among candidates that
 *  survive the caps/noise stage, and can NEVER change what the caps/noise
 *  stage itself decides. */

import { gateAllMarkets } from "@oracle/engine";
import { describe, expect, it } from "vitest";
import type { V3AllMarketsPenaltyFlags } from "../src/marketsV3/evGate.js";

const MODEL_PS = [0.05, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
const QS = [0.05, 0.15, 0.3, 0.45, 0.6];
const ODDS = [1.3, 1.45, 2.2, 3.5, 4.5, 8, 15, 20];
const CLASSES = ["S", "M", "L", "X"] as const;
const COMPLETENESS = [0, 0.5, 1];
const HAS_REAL_XG = [false, true];
const FLAG_COMBOS: V3AllMarketsPenaltyFlags[] = [
  {},
  { xgMissing: true },
  { exoticClass: true },
  { marketStatMissing: true },
];

describe("v3BlendPricing monotonicity — grid property tests (Wave 4-accuracy)", () => {
  it("caps/noise are IDENTICAL between blendPricing off and on, for every combination in the grid — a flag-off-capped/noised candidate is never flag-on-admitted", () => {
    let checked = 0;
    let cappedOrNoisedCount = 0;
    for (const modelP of MODEL_PS) {
      for (const q of QS) {
        for (const odds of ODDS) {
          for (const cls of CLASSES) {
            for (const flags of FLAG_COMBOS) {
              for (const completeness of COMPLETENESS) {
                for (const hasRealXg of HAS_REAL_XG) {
                  const qObj = { q, devigged: true };
                  const gateOff = gateAllMarkets(modelP, qObj, odds, cls, flags, {
                    blendPricing: false,
                  });
                  const gateOn = gateAllMarkets(modelP, qObj, odds, cls, flags, {
                    blendPricing: true,
                    completeness,
                    hasRealXg,
                  });
                  checked++;

                  // Sanity: raw quantities (rawEdge/adjustedEdge/ev) never
                  // move — blendPricing only ever adds fields, it never
                  // mutates the raw ones (evGate.ts's own contract, see the
                  // "Assessments keep raw rawEdge/adjustedEdge" doc).
                  expect(gateOn.rawEdge).toBe(gateOff.rawEdge);
                  expect(gateOn.adjustedEdge).toBe(gateOff.adjustedEdge);
                  expect(gateOn.ev).toBe(gateOff.ev);

                  if (gateOff.outcome === "capped" || gateOff.outcome === "noise") {
                    cappedOrNoisedCount++;
                    // HARD INVARIANT: caps/noise are computed identically
                    // before either gate table is even consulted —
                    // blendPricing cannot change this verdict, regardless of
                    // how generous completeness/hasRealXg are.
                    expect(gateOn.outcome).toBe(gateOff.outcome);
                    expect(gateOn.gateReason).toBe(gateOff.gateReason);
                    if (gateOff.outcome === "capped") {
                      expect(gateOn.capReason).toBe(gateOff.capReason);
                    }
                    // The literal ask: a flag-off-capped candidate is never
                    // flag-on-admitted.
                    expect(gateOn.outcome).not.toBe("done");
                  }
                }
              }
            }
          }
        }
      }
    }
    // Sanity checks that the grid actually exercised both branches — a
    // vacuously-true loop (e.g. every combo landing in the same bucket)
    // would make the invariant assertions above meaningless.
    expect(checked).toBeGreaterThan(1000);
    expect(cappedOrNoisedCount).toBeGreaterThan(0);
    expect(cappedOrNoisedCount).toBeLessThan(checked); // not EVERY combo capped/noised either
  });

  it("handpicked extreme case: maximum wModel (completeness=1, hasRealXg=true) still never rescues a raw-capped candidate", () => {
    // rawEdge = 0.20 (20pt), far past the 12pt absolute cap — even with the
    // most generous possible blend weight, the candidate must stay capped.
    const q = { q: 0.3, devigged: true };
    const gateOff = gateAllMarkets(0.5, q, 3.2, "M", {}, { blendPricing: false });
    const gateOn = gateAllMarkets(
      0.5,
      q,
      3.2,
      "M",
      {},
      { blendPricing: true, completeness: 1, hasRealXg: true }
    );
    expect(gateOff.outcome).toBe("capped");
    expect(gateOn.outcome).toBe("capped");
    expect(gateOn.gateReason).toBe(gateOff.gateReason);
    // Blend fields ARE still populated (persisted for the ledger even on a
    // capped assessment, same contract Wave-1's blendMode already has).
    expect(gateOn.pBlend).toBeDefined();
    expect(gateOn.wModel).toBeCloseTo(0.4, 5);
  });

  it("handpicked extreme case: a raw-noised candidate stays noise regardless of blendPricing/completeness/hasRealXg", () => {
    const q = { q: 0.655, devigged: true };
    const gateOff = gateAllMarkets(0.649, q, 1.45, "S", {}, { blendPricing: false });
    const gateOn = gateAllMarkets(
      0.649,
      q,
      1.45,
      "S",
      {},
      { blendPricing: true, completeness: 1, hasRealXg: true }
    );
    expect(gateOff.outcome).toBe("noise");
    expect(gateOn.outcome).toBe("noise");
    expect(gateOn.gateReason).toBe("noise");
  });
});
