/** Tests for makeSportyBetSidecarProvider — the tier-6 zero-network odds provider.
 *  node:fs/promises is mocked at module level so vi.mocked(readFile) can be
 *  configured per-test without ESM binding issues. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSportyBetSidecarProvider } from "../src/oddsProviders.js";

// ── Module-level mock (hoisted by Vitest) ─────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

const { readFile } = await import("node:fs/promises");

// ── Helpers ───────────────────────────────────────────────────────────────────

const TODAY = "2026-06-09";
const KICKOFF = `${TODAY}T15:00:00Z`;
const PROVIDER = makeSportyBetSidecarProvider("/fake/sportybet_today.json");

function sidecarWith(
  home: string,
  away: string,
  odds1x2: { home: number; draw: number; away: number } | null
): string {
  return JSON.stringify({
    date: TODAY,
    events: [
      {
        home,
        away,
        marketCount: 12,
        ...(odds1x2
          ? { odds: { "1x2": { home: odds1x2.home, draw: odds1x2.draw, away: odds1x2.away } } }
          : {}),
      },
    ],
  });
}

afterEach(() => vi.clearAllMocks());

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("makeSportyBetSidecarProvider fetch", () => {
  it("returns a valid soft-book triple when the event and 1x2 odds are present", async () => {
    vi.mocked(readFile).mockResolvedValue(
      sidecarWith("Arsenal", "Chelsea", { home: 2.0, draw: 3.4, away: 4.0 }) as never
    );
    const res = await PROVIDER.fetch("Arsenal", "Chelsea", "Premier League", KICKOFF);
    expect(res).not.toBeNull();
    expect(res!.home).toBe(2.0);
    expect(res!.draw).toBe(3.4);
    expect(res!.away).toBe(4.0);
    expect(res!.isSharp).toBe(false);
    expect(res!.confidence).toBe(0.62);
    expect(res!.provider).toBe("sportybet-sidecar");
    expect(res!.sources).toEqual(["sportybet-sidecar"]);
    expect(res!.overround).toBeGreaterThan(0);
  });

  it("returns null when the file is missing (readFile throws ENOENT)", async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );
    expect(await PROVIDER.fetch("Arsenal", "Chelsea", "Premier League", KICKOFF)).toBeNull();
  });

  it("returns null when the sidecar date does not match kickoff date", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ date: "2026-06-08", events: [] }) as never
    );
    expect(await PROVIDER.fetch("Arsenal", "Chelsea", "Premier League", KICKOFF)).toBeNull();
  });

  it("returns null when events is not an array", async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ date: TODAY, events: null }) as never
    );
    expect(await PROVIDER.fetch("Arsenal", "Chelsea", "Premier League", KICKOFF)).toBeNull();
  });

  it("returns null when no event matches the team names", async () => {
    vi.mocked(readFile).mockResolvedValue(
      sidecarWith("Liverpool", "Everton", { home: 2.0, draw: 3.4, away: 4.0 }) as never
    );
    expect(await PROVIDER.fetch("Arsenal", "Chelsea", "Premier League", KICKOFF)).toBeNull();
  });

  it("returns null when the matching event has no 1x2 odds block", async () => {
    vi.mocked(readFile).mockResolvedValue(
      sidecarWith("Arsenal", "Chelsea", null) as never
    );
    expect(await PROVIDER.fetch("Arsenal", "Chelsea", "Premier League", KICKOFF)).toBeNull();
  });

  it("returns null when the triple fails validateSbTriple (overround > 0.25)", async () => {
    // 1/1.3 + 1/1.3 + 1/1.3 − 1 ≈ 1.31 → far exceeds the 0.25 retail tolerance
    vi.mocked(readFile).mockResolvedValue(
      sidecarWith("Arsenal", "Chelsea", { home: 1.3, draw: 1.3, away: 1.3 }) as never
    );
    expect(await PROVIDER.fetch("Arsenal", "Chelsea", "Premier League", KICKOFF)).toBeNull();
  });

  it("returns null when a price is below MIN_PRICE (1.01)", async () => {
    vi.mocked(readFile).mockResolvedValue(
      sidecarWith("Arsenal", "Chelsea", { home: 1.0, draw: 3.4, away: 4.0 }) as never
    );
    expect(await PROVIDER.fetch("Arsenal", "Chelsea", "Premier League", KICKOFF)).toBeNull();
  });

  it("always reports hasQuota() === true (file-based, no API key required)", () => {
    expect(PROVIDER.hasQuota()).toBe(true);
  });

  it("is registered as tier 6 and non-sharp in buildOddsProviders", async () => {
    const { buildOddsProviders } = await import("../src/oddsProviders.js");
    const providers = buildOddsProviders({});
    const sidecar = providers.find((p) => p.name === "sportybet-sidecar");
    expect(sidecar?.tier).toBe(6);
    expect(sidecar?.isSharp).toBe(false);
  });
});
