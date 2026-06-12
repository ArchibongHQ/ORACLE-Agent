import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixtureJob } from "@oracle/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSportyBetIndex,
  scoreFixture,
  selectFixtures,
  type SelectionCandidate,
  sidecarKey,
  type SportyBetIndex,
} from "../src/selectFixtures.js";

// Fixed clock: 2026-06-11 10:00 UTC
const NOW = new Date("2026-06-11T10:00:00Z");
const TODAY = "2026-06-11";

function job(home: string, away: string, league = "Premier League", kickoff = "2026-06-11T15:00:00Z"): FixtureJob {
  return { home, away, league, kickoff };
}

function cand(j: FixtureJob, hasBulkOdds = false): SelectionCandidate {
  return { job: j, hasBulkOdds };
}

function index(events: Array<{ home: string; away: string; marketCount?: number }>): SportyBetIndex {
  const withCounts = events.map((ev) => ({ ...ev, marketCount: ev.marketCount ?? 0 }));
  const byKey = new Map<string, number>();
  for (const ev of withCounts) {
    byKey.set(sidecarKey(ev.home, ev.away), ev.marketCount);
  }
  return { date: TODAY, byKey, events: withCounts };
}

describe("scoreFixture", () => {
  it("scores a priority-league fixture with nothing else at 50", () => {
    const c = cand(job("A", "B", "Premier League", "2026-06-11T10:30:00Z"));
    expect(scoreFixture(c, 0, NOW)).toBe(50);
  });

  it("ranks priority-league-no-odds above non-priority-with-odds", () => {
    const priority = cand(job("A", "B", "Premier League", "2026-06-11T10:30:00Z"), false);
    const nonPriority = cand(job("C", "D", "Obscure League", "2026-06-11T15:00:00Z"), true);
    // 50 vs 30 (odds) + 10 (≥2h) + 5 (depth 20/40*10)
    expect(scoreFixture(priority, 0, NOW)).toBeGreaterThan(scoreFixture(nonPriority, 20, NOW));
  });

  it("weights bulk odds above kickoff window + market depth combined", () => {
    const withOdds = cand(job("A", "B", "Obscure", "2026-06-11T10:30:00Z"), true);
    const without = cand(job("C", "D", "Obscure", "2026-06-11T15:00:00Z"), false);
    // 30 vs 10 (≥2h) + 10 (depth capped at 40)
    expect(scoreFixture(withOdds, 0, NOW)).toBeGreaterThan(scoreFixture(without, 80, NOW));
  });

  it("grades the kickoff window: ≥2h +10, 1–2h +5, <1h +0", () => {
    const base = (ko: string) => scoreFixture(cand(job("A", "B", "Obscure", ko)), 0, NOW);
    expect(base("2026-06-11T13:00:00Z")).toBe(10);
    expect(base("2026-06-11T11:30:00Z")).toBe(5);
    expect(base("2026-06-11T10:20:00Z")).toBe(0);
    // exact boundaries
    expect(base("2026-06-11T12:00:00Z")).toBe(10);
    expect(base("2026-06-11T11:00:00Z")).toBe(5);
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

  it("honors the cap, keeping the highest-scored fixtures", () => {
    const pool = [
      cand(job("Low", "X", "Obscure"), false),
      cand(job("High", "Y", "Premier League"), true),
      cand(job("Mid", "Z", "Obscure"), true),
    ];
    const { selected } = selectFixtures(pool, { cap: 2, sportyBet: null, now: NOW });
    expect(selected.map((c) => c.job.home)).toEqual(["High", "Mid"]);
  });

  it("returns the whole pool when smaller than the cap", () => {
    const pool = [cand(job("A", "B")), cand(job("C", "D"))];
    const { selected } = selectFixtures(pool, { cap: 50, sportyBet: null, now: NOW });
    expect(selected).toHaveLength(2);
  });

  it("selects nothing for a zero or negative cap", () => {
    const pool = [cand(job("A", "B"))];
    expect(selectFixtures(pool, { cap: 0, sportyBet: null, now: NOW }).selected).toEqual([]);
    expect(selectFixtures(pool, { cap: -1, sportyBet: null, now: NOW }).selected).toEqual([]);
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
      sportyBet: { date: TODAY, byKey: new Map(), events: [] },
      now: NOW,
    });
    expect(emptyRes.selected).toHaveLength(1);
    expect(emptyRes.stats.failOpen).toBe(true);
  });

  it("reports bulkOdds and priority counts in stats", () => {
    const pool = [
      cand(job("A", "B", "Premier League"), true),
      cand(job("C", "D", "Obscure"), false),
    ];
    const { stats } = selectFixtures(pool, { cap: 50, sportyBet: null, now: NOW });
    expect(stats.selected).toBe(2);
    expect(stats.bulkOdds).toBe(1);
    expect(stats.priority).toBe(1);
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
