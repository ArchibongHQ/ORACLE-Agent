/** Result lookup — Phase 4.
 *  Takes yesterday's analysis records, fetches actual match scores,
 *  returns ResolutionRecord[] with RPS, draw-calibration, and CLV.
 *
 *  Two result sources, tried in order:
 *  1. API-Football (`/fixtures?date=&status=FT`) — one request covers every league
 *     globally (confirmed live: 94 finished matches across 38 leagues in one call),
 *     but the free tier only accepts dates in a rolling window near "today".
 *  2. football-data.org — only ~10 major leagues + World Cup, but accepts any date.
 *  Falls back to (2) when (1) is unavailable (no key, error, or date outside its
 *  free-tier window) so older dates and major-league-only setups still resolve. */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AnalysisRecord,
  ClosingOddsSnapshot,
  ClvSourceQuality,
  ResolutionRecord,
} from "@oracle/engine";
import { isPopularTeam, lstmMarketDecoderProxy, RESOLUTION_SCHEMA_VERSION } from "@oracle/engine";
import { resolvePythonBin } from "./fixtures.js";
import type { SharpOddsRecord } from "./sharpFeed.js";
import { namesMatch } from "./teamNames.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, "../../..");
const PYTHON_BIN = resolvePythonBin();
const RESULTS_CACHE_DIR = join(REPO_ROOT, ".tmp", "results");
const UNMATCHED_FIXTURES_FILE = join(REPO_ROOT, ".tmp", "unmatched_fixtures.txt");

const BASE_URL = "https://api.football-data.org/v4";
const APIFOOTBALL_BASE = "https://v3.football.api-sports.io";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// Odds API sport keys for CLV-eligible leagues. Exported so sharpFeed.ts (and
// its callers in apps/worker) can resolve the same sport-key mapping when
// deciding whether Tier 1 (Odds API) of fetchSharpFairPrice applies to a
// given league — single source of truth, not duplicated in a second map.
export const LEAGUE_TO_SPORT: Record<string, string> = {
  "Premier League": "soccer_epl",
  "La Liga": "soccer_spain_la_liga",
  Bundesliga: "soccer_germany_bundesliga",
  "Serie A": "soccer_italy_serie_a",
  "Ligue 1": "soccer_france_ligue_one",
  "Champions League": "soccer_uefa_champs_league",
  "Europa League": "soccer_uefa_europa_league",
  Eredivisie: "soccer_netherlands_eredivisie",
  "Primeira Liga": "soccer_portugal_primeira_liga",
  Championship: "soccer_england_championship",
  "FIFA World Cup": "soccer_fifa_world_cup",
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface FDTeam {
  name: string;
  shortName?: string;
  tla?: string;
}

interface FDScore {
  fullTime: { home: number | null; away: number | null };
}

interface FDMatch {
  id: number;
  utcDate: string;
  status: string;
  homeTeam: FDTeam;
  awayTeam: FDTeam;
  score: FDScore;
}

interface FDResponse {
  matches: FDMatch[];
}

interface OddsH2HOutcome {
  name: string;
  price: number;
}
interface OddsH2HGame {
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    markets: Array<{ key: string; outcomes: OddsH2HOutcome[] }>;
  }>;
}

// Team-name matching (namesMatch) is imported from teamNames.ts — the single,
// shared, alias-aware matcher also used by oddsProviders.ts. Do not reimplement here.

// ── RPS ───────────────────────────────────────────────────────────────────────

export function rpsScore(
  probs: { home: number; draw: number; away: number },
  actual: "home" | "draw" | "away"
): number {
  const outcomes = ["home", "draw", "away"] as const;
  let cumF = 0,
    cumA = 0,
    score = 0;
  for (const out of outcomes) {
    cumF += probs[out];
    cumA += out === actual ? 1 : 0;
    score += (cumF - cumA) ** 2;
  }
  return score / (outcomes.length - 1);
}

// ── football-data.org fetch ───────────────────────────────────────────────────

