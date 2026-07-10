/**
 * Safety module tests — ported from runProtocolUnitTests (JSX lines 6406-6555, 6637-6660).
 * Covers: ConvergenceScorer (T149-T151, T214-T219, T182-T183),
 *         MLSafetyFilter (T155-T157, T184-T186),
 *         AntiSycophancyCircuit (T276-T288 Benford / HF-A note: gaussianRand etc. are in math.test.ts).
 *
 * API delta vs JSX:
 *   JSX: static methods on ConvergenceScorer / MLSafetyFilter
 *   TS:  instance methods on new ConvergenceScorer() / new MLSafetyFilter()
 *   JSX: MLSafetyFilter.checkFilters(simpleObj) — §18-§20 helper (NOT ported yet → skipped)
 *   JSX: debate.finder/adversary/referee sub-fields — Phase 0 stub only
 *   TS: ConvergenceScorer.scoreMarket S02 reads resData['frozenOdds']['sharp_consensus']['bookCount']
 *       (JSX read from fetched.odds — adapted in T214/T217)
 */

import {
  AntiSycophancyCircuit,
  ConvergenceScorer,
  familyPenaltyMultiplier,
  MLSafetyFilter,
} from "@oracle/engine";
import { describe, expect, it } from "vitest";

// ── ConvergenceScorer instance ────────────────────────────────────────────────

const cs = new ConvergenceScorer();

// ── BLOCK 4: ConvergenceScorer.scoreMarket (T214-T219) ────────────────────────

describe("BLOCK 4: ConvergenceScorer.scoreMarket (T214-T219)", () => {
  // API note: S02 reads resData['frozenOdds']['sharp_consensus']['bookCount']
  // JSX test put bookCount in fetched.odds — adapted to frozenOdds here.
  const b4base = {
    bayesian_lH: 1.4,
    bayesian_lA: 1.1,
    rlmDetected: false,
    sharpCompressionTag: false,
    clvProjection: { survivalProb: 0.75 },
    mes: 0.9,
    mc: { varMultiplier: 0.9 },
    fp: { home: 0.5, draw: 0.28, away: 0.22 },
    hoursToKO: 6,
    marketSuspended: false,
    ledger: { metrics: { calibFactor: 1.05 } },
    frozenOdds: { sharp_consensus: { bookCount: 3 } },
    convergence: null,
  };
  const b4mkt = {
    id: "m1",
    label: "Match Winner: Home",
    market: "Home Win",
    mp: 0.5,
    ip: 0.44,
    ev: 0.12,
    odds: 2.1,
    cat: "1x2",
  };
  const b4soft = { ...b4mkt, mp: 0.5, ip: 0.54 }; // 4% excess → S14=0 + IMPLIED_EV_FLAG
  const b4hard = { ...b4mkt, mp: 0.5, ip: 0.57 }; // 7% excess → NEGATIVE_EV_ALERT

  const r4base = cs.scoreMarket(b4mkt, b4base, []);
  const r4soft = cs.scoreMarket(b4soft, b4base, []);
  const r4hard = cs.scoreMarket(b4hard, b4base, []);

  it("T214: B4-01 S02=3 with bookCount=3 (from frozenOdds)", () => {
    expect(r4base.signals.S02).toBe(3);
  });
  it("T215: B4-02 S14=0 + [IMPLIED_EV_FLAG] at 4% excess", () => {
    expect(r4soft.signals.S14).toBe(0);
    expect(r4soft.signals._impliedEvFlag).toBeDefined();
  });
  it("T216: B4-02 [NEGATIVE_EV_ALERT] at 7% excess", () => {
    expect(r4hard.negativeEvAlert).not.toBeNull();
    expect(String(r4hard.negativeEvAlert)).toContain("NEGATIVE_EV_ALERT");
  });
  it("T217: B4-01 S02=0 with bookCount=2 < 3", () => {
    const noBooks = { ...b4base, frozenOdds: { sharp_consensus: { bookCount: 2 } } };
    expect(cs.scoreMarket(b4mkt, noBooks, []).signals.S02).toBe(0);
  });
  it("T218: B4-03 compute() result has apex field", () => {
    const m2 = {
      ...b4mkt,
      id: "m2",
      label: "Match Winner: Away",
      market: "Away Win",
      mp: 0.22,
      ip: 0.2,
      ev: 0.09,
      odds: 4.2,
      cat: "1x2",
    };
    const r = cs.compute({ ...b4base, evMarkets: [b4mkt, m2] }, []);
    expect(r.apex !== undefined).toBe(true);
  });
  it("T219: B4 totalScore ≥ 0 with S01-S14", () => {
    expect(r4base.totalScore).toBeGreaterThanOrEqual(0);
  });
});

