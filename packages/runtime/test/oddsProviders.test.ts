import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOddsProviders,
  runOddsChain,
  type NormalizedOdds,
  type OddsProvider,
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
      "sportsgameodds",
      "rapidoddsapi",
      "bsd",
    ]);
    expect(providers.map((p) => p.tier)).toEqual([2, 3, 4, 5, 6]);
  });

  it("marks only OddsPapi and SportsGameOdds as sharp", () => {
    const sharp = buildOddsProviders({}).filter((p) => p.isSharp).map((p) => p.name);
    expect(sharp).toEqual(["oddspapi", "sportsgameodds"]);
  });

  it("reports no quota for providers without a key", () => {
    const providers = buildOddsProviders({});
    expect(providers.every((p) => !p.hasQuota())).toBe(true);
  });

  it("reports quota only for wired providers once their key is present", () => {
    const providers = buildOddsProviders({ oddsPapiKey: "k", apiFootballKey: "k2" });
    const withQuota = providers.filter((p) => p.hasQuota()).map((p) => p.name);
    expect(withQuota).toEqual(["oddspapi", "api-football"]);
  });

  it("never grants quota to stub providers even with a key (not implemented)", () => {
    const providers = buildOddsProviders({ sportsGameOddsKey: "k", rapidOddsApiKey: "k", bsdKey: "k" });
    const stubs = providers.filter((p) => ["sportsgameodds", "rapidoddsapi", "bsd"].includes(p.name));
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

  it("parses the Match Winner bet into a consensus (non-sharp) triple", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          response: [
            {
              fixture: { id: 42, date: "2026-06-09T15:00:00Z" },
              teams: { home: { name: "Arsenal" }, away: { name: "Chelsea" } },
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
  });
});
