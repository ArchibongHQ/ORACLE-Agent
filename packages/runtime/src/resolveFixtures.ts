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
import type { AnalysisRecord, ClvSourceQuality, ResolutionRecord } from "@oracle/engine";
import { RESOLUTION_SCHEMA_VERSION } from "@oracle/engine";
import { resolvePythonBin } from "./fixtures.js";
import { namesMatch } from "./teamNames.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, "../../..");
const PYTHON_BIN = resolvePythonBin();
const RESULTS_CACHE_DIR = join(REPO_ROOT, ".tmp", "results");
const UNMATCHED_FIXTURES_FILE = join(REPO_ROOT, ".tmp", "unmatched_fixtures.txt");

const BASE_URL = "https://api.football-data.org/v4";
const APIFOOTBALL_BASE = "https://v3.football.api-sports.io";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// Odds API sport keys for CLV-eligible leagues
const LEAGUE_TO_SPORT: Record<string, string> = {
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
  oddsApiKey?: string
): Promise<ResolutionRecord | null> {
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

  let realisedCLV: number | null = null;
  let clvSourceQuality: ClvSourceQuality = "UNKNOWN";
  if (record.liquidityTag === "CLV_ELIGIBLE" && oddsApiKey && record.frozenOddsAtAnalysis) {
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

  return {
    fixtureId: record.fixtureId,
    runId,
    schemaVersion: RESOLUTION_SCHEMA_VERSION,
    actualResult,
    homeGoals: hGoals,
    awayGoals: aGoals,
    realisedCLV,
    clvSourceQuality,
    rpsContribution: parseFloat(rps.toFixed(6)),
    drawCalibrationPoint,
    resolvedAt: new Date().toISOString(),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ResolveResult {
  resolved: ResolutionRecord[];
  unmatched: string[]; // fixtureIds with no match in the API response
}

export async function resolveRecords(
  records: AnalysisRecord[],
  footballDataApiKey?: string,
  oddsApiKey?: string,
  apiFootballKey?: string
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

  const resolved: ResolutionRecord[] = [];
  const unmatched: string[] = [];

  for (const record of records) {
    const match = findMatch(record, matches);
    if (!match) {
      unmatched.push(record.fixtureId);
      continue;
    }

    const rec = await resolveRecord(record, match, runId, oddsApiKey);
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

  const resolved: ResolutionRecord[] = [];
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
        rpsContribution: parseFloat(rps.toFixed(6)),
        drawCalibrationPoint: {
          league: record.league,
          predicted: record.probabilities.draw,
          realised: payload.actual_result === "draw" ? 1 : 0,
        },
        resolvedAt: new Date().toISOString(),
      });
    } catch {
      unmatched.push(record.fixtureId);
    }
  }

  return { resolved, unmatched };
}