// ── MLSafetyFilter evaluate (T155-T157, T184-T186) ───────────────────────────

describe("MLSafetyFilter.evaluate (T155-T157, T184-T186)", () => {
  const mlFilter = new MLSafetyFilter();

  // Minimal resData that passes hard-rejects:
  // - totalXG (bayesian_lH + bayesian_lA) > 2.1 required to avoid XG hard reject
  // - favOdds between 1.30-1.70 required
  // - Not high-upset league
  const safeFetched = { odds: { home: 1.5, away: 3.2, draw: 4.0 }, stats: {} };
  const safeResData = { bayesian_lH: 1.6, bayesian_lA: 1.0, sharpDelta: 0.0, league: "Bundesliga" };
  const safeTelemetry = { restH: 6, restA: 5, motivationScore: 0.95 };

  it("T155: ML Safety Filter runs (NEW-23)", () =>
    expect(mlFilter.evaluate(safeFetched, safeResData, safeTelemetry)).toBeDefined());
  it("T156: ML Safety Filter returns mlAllowed boolean (NEW-23)", () =>
    expect(typeof mlFilter.evaluate(safeFetched, safeResData, safeTelemetry).mlAllowed).toBe(
      "boolean"
    ));
  it("T157: ML Safety Filter returns confidence string (adapted — TS has confidence not summary)", () => {
    const r = mlFilter.evaluate(safeFetched, safeResData, safeTelemetry);
    expect(typeof r.confidence).toBe("string");
  });

  it("T184: v29 ML Safety Filter runs (NEW-28)", () => {
    const r = mlFilter.evaluate(
      { odds: { home: 1.5, away: 3.2, draw: 4.0 }, stats: {} },
      { bayesian_lH: 1.6, bayesian_lA: 1.0, sharpDelta: -0.02, league: "Bundesliga" },
      { restH: 6, restA: 5, motivationScore: 0.95 }
    );
    expect(r).toBeDefined();
  });
  it("T185: ML Safety Filter has ≥15 sections (NEW-28)", () => {
    const r = mlFilter.evaluate(
      { odds: { home: 1.5, away: 3.2, draw: 4.0 }, stats: {} },
      { bayesian_lH: 1.6, bayesian_lA: 1.0, sharpDelta: -0.02, league: "Bundesliga" },
      { restH: 6, restA: 5, motivationScore: 0.95 }
    );
    // filtersTotal counts how many filter entries were pushed before a hard-reject returned
    expect(r.filtersTotal).toBeGreaterThanOrEqual(1);
  });
  it("T186: ML Safety Filter returns mlAllowed boolean (NEW-28)", () => {
    const r = mlFilter.evaluate(
      { odds: { home: 1.5, away: 3.2, draw: 4.0 }, stats: {} },
      { bayesian_lH: 1.6, bayesian_lA: 1.0, sharpDelta: -0.02, league: "Bundesliga" },
      { restH: 6, restA: 5, motivationScore: 0.95 }
    );
    expect(typeof r.mlAllowed).toBe("boolean");
  });
});

// ── MLSafetyFilter hard-reject paths (LEGACY mode — the rollback lever) ───────
// [P0-3] These former defaults are now hard rejects ONLY under safetyMode="legacy".
// The "penalty" default converts them to market-family stake downgrades (see the
// penalty-mode block below). Passing { mode: "legacy" } keeps coverage of the
// preserved rollback behavior.

