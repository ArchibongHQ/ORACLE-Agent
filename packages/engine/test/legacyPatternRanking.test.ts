/** [Phase 2A, patterns-legacy-pricer] Pattern-aware ranking for the legacy
 *  ExecutionEngine pricer path — closes the last pattern-blind gap in
 *  delivery (markets-v3 already calls detectPatterns; this fixture's LEGACY
 *  evMarkets never saw it before Phase 2A). Covers both the pure functions
 *  in isolation (buildLegacyPatternInput, applyLegacyPatternRanking) and the
 *  full runBatch integration seam (config.v62Patterns → detectPatterns →
 *  re-ranked evMarkets → eligible). */

import { MemoryAdapter } from "@oracle/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyLegacyPatternRanking,
  buildLegacyPatternInput,
  type FixtureJob,
  type FixtureJobSuccess,
  runBatch,
} from "../src/batch/index.js";
import { ExecutionEngine } from "../src/execution/index.js";
import type { PatternReport } from "../src/marketsV3/patterns.js";
import type { AllMarketEntry, EVMarket, OracleConfig, RunResult, RunState } from "../src/types.js";

const runAllMarketsLlmExecutorMock = vi.fn();
vi.mock("../src/decision/marketExecutor.js", () => ({
  runAllMarketsLlmExecutor: (...args: unknown[]) => runAllMarketsLlmExecutorMock(...args),
}));

const analyzeFixtureMarketsV3Mock = vi.fn();
vi.mock("../src/marketsV3/analyzeFixtureMarkets.js", async () => {
  const actual = await vi.importActual<typeof import("../src/marketsV3/analyzeFixtureMarkets.js")>(
    "../src/marketsV3/analyzeFixtureMarkets.js"
  );
  return {
    ...actual,
    analyzeFixtureMarketsV3: (...args: unknown[]) => analyzeFixtureMarketsV3Mock(...args),
  };
});

// decide() dynamically imports @oracle/llm at every cascade tier — same
// convention as marketsV3BatchIntegration.test.ts/decision.test.ts, avoids
// paying real transform/load cost for the whole package graph per test.
vi.mock("@oracle/llm", () => ({
  isLocalRuntime: () => false,
  callClaudeCode: vi.fn().mockResolvedValue(null),
  callOpenRouterJson: vi.fn().mockResolvedValue(null),
  callGeminiDecision: vi.fn().mockResolvedValue(null),
  MODELS: { CLAUDE_OPUS: "claude-opus" },
  OPENROUTER_MODELS: { GLM_5_2: "glm-5.2", GLM_5_1: "glm-5.1" },
  _resetClaudeCodeCaches: vi.fn(),
}));

beforeEach(() => {
  analyzeFixtureMarketsV3Mock.mockReset();
  analyzeFixtureMarketsV3Mock.mockReturnValue(null); // v3 off/dry for these tests — legacy path only
  runAllMarketsLlmExecutorMock.mockReset();
  runAllMarketsLlmExecutorMock.mockResolvedValue(null);
});

const storage = new MemoryAdapter(`.tmp/legacy-pattern-ranking-test-${Date.now().toString(36)}`);
const baseConfig: OracleConfig = { geminiApiKey: "", claudeApiKey: "", bankroll: 1000 };

function makeJob(state: FixtureJob["state"]): FixtureJob {
  return {
    home: "Arsenal",
    away: "Chelsea",
    league: "Premier League",
    kickoff: "2026-06-05T15:00:00Z",
    state,
  };
}

