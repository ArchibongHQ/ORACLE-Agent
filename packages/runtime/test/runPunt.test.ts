/** Unit tests for refreshSidecarIfStale — the sidecar freshness guard in runPunt.ts.
 *  We mock node:fs (existsSync / readFileSync) and node:child_process (spawn) to
 *  exercise every branch without touching the filesystem or spawning a real process. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs")>();
  return { ...mod, existsSync: vi.fn(), readFileSync: vi.fn() };
});

vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return { ...mod, spawn: vi.fn() };
});

// goalsScreen.ts imports callClaudeCode statically (not dynamically), so a
// per-test vi.doMock would be too late — this hoisted mock is required for the
// computeAdvisoryLabels Sonnet-screen tests below to control its response.
vi.mock("@oracle/llm", () => ({
  isLocalRuntime: vi.fn(() => false),
  callClaudeCode: vi.fn(),
}));

// Must be imported AFTER the mocks are registered.
// Dynamic import ensures vitest hoists the vi.mock calls above before resolution.
const { existsSync, readFileSync } = await import("node:fs");
const { spawn } = await import("node:child_process");
const { isLocalRuntime, callClaudeCode } = await import("@oracle/llm");
const { computeAdvisoryLabels, formatPuntResult, refreshSidecarIfStale } = await import(
  "../src/runPunt.js"
);

const TODAY = new Date().toISOString().slice(0, 10);

/** Build a minimal fake child-process that fires "close" synchronously. */
function makeChild(opts: { error?: boolean; killable?: boolean } = {}) {
  const handlers: Record<string, () => void> = {};
  const child = {
    on(event: string, cb: () => void) {
      handlers[event] = cb;
      // fire "close" or "error" on the next tick so the Promise resolves quickly
      if (event === (opts.error ? "error" : "close")) {
        setImmediate(cb);
      }
      return child;
    },
    kill: vi.fn(),
  };
  return child as unknown as ReturnType<typeof spawn>;
}

describe("refreshSidecarIfStale", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => vi.clearAllMocks());

  it("returns immediately without spawning when the sidecar is fresh", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ date: TODAY }));

    await refreshSidecarIfStale();

    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns scrape_fixtures.py when the sidecar is missing", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(spawn).mockReturnValue(makeChild());

    await refreshSidecarIfStale();

    expect(spawn).toHaveBeenCalledOnce();
    const [cmd, args] = vi.mocked(spawn).mock.calls[0]!;
    // resolvePythonBin falls back to a bare interpreter when no install is found
    // (existsSync is mocked false here): "python" on Windows, "python3" elsewhere.
    expect(cmd).toBe(process.platform === "win32" ? "python" : "python3");
    expect((args as string[]).some((a) => a.includes("scrape_fixtures.py"))).toBe(true);
  });

  it("spawns when the sidecar date is stale (yesterday)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ date: yesterday }));
    vi.mocked(spawn).mockReturnValue(makeChild());

    await refreshSidecarIfStale();

    expect(spawn).toHaveBeenCalledOnce();
  });

  it("spawns when the sidecar JSON is corrupt (JSON.parse throws)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not-valid-json");
    vi.mocked(spawn).mockReturnValue(makeChild());

    await refreshSidecarIfStale();

    expect(spawn).toHaveBeenCalledOnce();
  });

  it("resolves without throwing when the child process emits an error", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(spawn).mockReturnValue(makeChild({ error: true }));

    await expect(refreshSidecarIfStale()).resolves.toBeUndefined();
  });
});

// ── computeAdvisoryLabels (Q4d) ─────────────────────────────────────────────────

import type { OracleConfig } from "@oracle/engine";
import type { CounterLeg } from "../src/punt.js";
import type { PuntResult } from "../src/runPunt.js";
import type { SportyBetEvent } from "../src/selectFixtures.js";

function sidecarEvent(home: string, away: string): SportyBetEvent {
  return { home, away, marketCount: 5, league: "Bundesliga" };
}

const BASE_CONFIG: OracleConfig = { geminiApiKey: "", claudeApiKey: "", bankroll: 1000 };

