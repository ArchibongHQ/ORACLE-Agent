/** all-markets-analysis-prompt-v3 — Phase 2 core deterministic engine tests.
 *  Anchored to the spec's own worked examples (DNB 64.9% discard, 1H Under 1.5
 *  70.2% noise-band discard, Over 2.5 +8.5pts done) plus per-engine unit coverage. */

import {
  type AllMarketEntry,
  blendEmpirical,
  buildV3Grid,
  buildV3HalfGrid,
  CLASS_GATE,
  CLASS_GATE_HEIGHTENED,
  classifyMarket,
  computeTailMarkets,
  deriveDualSplit,
  EMPIRICAL_BLEND_W,
  gateAllMarkets,
  goalsSlateSanityChecks,
  impliedQ,
  minuteShare,
  parseOUDesc,
  poissonPMF,
  priceExoticsOutcome,
  priceOU,
  priceShapeOutcome,
  priceTimeWindow,
  priceTotalsOutcome,
  resultProbs,
  routeCoverage,
  routeMarket,
  slateSanityChecks,
  sumWhere,
  V3_MINUTE_SHARE_TABLE,
  type V3EngineCtx,
  v3Confidence,
  winPushSplit,
} from "@oracle/engine";
import { describe, expect, it } from "vitest";

// ── grid.ts ────────────────────────────────────────────────────────────────

describe("grid (§3.1/§3.4)", () => {
  it("resultProbs sums 1X2 to 1 and matches a hand-computable low-score grid", () => {
    const mat = buildV3Grid(1.5, 1.0, 0);
    const { pHome, pDraw, pAway } = resultProbs(mat);
    expect(pHome + pDraw + pAway).toBeCloseTo(1, 5);
    expect(pHome).toBeGreaterThan(pAway); // stronger home lambda
  });

  it("winPushSplit finds a nonzero push at a whole-ball line", () => {
    const mat = buildV3Grid(1.4, 1.1, 0.08);
    const { pWin, pPush } = winPushSplit(mat, (h, a) => h - a); // DNB-style margin, line 0
    expect(pPush).toBeGreaterThan(0);
    expect(pWin + pPush).toBeLessThanOrEqual(1.001);
  });

  it("sumWhere over/under partition sums to ~1 across the full ladder", () => {
    const mat = buildV3Grid(1.5, 1.2, 0);
    const over = sumWhere(mat, (h, a) => h + a > 2.5);
    const under = sumWhere(mat, (h, a) => h + a < 2.5);
    expect(over + under).toBeCloseTo(1, 2);
  });

  it("buildV3HalfGrid produces a valid probability grid (rho=0, plain Poisson)", () => {
    const mat = buildV3HalfGrid(0.6, 0.5);
    let total = 0;
    for (const row of mat) for (const p of row) total += p;
    expect(total).toBeCloseTo(1, 2);
  });
});

// ── evGate.ts — spec worked examples ────────────────────────────────────────

describe("evGate — spec §5 worked examples", () => {
  // The spec's WORKED EXAMPLES prose gives illustrative model-P/q PAIRS that
  // don't always reconcile bit-exact against a real devig formula applied to
  // its example odds (rounding in the prose) — so most of these tests feed
  // the spec's own P/q numbers straight into the gate to verify the GATE
  // ARITHMETIC (raw/adjusted/tiering), which is exact. Where a test uses a
  // real odds pair, q is the ACTUAL additive de-vig of those odds (the method
  // the live code has always used — see markets/devig.ts), not an
  // approximation.
  it("Class S (1H Under 1.5): model 70.2% vs the real additive de-vig of 1.36/3.05 (q=70.4%) → near-zero raw edge, noise-band discard", () => {
    // q = additive de-vig of odds 1.36/3.05 (margin/2 subtracted from each
    // side) — matches all-markets-analysis-prompt-v4.md §4.1's worked example.
    // An earlier draft of this fixture used q=0.666 (a de-vig arithmetic
    // error), then the doc briefly stated q=0.692 via the multiplicative
    // formula that the live code has never used — both superseded.
    const q = { q: 0.704, devigged: true };
    const gate = gateAllMarkets(0.702, q, 1.36, "S", { xgMissing: true });
    expect(gate.rawEdge).toBeCloseTo(-0.002, 3);
    expect(gate.adjustedEdge).toBeCloseTo(-0.022, 3);
    expect(gate.outcome).toBe("noise");
  });

  it("Class S: a real edge that clears the noise band can still fail the S gate on inadequate adjusted edge", () => {
    // Illustrative pair (not tied to a specific doc example) covering the
    // below_gate-via-insufficient-edge path distinctly from the noise-band
    // case above.
    const q = { q: 0.704, devigged: true };
    const gate = gateAllMarkets(0.73, q, 1.36, "S", { xgMissing: true });
    expect(gate.rawEdge).toBeCloseTo(0.026, 3);
    expect(gate.adjustedEdge).toBeCloseTo(0.006, 3);
    expect(gate.outcome).toBe("below_gate");
  });

  it("Class M (Over 2.5): μ=3.15 model 61.0% vs q 49.5% raw +11.5, −3pt penalty → +8.5pts, High, done", () => {
    const q = impliedQ(1.89, 1.85)!;
    expect(q.q).toBeCloseTo(0.495, 2);
    // Spec's own worked example applies a 3pt penalty (unspecified flags) —
    // reproduce with 3 x 1pt flags to land on the same adjusted edge.
    const gate = gateAllMarkets(0.61, q, 1.89, "M", {
      h2hMissing: true,
      restEstimated: true,
      lineupsUnconfirmed: true,
    });
    expect(gate.rawEdge).toBeCloseTo(0.115, 2); // < 12pt cap
    expect(gate.adjustedEdge).toBeCloseTo(0.085, 2);
    expect(gate.outcome).toBe("done");
    expect(gate.confidence).toBe("high");
  });

  it("DNB worked example: conditional p′=64.9% vs de-vigged q=65.5% → raw −0.6pts, noise-band discard", () => {
    const q = { q: 0.655, devigged: true };
    const gate = gateAllMarkets(0.649, q, 1.45, "S", {});
    expect(gate.rawEdge).toBeCloseTo(-0.006, 3);
    expect(gate.outcome).toBe("noise");
  });

  it("§5.4 absolute cap: raw edge > 12pts is capped regardless of class", () => {
    const q = { q: 0.3, devigged: true };
    const gate = gateAllMarkets(0.5, q, 3.2, "M", {}); // raw = 0.2 > 0.12
    expect(gate.outcome).toBe("capped");
    expect(gate.capReason).toBe("absolute");
  });

  it("§5.4 relative cap: odds > 3.00 and raw/q > 40% is capped (30% for exotics)", () => {
    const q = { q: 0.1, devigged: false };
    const gate = gateAllMarkets(0.15, q, 4.0, "L", {}); // raw=0.05, raw/q=50% > 40%
    expect(gate.outcome).toBe("capped");
    expect(gate.capReason).toBe("relative");

    const exoticGate = gateAllMarkets(0.132, q, 4.0, "X", {}); // raw=0.032, raw/q=32%>30% but <40%
    expect(exoticGate.outcome).toBe("capped");
    expect(exoticGate.capReason).toBe("relative");
  });

  it("Class X requires odds ≤ 15 even with a qualifying edge (raw/q at the 0.30 cap boundary, not capped)", () => {
    const q = { q: 0.2, devigged: true };
    const gate = gateAllMarkets(0.26, q, 20, "X", {}); // raw=0.06, raw/q=0.30 (not >0.30)
    expect(gate.capReason).toBeUndefined();
    expect(gate.adjustedEdge).toBeCloseTo(0.06, 5);
    expect(gate.adjEvPct).toBeCloseTo(0.3, 5);
    expect(gate.outcome).toBe("below_gate"); // odds 20 > maxOdds 15
  });

  it("exotics class penalty (−5pts) can push a borderline X candidate below its own gate", () => {
    const q = { q: 0.06, devigged: false };
    const withoutPenalty = gateAllMarkets(0.16, q, 10, "X", {});
    const withPenalty = gateAllMarkets(0.16, q, 10, "X", { exoticClass: true });
    expect(withPenalty.adjustedEdge).toBeLessThan(withoutPenalty.adjustedEdge);
  });

  it("[PR-8 xG pin] estimated-xG costs exactly −1pt and is never discarded by the gate", () => {
    // A fixture whose xG was estimated (AI-Mode-sourced) reaches the gate with the
    // xgEstimated penalty flag. The −1pt must not turn a healthy candidate into a
    // discard — estimated xG is a soft penalty, not a hard reject condition.
    const q = { q: 0.5, devigged: true };
    const clean = gateAllMarkets(0.62, q, 2.0, "M", {});
    const estimated = gateAllMarkets(0.62, q, 2.0, "M", { xgEstimated: true });
    // Exactly one point of penalty relative to the clean case.
    expect(estimated.penaltyPts - clean.penaltyPts).toBeCloseTo(0.01, 10);
    expect(estimated.adjustedEdge).toBeCloseTo(clean.adjustedEdge - 0.01, 10);
    // Still a live candidate — not discarded (capped/noise/below_gate) by the flag.
    expect(estimated.outcome).toBe("done");
    expect(estimated.confidence).not.toBeNull();
  });

  it("v3Confidence: Class S reads EV%, other classes read adjusted edge", () => {
    expect(v3Confidence("S", 0.02, 0.11)).toBe("very_high"); // EV% 11% ≥10
    expect(v3Confidence("S", 0.02, 0.02)).toBeNull(); // below the 4% EV floor
    expect(v3Confidence("M", 0.11, 0)).toBe("very_high");
    expect(v3Confidence("X", 0.065, 0)).toBe("medium"); // X's medium floor is 6pts
  });

  it("CLASS_GATE thresholds match the spec table", () => {
    expect(CLASS_GATE.S).toMatchObject({ minAdjEdge: 0.03, minAdjEvPct: 0.04 });
    expect(CLASS_GATE.M).toMatchObject({ minAdjEdge: 0.05, minAdjEvPct: null });
    expect(CLASS_GATE.L).toMatchObject({ minAdjEdge: 0.06, minAdjEvPct: 0.15 });
    expect(CLASS_GATE.X).toMatchObject({ minAdjEdge: 0.06, minAdjEvPct: 0.2, maxOdds: 15 });
  });

  it("[audit fix] the true-EV floor rejects a -EV pick that would otherwise clear the S-class points/EV% gate", () => {
    // Odds 1.40 @ ~8% margin (opposite side 2.734), model p=0.706 — clears
    // Class S on rawEdge/adjEvPct alone (3.17pts / 4.7%) but true EV at the
    // offered price is 0.706*1.40-1 = -1.16%. Confirmed the pre-fix live code
    // returned "done" here; the floor must now reject it.
    const q = impliedQ(1.4, 2.734)!;
    expect(q.q).toBeCloseTo(0.6743, 3);
    const gate = gateAllMarkets(0.706, q, 1.4, "S", {});
    expect(gate.rawEdge).toBeCloseTo(0.0317, 3);
    expect(gate.adjEvPct).toBeCloseTo(0.047, 2);
    expect(gate.ev).toBeCloseTo(-0.0116, 3);
    expect(gate.outcome).toBe("below_gate");
  });
});

