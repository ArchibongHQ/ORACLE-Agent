/** WS2-C — sharpFeed.ts unit tests. node:child_process's execFile is mocked
 *  (same vi.hoisted pattern as packages/llm/test/claudeCode.test.ts's
 *  callClaudeCode mock) rather than spawning the real tools/fetch_sharp_odds.py
 *  — this sandbox has no network and likely no real Odds API key, and the
 *  point of these tests is to pin fetchSharpFairPrice's fail-open contract
 *  (never throws, returns null on any subprocess/parse failure) plus the
 *  devig arithmetic on the one success path, not to exercise the real
 *  Odds-API/AI-Mode tiers. */

import { devigThreeWay, devigTwoWay } from "@oracle/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFile } = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile }));

const { computeSharpFeedCoverage, fetchSharpFairPrice, sharpOddsRecordId } = await import(
  "../src/sharpFeed.js"
);

type SharpOddsRecordLike = {
  id: string;
  fixtureKey: string;
  market: string;
  side: string;
  pick_odds: number;
  sharp_fair_at_pick: number | null;
  sharp_fair_at_close: number | null;
  source: string;
  capturedAt: string;
};

function record(overrides: Partial<SharpOddsRecordLike> = {}): SharpOddsRecordLike {
  return {
    id: "fx1::1X2::home",
    fixtureKey: "fx1",
    market: "1X2",
    side: "home",
    pick_odds: 1.9,
    sharp_fair_at_pick: 1.95,
    sharp_fair_at_close: null,
    source: "odds_api",
    capturedAt: "2026-07-10T09:00:00Z",
    ...overrides,
  };
}

const baseCtx = {
  home: "Arsenal",
  away: "Chelsea",
  kickoff: "2026-07-10T15:00:00Z",
  sportKey: "soccer_epl",
  oddsApiKey: "test-key",
};

beforeEach(() => {
  execFile.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── sharpOddsRecordId ─────────────────────────────────────────────────────────

describe("sharpOddsRecordId", () => {
  it("is deterministic for the same inputs", () => {
    expect(sharpOddsRecordId("fx1", "1X2", "home")).toBe(sharpOddsRecordId("fx1", "1X2", "home"));
  });

  it("is distinct when fixtureKey differs", () => {
    expect(sharpOddsRecordId("fx1", "1X2", "home")).not.toBe(
      sharpOddsRecordId("fx2", "1X2", "home")
    );
  });

  it("is distinct when market differs", () => {
    expect(sharpOddsRecordId("fx1", "1X2", "home")).not.toBe(
      sharpOddsRecordId("fx1", "BTTS", "home")
    );
  });

  it("is distinct when side differs", () => {
    expect(sharpOddsRecordId("fx1", "1X2", "home")).not.toBe(
      sharpOddsRecordId("fx1", "1X2", "away")
    );
  });

  it("composes fixtureKey/market/side with :: separators", () => {
    expect(sharpOddsRecordId("fx1", "1X2", "home")).toBe("fx1::1X2::home");
  });
});

// ── computeSharpFeedCoverage ───────────────────────────────────────────────────

describe("computeSharpFeedCoverage", () => {
  it("returns 0 for an empty array", () => {
    expect(computeSharpFeedCoverage([])).toBe(0);
  });

  it("returns 1.0 when every record is covered", () => {
    const records = [
      record({ id: "a", source: "odds_api", sharp_fair_at_pick: 1.9 }),
      record({ id: "b", source: "ai_mode_fallback", sharp_fair_at_pick: 2.1 }),
    ];
    expect(computeSharpFeedCoverage(records)).toBe(1);
  });

  it("returns 0 when every record is uncovered (source unavailable)", () => {
    const records = [
      record({ id: "a", source: "unavailable", sharp_fair_at_pick: null }),
      record({ id: "b", source: "unavailable", sharp_fair_at_pick: null }),
    ];
    expect(computeSharpFeedCoverage(records)).toBe(0);
  });

  it("computes the correct fraction for a mix of covered and uncovered records", () => {
    const records = [
      record({ id: "a", source: "odds_api", sharp_fair_at_pick: 1.9 }),
      record({ id: "b", source: "ai_mode_fallback", sharp_fair_at_pick: 2.1 }),
      record({ id: "c", source: "unavailable", sharp_fair_at_pick: null }),
      record({ id: "d", source: "unavailable", sharp_fair_at_pick: null }),
    ];
    expect(computeSharpFeedCoverage(records)).toBeCloseTo(0.5, 6);
  });

  it("treats a record with source set but null sharp_fair_at_pick as uncovered", () => {
    // Guards against a partially-written record (e.g. a crash between setting
    // source and the price) silently counting as covered.
    const records = [record({ id: "a", source: "odds_api", sharp_fair_at_pick: null })];
    expect(computeSharpFeedCoverage(records)).toBe(0);
  });
});

// ── fetchSharpFairPrice — fail-open behavior ───────────────────────────────────

describe("fetchSharpFairPrice fail-open behavior", () => {
  it("returns null when execFile reports a spawn error", async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error("spawn ENOENT"), "", ""));
    const result = await fetchSharpFairPrice("fx1", "1X2", "home", baseCtx);
    expect(result).toBeNull();
  });

  it("returns null when execFile reports a timeout (killed) error", async () => {
    const timeoutErr = Object.assign(new Error("Command timed out"), {
      killed: true,
      signal: "SIGKILL",
    });
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(timeoutErr, "", ""));
    const result = await fetchSharpFairPrice("fx1", "1X2", "home", baseCtx);
    expect(result).toBeNull();
  });

  it("returns null when stdout is malformed/non-JSON", async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "not json at all", ""));
    const result = await fetchSharpFairPrice("fx1", "1X2", "home", baseCtx);
    expect(result).toBeNull();
  });

  it("returns null when the tool returns valid JSON with ok:false", async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(
        null,
        JSON.stringify({
          ok: false,
          source: "unavailable",
          market: "1X2",
          side: "home",
          prices: {},
          error: "no odds api key and AI-Mode fallback exhausted",
        }),
        ""
      )
    );
    const result = await fetchSharpFairPrice("fx1", "1X2", "home", baseCtx);
    expect(result).toBeNull();
  });

  it("returns null (never throws) when execFile itself throws synchronously", async () => {
    execFile.mockImplementation(() => {
      throw new Error("EACCES");
    });
    await expect(fetchSharpFairPrice("fx1", "1X2", "home", baseCtx)).resolves.toBeNull();
  });

  it("returns null when only one side of a would-be 2-way pair is present (nothing to devig against)", async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(
        null,
        JSON.stringify({
          ok: true,
          source: "odds_api",
          market: "1X2",
          side: "home",
          prices: { home: 1.9 },
        }),
        ""
      )
    );
    const result = await fetchSharpFairPrice("fx1", "1X2", "home", baseCtx);
    expect(result).toBeNull();
  });
});

