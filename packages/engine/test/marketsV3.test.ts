/** all-markets-analysis-prompt-v3 — Phase 2 core deterministic engine tests.
 *  Anchored to the spec's own worked examples (DNB 64.9% discard, 1H Under 1.5
 *  70.3% fail-Class-S, Over 2.5 +8.5pts done) plus per-engine unit coverage. */

import {
  type AllMarketEntry,
  buildV3Grid,
  buildV3HalfGrid,
  CLASS_GATE,
  classifyMarket,
  deriveDualSplit,
  gateAllMarkets,
  impliedQ,
  minuteShare,
  poissonPMF,
  priceTimeWindow,
  resultProbs,
  routeCoverage,
  routeMarket,
  sumWhere,
  V3_MINUTE_SHARE_TABLE,
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
  // The spec's WORKED EXAMPLES prose gives illustrative model-P/q PAIRS
  // (66.6%, 65.5% etc.) that don't reconcile bit-exact against any single
  // devig formula applied to its example odds (rounding in the prose) — so
  // these tests feed the spec's own P/q numbers straight into the gate to
  // verify the GATE ARITHMETIC (raw/adjusted/tiering), which is exact.
  it("Class S (1H Under 1.5): model 70.3% vs q 66.6% → adj +1.7pts fails the S gate (needs ≥3pts & ≥4% EV)", () => {
    const q = { q: 0.666, devigged: true };
    const gate = gateAllMarkets(0.703, q, 1.36, "S", { xgMissing: true });
    // raw ≈ 3.7pts, penalty 2pts (no xG) → adjusted ≈ 1.7pts, EV% ≈ 1.7/66.6 ≈ 2.6%
    expect(gate.rawEdge).toBeCloseTo(0.037, 3);
    expect(gate.adjustedEdge).toBeCloseTo(0.017, 3);
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

  it("skips player-market and dormant corners/cards families", () => {
    expect(routeMarket(entry({ id: "40", name: "Anytime Goalscorer" }))).toMatchObject({
      skip: true,
      reason: "player-market",
    });
    expect(
      routeMarket(entry({ id: "900999", name: "Total Corners Over/Under", specifier: "total=9.5" }))
    ).toMatchObject({ skip: true, reason: "corners-dormant" });
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
});
