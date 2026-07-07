/** PR-5b — slateOutputs.ts (daily-batch v3 Output A–D + sanity assembly) tests.
 *  Confirms buildMarketsV3SlateOutputs is pure glue over @oracle/engine's own
 *  builders (pool/A/B/C/D/sanity), and curateActionableByV3Outputs's §7-ranked
 *  ordering + unmatched-picks fallback. */

import type {
  BatchJobResult,
  FixtureJobSuccess,
  RouteCoverage,
  V3OutputCandidate,
  V3OutputRow,
} from "@oracle/engine";
import { describe, expect, it } from "vitest";
import {
  buildManifestMarketCoverage,
  buildMarketsV3SlateOutputs,
  curateActionableByV3Outputs,
  formatMarketCoverageNote,
  rollupCoverage,
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

function coverage(overrides: Partial<RouteCoverage> = {}): RouteCoverage {
  return {
    total: 10,
    routed: 6,
    byEngine: {
      totals: 6,
      result: 0,
      shape: 0,
      half: 0,
      time: 0,
      exotics: 0,
      corners: 0,
      cards: 0,
    },
    skipped: {
      "player-market": 1,
      "plain-1x2": 1,
      "non-goal-metric": 1,
      "corners-dormant": 0,
      "cards-dormant": 0,
      "settlement-variant": 0,
      "no-grid-model": 1,
      uncatalogued: 0,
      "bad-specifier": 0,
    },
    ...overrides,
  };
}

function assessmentStat(outcome: string) {
  return { family: "goals_ou", desc: "Over 2.5", outcome, rawEdge: 0.05 };
}

describe("rollupCoverage (PR-20)", () => {
  it("returns null when no fixture in the batch carries v3Coverage", () => {
    const jobs = [job(1, {}), job(2, {})];
    expect(rollupCoverage(jobs)).toBeNull();
  });

  it("sums total/routed/byEngine/skipped across every fixture that carries v3Coverage, skipping those that don't", () => {
    const jobs = [
      job(1, { v3Coverage: coverage({ total: 10, routed: 6 }) }),
      job(2, {}), // v3 didn't run for this one — must not blow up the sum
      job(3, {
        v3Coverage: coverage({
          total: 5,
          routed: 2,
          byEngine: {
            totals: 1,
            result: 1,
            shape: 0,
            half: 0,
            time: 0,
            exotics: 0,
            corners: 0,
            cards: 0,
          },
        }),
      }),
    ];

    const result = rollupCoverage(jobs);

    expect(result?.total).toBe(15);
    expect(result?.routed).toBe(8);
    expect(result?.byEngine.totals).toBe(7);
    expect(result?.byEngine.result).toBe(1);
    expect(result?.skipped["player-market"]).toBe(2); // 1 + 1 from the two coverage()s
  });

  it("merges unrouted market names across fixtures and caps to the top 5 by count descending", () => {
    const jobs = [
      job(1, {
        v3Coverage: coverage({ unrouted: { "Market A": 3, "Market B": 1 } }),
      }),
      job(2, {
        v3Coverage: coverage({
          unrouted: { "Market A": 2, "Market C": 5, "Market D": 1, "Market E": 1, "Market F": 1 },
        }),
      }),
    ];

    const result = rollupCoverage(jobs);

    // Market A: 3+2=5, Market C: 5 — tied for first; both must survive the top-5 cap
    // ahead of the four count=1 markets (B, D, E, F — only 3 of those 4 fit).
    expect(result?.topUnrouted).toHaveLength(5);
    expect(result?.topUnrouted[0]?.count).toBe(5);
    expect(result?.topUnrouted[1]?.count).toBe(5);
    expect(result?.topUnrouted.map((u) => u.name)).toContain("Market A");
    expect(result?.topUnrouted.map((u) => u.name)).toContain("Market C");
  });

  it("derives priced/gatePassed from v3AssessmentStats (priced = every entry, gatePassed = outcome:'done' only)", () => {
    const jobs = [
      job(1, {
        v3Coverage: coverage(),
        v3AssessmentStats: [assessmentStat("done"), assessmentStat("capped")],
      }),
      job(2, {
        v3Coverage: coverage(),
        v3AssessmentStats: [assessmentStat("done"), assessmentStat("done")],
      }),
    ];

    const result = rollupCoverage(jobs);

    expect(result?.priced).toBe(4);
    expect(result?.gatePassed).toBe(3);
  });
});

describe("formatMarketCoverageNote (PR-20)", () => {
  it("renders the total/routed/priced/gate-passed line with a top-unrouted tail when present", () => {
    const note = formatMarketCoverageNote({
      total: 2741,
      routed: 1902,
      priced: 1640,
      gatePassed: 37,
      byEngine: {} as RouteCoverage["byEngine"],
      skipped: {} as RouteCoverage["skipped"],
      topUnrouted: [
        { name: "Some Special", count: 12 },
        { name: "Another One", count: 4 },
      ],
    });

    expect(note).toBe(
      "markets: 2741 entries total / 1902 routed / 1640 outcomes priced / 37 gate-passed; " +
        "top unrouted: Some Special (12), Another One (4)"
    );
  });

  it("omits the top-unrouted tail entirely when there's nothing recoverable to report", () => {
    const note = formatMarketCoverageNote({
      total: 100,
      routed: 100,
      priced: 90,
      gatePassed: 5,
      byEngine: {} as RouteCoverage["byEngine"],
      skipped: {} as RouteCoverage["skipped"],
      topUnrouted: [],
    });

    expect(note).toBe(
      "markets: 100 entries total / 100 routed / 90 outcomes priced / 5 gate-passed"
    );
  });
});

function errorJob(i: number): BatchJobResult {
  return {
    status: "error",
    fixtureId: `err${i}`,
    home: `ErrHome${i}`,
    away: `ErrAway${i}`,
    league: "League0",
    kickoff: new Date(2026, 0, 1, i).toISOString(),
    reason: "boom",
    errorCode: "INTERNAL",
    llmEligible: true,
  };
}

describe("buildManifestMarketCoverage (PR-20)", () => {
  it("returns the narrowed RunManifest.marketCoverage shape (no byEngine/skipped) when jobs carry v3Coverage", () => {
    const jobs: BatchJobResult[] = [
      job(1, {
        v3Coverage: coverage({ total: 10, routed: 6 }),
        v3AssessmentStats: [assessmentStat("done")],
      }),
      errorJob(2), // must be filtered out, not thrown on
    ];

    const result = buildManifestMarketCoverage(jobs, undefined);

    expect(result).toEqual({
      total: 10,
      routed: 6,
      priced: 1,
      gatePassed: 1,
      topUnrouted: [],
    });
    expect(result).not.toHaveProperty("byEngine");
    expect(result).not.toHaveProperty("skipped");
  });

  it("returns undefined (key omitted, not zeroed) when marketsCoverageNote is false", () => {
    const jobs: BatchJobResult[] = [job(1, { v3Coverage: coverage() })];

    expect(buildManifestMarketCoverage(jobs, false)).toBeUndefined();
  });

  it("returns undefined when marketsCoverageNote is true/undefined but no job carries v3Coverage", () => {
    const jobs: BatchJobResult[] = [job(1, {}), errorJob(2)];

    expect(buildManifestMarketCoverage(jobs, true)).toBeUndefined();
    expect(buildManifestMarketCoverage(jobs, undefined)).toBeUndefined();
  });
});
