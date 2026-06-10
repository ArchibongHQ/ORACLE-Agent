import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOddsProviders,
  type NormalizedOdds,
  type OddsProvider,
  runOddsChain,
} from "../src/oddsProviders.js";

// ── Test doubles ──────────────────────────────────────────────────────────────

function fakeProvider(
  name: string,
  tier: number,
  isSharp: boolean,
  result: NormalizedOdds | null,
  opts: { hasQuota?: boolean; throws?: boolean; onFetch?: () => void } = {}
): OddsProvider {
  return {
    name,
    tier,
    isSharp,
    hasQuota: () => opts.hasQuota ?? true,
    async fetch() {
      opts.onFetch?.();
      if (opts.throws) throw new Error(`${name}: boom`);
      return result;
    },
  };
}

const odds = (provider: string, isSharp: boolean): NormalizedOdds => ({
  home: 2.0,
  draw: 3.4,
  away: 4.0,
  confidence: isSharp ? 0.85 : 0.7,
  sources: [provider],
  overround: 1 / 2 + 1 / 3.4 + 1 / 4 - 1,
  provider,
  isSharp,
});

const FX = ["Arsenal", "Chelsea", "Premier League", "2026-06-09T15:00:00Z"] as const;

// ── runOddsChain ──────────────────────────────────────────────────────────────

describe("runOddsChain", () => {
  it("stops at the first sharp provider and skips lower tiers", async () => {
    const tier3 = vi.fn();
    const providers = [
      fakeProvider("oddspapi", 2, true, odds("oddspapi", true)),
      fakeProvider("api-football", 3, false, odds("api-football", false), { onFetch: tier3 }),
    ];
    const res = await runOddsChain(providers, ...FX);
    expect(res?.provider).toBe("oddspapi");
    expect(tier3).not.toHaveBeenCalled(); // short-circuited on first sharp
  });

  it("skips providers without quota", async () => {
    const exhausted = vi.fn();
    const providers = [
      fakeProvider("oddspapi", 2, true, odds("oddspapi", true), {
        hasQuota: false,
        onFetch: exhausted,
      }),
      fakeProvider("api-football", 3, false, odds("api-football", false)),
    ];
    const res = await runOddsChain(providers, ...FX);
    expect(exhausted).not.toHaveBeenCalled(); // no-quota provider never fetched
    expect(res?.provider).toBe("api-football");
  });

  it("prefers a later sharp result over an earlier soft result", async () => {
    const providers = [
      fakeProvider("api-football", 3, false, odds("api-football", false)),
      fakeProvider("sportsgameodds", 4, true, odds("sportsgameodds", true)),
    ];
    const res = await runOddsChain(providers, ...FX);
    expect(res?.provider).toBe("sportsgameodds"); // sharp wins even though soft came first
    expect(res?.isSharp).toBe(true);
  });

  it("returns the soft result when no sharp source produces odds", async () => {
    const providers = [
      fakeProvider("oddspapi", 2, true, null), // sharp but empty
      fakeProvider("api-football", 3, false, odds("api-football", false)),
    ];
    const res = await runOddsChain(providers, ...FX);
    expect(res?.provider).toBe("api-football");
    expect(res?.isSharp).toBe(false);
  });

  it("treats a throwing provider as non-fatal and continues", async () => {
    const providers = [
      fakeProvider("oddspapi", 2, true, null, { throws: true }),
      fakeProvider("api-football", 3, false, odds("api-football", false)),
    ];
    const res = await runOddsChain(providers, ...FX);
    expect(res?.provider).toBe("api-football");
  });

  it("returns null when the whole chain is empty (caller falls through to Gemini)", async () => {
    const providers = [
      fakeProvider("oddspapi", 2, true, null),
      fakeProvider("api-football", 3, false, null),
    ];
    expect(await runOddsChain(providers, ...FX)).toBeNull();
  });
});

// ── buildOddsProviders registry ───────────────────────────────────────────────

