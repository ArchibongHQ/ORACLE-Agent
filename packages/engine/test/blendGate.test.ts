/** [refactor P0-2] Market-anchored blend (v5 §5.8) — evGate.ts's
 *  computeMarketBlend + gateAllMarkets' blendMode-gated mandatory longshot
 *  bar. Anchored to the live incident that motivated the fix (2026-07-09:
 *  unblended Poisson models overrating weak sides, producing fake +65-70%
 *  "edges" on 6.20/13.50 longshots) and the spec's own §5.8 worked examples.
 *
 *  computeMarketBlend/V3_BLEND_* aren't on the @oracle/engine barrel yet (this
 *  workstream owns evGate.ts but not packages/engine/src/index.ts) — imported
 *  directly from the source module below. See this PR's final report for the
 *  barrel-export lines the orchestrator should add. */

import {
  CLASS_GATE_BLEND,
  CLASS_GATE_BLEND_HEIGHTENED,
  gateAllMarkets,
  impliedQ,
} from "@oracle/engine";
import { describe, expect, it } from "vitest";
import {
  computeMarketBlend,
  V3_BLEND_GATE_ODDS_FLOOR,
  V3_BLEND_W_CAP,
  V3_EV_FLOOR_DEFAULT,
} from "../src/marketsV3/evGate.js";

describe("computeMarketBlend — v5 §5.8 pure arithmetic", () => {
  it("worked example: odds 6.20, q=0.147, P_model=0.267, completeness=0.7, no real xG → wModel=0.255, pBlend≈0.178, blendEdge≈+0.101, passes the blend bar", () => {
    const blend = computeMarketBlend(0.267, 0.147, 6.2, 0.7, false);
    expect(blend.wModel).toBeCloseTo(0.255, 5);
    expect(blend.pBlend).toBeCloseTo(0.178, 3);
    expect(blend.blendEdge).toBeCloseTo(0.101, 2);
    expect(blend.blendGatePass).toBe(true);
  });

  it("hot-longshot worked example: odds 4.5, q=0.16, P_model=0.30, completeness=0, no real xG → wModel floors at 0.15, pBlend=0.181, blendEdge≈-0.186, fails the blend bar", () => {
    const blend = computeMarketBlend(0.3, 0.16, 4.5, 0, false);
    expect(blend.wModel).toBeCloseTo(0.15, 5);
    expect(blend.pBlend).toBeCloseTo(0.181, 3);
    expect(blend.blendEdge).toBeCloseTo(-0.186, 2);
    expect(blend.blendGatePass).toBe(false);
  });

  it("completeness/hasRealXg default to the strictest posture (0/false) when omitted", () => {
    const withDefaults = computeMarketBlend(0.3, 0.2, 3.0);
    const explicitFloor = computeMarketBlend(0.3, 0.2, 3.0, 0, false);
    expect(withDefaults).toEqual(explicitFloor);
    expect(withDefaults.wModel).toBeCloseTo(0.15, 10);
  });

  it("wModel is hard-capped at 0.40 even when completeness/xG inputs would push it higher", () => {
    // completeness01=2 is out-of-range input (defensive) — the point is the
    // Math.min ceiling actually engages, not merely that 0.15+0.15+0.10 lands
    // at exactly 0.40 by coincidence.
    const blend = computeMarketBlend(0.5, 0.3, 3.0, 2, true);
    expect(blend.wModel).toBe(V3_BLEND_W_CAP);
  });
});