// The reference-doc worked example (packages/engine/test/patterns.test.ts's
// own "Arsenal vs Chelsea" fixture) — a proven, reliable telemetry
// combination that fires detectHeavySuperior with recommendedFamily
// "asian_handicap", recommendedSide "Home", strength well above
// PATTERN_MIN_STRENGTH (0.3). Reused here (not re-derived) so this
// integration test exercises a REAL pattern-detection path, not a
// hand-constructed PatternReport.
const heavySuperiorTelemetry: RunState["telemetry"] = {
  scoredPer90H: 2.4,
  concededPer90H: 0.6,
  scoredPer90A: 0.8,
  concededPer90A: 2.2,
  ouO25H: 0.8,
  ouO25A: 0.6,
  bttsPctH: 0.4,
  bttsPctA: 0.6,
  cornersForH: 6.8,
  cornersAgainstH: 3.2,
  cornersForA: 4.2,
  cornersAgainstA: 6.5,
  hOdds: 1.5,
  dOdds: 4.2,
  aOdds: 6.0,
  formNH: 5,
  formNA: 5,
};

const legacyAhHome: EVMarket = {
  cat: "Asian Handicap",
  label: "Home -1.5",
  market: "Asian Handicap",
  side: "Home -1.5",
  family: "asian_handicap",
  mp: 0.5,
  modelProb: 0.5,
  ip: 0.45,
  rawEdge: 0.05,
  ev: 0.05,
  odds: 2.0,
  stake: 0.02,
  stakeAmt: 20,
  rankingScore: 0.05, // deliberately close to legacyDoubleChance's — proves the boost, not a landslide
  varianceMod: 1,
};

const legacyDoubleChance: EVMarket = {
  cat: "Double Chance",
  label: "Home or Draw",
  market: "Double Chance",
  side: "Home or Draw",
  family: "double_chance",
  mp: 0.82,
  modelProb: 0.82,
  ip: 0.76,
  rawEdge: 0.06,
  ev: 0.06,
  odds: 1.25,
  stake: 0.03,
  stakeAmt: 30,
  rankingScore: 0.06, // higher raw rankingScore than legacyAhHome — the pattern boost must overcome this
  varianceMod: 1,
};

function legacyRunResultWith(evMarkets: EVMarket[]): RunResult {
  return {
    fp: { home: 0.45, draw: 0.28, away: 0.27 },
    evMarkets,
    oddsAvailable: true,
    bayesian_lH: 1.5,
    bayesian_lA: 1.2,
    expectedScoreline: "1-1",
    portfolioCorrelation: null,
    correlatedParlayRisk: null,
  };
}

describe("buildLegacyPatternInput", () => {
  it("maps RunState.telemetry onto PatternInput using the same field choices as buildV3Input/buildFixturePatternInput", () => {
    const state: RunState = { telemetry: heavySuperiorTelemetry };
    const input = buildLegacyPatternInput(state, "Premier League");
    expect(input).not.toBeNull();
    expect(input?.homeScoredHome).toBe(2.4);
    expect(input?.homeConcededHome).toBe(0.6);
    expect(input?.awayScoredAway).toBe(0.8);
    expect(input?.awayConcededAway).toBe(2.2);
    expect(input?.ou25PctH).toBe(0.8); // sourced from t.ouO25H (name transposition)
    expect(input?.nHome).toBe(5); // sourced from t.formNH, not t.nHome
    expect(input?.homeOdds).toBe(1.5); // sourced from t.hOdds directly
    expect(input?.league).toBe("Premier League");
  });

  it.each([
    "scoredPer90H",
    "concededPer90H",
    "scoredPer90A",
    "concededPer90A",
  ] as const)("returns null when %s alone is missing — never fabricates a signal from a 0-fallback", (field) => {
    const state: RunState = { telemetry: { ...heavySuperiorTelemetry, [field]: undefined } };
    expect(buildLegacyPatternInput(state, "Premier League")).toBeNull();
  });

  it("returns null when telemetry is entirely absent", () => {
    expect(buildLegacyPatternInput({}, "Premier League")).toBeNull();
  });
});

