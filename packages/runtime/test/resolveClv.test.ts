import { afterEach, describe, expect, it, vi } from "vitest";
import { computeRealisedClv } from "../src/resolveFixtures.js";

// ── computeRealisedClv unit tests ─────────────────────────────────────────────

describe("computeRealisedClv", () => {
  const frozen = { home: 2.0, draw: 3.4, away: 4.5 };

  it("returns null when frozenOdds side is missing", () => {
    expect(computeRealisedClv({}, { home: 2.1, draw: 3.3, away: 4.2 }, "Home")).toBeNull();
  });

  it("returns null when analysis odds ≤ 1", () => {
    expect(
      computeRealisedClv({ home: 0.9 }, { home: 2.0, draw: 3.4, away: 4.5 }, "Home")
    ).toBeNull();
  });

  it("returns null when closing odds ≤ 1", () => {
    expect(computeRealisedClv(frozen, { home: 0.5, draw: 3.4, away: 4.5 }, "Home")).toBeNull();
  });

  it("computes positive CLV when market shortens (closing IP > analysis IP)", () => {
    // Home moves 2.00 → 1.80: closing IP 0.556 > analysis IP 0.500 → CLV > 0
    const clv = computeRealisedClv(frozen, { home: 1.8, draw: 3.5, away: 4.6 }, "Home");
    expect(clv).not.toBeNull();
    expect(clv!).toBeGreaterThan(0);
    expect(clv!).toBeCloseTo(1 / 1.8 - 1 / 2.0, 5);
  });

  it("computes negative CLV when market drifts (closing IP < analysis IP)", () => {
    // Home moves 2.00 → 2.20: closing IP 0.455 < analysis IP 0.500 → CLV < 0
    const clv = computeRealisedClv(frozen, { home: 2.2, draw: 3.3, away: 4.4 }, "Home");
    expect(clv).not.toBeNull();
    expect(clv!).toBeLessThan(0);
  });

  it("uses home side as fallback when topPickLabel is null", () => {
    const clvNull = computeRealisedClv(frozen, { home: 1.9, draw: 3.4, away: 4.5 }, null);
    const clvHome = computeRealisedClv(frozen, { home: 1.9, draw: 3.4, away: 4.5 }, "Home");
    expect(clvNull).toEqual(clvHome);
  });

  it("uses draw side when topPickLabel is Draw", () => {
    const clv = computeRealisedClv(frozen, { home: 2.0, draw: 3.1, away: 4.5 }, "Draw");
    expect(clv).not.toBeNull();
    // closing draw IP (1/3.10) vs analysis draw IP (1/3.40)
    expect(clv!).toBeCloseTo(1 / 3.1 - 1 / 3.4, 5);
  });

  it("uses away side when topPickLabel is Away", () => {
    const clv = computeRealisedClv(frozen, { home: 2.0, draw: 3.4, away: 4.2 }, "Away");
    expect(clv).not.toBeNull();
    expect(clv!).toBeCloseTo(1 / 4.2 - 1 / 4.5, 5);
  });

  it("result is rounded to 6 decimal places", () => {
    const clv = computeRealisedClv(frozen, { home: 1.95, draw: 3.4, away: 4.5 }, "Home");
    expect(clv).not.toBeNull();
    const str = clv?.toString();
    const decimals = str.includes(".") ? str.split(".")[1]?.length : 0;
    expect(decimals).toBeLessThanOrEqual(6);
  });
});

// ── fetchClosingOdds integration (mocked fetch) ───────────────────────────────

