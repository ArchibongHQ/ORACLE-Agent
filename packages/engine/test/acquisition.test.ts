/** Acquisition turn tests — T1/T2/T3 Gemini enrichment.
 *  Verifies: no-op when key absent, graceful fallback on error, telemetry merge. */

import { MemoryAdapter } from "@oracle/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionEngine } from "../src/execution/index.js";
import type { OracleConfig, RunState } from "../src/types.js";

const storage = new MemoryAdapter(`.tmp/acq-test-${Date.now().toString(36)}`);

function makeConfig(geminiApiKey = ""): OracleConfig {
  return { geminiApiKey, claudeApiKey: "", bankroll: 1000 };
}

const baseState: RunState = {
  telemetry: { hOdds: 2.0, dOdds: 3.4, aOdds: 4.0, piH: 1500, piA: 1500 },
  pipeline: {
    fixture: {
      home: "Arsenal",
      away: "Chelsea",
      league: "Premier League",
      date: "2026-06-10T15:00:00Z",
    },
  },
};

// ── No-op when key absent ─────────────────────────────────────────────────────

describe("acquisition — no geminiApiKey", () => {
  it("run completes without calling Gemini", async () => {
    const spy = vi.fn();
    vi.doMock("@oracle/llm", () => ({
      fetchGeminiWithCascade: spy,
      callClaude: vi.fn(),
      MODELS: {},
      THINKING_LEVELS: {},
      ACQUISITION_CASCADE: [],
    }));

    const result = await ExecutionEngine.run(baseState, { storage, config: makeConfig("") });

    expect(result.bayesian_lH).toBeGreaterThan(0);
    // Gemini should NOT have been called
    expect(spy).not.toHaveBeenCalled();
    vi.doUnmock("@oracle/llm");
  });
});

// ── No-op when fixture names absent ──────────────────────────────────────────

describe("acquisition — no fixture names", () => {
  it("skips acquisition without home/away", async () => {
    const spy = vi.fn();
    vi.doMock("@oracle/llm", () => ({
      fetchGeminiWithCascade: spy,
      callClaude: vi.fn(),
      MODELS: {},
      THINKING_LEVELS: {},
      ACQUISITION_CASCADE: [],
    }));

    const stateNoFixture: RunState = {
      telemetry: { hOdds: 2.0, dOdds: 3.4, aOdds: 4.0 },
      pipeline: { fixture: { league: "Premier League" } },
    };
    const result = await ExecutionEngine.run(stateNoFixture, {
      storage,
      config: makeConfig("fake-key"),
    });

    expect(result.bayesian_lH).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
    vi.doUnmock("@oracle/llm");
  });
});

// ── Graceful fallback when @oracle/llm import fails ──────────────────────────

describe("acquisition — import failure", () => {
  it("engine still produces valid result when llm module unavailable", async () => {
    vi.doMock("@oracle/llm", () => {
      throw new Error("module not found");
    });

    const result = await ExecutionEngine.run(baseState, {
      storage,
      config: makeConfig("fake-key"),
    });

    expect(result.bayesian_lH).toBeGreaterThan(0);
    expect(result.fp.home + result.fp.draw + result.fp.away).toBeCloseTo(1, 3);
    vi.doUnmock("@oracle/llm");
  });
});

// ── Telemetry merge: T1 xG values written when key present ───────────────────

