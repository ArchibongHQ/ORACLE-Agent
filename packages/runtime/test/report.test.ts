/** [Wave 2] Tests for report.ts's slate-wide safety-kill-count / gateReason
 *  tally aggregation — surfaces Wave 1's per-fixture MLSafetyFilter kill
 *  telemetry and evGate gateReason attribution in one place instead of only
 *  per-fixture. Pure aggregation over already-computed data; never touches
 *  staking. */
import type { BatchJobResult } from "@oracle/engine";
import { describe, expect, it } from "vitest";
import { aggregateGateReasons, aggregateSafetyKillCounts, renderReport } from "../src/report.js";

function okJob(overrides: Partial<BatchJobResult> = {}): BatchJobResult {
  return {
    status: "ok",
    analysisId: "a1",
    runId: "r1",
    fixtureId: "f1",
    home: "Home FC",
    away: "Away FC",
    league: "Premier League",
    kickoff: "2026-07-10T15:00:00Z",
    result: {
      evMarkets: [],
      portfolioCorrelation: null,
      fp: { home: 0.4, draw: 0.3, away: 0.3 },
      bayesian_lH: 1.4,
      bayesian_lA: 1.1,
      expectedScoreline: "1-1",
    } as unknown as BatchJobResult["result"],
    decision: {
      primaryPick: { market: "Goals O/U", odds: 1.9 },
      confidence: 0.5,
      grade: "NO_EDGE",
      rationale: "",
      rejectedAndWhy: [],
    } as unknown as BatchJobResult["decision"],
    decisionReplay: null,
    eligibleBets: [],
    primaryPick: null,
    llmEligible: true,
    ...overrides,
  } as BatchJobResult;
}

function errorJob(): BatchJobResult {
  return {
    status: "error",
    fixtureId: "f2",
    home: "Ghost FC",
    away: "Phantom FC",
    league: "Premier League",
    kickoff: "2026-07-10T15:00:00Z",
    code: "UNKNOWN",
    message: "boom",
    retriable: false,
  } as unknown as BatchJobResult;
}

describe("aggregateSafetyKillCounts", () => {
  it("sums killCounts across every ok job, ignoring error jobs and jobs without any", () => {
    const jobs = [
      okJob({ safetyKillCounts: { S1: 1, S7: 2 } }),
      okJob({ safetyKillCounts: { S7: 1, S11: 1 } }),
      okJob({ safetyKillCounts: undefined }),
      errorJob(),
    ];
    expect(aggregateSafetyKillCounts(jobs)).toEqual({ S1: 1, S7: 3, S11: 1 });
  });

  it("returns an empty object when no fixture carried any kill counts", () => {
    expect(aggregateSafetyKillCounts([okJob(), errorJob()])).toEqual({});
  });
});

describe("aggregateGateReasons", () => {
  it("tallies gateReason across every v3AssessmentStats entry on every ok job", () => {
    const jobs = [
      okJob({
        v3AssessmentStats: [
          {
            family: "goals_ou",
            desc: "Over 2.5",
            outcome: "below_gate",
            rawEdge: 0.03,
            adjustedEdge: 0.03,
            cls: "S",
            gateReason: "class_edge",
          },
          {
            family: "btts",
            desc: "BTTS Yes",
            outcome: "done",
            rawEdge: 0.06,
            adjustedEdge: 0.06,
            cls: "M",
          },
        ],
      }),
      okJob({
        v3AssessmentStats: [
          {
            family: "match_result",
            desc: "Home",
            outcome: "below_gate",
            rawEdge: 0.02,
            adjustedEdge: 0.02,
            cls: "S",
            gateReason: "class_edge",
          },
          {
            family: "goals_ou",
            desc: "Under 2.5",
            outcome: "below_gate",
            rawEdge: -0.01,
            adjustedEdge: -0.01,
            cls: "M",
            gateReason: "ev_floor",
          },
        ],
      }),
      errorJob(),
    ];
    expect(aggregateGateReasons(jobs)).toEqual({ class_edge: 2, ev_floor: 1 });
  });

  it("returns an empty object when no assessment carried a gateReason", () => {
    const jobs = [
      okJob({
        v3AssessmentStats: [
          {
            family: "goals_ou",
            desc: "Over 2.5",
            outcome: "done",
            rawEdge: 0.06,
            adjustedEdge: 0.06,
            cls: "S",
          },
        ],
      }),
    ];
    expect(aggregateGateReasons(jobs)).toEqual({});
  });
});

describe("renderReport — tally section", () => {
  const baseBatch = {
    runId: "r1",
    calibrationSnapshotId: "calib_2026-07-10",
    date: "2026-07-10",
    rankingMode: "MAX_EV",
    completedCount: 1,
    errorCount: 0,
    actionableCount: 0,
    totalRecommendedStakePct: 0,
    cost: { estimatedUsd: 0, ceilingUsd: null, halted: false },
    errors: [],
  } as const;

  it("omits the tallies section entirely when no fixture carries kill counts or gate reasons", () => {
    const html = renderReport({ ...baseBatch, jobs: [okJob()] } as unknown as Parameters<
      typeof renderReport
    >[0]);
    expect(html).not.toContain('<div class="tallies">');
  });

  it("renders both tally groups when data is present", () => {
    const html = renderReport({
      ...baseBatch,
      jobs: [
        okJob({
          safetyKillCounts: { S11: 1 },
          v3AssessmentStats: [
            {
              family: "goals_ou",
              desc: "Over 2.5",
              outcome: "below_gate",
              rawEdge: 0.03,
              adjustedEdge: 0.03,
              cls: "S",
              gateReason: "class_edge",
            },
          ],
        }),
      ],
    } as unknown as Parameters<typeof renderReport>[0]);
    expect(html).toContain("Safety kill counts");
    expect(html).toContain("S11");
    expect(html).toContain("Gate reasons");
    expect(html).toContain("class_edge");
  });
});
