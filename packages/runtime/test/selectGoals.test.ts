import type { BatchJobResult, EVMarket, RunResult } from "@oracle/engine";
import { describe, expect, it } from "vitest";
import type { SportyBetEventDetail } from "../src/selectFixtures.js";
import { sidecarKey } from "../src/selectFixtures.js";
import {
  GOALS_MARKETS,
  goalsDataGate,
  pickSafestGoalsLeg,
  selectGoalsAccumulator,
} from "../src/selectGoals.js";

// ── builders ────────────────────────────────────────────────────────────────

function evm(label: string, mp: number, ip: number, odds = 1 / ip, cat = "Goals O/U"): EVMarket {
  return {
    cat,
    label,
    market: cat,
    side: label,
    mp,
    modelProb: mp,
    ip,
    rawEdge: mp - ip,
    ev: (mp - ip) * odds,
    odds,
    stake: 0,
    stakeAmt: 0,
    rankingScore: mp,
    varianceMod: 1,
  };
}

function okJob(
  home: string,
  away: string,
  evMarkets: EVMarket[],
  league = "Premier League"
): BatchJobResult {
  return {
    status: "ok",
    analysisId: `a_${home}_${away}`,
    runId: "run1",
    fixtureId: `f_${home}_${away}`,
    home,
    away,
    league,
    kickoff: "2026-06-15T15:00:00Z",
    result: { evMarkets } as unknown as RunResult,
    decision: {
      primaryPick: { market: "x", odds: 1 },
      confidence: 0.5,
      grade: "LEAN",
      rationale: "",
      rejectedAndWhy: [],
    },
    decisionReplay: null,
    eligibleBets: [],
    primaryPick: null,
  };
}

function errJob(home: string, away: string): BatchJobResult {
  return {
    status: "error",
    fixtureId: `f_${home}_${away}`,
    home,
    away,
    league: "Premier League",
    kickoff: "2026-06-15T15:00:00Z",
    reason: "boom",
    errorCode: "NO_DATA",
  };
}

/** Detail with both-teams goals + defensive figures (passes the strict gate). */
function richDetail(): SportyBetEventDetail {
  return {
    eventId: "e1",
    odds: null,
    stats: {
      goals: {
        home: { avg_scored: 2.1, avg_conceded: 1.0 },
        away: { avg_scored: 1.8, avg_conceded: 1.2 },
      },
      standings: { home: { ga: 18 }, away: { ga: 22 } },
    },
    statscoverage: null,
  };
}

/** Detail with only a single team's scoring signal (lenient gate only). */
function thinDetail(): SportyBetEventDetail {
  return {
    eventId: "e2",
    odds: null,
    stats: { goals: { home: { avg_scored: 1.6 }, away: null } },
    statscoverage: null,
  };
}

function detailMap(entries: Array<[string, string, SportyBetEventDetail]>) {
  const m = new Map<string, SportyBetEventDetail>();
  for (const [h, a, d] of entries) m.set(sidecarKey(h, a), d);
  return m;
}

// ── goalsDataGate ─────────────────────────────────────────────────────────────

describe("goalsDataGate", () => {
  it("rejects markets outside GOALS_MARKETS", () => {
    expect(goalsDataGate(richDetail(), "Premier League", "Over 3.5")).toBe(false);
    expect(goalsDataGate(richDetail(), "Premier League", "BTTS Yes")).toBe(false);
  });

  it("rejects cup / friendly / derby leagues regardless of data", () => {
    expect(goalsDataGate(richDetail(), "FA Cup", "Over 1.5")).toBe(false);
    expect(goalsDataGate(richDetail(), "Club Friendly", "Over 1.5")).toBe(false);
    expect(goalsDataGate(richDetail(), "Merseyside Derby", "Over 1.5")).toBe(false);
  });

  it("Over 2.5 (strict): requires both teams goals + a defensive figure", () => {
    expect(goalsDataGate(richDetail(), "Premier League", "Over 2.5")).toBe(true);
    expect(goalsDataGate(thinDetail(), "Premier League", "Over 2.5")).toBe(false);
    expect(goalsDataGate(undefined, "Premier League", "Over 2.5")).toBe(false);
  });

  it("Over 1.5 / Team Over 0.5 (lenient): any single-team scoring signal suffices", () => {
    expect(goalsDataGate(thinDetail(), "Premier League", "Over 1.5")).toBe(true);
    expect(goalsDataGate(thinDetail(), "Premier League", "Home Total Over 0.5")).toBe(true);
    expect(goalsDataGate(undefined, "Premier League", "Over 1.5")).toBe(false);
  });
});

// ── pickSafestGoalsLeg ───────────────────────────────────────────────────────