// ── v4 heightened gates (PR-3) ──────────────────────────────────────────────

describe("gateAllMarkets — v4 heightened bars (PR-3)", () => {
  it("CLASS_GATE_HEIGHTENED thresholds match the spec table, X is null (excluded)", () => {
    expect(CLASS_GATE_HEIGHTENED.S).toMatchObject({ minAdjEdge: 0.05, minAdjEvPct: 0.07 });
    expect(CLASS_GATE_HEIGHTENED.M).toMatchObject({ minAdjEdge: 0.08, minAdjEvPct: null });
    expect(CLASS_GATE_HEIGHTENED.L).toMatchObject({ minAdjEdge: 0.09, minAdjEvPct: 0.2 });
    expect(CLASS_GATE_HEIGHTENED.X).toBeNull();
  });

  it("excludes class X entirely under heightened, regardless of how strong the edge is", () => {
    const q = { q: 0.1, devigged: true };
    const gate = gateAllMarkets(0.5, q, 5, "X", {}, { heightened: true });
    expect(gate.outcome).toBe("below_gate");
    expect(gate.confidence).toBeNull();
  });

  it("a Class M edge of 6pts passes non-heightened but fails heightened (8pt bar)", () => {
    const q = { q: 0.4, devigged: true };
    const normal = gateAllMarkets(0.46, q, 2.2, "M", {}, {});
    expect(normal.outcome).toBe("done");

    const heightened = gateAllMarkets(0.46, q, 2.2, "M", {}, { heightened: true });
    expect(heightened.outcome).toBe("below_gate");
  });

  it("Class S needs both 5pt edge AND 7% EV% under heightened (vs 3pt/4% non-heightened)", () => {
    const q = { q: 0.5, devigged: true };
    // 4pt edge, 8% EV% — clears non-heightened (3pt/4%) but fails heightened's 5pt floor.
    const gate = gateAllMarkets(0.54, q, 2.0, "S", {}, { heightened: true });
    expect(gate.adjustedEdge).toBeCloseTo(0.04, 5);
    expect(gate.outcome).toBe("below_gate");
  });

  it("Class L clears the heightened bar (9pt edge, 20% EV%) with odds fixed to avoid a relative cap", () => {
    // 11pt edge / 50% q clears both the 9pt heightened floor and the 20% EV%
    // bar with margin — deliberately not pinned to either threshold exactly,
    // since 0.6-0.5 !== 0.1 in IEEE-754 float (lands just under 0.2 EV%).
    const q = { q: 0.5, devigged: true };
    const gate = gateAllMarkets(0.61, q, 2.0, "L", {}, { heightened: true });
    expect(gate.adjustedEdge).toBeCloseTo(0.11, 5);
    expect(gate.outcome).toBe("done");
  });

  it("defaults to standard (non-heightened) gates when the opt is omitted", () => {
    const q = { q: 0.4, devigged: true };
    const gate = gateAllMarkets(0.46, q, 2.2, "M", {});
    expect(gate.outcome).toBe("done");
  });
});

// ── exotics engine (§3.8) — exact-goals / multigoals routing + pricing ─────

