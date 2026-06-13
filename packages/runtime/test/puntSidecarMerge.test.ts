/** Tests for the sidecar stats/odds merge block in loadedSlipToJobs (punt.ts:176-197).
 *
 *  vi.mock must be at module level (Vitest hoists them); per-test variation is
 *  done via vi.mocked(...).mockResolvedValue inside beforeEach / each test. */

import type { FixtureJob } from "@oracle/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawLeg } from "../../../apps/booking/src/loadCode.js";

// ── Module-level mocks (hoisted by Vitest) ────────────────────────────────────

vi.mock("../src/fixtures.js", () => ({
  fetchFixtureByName: vi.fn(),
}));
vi.mock("../src/h2h.js", () => ({
  enrichWithH2H: vi.fn(),
}));
vi.mock("../src/newsIntel.js", () => ({
  enrichWithNewsIntel: vi.fn(),
}));
vi.mock("../src/lineups.js", () => ({
  enrichWithLineups: vi.fn(),
}));
vi.mock("../src/selectFixtures.js", () => ({
  loadSportyBetIndex: vi.fn(),
  sidecarKey: (h: string, a: string) => `${h}|${a}`,
}));

// Import AFTER mocks are registered so the module under test picks up stubs.
const { loadedSlipToJobs } = await import("../src/punt.js");
const { fetchFixtureByName } = await import("../src/fixtures.js");
const { enrichWithH2H } = await import("../src/h2h.js");
const { enrichWithNewsIntel } = await import("../src/newsIntel.js");
const { enrichWithLineups } = await import("../src/lineups.js");
const { loadSportyBetIndex } = await import("../src/selectFixtures.js");

// ── Shared helpers ────────────────────────────────────────────────────────────

const TODAY = new Date().toISOString().slice(0, 10);

function stubJob(): FixtureJob {
  return {
    home: "Arsenal",
    away: "Chelsea",
    league: "Premier League",
    kickoff: `${TODAY}T15:00:00Z`,
  };
}

function makeSlip(legs: Partial<RawLeg>[] = [{}]) {
  return {
    code: "X",
    legs: legs.map((over) => ({
      home: "Arsenal",
      away: "Chelsea",
      league: "Premier League",
      marketDesc: "1X2",
      outcomeDesc: "Home",
      odds: 2.0,
      ...over,
    })),
    totalOdds: 2,
    loadedAt: "",
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  // Default enrichment stubs: pass jobs through unchanged.
  vi.mocked(enrichWithH2H).mockImplementation(async (jobs) => jobs as FixtureJob[]);
  vi.mocked(enrichWithNewsIntel).mockImplementation(async (jobs) => jobs as FixtureJob[]);
  vi.mocked(enrichWithLineups).mockImplementation(async (jobs) => jobs as FixtureJob[]);
});

afterEach(() => vi.clearAllMocks());

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("loadedSlipToJobs — sidecar stats merge", () => {
  it("merges sportyBetStats and sportyBetOdds into fetched when the index has a match", async () => {
    const fakeStats = { form: { home: { last5: "WWWDL" }, away: { last5: "LLDWW" } } };
    const fakeOdds = { "1x2": { home: 2.0, draw: 3.4, away: 4.0 } };
    const fakeDetail = { eventId: "ev-1", stats: fakeStats, odds: fakeOdds, statscoverage: null };

    vi.mocked(fetchFixtureByName).mockResolvedValue(stubJob());
    vi.mocked(loadSportyBetIndex).mockResolvedValue({
      date: TODAY,
      events: [{ home: "Arsenal", away: "Chelsea", marketCount: 12 }],
      byKey: new Map([["Arsenal|Chelsea", 12]]),
      detailByKey: new Map([["Arsenal|Chelsea", fakeDetail]]),
    } as never);

    const legs = await loadedSlipToJobs(makeSlip(), { oddsApiKey: "k" });

    expect(legs).toHaveLength(1);
    const job = legs[0]!.job;
    expect(job).not.toBeNull();

    const fetched = job!.state?.pipeline?.fetched as Record<string, unknown> | undefined;
    expect(fetched?.sportyBetStats).toEqual(fakeStats);
    expect(fetched?.sportyBetOdds).toEqual(fakeOdds);
    expect(fetched?.sportyBetStatsCoverage).toBeNull();
  });

  it("leaves pipeline.fetched without sportyBetStats when detailByKey has no match", async () => {
    vi.mocked(fetchFixtureByName).mockResolvedValue(stubJob());
    vi.mocked(loadSportyBetIndex).mockResolvedValue({
      date: TODAY,
      events: [],
      byKey: new Map(),
      detailByKey: new Map(), // no entry for Arsenal|Chelsea
    } as never);

    const legs = await loadedSlipToJobs(makeSlip(), { oddsApiKey: "k" });
    const job = legs[0]!.job;
    expect(job).not.toBeNull();

    const fetched = job!.state?.pipeline?.fetched as Record<string, unknown> | undefined;
    expect(fetched?.sportyBetStats).toBeUndefined();
  });

  it("preserves existing fetched fields when merging sidecar detail", async () => {
    const existingJob: FixtureJob = {
      ...stubJob(),
      state: { pipeline: { fetched: { oddsSource: "api-football" } } } as never,
    };
    const fakeDetail = {
      eventId: "ev-2",
      stats: { goals: { home: { avg_scored: 1.8 } } },
      odds: null,
      statscoverage: null,
    };

    vi.mocked(fetchFixtureByName).mockResolvedValue(existingJob);
    vi.mocked(loadSportyBetIndex).mockResolvedValue({
      date: TODAY,
      events: [{ home: "Arsenal", away: "Chelsea", marketCount: 8 }],
      byKey: new Map([["Arsenal|Chelsea", 8]]),
      detailByKey: new Map([["Arsenal|Chelsea", fakeDetail]]),
    } as never);

    const legs = await loadedSlipToJobs(makeSlip(), { oddsApiKey: "k" });
    const fetched = legs[0]!.job!.state?.pipeline?.fetched as Record<string, unknown>;

    // Pre-existing field must survive the spread merge.
    expect(fetched.oddsSource).toBe("api-football");
    expect(fetched.sportyBetStats).toEqual(fakeDetail.stats);
  });

  it("skips merge entirely when fetchFixtureByName returns null (no coverage)", async () => {
    vi.mocked(fetchFixtureByName).mockResolvedValue(null);
    vi.mocked(loadSportyBetIndex).mockResolvedValue(null);

    const legs = await loadedSlipToJobs(makeSlip(), { oddsApiKey: "k" });
    expect(legs[0]!.job).toBeNull();
  });

  it("skips merge when loadSportyBetIndex returns null (sidecar absent)", async () => {
    vi.mocked(fetchFixtureByName).mockResolvedValue(stubJob());
    vi.mocked(loadSportyBetIndex).mockResolvedValue(null);

    const legs = await loadedSlipToJobs(makeSlip(), { oddsApiKey: "k" });
    const fetched = legs[0]!.job?.state?.pipeline?.fetched as Record<string, unknown> | undefined;
    expect(fetched?.sportyBetStats).toBeUndefined();
  });
});
