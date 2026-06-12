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
 *    2  SharpAPI.io       sharp  — Pinnacle/SBOBet et al.        [WIRED]
 *    3  API-Football      net    — permanent free tier           [WIRED]
 *    4  Odds-API.io       sharp  — Pinnacle/SingBet, 100 req/hr free [WIRED]
 *    5  SportsGameOdds    sharp  — Pinnacle, 1,000 objects/mo free   [WIRED]
 *    6  BSD / bzzoiro     soft   — no-rate-limit floor            [STUB]
 *    7  geminiOddsGapFill (handled upstream — last resort)
 *
 *  Tier 4 runs before tier 5 deliberately: runOddsChain keeps hunting for a sharp
 *  price after a soft hit, so these tiers fire often — Odds-API.io's ~72k req/mo
 *  equivalent quota absorbs that traffic before SportsGameOdds' scarce 1,000/mo.
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

// ── SharpAPI.io (tier 2, sharp) ────────────────────────────────────────────────
// SCHEMA: machine-verified 2026-06-10 against live responses. One GET does it all:
//   curl -H "X-API-Key: $K" "https://api.sharpapi.io/api/v1/odds?sport=soccer&market=moneyline&date=<YYYY-MM-DD>&q=<team>"
// Each row is ONE selection at ONE book: { sportsbook, home_team, away_team,
// market_type:"moneyline", selection_type:"home"|"draw"|"away", odds_decimal,
// is_live, is_active, is_main_line, event_start_time }. Soccer moneyline is
// 3-way, so a full 1X2 needs three rows from the same sportsbook.
// (Replaced OddsPapi 2026-06-10: contact-sales B2B, no key, coded v4 schema was
// confirmed wrong — real v5 schema preserved in project memory if ever revived.)
const SHARPAPIIO_BASE = "https://api.sharpapi.io/api/v1";
const SHARPAPIIO_SHARP_BOOKS = ["pinnacle", "sbobet", "betonline", "bookmaker", "circa"];

interface SharpApiIoOddsRow {
  sportsbook?: string;
  home_team?: string;
  away_team?: string;
  market_type?: string;
  selection_type?: string;
  odds_decimal?: number;
  is_live?: boolean;
  is_active?: boolean;
  is_main_line?: boolean;
}
interface SharpApiIoOddsResponse {
  data?: SharpApiIoOddsRow[];
}

/** Assemble a sharp (or first-complete) 1X2 triple from SharpAPI.io odds rows. */
function parseSharpApiIoOdds(
  rows: SharpApiIoOddsRow[]
): { h: number; d: number; a: number; book: string; sharp: boolean } | null {
  // Group pregame main-line rows into per-book {home,draw,away} triples.
  const byBook = new Map<string, Partial<Record<"home" | "draw" | "away", number>>>();
  for (const r of rows) {
    if (!r.sportsbook || r.is_live || r.is_active === false || r.is_main_line === false) continue;
    if (r.market_type && r.market_type !== "moneyline") continue;
    const side = r.selection_type;
    if (side !== "home" && side !== "draw" && side !== "away") continue;
    if (typeof r.odds_decimal !== "number") continue;
    const triple = byBook.get(r.sportsbook) ?? {};
    triple[side] ??= r.odds_decimal;
    byBook.set(r.sportsbook, triple);
  }
  const books = [...byBook.keys()];
  const ordered = [
    ...SHARPAPIIO_SHARP_BOOKS.filter((s) => books.includes(s)),
    ...books.filter((s) => !SHARPAPIIO_SHARP_BOOKS.includes(s)),
  ];
  for (const book of ordered) {
    const t = byBook.get(book);
    if (t?.home == null || t.draw == null || t.away == null) continue;
    return {
      h: t.home,
      d: t.draw,
      a: t.away,
      book,
      sharp: SHARPAPIIO_SHARP_BOOKS.includes(book),
    };
  }
  return null;
}