describe("priceExoticsOutcome — exact-goals & multigoals (PR-3)", () => {
  const ctx: V3EngineCtx = (() => {
    const statsGrid = buildV3Grid(1.5, 1.2, 0.08);
    const half = buildV3HalfGrid(0.75, 0.6);
    return {
      statsGrid,
      shapeGrid: statsGrid,
      mu: 2.7,
      split: {} as V3EngineCtx["split"],
      fhShare: 0.44,
      fhShareIsDefault: true,
      halfStats: [half, half],
      halfShape: [half, half],
      empirical: {},
    };
  })();

  it('prices exact_goals "2" as the sum of every cell where i+j===2', () => {
    const expected = sumWhere(ctx.statsGrid, (h, a) => h + a === 2);
    const price = priceExoticsOutcome(
      ctx,
      { engine: "exotics", family: "exact_goals" },
      "Exact Goals",
      "2"
    );
    expect(price?.p).toBeCloseTo(expected, 10);
  });

  it('prices exact_goals "2-3 goals" as the sum of cells where i+j in [2,3]', () => {
    const expected = sumWhere(ctx.statsGrid, (h, a) => h + a >= 2 && h + a <= 3);
    const price = priceExoticsOutcome(
      ctx,
      { engine: "exotics", family: "exact_goals" },
      "Exact Goals",
      "2-3 goals"
    );
    expect(price?.p).toBeCloseTo(expected, 10);
  });

  it('BUG FIX regression: prices exact_goals "6+" (catalog id 21) as P(total>=6), not P(total===6)', () => {
    const expectedTail = sumWhere(ctx.statsGrid, (h, a) => h + a >= 6);
    const expectedExact = sumWhere(ctx.statsGrid, (h, a) => h + a === 6);
    // The two must actually differ for this test to prove anything (true on
    // any non-degenerate grid — there's real mass above 6 goals).
    expect(expectedTail).toBeGreaterThan(expectedExact);

    const price = priceExoticsOutcome(
      ctx,
      { engine: "exotics", family: "exact_goals" },
      "Exact Goals",
      "6+"
    );
    expect(price?.p).toBeCloseTo(expectedTail, 10);
  });

  it('prices "3+" (catalog id 21, match-total Exact Goals) as an open-ended tail over the WHOLE match', () => {
    const expected = sumWhere(ctx.statsGrid, (h, a) => h + a >= 3);
    const price = priceExoticsOutcome(
      ctx,
      { engine: "exotics", family: "exact_goals" },
      "Exact Goals",
      "3+"
    );
    expect(price?.p).toBeCloseTo(expected, 10);
  });

  it('BUG FIX regression: "Home/Away Team Exact Goals" (catalog ids 23/24) prices only that TEAM\'s axis, not the match total', () => {
    const expectedHome = sumWhere(ctx.statsGrid, (h) => h >= 3);
    const expectedAway = sumWhere(ctx.statsGrid, (_h, a) => a >= 3);
    const expectedMatchTotal = sumWhere(ctx.statsGrid, (h, a) => h + a >= 3);
    // The team-axis and match-total tails must actually differ for this test
    // to prove anything (true on any non-degenerate grid).
    expect(expectedHome).not.toBeCloseTo(expectedMatchTotal, 5);

    const homePrice = priceExoticsOutcome(
      ctx,
      { engine: "exotics", family: "exact_goals", side: "home" },
      "Home Team Exact Goals",
      "3+"
    );
    expect(homePrice?.p).toBeCloseTo(expectedHome, 10);

    const awayPrice = priceExoticsOutcome(
      ctx,
      { engine: "exotics", family: "exact_goals", side: "away" },
      "Away Team Exact Goals",
      "3+"
    );
    expect(awayPrice?.p).toBeCloseTo(expectedAway, 10);
  });

  it('BUG FIX regression: "Home/Away Team Exact Goals" (ids 23/24) prices the closed-range/exact-value branch (non-"+" outcomes "0"/"1"/"2") against that team\'s own axis too, not just the "3+" tail', () => {
    const expectedHome1 = sumWhere(ctx.statsGrid, (h) => h === 1);
    const expectedAway0 = sumWhere(ctx.statsGrid, (_h, a) => a === 0);
    const expectedMatchTotal1 = sumWhere(ctx.statsGrid, (h, a) => h + a === 1);
    expect(expectedHome1).not.toBeCloseTo(expectedMatchTotal1, 5);

    const homePrice = priceExoticsOutcome(
      ctx,
      { engine: "exotics", family: "exact_goals", side: "home" },
      "Home Team Exact Goals",
      "1"
    );
    expect(homePrice?.p).toBeCloseTo(expectedHome1, 10);

    const awayPrice = priceExoticsOutcome(
      ctx,
      { engine: "exotics", family: "exact_goals", side: "away" },
      "Away Team Exact Goals",
      "0"
    );
    expect(awayPrice?.p).toBeCloseTo(expectedAway0, 10);
  });

  it('prices compound "1-3+" (catalog id 450002, Goal Bounds) as P(total>=1) — the trailing + on the upper end makes it open-ended', () => {
    const expected = sumWhere(ctx.statsGrid, (h, a) => h + a >= 1);
    const price = priceExoticsOutcome(
      ctx,
      { engine: "exotics", family: "exact_goals" },
      "Goal Bounds",
      "1-3+"
    );
    expect(price?.p).toBeCloseTo(expected, 10);
  });

  it("prices multigoals from a structured from/to route specifier (not desc text)", () => {
    const expected = sumWhere(ctx.statsGrid, (h, a) => h + a >= 2 && h + a <= 4);
    const price = priceExoticsOutcome(
      ctx,
      { engine: "exotics", family: "multigoals", from: 2, to: 4 },
      "Multigoals",
      "anything" // ignored — multigoals reads route.from/to, not desc
    );
    expect(price?.p).toBeCloseTo(expected, 10);
  });

  it("returns null for multigoals with neither from nor to specified", () => {
    const price = priceExoticsOutcome(
      ctx,
      { engine: "exotics", family: "multigoals" },
      "Multigoals",
      "anything"
    );
    expect(price).toBeNull();
  });

  it("prices a correct score cell exactly", () => {
    const expected = sumWhere(ctx.statsGrid, (h, a) => h === 2 && a === 1);
    const price = priceExoticsOutcome(
      ctx,
      { engine: "exotics", family: "correct_score" },
      "Correct Score",
      "2-1"
    );
    expect(price?.p).toBeCloseTo(expected, 10);
  });
});

// ── engines/types.ts — sample-scaled empirical blend (PR-3) ────────────────

