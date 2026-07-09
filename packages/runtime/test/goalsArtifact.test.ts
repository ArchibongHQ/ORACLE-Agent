import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGoalsArtifact, writeGoalsArtifact } from "../src/goalsArtifact.js";
import type { GoalsSelectionResult } from "../src/selectGoals.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oracle-goals-artifact-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function selection(): GoalsSelectionResult {
  return {
    legs: [],
    shortSlipLegs: [],
    target: 39,
    analysed: 10,
    qualified: 0,
    counts: { over15: 0, over25: 0, teamOver05: 0 },
    combinedProb: 0,
    combinedOdds: 0,
    shortSlipCombinedProb: 0,
    shortSlipCombinedOdds: 0,
    outputBLegs: [],
    outputCLegs: [],
    miniAccaLegs: [],
    miniAccaCombinedProb: 0,
    miniAccaCombinedOdds: 0,
    miniAccaTrueEv: -1,
  };
}

describe("writeGoalsArtifact / readGoalsArtifact", () => {
  it("writes then reads back the same selection for a date", async () => {
    const sel = selection();
    await writeGoalsArtifact(sel, "2026-06-20", dir);
    const artifact = await readGoalsArtifact("2026-06-20", dir);
    expect(artifact).not.toBeNull();
    expect(artifact?.date).toBe("2026-06-20");
    expect(artifact?.selection.target).toBe(39);
  });

  it("returns null when no artifact exists for the date", async () => {
    const artifact = await readGoalsArtifact("1999-01-01", dir);
    expect(artifact).toBeNull();
  });

  it("overwrites the prior artifact for the same date on a second write", async () => {
    await writeGoalsArtifact({ ...selection(), analysed: 10 }, "2026-06-20", dir);
    await writeGoalsArtifact({ ...selection(), analysed: 20 }, "2026-06-20", dir);
    const artifact = await readGoalsArtifact("2026-06-20", dir);
    expect(artifact?.selection.analysed).toBe(20);
  });

  it("readGoalsArtifact returns null (not a thrown path-traversal read) for a malformed date", async () => {
    const artifact = await readGoalsArtifact("../../../../etc/passwd", dir);
    expect(artifact).toBeNull();
  });

  it("writeGoalsArtifact rejects a malformed date instead of writing outside outDir", async () => {
    await expect(writeGoalsArtifact(selection(), "../../escape", dir)).rejects.toThrow(
      /Invalid date/
    );
  });
});