// ── fetchSharpFairPrice — success path (devig correctness) ────────────────────

describe("fetchSharpFairPrice success path", () => {
  it("devigs a 3-way (1X2) response via devigThreeWay and returns the fair price for the requested side", async () => {
    const prices = { home: 1.9, draw: 3.4, away: 4.3 };
    execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(
        null,
        JSON.stringify({ ok: true, source: "odds_api", market: "1X2", side: "home", prices }),
        ""
      )
    );

    const result = await fetchSharpFairPrice("fx1", "1X2", "home", baseCtx);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("odds_api");

    const fair = devigThreeWay(prices.home, prices.draw, prices.away);
    expect(fair).toBeDefined();
    const expectedFairOdds = parseFloat((1 / fair![0]).toFixed(4));
    expect(result!.fair).toBeCloseTo(expectedFairOdds, 4);
  });

  it("devigs a 2-way (BTTS yes/no) response via devigTwoWay and returns the fair price for 'no'", async () => {
    const prices = { yes: 1.8, no: 2.0 };
    execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(
        null,
        JSON.stringify({
          ok: true,
          source: "ai_mode_fallback",
          market: "BTTS",
          side: "no",
          prices,
        }),
        ""
      )
    );

    const result = await fetchSharpFairPrice("fx1", "BTTS", "no", baseCtx);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("ai_mode_fallback");

    const fair = devigTwoWay(prices.yes, prices.no);
    expect(fair).toBeDefined();
    const expectedFairOdds = parseFloat((1 / fair![1]).toFixed(4));
    expect(result!.fair).toBeCloseTo(expectedFairOdds, 4);
  });

  it("devigs a 2-way home/away (DNB-style) response via devigTwoWay", async () => {
    const prices = { home: 1.7, away: 2.3 };
    execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(
        null,
        JSON.stringify({ ok: true, source: "odds_api", market: "DNB", side: "away", prices }),
        ""
      )
    );

    const result = await fetchSharpFairPrice("fx1", "DNB", "away", baseCtx);
    expect(result).not.toBeNull();

    const fair = devigTwoWay(prices.home, prices.away);
    expect(fair).toBeDefined();
    const expectedFairOdds = parseFloat((1 / fair![1]).toFixed(4));
    expect(result!.fair).toBeCloseTo(expectedFairOdds, 4);
  });

  it("passes ctx fields through as execFile args (home/away/kickoff/market/side/fixture-key)", async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(
        null,
        JSON.stringify({
          ok: true,
          source: "odds_api",
          market: "1X2",
          side: "home",
          prices: { home: 1.9, draw: 3.4, away: 4.3 },
        }),
        ""
      )
    );

    await fetchSharpFairPrice("fx1", "1X2", "home", baseCtx);

    expect(execFile).toHaveBeenCalledTimes(1);
    const args = execFile.mock.calls[0]![1] as string[];
    expect(args).toContain("--home");
    expect(args).toContain(baseCtx.home);
    expect(args).toContain("--away");
    expect(args).toContain(baseCtx.away);
    expect(args).toContain("--kickoff");
    expect(args).toContain(baseCtx.kickoff);
    expect(args).toContain("--market");
    expect(args).toContain("1X2");
    expect(args).toContain("--side");
    expect(args).toContain("home");
    expect(args).toContain("--fixture-key");
    expect(args).toContain("fx1");
  });
});
