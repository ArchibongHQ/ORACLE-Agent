/** PR-5a — slateGate.ts (daily-batch v3 pre-filter) tests. Confirms the
 *  fail-open contract, per-reason discard tallies, and the per-fixture
 *  telemetry.v3Heightened stamp the heightened EV bars key off. */

import type { FixtureJob } from "@oracle/engine";
import { describe, expect, it } from "vitest";
import { buildMarketsV3GateConfig } from "../src/marketsV3/pipeline.js";
import { formatSlateGateLog, prefilterMarketsV3Jobs } from "../src/marketsV3/slateGate.js";
import { type SportyBetEventDetail, sidecarKey } from "../src/selectFixtures.js";

const cfg = buildMarketsV3GateConfig({});

/** Realistic ~21-entry allMarkets block (over the 20-entry meaningful floor —
 *  see feedIntegrity.ts's MIN_MEANINGFUL_PAIRED_ENTRIES) for the P1-3
 *  feed-integrity contamination tests below. */
function makeAllMarketsBlock(): NonNullable<
  NonNullable<SportyBetEventDetail["odds"]>["allMarkets"]
> {
  const entries: NonNullable<NonNullable<SportyBetEventDetail["odds"]>["allMarkets"]> = [
    {
      id: "1",
      outcomes: [
        { id: "1", odds: "1.79" },
        { id: "2", odds: "3.66" },
        { id: "3", odds: "4.56" },
      ],
    },
  ];
  for (let line = 5; line <= 45; line += 5) {
    entries.push({
      id: `ou_${line}`,
      name: "Over/Under",
      specifier: `total=${(line / 10).toFixed(1)}`,
      outcomes: [
        { id: "over", desc: "Over", odds: String(1.4 + line / 100) },
        { id: "under", desc: "Under", odds: String(2.6 - line / 100) },
      ],
    });
  }
  return entries;
}

function detail(overrides: Partial<SportyBetEventDetail> = {}): SportyBetEventDetail {
  return {
    eventId: "sr:match:1",
    odds: {
      "1x2": { home: 1.8, draw: 3.6, away: 4.2 },
      ou25: { over: 1.9, under: 1.95 },
    },
    stats: {
      form: { home: { last5: "WWDLW" }, away: { last5: "LDWWL" } },
      goals: {
        home: { avg_scored: 1.8, avg_conceded: 1.0 },
        away: { avg_scored: 1.0, avg_conceded: 1.4 },
      },
      overunder: { home: { over25_pct: 0.55 }, away: { over25_pct: 0.5 } },
    },
    statscoverage: null,
    ...overrides,
  };
}

function job(home: string, away: string, league = "Premier League"): FixtureJob {
  return { home, away, league, kickoff: "2026-08-01T15:00:00Z" };
}

function index(entries: Array<[FixtureJob, SportyBetEventDetail]>) {
  return new Map(entries.map(([j, d]) => [sidecarKey(j.home, j.away), d]));
}