describe("gateAllMarkets — blendMode field computation (both shadow and on)", () => {
  it("(a) fields are populated even on a CAPPED assessment (persisted for the ledger regardless of outcome) — shadow mode never enforces the bar", () => {
    // Same modelP/q/odds as the pure computeMarketBlend worked example above.
    // rawEdge (~0.12) sits right at the §5.4 absolute-cap boundary and raw/q
    // (81.6%) clears the relative-cap ratio for every class either way — this
    // candidate is already capped by the PRE-EXISTING §5.4 machinery
    // regardless of the blend fix (consistent with the live incident: an
    // unblended model handing out edges so large they trip caps meant for
    // "model too hot"). Which specific cap fires is a float-boundary detail
    // not pinned here; what matters is the blend fields survive it.
    const q = { q: 0.147, devigged: true };
    const gate = gateAllMarkets(
      0.267,
      q,
      6.2,
      "X",
      {},
      {
        blendMode: "shadow",
        completeness: 0.7,
        hasRealXg: false,
      }
    );
    expect(gate.outcome).toBe("capped");
    expect(["capped_absolute", "capped_relative"]).toContain(gate.gateReason);
    expect(gate.wModel).toBeCloseTo(0.255, 5);
    expect(gate.pBlend).toBeCloseTo(0.178, 3);
    expect(gate.blendEdge).toBeCloseTo(0.101, 2);
    expect(gate.blendGatePass).toBe(true);
  });

  it("(b) blendMode='on' vetoes an odds>=4.00 candidate that clears every class bar but fails the blend-anchored EV bar — gateReason model_hot_longshot", () => {
    // q=0.20, modelP=0.27 (rawEdge=7pts, ratio 35% — clears Class L's edge
    // AND the §5.4 relative cap on its own) at odds 4.5, completeness=0, no
    // real xG. wModel floors at 0.15 (closest-to-market posture) → pBlend
    // 0.2105 → blendEdge ≈ -0.053, below the +5% blend bar.
    const q = { q: 0.2, devigged: true };
    const onGate = gateAllMarkets(
      0.27,
      q,
      4.5,
      "L",
      {},
      {
        blendMode: "on",
        completeness: 0,
        hasRealXg: false,
      }
    );
    expect(onGate.adjustedEdge).toBeCloseTo(0.07, 5); // clears L's 0.06 bar
    expect(onGate.adjEvPct).toBeCloseTo(0.35, 5); // clears L's 0.15 bar
    expect(onGate.ev).toBeGreaterThan(0); // clears the true-EV floor
    expect(onGate.wModel).toBeCloseTo(0.15, 5);
    expect(onGate.blendEdge).toBeCloseTo(-0.0528, 3);
    expect(onGate.blendGatePass).toBe(false);
    expect(onGate.outcome).toBe("below_gate");
    expect(onGate.gateReason).toBe("model_hot_longshot");

    // Same inputs, shadow mode: fields identical, but the bar is NOT
    // enforced — outcome/confidence are unchanged from pre-blend behavior.
    const shadowGate = gateAllMarkets(
      0.27,
      q,
      4.5,
      "L",
      {},
      {
        blendMode: "shadow",
        completeness: 0,
        hasRealXg: false,
      }
    );
    expect(shadowGate.blendGatePass).toBe(false);
    expect(shadowGate.outcome).toBe("done");
    expect(shadowGate.confidence).toBe("high");
    expect(shadowGate.gateReason).toBeUndefined();
  });

  it("(c) odds below the 4.00 floor are never blend-gated, even under blendMode='on', though blend fields are still computed", () => {
    // q=0.25, modelP=0.31 at odds 3.9 (just under V3_BLEND_GATE_ODDS_FLOOR):
    // clears Class M on adjustedEdge alone; blendEdge (~1.0%) would fail the
    // +5% bar if it were enforced, but odds<4.00 exempts it.
    const q = { q: 0.25, devigged: true };
    const gate = gateAllMarkets(
      0.31,
      q,
      3.9,
      "M",
      {},
      {
        blendMode: "on",
        completeness: 0,
        hasRealXg: false,
      }
    );
    expect(3.9).toBeLessThan(V3_BLEND_GATE_ODDS_FLOOR);
    expect(gate.blendGatePass).toBe(false); // the blend bar itself fails...
    expect(gate.outcome).toBe("done"); // ...but isn't enforced below odds 4.00
    expect(gate.gateReason).toBeUndefined();
    expect(gate.wModel).toBeCloseTo(0.15, 5);
    expect(gate.blendEdge).toBeCloseTo(0.0101, 3);
  });

  it("(d) blendMode='off' (the gateAllMarkets default) computes no blend fields — byte-identical to pre-P0-2 gating", () => {
    const q = { q: 0.4, devigged: true };
    const implicitOff = gateAllMarkets(0.46, q, 2.2, "M", {});
    const explicitOff = gateAllMarkets(0.46, q, 2.2, "M", {}, { blendMode: "off" });
    for (const gate of [implicitOff, explicitOff]) {
      expect(gate.outcome).toBe("done");
      expect(gate.wModel).toBeUndefined();
      expect(gate.pBlend).toBeUndefined();
      expect(gate.blendEdge).toBeUndefined();
      expect(gate.blendGatePass).toBeUndefined();
      expect(gate.gateReason).toBeUndefined();
    }
    expect(implicitOff).toEqual(explicitOff);
  });

  it("(e) the true-EV floor (V3_EV_FLOOR_DEFAULT) is enforced when a caller passes it explicitly — the exact call analyzeFixtureMarketsV3 now makes visible (the fixed pass-through bug)", () => {
    // Same odds-1.40-at-8%-margin scenario as evGate.ts's own docstring / the
    // pre-existing marketsV3.test.ts "[audit fix]" case — reproduced here with
    // evFloor passed EXPLICITLY (opts.evFloor: V3_EV_FLOOR_DEFAULT), mirroring
    // analyzeFixtureMarkets.ts's fixed call site verbatim rather than relying
    // on gateAllMarkets' own internal default.
    const q = impliedQ(1.4, 2.734)!;
    const gate = gateAllMarkets(0.706, q, 1.4, "S", {}, { evFloor: V3_EV_FLOOR_DEFAULT });
    expect(gate.adjustedEdge).toBeGreaterThanOrEqual(0.03); // clears Class S's points bar
    expect(gate.adjEvPct).toBeGreaterThanOrEqual(0.04); // clears Class S's EV% bar
    expect(gate.ev).toBeLessThan(0); // -1.16% true EV at the offered price
    expect(gate.outcome).toBe("below_gate");
    expect(gate.gateReason).toBe("ev_floor");
  });
});

