/** Structured free-API odds fallback chain.
 *
 *  Sits between the-odds-api (primary, paid) and the Gemini/web-search degraded
 *  paths in fixtures.ts. Each provider returns structured bookmaker JSON, which
 *  always beats LLM-scraped prose, so the whole chain is tried before falling
 *  through to geminiOddsGapFill.
 *
 *  Tier order (lowest tier number first). "Stop at first sharp" — the chain halts
 *  the moment a provider with isSharp=true returns a result; soft-book providers
 *  only fire when every sharp source above is empty or over quota.
 *
 *    1  the-odds-api      (handled upstream in fixtures.ts — not in this chain)
 *    2  OddsPapi          sharp  — Pinnacle/Singbet              [WIRED]
 *    3  API-Football      net    — permanent free tier           [WIRED]
 *    4  SportsGameOdds    sharp  — Pinnacle                       [STUB]
 *    5  RapidOddsAPI      soft   — consensus                      [STUB]
 *    6  BSD / bzzoiro     soft   — no-rate-limit floor            [STUB]
 *    7  geminiOddsGapFill (handled upstream — last resort)
 *
 *  Providers whose key is absent are skipped silently (config.ts pattern).
 */
import { namesMatch } from "./teamNames.js";

/** 1X2 consensus result. Field-compatible with @oracle/llm OddsAcquisitionResult
 *  so it drops straight into the state-building in fixtures.ts geminiOddsGapFill. */
export interface NormalizedOdds {
  home: number;
  draw: number;
  away: number;
  /** 0–1 confidence — sharp single-source ≈ 0.8, soft consensus lower. */
  confidence: number;
  sources: string[];
  overround: number;
  /** Provider name, surfaced as odds_source for telemetry. */
  provider: string;
  /** True when the price came from a sharp book (Pinnacle/Singbet). */
  isSharp: boolean;
}

export interface OddsProvider {
  name: string;
  /** Lower runs first. */
  tier: number;
  /** Sharp books trigger the "stop at first sharp" short-circuit. */
  isSharp: boolean;
  /** False → skipped silently (missing key or exhausted quota). */
  hasQuota(): boolean;
  /** Resolve 1X2 odds for one fixture, or null if not found / parse failed. */
  fetch(
    home: string,
    away: string,
    league: string,
    kickoff: string
  ): Promise<NormalizedOdds | null>;
}

// ── Validation (mirrors callOdds.ts thresholds) ────────────────────────────────

const MIN_PRICE = 1.01;
const MAX_PRICE = 50;
const MIN_OVERROUND = 0.02;
const MAX_OVERROUND = 0.2;

/** Validate a raw 1X2 triple and compute overround. Returns null if implausible. */
function validateTriple(h: number, d: number, a: number): { overround: number } | null {
  for (const v of [h, d, a]) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < MIN_PRICE || v > MAX_PRICE) {
      return null;
    }
  }
  const overround = 1 / h + 1 / d + 1 / a - 1;
  if (overround < MIN_OVERROUND || overround > MAX_OVERROUND) return null;
  return { overround };
}

// Team-name matching (namesMatch) is imported from teamNames.ts — the single,
// alias-aware source of truth shared with fixtures.ts and the OTS name-gap fix.

// ── OddsPapi (tier 2, sharp) ───────────────────────────────────────────────────
// SCHEMA: confirmed via oddspapi.io docs (structure partly inferred). Verify the
// field paths below against one live response before trusting in production:
//   curl "https://api.oddspapi.io/v4/fixtures?apiKey=$K&date=2026-06-09"
//   curl "https://api.oddspapi.io/v4/odds?apiKey=$K&fixtureId=<id>"
const ODDSPAPI_BASE = "https://api.oddspapi.io/v4";
const ODDSPAPI_1X2_MARKET = "101"; // market id for 1X2
const ODDSPAPI_OUTCOMES = { home: "101", draw: "102", away: "103" } as const;
const ODDSPAPI_SHARP_BOOKS = ["pinnacle", "singbet", "betfair_ex"];

interface OddsPapiFixture {
  fixtureId: string;
  participant1Name: string;
  participant2Name: string;
  startTime?: string;
}
interface OddsPapiFixturesResponse {
  fixtures?: OddsPapiFixture[];
}
interface OddsPapiOddsResponse {
  bookmakerOdds?: Record<
    string,
    {
      markets?: Record<
        string,
        { outcomes?: Record<string, { players?: Record<string, { price?: number }> }> }
      >;
    }
  >;
}