describe("blendEmpirical — sample-scaled weight (PR-3)", () => {
  it("falls back to a flat 0.3 weight when n is omitted (unchanged pre-PR-3 behavior)", () => {
    const blended = blendEmpirical(0.5, 0.7);
    expect(blended).toBeCloseTo(0.5 * (1 - EMPIRICAL_BLEND_W) + 0.7 * EMPIRICAL_BLEND_W, 10);
  });

  it("reproduces the flat 0.3 weight exactly at n=5 (the common full-sample case)", () => {
    const flat = blendEmpirical(0.5, 0.7);
    const atFive = blendEmpirical(0.5, 0.7, 5);
    expect(atFive).toBeCloseTo(flat, 10);
  });

  it("scales the weight down for a thin sample: n=1 → w=0.06 instead of 0.3", () => {
    const model = 0.5;
    const empirical = 0.7;
    const blended = blendEmpirical(model, empirical, 1);
    const expectedW = 0.3 * (1 / 5);
    expect(blended).toBeCloseTo(model * (1 - expectedW) + empirical * expectedW, 10);
    // A thinner sample pulls less toward the empirical rate than the flat blend.
    expect(Math.abs(blended - model)).toBeLessThan(
      Math.abs(blendEmpirical(model, empirical) - model)
    );
  });

  it("n=0 means zero blend weight — model-only", () => {
    expect(blendEmpirical(0.5, 0.7, 0)).toBeCloseTo(0.5, 10);
  });

  it("returns model unchanged when empirical is undefined, regardless of n", () => {
    expect(blendEmpirical(0.42, undefined, 5)).toBe(0.42);
  });
});

// ── shape engine — FTS% wired into team-total blends (PR-3) ────────────────

describe("priceShapeOutcome — FTS% team-total blend (PR-3)", () => {
  const shapeCtx = (empirical: V3EngineCtx["empirical"]): V3EngineCtx => {
    const grid = buildV3Grid(1.4, 1.1, 0.08);
    const half = buildV3HalfGrid(0.7, 0.55);
    return {
      statsGrid: grid,
      shapeGrid: grid,
      mu: 2.5,
      split: {} as V3EngineCtx["split"],
      fhShare: 0.44,
      fhShareIsDefault: true,
      halfStats: [half, half],
      halfShape: [half, half],
      empirical,
    };
  };

  it("blends FTS% into Team Total Under 0.5 (the line FTS% actually measures) and flags nothing missing", () => {
    const ctx = shapeCtx({ ftsPctH: 0.4, nH: 5 });
    const modelOnly = priceShapeOutcome(
      shapeCtx({}),
      { engine: "shape", family: "team_total" },
      "Home Total",
      "under 0.5"
    );
    const blended = priceShapeOutcome(
      ctx,
      { engine: "shape", family: "team_total" },
      "Home Total",
      "under 0.5"
    );
    expect(blended?.marketStatMissing).toBe(false);
    expect(modelOnly?.marketStatMissing).toBe(true);
    // n=5 (full sample) reproduces the flat 0.3 weight exactly: 0.7·model + 0.3·FTS%.
    expect(blended?.p).toBeCloseTo(modelOnly!.p * 0.7 + 0.4 * 0.3, 5);
  });

  it("derives the Over 0.5 empirical rate as 1 - FTS% (complementary side of the same line)", () => {
    const ctx = shapeCtx({ ftsPctH: 0.4, nH: 5 });
    const modelOnly = priceShapeOutcome(
      shapeCtx({}),
      { engine: "shape", family: "team_total" },
      "Home Total",
      "over 0.5"
    );
    const blended = priceShapeOutcome(
      ctx,
      { engine: "shape", family: "team_total" },
      "Home Total",
      "over 0.5"
    );
    expect(blended?.p).toBeCloseTo(modelOnly!.p * 0.7 + 0.6 * 0.3, 5);
  });

  it("leaves non-0.5 team-total lines model-only (FTS% doesn't map to those thresholds)", () => {
    const ctx = shapeCtx({ ftsPctH: 0.3, nH: 5 });
    const price = priceShapeOutcome(
      ctx,
      { engine: "shape", family: "team_total" },
      "Home Total",
      "over 1.5"
    );
    expect(price?.marketStatMissing).toBeUndefined();
  });

  it("a thin recent-form sample (nH=1) pulls the blend less toward FTS% than a full sample (nH=5)", () => {
    const thin = priceShapeOutcome(
      shapeCtx({ ftsPctH: 0.9, nH: 1 }),
      { engine: "shape", family: "team_total" },
      "Home Total",
      "under 0.5"
    );
    const full = priceShapeOutcome(
      shapeCtx({ ftsPctH: 0.9, nH: 5 }),
      { engine: "shape", family: "team_total" },
      "Home Total",
      "under 0.5"
    );
    const modelOnly = priceShapeOutcome(
      shapeCtx({}),
      { engine: "shape", family: "team_total" },
      "Home Total",
      "under 0.5"
    );
    expect(Math.abs(thin!.p - modelOnly!.p)).toBeLessThan(Math.abs(full!.p - modelOnly!.p));
  });
});

// ── sanity.ts — slate-level sanity checks (PR-3) ────────────────────────────

describe("slateSanityChecks / goalsSlateSanityChecks (PR-3)", () => {
  it("a slate with zero >5pt signals and zero capped reports no flags, no NaN", () => {
    const assessments = [
      { outcome: "noise" as const, rawEdge: 0.01, family: "goals_ou", desc: "Over 2.5" },
      { outcome: "below_gate" as const, rawEdge: 0.02, family: "dnb", desc: "Home" },
    ];
    const result = slateSanityChecks(assessments);
    expect(result.flags).toEqual([]);
    expect(result.capRate).toBeNull();
    expect(Number.isNaN(result.capRate as unknown as number)).toBe(false);
  });

  it("flags model_miscalibration when capped/(capped+hotDone) exceeds 25%", () => {
    const assessments = [
      { outcome: "capped" as const, rawEdge: 0.15, family: "goals_ou", desc: "Over 2.5" },
      { outcome: "capped" as const, rawEdge: 0.14, family: "goals_ou", desc: "Under 2.5" },
      { outcome: "done" as const, rawEdge: 0.06, family: "goals_ou", desc: "Over 1.5" },
    ];
    const result = slateSanityChecks(assessments);
    expect(result.capRate).toBeCloseTo(2 / 3, 5);
    expect(result.flags).toContain("model_miscalibration");
  });

  it("flags result_skew_home when ≥70% of DONE result-family picks are Home", () => {
    const assessments = [
      { outcome: "done" as const, rawEdge: 0.06, family: "dnb", desc: "Home" },
      { outcome: "done" as const, rawEdge: 0.06, family: "double_chance", desc: "Home or Draw" },
      { outcome: "done" as const, rawEdge: 0.06, family: "handicap", desc: "Home -1" },
      { outcome: "done" as const, rawEdge: 0.06, family: "dnb", desc: "Away" },
    ];
    const result = slateSanityChecks(assessments);
    expect(result.resultHomeShare).toBeCloseTo(0.75, 5);
    expect(result.flags).toContain("result_skew_home");
  });

  it("flags totals_skew_over when ≥70% of DONE totals-family picks are Over", () => {
    const assessments = [
      { outcome: "done" as const, rawEdge: 0.06, family: "goals_ou", desc: "Over 2.5" },
      { outcome: "done" as const, rawEdge: 0.06, family: "goals_ou", desc: "Over 1.5" },
      {
        outcome: "done" as const,
        rawEdge: 0.06,
        family: "team_total",
        desc: "Home Total Over 0.5",
      },
      { outcome: "done" as const, rawEdge: 0.06, family: "goals_ou", desc: "Under 3.5" },
    ];
    const result = slateSanityChecks(assessments);
    expect(result.totalsOverShare).toBeCloseTo(0.75, 5);
    expect(result.flags).toContain("totals_skew_over");
  });

  it("goalsSlateSanityChecks never reports result-family flags (no b-check on the lean goals path)", () => {
    const assessments = [
      { outcome: "done" as const, rawEdge: 0.06, cat: "Goals O/U", label: "Over 2.5" },
      { outcome: "done" as const, rawEdge: 0.06, cat: "Goals O/U", label: "Over 1.5" },
      { outcome: "done" as const, rawEdge: 0.06, cat: "Team Total", label: "Home Total Over 0.5" },
    ];
    const result = goalsSlateSanityChecks(assessments);
    expect(result.resultHomeShare).toBeNull();
    expect(result.resultAwayShare).toBeNull();
    expect(result.totalsOverShare).toBeCloseTo(1, 5);
    expect(result.flags).toContain("totals_skew_over");
  });

  it("a heightened fixture whose only candidates are X reports zero survivors cleanly (valid outcome)", () => {
    const assessments = [
      { outcome: "below_gate" as const, rawEdge: 0.08, family: "correct_score", desc: "2-1" },
      { outcome: "below_gate" as const, rawEdge: 0.09, family: "ht_ft", desc: "Home/Home" },
    ];
    const result = slateSanityChecks(assessments);
    expect(result.flags).toEqual([]);
    expect(result.capRate).toBeNull();
  });
});

