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

describe("buildConfig enableMarketsV3", () => {
  it("defaults to 'on' (owner decision: go live immediately)", () => {
    expect(buildConfig({}).enableMarketsV3).toBe("on");
  });

  it("respects ORACLE_MARKETS_V3=off as an explicit rollback", () => {
    expect(buildConfig({ ORACLE_MARKETS_V3: "off" }).enableMarketsV3).toBe("off");
  });

  it("respects ORACLE_MARKETS_V3=shadow", () => {
    expect(buildConfig({ ORACLE_MARKETS_V3: "shadow" }).enableMarketsV3).toBe("shadow");
  });

  it("treats an unrecognised value as 'on' (fail-open toward the new default)", () => {
    expect(buildConfig({ ORACLE_MARKETS_V3: "banana" }).enableMarketsV3).toBe("on");
  });

  it("is case-insensitive", () => {
    expect(buildConfig({ ORACLE_MARKETS_V3: "OFF" }).enableMarketsV3).toBe("off");
  });
});

describe("buildConfig v3CompletenessV4", () => {
  it("defaults to true (v4 completeness — hit-rate demoted from mandatory)", () => {
    expect(buildConfig({}).v3CompletenessV4).toBe(true);
  });

  it("respects ORACLE_V3_COMPLETENESS_V4=off as an explicit rollback to v3 semantics", () => {
    expect(buildConfig({ ORACLE_V3_COMPLETENESS_V4: "off" }).v3CompletenessV4).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(buildConfig({ ORACLE_V3_COMPLETENESS_V4: "OFF" }).v3CompletenessV4).toBe(false);
  });

  it("treats any other value as on (fail-open toward the new default)", () => {
    expect(buildConfig({ ORACLE_V3_COMPLETENESS_V4: "banana" }).v3CompletenessV4).toBe(true);
  });
});

describe("buildConfig marketsV3Gate", () => {
  it("defaults to true (PR-5a slate pre-filter on)", () => {
    expect(buildConfig({}).marketsV3Gate).toBe(true);
  });

  it("respects ORACLE_MARKETS_V3_GATE=off (case-insensitive) as the ungated-slate rollback", () => {
    expect(buildConfig({ ORACLE_MARKETS_V3_GATE: "off" }).marketsV3Gate).toBe(false);
    expect(buildConfig({ ORACLE_MARKETS_V3_GATE: "OFF" }).marketsV3Gate).toBe(false);
  });
});

describe("buildConfig marketsV3Outputs", () => {
  it("defaults to true (PR-5b Outputs A–D + sanity assembly on)", () => {
    expect(buildConfig({}).marketsV3Outputs).toBe(true);
  });

  it("respects ORACLE_MARKETS_V3_OUTPUTS=off (case-insensitive) as the legacy-trim rollback", () => {
    expect(buildConfig({ ORACLE_MARKETS_V3_OUTPUTS: "off" }).marketsV3Outputs).toBe(false);
    expect(buildConfig({ ORACLE_MARKETS_V3_OUTPUTS: "OFF" }).marketsV3Outputs).toBe(false);
  });
});

describe("buildConfig v3CornersCards (PR-6)", () => {
  it("defaults to true (corners/cards O/U pricing on)", () => {
    expect(buildConfig({}).v3CornersCards).toBe(true);
  });

  it("respects ORACLE_V3_CORNERS_CARDS=off (case-insensitive) — withholds stats, modules dormant", () => {
    expect(buildConfig({ ORACLE_V3_CORNERS_CARDS: "off" }).v3CornersCards).toBe(false);
    expect(buildConfig({ ORACLE_V3_CORNERS_CARDS: "OFF" }).v3CornersCards).toBe(false);
  });

  it("treats any non-off value as on", () => {
    expect(buildConfig({ ORACLE_V3_CORNERS_CARDS: "banana" }).v3CornersCards).toBe(true);
  });
});

describe("buildConfig v3GoalsCrossCheck (PR-6)", () => {
  it("defaults to true (R10 cross-check on)", () => {
    expect(buildConfig({}).v3GoalsCrossCheck).toBe(true);
  });

  it("respects ORACLE_V3_GOALS_CROSSCHECK=off (case-insensitive)", () => {
    expect(buildConfig({ ORACLE_V3_GOALS_CROSSCHECK: "off" }).v3GoalsCrossCheck).toBe(false);
    expect(buildConfig({ ORACLE_V3_GOALS_CROSSCHECK: "OFF" }).v3GoalsCrossCheck).toBe(false);
  });
});

describe("buildConfig calibrationLedger (PR-7)", () => {
  it("defaults to shadow (write-only, no live behaviour change)", () => {
    expect(buildConfig({}).calibrationLedger).toBe("shadow");
  });

  it("respects off/on (case-insensitive)", () => {
    expect(buildConfig({ ORACLE_CALIBRATION_LEDGER: "off" }).calibrationLedger).toBe("off");
    expect(buildConfig({ ORACLE_CALIBRATION_LEDGER: "ON" }).calibrationLedger).toBe("on");
  });

  it("falls back to shadow on unknown values", () => {
    expect(buildConfig({ ORACLE_CALIBRATION_LEDGER: "banana" }).calibrationLedger).toBe("shadow");
  });
});