/** Extract a sharp (or first-available) 1X2 triple from an OddsPapi /odds payload. */
function parseOddsPapiOdds(
  raw: OddsPapiOddsResponse
): { h: number; d: number; a: number; book: string; sharp: boolean } | null {
  const books = raw.bookmakerOdds ?? {};
  const slugs = Object.keys(books);
  // Prefer sharp books; fall back to first book that has a full 1X2.
  const ordered = [
    ...ODDSPAPI_SHARP_BOOKS.filter((s) => slugs.includes(s)),
    ...slugs.filter((s) => !ODDSPAPI_SHARP_BOOKS.includes(s)),
  ];
  for (const slug of ordered) {
    const outcomes = books[slug]?.markets?.[ODDSPAPI_1X2_MARKET]?.outcomes;
    if (!outcomes) continue;
    const price = (id: string) => outcomes[id]?.players?.["0"]?.price;
    const h = price(ODDSPAPI_OUTCOMES.home);
    const d = price(ODDSPAPI_OUTCOMES.draw);
    const a = price(ODDSPAPI_OUTCOMES.away);
    if (h == null || d == null || a == null) continue;
    return { h, d, a, book: slug, sharp: ODDSPAPI_SHARP_BOOKS.includes(slug) };
  }
  return null;
}

export function makeOddsPapiProvider(apiKey: string | undefined): OddsProvider {
  return {
    name: "oddspapi",
    tier: 2,
    isSharp: true,
    hasQuota: () => !!apiKey,
    async fetch(home, away, _league, kickoff) {
      if (!apiKey) return null;
      const date = kickoff.slice(0, 10);
      // 1. Resolve fixtureId by team-name match on the date.
      const fxRes = await fetch(
        `${ODDSPAPI_BASE}/fixtures?apiKey=${encodeURIComponent(apiKey)}&date=${date}`,
        { signal: AbortSignal.timeout(15_000) }
      );
      if (!fxRes.ok) {
        if (fxRes.status === 429) throw new Error("oddspapi: quota exhausted");
        return null;
      }
      const fxJson = (await fxRes.json()) as OddsPapiFixturesResponse;
      const fixture = (fxJson.fixtures ?? []).find(
        (f) => namesMatch(f.participant1Name, home) && namesMatch(f.participant2Name, away)
      );
      if (!fixture) return null;

      // 2. Fetch odds for that fixture.
      const oddsRes = await fetch(
        `${ODDSPAPI_BASE}/odds?apiKey=${encodeURIComponent(apiKey)}&fixtureId=${encodeURIComponent(fixture.fixtureId)}`,
        { signal: AbortSignal.timeout(15_000) }
      );
      if (!oddsRes.ok) {
        if (oddsRes.status === 429) throw new Error("oddspapi: quota exhausted");
        return null;
      }
      const parsed = parseOddsPapiOdds((await oddsRes.json()) as OddsPapiOddsResponse);
      if (!parsed) return null;
      const valid = validateTriple(parsed.h, parsed.d, parsed.a);
      if (!valid) return null;
      return {
        home: parsed.h,
        draw: parsed.d,
        away: parsed.a,
        confidence: parsed.sharp ? 0.85 : 0.7,
        sources: [`oddspapi:${parsed.book}`],
        overround: valid.overround,
        provider: "oddspapi",
        isSharp: parsed.sharp,
      };
    },
  };
}

// ── API-Football (tier 3, permanent free net) ──────────────────────────────────
// SCHEMA (machine-verified 2026-06-09 against a live response): the /odds endpoint
// does NOT return team names — its rows carry only { league, fixture:{id,date},
// bookmakers:[...] } with `teams` absent. Names must be resolved separately via
// /fixtures. So this provider is a two-step join:
//   1. GET /fixtures?date=<d>   -> rows with teams.home.name / teams.away.name; name-match here
//   2. GET /odds?fixture=<id>&bet=1 -> bookmakers[].bets[id==1].values[{value:Home/Draw/Away,odd}]
// Verified value labels are exactly "Home"/"Draw"/"Away"; odds are strings.
const APIFOOTBALL_BASE = "https://v3.football.api-sports.io";
const APIFOOTBALL_1X2_BET_ID = 1; // "Match Winner"
const APIFOOTBALL_VALUE_LABELS = { home: "Home", draw: "Draw", away: "Away" } as const;

interface ApiFootballValue {
  value: string;
  odd: string;
}
interface ApiFootballBet {
  id: number;
  name: string;
  values: ApiFootballValue[];
}
interface ApiFootballBookmaker {
  name: string;
  bets: ApiFootballBet[];
}
interface ApiFootballRow {
  fixture?: { id?: number; date?: string };
  teams?: { home?: { name?: string }; away?: { name?: string } };
  bookmakers?: ApiFootballBookmaker[];
}
interface ApiFootballResponse {
  response?: ApiFootballRow[];
}
// /fixtures rows DO carry team names (unlike /odds), used to resolve the fixture id.
interface ApiFootballFixtureRow {
  fixture?: { id?: number };
  teams?: { home?: { name?: string }; away?: { name?: string } };
}
interface ApiFootballFixturesResponse {
  response?: ApiFootballFixtureRow[];
}