describe("prefilterMarketsV3Jobs", () => {
  it("returns the input untouched with summary null when there is no sidecar index", () => {
    const jobs = [job("Home FC", "Away FC")];
    expect(prefilterMarketsV3Jobs(jobs, undefined, cfg)).toEqual({ jobs, summary: null });
    expect(prefilterMarketsV3Jobs(jobs, new Map(), cfg)).toEqual({ jobs, summary: null });
  });

  it("keeps sidecar-unmapped jobs untouched (no stamp) and never evaluates them", () => {
    // Non-whitelisted league would be discarded if evaluated — but this fixture
    // isn't in the (non-empty) index, so it must pass through untouched.
    const unmapped = job("Ghost FC", "Phantom FC", "Some Obscure Regional League");
    const other = job("Home FC", "Away FC");
    const out = prefilterMarketsV3Jobs([unmapped], index([[other, detail()]]), cfg);
    expect(out.jobs).toEqual([unmapped]);
    expect(out.jobs[0]!.state?.telemetry?.v3Heightened).toBeUndefined();
    expect(out.summary).toEqual({ total: 0, passed: 0, discardCounts: {}, unmapped: 1 });
  });

  it("drops mapped fixtures the gate discards, tallying per-reason counts", () => {
    const whitelisted = job("Home FC", "Away FC");
    const offList = job("Nowhere FC", "Elsewhere FC", "Some Obscure Regional League");
    const { jobs, summary } = prefilterMarketsV3Jobs(
      [whitelisted, offList],
      index([
        [whitelisted, detail()],
        [offList, detail()],
      ]),
      cfg
    );
    expect(jobs.map((j) => j.home)).toEqual(["Home FC"]);
    expect(summary).toEqual({
      total: 2,
      passed: 1,
      discardCounts: { not_whitelisted: 1 },
      unmapped: 0,
    });
  });

  it("stamps v3Heightened=false on normal survivors, preserving existing telemetry", () => {
    const j: FixtureJob = {
      ...job("Home FC", "Away FC"),
      state: { telemetry: { xgfH: 1.4 } },
    };
    const { jobs } = prefilterMarketsV3Jobs([j], index([[j, detail()]]), cfg);
    expect(jobs[0]!.state?.telemetry?.v3Heightened).toBe(false);
    expect(jobs[0]!.state?.telemetry?.xgfH).toBe(1.4);
  });

  it("stamps v3Heightened=true on a heightened fixture that clears the 85 bar with aligned trends", () => {
    const youth = job("Home FC U19", "Away FC U19");
    // mandatory 60 + hitRate 10 + xg 10 + h2h 10 = 90 ≥ 85; both over25_pct ≥ 0.6 ⇒ aligned.
    const rich = detail({
      stats: {
        form: { home: { last5: "WWDLW" }, away: { last5: "LDWWL" } },
        goals: {
          home: { avg_scored: 1.8, avg_conceded: 1.0 },
          away: { avg_scored: 1.0, avg_conceded: 1.4 },
        },
        overunder: { home: { over25_pct: 0.65 }, away: { over25_pct: 0.7 } },
        xg: { home: { xgf: 1.5, xga: 1.1 }, away: { xgf: 1.2, xga: 1.3 } },
        h2h: { total: 4 },
      },
    });
    const { jobs, summary } = prefilterMarketsV3Jobs([youth], index([[youth, rich]]), cfg);
    expect(summary?.passed).toBe(1);
    expect(jobs[0]!.state?.telemetry?.v3Heightened).toBe(true);
  });

  it("drops a heightened fixture below the 85 bar (mandatory-only scores 70)", () => {
    const youth = job("Home FC U19", "Away FC U19");
    const { jobs, summary } = prefilterMarketsV3Jobs([youth], index([[youth, detail()]]), cfg);
    expect(jobs).toHaveLength(0);
    expect(summary?.discardCounts).toEqual({ below_completeness_floor: 1 });
  });

  it("[P1-3 review fix] discards a contaminated fixture outright — no headline-only rescue path exists downstream", () => {
    const block = makeAllMarketsBlock();
    const real = job("Home FC", "Away FC");
    const twin = job("Home FC SRL", "Away FC SRL", "Some Obscure Regional League");
    const withBlock = detail({
      odds: {
        "1x2": { home: 1.8, draw: 3.6, away: 4.2 },
        ou25: { over: 1.9, under: 1.95 },
        allMarkets: block,
      },
    });
    const { jobs, summary, integrityReport } = prefilterMarketsV3Jobs(
      [real, twin],
      index([
        [real, withBlock],
        [twin, withBlock],
      ]),
      cfg
    );
    expect(integrityReport?.contaminatedCount).toBeGreaterThanOrEqual(1);
    expect(jobs.map((j) => j.home)).not.toContain("Home FC");
    expect(summary?.discardCounts.contaminated).toBe(1);
  });

  it("[P1-3] feedIntegrity='shadow' still runs the v3 gate normally on a contaminated fixture, only logging the report", () => {
    const block = makeAllMarketsBlock();
    const real = job("Home FC", "Away FC");
    const twin = job("Home FC SRL", "Away FC SRL", "Some Obscure Regional League");
    const withBlock = detail({
      odds: {
        "1x2": { home: 1.8, draw: 3.6, away: 4.2 },
        ou25: { over: 1.9, under: 1.95 },
        allMarkets: block,
      },
    });
    const { jobs, integrityReport } = prefilterMarketsV3Jobs(
      [real, twin],
      index([
        [real, withBlock],
        [twin, withBlock],
      ]),
      cfg,
      { feedIntegrity: "shadow" }
    );
    expect(integrityReport?.contaminatedCount).toBeGreaterThanOrEqual(1);
    // Not discarded for contamination under "shadow" — it survives (or is
    // discarded) purely on the normal gate's own merits.
    expect(jobs.map((j) => j.home)).toContain("Home FC");
  });

  it("completenessV4=false restores hit-rate to the mandatory (discard) set", () => {
    const j = job("Home FC", "Away FC");
    // No overunder block: v4 default scores 60+xg10+h2h10=80 ≥ 70 and passes;
    // legacy (v4 off) treats the missing hit-rate as a mandatory discard.
    const noHitRate = detail({
      stats: {
        form: { home: { last5: "WWDLW" }, away: { last5: "LDWWL" } },
        goals: {
          home: { avg_scored: 1.8, avg_conceded: 1.0 },
          away: { avg_scored: 1.0, avg_conceded: 1.4 },
        },
        xg: { home: { xgf: 1.5, xga: 1.1 }, away: { xgf: 1.2, xga: 1.3 } },
        h2h: { total: 4 },
      },
    });
    const v4 = prefilterMarketsV3Jobs([j], index([[j, noHitRate]]), cfg);
    expect(v4.summary?.passed).toBe(1);
    const legacy = prefilterMarketsV3Jobs([j], index([[j, noHitRate]]), cfg, {
      completenessV4: false,
    });
    expect(legacy.jobs).toHaveLength(0);
    expect(legacy.summary?.discardCounts).toEqual({ mandatory_data_missing: 1 });
  });
});

describe("formatSlateGateLog", () => {
  it("renders counts and per-reason tallies in one line", () => {
    expect(
      formatSlateGateLog({
        total: 5,
        passed: 3,
        discardCounts: { not_whitelisted: 1, below_completeness_floor: 1 },
        unmapped: 2,
      })
    ).toBe(
      "gate: 5 mapped → 3 survive (2 unmapped pass through; not_whitelisted: 1, below_completeness_floor: 1)"
    );
  });

  it("omits the reason list when nothing was discarded", () => {
    expect(formatSlateGateLog({ total: 2, passed: 2, discardCounts: {}, unmapped: 0 })).toBe(
      "gate: 2 mapped → 2 survive (0 unmapped pass through)"
    );
  });
});