async function fetchFinishedMatches(apiKey: string, date: string): Promise<FDMatch[]> {
  // football-data.org's free tier unreliably returns 0 results for a single-day
  // dateFrom===dateTo window even when matches exist on that exact date (observed
  // 2026-06-19: a 1-day window returned 5 matches a same-day window missed entirely).
  // Pad by a day on each side; findMatch() below still filters callers back down to
  // the exact kickoff date, so this can't pull in a wrong-day match.
  const center = new Date(`${date}T00:00:00Z`);
  const dateFrom = new Date(center.getTime() - 86_400_000).toISOString().slice(0, 10);
  const dateTo = new Date(center.getTime() + 86_400_000).toISOString().slice(0, 10);
  const params = new URLSearchParams({ dateFrom, dateTo, status: "FINISHED" });
  const url = `${BASE_URL}/matches?${params}`;
  const res = await fetch(url, {
    headers: { "X-Auth-Token": apiKey },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    if (res.status === 429) throw new Error("football-data.org: rate limited");
    if (res.status === 403) throw new Error("football-data.org: invalid API key");
    throw new Error(`football-data.org: HTTP ${res.status}`);
  }

  const body = (await res.json()) as FDResponse;
  return body.matches ?? [];
}

// ── API-Football fetch (primary — broad league coverage, narrow date window) ──

interface AFFixture {
  fixture: { date: string; status: { short: string } };
  teams: { home: { name: string }; away: { name: string } };
  goals: { home: number | null; away: number | null };
}

interface AFFixturesResponse {
  response?: AFFixture[];
  errors?: Record<string, string> | string[];
}

/** Returns null when the source is unusable for this date (error, no key, or the
 *  free-tier date window rejected the request) so the caller can fall back. */
async function fetchFinishedMatchesApiFootball(
  apiKey: string,
  date: string
): Promise<AFFixture[] | null> {
  const res = await fetch(`${APIFOOTBALL_BASE}/fixtures?date=${date}&status=FT`, {
    headers: { "x-apisports-key": apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;

  const body = (await res.json()) as AFFixturesResponse;
  // Free-plan date-window rejection comes back as HTTP 200 with a populated `errors`
  // object (e.g. "Free plans do not have access to this date") rather than a non-2xx
  // status — must check this explicitly, not just res.ok.
  if (body.errors && Object.keys(body.errors).length) return null;
  return body.response ?? [];
}

/** Adapts an API-Football fixture into the internal FDMatch shape so findMatch()/
 *  resolveRecord() can stay source-agnostic. */
function afToFdShape(f: AFFixture): FDMatch {
  return {
    id: 0,
    utcDate: f.fixture.date,
    status: f.fixture.status.short,
    homeTeam: { name: f.teams.home.name },
    awayTeam: { name: f.teams.away.name },
    score: { fullTime: { home: f.goals.home, away: f.goals.away } },
  };
}

// ── Closing odds fetch (Odds API v4, kickoff-proxy CLV) ───────────────────────

async function fetchClosingOdds(
  apiKey: string,
  home: string,
  away: string,
  sportKey: string,
  kickoffIso: string
): Promise<{ home: number; draw: number; away: number } | null> {
  const kickoff = new Date(kickoffIso);
  const windowFrom = new Date(kickoff.getTime() - 2 * 3_600_000).toISOString();
  const windowTo = new Date(kickoff.getTime() + 2 * 3_600_000).toISOString();

  const params = new URLSearchParams({
    apiKey,
    regions: "uk,eu",
    markets: "h2h",
    oddsFormat: "decimal",
    bookmakers: "pinnacle",
    commenceTimeFrom: windowFrom,
    commenceTimeTo: windowTo,
  });

  try {
    const url = `${ODDS_API_BASE}/sports/${sportKey}/odds/?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;

    const games = (await res.json()) as OddsH2HGame[];
    const game = games.find((g) => namesMatch(g.home_team, home) && namesMatch(g.away_team, away));
    if (!game) return null;

    const bk = game.bookmakers.find((b) => b.key === "pinnacle") ?? game.bookmakers[0];
    if (!bk) return null;

    const h2h = bk.markets.find((m) => m.key === "h2h");
    if (!h2h) return null;

    const homeOut = h2h.outcomes.find((o) => namesMatch(o.name, home));
    const awayOut = h2h.outcomes.find((o) => namesMatch(o.name, away));
    const drawOut = h2h.outcomes.find((o) => o.name === "Draw");
    if (!homeOut || !awayOut || !drawOut) return null;

    return { home: homeOut.price, draw: drawOut.price, away: awayOut.price };
  } catch {
    return null;
  }
}

// ── CLV computation ───────────────────────────────────────────────────────────

// Maps EVMarket.label → h2h key for frozenOddsAtAnalysis lookup
const LABEL_TO_SIDE: Record<string, "home" | "draw" | "away"> = {
  Home: "home",
  Draw: "draw",
  Away: "away",
  home: "home",
  draw: "draw",
  away: "away",
};

/**
 * realisedCLV = closingIP − analysisIP for the top-pick side (home proxy if no 1X2 pick).
 * Positive value = market shortened (you beat the closing line). Units: implied-probability pp.
 * Display via formatClv() for human-readable "+1.42pp" format.
 */
export function computeRealisedClv(
  frozenOdds: Record<string, unknown>,
  closingOdds: { home: number; draw: number; away: number },
  topPickLabel: string | null
): number | null {
  const side: "home" | "draw" | "away" =
    (topPickLabel != null ? LABEL_TO_SIDE[topPickLabel] : null) ?? "home";

  const analysisOdds = frozenOdds[side];
  if (typeof analysisOdds !== "number" || analysisOdds <= 1) return null;

  const closingForSide = closingOdds[side];
  if (closingForSide <= 1) return null;

  return parseFloat((1 / closingForSide - 1 / analysisOdds).toFixed(6));
}

/** Format a realisedCLV value (implied-probability pp) as "+1.42pp" for display. */
export function formatClv(clv: number): string {
  return `${clv >= 0 ? "+" : ""}${(clv * 100).toFixed(2)}pp`;
}

/**
 * realisedSharpClv = 1/sharpFairAtClose − 1/sharpFairAtPick — the sharp-
 * reference twin of computeRealisedClv, using ORACLE's own devigged sharp
 * fair price (packages/runtime/src/sharpFeed.ts's fetchSharpFairPrice) at
 * both ends instead of SportyBet's own closing line. This is genuine
 * independent evidence of whether the market moved in ORACLE's favor —
 * computeRealisedClv answers "did SportyBet's own line move", which isn't
 * independent evidence since SportyBet is the book being bet into. The two
 * metrics ADD to the ledger; neither replaces the other (see
 * EnrichedResolutionRecord below, which carries both side by side).
 * Same units/shape as computeRealisedClv (implied-probability pp, positive =
 * favorable move), null whenever either endpoint is missing/invalid so a
 * partially-captured pick (e.g. sharp_fair_at_close never landed because the
 * closing-odds sweep missed its window) reports null rather than a
 * misleading number computed from only one side.
 */
export function computeSharpReferenceClv(
  sharpFairAtPick: number | null | undefined,
  sharpFairAtClose: number | null | undefined
): number | null {
  if (sharpFairAtPick == null || sharpFairAtPick <= 1) return null;
  if (sharpFairAtClose == null || sharpFairAtClose <= 1) return null;
  return parseFloat((1 / sharpFairAtClose - 1 / sharpFairAtPick).toFixed(6));
}

/** SportyBet odds sometimes arrive as numeric strings (raw API passthrough) —
 *  coerce to a finite number or undefined, never NaN/Infinity. */
function toNum(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** A T-30m snapshot is only trustworthy as tick-level provenance when it was
 *  actually captured in a plausible pre-kickoff band relative to THIS record's
 *  kickoff — guards against a kickoff that moved (postponement) after capture,
 *  which would otherwise silently mis-tag a stale snapshot as authoritative. */
function snapshotIsPlausible(snapshot: ClosingOddsSnapshot | undefined, kickoff: string): boolean {
  if (!snapshot) return false;
  const delta = Math.abs(new Date(snapshot.snapshotAt).getTime() - new Date(kickoff).getTime());
  return Number.isFinite(delta) && delta <= 45 * 60_000;
}

// ── Match + resolve ───────────────────────────────────────────────────────────

function findMatch(record: AnalysisRecord, matches: FDMatch[]): FDMatch | null {
  const kickoffDate = record.kickoff.slice(0, 10);
  return (
    matches.find(
      (m) =>
        m.utcDate.startsWith(kickoffDate) &&
        namesMatch(record.home, m.homeTeam.name) &&
        namesMatch(record.away, m.awayTeam.name)
    ) ?? null
  );
}

async function resolveRecord(
  record: AnalysisRecord,
  match: FDMatch,
  runId: string,
  oddsApiKey?: string,
  closingSnapshot?: ClosingOddsSnapshot,
  sharpOddsRecord?: SharpOddsRecord
): Promise<EnrichedResolutionRecord | null> {
  const { home: hGoals, away: aGoals } = match.score.fullTime;
  if (hGoals == null || aGoals == null) return null;

  const actualResult: "home" | "draw" | "away" =
    hGoals > aGoals ? "home" : hGoals === aGoals ? "draw" : "away";

  const rps = rpsScore(record.probabilities, actualResult);

  const drawCalibrationPoint = {
    league: record.league,
    predicted: record.probabilities.draw,
    realised: actualResult === "draw" ? 1 : 0,
  };

  const snap1x2 = snapshotIsPlausible(closingSnapshot, record.kickoff)
    ? closingSnapshot?.odds["1x2"]
    : undefined;
  const snapHome = toNum(snap1x2?.home);
  const snapDraw = toNum(snap1x2?.draw);
  const snapAway = toNum(snap1x2?.away);
  const frozenHome = toNum((record.frozenOddsAtAnalysis as Record<string, unknown> | null)?.home);

  // Real steam/sharp-compression signal (PR-8b) — independent of CLV
  // eligibility (broader coverage than CLV), computed post-hoc here since a
  // T-30m snapshot by construction can't exist before ORACLE's decision was
  // already made hours earlier. Observability only — never fed back into the
  // decision layer.
  let realisedSteamVelocity: number | null = null;
  let sharpCompressionDetected: boolean | null = null;
  if (snapHome != null && frozenHome != null) {
    const signal = lstmMarketDecoderProxy(0.5, frozenHome, snapHome, isPopularTeam(record.home));
    realisedSteamVelocity = parseFloat(signal.velocity.toFixed(6));
    sharpCompressionDetected = signal.sharpCompression;
  }

  let realisedCLV: number | null = null;
  let clvSourceQuality: ClvSourceQuality = "UNKNOWN";
  if (record.liquidityTag === "CLV_ELIGIBLE" && record.frozenOddsAtAnalysis) {
    if (snapHome != null && snapDraw != null && snapAway != null) {
      const topLabel = record.deterministicTopPick?.label ?? null;
      realisedCLV = computeRealisedClv(
        record.frozenOddsAtAnalysis,
        { home: snapHome, draw: snapDraw, away: snapAway },
        topLabel
      );
      clvSourceQuality = "TICK_LEVEL"; // a real captured snapshot, not a proxy
    } else if (oddsApiKey) {
      const sportKey = LEAGUE_TO_SPORT[record.league];
      if (sportKey) {
        const closing = await fetchClosingOdds(
          oddsApiKey,
          record.home,
          record.away,
          sportKey,
          record.kickoff
        );
        if (closing) {
          const topLabel = record.deterministicTopPick?.label ?? null;
          realisedCLV = computeRealisedClv(record.frozenOddsAtAnalysis, closing, topLabel);
          clvSourceQuality = "KICKOFF_PROXY"; // Odds API retains upcoming events only — proxy, not tick-level
        }
      }
    }
  }

  // Sharp-reference CLV (P1-4, Wave 2) — genuinely independent of
  // realisedCLV above (which is only ever SportyBet's OWN closing line, not
  // independent evidence). ADDS to the ledger; never gates on liquidityTag/
  // CLV_ELIGIBLE the way realisedCLV does, since that gate exists to protect
  // SportyBet's-own-line trust, which doesn't apply to an externally-sourced
  // sharp reference — this is computed whenever both endpoints were captured,
  // for any fixture.
  const realisedSharpClv = sharpOddsRecord
    ? computeSharpReferenceClv(
        sharpOddsRecord.sharp_fair_at_pick,
        sharpOddsRecord.sharp_fair_at_close
      )
    : null;

  return {
    fixtureId: record.fixtureId,
    runId,
    schemaVersion: RESOLUTION_SCHEMA_VERSION,
    actualResult,
    homeGoals: hGoals,
    awayGoals: aGoals,
    realisedCLV,
    clvSourceQuality,
    realisedSteamVelocity,
    sharpCompressionDetected,
    rpsContribution: parseFloat(rps.toFixed(6)),
    drawCalibrationPoint,
    resolvedAt: new Date().toISOString(),
    pickOdds: sharpOddsRecord?.pick_odds ?? null,
    sharpFairAtPick: sharpOddsRecord?.sharp_fair_at_pick ?? null,
    sharpFairAtPickSource: sharpOddsRecord?.source ?? null,
    sharpFairAtClose: sharpOddsRecord?.sharp_fair_at_close ?? null,
    sharpFairAtCloseSource: sharpOddsRecord?.sharp_fair_at_close_source ?? null,
    realisedSharpClv,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** ResolutionRecord (packages/engine/src/types.ts) plus the sharp-reference
 *  CLV fields (P1-4, Wave 2) — a superset, not a replacement, so every
 *  existing consumer typed against ResolutionRecord[] keeps working
 *  unchanged. Declared here (not in @oracle/engine's types.ts) to avoid
 *  touching a shared engine file other concurrent Wave-2 workstreams may be
 *  editing right now; see sharpFeed.ts's file header for why this workstream
 *  couldn't just extend the dormant `sharp_consensus` plumbing instead. */
export interface EnrichedResolutionRecord extends ResolutionRecord {
  /** The price actually taken for this pick, when a SharpOddsRecord was
   *  captured for it — null when no sharp-feed record exists for this
   *  fixture (feed unavailable, or the pick predates this workstream). */
  pickOdds: number | null;
  sharpFairAtPick: number | null;
  /** "odds_api" | "ai_mode_fallback" | "unavailable" | null (no record at all). */
  sharpFairAtPickSource: string | null;
  sharpFairAtClose: number | null;
  sharpFairAtCloseSource: string | null;
  /** computeSharpReferenceClv(sharpFairAtPick, sharpFairAtClose) — null until
   *  both endpoints are captured. Coexists with realisedCLV; see that field's
   *  own doc comment (packages/engine/src/types.ts) for why the two are not
   *  interchangeable. */
  realisedSharpClv: number | null;
}

export interface ResolveResult {
  resolved: EnrichedResolutionRecord[];
  unmatched: string[]; // fixtureIds with no match in the API response
}

export async function resolveRecords(
  records: AnalysisRecord[],
  footballDataApiKey?: string,
  oddsApiKey?: string,
  apiFootballKey?: string,
  closingSnapshotsByFixture?: Map<string, ClosingOddsSnapshot>,
  sharpOddsByFixture?: Map<string, SharpOddsRecord>
): Promise<ResolveResult> {
  if (!records.length) return { resolved: [], unmatched: [] };

  const runId = `resolve_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  // All records should be from the same date; use kickoff of first record
  const date = records[0]?.kickoff.slice(0, 10);
  let matches: FDMatch[] = [];

  // Primary: API-Football — one request covers every league globally, but the free
  // tier only accepts dates in a rolling window near "today" (returns null outside it).
  if (apiFootballKey) {
    const af = await fetchFinishedMatchesApiFootball(apiFootballKey, date);
    if (af) matches = af.map(afToFdShape);
  }

  // Fallback: football-data.org — only ~10 major leagues + World Cup, but accepts
  // any date. Used when API-Football found nothing (no key, error, or date outside
  // its window) and a football-data.org key is available.
  if (!matches.length && footballDataApiKey) {
    try {
      matches = await fetchFinishedMatches(footballDataApiKey, date);
    } catch (_err) {
      // both sources exhausted — fall through; every record reports unmatched below
    }
  }

  const resolved: EnrichedResolutionRecord[] = [];
  const unmatched: string[] = [];

  for (const record of records) {
    const match = findMatch(record, matches);
    if (!match) {
      unmatched.push(record.fixtureId);
      continue;
    }

    const rec = await resolveRecord(
      record,
      match,
      runId,
      oddsApiKey,
      closingSnapshotsByFixture?.get(record.fixtureId),
      sharpOddsByFixture?.get(record.fixtureId)
    );
    if (rec) {
      resolved.push(rec);
      const _clvStr =
        rec.realisedCLV != null
          ? ` CLV=${rec.realisedCLV >= 0 ? "+" : ""}${(rec.realisedCLV * 100).toFixed(2)}pp`
          : "";
    } else {
      unmatched.push(record.fixtureId);
    }
  }

  return { resolved, unmatched };
}

// ── Web-search consensus fallback (CLAUDE.md §6 no-data-blocker) ───────────────
// Fixtures that neither API-Football nor football-data.org resolved (e.g. minor
// leagues outside both free tiers' coverage) fall through here: tools/scrape_match_results.py
// scrapes ESPN, Flashscore, BetExplorer, SofaScore, and Google AI Mode in parallel
// and only returns a result when >= minConsensus sources agree on the exact same
// scoreline. Degraded relative to a structured results API (no fixture-ID match,
// fuzzy team-name search per source) but strictly better than leaving the fixture
// unresolved forever — same rationale as fetchWebSearchOdds's role in the odds chain.

interface WebSearchResultPayload {
  home: string;
  away: string;
  league: string;
  date: string;
  home_goals: number;
  away_goals: number;
  actual_result: "home" | "draw" | "away";
  confidence: number;
  agreeing_sources: number;
  total_sources: number;
}

function _slugForResultCache(home: string, away: string, league: string, date: string): string {
  return `${home}_${away}_${league}_${date}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Resolve fixtures that resolveRecords() couldn't match via API, by scraping a
 *  multi-source consensus of live-score sites. Only fixtures where >= minConsensus
 *  independent sources agree on the exact scoreline are accepted — everything else
 *  stays unmatched (logged, not silently dropped, per resolve.md's edge cases). */
export async function resolveUnmatchedViaWebSearch(
  records: AnalysisRecord[],
  unmatchedIds: string[],
  runId: string,
  minConsensus = 2
): Promise<ResolveResult> {
  const targets = records.filter((r) => unmatchedIds.includes(r.fixtureId));
  if (targets.length === 0) return { resolved: [], unmatched: [] };

  await mkdir(RESULTS_CACHE_DIR, { recursive: true });

  const fixtureLines = targets.map((r) => `${r.home} vs ${r.away}, ${r.league}, ${r.kickoff}`);
  await writeFile(UNMATCHED_FIXTURES_FILE, fixtureLines.join("\n"), "utf8");

  const scriptPath = join(REPO_ROOT, "tools", "scrape_match_results.py");
  await new Promise<void>((resolvePromise) => {
    void import("node:child_process").then(({ spawn }) => {
      const child = spawn(
        PYTHON_BIN,
        [
          scriptPath,
          "--fixtures",
          UNMATCHED_FIXTURES_FILE,
          "--quiet",
          "--min-consensus",
          String(minConsensus),
        ],
        { env: { ...process.env, PYTHONIOENCODING: "utf-8" } }
      );
      const timer = setTimeout(() => {
        child.kill();
        resolvePromise();
      }, 35_000 * targets.length); // ~35s budget per fixture (5 sources in parallel, Playwright tier dominates)
      child.on("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  });

  const resolved: EnrichedResolutionRecord[] = [];
  const unmatched: string[] = [];

  for (const record of targets) {
    const cachePath = join(
      RESULTS_CACHE_DIR,
      `${_slugForResultCache(record.home, record.away, record.league, record.kickoff.slice(0, 10))}.json`
    );
    if (!existsSync(cachePath)) {
      unmatched.push(record.fixtureId);
      continue;
    }
    try {
      const payload = JSON.parse(await readFile(cachePath, "utf8")) as WebSearchResultPayload;
      const rps = rpsScore(record.probabilities, payload.actual_result);
      resolved.push({
        fixtureId: record.fixtureId,
        runId,
        schemaVersion: RESOLUTION_SCHEMA_VERSION,
        actualResult: payload.actual_result,
        homeGoals: payload.home_goals,
        awayGoals: payload.away_goals,
        realisedCLV: null, // web-search results carry no closing-odds proxy
        clvSourceQuality: "UNKNOWN",
        realisedSteamVelocity: null, // no snapshot lookup on the web-search fallback path
        sharpCompressionDetected: null,
        rpsContribution: parseFloat(rps.toFixed(6)),
        drawCalibrationPoint: {
          league: record.league,
          predicted: record.probabilities.draw,
          realised: payload.actual_result === "draw" ? 1 : 0,
        },
        resolvedAt: new Date().toISOString(),
        // No sharp-feed lookup on the web-search fallback path — this branch
        // exists precisely for fixtures neither structured-results API could
        // find, so there's no fixtureId to key a SharpOddsRecord lookup by
        // that would be any more reliable.
        pickOdds: null,
        sharpFairAtPick: null,
        sharpFairAtPickSource: null,
        sharpFairAtClose: null,
        sharpFairAtCloseSource: null,
        realisedSharpClv: null,
      });
    } catch {
      unmatched.push(record.fixtureId);
    }
  }

  return { resolved, unmatched };
}