describe("gateAllMarkets — gateReason attribution (additive; `outcome` unchanged everywhere)", () => {
  it("class_edge: adjustedEdge below the class floor", () => {
    const q = { q: 0.704, devigged: true };
    const gate = gateAllMarkets(0.73, q, 1.36, "S", { xgMissing: true });
    expect(gate.outcome).toBe("below_gate");
    expect(gate.gateReason).toBe("class_edge");
  });

  it("class_evpct: adjustedEdge clears the floor but adjEvPct doesn't", () => {
    const q = { q: 0.5, devigged: true };
    const gate = gateAllMarkets(0.57, q, 2.0, "L", {});
    expect(gate.adjustedEdge).toBeCloseTo(0.07, 5); // clears L's 0.06 edge bar
    expect(gate.adjEvPct).toBeCloseTo(0.14, 5); // fails L's 0.15 EV% bar
    expect(gate.outcome).toBe("below_gate");
    expect(gate.gateReason).toBe("class_evpct");
  });

  it("max_odds: everything else clears but odds exceeds the class ceiling", () => {
    const q = { q: 0.2, devigged: true };
    const gate = gateAllMarkets(0.26, q, 20, "X", {});
    expect(gate.outcome).toBe("below_gate");
    expect(gate.gateReason).toBe("max_odds");
  });

  it("ev_floor: class bars clear but true EV at the offered price is negative", () => {
    const q = impliedQ(1.4, 2.734)!;
    const gate = gateAllMarkets(0.706, q, 1.4, "S", {});
    expect(gate.outcome).toBe("below_gate");
    expect(gate.gateReason).toBe("ev_floor");
  });

  it("noise: |rawEdge| within the noise band", () => {
    const q = { q: 0.655, devigged: true };
    const gate = gateAllMarkets(0.649, q, 1.45, "S", {});
    expect(gate.outcome).toBe("noise");
    expect(gate.gateReason).toBe("noise");
  });

  it("capped_absolute: raw edge exceeds the §5.4 absolute cap", () => {
    const q = { q: 0.3, devigged: true };
    const gate = gateAllMarkets(0.5, q, 3.2, "M", {});
    expect(gate.outcome).toBe("capped");
    expect(gate.gateReason).toBe("capped_absolute");
  });

  it("capped_relative: odds>3.00 and raw/q exceeds the §5.4 relative ratio", () => {
    const q = { q: 0.1, devigged: false };
    const gate = gateAllMarkets(0.15, q, 4.0, "L", {});
    expect(gate.outcome).toBe("capped");
    expect(gate.gateReason).toBe("capped_relative");
  });

  it("heightened_x_excluded: Class X is hard-excluded under v4 heightened bars", () => {
    const q = { q: 0.1, devigged: true };
    const gate = gateAllMarkets(0.5, q, 5, "X", {}, { heightened: true });
    expect(gate.outcome).toBe("below_gate");
    expect(gate.gateReason).toBe("heightened_x_excluded");
  });

  it("a DONE assessment never carries a gateReason", () => {
    const q = { q: 0.4, devigged: true };
    const gate = gateAllMarkets(0.46, q, 2.2, "M", {});
    expect(gate.outcome).toBe("done");
    expect(gate.gateReason).toBeUndefined();
  });
});

