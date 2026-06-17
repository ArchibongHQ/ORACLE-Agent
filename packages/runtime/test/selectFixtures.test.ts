import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixtureJob } from "@oracle/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSportyBetIndex,
  predictabilityScore,
  type SelectionCandidate,
  type SportyBetEventDetail,
  type SportyBetIndex,
  scoreFixture,
  selectFixtures,
  sidecarKey,
} from "../src/selectFixtures.js";

// Fixed clock: 2026-06-11 10:00 UTC
const NOW = new Date("2026-06-11T10:00:00Z");
const TODAY = "2026-06-11";

function job(
  home: string,
  away: string,
  league = "Premier League",
  kickoff = "2026-06-11T15:00:00Z"
): FixtureJob {
  return { home, away, league, kickoff };
}

function cand(j: FixtureJob, hasBulkOdds = false): SelectionCandidate {
  return { job: j, hasBulkOdds, llmEligible: false };
}

function index(
  events: Array<{ home: string; away: string; marketCount?: number }>
): SportyBetIndex {
  const withCounts = events.map((ev) => ({ ...ev, marketCount: ev.marketCount ?? 0 }));
  const byKey = new Map<string, number>();
  for (const ev of withCounts) {
    byKey.set(sidecarKey(ev.home, ev.away), ev.marketCount);
  }
  return { date: TODAY, byKey, detailByKey: new Map(), events: withCounts };
}

// ── helpers for predictabilityScore tests ──────────────────────────────────

function detail(overrides: Partial<SportyBetEventDetail> = {}): SportyBetEventDetail {
  return {
    eventId: "test",
    odds: null,
    stats: null,
    statscoverage: null,
    ...overrides,
  };
}