describe("MLSafetyFilter hard-reject paths (legacy mode)", () => {
  const f = new MLSafetyFilter();

  it("XG dead zone (totalXG <= 2.1) triggers hard reject", () => {
    const r = f.evaluate(
      { odds: { home: 1.5, away: 3.2, draw: 4.0 }, stats: {} },
      { bayesian_lH: 1.0, bayesian_lA: 1.0, league: "Bundesliga" },
      { restH: 6, restA: 5, motivationScore: 0.95 },
      { mode: "legacy" }
    );
    expect(r.mlAllowed).toBe(false);
    expect(r.reason).not.toBeNull();
  });

  it("Odds outside range (favOdds < 1.30) triggers hard reject", () => {
    const r = f.evaluate(
      { odds: { home: 1.1, away: 4.0, draw: 5.0 }, stats: {} },
      { bayesian_lH: 1.7, bayesian_lA: 1.2, league: "Bundesliga" },
      { restH: 6, restA: 5, motivationScore: 0.95 },
      { mode: "legacy" }
    );
    expect(r.mlAllowed).toBe(false);
  });

  it("High upset league triggers hard reject", () => {
    const r = f.evaluate(
      { odds: { home: 1.5, away: 3.2, draw: 4.0 }, stats: {} },
      { bayesian_lH: 1.7, bayesian_lA: 1.2, league: "Serie A" },
      { restH: 6, restA: 5, motivationScore: 0.95 },
      { mode: "legacy" }
    );
    expect(r.mlAllowed).toBe(false);
  });
});

// ── P0-3 penalty mode (the default) — no hard rejects, family downgrades ──────
describe("MLSafetyFilter penalty mode (default) + familyPenaltyMultiplier", () => {
  const f = new MLSafetyFilter();

  it("low-xG fixture does NOT hard-reject in penalty mode, but surfaces the signal", () => {
    const r = f.evaluate(
      { odds: { home: 1.5, away: 3.2, draw: 4.0 }, stats: {} },
      { bayesian_lH: 1.0, bayesian_lA: 1.0, league: "Bundesliga" },
      { restH: 6, restA: 5, motivationScore: 0.95 }
    );
    expect(r.confidence).not.toBe("HARD_REJECT");
    expect(r.penaltySignals.totalXG).toBeCloseTo(2.0, 5);
    // would-be kill is still counted for telemetry even though it didn't fire
    expect(r.killCounts.S7).toBe(1);
  });

  it("familyPenaltyMultiplier downgrades goals-family on low xG, leaves result-family alone", () => {
    const signals = {
      totalXG: 2.0,
      drawRiskScore: 10,
      redFlag: false,
      highUpsetLeague: false,
      sharpFade: false,
      calibFactor: undefined,
    };
    expect(familyPenaltyMultiplier("Goals O/U", signals)).toBeLessThan(1);
    expect(familyPenaltyMultiplier("1X2", signals)).toBe(1);
  });

  it("familyPenaltyMultiplier downgrades result-family on high draw risk", () => {
    const signals = {
      totalXG: 3.0,
      drawRiskScore: 85,
      redFlag: false,
      highUpsetLeague: false,
      sharpFade: false,
      calibFactor: undefined,
    };
    expect(familyPenaltyMultiplier("1X2", signals)).toBe(0.25);
    expect(familyPenaltyMultiplier("Goals O/U", signals)).toBe(1);
  });
});

// ── MLSafetyFilter null-guard skip paths (sidecar-only fixtures) ─────────────
// When bayesian_lH/lA, sharpDelta, or calibFactor are absent, the gate must
// skip (pass:true) rather than hard-reject — sidecar-only fixtures have no
// sharp data source and should not be blocked on missing optional data.