describe("impliedQ (§4.1)", () => {
  it("de-vigs a clean two-way pair (additive)", () => {
    const q = impliedQ(1.89, 1.85)!;
    expect(q.devigged).toBe(true);
    expect(q.q).toBeCloseTo(0.495, 2);
  });

  it("normalises a three-way outcome set (DC-style)", () => {
    const q = impliedQ(1.5, undefined, [1.5, 4.0, 5.0])!;
    expect(q.devigged).toBe(true);
    expect(q.q).toBeGreaterThan(0);
    expect(q.q).toBeLessThan(1 / 1.5); // devig always shrinks the raw 1/o
  });

  it("falls back to single-price 1/o with devigged=false when no pair/set given", () => {
    const q = impliedQ(4.0)!;
    expect(q.devigged).toBe(false);
    expect(q.q).toBeCloseTo(0.25, 5);
  });

  it("rejects invalid odds", () => {
    expect(impliedQ(0)).toBeNull();
    expect(impliedQ(1)).toBeNull();
  });
});

// ── classes.ts ───────────────────────────────────────────────────────────────

describe("classifyMarket (§4.2)", () => {
  it("buckets a non-exotic family by odds", () => {
    expect(classifyMarket("dnb", 1.4)).toBe("S");
    expect(classifyMarket("goals_ou", 2.0)).toBe("M");
    expect(classifyMarket("team_total", 5.0)).toBe("L");
  });
  it("structural X families are always X regardless of odds", () => {
    expect(classifyMarket("correct_score", 1.2)).toBe("X");
    expect(classifyMarket("combo", 20)).toBe("X");
  });
});

// ── split.ts ───────────────────────────────────────────────────────────────

describe("deriveDualSplit (§3.2 anti-circularity)", () => {
  it("flags shape disagreement when the odds-anchored share diverges >0.15 from the stats share", () => {
    const lambdas = {
      lambdaHome: 2.0,
      lambdaAway: 0.4,
      mu: 2.4,
      method: "multiplicative" as const,
      shrunk: false,
      xgBlended: false,
      leaguePerTeamAvg: 1.3,
    };
    // Odds imply a near-even match despite the stats split being lopsided.
    const split = deriveDualSplit(lambdas, { pHome: 0.36, pDraw: 0.28, pAway: 0.36 });
    expect(split.oddsSource).toBe("odds");
    expect(split.shareDelta).toBeGreaterThan(0.15);
    expect(split.shapeDisagreement).toBe(true);
  });

  it("no disagreement when devigged 1x2 is absent (falls back to the stats-derived ratio, delta=0)", () => {
    const lambdas = {
      lambdaHome: 1.5,
      lambdaAway: 1.0,
      mu: 2.5,
      method: "multiplicative" as const,
      shrunk: false,
      xgBlended: false,
      leaguePerTeamAvg: 1.3,
    };
    const split = deriveDualSplit(lambdas, null);
    expect(split.oddsSource).toBe("ratio");
    expect(split.shareDelta).toBeCloseTo(0, 9);
    expect(split.shapeDisagreement).toBe(false);
  });
});

// ── engines/time.ts §3.7 ─────────────────────────────────────────────────────

describe("time engine (§3.7)", () => {
  it("minute-share table matches the spec verbatim", () => {
    expect(V3_MINUTE_SHARE_TABLE).toEqual([
      [10, 0.08],
      [15, 0.13],
      [30, 0.29],
      [45, 0.44],
      [50, 0.52],
      [60, 0.61],
      [75, 0.79],
    ]);
  });

  it("minuteShare resolves to the nearest published cutoff at or above the minute", () => {
    expect(minuteShare(10)).toBeCloseTo(0.08, 5);
    expect(minuteShare(20)).toBeCloseTo(0.29, 5); // next cutoff at 30
    expect(minuteShare(80)).toBeCloseTo(0.79, 5); // beyond table → last known share
  });

  it("clean sheet first 10 minutes = e^(-0.08μ) (spec example shape)", () => {
    const mu = 2.6;
    const result = priceTimeWindow(mu, 10, "Under 0.5")!;
    expect(result.p).toBeCloseTo(Math.exp(-0.08 * mu), 5);
  });
});

// ── feedDictionary.ts §0.2 ───────────────────────────────────────────────────

