/** [PR-11] printEffectiveConfig's startup dump + the v3VenueSplitUsed assertion. */
import type { OracleConfig } from "@oracle/engine";
import type { GoalsV3Config } from "@oracle/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printEffectiveConfig } from "../src/effectiveConfig.js";

function fakeConfig(overrides: Partial<OracleConfig> = {}): OracleConfig {
  return { geminiApiKey: "", claudeApiKey: "", bankroll: 1000, ...overrides };
}

const fakeGoalsConfig: GoalsV3Config = {
  enabled: true,
  completenessMin: 70,
  heightenedMin: 80,
  edgeCap: 0.12,
  noiseGate: 0.02,
  xgBlend: true,
  arbiterTimeoutMs: 30_000,
  enableBtts: false,
};

describe("printEffectiveConfig", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("dumps the resolved flags as one JSON line on stdout", () => {
    printEffectiveConfig(fakeConfig({ enableMarketsV3: "on", v3Hfa: 1.1 }), fakeGoalsConfig);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const line = stdoutSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain("[worker] effective config:");
    const json = JSON.parse(line.replace("[worker] effective config: ", ""));
    expect(json.enableMarketsV3).toBe("on");
    expect(json.v3Hfa).toBe(1.1);
  });

  // [regression test, 2026-07-17] v3Patterns (real pick-selection gate
  // relaxation once "on") was missing from this dump since the flag was
  // introduced — a misconfigured/unexpectedly-live deploy had no first-line
  // visibility, exactly the failure mode this file exists to prevent.
  it("includes v3Patterns in the dump", () => {
    printEffectiveConfig(fakeConfig({ v3Patterns: "on" }), fakeGoalsConfig);
    const line = stdoutSpy.mock.calls[0]?.[0] as string;
    const json = JSON.parse(line.replace("[worker] effective config: ", ""));
    expect(json.v3Patterns).toBe("on");
  });

  it("does not warn when v3VenueSplitUsed is false/undefined", () => {
    printEffectiveConfig(fakeConfig({ v3VenueSplitUsed: false }), fakeGoalsConfig);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("warns loudly when v3VenueSplitUsed is true — neither pipeline backs the claim", () => {
    printEffectiveConfig(fakeConfig({ v3VenueSplitUsed: true }), fakeGoalsConfig);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = stderrSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain("ORACLE_V3_VENUE_SPLIT=on");
    expect(line).toContain("WARN");
  });
});