describe("predictabilityScore", () => {
  it("returns 30 (neutral) when detail is null or undefined", () => {
    expect(predictabilityScore(null, "Premier League")).toBe(30);
    expect(predictabilityScore(undefined, "Premier League")).toBe(30);
  });

  it("never returns NaN — degraded inputs produce a number", () => {
    const result = predictabilityScore(detail(), "Some League");
    expect(typeof result).toBe("number");
    expect(Number.isNaN(result)).toBe(false);
  });

  it("big home favourite with high scoring and good form scores high (>60)", () => {
    const d = detail({
      odds: { "1x2": { home: 1.3, draw: 5.5, away: 12 }, dnb: { home: 1.15 } },
      stats: {
        xg: { home: { xgf: 2.3, xga: 0.5 }, away: { xgf: 0.6, xga: 2.0 } },
        goals: {
          home: { avg_scored: 2.2, avg_conceded: 0.6 },
          away: { avg_scored: 0.7, avg_conceded: 2.0 },
        },
        form: { home: { w: 4, d: 1, l: 0 }, away: { w: 0, d: 1, l: 4 } },
      },
      statscoverage: { leaguetable: true, formtable: true, headtohead: false },
    });
    expect(predictabilityScore(d, "Premier League")).toBeGreaterThan(60);
  });

  it("evenly-matched low-scoring teams score below 30", () => {
    const d = detail({
      odds: { "1x2": { home: 2.0, draw: 3.2, away: 3.8 } },
      stats: {
        xg: { home: { xgf: 1.0, xga: 1.0 }, away: { xgf: 1.0, xga: 1.0 } },
        goals: {
          home: { avg_scored: 1.0, avg_conceded: 1.0 },
          away: { avg_scored: 1.0, avg_conceded: 1.0 },
        },
        form: { home: { w: 2, d: 1, l: 2 }, away: { w: 2, d: 1, l: 2 } },
      },
      statscoverage: { leaguetable: true, formtable: true, headtohead: true },
    });
    expect(predictabilityScore(d, "Serie A")).toBeLessThan(30);
  });

  it("1X2 component is zero when best implied prob is below 70%", () => {
    // home 1x2 = 2.0 → implied 50%; away = 3.5 → ~29%
    const withWeak = detail({ odds: { "1x2": { home: 2.0, draw: 3.2, away: 3.5 } } });
    const withoutOdds = detail({ odds: null });
    // Both should produce same 1X2 contribution (0) — i.e. same score
    expect(predictabilityScore(withWeak, "La Liga")).toBe(
      predictabilityScore(withoutOdds, "La Liga")
    );
  });

  it("cup/friendly/trophy league name applies a soft penalty (score decreases)", () => {
    const d = detail({
      stats: {
        xg: { home: { xgf: 1.5, xga: 0.8 }, away: { xgf: 0.8, xga: 1.5 } },
        goals: {
          home: { avg_scored: 1.5, avg_conceded: 0.8 },
          away: { avg_scored: 0.8, avg_conceded: 1.5 },
        },
        form: { home: { w: 3, d: 1, l: 1 }, away: { w: 1, d: 1, l: 3 } },
      },
      statscoverage: { leaguetable: true, formtable: true, headtohead: false },
    });
    expect(predictabilityScore(d, "FA Cup")).toBeLessThan(predictabilityScore(d, "Premier League"));
  });

  it("low-data fixture (no stats, coverage all false) gets a soft penalty", () => {
    const withData = detail({
      stats: {
        goals: {
          home: { avg_scored: 1.8, avg_conceded: 1.0 },
          away: { avg_scored: 1.0, avg_conceded: 1.8 },
        },
      },
      statscoverage: { leaguetable: true, formtable: true, headtohead: false },
    });
    const noData = detail({
      stats: null,
      statscoverage: { leaguetable: false, formtable: false, headtohead: false },
    });
    expect(predictabilityScore(noData, "Obscure League")).toBeLessThan(
      predictabilityScore(withData, "Obscure League")
    );
  });

  it("result is always in the 0–100 range", () => {
    // Extreme values shouldn't escape the 0–100 clamp
    const extreme = detail({
      odds: { dnb: { home: 1.01 } },
      stats: {
        xg: { home: { xgf: 5.0, xga: 0.1 }, away: { xgf: 0.1, xga: 5.0 } },
        form: { home: { w: 5, d: 0, l: 0 }, away: { w: 0, d: 0, l: 5 } },
      },
      statscoverage: { leaguetable: true, formtable: true },
    });
    const score = predictabilityScore(extreme, "Premier League");
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe("scoreFixture", () => {
  it("scores a priority-league fixture with no detail above a pure neutral baseline", () => {
    const c = cand(job("A", "B", "Premier League", "2026-06-11T10:30:00Z"));
    // neutral predictability (18) + priority (15) = 33 (no odds, no depth, <2h window)
    expect(scoreFixture(c, 0, NOW)).toBeCloseTo(33, 0);
  });

  it("a strong non-priority favourite now outranks a priority-league coin-flip", () => {
    // Big favourite with strong stats → high predictability, no priority league
    const favourite: SelectionCandidate = {
      job: job("Strong", "Weak", "Obscure League", "2026-06-11T15:00:00Z"),
      hasBulkOdds: false,
      llmEligible: false,
      sportyBetDetail: {
        eventId: "1",
        odds: { "1x2": { home: 1.3, draw: 5, away: 11 }, dnb: { home: 1.15 } },
        stats: {
          xg: { home: { xgf: 2.2, xga: 0.6 }, away: { xgf: 0.7, xga: 1.9 } },
          goals: {
            home: { avg_scored: 2.1, avg_conceded: 0.7 },
            away: { avg_scored: 0.8, avg_conceded: 1.8 },
          },
          form: { home: { w: 4, d: 1, l: 0 }, away: { w: 0, d: 1, l: 4 } },
        },
        statscoverage: { leaguetable: true, formtable: true, headtohead: false },
      },
    };
    const priorityCoinFlip = cand(job("A", "B", "Premier League", "2026-06-11T10:30:00Z"), false);
    expect(scoreFixture(favourite, 0, NOW)).toBeGreaterThan(scoreFixture(priorityCoinFlip, 0, NOW));
  });

  it("weights bulk odds (+30) above kickoff window + market depth combined", () => {
    const withOdds = cand(job("A", "B", "Obscure", "2026-06-11T10:30:00Z"), true);
    const without = cand(job("C", "D", "Obscure", "2026-06-11T15:00:00Z"), false);
    // 30 (odds) vs 10 (≥2h) + 10 (depth capped at 40) — both have same predictability
    expect(scoreFixture(withOdds, 0, NOW)).toBeGreaterThan(scoreFixture(without, 80, NOW));
  });

  it("grades the kickoff window: ≥2h +10, 1–2h +5, <1h +0", () => {
    // Use same league+detail for all to isolate the window component
    const base = (ko: string) => scoreFixture(cand(job("A", "B", "Obscure", ko)), 0, NOW);
    const ref = base("2026-06-11T10:20:00Z"); // <1h → +0
    expect(base("2026-06-11T13:00:00Z") - ref).toBe(10);
    expect(base("2026-06-11T11:30:00Z") - ref).toBe(5);
    expect(base("2026-06-11T10:20:00Z") - ref).toBe(0);
    expect(base("2026-06-11T12:00:00Z") - ref).toBe(10);
    expect(base("2026-06-11T11:00:00Z") - ref).toBe(5);
  });

  it("caps market depth at 40 markets for the full +10", () => {
    const c = cand(job("A", "B", "Obscure", "2026-06-11T10:20:00Z"));
    expect(scoreFixture(c, 40, NOW) - scoreFixture(c, 0, NOW)).toBe(10);
    expect(scoreFixture(c, 80, NOW)).toBe(scoreFixture(c, 40, NOW));
  });
});

describe("selectFixtures", () => {
  it("drops fixtures not kicking off today and those already started", () => {
    const pool = [
      cand(job("A", "B", "Obscure", "2026-06-11T15:00:00Z")), // keep
      cand(job("C", "D", "Obscure", "2026-06-12T15:00:00Z")), // tomorrow
      cand(job("E", "F", "Obscure", "2026-06-11T09:00:00Z")), // already started
      cand(job("G", "H", "Obscure", "garbage-kickoff")), // unparseable
    ];
    const { selected, stats } = selectFixtures(pool, { cap: 50, sportyBet: null, now: NOW });
    expect(selected.map((c) => c.job.home)).toEqual(["A"]);
    expect(stats.pool).toBe(4);
    expect(stats.today).toBe(1);
  });

  it("marks top-N by score as llmEligible, returns ALL fixtures", () => {
    const pool = [
      cand(job("Low", "X", "Obscure"), false),
      cand(job("High", "Y", "Premier League"), true),
      cand(job("Mid", "Z", "Obscure"), true),
    ];
    const { selected } = selectFixtures(pool, { cap: 2, sportyBet: null, now: NOW });
    // All 3 returned — cap is routing gate only
    expect(selected).toHaveLength(3);
    // Top-2 by score marked llmEligible; lowest not
    const eligible = selected.filter((c) => c.llmEligible).map((c) => c.job.home);
    expect(eligible).toContain("High");
    expect(eligible).toContain("Mid");
    expect(selected.find((c) => c.job.home === "Low")?.llmEligible).toBe(false);
  });

  it("returns the whole pool when smaller than the cap", () => {
    const pool = [cand(job("A", "B")), cand(job("C", "D"))];
    const { selected } = selectFixtures(pool, { cap: 50, sportyBet: null, now: NOW });
    expect(selected).toHaveLength(2);
  });

  it("cap=0 means no llmEligible fixtures but all are still returned", () => {
    const pool = [cand(job("A", "B"))];
    const { selected } = selectFixtures(pool, { cap: 0, sportyBet: null, now: NOW });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.llmEligible).toBe(false);
  });

  it("keeps an offset-bearing kickoff that lands on today in UTC", () => {
    // 00:30+02:00 on the 12th = 22:30Z on the 11th
    const pool = [cand(job("A", "B", "Obscure", "2026-06-12T00:30:00+02:00"))];
    const { selected } = selectFixtures(pool, { cap: 50, sportyBet: null, now: NOW });
    expect(selected).toHaveLength(1);
  });

  it("breaks score ties deterministically by kickoff then home name", () => {
    const pool = [
      cand(job("Zeta", "X", "Premier League", "2026-06-11T15:00:00Z")),
      cand(job("Alpha", "Y", "Premier League", "2026-06-11T15:00:00Z")),
      cand(job("Early", "Z", "Premier League", "2026-06-11T14:00:00Z")),
    ];
    const { selected } = selectFixtures(pool, { cap: 3, sportyBet: null, now: NOW });
    expect(selected.map((c) => c.job.home)).toEqual(["Early", "Alpha", "Zeta"]);
  });

  it("collapses near-duplicate fixtures (name variants, same day) keeping the highest scorer", () => {
    const pool = [
      cand(job("Ilves", "Jaro", "Veikkausliiga", "2026-06-11T15:00:00Z"), true), // higher score (bulk odds)
      cand(job("Tampereen Ilves", "FF Jaro", "Veikkausliiga", "2026-06-11T15:00:00Z"), false),
    ];
    const { selected, stats } = selectFixtures(pool, { cap: 50, sportyBet: null, now: NOW });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.job.home).toBe("Ilves");
    expect(stats.deduped).toBe(1);
  });

  it("does not collapse genuinely distinct fixtures that share no name overlap", () => {
    const pool = [
      cand(job("Ilves", "Jaro", "Veikkausliiga")),
      cand(job("Arsenal", "Chelsea", "Premier League")),
    ];
    const { selected, stats } = selectFixtures(pool, { cap: 50, sportyBet: null, now: NOW });
    expect(selected).toHaveLength(2);
    expect(stats.deduped).toBe(0);
  });

  it("keeps only SportyBet-listed fixtures when the index is present", () => {
    const idx = index([{ home: "Arsenal FC", away: "Chelsea FC", marketCount: 30 }]);
    const pool = [
      cand(job("Arsenal", "Chelsea")), // exact normTeam hit
      cand(job("Liverpool", "Everton")), // not listed
    ];
    const { selected, stats } = selectFixtures(pool, { cap: 50, sportyBet: idx, now: NOW });
    expect(selected.map((c) => c.job.home)).toEqual(["Arsenal"]);
    expect(stats.sportyBet).toBe(1);
    expect(stats.failOpen).toBe(false);
  });

  it("falls back to namesMatch when the exact key misses", () => {
    const idx = index([{ home: "Bayern", away: "Dortmund", marketCount: 12 }]);
    const pool = [cand(job("Bayern Munich", "Borussia Dortmund"))];
    const { selected } = selectFixtures(pool, { cap: 50, sportyBet: idx, now: NOW });
    expect(selected).toHaveLength(1);
  });

  it("hits the byKey fast path without the namesMatch fallback", () => {
    const idx: SportyBetIndex = {
      date: TODAY,
      byKey: new Map([[sidecarKey("Arsenal FC", "Chelsea FC"), 30]]),
      detailByKey: new Map(),
      events: [], // fallback disabled — a key miss cannot be rescued
    };
    const { selected } = selectFixtures([cand(job("Arsenal", "Chelsea"))], {
      cap: 50,
      sportyBet: idx,
      now: NOW,
    });
    expect(selected).toHaveLength(1);
  });

  it("counts gated-out fixtures that already had bulk odds", () => {
    const idx = index([{ home: "Arsenal", away: "Chelsea" }]);
    const pool = [
      cand(job("Arsenal", "Chelsea"), true),
      cand(job("Wolverhampton Wanderers", "Newcastle"), true), // not listed → dropped
    ];
    const { stats } = selectFixtures(pool, { cap: 50, sportyBet: idx, now: NOW });
    expect(stats.droppedBulkOdds).toBe(1);
  });

  it("fails open when the index is null or has no events", () => {
    const pool = [cand(job("A", "B", "Obscure"))];
    const nullRes = selectFixtures(pool, { cap: 50, sportyBet: null, now: NOW });
    expect(nullRes.selected).toHaveLength(1);
    expect(nullRes.stats.failOpen).toBe(true);

    const emptyRes = selectFixtures(pool, {
      cap: 50,
      sportyBet: { date: TODAY, byKey: new Map(), detailByKey: new Map(), events: [] },
      now: NOW,
    });
    expect(emptyRes.selected).toHaveLength(1);
    expect(emptyRes.stats.failOpen).toBe(true);
  });

  it("reports bulkOdds, priority, analyzed, and llmRouted counts in stats", () => {
    const pool = [
      cand(job("A", "B", "Premier League"), true),
      cand(job("C", "D", "Obscure"), false),
    ];
    const { stats } = selectFixtures(pool, { cap: 1, sportyBet: null, now: NOW });
    expect(stats.selected).toBe(2); // ALL returned
    expect(stats.analyzed).toBe(2);
    expect(stats.bulkOdds).toBe(1);
    expect(stats.priority).toBe(1);
    expect(stats.llmRouted).toBe(1); // cap=1 → top-1 llmEligible
  });
});

describe("loadSportyBetIndex", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oracle-select-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null for a missing file", async () => {
    expect(await loadSportyBetIndex(TODAY, join(dir, "nope.json"))).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    const p = join(dir, "sidecar.json");
    await writeFile(p, "{not json", "utf8");
    expect(await loadSportyBetIndex(TODAY, p)).toBeNull();
  });

  it("returns null for a stale date", async () => {
    const p = join(dir, "sidecar.json");
    await writeFile(p, JSON.stringify({ date: "2026-06-10", events: [] }), "utf8");
    expect(await loadSportyBetIndex(TODAY, p)).toBeNull();
  });

  it("indexes events by normalised team key with market counts", async () => {
    const p = join(dir, "sidecar.json");
    await writeFile(
      p,
      JSON.stringify({
        date: TODAY,
        scraped_at: "2026-06-11T08:00:00Z",
        events: [
          { home: "Arsenal FC", away: "Chelsea FC", marketCount: 27 },
          { home: "", away: "Broken", marketCount: 5 }, // malformed — skipped
          { home: 7, away: "Bad Types" }, // non-string — skipped, must not throw
          { home: "Lyon", away: "Lille", marketCount: "12" }, // non-numeric count → 0
        ],
      }),
      "utf8"
    );
    const idx = await loadSportyBetIndex(TODAY, p);
    expect(idx).not.toBeNull();
    expect(idx?.byKey.size).toBe(2);
    expect(idx?.byKey.get("arsenal|chelsea")).toBe(27);
    expect(idx?.byKey.get(sidecarKey("Lyon", "Lille"))).toBe(0); // string count coerced to 0
    expect(idx?.events).toHaveLength(2);
  });
});