describe("applyLegacyPatternRanking", () => {
  const strongPattern: PatternReport = {
    patterns: [],
    topPattern: {
      kind: "heavy_superior",
      score: 0.9,
      side: "home",
      recommendedFamily: "asian_handicap",
      recommendedSide: "Home",
      rationale: "test fixture",
    },
    strength: 0.8,
    recommendedFamily: "asian_handicap",
    recommendedSide: "Home",
    confidence: "high",
    trapWarning: null,
    trapFlags: [],
  };

  it("boosts the pattern-backed candidate's rankingScore and sorts it first, even when it started behind a higher-rankingScore candidate", () => {
    const ranked = applyLegacyPatternRanking([legacyDoubleChance, legacyAhHome], strongPattern);
    expect(ranked[0]?.label).toBe("Home -1.5");
    expect(ranked[0]?.rankingScore).toBeGreaterThan(legacyAhHome.rankingScore);
    // The non-pattern candidate is untouched.
    expect(ranked[1]?.label).toBe("Home or Draw");
    expect(ranked[1]?.rankingScore).toBe(legacyDoubleChance.rankingScore);
  });

  it("never boosts a candidate with ev <= 0, even when it matches the pattern's family+side exactly (defense-in-depth — the real floor is buildEligibleBets, called after this)", () => {
    const negativeEvMatch: EVMarket = { ...legacyAhHome, ev: -0.02, rankingScore: 0.05 };
    const ranked = applyLegacyPatternRanking([legacyDoubleChance, negativeEvMatch], strongPattern);
    const matched = ranked.find((m) => m.label === "Home -1.5");
    expect(matched?.rankingScore).toBe(0.05); // unchanged — never boosted
    expect(matched?.ev).toBe(-0.02); // ev itself is never touched either way
  });

  it("does not boost a candidate in a non-matching family, even with an identical side string", () => {
    const wrongFamily: EVMarket = { ...legacyAhHome, family: "handicap", rankingScore: 0.05 };
    const ranked = applyLegacyPatternRanking([wrongFamily], strongPattern);
    expect(ranked[0]?.rankingScore).toBe(0.05); // unchanged
  });

  it("does not boost a candidate in the right family with the WRONG side (sideMatches returns false)", () => {
    const wrongSide: EVMarket = {
      ...legacyAhHome,
      label: "Away +1.5",
      side: "Away +1.5",
      rankingScore: 0.05,
    };
    const ranked = applyLegacyPatternRanking([wrongSide], strongPattern);
    expect(ranked[0]?.rankingScore).toBe(0.05); // unchanged — strongPattern recommends "Home"
  });

  it("never boosts a vetoed candidate (v3-cap/v3-noise), even when it matches family+side exactly and has ev > 0 (adversarial review finding, 2026-07-20 — execution/index.ts pushes these with rankingScore: -100)", () => {
    const cappedMatch: EVMarket = { ...legacyAhHome, veto: "v3-cap", rankingScore: -100 };
    const ranked = applyLegacyPatternRanking([legacyDoubleChance, cappedMatch], strongPattern);
    const matched = ranked.find((m) => m.label === "Home -1.5");
    expect(matched?.rankingScore).toBe(-100); // unchanged — never boosted despite the exact match
    // Never sorts ahead of a genuine +EV non-vetoed candidate either.
    expect(ranked[0]?.label).toBe("Home or Draw");
  });

  it("matches on .side (the clean outcome desc), not the composite .label scanAllMarketsFallback produces (adversarial review finding, 2026-07-20)", () => {
    // Mirrors execution/index.ts's scanAllMarketsFallback shape EXACTLY:
    // label is a composite "<market name> — <outcome desc>" string that
    // dirOfDesc/lineOfDesc/exact-match all fail to parse; side carries the
    // clean desc sideMatches actually expects.
    const scanSourced: EVMarket = {
      cat: "Asian Handicap",
      label: "Asian Handicap — Home -1.5",
      market: "Asian Handicap",
      side: "Home -1.5",
      family: "asian_handicap",
      mp: 0.5,
      modelProb: 0.5,
      ip: 0.45,
      rawEdge: 0.05,
      ev: 0.05,
      odds: 2.0,
      stake: 0.02,
      stakeAmt: 20,
      rankingScore: 0.05,
      varianceMod: 1,
      sourcedFromScan: true,
    };
    const ranked = applyLegacyPatternRanking([legacyDoubleChance, scanSourced], strongPattern);
    const matched = ranked.find((m) => m.side === "Home -1.5");
    expect(matched?.rankingScore).toBeGreaterThan(0.05); // boosted via .side, despite the composite .label
    expect(ranked[0]?.side).toBe("Home -1.5");
  });

  it("boosts and preserves relative order among MULTIPLE candidates that all match the pattern", () => {
    // PATTERN_RANK_BONUS(0.02) * strength(0.8) = 0.016 boost, applied
    // identically to both matches: legacyAhHome 0.05→0.066, secondAhHome
    // 0.03→0.046 — a non-matching candidate at 0.02 (well below both
    // boosted scores) isolates the order-among-matches claim cleanly,
    // rather than depending on an inequality against the shared fixtures'
    // own values (legacyDoubleChance's unboosted 0.06 would have sat
    // between the two boosted scores, confounding this specific claim).
    const secondAhHome: EVMarket = {
      ...legacyAhHome,
      label: "Home -0.5",
      side: "Home -0.5",
      rankingScore: 0.03,
    };
    const lowNonMatching: EVMarket = { ...legacyDoubleChance, rankingScore: 0.02 };
    const ranked = applyLegacyPatternRanking(
      [secondAhHome, legacyAhHome, lowNonMatching],
      strongPattern
    );
    // Both matches boosted by the SAME PATTERN_RANK_BONUS*strength amount —
    // their relative order (legacyAhHome's higher raw 0.05 > secondAhHome's
    // 0.03) is preserved, both ahead of the non-matching candidate.
    expect(ranked.map((m) => m.label)).toEqual(["Home -1.5", "Home -0.5", "Home or Draw"]);
  });

  it("does not boost a candidate whose family is undefined (EVMarket.family is optional) and does not throw", () => {
    const noFamily: EVMarket = { ...legacyAhHome, family: undefined, rankingScore: 0.05 };
    expect(() => applyLegacyPatternRanking([noFamily], strongPattern)).not.toThrow();
    expect(applyLegacyPatternRanking([noFamily], strongPattern)[0]?.rankingScore).toBe(0.05);
  });

  it("returns an empty array (not a throw) for empty input", () => {
    const ranked = applyLegacyPatternRanking([], strongPattern);
    expect(ranked).toEqual([]);
  });

  it("returns a NEW array, never mutates the input — including candidates that were NOT boosted", () => {
    const input = [legacyAhHome, legacyDoubleChance];
    const ranked = applyLegacyPatternRanking(input, strongPattern);
    expect(ranked).not.toBe(input);
    expect(legacyAhHome.rankingScore).toBe(0.05); // boosted candidate's original object untouched
    expect(ranked.includes(legacyDoubleChance)).toBe(true); // non-boosted: same reference, returned as-is
    expect(legacyDoubleChance.rankingScore).toBe(0.06); // unmutated
  });

  it("is a no-op (returns the input array unchanged in content) when the pattern report has no recommendedFamily/recommendedSide", () => {
    const noRec: PatternReport = {
      ...strongPattern,
      recommendedFamily: null,
      recommendedSide: null,
    };
    const ranked = applyLegacyPatternRanking([legacyAhHome, legacyDoubleChance], noRec);
    expect(ranked).toEqual([legacyAhHome, legacyDoubleChance]);
  });

  it("is a no-op when only recommendedFamily is set (recommendedSide null)", () => {
    const familyOnly: PatternReport = { ...strongPattern, recommendedSide: null };
    const ranked = applyLegacyPatternRanking([legacyAhHome], familyOnly);
    expect(ranked[0]?.rankingScore).toBe(0.05); // unchanged
  });

  it("is a no-op when only recommendedSide is set (recommendedFamily null)", () => {
    const sideOnly: PatternReport = { ...strongPattern, recommendedFamily: null };
    const ranked = applyLegacyPatternRanking([legacyAhHome], sideOnly);
    expect(ranked[0]?.rankingScore).toBe(0.05); // unchanged
  });
});