describe("feedDictionary routing (§0.2)", () => {
  const entry = (over: Partial<AllMarketEntry>): AllMarketEntry => ({
    id: "18",
    name: "Over/Under",
    outcomes: [],
    ...over,
  });

  it("routes plain 1X2 to a skip (never a candidate, §3.4 mandate)", () => {
    const r = routeMarket(entry({ id: "1", name: "1X2" }));
    expect(r).toMatchObject({ skip: true, reason: "plain-1x2" });
  });

  it("routes Over/Under with an exact total= specifier to the totals engine", () => {
    const r = routeMarket(entry({ id: "18", name: "Over/Under", specifier: "total=2.5" }));
    expect(r).toMatchObject({ engine: "totals", family: "goals_ou", total: 2.5 });
  });

  it("routes a compound minsnr|total specifier to the time engine", () => {
    const r = routeMarket(
      entry({ id: "60180", name: "Over/Under - Early Goals", specifier: "minsnr=10|total=1.5" })
    );
    expect(r).toMatchObject({ engine: "time", minute: 10, total: 1.5 });
  });

  it("routes a handicap score= specifier (European) distinctly from Asian hcp=", () => {
    const r = routeMarket(entry({ id: "14", name: "Handicap", specifier: "hcp=0:1" }));
    expect(r).toMatchObject({ engine: "result", family: "handicap", hcpScore: [0, 1] });
  });

  it('BUG FIX regression: routes "Home/Away Team Exact Goals" (ids 23/24, PREFIX naming) with side set, plain "Exact Goals" (id 21) without', () => {
    expect(routeMarket(entry({ id: "23", name: "Home Team Exact Goals" }))).toMatchObject({
      engine: "exotics",
      family: "exact_goals",
      side: "home",
    });
    expect(routeMarket(entry({ id: "24", name: "Away Team Exact Goals" }))).toMatchObject({
      engine: "exotics",
      family: "exact_goals",
      side: "away",
    });
    const matchTotal = routeMarket(entry({ id: "21", name: "Exact Goals" }));
    expect(matchTotal).toMatchObject({ engine: "exotics", family: "exact_goals" });
    expect((matchTotal as { side?: string }).side).toBeUndefined();
  });

  it('BUG FIX regression: routes "Goal Bounds - Home/Away" and "Excluded Goals - Home/Away" (ids 450002/450003/450005/450006, SUFFIX naming) with side set, unsuffixed "Goal Bounds"/"Excluded Goals" (ids 450001/450004) without', () => {
    expect(routeMarket(entry({ id: "450002", name: "Goal Bounds - Home" }))).toMatchObject({
      engine: "exotics",
      family: "exact_goals",
      side: "home",
    });
    expect(routeMarket(entry({ id: "450003", name: "Goal Bounds - Away" }))).toMatchObject({
      engine: "exotics",
      family: "exact_goals",
      side: "away",
    });
    expect(routeMarket(entry({ id: "450005", name: "Excluded Goals - Home" }))).toMatchObject({
      engine: "exotics",
      family: "exact_goals",
      side: "home",
    });
    expect(routeMarket(entry({ id: "450006", name: "Excluded Goals - Away" }))).toMatchObject({
      engine: "exotics",
      family: "exact_goals",
      side: "away",
    });
    const goalBounds = routeMarket(entry({ id: "450001", name: "Goal Bounds" }));
    expect((goalBounds as { side?: string }).side).toBeUndefined();
    const excludedGoals = routeMarket(entry({ id: "450004", name: "Excluded Goals" }));
    expect((excludedGoals as { side?: string }).side).toBeUndefined();
  });

  it("skips player-market and routes plain corners/cards O/U to their §3.9 engines (PR-6)", () => {
    expect(routeMarket(entry({ id: "40", name: "Anytime Goalscorer" }))).toMatchObject({
      skip: true,
      reason: "player-market",
    });
    // PR-6: the plain match-total Over/Under corners line is now priceable.
    expect(
      routeMarket(entry({ id: "166", name: "Total Corners Over/Under", specifier: "total=9.5" }))
    ).toMatchObject({ engine: "corners", family: "corners", total: 9.5 });
    // PR-6: cards match-total O/U → cards engine.
    expect(
      routeMarket(entry({ id: "139", name: "Total Cards Over/Under", specifier: "total=5.5" }))
    ).toMatchObject({ engine: "cards", family: "cards", total: 5.5 });
  });

  it("keeps 1st-half corners/cards variants dormant; routes handicap (PR-22); flags a missing specifier precisely", () => {
    // PR-22: "Corners Handicap" now has a real model (joint-grid handicap) —
    // no longer dormant. This is the intended PR-22 behavior change; see
    // marketsV3CornersCards.test.ts's routing-table describe block for the
    // full PR-22 variant coverage (1x2/handicap/range/odd-even/team-total).
    expect(
      routeMarket(entry({ id: "900999", name: "Corners Handicap", specifier: "hcp=0:2" }))
    ).toMatchObject({ engine: "corners", family: "corners", variant: "handicap" });
    // 1st-half corners O/U has no half-calibrated corners model → still
    // dormant (HALF_RE is checked first in routeCornersLike, before any
    // PR-22 variant detection — unaffected by this change).
    expect(
      routeMarket(
        entry({ id: "900998", name: "1st Half Corners Over/Under", specifier: "total=4.5" })
      )
    ).toMatchObject({ skip: true, reason: "corners-dormant" });
    // Cards O/U missing its total specifier: PR-22's routeCornersLike returns
    // the more precise "bad-specifier" reason here (an O/U-shaped name that
    // failed to parse) rather than the old generic "cards-dormant" catch-all
    // — same "bad-specifier" reason routeMarket's own uncatalogued-id path
    // already uses for an identical failure mode.
    expect(routeMarket(entry({ id: "900997", name: "Total Bookings Over/Under" }))).toMatchObject({
      skip: true,
      reason: "bad-specifier",
    });
  });

  it("routeCoverage tallies routed-vs-skipped across a fixture's catalogue", () => {
    const entries = [
      entry({ id: "1", name: "1X2" }),
      entry({ id: "18", name: "Over/Under", specifier: "total=2.5" }),
      entry({ id: "29", name: "GG/NG" }),
    ];
    const cov = routeCoverage(entries);
    expect(cov.total).toBe(3);
    expect(cov.routed).toBe(2);
    expect(cov.skipped["plain-1x2"]).toBe(1);
    expect(cov.byEngine.totals).toBe(1);
    expect(cov.byEngine.shape).toBe(1);
  });

  it("routeCoverage.unrouted tallies market NAMES only for the recoverable skip tail (PR-20)", () => {
    const entries = [
      // Principled skip (plain-1x2) — must NOT appear in `unrouted`.
      entry({ id: "1", name: "1X2" }),
      // uncatalogued: id not in the catalog, non-O/U-shaped name.
      entry({ id: "999999", name: "Some Uncatalogued Market" }),
      // uncatalogued via the desc-only fallback (name absent).
      entry({ id: "999998", name: undefined, desc: "Desc Only Market" }),
      // uncatalogued via the id: fallback (both name and desc absent).
      entry({ id: "999997", name: undefined, desc: undefined }),
      // no-grid-model: catalogued id 45 = correct_score, half-scoped.
      entry({ id: "45", name: "1st Half Correct Score" }),
      // bad-specifier: goals_ou (id 18) with a minute window but no total line.
      entry({ id: "18", name: "Over/Under - Early Goals", specifier: "minsnr=10" }),
    ];
    const cov = routeCoverage(entries);
    expect(cov.unrouted?.["1X2"]).toBeUndefined();
    expect(cov.unrouted?.["Some Uncatalogued Market"]).toBe(1);
    expect(cov.unrouted?.["Desc Only Market"]).toBe(1);
    expect(cov.unrouted?.["id:999997"]).toBe(1);
    expect(cov.unrouted?.["1st Half Correct Score"]).toBe(1);
    expect(cov.unrouted?.["Over/Under - Early Goals"]).toBe(1);
  });

  describe("computeTailMarkets (PR-23)", () => {
    it("keeps only no-grid-model and uncatalogued entries — the same recoverable tail routeCoverage.unrouted tallies", () => {
      const uncatalogued = entry({ id: "999999", name: "Some Uncatalogued Market" });
      const noGridModel = entry({ id: "45", name: "1st Half Correct Score" }); // half correct_score
      const entries = [
        entry({ id: "1", name: "1X2" }), // plain-1x2 — principled skip, excluded
        uncatalogued,
        noGridModel,
        entry({ id: "18", name: "Over/Under - Early Goals", specifier: "minsnr=10" }), // bad-specifier, excluded
        entry({ id: "18", name: "Over/Under", specifier: "total=2.5" }), // routed, excluded
        entry({ id: "40", name: "Anytime Goalscorer" }), // player-market, excluded
      ];

      const tail = computeTailMarkets(entries);

      expect(tail).toEqual([uncatalogued, noGridModel]);
    });

    it("returns an empty array (not an error) when nothing in the catalogue has a recoverable tail reason", () => {
      const entries = [
        entry({ id: "1", name: "1X2" }),
        entry({ id: "18", name: "Over/Under", specifier: "total=2.5" }),
      ];
      expect(computeTailMarkets(entries)).toEqual([]);
    });

    it("returns an empty array for an empty catalogue", () => {
      expect(computeTailMarkets([])).toEqual([]);
    });
  });
});

