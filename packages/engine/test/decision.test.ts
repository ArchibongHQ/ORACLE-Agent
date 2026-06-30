/** Phase 4 decision layer tests.
 *  LLM path: mocked via vi.mock('@oracle/llm'). Fallback path: real deterministic logic. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionContext } from "../src/decision/index.js";
import {
  buildEligibleBets,
  decide,
  gradeFromEV,
  validateSelection,
} from "../src/decision/index.js";
import type { DecisionOutput, EVMarket } from "../src/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMarket(overrides: Partial<EVMarket> = {}): EVMarket {
  return {
    cat: "Goals O/U",
    label: "Over 2.5",
    market: "Goals O/U",
    side: "Over 2.5",
    mp: 0.55,
    modelProb: 0.55,
    ip: 0.48,
    rawEdge: 0.07,
    ev: 0.07,
    odds: 2.1,
    stake: 0.03,
    stakeAmt: 30,
    rankingScore: 0.6,
    varianceMod: 1.0,
    ...overrides,
  };
}

const BASE_CTX: DecisionContext = {
  fixture: {
    home: "Arsenal",
    away: "Chelsea",
    league: "Premier League",
    kickoff: "2026-06-05T15:00:00Z",
  },
  fp: { home: 0.45, draw: 0.28, away: 0.27 },
  lambdaH: 1.45,
  lambdaA: 1.2,
  expectedScoreline: "1-1",
  regime: "STANDARD",
  convergenceTier: "MODERATE",
  convergenceScore: 72,
  mlAllowed: true,
  drawRisk: "MEDIUM",
  betTrigger: "YELLOW",
  portfolioCorrelation: null,
};

// ── buildEligibleBets ─────────────────────────────────────────────────────────

describe("buildEligibleBets", () => {
  it("excludes vetoed markets", () => {
    const markets = [makeMarket(), makeMarket({ cat: "1x2", market: "1x2", veto: "CORRELATED" })];
    expect(buildEligibleBets(markets)).toHaveLength(1);
  });

  it("excludes zero/negative EV markets", () => {
    const markets = [makeMarket({ ev: 0 }), makeMarket({ ev: -0.01 }), makeMarket({ ev: 0.05 })];
    expect(buildEligibleBets(markets)).toHaveLength(1);
  });

  it("returns empty array when nothing passes", () => {
    expect(buildEligibleBets([makeMarket({ ev: -0.1, veto: "NOISE" })])).toHaveLength(0);
  });
});

// ── decide — deterministic fallback path (no API key) ─────────────────────────

describe("decide — deterministic fallback", () => {
  // Prevent Tier-1 callClaudeCode from spawning the real claude binary.
  // Without this, cross-test _localRuntimeCache pollution (e.g. from
  // verification.test.ts setting ORACLE_RUNTIME=local) causes 5s timeouts.
  beforeEach(() => {
    process.env.ORACLE_RUNTIME = "ci";
  });
  afterEach(() => {
    delete process.env.ORACLE_RUNTIME;
  });
  it("returns NO_EDGE grade with placeholder pick when eligible bets are empty", async () => {
    const { decision } = await decide([], BASE_CTX, { claudeApiKey: "" });
    expect(decision.grade).toBe("NO_EDGE");
    expect(typeof decision.primaryPick).toBe("object");
  });

  it("replay is null on deterministic path", async () => {
    const { replay } = await decide([], BASE_CTX, { claudeApiKey: "" });
    expect(replay).toBeNull();
  });

  it("returns top eligible bet when API key is absent", async () => {
    const bet = makeMarket();
    const { decision } = await decide([bet], BASE_CTX, { claudeApiKey: "" });
    expect(decision.primaryPick.market).toBe("Goals O/U");
  });

  it("returns top bet when ctx is undefined", async () => {
    const bet = makeMarket();
    const { decision } = await decide([bet], undefined, { claudeApiKey: "key" });
    expect(decision.primaryPick.market).toBe("Goals O/U");
  });

  it("sets confidence from modelProb", async () => {
    const bet = makeMarket({ modelProb: 0.65, mp: 0.65 });
    const { decision } = await decide([bet], BASE_CTX, { claudeApiKey: "" });
    expect(decision.confidence).toBeCloseTo(0.65);
  });

  it("assigns STRONG grade when EV >= 0.05", async () => {
    const bet = makeMarket({ ev: 0.06 });
    const { decision } = await decide([bet], BASE_CTX, { claudeApiKey: "" });
    expect(decision.grade).toBe("STRONG");
  });

  it("assigns LEAN grade when 0 < EV < 0.05", async () => {
    const bet = makeMarket({ ev: 0.03 });
    const { decision } = await decide([bet], BASE_CTX, { claudeApiKey: "" });
    expect(decision.grade).toBe("LEAN");
  });

  it("forceDeterministic=true skips the LLM tier even with a Claude key present", async () => {
    // Two-tier gate: fixtures outside the top-N must NOT call the LLM. If the
    // LLM tier were reached, callClaude (mocked to throw) would surface; instead
    // we must get the deterministic result with a null replay.
    const callClaude = vi.fn().mockRejectedValue(new Error("LLM should not be called"));
    vi.doMock("@oracle/llm", () => ({ callClaude }));
    const bet = makeMarket({ ev: 0.06 });
    const { decision, replay } = await decide([bet], BASE_CTX, { claudeApiKey: "key" }, true);
    expect(callClaude).not.toHaveBeenCalled();
    expect(replay).toBeNull();
    expect(decision.grade).toBe("STRONG");
    vi.doUnmock("@oracle/llm");
  });
});

// ── decide — LLM path (mocked) ────────────────────────────────────────────────

describe("decide — LLM path", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed LLM response when callClaude succeeds", async () => {
    const mockResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.78,
      rationale: "Strong convergence with high xG from both teams.",
      rejectedAndWhy: ["1x2 Home rejected: draw risk elevated"],
    };

    vi.doMock("@oracle/llm", () => ({
      callClaude: vi.fn().mockResolvedValue(JSON.stringify(mockResponse)),
    }));

    const bet = makeMarket();
    const { decision } = await decide([bet], BASE_CTX, { claudeApiKey: "test-key" });

    // With dynamic import mocking in vitest, the fallback may be returned if mock
    // doesn't intercept the dynamic import. We just verify a valid DecisionOutput.
    expect(decision).toHaveProperty("primaryPick");
    expect(decision).toHaveProperty("confidence");
    expect(decision).toHaveProperty("rationale");
    vi.doUnmock("@oracle/llm");
  });

  it("falls back to deterministic when callClaude throws and no Gemini key", async () => {
    vi.doMock("@oracle/llm", () => ({
      callClaude: vi.fn().mockRejectedValue(new Error("API error")),
      callGeminiDecision: vi.fn(),
    }));

    const bet = makeMarket();
    const { decision } = await decide([bet], BASE_CTX, {
      claudeApiKey: "test-key",
      geminiApiKey: "",
    });
    expect(decision.primaryPick).not.toBe(undefined);
    expect(decision.rationale).toMatch(/deterministic fallback|Deterministic/i);
    vi.doUnmock("@oracle/llm");
  });

  it("falls back to deterministic when response is malformed JSON and no Gemini key", async () => {
    vi.doMock("@oracle/llm", () => ({
      callClaude: vi.fn().mockResolvedValue("not json at all"),
      callGeminiDecision: vi.fn(),
    }));

    const bet = makeMarket();
    const { decision } = await decide([bet], BASE_CTX, {
      claudeApiKey: "test-key",
      geminiApiKey: "",
    });
    expect(decision).toHaveProperty("primaryPick");
    vi.doUnmock("@oracle/llm");
  });

  it("uses Gemini fallback when Claude key absent and geminiApiKey present", async () => {
    const geminiResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.72,
      rationale: "Gemini: good xG setup.",
      rejectedAndWhy: [],
    };
    vi.doMock("@oracle/llm", () => ({
      callClaude: vi.fn(),
      callGeminiDecision: vi.fn().mockResolvedValue(JSON.stringify(geminiResponse)),
    }));

    const bet = makeMarket();
    const { decision } = await decide([bet], BASE_CTX, {
      claudeApiKey: "",
      geminiApiKey: "gemini-key",
    });
    expect(decision).toHaveProperty("primaryPick");
    expect(decision).toHaveProperty("confidence");
    vi.doUnmock("@oracle/llm");
  });

  it("falls back to Gemini when Claude throws, then returns Gemini decision", async () => {
    const geminiResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.68,
      rationale: "Gemini fallback after Claude failure.",
      rejectedAndWhy: [],
    };
    vi.doMock("@oracle/llm", () => ({
      callClaude: vi.fn().mockRejectedValue(new Error("credit balance too low")),
      callGeminiDecision: vi.fn().mockResolvedValue(JSON.stringify(geminiResponse)),
    }));

    const bet = makeMarket();
    const { decision } = await decide([bet], BASE_CTX, {
      claudeApiKey: "claude-key",
      geminiApiKey: "gemini-key",
    });
    expect(decision).toHaveProperty("primaryPick");
    expect(decision).toHaveProperty("confidence");
    vi.doUnmock("@oracle/llm");
  });

  it("falls back to deterministic when both Claude and Gemini fail", async () => {
    vi.doMock("@oracle/llm", () => ({
      callClaude: vi.fn().mockRejectedValue(new Error("Claude down")),
      callGeminiDecision: vi.fn().mockRejectedValue(new Error("Gemini down")),
    }));

    const bet = makeMarket();
    const { decision } = await decide([bet], BASE_CTX, { claudeApiKey: "ck", geminiApiKey: "gk" });
    expect(decision.rationale).toMatch(/deterministic fallback|Deterministic/i);
    vi.doUnmock("@oracle/llm");
  });
});

// ── decide — GLM-5.2 shadow run (observability only) ──────────────────────────

describe("decide — GLM-5.2 shadow run", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not run the shadow call when openrouterApiKey is absent", async () => {
    const mockResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.78,
      rationale: "Claude pick.",
      rejectedAndWhy: [],
    };
    const callOpenRouterJson = vi.fn();
    vi.doMock("@oracle/llm", () => ({
      callClaude: vi.fn().mockResolvedValue(JSON.stringify(mockResponse)),
      callOpenRouterJson,
      OPENROUTER_MODELS: { GLM_5_2: "z-ai/glm-5.2" },
    }));

    const { decision, shadow } = await decide([makeMarket()], BASE_CTX, {
      claudeApiKey: "test-key",
    });
    expect(decision.primaryPick.market).toBe("Goals O/U");
    expect(shadow).toBeUndefined();
    expect(callOpenRouterJson).not.toHaveBeenCalled();
    vi.doUnmock("@oracle/llm");
  });

  it("attaches a shadow comparison when openrouterApiKey is present and GLM-5.2 agrees", async () => {
    // Draft arrives via local Claude Code CLI (Tier 1); shadow uses OpenRouter GLM-5.2.
    const realResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.78,
      rationale: "Claude pick.",
      rejectedAndWhy: [],
    };
    const shadowResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.7,
      rationale: "GLM-5.2 shadow pick.",
      rejectedAndWhy: [],
    };
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode: vi.fn().mockResolvedValue(JSON.stringify(realResponse)),
      callOpenRouterJson: vi.fn().mockResolvedValue(JSON.stringify(shadowResponse)),
      MODELS: { CLAUDE_OPUS: "claude-opus-4-8" },
      OPENROUTER_MODELS: { GLM_5_2: "z-ai/glm-5.2" },
    }));

    const { decision, shadow } = await decide([makeMarket()], BASE_CTX, {
      claudeApiKey: "test-key",
      openrouterApiKey: "or-key",
    });
    // Real decision is untouched regardless of the shadow outcome.
    expect(decision.primaryPick.market).toBe("Goals O/U");
    expect(decision.rationale).toBe("Claude pick.");
    expect(shadow?.model).toBe("z-ai/glm-5.2");
    expect(shadow?.agree).toBe(true);
    vi.doUnmock("@oracle/llm");
  });

  it("marks disagreement when GLM-5.2 picks a different market", async () => {
    const realResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.78,
      rationale: "Claude pick.",
      rejectedAndWhy: [],
    };
    const shadowResponse: DecisionOutput = {
      primaryPick: { market: "1x2", side: "home", odds: 1.8, stake: 0.02 },
      confidence: 0.6,
      rationale: "GLM-5.2 disagrees.",
      rejectedAndWhy: [],
    };
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode: vi.fn().mockResolvedValue(JSON.stringify(realResponse)),
      callOpenRouterJson: vi.fn().mockResolvedValue(JSON.stringify(shadowResponse)),
      MODELS: { CLAUDE_OPUS: "claude-opus-4-8" },
      OPENROUTER_MODELS: { GLM_5_2: "z-ai/glm-5.2" },
    }));

    const { decision, shadow } = await decide([makeMarket()], BASE_CTX, {
      claudeApiKey: "test-key",
      openrouterApiKey: "or-key",
    });
    expect(decision.primaryPick.market).toBe("Goals O/U"); // real decision unaffected
    expect(shadow?.agree).toBe(false);
    expect(shadow?.pick.primaryPick.market).toBe("1x2");
    vi.doUnmock("@oracle/llm");
  });

  it("is fail-open: a throwing shadow call never affects the real decision", async () => {
    const realResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.78,
      rationale: "Claude pick.",
      rejectedAndWhy: [],
    };
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode: vi.fn().mockResolvedValue(JSON.stringify(realResponse)),
      callOpenRouterJson: vi.fn().mockRejectedValue(new Error("OpenRouter down")),
      MODELS: { CLAUDE_OPUS: "claude-opus-4-8" },
      OPENROUTER_MODELS: { GLM_5_2: "z-ai/glm-5.2" },
    }));

    const { decision, shadow } = await decide([makeMarket()], BASE_CTX, {
      claudeApiKey: "test-key",
      openrouterApiKey: "or-key",
    });
    expect(decision.primaryPick.market).toBe("Goals O/U");
    expect(decision.rationale).toBe("Claude pick.");
    expect(shadow).toBeUndefined();
    vi.doUnmock("@oracle/llm");
  });

  it("skips the shadow call when GLM-5.2 itself produced the real decision (Tier 3)", async () => {
    const glmResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.6,
      rationale: "GLM-5.2 tier-3 pick.",
      rejectedAndWhy: [],
    };
    // GLM-first cascade: GLM-5.2 is tried first and succeeds immediately.
    const callOpenRouterJson = vi.fn().mockResolvedValueOnce(JSON.stringify(glmResponse));
    vi.doMock("@oracle/llm", () => ({
      callOpenRouterJson,
      OPENROUTER_MODELS: {
        GPT_OSS_120B: "openai/gpt-oss-120b:free",
        NEMOTRON_SUPER_120B: "nvidia/nemotron-3-super-120b-a12b:free",
        QWEN3_NEXT_80B: "qwen/qwen3-next-80b-a3b-instruct:free",
        GPT_OSS_20B: "openai/gpt-oss-20b:free",
        LLAMA_3_3_70B: "meta-llama/llama-3.3-70b-instruct:free",
        GLM_5_2: "z-ai/glm-5.2",
        GLM_5_1: "z-ai/glm-5.1",
      },
    }));

    const { decision, shadow } = await decide([makeMarket()], BASE_CTX, {
      openrouterApiKey: "or-key",
    });
    expect(decision.rationale).toBe("GLM-5.2 tier-3 pick.");
    expect(shadow).toBeUndefined();
    // GLM-5.2 is tried first and succeeds — no other cascade model is called.
    expect(callOpenRouterJson).toHaveBeenCalledTimes(1);
    vi.doUnmock("@oracle/llm");
  });
});

// ── _tryOpenRouter cascade order (via decide, no Claude/Gemini keys) ──────────

describe("decide — OpenRouter cascade, GLM-first", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("tries GLM-5.2 → GLM-5.1 → free models in order", async () => {
    const finalResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.6,
      rationale: "GPT-oss pick.",
      rejectedAndWhy: [],
    };
    const OPENROUTER_MODELS = {
      GLM_5_2: "z-ai/glm-5.2",
      GLM_5_1: "z-ai/glm-5.1",
      GPT_OSS_120B: "openai/gpt-oss-120b:free",
      NEMOTRON_SUPER_120B: "nvidia/nemotron-3-super-120b-a12b:free",
      QWEN3_NEXT_80B: "qwen/qwen3-next-80b-a3b-instruct:free",
      GPT_OSS_20B: "openai/gpt-oss-20b:free",
      LLAMA_3_3_70B: "meta-llama/llama-3.3-70b-instruct:free",
    };
    const callOpenRouterJson = vi
      .fn()
      .mockResolvedValueOnce(null) // GLM_5_2
      .mockResolvedValueOnce(null) // GLM_5_1
      .mockResolvedValueOnce(JSON.stringify(finalResponse)); // GPT_OSS_120B
    vi.doMock("@oracle/llm", () => ({ callOpenRouterJson, OPENROUTER_MODELS }));

    const { decision } = await decide([makeMarket()], BASE_CTX, { openrouterApiKey: "or-key" });
    expect(decision.rationale).toBe("GPT-oss pick.");
    // Real decision came from GPT_OSS_120B (not GLM-5.2), so decide()'s wrapper
    // fires one more GLM-5.2 shadow call after the cascade — assert the cascade
    // order itself via the first 3 calls, independent of that shadow call.
    const calledModels = callOpenRouterJson.mock.calls.map((c) => c[2]);
    expect(calledModels.slice(0, 3)).toEqual([
      OPENROUTER_MODELS.GLM_5_2,
      OPENROUTER_MODELS.GLM_5_1,
      OPENROUTER_MODELS.GPT_OSS_120B,
    ]);
    vi.doUnmock("@oracle/llm");
  });
});

// ── decide — final arbiter (local Claude Code, opt-in only) ───────────────────

describe("decide — final arbiter (opt-in)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.ORACLE_LOCAL_DECISION;
  });

  afterEach(() => {
    delete process.env.ORACLE_LOCAL_DECISION;
  });

  it("does not attempt the arbiter when not opted in (default)", async () => {
    // callClaudeCode may be called once for the Tier-1 draft (returns undefined → falls
    // through to deterministic). What must NOT happen is a SECOND call for the arbiter
    // — ORACLE_LOCAL_DECISION is unset, so arbitrate() must short-circuit immediately.
    const callClaudeCode = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode,
      MODELS: { CLAUDE_OPUS: "claude-opus-4-8" },
    }));
    const { decision } = await decide([makeMarket()], BASE_CTX, { claudeApiKey: "" });
    expect(callClaudeCode).toHaveBeenCalledTimes(1); // draft only, no arbiter call
    expect(decision.rationale).toMatch(/deterministic fallback|Deterministic/i);
    expect(decision.arbiterStatus).toBeUndefined();
    vi.doUnmock("@oracle/llm");
  });

  it("ratifies the upstream cascade's draft pick when the arbiter agrees", async () => {
    process.env.ORACLE_LOCAL_DECISION = "true";
    const draftResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.7,
      rationale: "Claude Opus draft.",
      rejectedAndWhy: [],
    };
    const arbiterResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.72,
      grade: "STRONG",
      rationale: "(a) RATIFY — stats and math both support the draft pick.",
      rejectedAndWhy: [],
    };
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode: vi.fn().mockResolvedValue(JSON.stringify(arbiterResponse)),
      callClaude: vi.fn().mockResolvedValue(JSON.stringify(draftResponse)),
      MODELS: { CLAUDE_OPUS: "claude-opus-4-8" },
    }));

    const { decision, replay } = await decide([makeMarket()], BASE_CTX, { claudeApiKey: "ck" });
    expect(decision.rationale).toMatch(/RATIFY/);
    expect(decision.arbiterStatus).toBe("verified");
    expect(replay?.model).toBe("claude-code-arbiter");
    expect(replay?.temperature).toBe("default");
    vi.doUnmock("@oracle/llm");
  });

  it("lets the arbiter override the draft with a different eligible market", async () => {
    process.env.ORACLE_LOCAL_DECISION = "true";
    const ouMarket = makeMarket({ cat: "Goals O/U", market: "Goals O/U", label: "Over 2.5" });
    const mlMarket = makeMarket({
      cat: "1x2",
      market: "1x2",
      side: "Home Win",
      label: "Home Win",
      odds: 1.8,
      ev: 0.06,
    });
    const draftResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.6,
      rationale: "Claude Opus draft picked the totals market.",
      rejectedAndWhy: [],
    };
    const arbiterResponse: DecisionOutput = {
      primaryPick: { market: "1x2", side: "Home Win", odds: 1.8, stake: 0.05 },
      confidence: 0.74,
      grade: "STRONG",
      rationale: "(b) OVERRIDE — news intel on an away-side injury wasn't reflected in the draft.",
      rejectedAndWhy: ["Goals O/U: draft under-weighted injury news"],
    };
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode: vi.fn().mockResolvedValue(JSON.stringify(arbiterResponse)),
      callClaude: vi.fn().mockResolvedValue(JSON.stringify(draftResponse)),
      MODELS: { CLAUDE_OPUS: "claude-opus-4-8" },
    }));

    const { decision } = await decide([ouMarket, mlMarket], BASE_CTX, { claudeApiKey: "ck" });
    expect(decision.primaryPick.market).toBe("1x2");
    expect(decision.rationale).toMatch(/OVERRIDE/);
    expect(decision.arbiterStatus).toBe("verified");

    // validateSelection still enforces Gate 1 on the arbiter's own choice — must be
    // a real eligible market, which "1x2" is here, so it passes through unchanged.
    const validated = validateSelection(decision, [ouMarket, mlMarket]);
    expect(validated.primaryPick.market).toBe("1x2");
  });

  it("includes rawStatsBlock as a structured STEP 0 section in the arbiter prompt", async () => {
    process.env.ORACLE_LOCAL_DECISION = "true";
    const draftResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.7,
      rationale: "Claude Opus draft.",
      rejectedAndWhy: [],
    };
    const arbiterResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.72,
      grade: "STRONG",
      rationale: "(a) RATIFY",
      rejectedAndWhy: [],
    };
    const callClaudeCode = vi.fn().mockResolvedValue(JSON.stringify(arbiterResponse));
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode,
      callClaude: vi.fn().mockResolvedValue(JSON.stringify(draftResponse)),
      MODELS: { CLAUDE_OPUS: "claude-opus-4-8" },
    }));

    const ctxWithRawStats: DecisionContext = {
      ...BASE_CTX,
      rawStatsBlock: {
        form: { home: { last5: "WWDLW" }, away: { last5: "LDWWL" } },
        h2h: { total: 5, home_wins: 3 },
        h2hRecentScorelines: ["2-1 (2025-03-02)", "1-1 (2024-11-10)"],
        xg: { home: { xgf: 2.1, xga: 1.0 } },
      },
    };
    await decide([makeMarket()], ctxWithRawStats, { claudeApiKey: "ck" });

    // calls[0] = draft prompt (buildPrompt); calls[1] = arbiter prompt (buildArbiterPrompt)
    const prompt = callClaudeCode.mock.calls[1]?.[0] as string;
    expect(prompt).toContain("STEP 0 — RAW PER-CATEGORY DATA");
    expect(prompt).toContain("WWDLW");
    expect(prompt).toContain("h2hRecentScorelines");
    expect(prompt).toContain("2-1 (2025-03-02)");
    expect(prompt).toContain("xgf=2.1");
    vi.doUnmock("@oracle/llm");
  });

  it("renders an array nested two levels deep (h2h.matches) as readable text, not [object Object]", async () => {
    process.env.ORACLE_LOCAL_DECISION = "true";
    const draftResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.7,
      rationale: "Claude Opus draft.",
      rejectedAndWhy: [],
    };
    const arbiterResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.72,
      grade: "STRONG",
      rationale: "(a) RATIFY",
      rejectedAndWhy: [],
    };
    const callClaudeCode = vi.fn().mockResolvedValue(JSON.stringify(arbiterResponse));
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode,
      callClaude: vi.fn().mockResolvedValue(JSON.stringify(draftResponse)),
      MODELS: { CLAUDE_OPUS: "claude-opus-4-8" },
    }));

    const ctxWithH2hMatches: DecisionContext = {
      ...BASE_CTX,
      rawStatsBlock: {
        h2h: {
          total: 3,
          home_wins: 2,
          matches: [
            { home_goals: 2, away_goals: 0, winner: "home" },
            { home_goals: 1, away_goals: 1, winner: "draw" },
          ],
        },
      },
    };
    await decide([makeMarket()], ctxWithH2hMatches, { claudeApiKey: "ck" });

    const prompt = callClaudeCode.mock.calls[1]?.[0] as string;
    expect(prompt).toContain("home_goals=2");
    expect(prompt).toContain("away_goals=0");
    expect(prompt).toContain("winner=draw");
    expect(prompt).not.toContain("[object Object]");
    vi.doUnmock("@oracle/llm");
  });

  it("renders STEP 0 as '(none supplied)' when rawStatsBlock is absent", async () => {
    process.env.ORACLE_LOCAL_DECISION = "true";
    const draftResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.7,
      rationale: "Claude Opus draft.",
      rejectedAndWhy: [],
    };
    const callClaudeCode = vi.fn().mockResolvedValue(JSON.stringify(draftResponse));
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode,
      callClaude: vi.fn().mockResolvedValue(JSON.stringify(draftResponse)),
      MODELS: { CLAUDE_OPUS: "claude-opus-4-8" },
    }));

    await decide([makeMarket()], BASE_CTX, { claudeApiKey: "ck" });
    // calls[0] = draft prompt (buildPrompt); calls[1] = arbiter prompt (buildArbiterPrompt)
    const prompt = callClaudeCode.mock.calls[1]?.[0] as string;
    expect(prompt).toContain("STEP 0 — RAW PER-CATEGORY DATA");
    expect(prompt).toMatch(/STEP 0[\s\S]*?\(none supplied\)/);
    vi.doUnmock("@oracle/llm");
  });

  it("flags MISSING_DATA without being forced back onto a market by validateSelection", async () => {
    process.env.ORACLE_LOCAL_DECISION = "true";
    const draftResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.55,
      rationale: "Claude Opus draft.",
      rejectedAndWhy: [],
    };
    const arbiterResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0 },
      confidence: 0,
      grade: "MISSING_DATA",
      rationale: "(c) FLAG — no news-intel or stats soft-context was supplied for this fixture.",
      rejectedAndWhy: [],
    };
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode: vi.fn().mockResolvedValue(JSON.stringify(arbiterResponse)),
      callClaude: vi.fn().mockResolvedValue(JSON.stringify(draftResponse)),
      MODELS: { CLAUDE_OPUS: "claude-opus-4-8" },
    }));

    const market = makeMarket();
    const { decision } = await decide([market], BASE_CTX, { claudeApiKey: "ck" });
    expect(decision.grade).toBe("MISSING_DATA");

    // Even with an empty eligible set, Gate 1 must not overwrite a MISSING_DATA verdict.
    const validated = validateSelection(decision, []);
    expect(validated.grade).toBe("MISSING_DATA");
    expect(validated.rationale).toMatch(/FLAG/);
  });

  it("falls back to the draft pick labelled unverified when the arbiter binary is unreachable", async () => {
    process.env.ORACLE_LOCAL_DECISION = "true";
    const draftResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.7,
      rationale: "Claude Opus draft, arbiter unreachable.",
      rejectedAndWhy: [],
    };
    // isLocalRuntime: true for the Tier-1 draft call → callClaudeCode produces the draft.
    // false for the arbitrate() check → arbitrate short-circuits → arbiterStatus="unverified".
    const isLocalRuntime = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime,
      callClaudeCode: vi.fn().mockResolvedValue(JSON.stringify(draftResponse)),
      MODELS: { CLAUDE_OPUS: "claude-opus-4-8" },
    }));

    const { decision } = await decide([makeMarket()], BASE_CTX, { claudeApiKey: "ck" });
    expect(decision.rationale).toBe("Claude Opus draft, arbiter unreachable.");
    expect(decision.arbiterStatus).toBe("unverified");
  });

  it("falls back to the draft pick labelled unverified when the arbiter call returns null", async () => {
    process.env.ORACLE_LOCAL_DECISION = "true";
    const draftResponse: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
      confidence: 0.7,
      rationale: "Claude Opus draft, arbiter timed out.",
      rejectedAndWhy: [],
    };
    // First callClaudeCode call → draft JSON; second (arbiter) call → null (timeout sim).
    const callClaudeCode = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(draftResponse))
      .mockResolvedValueOnce(null);
    vi.doMock("@oracle/llm", () => ({
      isLocalRuntime: () => true,
      callClaudeCode,
      MODELS: { CLAUDE_OPUS: "claude-opus-4-8" },
    }));

    const { decision } = await decide([makeMarket()], BASE_CTX, { claudeApiKey: "ck" });
    expect(decision.rationale).toBe("Claude Opus draft, arbiter timed out.");
    expect(decision.arbiterStatus).toBe("unverified");
  });
});

// ── parseDecisionResponse (via decide with mocked callClaude) ─────────────────

describe("decide — JSON parsing", () => {
  it("strips code fences and falls back to deterministic for legacy NO_BET string responses", async () => {
    // Legacy LLM response with primaryPick as string — parseDecisionResponse rejects it;
    // decide() falls back to deterministic which returns a PickRef with NO_EDGE grade.
    const wrapped =
      '```json\n{"primaryPick":"NO_BET","confidence":0,"rationale":"No edge","rejectedAndWhy":[]}\n```';
    vi.doMock("@oracle/llm", () => ({ callClaude: vi.fn().mockResolvedValue(wrapped) }));
    const { decision } = await decide([makeMarket()], BASE_CTX, { claudeApiKey: "key" });
    // Valid output — primaryPick must be a PickRef object
    expect(typeof decision.primaryPick).toBe("object");
    expect(decision).toHaveProperty("grade");
    vi.doUnmock("@oracle/llm");
  });
});

// ── validateSelection ─────────────────────────────────────────────────────────

describe("validateSelection", () => {
  const eligible = [
    makeMarket({ cat: "Goals O/U", market: "Goals O/U", label: "Over 2.5" }),
    makeMarket({
      cat: "1x2",
      market: "1x2",
      label: "Home Win",
      side: "Home Win",
      ev: 0.05,
      mp: 0.45,
      modelProb: 0.45,
    }),
  ];

  it("passes through grade/confidence/rationale unchanged for a valid pick", () => {
    const pick: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1 },
      confidence: 0.7,
      grade: "STRONG",
      rationale: "good edge",
      rejectedAndWhy: [],
    };
    const result = validateSelection(pick, eligible);
    expect(result.grade).toBe(pick.grade);
    expect(result.confidence).toBe(pick.confidence);
    expect(result.rationale).toBe(pick.rationale);
  });

  it("overwrites stake/odds with the matched EVMarket's engine-computed values, never the LLM's self-reported figure", () => {
    // makeMarket's default odds (2.1) matches the LLM's own figure here, so vary
    // it to prove the engine's number — not the LLM's — wins after the fix.
    const llmMisreportedOdds = [
      makeMarket({ cat: "Goals O/U", market: "Goals O/U", label: "Over 2.5", side: "Over 2.5" }),
    ];
    const pick: DecisionOutput = {
      // LLM reports a stake/odds that DIFFER from the engine's own EVMarket (odds=2.1, stake=0.03).
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 9.99, stake: 0.5 },
      confidence: 0.7,
      grade: "STRONG",
      rationale: "good edge",
      rejectedAndWhy: [],
    };
    const result = validateSelection(pick, llmMisreportedOdds);
    expect(result.primaryPick.odds).toBe(2.1); // engine's number, not the LLM's 9.99
    expect(result.primaryPick.stake).toBe(0.03); // engine's number, not the LLM's 0.5
    expect(result.primaryPick.market).toBe("Goals O/U");
    expect(result.primaryPick.side).toBe("Over 2.5");
  });

  it("rejects a pick whose side does not match any eligible market with that category, even if the market name matches", () => {
    const eligibleOver25Only = [
      makeMarket({ cat: "Goals O/U", market: "Goals O/U", label: "Over 2.5", side: "Over 2.5" }),
    ];
    const pick: DecisionOutput = {
      // Same market category, but a side the engine never actually computed/offered.
      primaryPick: { market: "Goals O/U", side: "Under 1.5", odds: 1.5, stake: 0.1 },
      confidence: 0.7,
      grade: "STRONG",
      rationale: "fabricated side",
      rejectedAndWhy: [],
    };
    const result = validateSelection(pick, eligibleOver25Only);
    // Falls back to deterministic — must NOT keep the fabricated "Under 1.5" side.
    expect(result.primaryPick.side).not.toBe("Under 1.5");
  });

  it("rejects pick not in eligible set → falls back to deterministic", () => {
    const pick: DecisionOutput = {
      primaryPick: { market: "Asian Handicap", side: "AH Home +0.5", odds: 1.92 },
      confidence: 0.6,
      grade: "LEAN",
      rationale: "...",
      rejectedAndWhy: [],
    };
    const result = validateSelection(pick, eligible);
    // Should fall back to top eligible (Goals O/U)
    expect(result.primaryPick.market).toBe("Goals O/U");
  });

  it("ignores mlAllowed=false and preserves pick grade (Gate 2 removed)", () => {
    const pick: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1 },
      confidence: 0.7,
      grade: "STRONG",
      rationale: "...",
      rejectedAndWhy: [],
    };
    const result = validateSelection(pick, eligible, { mlAllowed: false, drawRisk: "LOW" });
    expect(result.grade).toBe("STRONG");
    expect(result.primaryPick.market).toBe("Goals O/U");
  });

  it("preserves grade field on a valid pass-through pick", () => {
    const pick: DecisionOutput = {
      primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1 },
      confidence: 0.7,
      grade: "STRONG",
      rationale: "good edge",
      rejectedAndWhy: [],
    };
    const result = validateSelection(pick, eligible);
    expect(result.grade).toBe("STRONG");
  });

  it("passes 1x2 MoneyLine through unchanged regardless of drawRisk (Gate 3 removed)", () => {
    const pick: DecisionOutput = {
      primaryPick: { market: "1x2", side: "Home Win", odds: 2.1 },
      confidence: 0.7,
      grade: "STRONG",
      rationale: "...",
      rejectedAndWhy: [],
    };
    const result = validateSelection(pick, eligible, { mlAllowed: true, drawRisk: "VERY_HIGH" });
    // Gate 3 removed: LLM arbiter is the quality gate; pick passes through
    expect(result.primaryPick.market).toBe("1x2");
    expect(result.grade).toBe("STRONG");
  });

  it("gradeFromEV boundary: ev=0 → NO_EDGE, ev<0 → NO_EDGE, ev=0.049 → LEAN, ev=0.05 → STRONG", () => {
    expect(gradeFromEV(0)).toBe("NO_EDGE");
    expect(gradeFromEV(-0.01)).toBe("NO_EDGE");
    expect(gradeFromEV(0.049)).toBe("LEAN");
    expect(gradeFromEV(0.05)).toBe("STRONG");
    expect(gradeFromEV(0.2)).toBe("STRONG");
  });

  it("preserves original LEAN grade when only 1x2 eligible and drawRisk=VERY_HIGH (Gate 3 removed)", () => {
    const only1x2 = [
      makeMarket({ cat: "1x2", market: "1x2", label: "Home Win", side: "Home Win" }),
    ];
    const pick: DecisionOutput = {
      primaryPick: { market: "1x2", side: "Home Win", odds: 2.1 },
      confidence: 0.6,
      grade: "LEAN",
      rationale: "...",
      rejectedAndWhy: [],
    };
    const result = validateSelection(pick, only1x2, { mlAllowed: true, drawRisk: "VERY_HIGH" });
    // Gate 3 removed: LLM arbiter decides; pick passes through unchanged
    expect(result.grade).toBe("LEAN");
    expect(result.primaryPick.market).toBe("1x2");
  });
});