describe("runBatch — legacy pricer pattern-aware ranking (Phase 2A integration)", () => {
  // NOTE on scope (discovered writing this test — documented, not papered
  // over): deterministicDecide (decision/index.ts), the no-LLM-available
  // fallback this test's config exercises (no claudeApiKey/geminiApiKey, no
  // DecisionContext), does its OWN independent `sort((a,b) => b.ev - a.ev)`
  // over whatever `eligible` it receives — it does NOT respect incoming
  // array order/rankingScore. That function is decision/index.ts's
  // pre-existing, general-purpose logic (used by every decision path in the
  // engine, not legacy-pricer-specific) and is OUTSIDE Phase 2A's stated
  // scope (the plan names execution/index.ts, not decision/index.ts). So
  // the ranking boost's real, honest effect is on eligibleBets' ORDER
  // itself — visible to the LLM briefing's "top eligible bet" framing
  // (batch/index.ts's eligible[0] read) and runSwarm's input ordering when
  // an LLM tier IS active — not on deterministicDecide's own ev-based
  // choice when it fires. Asserting on eligibleBets[0] (not
  // decision.primaryPick) is the honest, correct test of what this phase
  // actually changed.
  it("v62Patterns='on': a strong pattern re-ranks eligibleBets so the pattern-backed +EV candidate sorts first, overcoming a higher raw rankingScore competitor", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(
      legacyRunResultWith([legacyDoubleChance, legacyAhHome])
    );
    const job = makeJob({ telemetry: heavySuperiorTelemetry });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, v62Patterns: "on" },
    });
    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.status).toBe("ok");
    expect(success.eligibleBets?.[0]?.side).toBe("Home -1.5");
  });

  it("v62Patterns='shadow' (default): computes the pattern report but never reorders eligibleBets — array order stays exactly as ExecutionEngine produced it", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(
      legacyRunResultWith([legacyDoubleChance, legacyAhHome])
    );
    const job = makeJob({ telemetry: heavySuperiorTelemetry });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, v62Patterns: "shadow" },
    });
    const success = result.jobs[0] as FixtureJobSuccess;
    // Unreordered — legacyDoubleChance stays first, exactly the input order,
    // proving shadow mode computed-but-never-applied (not merely "happened
    // to still win deterministicDecide's own separate ev-based pick").
    expect(success.eligibleBets?.[0]?.side).toBe("Home or Draw");
    expect(success.decision.primaryPick.side).toBe("Home or Draw");
  });

  it("v62Patterns='off': byte-identical to the flag not existing — same unreordered eligibleBets as shadow mode", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(
      legacyRunResultWith([legacyDoubleChance, legacyAhHome])
    );
    const job = makeJob({ telemetry: heavySuperiorTelemetry });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, v62Patterns: "off" },
    });
    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.eligibleBets?.[0]?.side).toBe("Home or Draw");
    expect(success.decision.primaryPick.side).toBe("Home or Draw");
  });

  it("v62Patterns undefined (absent from config): defaults to off-like behavior — same unreordered eligibleBets as shadow/off", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(
      legacyRunResultWith([legacyDoubleChance, legacyAhHome])
    );
    const job = makeJob({ telemetry: heavySuperiorTelemetry });
    const result = await runBatch([job], { storage, config: baseConfig });
    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.eligibleBets?.[0]?.side).toBe("Home or Draw");
    expect(success.decision.primaryPick.side).toBe("Home or Draw");
  });

  it("HARD INVARIANT: a strong-pattern-backed but negative-EV legacy candidate is never promoted into eligibleBets/primaryPick, even with v62Patterns='on'", async () => {
    const negativeEvAhHome: EVMarket = { ...legacyAhHome, ev: -0.03, rawEdge: -0.02 };
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(
      legacyRunResultWith([legacyDoubleChance, negativeEvAhHome])
    );
    const job = makeJob({ telemetry: heavySuperiorTelemetry });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, v62Patterns: "on" },
    });
    const success = result.jobs[0] as FixtureJobSuccess;
    // The -EV pattern-backed candidate never even enters eligibleBets
    // (buildEligibleBets' ev>0 floor, unaffected by ranking) — the genuinely
    // +EV Double Chance candidate wins by default, not the pattern match.
    expect(success.eligibleBets?.some((m) => m.side === "Home -1.5")).toBe(false);
    expect(success.decision.primaryPick.side).toBe("Home or Draw");
  });

  it("does not crash and simply skips pattern-ranking when telemetry lacks the required venue-split fields, even with v62Patterns='on'", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(
      legacyRunResultWith([legacyDoubleChance, legacyAhHome])
    );
    const job = makeJob({ telemetry: {} }); // no venue-split data at all
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, v62Patterns: "on" },
    });
    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.status).toBe("ok");
    // No pattern computed (buildLegacyPatternInput returned null) — falls
    // through to the unmodified legacy ranking, same as shadow/off.
    expect(success.eligibleBets?.[0]?.side).toBe("Home or Draw");
    expect(success.decision.primaryPick.side).toBe("Home or Draw");
  });

  // Structural invariant, pinned (test-coverage review finding, 2026-07-20):
  // when v3 actually produces a gate-surviving result for this fixture,
  // batch/index.ts REPLACES `eligible` with v3's own staked candidates
  // (line ~1055) — AFTER the legacy pattern reorder already ran on the
  // now-discarded legacy `eligible`. The v62Patterns boost must never leak
  // into a v3-live delivered pick. Every other test in this file mocks v3
  // as dry (returns null); this is the one test that mocks a REAL v3
  // result to prove the two paths stay genuinely decoupled.
  it("v3 IS live for this fixture: the legacy pattern-ranking boost never leaks into the v3-sourced eligibleBets/primaryPick, even with v62Patterns='on'", async () => {
    vi.spyOn(ExecutionEngine, "run").mockResolvedValueOnce(
      legacyRunResultWith([legacyDoubleChance, legacyAhHome])
    );
    analyzeFixtureMarketsV3Mock.mockReturnValueOnce({
      lambdas: {},
      split: {},
      fhShare: 0.44,
      fhShareIsDefault: true,
      coverage: { total: 1, routed: 1, byEngine: {}, skipped: {} },
      assessments: [
        {
          family: "match_result",
          marketId: "m1",
          marketName: "1X2",
          outcomeId: "o1",
          desc: "Home",
          odds: 2.5,
          mp: 0.55,
          q: 0.4,
          devigged: true,
          rawEdge: 0.15,
          penaltyPts: 0,
          adjustedEdge: 0.15,
          adjEvPct: 0.375,
          ev: 0.375,
          cls: "M",
          outcome: "done",
          confidence: "high",
        },
      ],
      capped: [],
      evMarkets: [],
      best: null,
    });
    // buildV3Input short-circuits to null (v3 never called) without a
    // non-empty allMarkets catalogue on the fixture — see
    // marketsV3BatchIntegration.test.ts's identical convention.
    const v3AllMarkets: AllMarketEntry[] = [
      {
        id: "1",
        name: "1X2",
        outcomes: [
          { id: "o1", desc: "Home", odds: "2.5" },
          { id: "o2", desc: "Draw", odds: "3.4" },
          { id: "o3", desc: "Away", odds: "2.8" },
        ],
      },
    ];
    const job = makeJob({
      telemetry: heavySuperiorTelemetry,
      pipeline: { fetched: { sportyBetOdds: { allMarkets: v3AllMarkets } } },
    });
    const result = await runBatch([job], {
      storage,
      config: { ...baseConfig, enableMarketsV3: "on", v62Patterns: "on" },
    });
    const success = result.jobs[0] as FixtureJobSuccess;
    expect(success.status).toBe("ok");
    expect(analyzeFixtureMarketsV3Mock).toHaveBeenCalled();
    // The delivered pick is v3's "Home" (match_result), NOT the legacy
    // "Home -1.5" the pattern boost would have promoted on the legacy path.
    expect(success.eligibleBets?.[0]?.side).toBe("Home");
    expect(success.eligibleBets?.some((m) => m.side === "Home -1.5")).toBe(false);
  });
});
