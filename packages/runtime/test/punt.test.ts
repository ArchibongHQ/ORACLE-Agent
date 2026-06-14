import type { BatchResult } from "@oracle/engine";
import { describe, expect, it, vi } from "vitest";
import type { RawLeg } from "../../../apps/booking/src/loadCode.js";
import type { PuntLeg } from "../src/punt.js";
import { counterSlip, loadedSlipToJobs, rawLegToMarketSide } from "../src/punt.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

function rawLeg(over: Partial<RawLeg> = {}): RawLeg {
  return {
    home: "Arsenal",
    away: "Chelsea",
    league: "Premier League",
    marketDesc: "1X2",
    outcomeDesc: "Home",
    odds: 2.0,
    ...over,
  };
}

/** Minimal FixtureJob-ish placeholder (counterSlip only checks job !== null). */
const fakeJob = {
  home: "Arsenal",
  away: "Chelsea",
  league: "Premier League",
  kickoff: "",
} as PuntLeg["job"];

/** Build a minimal BatchResult whose only meaningful field is jobs[] (what counterSlip reads). */
function batchWith(
  jobs: {
    home: string;
    away: string;
    pick: "NO_EDGE" | { market: string; side?: string; odds: number; stake?: number };
    confidence: number;
  }[]
): BatchResult {
  return {
    runId: "t",
    calibrationSnapshotId: "",
    date: "2026-06-07",
    rankingMode: "MAX_EV",
    jobs: jobs.map((j) => ({
      status: "ok",
      home: j.home,
      away: j.away,
      decision: {
        primaryPick: j.pick === "NO_EDGE" ? { market: "1x2", side: "home", odds: 1.5 } : j.pick,
        grade: j.pick === "NO_EDGE" ? "NO_EDGE" : "STRONG",
        confidence: j.confidence,
        rationale: "",
        rejectedAndWhy: [],
      },
    })) as unknown as BatchResult["jobs"],
    completedCount: jobs.length,
    errorCount: 0,
    actionableCount: 0,
    totalRecommendedStakePct: 0,
    cost: { estimatedUsd: 0, ceilingUsd: null, halted: false },
    errors: [],
  };
}

// ── rawLegToMarketSide ────────────────────────────────────────────────────────

describe("rawLegToMarketSide", () => {
  it("maps Over/Under total goals", () => {
    expect(rawLegToMarketSide(rawLeg({ marketDesc: "Total", outcomeDesc: "Over 2.5" }))).toEqual({
      market: "Goals O/U",
      side: "Over 2.5",
    });
  });

  it("maps 1X2 home/draw/away", () => {
    expect(rawLegToMarketSide(rawLeg({ outcomeDesc: "Home" })).side).toBe("Home Win");
    expect(rawLegToMarketSide(rawLeg({ outcomeDesc: "Draw" })).side).toBe("Draw");
    expect(rawLegToMarketSide(rawLeg({ outcomeDesc: "Away" })).side).toBe("Away Win");
  });

  it("maps BTTS yes/no", () => {
    expect(
      rawLegToMarketSide(rawLeg({ marketDesc: "Both Teams to Score", outcomeDesc: "Yes" }))
    ).toEqual({
      market: "BTTS",
      side: "Yes",
    });
  });
});

// ── counterSlip verdicts ──────────────────────────────────────────────────────