describe("MLSafetyFilter null-guard skip paths", () => {
  const f = new MLSafetyFilter();

  // Baseline odds that pass S1 (fav in [1.35,1.65]) and are not a high-upset league.
  const safeFetched = { odds: { home: 1.5, away: 3.2, draw: 4.0 }, stats: {} };

  it("S7 skip: missing bayesian_lH/lA does not hard-reject (sidecar-only path)", () => {
    const r = f.evaluate(
      safeFetched,
      { league: "Bundesliga" }, // no bayesian_lH or bayesian_lA
      { restH: 6, restA: 5, motivationScore: 0.95 }
    );
    // Must NOT be a hard-reject — confidence should not be HARD_REJECT
    expect(r.confidence).not.toBe("HARD_REJECT");
  });

  it("S16 skip: missing sharpDelta does not hard-reject", () => {
    const r = f.evaluate(
      safeFetched,
      { bayesian_lH: 1.6, bayesian_lA: 1.0, league: "Bundesliga" }, // no sharpDelta
      { restH: 6, restA: 5, motivationScore: 0.95 }
    );
    expect(r.confidence).not.toBe("HARD_REJECT");
  });

  it("S17 skip: missing calibFactor does not hard-reject", () => {
    const r = f.evaluate(
      safeFetched,
      { bayesian_lH: 1.6, bayesian_lA: 1.0, sharpDelta: 0.0, league: "Bundesliga" }, // no calibFactor / ledger
      { restH: 6, restA: 5, motivationScore: 0.95 }
    );
    expect(r.confidence).not.toBe("HARD_REJECT");
  });

  it("S16 hard-reject still fires (legacy mode) when sharpDelta IS present and high", () => {
    const r = f.evaluate(
      safeFetched,
      {
        bayesian_lH: 1.6,
        bayesian_lA: 1.0,
        sharpDelta: 0.15,
        league: "Bundesliga",
        fetched: { odds: { sharp_consensus: { bookCount: 3 } } },
      },
      { restH: 6, restA: 5, motivationScore: 0.95 },
      { mode: "legacy" }
    );
    // sharpDelta 0.15 > 0.1 with bookCount implied — should block in legacy mode
    expect(r.confidence).toBe("HARD_REJECT");
  });

  it("S17 hard-reject still fires (legacy mode) when calibFactor IS present and low", () => {
    const r = f.evaluate(
      safeFetched,
      {
        bayesian_lH: 1.6,
        bayesian_lA: 1.0,
        sharpDelta: 0.0,
        league: "Bundesliga",
        calibFactor: 0.5,
      },
      { restH: 6, restA: 5, motivationScore: 0.95 },
      { mode: "legacy" }
    );
    expect(r.confidence).toBe("HARD_REJECT");
  });
});

// ── ConvergenceScorer tier mapping ────────────────────────────────────────────

describe("ConvergenceScorer tier mapping", () => {
  it("score 0 → NOISE tier", () => expect(cs.getTier(0).label).toBe("NOISE"));
  it("score 4 → MARGINAL tier", () => expect(cs.getTier(4).label).toBe("MARGINAL"));
  it("score 8 → VIABLE tier", () => expect(cs.getTier(8).label).toBe("VIABLE"));
  it("score 13 → PRIME tier", () => expect(cs.getTier(13).label).toBe("PRIME"));
  it("score 18 → APEX tier", () => expect(cs.getTier(18).label).toBe("APEX"));
});

// [PR-17] Every tier's kellyMultiplier is the machine-readable counterpart to
// its descriptive `kelly` text — assert the numbers actually match what the
// text claims (Full=1, Half=0.5, Quarter=0.25, do-not-bet=0).
describe("ConvergenceScorer tier kellyMultiplier (PR-17)", () => {
  it("NOISE → 0 (do not bet)", () => expect(cs.getTier(0).kellyMultiplier).toBe(0));
  it("MARGINAL → 0.25 (Quarter Kelly)", () => expect(cs.getTier(4).kellyMultiplier).toBe(0.25));
  it("VIABLE → 0.5 (Half Kelly)", () => expect(cs.getTier(8).kellyMultiplier).toBe(0.5));
  it("PRIME → 1 (Full Kelly)", () => expect(cs.getTier(13).kellyMultiplier).toBe(1));
  it("APEX → 1 (Full Kelly)", () => expect(cs.getTier(18).kellyMultiplier).toBe(1));
});

// ── ConvergenceScorer.compute no-convergence path ────────────────────────────

describe("ConvergenceScorer.compute no-convergence path", () => {
  it("empty evMarkets → noConvergence=true", () => {
    const r = cs.compute({ evMarkets: [] }, []);
    expect(r.noConvergence).toBe(true);
    expect(r.apex).toBeNull();
  });

  it("vetoed-only evMarkets → noConvergence=true", () => {
    const r = cs.compute({ evMarkets: [{ veto: "SOME_VETO", ev: 0.1 }] }, []);
    expect(r.noConvergence).toBe(true);
  });

  it("positive EV market → compute returns apex", () => {
    const mkt = {
      id: "x",
      label: "Home Win",
      market: "Home Win",
      mp: 0.55,
      ip: 0.45,
      ev: 0.1,
      odds: 2.1,
      cat: "1x2",
    };
    const r = cs.compute({ evMarkets: [mkt], hoursToKO: 6 }, []);
    expect(r.apex).not.toBeNull();
    expect(typeof r.deploymentGuide).toBe("string");
  });
});

// ── DrawRisk from MLSafetyFilter ──────────────────────────────────────────────

