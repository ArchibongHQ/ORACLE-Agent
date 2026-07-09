/** PR-8a — unit tests for the T-30m closing-odds sweep's pure window/dedup
 *  logic. Extracted into its own dependency-free module (closingOddsSweep.ts)
 *  precisely so this is testable without importing the rest of
 *  apps/worker/src/index.ts (cron registrations, execFile calls, etc.) —
 *  same rationale as acquireChain.test.ts. */
import { describe, expect, it } from "vitest";
import {
  isDueForSnapshot,
  minutesToKickoff,
  type SweepCandidate,
  selectDueFixtures,
} from "../src/closingOddsSweep.js";

const NOW = new Date("2026-07-07T12:00:00.000Z");

function kickoffMinutesFromNow(mins: number): string {
  return new Date(NOW.getTime() + mins * 60_000).toISOString();
}

describe("minutesToKickoff", () => {
  it("returns a positive value for a future kickoff", () => {
    expect(minutesToKickoff(kickoffMinutesFromNow(30), NOW)).toBeCloseTo(30, 6);
  });

  it("returns a negative value for a past kickoff", () => {
    expect(minutesToKickoff(kickoffMinutesFromNow(-10), NOW)).toBeCloseTo(-10, 6);
  });

  it("returns NaN for a malformed ISO string", () => {
    expect(minutesToKickoff("not-a-date", NOW)).toBeNaN();
  });
});

describe("isDueForSnapshot — window boundaries", () => {
  it("is false just below the window (24.9 min out)", () => {
    expect(isDueForSnapshot(24.9)).toBe(false);
  });

  it("is true at the window's minimum edge (25.0 min out)", () => {
    expect(isDueForSnapshot(25.0)).toBe(true);
  });

  it("is true at the window's maximum edge (35.0 min out)", () => {
    expect(isDueForSnapshot(35.0)).toBe(true);
  });

  it("is false just above the window (35.1 min out)", () => {
    expect(isDueForSnapshot(35.1)).toBe(false);
  });

  it("is false for NaN (malformed kickoff)", () => {
    expect(isDueForSnapshot(Number.NaN)).toBe(false);
  });
});

function candidate(overrides: Partial<SweepCandidate>): SweepCandidate {
  return {
    fixtureId: "arsenal_vs_chelsea_202607071500",
    home: "Arsenal",
    away: "Chelsea",
    kickoff: kickoffMinutesFromNow(30),
    analysedAt: "2026-07-07T09:35:00.000Z",
    ...overrides,
  };
}

describe("selectDueFixtures", () => {
  it("returns empty for empty input, no throw", () => {
    expect(selectDueFixtures([], new Set(), NOW)).toEqual([]);
  });

  it("includes a fixture inside the window", () => {
    const c = candidate({ kickoff: kickoffMinutesFromNow(30) });
    expect(selectDueFixtures([c], new Set(), NOW)).toEqual([
      { fixtureId: c.fixtureId, home: c.home, away: c.away, kickoff: c.kickoff },
    ]);
  });

  it("excludes a fixture at 20 min out (not yet due)", () => {
    const c = candidate({ kickoff: kickoffMinutesFromNow(20) });
    expect(selectDueFixtures([c], new Set(), NOW)).toEqual([]);
  });

  it("excludes a fixture at 40 min out (already past due, or too early)", () => {
    const c = candidate({ kickoff: kickoffMinutesFromNow(40) });
    expect(selectDueFixtures([c], new Set(), NOW)).toEqual([]);
  });

  it("includes fixtures at 25 and 35 min out (inclusive boundaries)", () => {
    const c25 = candidate({ fixtureId: "fx25", kickoff: kickoffMinutesFromNow(25) });
    const c35 = candidate({ fixtureId: "fx35", kickoff: kickoffMinutesFromNow(35) });
    const due = selectDueFixtures([c25, c35], new Set(), NOW);
    expect(due.map((d) => d.fixtureId).sort()).toEqual(["fx25", "fx35"]);
  });

  it("excludes a fixtureId already snapshotted, even if inside the window", () => {
    const c = candidate({ fixtureId: "already-done" });
    expect(selectDueFixtures([c], new Set(["already-done"]), NOW)).toEqual([]);
  });

  it("dedupes reruns of the same fixtureId, keeping only the most-recently-analysed one", () => {
    const older = candidate({
      fixtureId: "rerun-fixture",
      analysedAt: "2026-07-07T09:00:00.000Z",
      home: "Old Home Value",
    });
    const newer = candidate({
      fixtureId: "rerun-fixture",
      analysedAt: "2026-07-07T09:40:00.000Z",
      home: "Arsenal",
    });
    const due = selectDueFixtures([older, newer], new Set(), NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.home).toBe("Arsenal");
  });

  it("simulates a full sweep tick: 2 due, 1 not-yet-due, 1 already-snapshotted, 1 rerun-duplicate", () => {
    const dueA = candidate({ fixtureId: "due-a", kickoff: kickoffMinutesFromNow(28) });
    const dueBOld = candidate({
      fixtureId: "due-b",
      kickoff: kickoffMinutesFromNow(32),
      analysedAt: "2026-07-07T09:00:00.000Z",
    });
    const dueBNew = candidate({
      fixtureId: "due-b",
      kickoff: kickoffMinutesFromNow(32),
      analysedAt: "2026-07-07T09:40:00.000Z",
    });
    const notYetDue = candidate({ fixtureId: "not-yet-due", kickoff: kickoffMinutesFromNow(60) });
    const alreadySnapshotted = candidate({
      fixtureId: "already-done",
      kickoff: kickoffMinutesFromNow(30),
    });

    const due = selectDueFixtures(
      [dueA, dueBOld, dueBNew, notYetDue, alreadySnapshotted],
      new Set(["already-done"]),
      NOW
    );

    expect(due.map((d) => d.fixtureId).sort()).toEqual(["due-a", "due-b"]);
  });
});
