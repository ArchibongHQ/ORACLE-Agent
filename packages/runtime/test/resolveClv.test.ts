import { afterEach, describe, expect, it, vi } from "vitest";
import { computeRealisedClv, computeSharpReferenceClv } from "../src/resolveFixtures.js";

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

// ── computeSharpReferenceClv unit tests (P1-4, Wave 2) ────────────────────────

describe("computeSharpReferenceClv", () => {
  it("returns null when sharpFairAtPick is null", () => {
    expect(computeSharpReferenceClv(null, 1.95)).toBeNull();
  });

  it("returns null when sharpFairAtPick is undefined", () => {
    expect(computeSharpReferenceClv(undefined, 1.95)).toBeNull();
  });

  it("returns null when sharpFairAtPick is <= 1", () => {
    expect(computeSharpReferenceClv(1, 1.95)).toBeNull();
    expect(computeSharpReferenceClv(0.9, 1.95)).toBeNull();
  });

  it("returns null when sharpFairAtClose is null", () => {
    expect(computeSharpReferenceClv(1.95, null)).toBeNull();
  });

  it("returns null when sharpFairAtClose is undefined", () => {
    expect(computeSharpReferenceClv(1.95, undefined)).toBeNull();
  });

  it("returns null when sharpFairAtClose is <= 1", () => {
    expect(computeSharpReferenceClv(1.95, 1)).toBeNull();
    expect(computeSharpReferenceClv(1.95, 0.8)).toBeNull();
  });

  it("returns null (never throws) when both endpoints are missing", () => {
    expect(() => computeSharpReferenceClv(null, undefined)).not.toThrow();
    expect(computeSharpReferenceClv(null, undefined)).toBeNull();
  });

  it("computes positive CLV when the sharp fair price shortened (moved in the bettor's favor)", () => {
    // Sharp fair 1.95 → 1.80: closing IP 0.556 > pick IP 0.513 → CLV > 0
    const clv = computeSharpReferenceClv(1.95, 1.8);
    expect(clv).not.toBeNull();
    expect(clv!).toBeGreaterThan(0);
    expect(clv!).toBeCloseTo(1 / 1.8 - 1 / 1.95, 6);
  });

  it("computes negative CLV when the sharp fair price drifted (moved against the bettor)", () => {
    // Sharp fair 1.95 → 2.20: closing IP 0.455 < pick IP 0.513 → CLV < 0
    const clv = computeSharpReferenceClv(1.95, 2.2);
    expect(clv).not.toBeNull();
    expect(clv!).toBeLessThan(0);
    expect(clv!).toBeCloseTo(1 / 2.2 - 1 / 1.95, 6);
  });

  it("returns 0 (not null) when the sharp fair price is unchanged", () => {
    const clv = computeSharpReferenceClv(2.0, 2.0);
    expect(clv).toBe(0);
  });

  it("result is rounded to 6 decimal places", () => {
    const clv = computeSharpReferenceClv(1.93, 1.87);
    expect(clv).not.toBeNull();
    const str = clv?.toString() ?? "";
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

// ── PR-8b: TICK_LEVEL CLV + real steam signal from a captured snapshot ───────

function baseAnalysisRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    fixtureId: "snap-test",
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
    ...overrides,
  };
}

function fdFinishedResponse(homeGoals = 2, awayGoals = 1) {
  return {
    matches: [
      {
        id: 1,
        utcDate: "2026-06-01T15:00:00Z",
        status: "FINISHED",
        homeTeam: { name: "Arsenal FC" },
        awayTeam: { name: "Chelsea FC" },
        score: { fullTime: { home: homeGoals, away: awayGoals } },
      },
    ],
  };
}

describe("resolveRecords TICK_LEVEL CLV + steam signal (PR-8b)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the snapshot for CLV (TICK_LEVEL) and never calls the Odds API", async () => {
    const fetchSpy = vi.fn(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("the-odds-api"))
        throw new Error("must not call Odds API when a snapshot exists");
      return new Response(JSON.stringify(fdFinishedResponse()), { status: 200 });
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);

    const { resolveRecords } = await import("../src/resolveFixtures.js");
    const record = baseAnalysisRecord();
    const snapshots = new Map([
      [
        "snap-test",
        {
          fixtureId: "snap-test",
          eventId: "sr:match:1",
          kickoff: "2026-06-01T15:00:00Z",
          snapshotAt: "2026-06-01T14:30:00Z",
          odds: { "1x2": { home: 1.7, draw: 3.5, away: 5.0 } },
        },
      ],
    ]);

    const { resolved } = await resolveRecords([record], "fd-key", "odds-key", undefined, snapshots);
    expect(resolved).toHaveLength(1);
    const res = resolved[0]!;
    expect(res.clvSourceQuality).toBe("TICK_LEVEL");
    // closing home IP = 1/1.7 ≈ 0.588; analysis home IP = 1/1.9 ≈ 0.526 → CLV > 0
    expect(res.realisedCLV).not.toBeNull();
    expect(res.realisedCLV!).toBeGreaterThan(0);
  });

  it("populates a real steam signal (nonzero velocity) from the snapshot vs frozenOddsAtAnalysis", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify(fdFinishedResponse()), { status: 200 })
    );

    const { resolveRecords } = await import("../src/resolveFixtures.js");
    const record = baseAnalysisRecord();
    const snapshots = new Map([
      [
        "snap-test",
        {
          fixtureId: "snap-test",
          eventId: "sr:match:1",
          kickoff: "2026-06-01T15:00:00Z",
          snapshotAt: "2026-06-01T14:30:00Z",
          odds: { "1x2": { home: 1.7, draw: 3.5, away: 5.0 } },
        },
      ],
    ]);

    const { resolved } = await resolveRecords([record], "fd-key", undefined, undefined, snapshots);
    const res = resolved[0]!;
    expect(res.realisedSteamVelocity).not.toBeNull();
    expect(res.realisedSteamVelocity!).toBeCloseTo(1 / 1.7 - 1 / 1.9, 5);
    expect(typeof res.sharpCompressionDetected).toBe("boolean");
  });

  it("falls back to KICKOFF_PROXY when no snapshot is provided (byte-for-byte existing behavior)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.includes("the-odds-api")
        ? [
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
          ]
        : fdFinishedResponse();
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const { resolveRecords } = await import("../src/resolveFixtures.js");
    const record = baseAnalysisRecord();
    const { resolved } = await resolveRecords([record], "fd-key", "odds-key");
    const res = resolved[0]!;
    expect(res.clvSourceQuality).toBe("KICKOFF_PROXY");
    expect(res.realisedCLV).not.toBeNull();
    expect(res.realisedSteamVelocity).toBeNull();
    expect(res.sharpCompressionDetected).toBeNull();
  });

  it("CALIBRATION_ONLY league still gets a steam signal but never CLV, even with a snapshot", async () => {
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
    const record = baseAnalysisRecord({
      fixtureId: "snap-calib-only",
      home: "Burnley",
      away: "QPR",
      league: "Championship",
      liquidityTag: "CALIBRATION_ONLY" as const,
      frozenOddsAtAnalysis: { home: 1.7, draw: 3.5, away: 5.0 },
    });
    const snapshots = new Map([
      [
        "snap-calib-only",
        {
          fixtureId: "snap-calib-only",
          eventId: "sr:match:2",
          kickoff: "2026-06-01T15:00:00Z",
          snapshotAt: "2026-06-01T14:30:00Z",
          odds: { "1x2": { home: 1.6, draw: 3.6, away: 5.5 } },
        },
      ],
    ]);

    const { resolved } = await resolveRecords([record], "fd-key", "odds-key", undefined, snapshots);
    const res = resolved[0]!;
    expect(res.realisedCLV).toBeNull();
    expect(res.realisedSteamVelocity).not.toBeNull();
  });

  it("falls back to KICKOFF_PROXY when the snapshot's snapshotAt is implausibly far from kickoff (postponement guard)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.includes("the-odds-api")
        ? [
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
          ]
        : fdFinishedResponse();
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const { resolveRecords } = await import("../src/resolveFixtures.js");
    const record = baseAnalysisRecord();
    // snapshotAt is 5 hours before kickoff — well outside the 45-min plausibility band.
    const snapshots = new Map([
      [
        "snap-test",
        {
          fixtureId: "snap-test",
          eventId: "sr:match:1",
          kickoff: "2026-06-01T15:00:00Z",
          snapshotAt: "2026-06-01T10:00:00Z",
          odds: { "1x2": { home: 1.7, draw: 3.5, away: 5.0 } },
        },
      ],
    ]);

    const { resolved } = await resolveRecords([record], "fd-key", "odds-key", undefined, snapshots);
    const res = resolved[0]!;
    expect(res.clvSourceQuality).toBe("KICKOFF_PROXY");
    expect(res.realisedSteamVelocity).toBeNull();
  });
});

