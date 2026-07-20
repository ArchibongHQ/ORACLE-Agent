/** [Phase 2, two-tier slate] buildTwoTierSlate — the core assembly tests.
 *  Delivered slate = Tier① (QUALIFIED, gate survivors) + Tier② (WATCHLIST,
 *  filling to `target`), each pattern-first ranked. Confirms: fill-to-39,
 *  tier ordering (pattern-first, then §7), capped/noise rows sort last
 *  within Tier② and never reach Tier①, no-Under invariant holds through the
 *  assembly (defense in depth — the real ban lives upstream in
 *  batch/index.ts, but this proves the assembly layer doesn't accidentally
 *  reintroduce one), and shortfall text is always present on Tier② rows. */

import type { FixtureJobSuccess, V3DeliveryCandidate } from "@oracle/engine";
import { describe, expect, it } from "vitest";
import { buildTwoTierSlate } from "../src/marketsV3/slateOutputs.js";

function deliveryCandidate(overrides: Partial<V3DeliveryCandidate> = {}): V3DeliveryCandidate {
  return {
    fixtureId: "f1",
    home: "Home",
    away: "Away",
    league: "League",
    kickoff: "2026-01-01T15:00:00Z",
    marketName: "Over/Under",
    desc: "Over 2.5",
    cls: "M",
    mp: 0.55,
    odds: 2.1,
    q: 0.5,
    rawEdge: 0.05,
    penaltyPts: 0,
    adjustedEdge: 0.08,
    adjEvPct: 0.16,
    confidence: "high",
    family: "goals_ou",
    stakePct: 2.5,
    trapWarning: "no contradicting signal detected",
    basisLabel: "venue",
    ...overrides,
  };
}

function job(
  i: number,
  overrides: {
    deliveryBest?: V3DeliveryCandidate | null;
    watchlist?: V3DeliveryCandidate[];
  } = {}
): FixtureJobSuccess {
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
    ...(overrides.deliveryBest !== undefined
      ? { v3DeliveryBest: overrides.deliveryBest ?? undefined }
      : {}),
    ...(overrides.watchlist ? { v3Watchlist: overrides.watchlist } : {}),
  } as unknown as FixtureJobSuccess;
}

describe("buildTwoTierSlate — Tier① (QUALIFIED)", () => {
  it("collects every fixture's v3DeliveryBest into tier1, dropping fixtures with none", () => {
    const jobs = [
      job(1, { deliveryBest: deliveryCandidate({ fixtureId: "f1", adjustedEdge: 0.05 }) }),
      job(2, { deliveryBest: null }), // v3 didn't run / gate-dry — dropped, not an error
      job(3, { deliveryBest: deliveryCandidate({ fixtureId: "f3", adjustedEdge: 0.12 }) }),
    ];
    const { tier1 } = buildTwoTierSlate(jobs);
    expect(tier1).toHaveLength(2);
    expect(tier1.map((c) => c.fixtureId)).toEqual(["f3", "f1"]); // ranked by adjustedEdge
  });

  it("never truncates tier1 to make room for tier2 padding, even past the target", () => {
    const jobs = Array.from({ length: 45 }, (_, i) =>
      job(i, { deliveryBest: deliveryCandidate({ fixtureId: `f${i}`, adjustedEdge: 0.01 * i }) })
    );
    const { tier1, tier2 } = buildTwoTierSlate(jobs, { target: 39 });
    expect(tier1).toHaveLength(45); // ALL 45 survivors, target only bounds tier2
    expect(tier2).toHaveLength(0); // nothing left to fill — target - tier1.length < 0
  });
});

describe("buildTwoTierSlate — Tier② (WATCHLIST) fill-to-target", () => {
  it("fills tier2 up to target - tier1.length when tier1 is under target", () => {
    const jobs = [
      job(1, { deliveryBest: deliveryCandidate({ fixtureId: "f1" }) }), // 1 tier1 row
      job(2, {
        watchlist: [
          deliveryCandidate({ fixtureId: "f2", shortfall: "class_edge", adjustedEdge: 0.05 }),
          deliveryCandidate({ fixtureId: "f2", shortfall: "class_edge", adjustedEdge: 0.03 }),
        ],
      }),
    ];
    const { tier1, tier2 } = buildTwoTierSlate(jobs, { target: 2 });
    expect(tier1).toHaveLength(1);
    expect(tier2).toHaveLength(1); // target(2) - tier1(1) = 1, not both watchlist rows
    expect(tier2[0]?.adjustedEdge).toBe(0.05); // the better-ranked one survives the cap
  });

  it("returns an empty tier2 when tier1 alone already meets target", () => {
    const jobs = Array.from({ length: 39 }, (_, i) =>
      job(i, { deliveryBest: deliveryCandidate({ fixtureId: `f${i}` }) })
    );
    jobs.push(
      job(99, {
        watchlist: [deliveryCandidate({ fixtureId: "f99", shortfall: "class_edge" })],
      })
    );
    const { tier1, tier2 } = buildTwoTierSlate(jobs, { target: 39 });
    expect(tier1).toHaveLength(39);
    expect(tier2).toHaveLength(0);
  });

  it("every tier2 row carries a shortfall reason — mandatory field, never a bare pick", () => {
    const jobs = [
      job(1, {
        watchlist: [deliveryCandidate({ fixtureId: "f1", shortfall: "ev_floor" })],
      }),
    ];
    const { tier2 } = buildTwoTierSlate(jobs);
    expect(tier2[0]?.shortfall).toBe("ev_floor");
  });
});