describe("computeAdvisoryLabels", () => {
  beforeEach(() => {
    vi.mocked(isLocalRuntime).mockReturnValue(false);
    vi.mocked(callClaudeCode).mockReset();
  });

  it("attaches a mechanical score only to legs with a matching sidecar event", async () => {
    const legs: Array<{ sidecarEvent?: SportyBetEvent }> = [
      { sidecarEvent: sidecarEvent("A", "B") },
      {}, // no sidecar event — no fabricated score
    ];
    const { mechanicalByLegIdx, sonnetByLegIdx } = await computeAdvisoryLabels(legs, BASE_CONFIG);
    expect(mechanicalByLegIdx.has(0)).toBe(true);
    expect(mechanicalByLegIdx.has(1)).toBe(false);
    expect(sonnetByLegIdx.size).toBe(0);
  });

  it("never runs the Sonnet screen outside a local runtime", async () => {
    const legs: Array<{ sidecarEvent?: SportyBetEvent }> = [
      { sidecarEvent: sidecarEvent("A", "B") },
    ];
    const { sonnetByLegIdx } = await computeAdvisoryLabels(legs, BASE_CONFIG);
    expect(callClaudeCode).not.toHaveBeenCalled();
    expect(sonnetByLegIdx.size).toBe(0);
  });

  it("attaches a Sonnet rationale when running locally and the screen succeeds", async () => {
    vi.mocked(isLocalRuntime).mockReturnValue(true);
    vi.mocked(callClaudeCode).mockResolvedValue(
      JSON.stringify({ ranked: [{ index: 0, rationale: "strong goals signal" }] })
    );
    const legs: Array<{ sidecarEvent?: SportyBetEvent }> = [
      { sidecarEvent: sidecarEvent("A", "B") },
    ];
    const { sonnetByLegIdx } = await computeAdvisoryLabels(legs, BASE_CONFIG);
    expect(sonnetByLegIdx.get(0)).toBe("strong goals signal");
  });

  it("fails open (mechanical score still set) when Sonnet screening throws", async () => {
    vi.mocked(isLocalRuntime).mockReturnValue(true);
    vi.mocked(callClaudeCode).mockRejectedValue(new Error("spawn failed"));
    const legs: Array<{ sidecarEvent?: SportyBetEvent }> = [
      { sidecarEvent: sidecarEvent("A", "B") },
    ];
    const { mechanicalByLegIdx, sonnetByLegIdx } = await computeAdvisoryLabels(legs, BASE_CONFIG);
    expect(mechanicalByLegIdx.has(0)).toBe(true);
    expect(sonnetByLegIdx.size).toBe(0);
  });

  it("returns empty maps when no leg has a sidecar event", async () => {
    const { mechanicalByLegIdx, sonnetByLegIdx } = await computeAdvisoryLabels(
      [{}, {}],
      BASE_CONFIG
    );
    expect(mechanicalByLegIdx.size).toBe(0);
    expect(sonnetByLegIdx.size).toBe(0);
  });
});

// ── formatPuntResult (Q4) ────────────────────────────────────────────────────────

describe("formatPuntResult", () => {
  function baseLeg(overrides: Partial<CounterLeg> = {}): CounterLeg {
    return {
      raw: {
        home: "Arsenal",
        away: "Chelsea",
        league: "Premier League",
        marketDesc: "1X2",
        outcomeDesc: "Home",
        odds: 2.0,
      },
      verdict: "CONFIRMED",
      pick: {
        home: "Arsenal",
        away: "Chelsea",
        league: "Premier League",
        kickoff: "",
        market: "1X2",
        side: "Home Win",
        odds: 2.0,
        stakePct: 0,
        confidence: 0.6,
      },
      oracleConfidence: 0.6,
      ...overrides,
    };
  }

  function baseResult(legs: CounterLeg[]): PuntResult {
    return {
      sourceCode: "ABC123",
      oracleCode: null,
      oracleLoadUrl: null,
      totalOdds: 0,
      legs,
      adjustedCount: 0,
      confirmedCount: legs.length,
      keptCount: 0,
      noCoverageCount: 0,
    };
  }

  it("renders the leg's note when present", () => {
    const html = formatPuntResult(baseResult([baseLeg({ note: "swapped 1X2/Home → Goals O/U" })]));
    expect(html).toContain("↳ swapped 1X2/Home → Goals O/U");
  });

  it("flags provenance when the pick came from the all-markets scan", () => {
    // [patterns-engine Wave 1 — Phase 4] Provenance now rides on the
    // sourcedFromScan flag, not the market string (which carries the real
    // FAMILY_LABEL so the pick is bookable + readable).
    const html = formatPuntResult(
      baseResult([
        baseLeg({ pick: { ...baseLeg().pick, market: "Goals O/U", sourcedFromScan: true } }),
      ])
    );
    expect(html).toContain("sourced from the full markets scan (Goals O/U)");
  });

  it("flags provenance when the pick came from the LLM market executor", () => {
    const html = formatPuntResult(
      baseResult([baseLeg({ pick: { ...baseLeg().pick, market: "LLM Market Executor" } })])
    );
    expect(html).toContain("sourced from the full markets scan (LLM Market Executor)");
  });

  it("renders the AH-pivot safety note when present", () => {
    const html = formatPuntResult(
      baseResult([
        baseLeg({
          ahPivotNote: "Low-scoring regime — 0:0/Under-2.5 risk. Safer alternative: AH +0.5 home",
        }),
      ])
    );
    expect(html).toContain("⚠️ Low-scoring regime — 0:0/Under-2.5 risk");
  });

  it("renders mechanical score and Sonnet verdict together", () => {
    const html = formatPuntResult(
      baseResult([baseLeg({ mechanicalScore: 72.4, sonnetVerdict: "strong goals case" })])
    );
    expect(html).toContain("mech=72");
    expect(html).toContain("Sonnet: strong goals case");
  });

  it("renders every leg regardless of verdict, including NO_COVERAGE", () => {
    const html = formatPuntResult(
      baseResult([
        baseLeg({ verdict: "NO_COVERAGE", note: "fixture not resolved on ORACLE coverage" }),
      ])
    );
    expect(html).toContain("❔");
    expect(html).toContain("↳ fixture not resolved on ORACLE coverage");
  });
});
