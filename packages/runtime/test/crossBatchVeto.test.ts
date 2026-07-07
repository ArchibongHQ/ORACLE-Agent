/** [PR-13] Cross-batch portfolio dedup — crossBatchVetoKeys/applyCrossBatchVeto. */
import type { PortfolioLeg } from "@oracle/engine";
import { describe, expect, it } from "vitest";
import { applyCrossBatchVeto, crossBatchVetoKeys } from "../src/goalsV3/crossBatchVeto.js";
import type { GoalsLeg, GoalsSelectionResult } from "../src/selectGoals.js";

function makeLeg(overrides: Partial<GoalsLeg> = {}): GoalsLeg {
  return {
    home: "Arsenal",
    away: "Chelsea",
    league: "Premier League",
    kickoff: "2026-07-07T15:00:00Z",
    market: "Goals O/U",
    side: "Over 2.5",
    odds: 1.8,
    mp: 0.6,
    ip: 0.55,
    edge: 0.05,
    ...overrides,
  };
}

function makeSelection(legs: GoalsLeg[], shortSlipLegs: GoalsLeg[] = legs): GoalsSelectionResult {
  return {
    legs,
    shortSlipLegs,
    target: 39,
    analysed: legs.length,
    qualified: legs.length,
    counts: { over15: 0, over25: legs.length, teamOver05: 0 },
    combinedProb: legs.reduce((acc, l) => acc * l.mp, 1),
    combinedOdds: legs.reduce((acc, l) => acc * l.odds, 1),
    shortSlipCombinedProb: shortSlipLegs.reduce((acc, l) => acc * l.mp, 1),
    shortSlipCombinedOdds: shortSlipLegs.reduce((acc, l) => acc * l.odds, 1),
    outputBLegs: [],
    outputCLegs: [],
    miniAccaLegs: [],
    miniAccaCombinedProb: 1,
    miniAccaCombinedOdds: 1,
  };
}

describe("crossBatchVetoKeys", () => {
  it("returns no vetoes when there are no daily-batch legs (fail-open)", () => {
    const selection = makeSelection([makeLeg()]);
    expect(crossBatchVetoKeys(selection, []).size).toBe(0);
  });

  it("vetoes a leg sharing league + kickoff window with an existing daily-batch pick", () => {
    const leg = makeLeg({ home: "Arsenal", away: "Chelsea", league: "Premier League" });
    const selection = makeSelection([leg]);
    const existing: PortfolioLeg[] = [
      {
        home: "Liverpool",
        away: "Everton",
        league: "Premier League",
        market: "1x2 Home",
        mp: 0.5,
        kickoff: "2026-07-07T15:30:00Z", // within the 3h same-window bonus
      },
    ];
    const vetoes = crossBatchVetoKeys(selection, existing);
    expect(vetoes.size).toBe(1);
    const [reason] = vetoes.values();
    expect(reason).toContain("cross-batch correlation");
    expect(reason).toContain("Liverpool");
  });

  it("does not veto a leg in a different league with no shared kickoff window", () => {
    const leg = makeLeg({ league: "Serie A", kickoff: "2026-07-07T12:00:00Z" });
    const selection = makeSelection([leg]);
    const existing: PortfolioLeg[] = [
      {
        home: "Liverpool",
        away: "Everton",
        league: "Premier League",
        market: "1x2 Home",
        mp: 0.5,
        kickoff: "2026-07-07T20:00:00Z",
      },
    ];
    expect(crossBatchVetoKeys(selection, existing).size).toBe(0);
  });

  it("does not veto same-league legs outside the kickoff window (rho=0.25, below the 0.3 reject bar)", () => {
    const leg = makeLeg({ league: "Premier League", kickoff: "2026-07-07T12:00:00Z" });
    const selection = makeSelection([leg]);
    const existing: PortfolioLeg[] = [
      {
        home: "Liverpool",
        away: "Everton",
        league: "Premier League",
        market: "1x2 Home",
        mp: 0.5,
        kickoff: "2026-07-07T20:00:00Z", // 8h apart — no same-window bonus
      },
    ];
    expect(crossBatchVetoKeys(selection, existing).size).toBe(0);
  });

  it("dedupes legs shared across long/short slips before checking", () => {
    const leg = makeLeg();
    const selection = makeSelection([leg], [leg]);
    const existing: PortfolioLeg[] = [
      {
        home: "Liverpool",
        away: "Everton",
        league: leg.league,
        market: "1x2",
        mp: 0.5,
        kickoff: leg.kickoff,
      },
    ];
    // Same leg appears in both legs and shortSlipLegs — should produce exactly one veto key.
    expect(crossBatchVetoKeys(selection, existing).size).toBe(1);
  });
});

describe("applyCrossBatchVeto", () => {
  it("returns the selection unchanged when there are no vetoes", () => {
    const selection = makeSelection([makeLeg()]);
    expect(applyCrossBatchVeto(selection, new Map())).toBe(selection);
  });

  it("drops the vetoed leg from every output and recomputes combined odds/prob", () => {
    const keep = makeLeg({ home: "Arsenal", away: "Chelsea", odds: 2.0, mp: 0.5 });
    const drop = makeLeg({ home: "Man City", away: "Spurs", odds: 1.5, mp: 0.7 });
    const selection = makeSelection([keep, drop], [keep, drop]);
    const vetoes = new Map([[`${drop.home}|${drop.away}|${drop.side}`, "too correlated"]]);

    const result = applyCrossBatchVeto(selection, vetoes);

    expect(result.legs).toEqual([keep]);
    expect(result.shortSlipLegs).toEqual([keep]);
    expect(result.combinedProb).toBeCloseTo(keep.mp, 10);
    expect(result.combinedOdds).toBeCloseTo(keep.odds, 10);
    expect(result.shortSlipCombinedProb).toBeCloseTo(keep.mp, 10);
    expect(result.shortSlipCombinedOdds).toBeCloseTo(keep.odds, 10);
  });

  it("never touches outputs that had no vetoed leg", () => {
    const keep = makeLeg();
    const selection = makeSelection([keep], [keep]);
    // Veto key for a leg that isn't actually in this selection.
    const vetoes = new Map([["nobody|here|X", "n/a"]]);
    const result = applyCrossBatchVeto(selection, vetoes);
    expect(result.legs).toEqual([keep]);
    expect(result.combinedProb).toBe(selection.combinedProb);
  });
});
