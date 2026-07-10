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

import { gateAllMarkets, impliedQ } from "@oracle/engine";
import { describe, expect, it } from "vitest";
import {
  computeMarketBlend,
  V3_BLEND_GATE_ODDS_FLOOR,
  V3_BLEND_MIN_EDGE,
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