describe("acquisition — T1 xG merge", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.doUnmock("@oracle/llm");
  });

  it("merges xH/xA from T1 response into telemetry", async () => {
    // Only T1 returns valid JSON; T2 and T3 throw
    let callCount = 0;
    vi.doMock("@oracle/llm", () => ({
      fetchGeminiWithCascade: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return '{"xH":2.1,"xA":0.7,"confidence":"high"}'; // T1
        throw new Error("Gemini unavailable"); // T2, T3
      }),
      callClaude: vi.fn(),
      MODELS: {},
      THINKING_LEVELS: {},
      ACQUISITION_CASCADE: [],
    }));

    const state: RunState = {
      telemetry: { hOdds: 1.85, dOdds: 3.4, aOdds: 4.5, piH: 1550, piA: 1450 },
      pipeline: {
        fixture: {
          home: "Arsenal",
          away: "Chelsea",
          league: "Premier League",
          date: "2026-06-10T15:00:00Z",
        },
      },
    };
    const result = await ExecutionEngine.run(state, { storage, config: makeConfig("key") });

    // xG was injected — bayesian lambda should reflect higher home xG
    expect(result.bayesian_lH).toBeGreaterThan(0);
    // xg_confidence should be written to state.telemetry
    expect(state.telemetry?.xg_confidence).toBe("high");
    expect(state.telemetry?.xgMode).toBe("estimated");
  });

  it("does NOT overwrite caller-provided xH", async () => {
    vi.doMock("@oracle/llm", () => ({
      fetchGeminiWithCascade: vi.fn().mockResolvedValue('{"xH":0.5,"xA":0.5,"confidence":"low"}'),
      callClaude: vi.fn(),
      MODELS: {},
      THINKING_LEVELS: {},
      ACQUISITION_CASCADE: [],
    }));

    // Pre-supplied xH should not be overwritten
    const state: RunState = {
      telemetry: { xH: 2.5, xA: 1.0, hOdds: 1.85, dOdds: 3.4, aOdds: 4.5, piH: 1550, piA: 1450 },
      pipeline: {
        fixture: {
          home: "Arsenal",
          away: "Chelsea",
          league: "Premier League",
          date: "2026-06-10T15:00:00Z",
        },
      },
    };
    await ExecutionEngine.run(state, { storage, config: makeConfig("key") });

    // xH should remain 2.5, not overwritten to 0.5
    expect(state.telemetry?.xH).toBe(2.5);
  });
});

// ── Graceful fallback when Gemini returns garbage JSON ────────────────────────

describe("acquisition — malformed Gemini response", () => {
  afterEach(() => {
    vi.doUnmock("@oracle/llm");
  });

  it("engine still completes with default values", async () => {
    vi.doMock("@oracle/llm", () => ({
      fetchGeminiWithCascade: vi.fn().mockResolvedValue("not json at all ¯\\_(ツ)_/¯"),
      callClaude: vi.fn(),
      MODELS: {},
      THINKING_LEVELS: {},
      ACQUISITION_CASCADE: [],
    }));

    const result = await ExecutionEngine.run(baseState, { storage, config: makeConfig("key") });
    expect(result.bayesian_lH).toBeGreaterThan(0);
    expect(result.fp.home + result.fp.draw + result.fp.away).toBeCloseTo(1, 3);
  });
});

// ── T3 soft context merge ─────────────────────────────────────────────────────

describe("acquisition — T3 soft context", () => {
  afterEach(() => {
    vi.doUnmock("@oracle/llm");
  });

  it("stores isDerby and softContext from T3 on state.telemetry", async () => {
    let callCount = 0;
    vi.doMock("@oracle/llm", () => ({
      fetchGeminiWithCascade: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return '{"xH":1.5,"xA":1.0,"confidence":"medium"}';
        if (callCount === 2) return '{"injPenH":0.0,"injPenA":0.0,"softContext":[]}';
        // T3
        return JSON.stringify({
          isDerby: true,
          motivationScore: 1.1,
          travelKm: 350,
          softContext: [
            {
              kind: "motivation",
              text: "North London Derby",
              source: "Gemini T3",
              observedAt: "2026-06-10T15:00:00Z",
            },
          ],
        });
      }),
      callClaude: vi.fn(),
      MODELS: {},
      THINKING_LEVELS: {},
      ACQUISITION_CASCADE: [],
    }));

    const state: RunState = {
      telemetry: { hOdds: 1.85, dOdds: 3.4, aOdds: 4.5, piH: 1550, piA: 1450 },
      pipeline: {
        fixture: {
          home: "Arsenal",
          away: "Tottenham",
          league: "Premier League",
          date: "2026-06-10T15:00:00Z",
        },
      },
    };
    await ExecutionEngine.run(state, { storage, config: makeConfig("key") });

    expect(state.telemetry?.isDerby).toBe(true);
    expect(state.telemetry?.motivationScore).toBe(1.1);
    expect(state.telemetry?.travelKm).toBe(350);
    const sc = state.telemetry?.softContext ?? [];
    expect(sc.length).toBeGreaterThan(0);
    expect(sc[0]?.kind).toBe("motivation");
  });
});
