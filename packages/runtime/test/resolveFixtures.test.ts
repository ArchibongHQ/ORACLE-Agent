/** resolveUnmatchedViaWebSearch — web-search consensus fallback (CLAUDE.md §6).
 *  node:child_process (spawn/execFile) and node:fs / node:fs/promises are
 *  mocked — same seam/pattern as runPunt.test.ts (mock fs + spawn, never touch
 *  the real filesystem or spawn a real process) and claudeCode.test.ts (fake
 *  timers + assert the platform-appropriate tree-kill branch instead of a
 *  bare child.kill()) — so the timeout-cap and tree-kill behavior can be
 *  exercised without shelling out to the real tools/scrape_match_results.py. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisRecord } from "@oracle/engine";

const { spawn, execFile } = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn((_cmd: string, _args: string[], cb?: () => void) => cb?.()),
}));

vi.mock("node:child_process", () => ({ spawn, execFile }));

vi.mock("node:fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs")>();
  return { ...mod, existsSync: vi.fn() };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs/promises")>();
  return { ...mod, mkdir: vi.fn(), writeFile: vi.fn(), readFile: vi.fn() };
});

const { existsSync } = await import("node:fs");
const { mkdir, writeFile } = await import("node:fs/promises");
const { resolveUnmatchedViaWebSearch } = await import("../src/resolveFixtures.js");

/** Minimal EventEmitter-backed fake child process — mirrors claudeCode.test.ts's
 *  FakeChild so the same "advance fake timers, then assert the tree-kill
 *  branch fired" idiom applies here. */
class FakeChild {
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  pid = 4321;
  kill = vi.fn();
  on(event: string, cb: (...args: unknown[]) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
}

function makeRecord(i: number): AnalysisRecord {
  return {
    analysisId: `analysis_${i}`,
    runId: "run_test",
    schemaVersion: 1,
    calibrationSnapshotId: "calib_test",
    fixtureId: `fixture-${i}`,
    home: `Home${i}`,
    away: `Away${i}`,
    league: "Test League",
    kickoff: "2026-07-14T15:00:00Z",
    lambdaH: 1.4,
    lambdaA: 1.1,
    probabilities: { home: 0.4, draw: 0.3, away: 0.3 },
    regime: "NORMAL",
    rankingMode: "MAX_EV",
    liquidityTag: "CALIBRATION_ONLY",
    evMarkets: [],
    llmPick: null,
    deterministicTopPick: null,
    decisionReplay: null,
    frozenOddsAtAnalysis: null,
    analysedAt: "2026-07-14T12:00:00Z",
  };
}

beforeEach(() => {
  spawn.mockReset();
  execFile.mockClear();
  vi.mocked(existsSync).mockReturnValue(false); // no cached result file — every target reports unmatched
  vi.mocked(mkdir).mockResolvedValue(undefined);
  vi.mocked(writeFile).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("resolveUnmatchedViaWebSearch — sweep timeout cap", () => {
  it("caps the total timeout at 10min even when 35s/fixture * targets.length would exceed it", async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      // 30 targets * 35_000ms = 1_050_000ms (~17.5min) uncapped — well past the
      // 10min cap. child never emits "close"/"error", so the only way this
      // promise resolves is via the timeout branch.
      const records = Array.from({ length: 30 }, (_, i) => makeRecord(i));
      const unmatchedIds = records.map((r) => r.fixtureId);
      const child = new FakeChild();
      spawn.mockReturnValue(child);

      const promise = resolveUnmatchedViaWebSearch(records, unmatchedIds, "run_test");
      await vi.advanceTimersByTimeAsync(0); // let the dynamic import("node:child_process") resolve

      // Advancing exactly 10min (the cap) must be enough to settle — if the
      // uncapped 35_000*30ms budget were still in effect, nothing would have
      // fired yet at this point.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      const result = await promise;

      expect(result.unmatched).toEqual(unmatchedIds);
      expect(result.resolved).toEqual([]);
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe("resolveUnmatchedViaWebSearch — tree-kill on timeout", () => {
  it("tree-kills the spawned process instead of calling bare child.kill()", async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const records = [makeRecord(0)];
      const child = new FakeChild();
      spawn.mockReturnValue(child);

      const promise = resolveUnmatchedViaWebSearch(records, [records[0]!.fixtureId], "run_test");
      await vi.advanceTimersByTimeAsync(0);
      // Single target: capped budget is min(35_000, 600_000) = 35_000ms.
      await vi.advanceTimersByTimeAsync(35_000);
      await promise;

      // The bare child.kill() this replaces must NOT have been called.
      expect(child.kill).not.toHaveBeenCalled();
      // killProcessTree (fixtures.ts) branches on process.platform — assert
      // whichever branch this runner actually takes, same as
      // claudeCode.test.ts's equivalent assertion.
      if (process.platform === "win32") {
        expect(execFile).toHaveBeenCalledWith(
          "taskkill",
          ["/pid", "4321", "/T", "/F"],
          expect.any(Function)
        );
      } else {
        expect(killSpy).toHaveBeenCalledWith(-4321, "SIGKILL");
      }
    } finally {
      killSpy.mockRestore();
    }
  });
});