// ── poissonPMF sanity (shared with engines) ─────────────────────────────────

describe("poissonPMF re-export sanity", () => {
  it("sums to ~1 over a wide k range", () => {
    let total = 0;
    for (let k = 0; k < 30; k++) total += poissonPMF(k, 2.5);
    expect(total).toBeCloseTo(1, 5);
  });
});

// ── analyzeFixtureMarketsV3 — end-to-end orchestrator ───────────────────────

describe("analyzeFixtureMarketsV3 (orchestrator)", () => {
  const baseInput = {
    fixtureId: "f1",
    runId: "r1",
    home: "Home FC",
    away: "Away FC",
    league: "__unknown_league__",
    kickoff: new Date().toISOString(),
    lambdaInput: {
      league: "__unknown_league__",
      homeScoredPer90: 1.7,
      homeConcededPer90: 1.0,
      awayScoredPer90: 1.2,
      awayConcededPer90: 1.5,
      nHome: 10,
      nAway: 10,
    },
    devigged1x2: { pHome: 0.45, pDraw: 0.27, pAway: 0.28 },
    penaltyFlags: {},
  };

  it("returns null when no λ model can be built", async () => {
    const { analyzeFixtureMarketsV3 } = await import("@oracle/engine");
    const result = analyzeFixtureMarketsV3({
      ...baseInput,
      lambdaInput: { league: "__unknown_league__" },
      allMarkets: [],
    });
    expect(result).toBeNull();
  });

  it("routes a small realistic catalogue end-to-end and surfaces gate-surviving candidates", async () => {
    const { analyzeFixtureMarketsV3 } = await import("@oracle/engine");
    const allMarkets: AllMarketEntry[] = [
      {
        id: "1",
        name: "1X2",
        outcomes: [
          { id: "1", desc: "Home", odds: "1.90" },
          { id: "2", desc: "Draw", odds: "3.60" },
          { id: "3", desc: "Away", odds: "4.20" },
        ],
      },
      {
        id: "18",
        name: "Over/Under",
        specifier: "total=2.5",
        outcomes: [
          { id: "1", desc: "Over 2.5", odds: "1.85" },
          { id: "2", desc: "Under 2.5", odds: "1.95" },
        ],
      },
      {
        id: "29",
        name: "GG/NG",
        outcomes: [
          { id: "1", desc: "Yes", odds: "1.80" },
          { id: "2", desc: "No", odds: "2.00" },
        ],
      },
      {
        id: "10",
        name: "Double Chance",
        outcomes: [
          { id: "1", desc: "Home or Draw", odds: "1.25" },
          { id: "2", desc: "Home or Away", odds: "1.10" },
          { id: "3", desc: "Draw or Away", odds: "2.10" },
        ],
      },
      {
        id: "40",
        name: "Anytime Goalscorer",
        outcomes: [{ id: "1", desc: "Some Player", odds: "3.00" }],
      },
    ];

    const result = analyzeFixtureMarketsV3({ ...baseInput, allMarkets });
    expect(result).not.toBeNull();
    expect(result!.coverage.total).toBe(5);
    // Plain 1X2 skipped (never a candidate) + player market skipped.
    expect(result!.coverage.skipped["plain-1x2"]).toBe(1);
    expect(result!.coverage.skipped["player-market"]).toBe(1);
    expect(result!.coverage.routed).toBe(3);
    // Every assessed outcome carries a valid class + gate outcome.
    for (const a of result!.assessments) {
      expect(["S", "M", "L", "X"]).toContain(a.cls);
      expect(["done", "capped", "noise", "below_gate"]).toContain(a.outcome);
    }
    // evMarkets are sorted best-first by adjusted edge (rankingScore).
    for (let i = 1; i < result!.evMarkets.length; i++) {
      expect(result!.evMarkets[i - 1]!.rankingScore).toBeGreaterThanOrEqual(
        result!.evMarkets[i]!.rankingScore
      );
    }
    expect(result!.best).toEqual(result!.evMarkets[0] ?? null);
  });

  it("prices corners/cards O/U when §3.9 stats are present, stays dormant-by-data when absent (PR-6)", async () => {
    const { analyzeFixtureMarketsV3 } = await import("@oracle/engine");
    const allMarkets: AllMarketEntry[] = [
      {
        id: "166",
        name: "Total Corners Over/Under",
        specifier: "total=9.5",
        outcomes: [
          { id: "1", desc: "Over 9.5", odds: "1.90" },
          { id: "2", desc: "Under 9.5", odds: "1.90" },
        ],
      },
      {
        id: "139",
        name: "Total Cards Over/Under",
        specifier: "total=4.5",
        outcomes: [
          { id: "1", desc: "Over 4.5", odds: "2.00" },
          { id: "2", desc: "Under 4.5", odds: "1.80" },
        ],
      },
    ];

    // Routing is unconditional — both land on their §3.9 engines regardless of stats.
    const noStats = analyzeFixtureMarketsV3({ ...baseInput, allMarkets });
    expect(noStats!.coverage.byEngine.corners).toBe(1);
    expect(noStats!.coverage.byEngine.cards).toBe(1);
    // But with ctx.corners/.cards null (no stats), pricing yields nothing.
    expect(noStats!.assessments.some((a) => a.family === "corners" || a.family === "cards")).toBe(
      false
    );

    // Stats present → the modules price the lines and emit assessments.
    const withStats = analyzeFixtureMarketsV3({
      ...baseInput,
      allMarkets,
      cornersForH: 5.5,
      cornersForA: 5.0,
      cornersAgainstH: 4.5,
      cornersAgainstA: 4.0,
      cardsAvgH: 2.2,
      cardsAvgA: 2.0,
    });
    expect(withStats!.assessments.some((a) => a.family === "corners")).toBe(true);
    expect(withStats!.assessments.some((a) => a.family === "cards")).toBe(true);
    // Every corners/cards mp is a valid probability in (0,1).
    for (const a of withStats!.assessments) {
      if (a.family === "corners" || a.family === "cards") {
        expect(a.mp).toBeGreaterThan(0);
        expect(a.mp).toBeLessThan(1);
      }
    }
  });

  it("marks half-share as default (0.44) when fhShareH/A are not supplied", async () => {
    const { analyzeFixtureMarketsV3 } = await import("@oracle/engine");
    const result = analyzeFixtureMarketsV3({ ...baseInput, allMarkets: [] });
    expect(result!.fhShareIsDefault).toBe(true);
    expect(result!.fhShare).toBeCloseTo(0.44, 5);
  });

  it("uses the typed fhShareH/A average (clamped) when supplied", async () => {
    const { analyzeFixtureMarketsV3 } = await import("@oracle/engine");
    const result = analyzeFixtureMarketsV3({
      ...baseInput,
      fhShareH: 0.5,
      fhShareA: 0.4,
      allMarkets: [],
    });
    expect(result!.fhShareIsDefault).toBe(false);
    expect(result!.fhShare).toBeCloseTo(0.45, 5);
  });

  it("threads heightened through the full pipeline — fewer (or equal) DONE candidates survive than non-heightened", async () => {
    const { analyzeFixtureMarketsV3 } = await import("@oracle/engine");
    const allMarkets: AllMarketEntry[] = [
      {
        id: "18",
        name: "Over/Under",
        specifier: "total=2.5",
        outcomes: [
          { id: "1", desc: "Over 2.5", odds: "1.85" },
          { id: "2", desc: "Under 2.5", odds: "1.95" },
        ],
      },
      {
        id: "10",
        name: "Double Chance",
        outcomes: [
          { id: "1", desc: "Home or Draw", odds: "1.25" },
          { id: "2", desc: "Home or Away", odds: "1.10" },
          { id: "3", desc: "Draw or Away", odds: "2.10" },
        ],
      },
    ];
    const normal = analyzeFixtureMarketsV3({ ...baseInput, allMarkets });
    const heightened = analyzeFixtureMarketsV3({ ...baseInput, allMarkets, heightened: true });
    expect(normal).not.toBeNull();
    expect(heightened).not.toBeNull();
    const normalDone = normal!.assessments.filter((a) => a.outcome === "done").length;
    const heightenedDone = heightened!.assessments.filter((a) => a.outcome === "done").length;
    expect(heightenedDone).toBeLessThanOrEqual(normalDone);
    // Every heightened survivor must be Class S/M/L — X is excluded entirely.
    for (const a of heightened!.assessments) {
      if (a.outcome === "done") expect(a.cls).not.toBe("X");
    }
  });

  describe("dynamicRho override (PR-5, §8.1 NEW-07)", () => {
    // Over/Under 1.5 (not 2.5): the DC tau correction only redistributes
    // probability among the four low-score cells (0-0/1-0/0-1/1-1) — all of
    // which sit on the SAME side of the 2.5 line, so Over/Under 2.5 is
    // mathematically insensitive to rho. 1-1 straddles the 1.5 line (it's the
    // only one of the four cells that's "over"), so Over/Under 1.5 is the
    // line that actually moves when rho changes.
    const allMarkets: AllMarketEntry[] = [
      {
        id: "18",
        name: "Over/Under",
        specifier: "total=1.5",
        outcomes: [
          { id: "1", desc: "Over 1.5", odds: "1.30" },
          { id: "2", desc: "Under 1.5", odds: "3.20" },
        ],
      },
    ];

    it("omitting dynamicRho falls back to the static getLeagueParams baseRho (unchanged)", async () => {
      const { analyzeFixtureMarketsV3 } = await import("@oracle/engine");
      const withoutOverride = analyzeFixtureMarketsV3({ ...baseInput, allMarkets });
      // Default league's baseRho per execution/index.ts's LEAGUE_PARAMS is -0.13.
      const withMatchingOverride = analyzeFixtureMarketsV3({
        ...baseInput,
        allMarkets,
        dynamicRho: -0.13,
      });
      expect(withoutOverride).not.toBeNull();
      expect(withMatchingOverride).not.toBeNull();
      const mp = (r: typeof withoutOverride) =>
        r!.assessments.find((a) => a.desc === "Over 1.5")!.mp;
      expect(mp(withMatchingOverride)).toBeCloseTo(mp(withoutOverride), 10);
    });

    it("a dynamicRho override changes the priced model probability", async () => {
      const { analyzeFixtureMarketsV3 } = await import("@oracle/engine");
      const withoutOverride = analyzeFixtureMarketsV3({ ...baseInput, allMarkets });
      const withOverride = analyzeFixtureMarketsV3({ ...baseInput, allMarkets, dynamicRho: -0.28 });
      expect(withoutOverride).not.toBeNull();
      expect(withOverride).not.toBeNull();
      const mp = (r: typeof withoutOverride) =>
        r!.assessments.find((a) => a.desc === "Over 1.5")!.mp;
      expect(mp(withOverride)).not.toBeCloseTo(mp(withoutOverride), 5);
    });
  });
});