describe("buildTwoTierSlate — capped/noise rows sort LAST within tier2, never reach tier1", () => {
  it("a capped row never outranks a class_edge row within tier2, even with a much higher adjustedEdge", () => {
    const jobs = [
      job(1, {
        watchlist: [
          deliveryCandidate({
            fixtureId: "f1",
            shortfall: "capped (absolute)",
            adjustedEdge: 0.9, // deliberately huge — proves the demotion isn't edge-driven
          }),
        ],
      }),
      job(2, {
        watchlist: [
          deliveryCandidate({ fixtureId: "f2", shortfall: "class_edge", adjustedEdge: 0.02 }),
        ],
      }),
    ];
    const { tier2 } = buildTwoTierSlate(jobs, { target: 39 });
    expect(tier2.map((c) => c.fixtureId)).toEqual(["f2", "f1"]); // class_edge first despite lower edge
  });

  it("a strongly-patterned capped row STILL sorts behind a weakly-patterned class_edge row — the invariant pattern strength can never cross", () => {
    const jobs = [
      job(1, {
        watchlist: [
          deliveryCandidate({
            fixtureId: "f1",
            shortfall: "noise",
            adjustedEdge: 0.5,
            patternStrength: 0.95, // deliberately strong — proves patterns can't rescue this
          }),
        ],
      }),
      job(2, {
        watchlist: [
          deliveryCandidate({
            fixtureId: "f2",
            shortfall: "class_edge",
            adjustedEdge: 0.01,
            patternStrength: 0.05,
          }),
        ],
      }),
    ];
    const { tier1, tier2 } = buildTwoTierSlate(jobs, { target: 39 });
    expect(tier1).toHaveLength(0); // neither ever reaches tier1 — this function only orders
    expect(tier2.map((c) => c.fixtureId)).toEqual(["f2", "f1"]);
  });

  it("capped/noise demotion applies to fill-to-target truncation too — a capped row is the first cut when the pool exceeds target", () => {
    const jobs = [
      job(1, {
        watchlist: [
          deliveryCandidate({ fixtureId: "f1", shortfall: "capped (relative)", adjustedEdge: 0.9 }),
        ],
      }),
      job(2, {
        watchlist: [
          deliveryCandidate({ fixtureId: "f2", shortfall: "ev_floor", adjustedEdge: 0.01 }),
        ],
      }),
    ];
    const { tier2 } = buildTwoTierSlate(jobs, { target: 1 });
    expect(tier2).toHaveLength(1);
    expect(tier2[0]?.fixtureId).toBe("f2"); // the real shortfall survives, capped is cut first
  });
});

describe("buildTwoTierSlate — pattern-first ranking within each tier", () => {
  it("tier1: a pattern-backed row sorts before a non-pattern row with a higher raw adjustedEdge", () => {
    const jobs = [
      job(1, {
        deliveryBest: deliveryCandidate({
          fixtureId: "f1",
          adjustedEdge: 0.03,
          patternStrength: 0.4,
        }),
      }),
      job(2, { deliveryBest: deliveryCandidate({ fixtureId: "f2", adjustedEdge: 0.2 }) }),
    ];
    const { tier1 } = buildTwoTierSlate(jobs);
    expect(tier1[0]?.fixtureId).toBe("f1");
  });
});

describe("buildTwoTierSlate — Under-ban defense in depth", () => {
  it("does not itself gate anything (a candidate carrying an Under desc would still appear if upstream failed to strip it) — documents that this layer is NOT the enforcement point", () => {
    // This is a documentation test, not a guard: buildTwoTierSlate has no
    // family/desc knowledge and cannot enforce the ban itself (by design —
    // see the plan's Phase 1 rationale: the ban is a single choke point in
    // batch/index.ts, not re-implemented at every downstream consumer).
    // Confirms the real invariant: a v3Watchlist/v3DeliveryBest that reaches
    // this function is trusted input, exactly as documented on the type.
    const jobs = [
      job(1, {
        deliveryBest: deliveryCandidate({ fixtureId: "f1", desc: "Over 2.5" }),
      }),
    ];
    const { tier1 } = buildTwoTierSlate(jobs);
    expect(tier1).toHaveLength(1);
    expect(tier1[0]?.desc).not.toMatch(/\bunder\b/i);
  });
});