export function makeSharpApiIoProvider(apiKey: string | undefined): OddsProvider {
  return {
    name: "sharpapi-io",
    tier: 2,
    isSharp: true,
    hasQuota: () => !!apiKey,
    async fetch(home, away, _league, kickoff) {
      if (!apiKey) return null;
      const date = kickoff.slice(0, 10);
      // Single call: filter server-side by date + full-text team search, then
      // pin the exact fixture client-side with alias-aware name matching.
      const url =
        `${SHARPAPIIO_BASE}/odds?sport=soccer&market=moneyline` +
        `&date=${date}&q=${encodeURIComponent(home)}&limit=100`;
      const res = await fetch(url, {
        headers: { "X-API-Key": apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        if (res.status === 429) throw new Error("sharpapi-io: quota exhausted");
        return null;
      }
      const json = (await res.json()) as SharpApiIoOddsResponse;
      const rows = (json.data ?? []).filter(
        (r) => namesMatch(r.home_team ?? "", home) && namesMatch(r.away_team ?? "", away)
      );
      if (!rows.length) return null;

      const parsed = parseSharpApiIoOdds(rows);
      if (!parsed) return null;
      const valid = validateTriple(parsed.h, parsed.d, parsed.a);
      if (!valid) return null;
      return {
        home: parsed.h,
        draw: parsed.d,
        away: parsed.a,
        confidence: parsed.sharp ? 0.85 : 0.7,
        sources: [`sharpapi-io:${parsed.book}`],
        overround: valid.overround,
        provider: "sharpapi-io",
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

// ── Odds-API.io (tier 4, sharp-capable) ────────────────────────────────────────
// SCHEMA: confirmed via docs.odds-api.io (guides/fetching-odds, 2026-06-10). Free
// tier: 100 req/hr, no card. Verify field paths against one live response:
//   curl "https://api.odds-api.io/v3/events?sport=football&apiKey=$K"
//   curl "https://api.odds-api.io/v3/odds?eventId=<id>&bookmakers=Pinnacle&apiKey=$K"
// /odds returns decimal prices as strings under the "ML" market (Home/Draw/Away).
const ODDSAPIIO_BASE = "https://api.odds-api.io/v3";
const ODDSAPIIO_SHARP_BOOKS = ["pinnacle", "singbet"];
const ODDSAPIIO_BOOKMAKERS = "Pinnacle,SingBet,Bet365"; // sharp first, Bet365 soft floor
const ODDSAPIIO_ML_MARKET = "ML";

interface OddsApiIoEvent {
  id: number | string;
  home?: string;
  away?: string;
  date?: string;
}
interface OddsApiIoMarket {
  name?: string;
  odds?: Array<{ home?: string | number; draw?: string | number; away?: string | number }>;
}
interface OddsApiIoOddsResponse {
  bookmakers?: Record<string, OddsApiIoMarket[]>;
}

/** Extract a sharp (or first-available) ML triple from an Odds-API.io /odds payload. */
function parseOddsApiIoOdds(
  raw: OddsApiIoOddsResponse
): { h: number; d: number; a: number; book: string; sharp: boolean } | null {
  const books = raw.bookmakers ?? {};
  const names = Object.keys(books);
  const ordered = [
    ...names.filter((n) => ODDSAPIIO_SHARP_BOOKS.includes(n.toLowerCase())),
    ...names.filter((n) => !ODDSAPIIO_SHARP_BOOKS.includes(n.toLowerCase())),
  ];
  for (const book of ordered) {
    const ml = (books[book] ?? []).find((m) => m.name === ODDSAPIIO_ML_MARKET)?.odds?.[0];
    if (!ml) continue;
    const h = Number(ml.home);
    const d = Number(ml.draw);
    const a = Number(ml.away);
    if ([h, d, a].some((v) => !Number.isFinite(v))) continue;
    return { h, d, a, book, sharp: ODDSAPIIO_SHARP_BOOKS.includes(book.toLowerCase()) };
  }
  return null;
}

export function makeOddsApiIoProvider(apiKey: string | undefined): OddsProvider {
  return {
    name: "odds-api-io",
    tier: 4,
    isSharp: true,
    hasQuota: () => !!apiKey,
    async fetch(home, away, _league, kickoff) {
      if (!apiKey) return null;
      const date = kickoff.slice(0, 10);
      // 1. Resolve the event id. Narrow to the kickoff day server-side so the
      //    payload stays small (provider mandates apiKey in query string, not header).
      const evRes = await fetch(
        `${ODDSAPIIO_BASE}/events?sport=football&startsAfter=${date}T00:00:00Z&startsBefore=${date}T23:59:59Z&apiKey=${encodeURIComponent(apiKey)}`,
        { signal: AbortSignal.timeout(15_000) }
      );
      if (!evRes.ok) {
        if (evRes.status === 429) throw new Error("odds-api-io: quota exhausted");
        return null;
      }
      const evJson = (await evRes.json()) as OddsApiIoEvent[] | { events?: OddsApiIoEvent[] };
      const events = Array.isArray(evJson) ? evJson : (evJson.events ?? []);
      const event = events.find(
        (e) =>
          namesMatch(e.home ?? "", home) &&
          namesMatch(e.away ?? "", away) &&
          (!e.date || e.date.slice(0, 10) === date)
      );
      if (!event) return null;

      // 2. Fetch odds for that event, sharp books first.
      const oddsRes = await fetch(
        `${ODDSAPIIO_BASE}/odds?eventId=${encodeURIComponent(String(event.id))}&bookmakers=${encodeURIComponent(ODDSAPIIO_BOOKMAKERS)}&apiKey=${encodeURIComponent(apiKey)}`,
        { signal: AbortSignal.timeout(15_000) }
      );
      if (!oddsRes.ok) {
        if (oddsRes.status === 429) throw new Error("odds-api-io: quota exhausted");
        return null;
      }
      const parsed = parseOddsApiIoOdds((await oddsRes.json()) as OddsApiIoOddsResponse);
      if (!parsed) return null;
      const valid = validateTriple(parsed.h, parsed.d, parsed.a);
      if (!valid) return null;
      return {
        home: parsed.h,
        draw: parsed.d,
        away: parsed.a,
        confidence: parsed.sharp ? 0.85 : 0.7,
        sources: [`odds-api-io:${parsed.book}`],
        overround: valid.overround,
        provider: "odds-api-io",
        isSharp: parsed.sharp,
      };
    },
  };
}

// ── SportsGameOdds (tier 5, sharp-capable) ─────────────────────────────────────
// SCHEMA: partially machine-verified live 2026-06-12 (one MLS event):
//   teams.{home,away}.names.{long,medium,short} and status.startsAt confirmed.
//   ml3way oddIDs + byBookmaker still doc-inferred only — the event had no priced
//   odds yet (MLS on World Cup break; re-verify when fixtures price up):
//   curl -H "X-Api-Key: $K" "https://api.sportsgameodds.com/v2/events?leagueID=MLS&startsAfter=<date>&oddsAvailable=true&limit=50"
// Free tier bills per OBJECT RETURNED (1,000/mo) — keep limit tight, never page.
// Free tier REQUIRES leagueID (sportID-wide queries 400: "must specify a leagueID
// or eventID at this subscription tier") and only unlocks MLS + UCL (verified
// live 2026-06-12 via GET /v2/leagues?sportID=SOCCER). Unmapped/locked leagues
// are skipped client-side so no quota or roundtrip is wasted.
// Odds are AMERICAN format strings (e.g. "-112") and need decimal conversion.
const SGO_BASE = "https://api.sportsgameodds.com/v2";
// ORACLE league name → SGO leagueID. Only IDs confirmed against the live API are
// listed (EPL exists but is locked on the free tier — kept for a future upgrade).
const SGO_LEAGUE_IDS: Record<string, string> = {
  MLS: "MLS",
  "Champions League": "UEFA_CHAMPIONS_LEAGUE",
  "Premier League": "EPL",
};
// oddID pattern: {statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}
const SGO_ML3WAY_ODD_IDS = {
  home: "points-home-game-ml3way-home",
  draw: "points-all-game-ml3way-draw",
  away: "points-away-game-ml3way-away",
} as const;
const SGO_SHARP_BOOKS = ["pinnacle"];

/** American ("-112" / "+150") → decimal. NaN-propagating on bad input. */
function americanToDecimal(odds: string | number | undefined): number {
  const a = Number(odds);
  if (!Number.isFinite(a) || a === 0) return NaN;
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

interface SgoBookmakerOdd {
  odds?: string | number;
  available?: boolean;
}
interface SgoOdd {
  odds?: string | number; // consensus (bookOdds) — soft fallback
  byBookmaker?: Record<string, SgoBookmakerOdd>;
}
interface SgoTeam {
  names?: { long?: string; medium?: string; short?: string };
  name?: string;
}
interface SgoEvent {
  eventID?: string;
  status?: { startsAt?: string };
  teams?: { home?: SgoTeam; away?: SgoTeam };
  odds?: Record<string, SgoOdd>;
}
interface SgoEventsResponse {
  data?: SgoEvent[];
}

function sgoTeamName(t: SgoTeam | undefined): string {
  return t?.names?.long ?? t?.names?.medium ?? t?.name ?? "";
}

/** Extract the 3-way ML triple from an SGO event — Pinnacle first, consensus fallback. */
function parseSgoEvent(
  event: SgoEvent
): { h: number; d: number; a: number; book: string; sharp: boolean } | null {
  const odds = event.odds ?? {};
  const homeOdd = odds[SGO_ML3WAY_ODD_IDS.home];
  const drawOdd = odds[SGO_ML3WAY_ODD_IDS.draw];
  const awayOdd = odds[SGO_ML3WAY_ODD_IDS.away];
  if (!homeOdd || !drawOdd || !awayOdd) return null;
  // Prefer a sharp book carried on all three sides.
  for (const book of SGO_SHARP_BOOKS) {
    const side = (o: SgoOdd) => {
      const b = o.byBookmaker?.[book];
      return b && b.available !== false ? americanToDecimal(b.odds) : NaN;
    };
    const h = side(homeOdd);
    const d = side(drawOdd);
    const a = side(awayOdd);
    if ([h, d, a].every(Number.isFinite)) return { h, d, a, book, sharp: true };
  }
  // Fall back to the consensus price on the odd itself.
  const h = americanToDecimal(homeOdd.odds);
  const d = americanToDecimal(drawOdd.odds);
  const a = americanToDecimal(awayOdd.odds);
  if ([h, d, a].some((v) => !Number.isFinite(v))) return null;
  return { h, d, a, book: "consensus", sharp: false };
}

export function makeSportsGameOddsProvider(apiKey: string | undefined): OddsProvider {
  return {
    name: "sportsgameodds",
    tier: 5,
    isSharp: true,
    hasQuota: () => !!apiKey,
    async fetch(home, away, league, kickoff) {
      if (!apiKey) return null;
      const leagueId = SGO_LEAGUE_IDS[league];
      if (!leagueId) return null; // league not served by SGO (or locked) — free skip
      const date = kickoff.slice(0, 10);
      // Single call: events + odds in one payload (each event returned = 1 billed
      // object on the 1,000/mo free tier, so the day window + limit stay tight).
      const res = await fetch(
        `${SGO_BASE}/events?leagueID=${leagueId}&startsAfter=${date}T00:00:00Z&startsBefore=${date}T23:59:59Z&oddsAvailable=true&limit=50`,
        { headers: { "X-Api-Key": apiKey }, signal: AbortSignal.timeout(15_000) }
      );
      if (!res.ok) {
        if (res.status === 429) throw new Error("sportsgameodds: quota exhausted");
        return null;
      }
      const json = (await res.json()) as SgoEventsResponse;
      const event = (json.data ?? []).find(
        (e) =>
          namesMatch(sgoTeamName(e.teams?.home), home) &&
          namesMatch(sgoTeamName(e.teams?.away), away)
      );
      if (!event) return null;
      const parsed = parseSgoEvent(event);
      if (!parsed) return null;
      const valid = validateTriple(parsed.h, parsed.d, parsed.a);
      if (!valid) return null;
      return {
        home: parsed.h,
        draw: parsed.d,
        away: parsed.a,
        confidence: parsed.sharp ? 0.85 : 0.68,
        sources: [`sportsgameodds:${parsed.book}`],
        overround: valid.overround,
        provider: "sportsgameodds",
        isSharp: parsed.sharp,
      };
    },
  };
}

// ── Stubs (tier 6) ─────────────────────────────────────────────────────────────
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
  sharpApiIoKey?: string;
  apiFootballKey?: string;
  oddsApiIoKey?: string;
  sportsGameOddsKey?: string;
  bsdKey?: string;
}

/** Build the full provider registry in tier order. */
export function buildOddsProviders(keys: OddsProviderKeys): OddsProvider[] {
  return [
    makeSharpApiIoProvider(keys.sharpApiIoKey),
    makeApiFootballProvider(keys.apiFootballKey),
    makeOddsApiIoProvider(keys.oddsApiIoKey),
    makeSportsGameOddsProvider(keys.sportsGameOddsKey),
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