// ── [Wave 4-accuracy] v3BlendPricing — ALL candidates price off pBlend ──────

describe("gateAllMarkets — v3BlendPricing (Wave 4-accuracy)", () => {
  it("HSH-shaped fake edge: soft odds 2.25 with an inflated raw model P passes the LEGACY raw gate (the bug this fixes) but fails the blend-anchored bar", () => {
    // odds 2.25 is below V3_BLEND_GATE_ODDS_FLOOR (4.00) — the pre-existing
    // Wave-1 blend gate never touches it. modelP=0.524 vs q≈0.4444 (single
    // price, un-devigged) is an 8pt raw edge: clears Class M's 5pt floor,
    // well under the 12pt absolute cap and odds<3.00 so the relative cap
    // never engages either — exactly the "highest_scoring_half"-shaped fake
    // edge the live incident referenced (unblended Poisson overrating a weak
    // side at moderate odds, just under the old odds>=4.00 gate floor).
    const q = impliedQ(2.25)!;
    expect(q.devigged).toBe(false);

    const legacyGate = gateAllMarkets(0.524, q, 2.25, "M", {});
    expect(legacyGate.adjustedEdge).toBeCloseTo(0.0796, 3);
    expect(legacyGate.outcome).toBe("done"); // the bug: raw edge passes unanchored

    const blendGate = gateAllMarkets(0.524, q, 2.25, "M", {}, { blendPricing: true });
    expect(blendGate.wModel).toBeCloseTo(0.15, 5); // completeness/hasRealXg default to the floor
    expect(blendGate.adjustedEdgeBlend).toBeCloseTo(0.012, 2);
    expect(blendGate.blendEV).toBeLessThan(CLASS_GATE_BLEND.M.minAdjEdgeBlend * 10); // sanity: tiny
    expect(blendGate.outcome).toBe("below_gate");
    expect(blendGate.gateReason).toBe("class_edge");
  });

  it("HARD INVARIANT: a raw-capped candidate (absolute cap) is NEVER admitted via blendPricing — caps always evaluate the RAW edge", () => {
    const q = { q: 0.3, devigged: true };
    const legacyGate = gateAllMarkets(0.5, q, 3.2, "M", {}); // rawEdge=0.20 > 12pt cap
    expect(legacyGate.outcome).toBe("capped");
    expect(legacyGate.gateReason).toBe("capped_absolute");

    const blendGate = gateAllMarkets(0.5, q, 3.2, "M", {}, { blendPricing: true });
    expect(blendGate.outcome).toBe("capped");
    expect(blendGate.gateReason).toBe("capped_absolute");
    // Blend fields are still computed/persisted even though the candidate
    // never reaches the blend-pricing branch (same "populated on every
    // outcome" contract the Wave-1 blendMode fields already have).
    expect(blendGate.wModel).toBeDefined();
    expect(blendGate.pBlend).toBeDefined();
    expect(blendGate.adjustedEdgeBlend).toBeDefined();
  });

  it("HARD INVARIANT: a raw-noised candidate is NEVER admitted via blendPricing — the noise gate always evaluates the RAW edge", () => {
    const q = { q: 0.655, devigged: true };
    const legacyGate = gateAllMarkets(0.649, q, 1.45, "S", {}); // |rawEdge| within the 2pt noise band
    expect(legacyGate.outcome).toBe("noise");

    const blendGate = gateAllMarkets(0.649, q, 1.45, "S", {}, { blendPricing: true });
    expect(blendGate.outcome).toBe("noise");
    expect(blendGate.gateReason).toBe("noise");
  });

  it("blendPricing FORCES the blend computation even when blendMode is 'off'/omitted — the two flags are independent contracts", () => {
    const q = { q: 0.4, devigged: true };
    const gate = gateAllMarkets(0.46, q, 2.2, "M", {}, { blendPricing: true });
    expect(gate.wModel).toBeDefined();
    expect(gate.pBlend).toBeDefined();
    expect(gate.blendEdge).toBeDefined(); // Wave-1's own field, still populated
    expect(gate.rawEdgeBlend).toBeDefined();
    expect(gate.adjustedEdgeBlend).toBeDefined();
    expect(gate.blendEV).toBeDefined();
    expect(gate.blendEV).toBeCloseTo(gate.blendEdge!, 10); // numerically identical, distinct names
  });

  it("blendPricing default (omitted/false) is BYTE-IDENTICAL to pre-Wave-4 gating — no blend fields, same outcome", () => {
    const q = { q: 0.4, devigged: true };
    const implicitOff = gateAllMarkets(0.46, q, 2.2, "M", {});
    const explicitOff = gateAllMarkets(0.46, q, 2.2, "M", {}, { blendPricing: false });
    for (const gate of [implicitOff, explicitOff]) {
      expect(gate.outcome).toBe("done");
      expect(gate.wModel).toBeUndefined();
      expect(gate.rawEdgeBlend).toBeUndefined();
      expect(gate.adjustedEdgeBlend).toBeUndefined();
      expect(gate.blendEV).toBeUndefined();
    }
    expect(implicitOff).toEqual(explicitOff);
  });

  describe("CLASS_GATE_BLEND — per-class rescaled bars", () => {
    // NOTE on construction: q is set to exactly 1/odds (un-devigged-equivalent)
    // in these cases so blendEV = wModel * (modelP*odds - 1) exactly — this
    // makes it tractable to hand-derive modelP/q/odds combinations that clear
    // both the point-edge AND EV%% bars without also tripping the INDEPENDENT
    // raw-edge caps (12pt absolute / odds>3.00+40%% relative), which evaluate
    // rawEdge = modelP - q regardless of blendPricing (HARD INVARIANT above).
    it("S: adjEdgeBlend>=1.0pt AND blendEV>=4% — a high-completeness/real-xG candidate (wModel=0.40) clears both bars", () => {
      const q = { q: 1 / 1.45, devigged: false };
      const gate = gateAllMarkets(
        0.77,
        q,
        1.45,
        "S",
        {},
        { blendPricing: true, completeness: 1, hasRealXg: true }
      );
      expect(gate.cls).toBe("S");
      expect(gate.wModel).toBeCloseTo(0.4, 5); // ceiling: 0.15+0.15+0.10
      expect(gate.rawEdge).toBeLessThan(0.12); // nowhere near the absolute cap
      expect(gate.adjustedEdgeBlend).toBeGreaterThanOrEqual(CLASS_GATE_BLEND.S.minAdjEdgeBlend);
      expect(gate.blendEV).toBeGreaterThanOrEqual(CLASS_GATE_BLEND.S.minBlendEvPct!);
      expect(gate.outcome).toBe("done");
    });

    it("M: no EV%% requirement — a candidate clearing only the 1.5pt edge bar passes even at the wModel floor (0.15)", () => {
      const q = { q: 1 / 2.5, devigged: false };
      const gate = gateAllMarkets(0.51, q, 2.5, "M", {}, { blendPricing: true });
      expect(CLASS_GATE_BLEND.M.minBlendEvPct).toBeNull();
      expect(gate.wModel).toBeCloseTo(0.15, 5); // completeness/hasRealXg omitted ⇒ floor
      expect(gate.rawEdge).toBeLessThan(0.12);
      expect(gate.adjustedEdgeBlend).toBeGreaterThanOrEqual(CLASS_GATE_BLEND.M.minAdjEdgeBlend);
      expect(gate.blendEV).toBeGreaterThan(0); // still clears the universal EV floor (evFloor default 0)
      expect(gate.outcome).toBe("done");
    });

    it("L: adjEdgeBlend>=2.0pt AND blendEV>=8% — clears both at wModel=0.40, comfortably under the raw caps", () => {
      const q = { q: 1 / 4.5, devigged: false };
      const gate = gateAllMarkets(
        0.3,
        q,
        4.5,
        "L",
        {},
        { blendPricing: true, completeness: 1, hasRealXg: true }
      );
      expect(gate.rawEdge).toBeLessThan(0.12);
      expect(gate.rawEdge! / q.q).toBeLessThan(0.4); // under the §5.4 relative cap ratio too
      expect(gate.adjustedEdgeBlend).toBeGreaterThanOrEqual(CLASS_GATE_BLEND.L.minAdjEdgeBlend);
      expect(gate.blendEV).toBeGreaterThanOrEqual(CLASS_GATE_BLEND.L.minBlendEvPct!);
      expect(gate.outcome).toBe("done");
    });

    it("X: the -5pt exotic penalty combined with the 12pt absolute raw-edge cap makes CLASS_GATE_BLEND.X structurally near-unreachable — DOCUMENTED CONTRADICTION, see report", () => {
      // At wModel's 0.40 ceiling (the most generous possible), rawEdgeBlend
      // tops out at 0.40 * 0.12 (the largest rawEdge that still avoids the
      // absolute cap) = 0.048 — already less than the 0.07 rawEdgeBlend the
      // -5pt (0.05) penalty requires just to clear X's 0.02 floor
      // (0.02 + 0.05 = 0.07). So adjustedEdgeBlend can never reach 0.02 for
      // any X candidate without first tripping the (blend-independent)
      // absolute cap. This is a direct consequence of implementing the task
      // spec literally ("adjustedEdgeBlend = rawEdgeBlend − penaltyPts, SAME
      // penalty table" + caps always on raw edge) — flagged for owner review
      // rather than silently rescaled to make X reachable.
      const maxNonCappedRawEdge = 0.12; // V3_EDGE_CAP_DEFAULT (not exported; mirrors evGate.ts's own header doc "Raw > 12pts ⇒ capped")
      const maxWModel = 0.4; // V3_BLEND_W_CAP
      const maxPossibleRawEdgeBlend = maxWModel * maxNonCappedRawEdge;
      const exoticPenalty = 0.05;
      expect(maxPossibleRawEdgeBlend - exoticPenalty).toBeLessThan(
        CLASS_GATE_BLEND.X.minAdjEdgeBlend
      );

      // Concretely: push rawEdge right up to (but under) BOTH the absolute
      // 12pt cap AND X's stricter 30%% relative-cap ratio (q=0.4 keeps
      // rawEdge/q at 0.115/0.4=0.2875 < 0.3), wModel at its ceiling — still
      // below_gate, never "done".
      const q = { q: 0.4, devigged: true };
      const gate = gateAllMarkets(
        0.515, // rawEdge = 0.115: under the 0.12 absolute cap AND the 0.3 relative ratio
        q,
        6.5,
        "X",
        { exoticClass: true },
        { blendPricing: true, completeness: 1, hasRealXg: true }
      );
      expect(gate.rawEdge).toBeLessThan(0.12);
      expect(gate.rawEdge! / q.q).toBeLessThan(0.3);
      expect(gate.outcome).not.toBe("capped"); // confirms the caps genuinely didn't fire here
      expect(gate.penaltyPts).toBeCloseTo(0.05, 5);
      expect(gate.adjustedEdgeBlend).toBeCloseTo(gate.rawEdgeBlend! - gate.penaltyPts, 10);
      expect(gate.adjustedEdgeBlend).toBeLessThan(CLASS_GATE_BLEND.X.minAdjEdgeBlend);
      expect(gate.outcome).toBe("below_gate");
      expect(gate.gateReason).toBe("class_edge");
    });

    it("X: odds above 15 fails max_odds (independent of the edge/EV bars, same as the legacy raw gate)", () => {
      // Small, cap-avoiding edge (rawEdge=0.05, rawEdge/q=0.1 well under the
      // 0.3 X relative ratio) so max_odds is reachable without a cap firing
      // first — the point being demonstrated is odds>15 alone, not the edge
      // bars (already covered by the contradiction test above).
      const q = { q: 0.5, devigged: true };
      const gate = gateAllMarkets(
        0.555,
        q,
        18,
        "X",
        {},
        { blendPricing: true, completeness: 1, hasRealXg: true }
      );
      expect(gate.outcome).not.toBe("capped");
      expect(gate.adjustedEdgeBlend).toBeGreaterThanOrEqual(CLASS_GATE_BLEND.X.minAdjEdgeBlend);
      expect(gate.blendEV).toBeGreaterThanOrEqual(CLASS_GATE_BLEND.X.minBlendEvPct!);
      expect(gate.outcome).toBe("below_gate");
      expect(gate.gateReason).toBe("max_odds");
    });
  });

  describe("CLASS_GATE_BLEND_HEIGHTENED — X excluded, S/M/L stricter (×1.30 of the base blend bars)", () => {
    it("bars are exactly 1.30x the base CLASS_GATE_BLEND bars for S/M/L", () => {
      for (const cls of ["S", "M", "L"] as const) {
        const base = CLASS_GATE_BLEND[cls];
        const heightened = CLASS_GATE_BLEND_HEIGHTENED[cls]!;
        expect(heightened.minAdjEdgeBlend).toBeCloseTo(base.minAdjEdgeBlend * 1.3, 10);
        if (base.minBlendEvPct !== null) {
          expect(heightened.minBlendEvPct).toBeCloseTo(base.minBlendEvPct * 1.3, 10);
        } else {
          expect(heightened.minBlendEvPct).toBeNull();
        }
      }
    });

    it("X is excluded entirely under heightened blend bars", () => {
      expect(CLASS_GATE_BLEND_HEIGHTENED.X).toBeNull();
      const q = { q: 0.06, devigged: true };
      const gate = gateAllMarkets(
        0.5,
        q,
        6,
        "X",
        {},
        { blendPricing: true, heightened: true, completeness: 1, hasRealXg: true }
      );
      expect(gate.outcome).toBe("below_gate");
      expect(gate.gateReason).toBe("heightened_x_excluded");
    });

    it("a candidate clearing the base M blend bar (0.015) but not the heightened one (0.0195) is rejected only when heightened", () => {
      // wModel floor (0.15) at q=1/2.5, modelP=0.51: adjustedEdgeBlend ≈
      // 0.0165 — clears the base M bar (0.015) but falls short of the
      // heightened M bar (0.0195), a real "clears normal, fails heightened"
      // straddle rather than a hypothetical one.
      const q = { q: 1 / 2.5, devigged: false };
      const normal = gateAllMarkets(0.51, q, 2.5, "M", {}, { blendPricing: true });
      const heightened = gateAllMarkets(
        0.51,
        q,
        2.5,
        "M",
        {},
        { blendPricing: true, heightened: true }
      );
      expect(normal.adjustedEdgeBlend).toBeCloseTo(heightened.adjustedEdgeBlend!, 10); // same raw/blend math
      expect(normal.adjustedEdgeBlend!).toBeGreaterThanOrEqual(CLASS_GATE_BLEND.M.minAdjEdgeBlend);
      expect(normal.adjustedEdgeBlend!).toBeLessThan(
        CLASS_GATE_BLEND_HEIGHTENED.M!.minAdjEdgeBlend
      );
      expect(normal.outcome).toBe("done");
      expect(heightened.outcome).toBe("below_gate");
      expect(heightened.gateReason).toBe("class_edge");
    });
  });

  it("the pre-existing odds>=4.00 blendMode='on' blendEdge gate is STILL enforced alongside blendPricing (legacy raw path — see the DOCUMENTED FINDING below for why it's unreachable as a distinct failure on the blend-pricing path itself)", () => {
    // Reuses the exact blendMode='on' hot-longshot scenario from the
    // pre-existing describe block above (odds 4.5, q=0.20, modelP=0.27,
    // Class L) with blendPricing ALSO on. Under blendPricing, this
    // candidate's OWN blend class bars reject it first (adjustedEdgeBlend
    // 1.05pt < L's 2.0pt floor at the wModel floor) — gateReason is
    // "class_edge", not "model_hot_longshot". DOCUMENTED FINDING: this isn't
    // test miscalibration — it's structural. blendEdge and blendEV are the
    // SAME number (both pBlend*odds-1); L/X's own blendEV floors (8%/12%)
    // are both ABOVE the mandatory odds>=4.00 bar's 5% threshold, so any L/X
    // candidate that clears its OWN class bar under blendPricing has, by
    // construction, already cleared the mandatory bar too — "model_hot_longshot"
    // becomes structurally unreachable on the blendPricing path for L/X
    // (S/M never reach odds>=4.00 at all — S<=1.50, M<=3.00). The mandatory
    // gate still fires exactly as before on the LEGACY raw-pricing path
    // (see "(b) blendMode='on' vetoes..." above, unaffected by this change).
    const q = { q: 0.2, devigged: true };
    const legacyPath = gateAllMarkets(
      0.27,
      q,
      4.5,
      "L",
      {},
      { blendMode: "on", completeness: 0, hasRealXg: false } // blendPricing OFF — legacy raw class bars
    );
    expect(legacyPath.outcome).toBe("below_gate");
    expect(legacyPath.gateReason).toBe("model_hot_longshot"); // unaffected, as before

    const blendPricingPath = gateAllMarkets(
      0.27,
      q,
      4.5,
      "L",
      {},
      { blendMode: "on", blendPricing: true, completeness: 0, hasRealXg: false }
    );
    expect(blendPricingPath.blendGatePass).toBe(false); // the mandatory bar itself still fails...
    expect(blendPricingPath.outcome).toBe("below_gate");
    expect(blendPricingPath.gateReason).toBe("class_edge"); // ...but the OWN class bar fails first
  });
});