describe("counterSlip", () => {
  it("NO_COVERAGE: keeps his pick when the fixture has no job", () => {
    const legs: PuntLeg[] = [{ raw: rawLeg(), job: null }];
    const [leg] = counterSlip(legs, batchWith([]));
    expect(leg?.verdict).toBe("NO_COVERAGE");
    expect(leg?.pick.side).toBe("Home Win");
    expect(leg?.oracleConfidence).toBeNull();
  });

  it("KEPT_LOW_CONVICTION: keeps his pick when ORACLE returns NO_EDGE grade", () => {
    const legs: PuntLeg[] = [{ raw: rawLeg(), job: fakeJob }];
    const batch = batchWith([{ home: "Arsenal", away: "Chelsea", pick: "NO_EDGE", confidence: 0 }]);
    const [leg] = counterSlip(legs, batch);
    expect(leg?.verdict).toBe("KEPT_LOW_CONVICTION");
    expect(leg?.pick.side).toBe("Home Win");
  });

  it("CONFIRMED: keeps his pick when ORACLE agrees on market+side", () => {
    const legs: PuntLeg[] = [
      { raw: rawLeg({ marketDesc: "1X2", outcomeDesc: "Home" }), job: fakeJob },
    ];
    const batch = batchWith([
      {
        home: "Arsenal",
        away: "Chelsea",
        pick: { market: "1X2", side: "Home Win", odds: 2.0 },
        confidence: 0.7,
      },
    ]);
    const [leg] = counterSlip(legs, batch);
    expect(leg?.verdict).toBe("CONFIRMED");
    expect(leg?.oracleConfidence).toBe(0.7);
  });

  it("ADJUSTED: swaps to ORACLE's pick when its confidence clears the threshold", () => {
    // His pick: Home @ 2.0 → implied 0.50. ORACLE: Away Win @ 70% → 0.70-0.50 = 0.20 ≥ 0.05.
    const legs: PuntLeg[] = [{ raw: rawLeg({ outcomeDesc: "Home", odds: 2.0 }), job: fakeJob }];
    const batch = batchWith([
      {
        home: "Arsenal",
        away: "Chelsea",
        pick: { market: "1X2", side: "Away Win", odds: 3.2, stake: 0.04 },
        confidence: 0.7,
      },
    ]);
    const [leg] = counterSlip(legs, batch);
    expect(leg?.verdict).toBe("ADJUSTED");
    expect(leg?.pick.side).toBe("Away Win");
    expect(leg?.pick.odds).toBe(3.2);
  });

  it("KEPT_LOW_CONVICTION: keeps his pick when ORACLE disagrees but below threshold", () => {
    // His pick: Home @ 1.25 → implied 0.80. ORACLE: Away @ 82% → 0.82-0.80 = 0.02 < 0.05.
    const legs: PuntLeg[] = [{ raw: rawLeg({ outcomeDesc: "Home", odds: 1.25 }), job: fakeJob }];
    const batch = batchWith([
      {
        home: "Arsenal",
        away: "Chelsea",
        pick: { market: "1X2", side: "Away Win", odds: 1.22 },
        confidence: 0.82,
      },
    ]);
    const [leg] = counterSlip(legs, batch);
    expect(leg?.verdict).toBe("KEPT_LOW_CONVICTION");
    expect(leg?.pick.side).toBe("Home Win"); // his pick kept
  });
});

// ── loadedSlipToJobs ──────────────────────────────────────────────────────────

describe("loadedSlipToJobs", () => {
  it("returns all job:null when no odds key and nothing in cache", async () => {
    const slip = {
      code: "X",
      legs: [rawLeg(), rawLeg({ home: "Spurs", away: "Everton" })],
      totalOdds: 4,
      loadedAt: "",
    };
    const legs = await loadedSlipToJobs(slip, { oddsApiKey: undefined });
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.job === null)).toBe(true);
  });

  it("returns job:null for a fixture not in the odds-api or sidecar", async () => {
    // "Fictional FC vs Made Up United" will never appear in any live sidecar.
    const slip = {
      code: "X",
      legs: [rawLeg({ home: "Fictional FC", away: "Made Up United", league: "Nowhere League" })],
      totalOdds: 2,
      loadedAt: "",
    };
    const legs = await loadedSlipToJobs(slip, { oddsApiKey: undefined });
    expect(legs).toHaveLength(1);
    expect(legs[0]!.job).toBeNull();
  });
});
