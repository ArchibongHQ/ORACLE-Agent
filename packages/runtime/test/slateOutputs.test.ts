/** PR-5b — slateOutputs.ts (daily-batch v3 Output A–D + sanity assembly) tests.
 *  Confirms buildMarketsV3SlateOutputs is pure glue over @oracle/engine's own
 *  builders (pool/A/B/C/D/sanity), and curateActionableByV3Outputs's §7-ranked
 *  ordering + unmatched-picks fallback. */

import type { FixtureJobSuccess, V3OutputCandidate, V3OutputRow } from "@oracle/engine";
import { describe, expect, it } from "vitest";
import {
  buildMarketsV3SlateOutputs,
  curateActionableByV3Outputs,
} from "../src/marketsV3/slateOutputs.js";

function candidate(overrides: Partial<V3OutputCandidate> = {}): V3OutputCandidate {
  return {
    marketName: "Over/Under",
    desc: "Over 2.5",
    cls: "M",
    mp: 0.55,
    odds: 2.1,
    q: 0.5,
    rawEdge: 0.08,
    penaltyPts: 0,
    adjustedEdge: 0.08,
    adjEvPct: 0.16,
    confidence: "high",
    ...overrides,
  };
}

function job(
  i: number,
  overrides: Partial<FixtureJobSuccess> & { best?: V3OutputCandidate | null } = {}
): FixtureJobSuccess {
  const { best, ...rest } = overrides;
  return {
    status: "ok",
    analysisId: `a${i}`,
    runId: "run1",
    fixtureId: `f${i}`,
    home: `Home${i}`,
    away: `Away${i}`,
    league: `League${i % 3}`,
    kickoff: new Date(2026, 0, 1, i).toISOString(),
    llmEligible: true,
    ...(best !== undefined ? { v3Best: best ?? undefined } : {}),
    ...rest,
  } as unknown as FixtureJobSuccess;
}

describe("buildMarketsV3SlateOutputs", () => {
  it("assembles pool/outputA/B/C/D from a handful of FixtureJobSuccess-shaped jobs, dropping fixtures with no v3Best", () => {
    const jobs: FixtureJobSuccess[] = [
      job(1, { best: candidate({ adjustedEdge: 0.05, odds: 1.8 }) }),
      job(2, { best: null }), // v3 didn't run / nothing survived — must be dropped, not error
      job(3, { best: candidate({ adjustedEdge: 0.12, odds: 4.5 }) }),
      job(4, { best: candidate({ adjustedEdge: 0.09, odds: 2.8 }) }),
    ];

    const out = buildMarketsV3SlateOutputs(jobs);

    // Pool: one row per surviving fixture (3, not 4 — f2 dropped), ranked best-first.
    expect(out.pool).toHaveLength(3);
    expect(out.pool.map((r) => r.fixtureId)).toEqual(["f3", "f4", "f1"]);

    // Output A: top 39 (all 3 here, under the cap).
    expect(out.outputA).toHaveLength(3);

    // Output B: mini-ACCA + best singles, both derived from Output A.
    expect(out.outputB.bestSingles.length).toBeGreaterThan(0);

    // Output C: odds >= 4.00 only.
    expect(out.outputC.map((r) => r.fixtureId)).toEqual(["f3"]);

    // Output D: 2.50 <= odds < 4.00 only.
    expect(out.outputD.map((r) => r.fixtureId)).toEqual(["f4"]);
  });

  it("computes sanity from every job's v3AssessmentStats (done/capped/discarded alike), defaulting to an empty input when absent", () => {
    const jobs: FixtureJobSuccess[] = [
      job(1, {
        best: candidate(),
        v3AssessmentStats: [
          { family: "goals_ou", desc: "Over 2.5", outcome: "done", rawEdge: 0.06 },
          { family: "asian_handicap", desc: "Home -1", outcome: "capped", rawEdge: 0.2 },
        ],
      }),
      job(2, { best: null }), // no v3AssessmentStats at all — must not throw
    ];

    const out = buildMarketsV3SlateOutputs(jobs);

    expect(out.sanity).toBeDefined();
    expect(typeof out.sanityLine).toBe("string");
    expect(out.sanityLine.length).toBeGreaterThan(0);
  });

  it("returns an empty pool/outputs (no error) for a slate where every job has no v3Best", () => {
    const jobs: FixtureJobSuccess[] = [job(1, { best: null }), job(2, { best: null })];

    const out = buildMarketsV3SlateOutputs(jobs);

    expect(out.pool).toHaveLength(0);
    expect(out.outputA).toHaveLength(0);
    expect(out.outputB.miniAcca).toHaveLength(0);
    expect(out.outputC).toHaveLength(0);
    expect(out.outputD).toHaveLength(0);
    expect(out.sanityLine).toMatch(/clean|Sanity/);
  });
});

describe("curateActionableByV3Outputs", () => {
  type Pick = { home: string; away: string; confidence: number };

  function outputRow(home: string, away: string): V3OutputRow {
    return {
      fixtureId: `${home}::${away}`,
      home,
      away,
      league: "L",
      kickoff: "2026-08-01T15:00:00Z",
      marketName: "Over/Under",
      desc: "Over 2.5",
      cls: "M",
      mp: 0.55,
      odds: 2.1,
      q: 0.5,
      rawEdge: 0.08,
      penaltyPts: 0,
      adjustedEdge: 0.08,
      adjEvPct: 0.16,
      confidence: "high",
    };
  }

  it("sorts v3-ranked picks by their Output A rank", () => {
    const outputA = [outputRow("Team3", "X"), outputRow("Team1", "X"), outputRow("Team2", "X")];
    const actionable: Pick[] = [
      { home: "Team1", away: "X", confidence: 0.5 },
      { home: "Team2", away: "X", confidence: 0.9 },
      { home: "Team3", away: "X", confidence: 0.1 },
    ];

    const result = curateActionableByV3Outputs(actionable, outputA, 39);

    // Ranked by outputA order (Team3 first, then Team1, then Team2), NOT confidence.
    expect(result.map((p) => p.home)).toEqual(["Team3", "Team1", "Team2"]);
  });

  it("sorts unmatched picks (not in Output A) after every ranked pick, by confidence descending among themselves", () => {
    const outputA = [outputRow("Ranked1", "X")];
    const actionable: Pick[] = [
      { home: "Unmatched-Low", away: "X", confidence: 0.2 },
      { home: "Ranked1", away: "X", confidence: 0.01 }, // low confidence, but v3-ranked — still first
      { home: "Unmatched-High", away: "X", confidence: 0.8 },
    ];

    const result = curateActionableByV3Outputs(actionable, outputA, 39);

    expect(result.map((p) => p.home)).toEqual(["Ranked1", "Unmatched-High", "Unmatched-Low"]);
  });

  it("respects max, keeping only the top N after ranking", () => {
    const outputA = [outputRow("A", "X"), outputRow("B", "X"), outputRow("C", "X")];
    const actionable: Pick[] = [
      { home: "A", away: "X", confidence: 0.1 },
      { home: "B", away: "X", confidence: 0.2 },
      { home: "C", away: "X", confidence: 0.3 },
    ];

    const result = curateActionableByV3Outputs(actionable, outputA, 2);

    expect(result).toHaveLength(2);
    expect(result.map((p) => p.home)).toEqual(["A", "B"]);
  });
});