// ── API-Football primary source + football-data.org fallback ────────────────

function baseRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    fixtureId: "af-test",
    home: "Mbeya City",
    away: "Simba SC",
    league: "Botola Pro",
    kickoff: "2026-06-19T13:00:00Z",
    lambdaH: 1.2,
    lambdaA: 1.1,
    probabilities: { home: 0.4, draw: 0.3, away: 0.3 },
    regime: "STANDARD",
    rankingMode: "CONFIDENCE_WEIGHTED" as const,
    evMarkets: [],
    llmPick: null,
    deterministicTopPick: null,
    frozenOddsAtAnalysis: null,
    liquidityTag: "CALIBRATION_ONLY" as const,
    analysedAt: "2026-06-19T09:00:00Z",
    ...overrides,
  };
}

describe("resolveRecords API-Football primary source", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves via API-Football without calling football-data.org", async () => {
    const fdSpy = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("football-data.org")) {
        fdSpy();
        return new Response(JSON.stringify({ matches: [] }), { status: 200 });
      }
      if (url.includes("api-sports.io")) {
        return new Response(
          JSON.stringify({
            response: [
              {
                fixture: { date: "2026-06-19T13:00:00+00:00", status: { short: "FT" } },
                teams: { home: { name: "Mbeya City" }, away: { name: "Simba SC" } },
                goals: { home: 1, away: 2 },
              },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { resolveRecords } = await import("../src/resolveFixtures.js");
    const { resolved, unmatched } = await resolveRecords(
      [baseRecord()],
      "fd-key",
      undefined,
      "af-key"
    );
    expect(unmatched).toEqual([]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.actualResult).toBe("away");
    expect(resolved[0]!.homeGoals).toBe(1);
    expect(resolved[0]!.awayGoals).toBe(2);
    expect(fdSpy).not.toHaveBeenCalled();
  });

  it("falls back to football-data.org when API-Football rejects the date (free-plan window)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("api-sports.io")) {
        // Free-plan date-window rejection: HTTP 200 with a populated `errors` object.
        return new Response(
          JSON.stringify({
            errors: { plan: "Free plans do not have access to this date" },
            response: [],
          }),
          { status: 200 }
        );
      }
      if (url.includes("football-data.org")) {
        return new Response(
          JSON.stringify({
            matches: [
              {
                id: 9,
                utcDate: "2026-06-19T13:00:00Z",
                status: "FINISHED",
                homeTeam: { name: "Mbeya City" },
                awayTeam: { name: "Simba SC" },
                score: { fullTime: { home: 0, away: 0 } },
              },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { resolveRecords } = await import("../src/resolveFixtures.js");
    const { resolved, unmatched } = await resolveRecords(
      [baseRecord()],
      "fd-key",
      undefined,
      "af-key"
    );
    expect(unmatched).toEqual([]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.actualResult).toBe("draw");
  });

  it("resolves with apiFootballKey alone (no footballDataApiKey)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("api-sports.io")) {
        return new Response(
          JSON.stringify({
            response: [
              {
                fixture: { date: "2026-06-19T13:00:00+00:00", status: { short: "FT" } },
                teams: { home: { name: "Mbeya City" }, away: { name: "Simba SC" } },
                goals: { home: 3, away: 0 },
              },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { resolveRecords } = await import("../src/resolveFixtures.js");
    const { resolved } = await resolveRecords([baseRecord()], undefined, undefined, "af-key");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.actualResult).toBe("home");
  });

  it("matches a World-Cup fixture by international-team alias (Ivory Coast vs Côte d'Ivoire)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("api-sports.io")) {
        return new Response(
          JSON.stringify({
            response: [
              {
                fixture: { date: "2026-06-19T17:00:00+00:00", status: { short: "FT" } },
                // API-Football's canonical spelling differs from ORACLE's analysis-record spelling.
                teams: { home: { name: "Côte d'Ivoire" }, away: { name: "Iran" } },
                goals: { home: 2, away: 1 },
              },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { resolveRecords } = await import("../src/resolveFixtures.js");
    const record = baseRecord({
      home: "Ivory Coast",
      away: "IR Iran",
      league: "FIFA World Cup",
      kickoff: "2026-06-19T17:00:00Z",
    });
    const { resolved, unmatched } = await resolveRecords([record], undefined, undefined, "af-key");
    expect(unmatched).toEqual([]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.actualResult).toBe("home");
  });
});

// ── Sharp-reference CLV integration via resolveRecords (P1-4, Wave 2) ─────────

describe("resolveRecords sharp-reference CLV (P1-4)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("carries pick_odds/source through and computes realisedSharpClv when both endpoints are captured", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify(fdFinishedResponse()), { status: 200 })
    );

    const { resolveRecords } = await import("../src/resolveFixtures.js");
    const record = baseAnalysisRecord();
    const sharpOddsByFixture = new Map([
      [
        "snap-test",
        {
          id: "snap-test::1X2::home",
          fixtureKey: "snap-test",
          market: "1X2",
          side: "home",
          pick_odds: 1.9,
          sharp_fair_at_pick: 1.95,
          sharp_fair_at_close: 1.8,
          source: "odds_api",
          sharp_fair_at_close_source: "ai_mode_fallback",
          capturedAt: "2026-06-01T09:00:00Z",
          closeCapturedAt: "2026-06-01T14:35:00Z",
        },
      ],
    ]);

    const { resolved } = await resolveRecords(
      [record],
      "fd-key",
      undefined,
      undefined,
      undefined,
      sharpOddsByFixture
    );
    expect(resolved).toHaveLength(1);
    const res = resolved[0]!;
    expect(res.pickOdds).toBe(1.9);
    expect(res.sharpFairAtPick).toBe(1.95);
    expect(res.sharpFairAtPickSource).toBe("odds_api");
    expect(res.sharpFairAtClose).toBe(1.8);
    expect(res.sharpFairAtCloseSource).toBe("ai_mode_fallback");
    expect(res.realisedSharpClv).not.toBeNull();
    expect(res.realisedSharpClv!).toBeCloseTo(1 / 1.8 - 1 / 1.95, 6);
  });

  it("leaves every sharp field null (never throws) when no SharpOddsRecord exists for the fixture", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify(fdFinishedResponse()), { status: 200 })
    );

    const { resolveRecords } = await import("../src/resolveFixtures.js");
    const record = baseAnalysisRecord();

    const { resolved } = await resolveRecords([record], "fd-key");
    expect(resolved).toHaveLength(1);
    const res = resolved[0]!;
    expect(res.pickOdds).toBeNull();
    expect(res.sharpFairAtPick).toBeNull();
    expect(res.sharpFairAtPickSource).toBeNull();
    expect(res.sharpFairAtClose).toBeNull();
    expect(res.sharpFairAtCloseSource).toBeNull();
    expect(res.realisedSharpClv).toBeNull();
  });

  it("leaves realisedSharpClv null when only sharp_fair_at_pick was captured (close not yet swept)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify(fdFinishedResponse()), { status: 200 })
    );

    const { resolveRecords } = await import("../src/resolveFixtures.js");
    const record = baseAnalysisRecord();
    const sharpOddsByFixture = new Map([
      [
        "snap-test",
        {
          id: "snap-test::1X2::home",
          fixtureKey: "snap-test",
          market: "1X2",
          side: "home",
          pick_odds: 1.9,
          sharp_fair_at_pick: 1.95,
          sharp_fair_at_close: null,
          source: "odds_api",
          capturedAt: "2026-06-01T09:00:00Z",
        },
      ],
    ]);

    const { resolved } = await resolveRecords(
      [record],
      "fd-key",
      undefined,
      undefined,
      undefined,
      sharpOddsByFixture
    );
    const res = resolved[0]!;
    expect(res.sharpFairAtPick).toBe(1.95);
    expect(res.sharpFairAtPickSource).toBe("odds_api");
    expect(res.sharpFairAtClose).toBeNull();
    expect(res.realisedSharpClv).toBeNull();
  });

  it("still computes realisedSharpClv for a CALIBRATION_ONLY record — independent of the liquidityTag gate that guards realisedCLV", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("api-sports.io")) {
        return new Response(
          JSON.stringify({
            response: [
              {
                fixture: { date: "2026-06-19T13:00:00+00:00", status: { short: "FT" } },
                teams: { home: { name: "Mbeya City" }, away: { name: "Simba SC" } },
                goals: { home: 1, away: 0 },
              },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { resolveRecords } = await import("../src/resolveFixtures.js");
    const record = baseRecord(); // CALIBRATION_ONLY, frozenOddsAtAnalysis: null
    const sharpOddsByFixture = new Map([
      [
        "af-test",
        {
          id: "af-test::1X2::home",
          fixtureKey: "af-test",
          market: "1X2",
          side: "home",
          pick_odds: 1.6,
          sharp_fair_at_pick: 1.65,
          sharp_fair_at_close: 1.5,
          source: "odds_api",
          sharp_fair_at_close_source: "odds_api",
          capturedAt: "2026-06-19T09:00:00Z",
          closeCapturedAt: "2026-06-19T12:35:00Z",
        },
      ],
    ]);

    const { resolved } = await resolveRecords(
      [record],
      undefined,
      undefined,
      "af-key",
      undefined,
      sharpOddsByFixture
    );
    const res = resolved[0]!;
    // realisedCLV stays null (CALIBRATION_ONLY never gets the SportyBet-line metric)...
    expect(res.realisedCLV).toBeNull();
    // ...but realisedSharpClv is computed regardless, since it doesn't gate on liquidityTag.
    expect(res.realisedSharpClv).not.toBeNull();
    expect(res.realisedSharpClv!).toBeCloseTo(1 / 1.5 - 1 / 1.65, 6);
  });
});
