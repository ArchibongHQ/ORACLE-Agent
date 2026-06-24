import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/env.js";

describe("buildConfig maxFixturesPerRun", () => {
  it("defaults to 50 when unset", () => {
    expect(buildConfig({}).maxFixturesPerRun).toBe(50);
  });

  it.each([
    ["25", 25],
    ["0", 50],
    ["-5", 50],
    ["abc", 50],
    ["", 50],
    ["0.5", 50], // floors to 0 → invalid → default
    ["10.9", 10], // floors fractional caps
  ])("MAX_FIXTURES_PER_RUN=%j → %d", (raw, expected) => {
    expect(buildConfig({ MAX_FIXTURES_PER_RUN: raw }).maxFixturesPerRun).toBe(expected);
  });
});

describe("buildConfig enableGoalsOnlyMode", () => {
  it("is always false, regardless of ORACLE_GOALS_ONLY_MODE — the shared config object feeds every analysis call site (main batch, ad-hoc /analyze, CLI, web, punt), and this flag is an exception scoped to the independent goals pipeline alone, which opts in explicitly per-call", () => {
    expect(buildConfig({}).enableGoalsOnlyMode).toBe(false);
    expect(buildConfig({ ORACLE_GOALS_ONLY_MODE: "true" }).enableGoalsOnlyMode).toBe(false);
    expect(buildConfig({ ORACLE_GOALS_ONLY_MODE: "false" }).enableGoalsOnlyMode).toBe(false);
  });
});