describe("buildOddsProviders", () => {
  it("registers all five providers in tier order", () => {
    const providers = buildOddsProviders({});
    expect(providers.map((p) => p.name)).toEqual([
      "oddspapi",
      "api-football",
      "odds-api-io",
      "sportsgameodds",
      "bsd",
    ]);
    expect(providers.map((p) => p.tier)).toEqual([2, 3, 4, 5, 6]);
  });

  it("marks OddsPapi, Odds-API.io and SportsGameOdds as sharp", () => {
    const sharp = buildOddsProviders({})
      .filter((p) => p.isSharp)
      .map((p) => p.name);
    expect(sharp).toEqual(["oddspapi", "odds-api-io", "sportsgameodds"]);
  });

  it("reports no quota for providers without a key", () => {
    const providers = buildOddsProviders({});
    expect(providers.every((p) => !p.hasQuota())).toBe(true);
  });

  it("reports quota only for wired providers once their key is present", () => {
    const providers = buildOddsProviders({
      oddsPapiKey: "k",
      apiFootballKey: "k2",
      oddsApiIoKey: "k3",
      sportsGameOddsKey: "k4",
    });
    const withQuota = providers.filter((p) => p.hasQuota()).map((p) => p.name);
    expect(withQuota).toEqual(["oddspapi", "api-football", "odds-api-io", "sportsgameodds"]);
  });

  it("never grants quota to stub providers even with a key (not implemented)", () => {
    const providers = buildOddsProviders({ bsdKey: "k" });
    const stubs = providers.filter((p) => p.name === "bsd");
    expect(stubs.every((p) => !p.hasQuota())).toBe(true);
  });
});

// ── Live-fetch parsing (mocked HTTP) ──────────────────────────────────────────
// Exercises the documented response schemas end-to-end. If a live response shows
// a different shape, update these fixtures — the parser logic stays the same.

describe("OddsPapi provider fetch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves a fixture and parses the Pinnacle 1X2 triple as sharp", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/fixtures")) {
        return new Response(
          JSON.stringify({
            fixtures: [
              { fixtureId: "fx-1", participant1Name: "Arsenal FC", participant2Name: "Chelsea FC" },
            ],
          }),
          { status: 200 }
        );
      }
      // /odds
      return new Response(
        JSON.stringify({
          bookmakerOdds: {
            pinnacle: {
              markets: {
                "101": {
                  outcomes: {
                    "101": { players: { "0": { price: 2.05 } } },
                    "102": { players: { "0": { price: 3.5 } } },
                    "103": { players: { "0": { price: 3.8 } } },
                  },
                },
              },
            },
          },
        }),
        { status: 200 }
      );
    });

    const [oddspapi] = buildOddsProviders({ oddsPapiKey: "k" });
    const res = await oddspapi!.fetch(...FX);
    expect(res).not.toBeNull();
    expect(res!.isSharp).toBe(true);
    expect(res!.home).toBe(2.05);
    expect(res!.draw).toBe(3.5);
    expect(res!.away).toBe(3.8);
    expect(res!.confidence).toBe(0.85);
    expect(res!.provider).toBe("oddspapi");
    expect(res!.overround).toBeGreaterThan(0);
    expect(res!.sources[0]).toContain("pinnacle");
  });

  it("returns null when no fixture matches the team names", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ fixtures: [] }), { status: 200 })
    );
    const [oddspapi] = buildOddsProviders({ oddsPapiKey: "k" });
    expect(await oddspapi!.fetch(...FX)).toBeNull();
  });
});

