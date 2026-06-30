import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markFulfilled,
  markPrompted,
  readPuntState,
  SLIP_LABELS,
  shouldReprompt,
} from "../src/puntState.js";

let root: string;
const DATE = "2026-07-01";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oracle-punt-state-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("puntState", () => {
  it("defaults to two unprompted, unfulfilled slips", () => {
    const state = readPuntState(root, DATE);
    expect(state.slips).toHaveLength(SLIP_LABELS.length);
    for (const slip of state.slips) {
      expect(slip).toEqual({ promptedAt: null, fulfilled: false });
    }
  });

  it("markPrompted stamps only the targeted slip and is idempotent", () => {
    markPrompted(root, 0, DATE);
    const first = readPuntState(root, DATE).slips[0]!.promptedAt;
    expect(first).not.toBeNull();
    expect(readPuntState(root, DATE).slips[1]!.promptedAt).toBeNull();

    markPrompted(root, 0, DATE); // second call must not overwrite the timestamp
    expect(readPuntState(root, DATE).slips[0]!.promptedAt).toBe(first);
  });

  it("markFulfilled closes slips in order, ignores extra codes once both are done", () => {
    expect(markFulfilled(root, "CODE-A", DATE)).toBe(0);
    let state = readPuntState(root, DATE);
    expect(state.slips[0]).toMatchObject({ fulfilled: true, lastCode: "CODE-A" });
    expect(state.slips[1]!.fulfilled).toBe(false);

    expect(markFulfilled(root, "CODE-B", DATE)).toBe(1);
    state = readPuntState(root, DATE);
    expect(state.slips[1]).toMatchObject({ fulfilled: true, lastCode: "CODE-B" });

    expect(markFulfilled(root, "CODE-C", DATE)).toBeNull(); // both slips already closed
  });

  it("shouldReprompt is true only for slips not yet fulfilled", () => {
    expect(shouldReprompt(root, 0, DATE)).toBe(true);
    expect(shouldReprompt(root, 1, DATE)).toBe(true);

    markFulfilled(root, "CODE-A", DATE);
    expect(shouldReprompt(root, 0, DATE)).toBe(false);
    expect(shouldReprompt(root, 1, DATE)).toBe(true);
  });

  it("scopes state by date — different dates don't share slips", () => {
    markFulfilled(root, "CODE-A", DATE);
    const otherDate = readPuntState(root, "2026-07-02");
    expect(otherDate.slips.every((s) => !s.fulfilled)).toBe(true);
  });
});