describe("resolveRecords CLV integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolveRecord produces realisedCLV when Odds API returns matching game", async () => {
    // Minimal mocked Odds API response: Pinnacle h2h odds for Arsenal vs Chelsea
    const oddsApiPayload: unknown = [
      {
        home_team: "Arsenal",
        away_team: "Chelsea",
        bookmakers: [
          {
            key: "pinnacle",
            markets: [
              {
                key: "h2h",
                outcomes: [
                  { name: "Arsenal", price: 1.85 },
                  { name: "Chelsea", price: 4.2 },
                  { name: "Draw", price: 3.5 },
                ],
              },
            ],
          },
        ],
      },
    ];

    // football-data.org response: finished match
    const fdPayload: unknown = {
      matches: [
        {
          id: 1,
          utcDate: "2026-06-01T15:00:00Z",
          status: "FINISHED",
          homeTeam: { name: "Arsenal FC" },
          awayTeam: { name: "Chelsea FC" },
          score: { fullTime: { home: 2, away: 1 } },
        },
      ],
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.includes("the-odds-api") ? oddsApiPayload : fdPayload;
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const { resolveRecords } = await import("../src/resolveFixtures.js");

    const record = {
      fixtureId: "test-1",
      home: "Arsenal",
      away: "Chelsea",
      league: "Premier League",
      kickoff: "2026-06-01T15:00:00Z",
      lambdaH: 1.5,
      lambdaA: 1.2,
      probabilities: { home: 0.5, draw: 0.28, away: 0.22 },
      regime: "STANDARD",
      rankingMode: "CONFIDENCE_WEIGHTED" as const,
      evMarkets: [],
      llmPick: null,
      deterministicTopPick: {
        cat: "1X2",
        label: "Home",
        market: "1X2",
        mp: 0.5,
        modelProb: 0.5,
        ip: 0.526,
        rawEdge: -0.026,
        ev: -0.026,
        odds: 1.9,
        stake: 0.01,
        stakeAmt: 10,
        rankingScore: 0.5,
        varianceMod: 1,
      },
      frozenOddsAtAnalysis: { home: 1.9, draw: 3.4, away: 4.5 },
      liquidityTag: "CLV_ELIGIBLE" as const,
      analysedAt: "2026-06-01T09:00:00Z",
    };

    const { resolved } = await resolveRecords([record], "fd-key", "odds-key");
    expect(resolved).toHaveLength(1);
    const res = resolved[0]!;
    expect(res.realisedCLV).not.toBeNull();
    // closing home IP = 1/1.85 ≈ 0.5405; analysis home IP = 1/1.90 ≈ 0.5263 → CLV > 0
    expect(res.realisedCLV!).toBeGreaterThan(0);
  });

  it("resolveRecord leaves realisedCLV null when Odds API returns no match", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.includes("the-odds-api")
        ? []
        : {
            matches: [
              {
                id: 2,
                utcDate: "2026-06-01T15:00:00Z",
                status: "FINISHED",
                homeTeam: { name: "Arsenal FC" },
                awayTeam: { name: "Chelsea FC" },
                score: { fullTime: { home: 1, away: 1 } },
              },
            ],
          };
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const { resolveRecords } = await import("../src/resolveFixtures.js");

    const record = {
      fixtureId: "test-2",
      home: "Arsenal",
      away: "Chelsea",
      league: "Premier League",
      kickoff: "2026-06-01T15:00:00Z",
      lambdaH: 1.5,
      lambdaA: 1.2,
      probabilities: { home: 0.45, draw: 0.3, away: 0.25 },
      regime: "STANDARD",
      rankingMode: "CONFIDENCE_WEIGHTED" as const,
      evMarkets: [],
      llmPick: null,
      deterministicTopPick: null,
      frozenOddsAtAnalysis: { home: 1.9, draw: 3.4, away: 4.5 },
      liquidityTag: "CLV_ELIGIBLE" as const,
      analysedAt: "2026-06-01T09:00:00Z",
    };

    const { resolved } = await resolveRecords([record], "fd-key", "odds-key");
    expect(resolved[0]?.realisedCLV).toBeNull();
  });

  it("resolveRecord leaves realisedCLV null for CALIBRATION_ONLY records", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            matches: [
              {
                id: 3,
                utcDate: "2026-06-01T15:00:00Z",
                status: "FINISHED",
                homeTeam: { name: "Burnley" },
                awayTeam: { name: "QPR" },
                score: { fullTime: { home: 2, away: 0 } },
              },
            ],
          }),
          { status: 200 }
        )
    );

    const { resolveRecords } = await import("../src/resolveFixtures.js");

    const record = {
      fixtureId: "test-3",
      home: "Burnley",
      away: "QPR",
      league: "Championship",
      kickoff: "2026-06-01T15:00:00Z",
      lambdaH: 1.6,
      lambdaA: 1.1,
      probabilities: { home: 0.55, draw: 0.25, away: 0.2 },
      regime: "STANDARD",
      rankingMode: "CONFIDENCE_WEIGHTED" as const,
      evMarkets: [],
      llmPick: null,
      deterministicTopPick: null,
      frozenOddsAtAnalysis: { home: 1.7, draw: 3.5, away: 5.0 },
      liquidityTag: "CALIBRATION_ONLY" as const,
      analysedAt: "2026-06-01T09:00:00Z",
    };

    const { resolved } = await resolveRecords([record], "fd-key", "odds-key");
    // Championship is CALIBRATION_ONLY — CLV never computed regardless of odds key
    expect(resolved[0]?.realisedCLV).toBeNull();
  });
});