describe("API-Football provider fetch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves the fixture id then parses the Match Winner bet into a consensus (non-sharp) triple", async () => {
    // Live-verified two-step shape: /fixtures carries team names (used to resolve
    // the id), /odds?fixture= carries bookmakers only (no `teams` field).
    const spy = vi.spyOn(globalThis, "fetch");
    // Step 1: /fixtures?date= — name-match resolves to fixture id 42.
    spy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          response: [
            {
              fixture: { id: 42 },
              teams: { home: { name: "Arsenal" }, away: { name: "Chelsea" } },
            },
          ],
        }),
        { status: 200 }
      )
    );
    // Step 2: /odds?fixture=42 — bookmakers only, no team names (real shape).
    spy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          response: [
            {
              fixture: { id: 42, date: "2026-06-09T15:00:00Z" },
              bookmakers: [
                {
                  name: "Bet365",
                  bets: [
                    {
                      id: 1,
                      name: "Match Winner",
                      values: [
                        { value: "Home", odd: "2.10" },
                        { value: "Draw", odd: "3.40" },
                        { value: "Away", odd: "3.60" },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        { status: 200 }
      )
    );
    const providers = buildOddsProviders({ apiFootballKey: "k" });
    const apiFootball = providers.find((p) => p.name === "api-football")!;
    const res = await apiFootball.fetch(...FX);
    expect(res).not.toBeNull();
    expect(res!.isSharp).toBe(false);
    expect(res!.home).toBe(2.1);
    expect(res!.draw).toBe(3.4);
    // Step 2 must be scoped to the resolved fixture id, not a bulk date query.
    expect(String(spy.mock.calls[1]![0])).toContain("fixture=42");
  });
});

describe("Odds-API.io provider fetch", () => {
  afterEach(() => vi.restoreAllMocks());

  const mockEventsAndOdds = (bookmakers: Record<string, unknown>) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/events")) {
        return new Response(
          JSON.stringify([
            { id: 9001, home: "Arsenal FC", away: "Chelsea FC", date: "2026-06-09T15:00:00Z" },
          ]),
          { status: 200 }
        );
      }
      // /odds
      return new Response(JSON.stringify({ bookmakers }), { status: 200 });
    });

  it("resolves the event then parses a SingBet ML triple as sharp", async () => {
    const spy = mockEventsAndOdds({
      SingBet: [{ name: "ML", odds: [{ home: "2.10", draw: "3.40", away: "3.20" }] }],
    });
    const providers = buildOddsProviders({ oddsApiIoKey: "k" });
    const oddsApiIo = providers.find((p) => p.name === "odds-api-io")!;
    const res = await oddsApiIo.fetch(...FX);
    expect(res).not.toBeNull();
    expect(res!.isSharp).toBe(true);
    expect(res!.home).toBe(2.1); // string prices parsed to numbers
    expect(res!.draw).toBe(3.4);
    expect(res!.sources[0]).toBe("odds-api-io:SingBet");
    // Odds call must be scoped to the resolved event id.
    expect(String(spy.mock.calls[1]![0])).toContain("eventId=9001");
  });

  it("falls back to a soft book when no sharp book returns the ML market", async () => {
    mockEventsAndOdds({
      Bet365: [{ name: "ML", odds: [{ home: "2.05", draw: "3.50", away: "3.30" }] }],
    });
    const providers = buildOddsProviders({ oddsApiIoKey: "k" });
    const oddsApiIo = providers.find((p) => p.name === "odds-api-io")!;
    const res = await oddsApiIo.fetch(...FX);
    expect(res).not.toBeNull();
    expect(res!.isSharp).toBe(false);
    expect(res!.confidence).toBe(0.7);
  });

  it("rejects an implausible triple via validateTriple", async () => {
    mockEventsAndOdds({
      SingBet: [{ name: "ML", odds: [{ home: "1.001", draw: "3.40", away: "3.20" }] }],
    });
    const providers = buildOddsProviders({ oddsApiIoKey: "k" });
    const oddsApiIo = providers.find((p) => p.name === "odds-api-io")!;
    expect(await oddsApiIo.fetch(...FX)).toBeNull();
  });

  it("throws on 429 so the chain skips it as quota-exhausted", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    const providers = buildOddsProviders({ oddsApiIoKey: "k" });
    const oddsApiIo = providers.find((p) => p.name === "odds-api-io")!;
    await expect(oddsApiIo.fetch(...FX)).rejects.toThrow("quota exhausted");
  });

  it("returns null when no event matches the team names", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 })
    );
    const providers = buildOddsProviders({ oddsApiIoKey: "k" });
    const oddsApiIo = providers.find((p) => p.name === "odds-api-io")!;
    expect(await oddsApiIo.fetch(...FX)).toBeNull();
  });

  it("handles the { events: [...] } wrapper response shape", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/events")) {
        // Wrapped shape (not a bare array)
        return new Response(
          JSON.stringify({
            events: [
              { id: 9002, home: "Arsenal FC", away: "Chelsea FC", date: "2026-06-09T15:00:00Z" },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          bookmakers: {
            Pinnacle: [{ name: "ML", odds: [{ home: "2.10", draw: "3.40", away: "3.20" }] }],
          },
        }),
        { status: 200 }
      );
    });
    const providers = buildOddsProviders({ oddsApiIoKey: "k" });
    const oddsApiIo = providers.find((p) => p.name === "odds-api-io")!;
    const res = await oddsApiIo.fetch(...FX);
    expect(res).not.toBeNull();
    expect(res!.home).toBe(2.1);
  });

  it("rejects an event whose kickoff date does not match the fixture date", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/events")) {
        return new Response(
          JSON.stringify([
            // same teams but DIFFERENT date (next day)
            { id: 9003, home: "Arsenal FC", away: "Chelsea FC", date: "2026-06-10T15:00:00Z" },
          ]),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ bookmakers: {} }), { status: 200 });
    });
    const providers = buildOddsProviders({ oddsApiIoKey: "k" });
    const oddsApiIo = providers.find((p) => p.name === "odds-api-io")!;
    // FX kickoff is 2026-06-09, event is 2026-06-10 → no match
    expect(await oddsApiIo.fetch(...FX)).toBeNull();
  });
});

