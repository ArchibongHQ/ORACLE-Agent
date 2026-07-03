/** all-markets-analysis-prompt-v3 R10 — goals-batch verification arbiter
 *  tests. Verifies the owner-locked downgrade+re-gate semantics: agree
 *  confirms, disagree penalizes -2pt and downgrades one confidence tier then
 *  re-gates, no independent opinion skips silently. */

import type { V3AllMarketsAssessment, V3AnalyzeInput } from "@oracle/engine";
import { describe, expect, it } from "vitest";
import {
  CROSSCHECK_DISAGREE_PENALTY,
  crossCheckGoalsPick,
} from "../src/marketsV3/goalsCrossCheck.js";

function goalsInput(overrides: Partial<V3AnalyzeInput> = {}): V3AnalyzeInput {
  return {
    fixtureId: "f1",
    runId: "r1",
    home: "Home FC",
    away: "Away FC",
    league: "__unknown_league__",
    kickoff: new Date().toISOString(),
    odds: {
      over25: 1.85,
      under25: 1.95,
    },
    lambdaInput: {
      league: "__unknown_league__",
      homeScoredPer90: 1.7,
      homeConcededPer90: 1.0,
      awayScoredPer90: 1.2,
      awayConcededPer90: 1.5,
      nHome: 10,
      nAway: 10,
    },
    penaltyFlags: {},
    completeness: 100,
    sources: ["sportybet-gismo"],
    ...overrides,
  };
}

function pick(overrides: Partial<V3AllMarketsAssessment> = {}): V3AllMarketsAssessment {
  return {
    q: 0.5,
    devigged: true,
    rawEdge: 0.1,
    penaltyPts: 0,
    adjustedEdge: 0.1,
    adjEvPct: 0.2,
    cls: "M",
    outcome: "done",
    confidence: "very_high",
    ...overrides,
  };
}

describe("crossCheckGoalsPick", () => {
  it("returns no_data when the goals engine's fixed menu doesn't cover this label", () => {
    const result = crossCheckGoalsPick(pick(), "Over 3.5", 1.9, goalsInput());
    expect(result.verdict).toBe("no_data");
    expect(result.survives).toBe(true);
    expect(result.assessment).toEqual(pick());
  });

  it("returns no_data when the goals engine can't build a λ model at all (e.g. no scoring data)", () => {
    const result = crossCheckGoalsPick(
      pick(),
      "Over 2.5",
      1.85,
      goalsInput({ lambdaInput: { league: "__unknown_league__" } })
    );
    expect(result.verdict).toBe("no_data");
    expect(result.survives).toBe(true);
  });

  it("agrees when the goals engine independently clears the same exact market", () => {
    // Verified via the actual goalsV3 math (μ=2.885 at this lambdaInput):
    // P(Over2.5)=55.0%, odds 2.05/1.75 devig to q=45.8% → rawEdge=9.2pts,
    // tier=high, outcome=done.
    const p = pick();
    const result = crossCheckGoalsPick(
      p,
      "Over 2.5",
      1.85,
      goalsInput({ odds: { over25: 2.05, under25: 1.75 } })
    );
    expect(result.verdict).toBe("agree");
    expect(result.survives).toBe(true);
    expect(result.assessment).toEqual(p);
    expect(result.annotation).toContain("goals-verified");
  });

  it("disagrees and survives when the downgraded edge still clears the class gate", () => {
    // Force the goals engine to independently REJECT Over 2.5: low-scoring λ
    // model vs an overs-favoring market price ⇒ deeply negative raw edge ⇒
    // below_edge in the goals engine's own gate.
    const lowScoringGoalsInput = goalsInput({
      lambdaInput: {
        league: "__unknown_league__",
        homeScoredPer90: 0.8,
        homeConcededPer90: 0.8,
        awayScoredPer90: 0.8,
        awayConcededPer90: 0.8,
        nHome: 10,
        nAway: 10,
      },
      odds: { over25: 1.45, under25: 2.7 }, // market heavily favors overs
    });

    const bigEdgePick = pick({ cls: "M", adjustedEdge: 0.1, q: 0.5 });
    const result = crossCheckGoalsPick(bigEdgePick, "Over 2.5", 1.85, lowScoringGoalsInput);

    expect(result.verdict).toBe("disagree");
    expect(result.survives).toBe(true);
    expect(result.assessment.adjustedEdge).toBeCloseTo(0.1 - CROSSCHECK_DISAGREE_PENALTY, 5);
    expect(result.assessment.outcome).toBe("done");
    expect(result.assessment.confidence).toBe("high"); // very_high downgraded one tier
    expect(result.annotation).toContain("still clears");
  });

  it("disagrees and drops when the downgraded edge no longer clears the class gate", () => {
    const lowScoringGoalsInput = goalsInput({
      lambdaInput: {
        league: "__unknown_league__",
        homeScoredPer90: 0.8,
        homeConcededPer90: 0.8,
        awayScoredPer90: 0.8,
        awayConcededPer90: 0.8,
        nHome: 10,
        nAway: 10,
      },
      odds: { over25: 1.45, under25: 2.7 },
    });

    // Class M floor is 0.05 adjustedEdge — start just above it so the -0.02
    // downgrade pushes it below.
    const marginalPick = pick({ cls: "M", adjustedEdge: 0.055, q: 0.5 });
    const result = crossCheckGoalsPick(marginalPick, "Over 2.5", 1.85, lowScoringGoalsInput);

    expect(result.verdict).toBe("disagree");
    expect(result.survives).toBe(false);
    expect(result.assessment.outcome).toBe("below_gate");
    expect(result.assessment.confidence).toBeNull();
    expect(result.annotation).toContain("dropping");
  });

  it("floors the confidence downgrade at medium rather than producing an invalid tier", () => {
    const lowScoringGoalsInput = goalsInput({
      lambdaInput: {
        league: "__unknown_league__",
        homeScoredPer90: 0.8,
        homeConcededPer90: 0.8,
        awayScoredPer90: 0.8,
        awayConcededPer90: 0.8,
        nHome: 10,
        nAway: 10,
      },
      odds: { over25: 1.45, under25: 2.7 },
    });
    // "high" is one step above the floor — downgrading it lands at "medium",
    // the lowest defined tier (there's no tier below medium to downgrade to).
    const pick2 = pick({ cls: "M", adjustedEdge: 0.08, q: 0.5, confidence: "high" });
    const result = crossCheckGoalsPick(pick2, "Over 2.5", 1.85, lowScoringGoalsInput);
    expect(result.survives).toBe(true);
    expect(result.assessment.confidence).toBe("medium");
  });
});