describe("pickSafestGoalsLeg", () => {
  const detailByKey = detailMap([["A", "B", richDetail()]]);

  it("returns null for errored jobs", () => {
    expect(pickSafestGoalsLeg(errJob("A", "B"), { detailByKey })).toBeNull();
  });

  it("returns null when no allowed market clears the bars", () => {
    const job = okJob("A", "B", [evm("Over 2.5", 0.6, 0.55)]); // mp below 0.75
    expect(pickSafestGoalsLeg(job, { detailByKey })).toBeNull();
  });

  it("ignores non-goals markets even at high confidence", () => {
    const job = okJob("A", "B", [evm("AH Home -1", 0.95, 0.9, undefined, "Asian Handicap")]);
    expect(pickSafestGoalsLeg(job, { detailByKey })).toBeNull();
  });

  it("picks the highest-mp qualifying goals leg (safest)", () => {
    const job = okJob("A", "B", [
      evm("Over 1.5", 0.92, 0.8),
      evm("Over 2.5", 0.78, 0.72),
    ]);
    const leg = pickSafestGoalsLeg(job, { detailByKey });
    expect(leg?.side).toBe("Over 1.5");
    expect(leg?.mp).toBeCloseTo(0.92);
  });

  it("drops Over 2.5 when strict data gate fails but keeps a passing Over 1.5", () => {
    const thin = detailMap([["A", "B", thinDetail()]]);
    const job = okJob("A", "B", [
      evm("Over 2.5", 0.95, 0.9), // would win on mp, but strict gate fails
      evm("Over 1.5", 0.8, 0.76),
    ]);
    const leg = pickSafestGoalsLeg(job, { detailByKey: thin });
    expect(leg?.side).toBe("Over 1.5");
  });

  it("respects veto and the implied-prob floor", () => {
    const vetoed = okJob("A", "B", [{ ...evm("Over 1.5", 0.9, 0.8), veto: "X" }]);
    expect(pickSafestGoalsLeg(vetoed, { detailByKey })).toBeNull();
    const lowIp = okJob("A", "B", [evm("Over 1.5", 0.9, 0.6)]); // ip below 0.70
    expect(pickSafestGoalsLeg(lowIp, { detailByKey })).toBeNull();
  });
});

// ── selectGoalsAccumulator ───────────────────────────────────────────────────

describe("selectGoalsAccumulator", () => {
  it("ranks legs by mp desc and counts markets", () => {
    const detailByKey = detailMap([
      ["A", "B", richDetail()],
      ["C", "D", thinDetail()],
    ]);
    const jobs = [
      okJob("A", "B", [evm("Over 2.5", 0.82, 0.78)]),
      okJob("C", "D", [evm("Over 1.5", 0.9, 0.85)]),
    ];
    const res = selectGoalsAccumulator(jobs, { detailByKey });
    expect(res.legs.map((l) => l.side)).toEqual(["Over 1.5", "Over 2.5"]);
    expect(res.counts).toEqual({ over15: 1, over25: 1, teamOver05: 0 });
    expect(res.qualified).toBe(2);
  });

  it("caps at target as a CEILING (does not relax to fill)", () => {
    const detailByKey = detailMap([
      ["A", "B", richDetail()],
      ["C", "D", richDetail()],
      ["E", "F", richDetail()],
    ]);
    const jobs = [
      okJob("A", "B", [evm("Over 1.5", 0.95, 0.9)]),
      okJob("C", "D", [evm("Over 1.5", 0.9, 0.85)]),
      okJob("E", "F", [evm("Over 1.5", 0.85, 0.8)]),
    ];
    const res = selectGoalsAccumulator(jobs, { detailByKey, target: 2 });
    expect(res.legs).toHaveLength(2);
    expect(res.qualified).toBe(3); // all qualified, but only 2 fit the ceiling
    expect(res.legs.map((l) => l.mp)).toEqual([0.95, 0.9]); // top-2 by mp
  });

  it("returns fewer than target when fewer qualify (no dilution)", () => {
    const detailByKey = detailMap([["A", "B", richDetail()]]);
    const jobs = [
      okJob("A", "B", [evm("Over 1.5", 0.9, 0.85)]),
      okJob("C", "D", [evm("Over 1.5", 0.5, 0.45)]), // below bar, no detail
    ];
    const res = selectGoalsAccumulator(jobs, { detailByKey, target: 39 });
    expect(res.legs).toHaveLength(1);
    expect(res.analysed).toBe(2);
  });
});

describe("GOALS_MARKETS", () => {
  it("contains exactly the four allowed labels", () => {
    expect([...GOALS_MARKETS].sort()).toEqual(
      ["Away Total Over 0.5", "Home Total Over 0.5", "Over 1.5", "Over 2.5"].sort()
    );
  });
});