describe("SportsGameOdds provider fetch", () => {
  afterEach(() => vi.restoreAllMocks());

  const sgoEvent = (odds: Record<string, unknown>) => ({
    data: [
      {
        eventID: "ev-1",
        teams: { home: { names: { long: "Arsenal FC" } }, away: { names: { long: "Chelsea FC" } } },
        odds,
      },
    ],
  });

  it("converts Pinnacle American odds to decimal and flags the result sharp", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          sgoEvent({
            "points-home-game-ml3way-home": {
              odds: "+115",
              byBookmaker: { pinnacle: { odds: "+110", available: true } },
            },
            "points-all-game-ml3way-draw": {
              odds: "+240",
              byBookmaker: { pinnacle: { odds: "+245", available: true } },
            },
            "points-away-game-ml3way-away": {
              odds: "+220",
              byBookmaker: { pinnacle: { odds: "+225", available: true } },
            },
          })
        ),
        { status: 200 }
      )
    );
    const providers = buildOddsProviders({ sportsGameOddsKey: "k" });
    const sgo = providers.find((p) => p.name === "sportsgameodds")!;
    const res = await sgo.fetch(...FX);
    expect(res).not.toBeNull();
    expect(res!.isSharp).toBe(true);
    expect(res!.home).toBeCloseTo(2.1, 5); // +110 → 2.10
    expect(res!.draw).toBeCloseTo(3.45, 5); // +245 → 3.45
    expect(res!.away).toBeCloseTo(3.25, 5); // +225 → 3.25
    expect(res!.sources[0]).toBe("sportsgameodds:pinnacle");
  });

  it("falls back to consensus odds (non-sharp) when Pinnacle is missing a side", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          sgoEvent({
            "points-home-game-ml3way-home": {
              odds: "-110", // -110 → 1.909…
              byBookmaker: { pinnacle: { odds: "+110", available: true } },
            },
            "points-all-game-ml3way-draw": { odds: "+250" }, // no pinnacle side
            "points-away-game-ml3way-away": { odds: "+260" },
          })
        ),
        { status: 200 }
      )
    );
    const providers = buildOddsProviders({ sportsGameOddsKey: "k" });
    const sgo = providers.find((p) => p.name === "sportsgameodds")!;
    const res = await sgo.fetch(...FX);
    expect(res).not.toBeNull();
    expect(res!.isSharp).toBe(false);
    expect(res!.home).toBeCloseTo(1 + 100 / 110, 5); // negative American conversion
    expect(res!.sources[0]).toBe("sportsgameodds:consensus");
  });

  it("returns null when the 3-way moneyline market is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(sgoEvent({})), { status: 200 })
    );
    const providers = buildOddsProviders({ sportsGameOddsKey: "k" });
    const sgo = providers.find((p) => p.name === "sportsgameodds")!;
    expect(await sgo.fetch(...FX)).toBeNull();
  });

  it("returns null when no event matches the team names", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    const providers = buildOddsProviders({ sportsGameOddsKey: "k" });
    const sgo = providers.find((p) => p.name === "sportsgameodds")!;
    expect(await sgo.fetch(...FX)).toBeNull();
  });

  it("throws on 429 so the chain skips it as quota-exhausted", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    const providers = buildOddsProviders({ sportsGameOddsKey: "k" });
    const sgo = providers.find((p) => p.name === "sportsgameodds")!;
    await expect(sgo.fetch(...FX)).rejects.toThrow("quota exhausted");
  });

  it("returns null when consensus odds are non-numeric or zero (americanToDecimal edge cases)", async () => {
    // "0" and "abc" should both produce NaN → validateTriple rejects → null
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          sgoEvent({
            "points-home-game-ml3way-home": { odds: "0" },
            "points-all-game-ml3way-draw": { odds: "abc" },
            "points-away-game-ml3way-away": { odds: "+220" },
          })
        ),
        { status: 200 }
      )
    );
    const providers = buildOddsProviders({ sportsGameOddsKey: "k" });
    const sgo = providers.find((p) => p.name === "sportsgameodds")!;
    expect(await sgo.fetch(...FX)).toBeNull();
  });
});