// ── totals engine — per-line marketStatMissing flag (PR-4 §0.3) ────────────

describe("priceOU / priceTotalsOutcome — per-line O/U hit-rate flag (PR-4)", () => {
  const totalsCtx = (empirical: V3EngineCtx["empirical"]): V3EngineCtx => {
    const grid = buildV3Grid(1.5, 1.2, 0.08);
    const half = buildV3HalfGrid(0.75, 0.6);
    return {
      statsGrid: grid,
      shapeGrid: grid,
      mu: 2.7,
      split: {} as V3EngineCtx["split"],
      fhShare: 0.44,
      fhShareIsDefault: true,
      halfStats: [half, half],
      halfShape: [half, half],
      empirical,
    };
  };

  it("flags marketStatMissing on a tracked line (2.5) when the hit-rate is absent", () => {
    const ctx = totalsCtx({});
    const price = priceOU(ctx, parseOUDesc("over 2.5")!);
    expect(price.marketStatMissing).toBe(true);
  });

  it("does not flag a tracked line when both sides' hit-rates are present", () => {
    const ctx = totalsCtx({ ou25PctH: 0.6, ou25PctA: 0.55 });
    const price = priceOU(ctx, parseOUDesc("over 2.5")!);
    expect(price.marketStatMissing).toBe(false);
  });

  it("still flags missing when only one side's hit-rate is present", () => {
    const ctx = totalsCtx({ ou25PctH: 0.6 });
    const price = priceOU(ctx, parseOUDesc("over 2.5")!);
    expect(price.marketStatMissing).toBe(true);
  });

  it("never flags an untracked line (e.g. 0.5) — it never had this stat to begin with", () => {
    const ctx = totalsCtx({});
    const price = priceOU(ctx, parseOUDesc("over 0.5")!);
    expect(price.marketStatMissing).toBe(false);
  });

  it("checks each of 1.5/2.5/3.5 against its own matching pair independently", () => {
    const ctx = totalsCtx({ ou15PctH: 0.8, ou15PctA: 0.75, ou35PctH: 0.3, ou35PctA: 0.25 });
    expect(priceOU(ctx, parseOUDesc("over 1.5")!).marketStatMissing).toBe(false);
    expect(priceOU(ctx, parseOUDesc("over 2.5")!).marketStatMissing).toBe(true); // no ou25 entry
    expect(priceOU(ctx, parseOUDesc("over 3.5")!).marketStatMissing).toBe(false);
  });

  it("wires the flag through priceTotalsOutcome (the routed entry point)", () => {
    const ctx = totalsCtx({});
    const price = priceTotalsOutcome(ctx, { engine: "totals", family: "goals_ou" }, "Over 2.5");
    expect(price?.marketStatMissing).toBe(true);
  });

  it("totals pricing itself is unaffected by hit-rate presence (model-only, not blended)", () => {
    const withRate = priceOU(
      totalsCtx({ ou25PctH: 0.6, ou25PctA: 0.55 }),
      parseOUDesc("over 2.5")!
    );
    const withoutRate = priceOU(totalsCtx({}), parseOUDesc("over 2.5")!);
    expect(withRate.p).toBeCloseTo(withoutRate.p, 10);
  });
});