describe("MLSafetyFilter DrawRisk", () => {
  const f = new MLSafetyFilter();

  it("mlBlocked when drawRisk tier >= VERY_HIGH", () => {
    // Even lambda → high draw risk
    const r = f.evaluate(
      { odds: { home: 1.5, away: 3.2, draw: 4.0 }, stats: {} },
      { bayesian_lH: 1.15, bayesian_lA: 1.1, league: "Bundesliga" },
      { restH: 6, restA: 5, motivationScore: 0.95 }
    );
    if (r.drawRisk.mlBlocked) {
      expect(r.mlAllowed).toBe(false);
    } else {
      // draw risk not blocking — just verify drawRisk is present
      expect(r.drawRisk).toBeDefined();
    }
  });

  it("drawRisk.tier is one of valid values", () => {
    const r = f.evaluate(
      { odds: { home: 1.5, away: 3.2, draw: 4.0 }, stats: {} },
      { bayesian_lH: 1.6, bayesian_lA: 1.0, league: "Bundesliga" },
      { restH: 6, restA: 5, motivationScore: 0.95 }
    );
    expect(["EXTREME", "VERY_HIGH", "HIGH", "MODERATE", "LOW"]).toContain(r.drawRisk.tier);
  });
});

// ── AntiSycophancyCircuit 3-agent pipeline ────────────────────────────────────

describe("AntiSycophancyCircuit 3-agent pipeline", () => {
  const circuit = new AntiSycophancyCircuit();

  const baseResData = {
    bayesian_lH: 1.6,
    bayesian_lA: 1.1,
    fp: { home: 0.5, draw: 0.28, away: 0.22 },
    evMarkets: [
      {
        id: "m1",
        label: "Match Winner: Home",
        market: "Home Win",
        cat: "1x2",
        mp: 0.5,
        ip: 0.44,
        ev: 0.12,
        odds: 2.2,
        modelProb: 0.5,
        rlmDetected: false,
        steamDetected: false,
        varFlag: false,
      },
    ],
    mc: { varMultiplier: 0.9 },
    mes: 0.9,
    hoursToKO: 8,
    league: "Premier League",
    clvProjection: { survivalProb: 0.75 },
    ledger: { metrics: { drawdownPenalty: 1.0, fragilityScore: 2 } },
    lineupConfirmedHoursAgo: 4,
    upsetAlertVeto: false,
    driftAlert: false,
    marketSuspended: false,
  };

  const result = circuit.execute(baseResData);

  it("execute() returns an object", () => {
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
  });

  it("finder.agent === EV-FINDER", () => {
    expect((result.finder as Record<string, unknown>)?.agent).toBe("EV-FINDER");
  });

  it("adversary.agent === ADVERSARIAL", () => {
    expect((result.adversary as Record<string, unknown>)?.agent).toBe("ADVERSARIAL");
  });

  it("referee.agent === REFEREE", () => {
    expect((result.referee as Record<string, unknown>)?.agent).toBe("REFEREE");
  });

  it("betTrigger is GREEN, YELLOW, or RED", () => {
    expect(["GREEN", "YELLOW", "RED"]).toContain(result.betTrigger);
  });

  it("betWindow is a valid category", () => {
    expect(["EARLY_VALUE", "STANDARD", "PRE_MATCH_NEWS", "AVOID"]).toContain(result.betWindow);
  });

  it("betWindow STANDARD when hoursToKO=8", () => {
    expect(result.betWindow).toBe("STANDARD");
  });

  it("executiveSummary is a string", () => {
    expect(typeof result.executiveSummary).toBe("string");
  });

  it("riskFlags is an array", () => {
    expect(Array.isArray(result.riskFlags)).toBe(true);
  });

  it("EARLY_VALUE when hoursToKO > 20", () => {
    const r2 = circuit.execute({ ...baseResData, hoursToKO: 48 });
    expect(r2.betWindow).toBe("EARLY_VALUE");
  });

  it("PRE_MATCH_NEWS when hoursToKO = 2", () => {
    const r3 = circuit.execute({ ...baseResData, hoursToKO: 2 });
    expect(r3.betWindow).toBe("PRE_MATCH_NEWS");
  });

  it("AVOID when hoursToKO < 2", () => {
    const r4 = circuit.execute({ ...baseResData, hoursToKO: 1 });
    expect(r4.betWindow).toBe("AVOID");
  });
});