/** Extract the 1X2 triple from an API-Football odds row. */
function parseApiFootballRow(
  row: ApiFootballRow
): { h: number; d: number; a: number; book: string } | null {
  for (const bk of row.bookmakers ?? []) {
    const bet = bk.bets?.find((b) => b.id === APIFOOTBALL_1X2_BET_ID);
    if (!bet) continue;
    const odd = (label: string) => Number(bet.values.find((v) => v.value === label)?.odd ?? NaN);
    const h = odd(APIFOOTBALL_VALUE_LABELS.home);
    const d = odd(APIFOOTBALL_VALUE_LABELS.draw);
    const a = odd(APIFOOTBALL_VALUE_LABELS.away);
    if ([h, d, a].some((v) => !Number.isFinite(v))) continue;
    return { h, d, a, book: bk.name };
  }
  return null;
}

export function makeApiFootballProvider(apiKey: string | undefined): OddsProvider {
  return {
    name: "api-football",
    tier: 3,
    isSharp: false, // consensus net, not a sharp single source
    hasQuota: () => !!apiKey,
    async fetch(home, away, _league, kickoff) {
      if (!apiKey) return null;
      const date = kickoff.slice(0, 10);
      const headers = { "x-apisports-key": apiKey };
      // Step 1: resolve the fixture id by name-matching against /fixtures (the
      // /odds endpoint carries no team names, so the match must happen here).
      const fxRes = await fetch(`${APIFOOTBALL_BASE}/fixtures?date=${date}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!fxRes.ok) {
        if (fxRes.status === 429) throw new Error("api-football: quota exhausted");
        return null;
      }
      const fxJson = (await fxRes.json()) as ApiFootballFixturesResponse;
      const fixtureId = (fxJson.response ?? []).find(
        (f) =>
          namesMatch(f.teams?.home?.name ?? "", home) && namesMatch(f.teams?.away?.name ?? "", away)
      )?.fixture?.id;
      if (!fixtureId) return null;
      // Step 2: fetch odds scoped to that fixture id.
      const res = await fetch(
        `${APIFOOTBALL_BASE}/odds?fixture=${fixtureId}&bet=${APIFOOTBALL_1X2_BET_ID}`,
        { headers, signal: AbortSignal.timeout(15_000) }
      );
      if (!res.ok) {
        if (res.status === 429) throw new Error("api-football: quota exhausted");
        return null;
      }
      const json = (await res.json()) as ApiFootballResponse;
      const row = (json.response ?? [])[0];
      if (!row) return null;
      const parsed = parseApiFootballRow(row);
      if (!parsed) return null;
      const valid = validateTriple(parsed.h, parsed.d, parsed.a);
      if (!valid) return null;
      return {
        home: parsed.h,
        draw: parsed.d,
        away: parsed.a,
        confidence: 0.72,
        sources: [`api-football:${parsed.book}`],
        overround: valid.overround,
        provider: "api-football",
        isSharp: false,
      };
    },
  };
}

// ── Stubs (tiers 4–6) ──────────────────────────────────────────────────────────
// Registered so the chain is complete; each is a one-function fill-in. They report
// hasQuota=false (no key wired) so the chain skips them today.

function makeStubProvider(
  name: string,
  tier: number,
  isSharp: boolean,
  apiKey: string | undefined
): OddsProvider {
  return {
    name,
    tier,
    isSharp,
    hasQuota: () => false, // not implemented — never selected until fetch() is written
    async fetch() {
      if (!apiKey) return null;
      throw new Error(`${name}: provider not implemented`);
    },
  };
}

export interface OddsProviderKeys {
  oddsPapiKey?: string;
  apiFootballKey?: string;
  sportsGameOddsKey?: string;
  rapidOddsApiKey?: string;
  bsdKey?: string;
}

/** Build the full provider registry in tier order. */
export function buildOddsProviders(keys: OddsProviderKeys): OddsProvider[] {
  return [
    makeOddsPapiProvider(keys.oddsPapiKey),
    makeApiFootballProvider(keys.apiFootballKey),
    makeStubProvider("sportsgameodds", 4, true, keys.sportsGameOddsKey),
    makeStubProvider("rapidoddsapi", 5, false, keys.rapidOddsApiKey),
    makeStubProvider("bsd", 6, false, keys.bsdKey),
  ].sort((a, b) => a.tier - b.tier);
}

/** Run the structured-provider fallback chain for one fixture.
 *
 *  Iterates providers in tier order, skipping those without quota. Stops and
 *  returns the moment a sharp provider yields a result. Soft results are held and
 *  returned only if no sharp source produced anything. Returns null when the whole
 *  chain is empty — caller then falls through to the Gemini/web-search path.
 */
export async function runOddsChain(
  providers: OddsProvider[],
  home: string,
  away: string,
  league: string,
  kickoff: string
): Promise<NormalizedOdds | null> {
  let softResult: NormalizedOdds | null = null;
  for (const provider of providers) {
    if (!provider.hasQuota()) continue;
    let result: NormalizedOdds | null = null;
    try {
      result = await provider.fetch(home, away, league, kickoff);
    } catch {
      // quota/network/parse error — non-fatal, try next provider
      continue;
    }
    if (!result) continue;
    if (result.isSharp) return result; // stop at first sharp
    if (!softResult) softResult = result; // remember best soft result, keep looking for a sharp
  }
  return softResult;
}
