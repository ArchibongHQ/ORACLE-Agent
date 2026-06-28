import { describe, expect, it } from "vitest";
import { computeMarketExecutorConcurrency } from "../src/batch/marketExecutorConcurrency.js";

describe("computeMarketExecutorConcurrency", () => {
  it("scales to one agent per fixture on VPS, uncapped by hardware", () => {
    expect(computeMarketExecutorConcurrency(39, true)).toBe(39);
    expect(computeMarketExecutorConcurrency(1000, true)).toBe(1000);
  });

  it("never returns less than 1 even for a zero-fixture VPS run", () => {
    expect(computeMarketExecutorConcurrency(0, true)).toBe(1);
  });

  it("caps locally at 3 regardless of fixture count", () => {
    expect(computeMarketExecutorConcurrency(39, false)).toBeLessThanOrEqual(3);
    expect(computeMarketExecutorConcurrency(39, undefined)).toBeLessThanOrEqual(3);
  });

  it("never exceeds the fixture count locally on a small batch", () => {
    expect(computeMarketExecutorConcurrency(1, false)).toBe(1);
    expect(computeMarketExecutorConcurrency(2, false)).toBeLessThanOrEqual(2);
  });
});
