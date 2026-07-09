/** [PR-13] loadTodaysCompletedLegs — extracts PortfolioLeg[] from today's
 *  already-stored RunManifests for the cross-batch correlation veto. */
import { mkdirSync, rmSync } from "node:fs";
import type { RunManifest } from "@oracle/engine";
import { MemoryAdapter, STORAGE_KEYS } from "@oracle/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTodaysCompletedLegs } from "../src/goalsV3Pipeline.js";

const RUN_ID = Date.now().toString(36);
const tmpDir = `.tmp/load-todays-legs-test-${RUN_ID}`;

function fakeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "r1",
    schemaVersion: 1,
    startedAt: "2026-07-07T09:35:00Z",
    finishedAt: "2026-07-07T09:40:00Z",
    mode: "CONFIDENCE_WEIGHTED",
    trigger: "scheduled",
    calibrationSnapshotId: "c1",
    fixtures: [],
    totals: { analysed: 0, actionable: 0, errors: 0, totalRecommendedStakePct: 0 },
    cost: { estimatedUsd: null, ceilingUsd: null, halted: false },
    errors: [],
    ...overrides,
  };
}

describe("loadTodaysCompletedLegs", () => {
  let storage: MemoryAdapter;

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    storage = new MemoryAdapter(tmpDir);
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns an empty array when no manifests are stored (fail-open)", async () => {
    expect(await loadTodaysCompletedLegs(storage, "2026-07-07")).toEqual([]);
  });

  it("extracts only today's actionable (status=ok, pick present) fixtures", async () => {
    const manifest = fakeManifest({
      fixtures: [
        {
          fixtureId: "f1",
          home: "Arsenal",
          away: "Chelsea",
          league: "Premier League",
          kickoff: "2026-07-07T15:00:00Z",
          status: "ok",
          pick: { market: "Goals O/U", side: "Over 2.5", odds: 1.8 },
          grade: "A",
          confidence: 0.62,
          errorCode: null,
          errorMessage: null,
          stakePct: 0.03,
        },
        {
          // Not actionable — no pick.
          fixtureId: "f2",
          home: "Man City",
          away: "Spurs",
          league: "Premier League",
          kickoff: "2026-07-07T17:30:00Z",
          status: "ok",
          pick: null,
          grade: null,
          confidence: null,
          errorCode: "NO_DATA",
          errorMessage: "no data",
          stakePct: null,
        },
        {
          // Different day — must be excluded.
          fixtureId: "f3",
          home: "Liverpool",
          away: "Everton",
          league: "Premier League",
          kickoff: "2026-07-06T15:00:00Z",
          status: "ok",
          pick: { market: "1x2", side: "Home", odds: 1.5 },
          grade: "A",
          confidence: 0.7,
          errorCode: null,
          errorMessage: null,
          stakePct: 0.02,
        },
      ],
    });
    await storage.set(STORAGE_KEYS.runManifests, [manifest]);

    const legs = await loadTodaysCompletedLegs(storage, "2026-07-07");
    expect(legs).toEqual([
      {
        home: "Arsenal",
        away: "Chelsea",
        league: "Premier League",
        market: "Goals O/U",
        mp: 0.62,
        kickoff: "2026-07-07T15:00:00Z",
      },
    ]);
  });

  it("excludes manifests from ad-hoc manual runs (CLI/bot/web/punt) — only trigger=scheduled counts", async () => {
    const manualManifest = fakeManifest({
      trigger: "manual",
      fixtures: [
        {
          fixtureId: "m1",
          home: "Man Utd",
          away: "Newcastle",
          league: "Premier League",
          kickoff: "2026-07-07T15:00:00Z",
          status: "ok",
          pick: { market: "1x2", side: "Home", odds: 1.7 },
          grade: "A",
          confidence: 0.55,
          errorCode: null,
          errorMessage: null,
          stakePct: 0.02,
        },
      ],
    });
    await storage.set(STORAGE_KEYS.runManifests, [manualManifest]);

    expect(await loadTodaysCompletedLegs(storage, "2026-07-07")).toEqual([]);
  });

  it("collects legs across multiple stored manifests", async () => {
    const m1 = fakeManifest({
      runId: "r1",
      fixtures: [
        {
          fixtureId: "a",
          home: "A",
          away: "B",
          league: "L1",
          kickoff: "2026-07-07T12:00:00Z",
          status: "ok",
          pick: { market: "1x2", side: "Home", odds: 1.5 },
          grade: "A",
          confidence: 0.6,
          errorCode: null,
          errorMessage: null,
          stakePct: 0.02,
        },
      ],
    });
    const m2 = fakeManifest({
      runId: "r2",
      fixtures: [
        {
          fixtureId: "c",
          home: "C",
          away: "D",
          league: "L2",
          kickoff: "2026-07-07T13:00:00Z",
          status: "ok",
          pick: { market: "1x2", side: "Away", odds: 2.5 },
          grade: "B",
          confidence: 0.4,
          errorCode: null,
          errorMessage: null,
          stakePct: 0.01,
        },
      ],
    });
    await storage.set(STORAGE_KEYS.runManifests, [m1, m2]);

    const legs = await loadTodaysCompletedLegs(storage, "2026-07-07");
    expect(legs).toHaveLength(2);
    expect(legs.map((l) => l.home)).toEqual(["A", "C"]);
  });
});
