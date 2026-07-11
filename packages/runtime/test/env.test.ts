import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfig, loadLakeBaselines, loadLakeHfa } from "../src/env.js";

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

describe("buildConfig marketsCoverageNote (PR-20)", () => {
  it("defaults to true (route-coverage telemetry on)", () => {
    expect(buildConfig({}).marketsCoverageNote).toBe(true);
  });

  it("respects ORACLE_MARKETS_COVERAGE=off (case-insensitive) as the rollback", () => {
    expect(buildConfig({ ORACLE_MARKETS_COVERAGE: "off" }).marketsCoverageNote).toBe(false);
    expect(buildConfig({ ORACLE_MARKETS_COVERAGE: "OFF" }).marketsCoverageNote).toBe(false);
  });
});

describe("buildConfig catalogOverlay (PR-21)", () => {
  it("defaults to false (runtime catalog overlay off until coverage data justifies it)", () => {
    expect(buildConfig({}).catalogOverlay).toBe(false);
  });

  it("respects ORACLE_CATALOG_OVERLAY=on (case-insensitive) to enable it", () => {
    expect(buildConfig({ ORACLE_CATALOG_OVERLAY: "on" }).catalogOverlay).toBe(true);
    expect(buildConfig({ ORACLE_CATALOG_OVERLAY: "ON" }).catalogOverlay).toBe(true);
  });

  it("stays false for any value other than exactly 'on'", () => {
    expect(buildConfig({ ORACLE_CATALOG_OVERLAY: "true" }).catalogOverlay).toBe(false);
    expect(buildConfig({ ORACLE_CATALOG_OVERLAY: "yes" }).catalogOverlay).toBe(false);
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

describe("buildConfig PR-8 demote/gate flags", () => {
  it("v3DeterministicDraft defaults on, ORACLE_V3_DETERMINISTIC_DRAFT=off restores LLM draft", () => {
    expect(buildConfig({}).v3DeterministicDraft).toBe(true);
    expect(buildConfig({ ORACLE_V3_DETERMINISTIC_DRAFT: "off" }).v3DeterministicDraft).toBe(false);
    expect(buildConfig({ ORACLE_V3_DETERMINISTIC_DRAFT: "OFF" }).v3DeterministicDraft).toBe(false);
  });

  it("llmExtrasTiers defaults apex, =all opts into the route's own tier scope", () => {
    expect(buildConfig({}).llmExtrasTiers).toBe("apex");
    expect(buildConfig({ ORACLE_LLM_EXTRAS_TIERS: "all" }).llmExtrasTiers).toBe("all");
    expect(buildConfig({ ORACLE_LLM_EXTRAS_TIERS: "banana" }).llmExtrasTiers).toBe("apex");
  });

  it("enableBriefing/enableCVL default off (explicit), opt-in via env", () => {
    expect(buildConfig({}).enableBriefing).toBe(false);
    expect(buildConfig({}).enableCVL).toBe(false);
    expect(buildConfig({ ENABLE_BRIEFING: "true" }).enableBriefing).toBe(true);
    expect(buildConfig({ ENABLE_CVL: "true" }).enableCVL).toBe(true);
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

describe("buildConfig llmExecutorScope + enableLlmMarketExecutor (PR-23 tri-state)", () => {
  it('defaults to "off" (enableLlmMarketExecutor false) when unset', () => {
    expect(buildConfig({}).llmExecutorScope).toBe("off");
    expect(buildConfig({}).enableLlmMarketExecutor).toBe(false);
  });

  it('ENABLE_LLM_MARKET_EXECUTOR="true" resolves to "full" scope — the exact pre-PR-23 behavior', () => {
    const cfg = buildConfig({ ENABLE_LLM_MARKET_EXECUTOR: "true" });
    expect(cfg.llmExecutorScope).toBe("full");
    expect(cfg.enableLlmMarketExecutor).toBe(true);
  });

  it('ENABLE_LLM_MARKET_EXECUTOR="unmapped" resolves to "unmapped" scope, enableLlmMarketExecutor still true', () => {
    const cfg = buildConfig({ ENABLE_LLM_MARKET_EXECUTOR: "unmapped" });
    expect(cfg.llmExecutorScope).toBe("unmapped");
    expect(cfg.enableLlmMarketExecutor).toBe(true);
  });

  it("is case-insensitive for both recognised values", () => {
    expect(buildConfig({ ENABLE_LLM_MARKET_EXECUTOR: "TRUE" }).llmExecutorScope).toBe("full");
    expect(buildConfig({ ENABLE_LLM_MARKET_EXECUTOR: "UNMAPPED" }).llmExecutorScope).toBe(
      "unmapped"
    );
  });

  it('falls back to "off" on any unrecognised value (never throws, never silently becomes "full")', () => {
    const cfg = buildConfig({ ENABLE_LLM_MARKET_EXECUTOR: "yes" });
    expect(cfg.llmExecutorScope).toBe("off");
    expect(cfg.enableLlmMarketExecutor).toBe(false);
  });

  it('ENABLE_LLM_MARKET_EXECUTOR="false" resolves to "off" (not "full" — only the literal "true" does)', () => {
    expect(buildConfig({ ENABLE_LLM_MARKET_EXECUTOR: "false" }).llmExecutorScope).toBe("off");
  });
});

describe("buildConfig enableNewsIntel", () => {
  it("defaults to false when the flag is unset", () => {
    expect(buildConfig({}).enableNewsIntel).toBe(false);
  });

  it("is true when ENABLE_NEWS_INTEL=true even with no provider keys present — a missing key is never a blocker; keyless mode runs the Google AI-Mode + local-Claude ensemble tier", () => {
    expect(buildConfig({ ENABLE_NEWS_INTEL: "true" }).enableNewsIntel).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(buildConfig({ ENABLE_NEWS_INTEL: "TRUE" }).enableNewsIntel).toBe(true);
  });

  it("stays false for any value other than 'true'", () => {
    expect(buildConfig({ ENABLE_NEWS_INTEL: "false" }).enableNewsIntel).toBe(false);
    expect(buildConfig({ ENABLE_NEWS_INTEL: "banana" }).enableNewsIntel).toBe(false);
  });
});

describe("loadLakeBaselines (audit P0-2)", () => {
  const withTempJson = (content: string, fn: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "lake-baselines-"));
    const path = join(dir, "league_baselines.json");
    writeFileSync(path, content, "utf8");
    try {
      fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("returns the byName map, keeping only positive-finite values", () => {
    withTempJson(
      JSON.stringify({
        byName: { "Premier League": 2.98, "La Liga": 2.58, Bad: 0, Nan: "x" },
      }),
      (path) => {
        expect(loadLakeBaselines(path)).toEqual({
          "Premier League": 2.98,
          "La Liga": 2.58,
        });
      }
    );
  });

  it("returns undefined for a missing file", () => {
    expect(loadLakeBaselines("/no/such/league_baselines.json")).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    withTempJson("{ not json", (path) => {
      expect(loadLakeBaselines(path)).toBeUndefined();
    });
  });

  it("returns undefined when byName is absent or has no usable values", () => {
    withTempJson(JSON.stringify({ detail: {} }), (path) => {
      expect(loadLakeBaselines(path)).toBeUndefined();
    });
    withTempJson(JSON.stringify({ byName: { A: 0, B: -1 } }), (path) => {
      expect(loadLakeBaselines(path)).toBeUndefined();
    });
  });
});

describe("buildConfig v3LakeBaselines gating", () => {
  it("is undefined by default (flag off ⇒ static table only)", () => {
    expect(buildConfig({}).v3LakeBaselines).toBeUndefined();
  });

  it("reads from an explicit leagueBaselinesPath override, not just cwd-relative", () => {
    const dir = mkdtempSync(join(tmpdir(), "lake-buildconfig-"));
    const path = join(dir, "league_baselines.json");
    writeFileSync(path, JSON.stringify({ byName: { "Premier League": 2.98 } }), "utf8");
    try {
      const cfg = buildConfig({ ORACLE_V3_LAKE_BASELINES: "on" }, path);
      expect(cfg.v3LakeBaselines).toEqual({ "Premier League": 2.98 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the bare cwd-relative default when no override path is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "lake-buildconfig-nocwdfile-"));
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      expect(buildConfig({ ORACLE_V3_LAKE_BASELINES: "on" }).v3LakeBaselines).toBeUndefined();
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadLakeHfa (full-audit P3)", () => {
  const withTempJson = (content: string, fn: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "lake-hfa-"));
    const path = join(dir, "league_baselines.json");
    writeFileSync(path, content, "utf8");
    try {
      fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("returns the hfaByName map, keeping only positive-finite values", () => {
    withTempJson(
      JSON.stringify({ hfaByName: { "Premier League": 1.08, "La Liga": 1.13, Bad: 0 } }),
      (path) => {
        expect(loadLakeHfa(path)).toEqual({ "Premier League": 1.08, "La Liga": 1.13 });
      }
    );
  });

  it("returns undefined when hfaByName is absent (baselines-only artifact)", () => {
    withTempJson(JSON.stringify({ byName: { "Premier League": 2.98 } }), (path) => {
      expect(loadLakeHfa(path)).toBeUndefined();
    });
  });

  it("returns undefined for a missing file", () => {
    expect(loadLakeHfa("/no/such/league_baselines.json")).toBeUndefined();
  });
});

describe("buildConfig v3HfaByLeague gating", () => {
  it("is undefined by default (flag off ⇒ global v3Hfa applies)", () => {
    expect(buildConfig({}).v3HfaByLeague).toBeUndefined();
  });

  it("reads from an explicit leagueBaselinesPath override, not just cwd-relative", () => {
    const dir = mkdtempSync(join(tmpdir(), "lake-hfa-buildconfig-"));
    const path = join(dir, "league_baselines.json");
    writeFileSync(path, JSON.stringify({ hfaByName: { "Premier League": 1.08 } }), "utf8");
    try {
      const cfg = buildConfig({ ORACLE_V3_LAKE_HFA: "on" }, path);
      expect(cfg.v3HfaByLeague).toEqual({ "Premier League": 1.08 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
