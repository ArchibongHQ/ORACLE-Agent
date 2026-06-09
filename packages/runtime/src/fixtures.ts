/** Odds API integration — Phase 4.
 *  Fetches today's fixtures + odds, returns FixtureJob[] ready for runBatch.
 *  Falls back to .tmp/fixtures/today.txt when API key is absent or quota exhausted.
 *  Gap-fill: fixtures scraped but not covered by the Odds API get odds via Gemini Search. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureJob, RunState } from "@oracle/engine";
import { parseFixtureList } from "@oracle/engine";
import type { LLMCallContext } from "@oracle/llm";
import { fetchOddsViaGemini } from "@oracle/llm";
import { enrichWithH2H } from "./h2h.js";
import { enrichWithNewsIntel } from "./newsIntel.js";
import { buildOddsProviders, runOddsChain, type OddsProvider } from "./oddsProviders.js";
import { namesMatch } from "./teamNames.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");
const CACHE_PATH = join(ROOT, ".tmp/fixtures/today.txt");
const ODDS_CACHE_DIR = join(ROOT, ".tmp/odds");

// ── Odds API sport → ORACLE league name ──────────────────────────────────────

export const SPORT_TO_LEAGUE: Record<string, string> = {
  // European leagues (season Apr–May, off Jun–Jul)
  soccer_epl: "Premier League",
  soccer_spain_la_liga: "La Liga",
  soccer_germany_bundesliga: "Bundesliga",
  soccer_italy_serie_a: "Serie A",
  soccer_france_ligue_one: "Ligue 1",
  soccer_netherlands_eredivisie: "Eredivisie",
  soccer_portugal_primeira_liga: "Primeira Liga",
  soccer_england_championship: "Championship",
  soccer_scotland_premiership: "Scottish Premiership",
  soccer_austria_bundesliga: "Austrian Bundesliga",
  soccer_belgium_first_div_a: "Belgian Pro League",
  // UEFA club competitions
  soccer_uefa_champs_league: "Champions League",
  soccer_uefa_europa_league: "Europa League",
  // International & summer competitions
  soccer_fifa_world_cup: "FIFA World Cup",
  soccer_conmebol_copa_libertadores: "Copa Libertadores",
  soccer_conmebol_copa_sudamericana: "Copa Sudamericana",
  // Summer leagues
  soccer_japan_j_league: "J League",
  soccer_norway_eliteserien: "Eliteserien",
  soccer_sweden_allsvenskan: "Allsvenskan",
};

// Bookmaker preference — most sharp first
const BOOKMAKER_PREFERENCE = ["pinnacle", "betfair_ex_eu", "unibet", "bet365", "williamhill"];

// ── Types ─────────────────────────────────────────────────────────────────────

interface OddsOutcome {
  name: string;
  price: number;
  point?: number;
}

interface OddsMarket {
  key: string;
  outcomes: OddsOutcome[];
}

interface OddsBookmaker {
  key: string;
  markets: OddsMarket[];
}

interface OddsApiGame {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
}

// ── AH line key mapping ───────────────────────────────────────────────────────

function ahSuffix(abs: number): string {
  if (abs === 0.25) return "025";
  if (abs === 0.75) return "075";
  return String(Math.round(abs * 10)).padStart(2, "0");
}

function spreadToEngineKey(name: string, homeTeam: string, point: number): string {
  const side = name === homeTeam ? "h" : "a";
  const dir = point < 0 ? "m" : "p";
  return `${side}${dir}${ahSuffix(Math.abs(point))}`;
}

// ── Bookmaker selection ───────────────────────────────────────────────────────

function pickBookmaker(game: OddsApiGame): OddsBookmaker | null {
  if (!game.bookmakers.length) return null;
  for (const preferred of BOOKMAKER_PREFERENCE) {
    const bk = game.bookmakers.find((b) => b.key === preferred);
    if (bk) return bk;
  }
  return game.bookmakers[0]!;
}

// ── Odds extraction ───────────────────────────────────────────────────────────

function extractOdds(
  bk: OddsBookmaker,
  homeTeam: string,
  awayTeam: string
): {
  h2h: { home: number; draw: number; away: number } | null;
  flatOdds: Record<string, number>;
} {
  const flatOdds: Record<string, number> = {};
  let h2h: { home: number; draw: number; away: number } | null = null;

  for (const market of bk.markets) {
    if (market.key === "h2h") {
      const homeOut = market.outcomes.find((o) => o.name === homeTeam);
      const awayOut = market.outcomes.find((o) => o.name === awayTeam);
      const drawOut = market.outcomes.find((o) => o.name === "Draw");
      if (homeOut && awayOut && drawOut) {
        h2h = { home: homeOut.price, draw: drawOut.price, away: awayOut.price };
        flatOdds.home = homeOut.price;
        flatOdds.draw = drawOut.price;
        flatOdds.away = awayOut.price;
      }
    }

    if (market.key === "totals") {
      for (const out of market.outcomes) {
        if (out.point == null) continue;
        const dir = out.name === "Over" ? "over" : "under";
        // Key format: over_2.5, under_2.5, over_1.5, etc.
        const key = `${dir}_${String(out.point).replace(".", "_")}`;
        flatOdds[key] = out.price;
        // Also store the decimal-point format used by the engine
        const keyDot = `${dir}_${out.point}`;
        flatOdds[keyDot] = out.price;
      }
    }

    if (market.key === "spreads") {
      // Group by absolute point to get paired lines
      const byName = new Map<string, OddsOutcome[]>();
      for (const out of market.outcomes) {
        const list = byName.get(out.name) ?? [];
        list.push(out);
        byName.set(out.name, list);
      }
      for (const out of market.outcomes) {
        if (out.point == null) continue;
        // Store as ah_{engineKey} for the scanMarkets() block 4 lookup
        const engineKey = spreadToEngineKey(out.name, homeTeam, out.point);
        flatOdds[`ah_${engineKey}`] = out.price;
      }
    }

    if (market.key === "btts") {
      const yes = market.outcomes.find((o) => o.name.toLowerCase().includes("yes"));
      const no = market.outcomes.find((o) => o.name.toLowerCase().includes("no"));
      if (yes) flatOdds.btts_yes = yes.price;
      if (no) flatOdds.btts_no = no.price;
    }
  }

  return { h2h, flatOdds };
}

// ── Game → FixtureJob ─────────────────────────────────────────────────────────

export function gameToFixtureJob(game: OddsApiGame, league: string): FixtureJob | null {
  const bk = pickBookmaker(game);
  if (!bk) return null;

  const { h2h, flatOdds } = extractOdds(bk, game.home_team, game.away_team);
  if (!h2h) return null;

  const kickoffMs = new Date(game.commence_time).getTime();
  const hoursToKO = Math.max(0, (kickoffMs - Date.now()) / 3_600_000);

  const state: RunState = {
    telemetry: {
      hOdds: h2h.home,
      dOdds: h2h.draw,
      aOdds: h2h.away,
      ohO: h2h.home, // opening = current (no history available)
      oaO: h2h.away,
      hoursToKO,
    },
    pipeline: {
      fixture: {
        home: game.home_team,
        away: game.away_team,
        league,
        date: game.commence_time,
      },
      fetched: {
        odds: flatOdds,
      },
    },
  };

  return {
    home: game.home_team,
    away: game.away_team,
    league,
    kickoff: game.commence_time,
    state,
  };
}

// ── Odds API HTTP call ────────────────────────────────────────────────────────

const BASE_URL = "https://api.the-odds-api.com/v4";

async function fetchSportOdds(
  apiKey: string,
  sportKey: string,
  dateFrom: string,
  dateTo: string
): Promise<OddsApiGame[]> {
  const params = new URLSearchParams({
    apiKey,
    regions: "uk,eu",
    markets: "h2h,totals,spreads",
    oddsFormat: "decimal",
    commenceTimeFrom: dateFrom,
    commenceTimeTo: dateTo,
  });

  const url = `${BASE_URL}/sports/${sportKey}/odds/?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok) {
    if (res.status === 404) return []; // sport key not currently offered
    if (res.status === 422) return []; // no events for this sport/date
    if (res.status === 401) throw new Error(`Odds API: invalid key (${res.status})`);
    if (res.status === 429) throw new Error("Odds API: quota exhausted");
    throw new Error(`Odds API: HTTP ${res.status} for ${sportKey}`);
  }

  return res.json() as Promise<OddsApiGame[]>;
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

/** Merge Odds API jobs into today.txt without discarding scraped fixtures.
 *  Existing lines are preserved; new lines are appended only when not already present. */
async function mergeCache(jobs: FixtureJob[]): Promise<void> {
  await mkdir(dirname(CACHE_PATH), { recursive: true });

  // Read existing scraped lines
  let existing: string[] = [];
  try {
    const text = await readFile(CACHE_PATH, "utf8");
    existing = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    /* file may not exist yet */
  }

  // Build dedup key: normalised "home_vs_away_YYYY-MM-DD"
  const normKey = (home: string, away: string, kickoff: string) =>
    `${home}_vs_${away}_${kickoff.slice(0, 10)}`
      .toLowerCase()
      .replace(/\b(fc|afc|sc|cf|ac|as)\b/g, "")
      .replace(/[^a-z0-9_]/g, "")
      .replace(/_+/g, "_");

  const existingKeys = new Set(
    existing.map((line) => {
      const parts = line.split(", ");
      const vs = parts[0]?.split(" vs ") ?? [];
      return normKey(vs[0] ?? "", vs[1] ?? "", parts[2] ?? "");
    })
  );

  // Append only genuinely new jobs from Odds API
  const newLines: string[] = [];
  for (const job of jobs) {
    const k = normKey(job.home, job.away, job.kickoff);
    if (!existingKeys.has(k)) {
      newLines.push(`${job.home} vs ${job.away}, ${job.league}, ${job.kickoff}`);
      existingKeys.add(k);
    }
  }

  const merged = [...existing, ...newLines];
  await writeFile(CACHE_PATH, `${merged.join("\n")}\n`, "utf8");

  // Write per-fixture odds cache
  await mkdir(ODDS_CACHE_DIR, { recursive: true });
  for (const job of jobs) {
    const slug = `${job.home}_vs_${job.away}`
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
    const out = join(ODDS_CACHE_DIR, `${slug}.json`);
    await writeFile(out, JSON.stringify(job.state?.pipeline?.fetched?.odds ?? {}, null, 2), "utf8");
  }
}

async function readCachedJobs(): Promise<FixtureJob[]> {
  try {
    const text = await readFile(CACHE_PATH, "utf8");
    return parseFixtureList(text);
  } catch {
    return [];
  }
}

// ── Gemini odds gap-fill (scraped fixtures with no Odds API coverage) ────────────

/** Normalise a name to a dedup key for matching scraped vs Odds API fixtures. */
function normForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(fc|afc|sc|cf|ac|as|ss|ssc|sv|bk|if|cd|ud)\b/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Return scraped fixtures that have no match in the Odds API job list. */
function findUnmatched(scrapedJobs: FixtureJob[], oddsJobs: FixtureJob[]): FixtureJob[] {
  return scrapedJobs.filter((s) => {
    const sH = normForMatch(s.home);
    const sA = normForMatch(s.away);
    const sD = s.kickoff.slice(0, 10);
    return (
      !oddsJobs.some(
        (o) =>
          o.kickoff.slice(0, 10) === sD && namesMatch(o.home, s.home) && namesMatch(o.away, s.away)
      ) &&
      sH.length > 0 &&
      sA.length > 0
    );
  });
}

/** A resolved 1X2 triple plus provenance, normalised across acquisition paths. */
interface GapOdds {
  home: number;
  draw: number;
  away: number;
  odds_source: string;
  odds_quality: "live" | "degraded";
  confidence: number;
  sources: string;
}

/** Build a FixtureJob state from a resolved odds triple, mirroring gameToFixtureJob. */
function jobFromGapOdds(job: FixtureJob, o: GapOdds): FixtureJob {
  const hoursToKO = Math.max(0, (new Date(job.kickoff).getTime() - Date.now()) / 3_600_000);
  const state: RunState = {
    telemetry: {
      hOdds: o.home,
      dOdds: o.draw,
      aOdds: o.away,
      ohO: o.home,
      oaO: o.away,
      hoursToKO,
    },
    pipeline: {
      fixture: { home: job.home, away: job.away, league: job.league, date: job.kickoff },
      fetched: { odds: { ...o } },
    },
  };
  return { ...job, state };
}

/** For fixtures not covered by the Odds API, acquire odds from the structured
 *  free-API provider chain first (OddsPapi → API-Football → …), then fall back to
 *  Gemini Search for any still unresolved. Returns only jobs with confident odds. */
async function geminiOddsGapFill(
  unmatched: FixtureJob[],
  geminiApiKey: string | undefined,
  providers: OddsProvider[] = []
): Promise<FixtureJob[]> {
  if (unmatched.length === 0) return [];
  const hasChain = providers.some((p) => p.hasQuota());
  if (!geminiApiKey && !hasChain) return [];

  const ctx: LLMCallContext | null = geminiApiKey
    ? { config: { claudeApiKey: "", geminiApiKey, bankroll: 0 }, requestedAt: new Date().toISOString() }
    : null;

  const filled: FixtureJob[] = [];

  for (const job of unmatched) {
    try {
      let resolved: GapOdds | null = null;

      // Tier 1: structured providers (sharp JSON beats LLM-scraped prose).
      if (hasChain) {
        const chain = await runOddsChain(providers, job.home, job.away, job.league, job.kickoff);
        if (chain) {
          resolved = {
            home: chain.home,
            draw: chain.draw,
            away: chain.away,
            odds_source: chain.provider,
            odds_quality: chain.isSharp ? "live" : "degraded",
            confidence: chain.confidence,
            sources: chain.sources.join(","),
          };
        }
      }

      // Tier 2: Gemini Search consensus (degraded last resort).
      if (!resolved && ctx) {
        const g = await fetchOddsViaGemini(job.home, job.away, job.league, job.kickoff, ctx);
        if (g) {
          resolved = {
            home: g.home,
            draw: g.draw,
            away: g.away,
            odds_source: "gemini_search_consensus",
            odds_quality: "degraded",
            confidence: g.confidence,
            sources: g.sources.join(","),
          };
        }
      }

      if (!resolved) continue;

      const filledJob = jobFromGapOdds(job, resolved);
      filled.push(filledJob);

      // Write odds to cache for inspection
      await mkdir(ODDS_CACHE_DIR, { recursive: true });
      const slug = `${job.home}_vs_${job.away}`
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_]/g, "");
      await writeFile(
        join(ODDS_CACHE_DIR, `${slug}.json`),
        JSON.stringify(filledJob.state?.pipeline?.fetched?.odds, null, 2),
        "utf8"
      );
    } catch {
      // non-fatal — move to next fixture
    }
  }

  return filled;
}

// ── Web search fallback (when Odds API fails) ──────────────────────────────────

interface WebSearchOdds {
  match_id: string;
  source: string;
  confidence: number;
  consensus_odds: {
    h2h?: { home: number; draw: number; away: number };
    totals?: { over: number; under: number };
    btts?: { yes: number; no: number };
  };
  validation: {
    consensus_sources: number;
    passed: boolean;
  };
}

async function fetchWebSearchOdds(
  jobs: FixtureJob[],
  enableWebSearch: boolean
): Promise<FixtureJob[]> {
  if (!enableWebSearch || jobs.length === 0) return jobs;

  try {
    const { spawnSync } = await import("node:child_process");
    const fixtureLines = jobs.map((j) => `${j.home} vs ${j.away}, ${j.league}, ${j.kickoff}`);
    const fixtureContent = fixtureLines.join("\n");

    // Write temp fixture list
    const tmpPath = join(ROOT, ".tmp/web_search_fixtures.txt");
    await writeFile(tmpPath, fixtureContent, "utf8");

    // Spawn Python scraper
    const result = spawnSync(
      "python",
      [join(ROOT, "tools/scrape_live_odds.py"), "--fixtures", tmpPath, "--quiet"],
      {
        encoding: "utf8",
        timeout: 120_000, // 2 min per fixture
      }
    );

    if (result.error) {
      return jobs;
    }

    if (result.status !== 0) {
      return jobs;
    }

    // Read synthesized odds from .tmp/odds/*.json
    const oddsDir = join(ROOT, ".tmp/odds");
    let successCount = 0;

    for (const job of jobs) {
      const _slug = `${job.home}_vs_${job.away}`
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_]/g, "");
      const dateSlug = job.kickoff.slice(0, 10);
      const oddsFile = join(oddsDir, `${job.home}_${job.away}_${job.league}_${dateSlug}.json`);

      try {
        const oddsText = await readFile(oddsFile, "utf8");
        const webOdds: WebSearchOdds = JSON.parse(oddsText);

        if (webOdds.validation.passed && webOdds.confidence >= 0.7) {
          // Merge web search odds into job state
          if (job.state?.pipeline?.fetched) {
            const existingOdds = (job.state.pipeline.fetched.odds as Record<string, unknown>) || {};
            const webH2H = webOdds.consensus_odds.h2h || {};
            job.state.pipeline.fetched.odds = Object.assign({}, existingOdds, webH2H, {
              odds_source: "web_search_consensus",
              odds_quality: "degraded",
              confidence: webOdds.confidence,
            });
            successCount++;
          }
        }
      } catch {
        // No web search odds for this fixture
      }
    }

    if (successCount > 0) {
    }

    return jobs;
  } catch (_err) {
    return jobs;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface FetchResult {
  jobs: FixtureJob[];
  source: "api" | "web_search_consensus" | "cache" | "empty";
  quality?: "live" | "degraded" | "no_odds";
  fetchedAt: string;
}

export async function fetchTodaysFixtures(
  oddsApiKey: string | undefined,
  enableWebSearchFallback: boolean = true,
  geminiApiKey?: string,
  footballDataApiKey?: string,
  perplexityApiKey?: string,
  oddsPapiKey?: string,
  apiFootballKey?: string
): Promise<FetchResult> {
  // Structured free-API odds providers (OddsPapi → API-Football → stubs). Built
  // once; the gap-fill tries this chain before the Gemini/web-search degraded path.
  const oddsProviders = buildOddsProviders({ oddsPapiKey, apiFootballKey });

  // T0 news intel runs after H2H on every return path (cache-first, non-fatal).
  const enrich = async (jobs: FixtureJob[]): Promise<FixtureJob[]> => {
    const withH2H = await enrichWithH2H(jobs, footballDataApiKey);
    return enrichWithNewsIntel(withH2H, perplexityApiKey);
  };

  if (!oddsApiKey) {
    const cached = await readCachedJobs();
    const filled = await geminiOddsGapFill(
      cached.filter((j) => !j.state?.telemetry?.hOdds),
      geminiApiKey,
      oddsProviders
    );
    const jobs = await enrich([...cached.filter((j) => j.state?.telemetry?.hOdds), ...filled]);
    return {
      jobs,
      source: jobs.length ? "cache" : "empty",
      quality: filled.length ? "degraded" : "no_odds",
      fetchedAt: new Date().toISOString(),
    };
  }

  const today = new Date();
  const windowEnd = new Date(today.getTime() + 7 * 86_400_000);
  const dateFrom = `${today.toISOString().slice(0, 10)}T00:00:00Z`;
  const dateTo = `${windowEnd.toISOString().slice(0, 10)}T00:00:00Z`;

  const oddsJobs: FixtureJob[] = [];
  const errors: string[] = [];
  let quotaExhausted = false;

  for (const [sportKey, league] of Object.entries(SPORT_TO_LEAGUE)) {
    try {
      const games = await fetchSportOdds(oddsApiKey, sportKey, dateFrom, dateTo);
      for (const game of games) {
        const job = gameToFixtureJob(game, league);
        if (job) oddsJobs.push(job);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${sportKey}: ${msg}`);
      if (msg.includes("quota")) {
        quotaExhausted = true;
        break;
      }
    }
  }

  if (errors.length)
    if (oddsJobs.length > 0) {
      // Merge into today.txt without overwriting scraped fixtures
      await mergeCache(oddsJobs);

      // Gap-fill: find scraped fixtures with no Odds API match and try Gemini
      const scraped = await readCachedJobs();
      const unmatched = findUnmatched(scraped, oddsJobs);
      const filled = await geminiOddsGapFill(unmatched, geminiApiKey, oddsProviders);

      const preEnrich = [...oddsJobs, ...filled];
      const allJobs = await enrich(preEnrich);
      return {
        jobs: allJobs,
        source: "api",
        quality: filled.length > 0 ? "degraded" : "live",
        fetchedAt: new Date().toISOString(),
      };
    }

  // Quota exhausted — try web search fallback then Gemini on cached
  if (quotaExhausted && enableWebSearchFallback) {
    const cached = await readCachedJobs();
    if (cached.length > 0) {
      const enhanced = await fetchWebSearchOdds(cached, true);
      const enrichedJobs = await enrich(enhanced);
      return {
        jobs: enrichedJobs,
        source: "web_search_consensus",
        quality: "degraded",
        fetchedAt: new Date().toISOString(),
      };
    }
  }

  // Fall back to cache + Gemini gap-fill
  const cached = await readCachedJobs();
  if (cached.length) {
    const filled = await geminiOddsGapFill(cached, geminiApiKey, oddsProviders);
    if (filled.length > 0) {
      const enrichedJobs = await enrich(filled);
      return {
        jobs: enrichedJobs,
        source: "web_search_consensus",
        quality: "degraded",
        fetchedAt: new Date().toISOString(),
      };
    }
    return {
      jobs: cached,
      source: "cache",
      quality: "no_odds",
      fetchedAt: new Date().toISOString(),
    };
  }

  return { jobs: [], source: "empty", quality: "no_odds", fetchedAt: new Date().toISOString() };
}

// ── Single-fixture lookup by name (web search box / CLI `fixture`) ────────────

// Team-name normalisation + alias matching live in teamNames.ts (shared with
// oddsProviders.ts). normTeam/namesMatch imported at top of file.

/** Resolve a single typed fixture ("Arsenal" vs "Chelsea") to a FixtureJob with live odds.
 *
 *  1. Fast path: scan the cached daily fixture list (.tmp/fixtures/today.txt).
 *  2. Else query the Odds API. With a leagueHint, only that sport is queried; otherwise every
 *     sport in SPORT_TO_LEAGUE is tried until a fuzzy home+away match is found (stops on quota).
 *
 *  Returns null when no odds-bearing match is found (caller decides fallback). */
export async function fetchFixtureByName(
  home: string,
  away: string,
  oddsApiKey: string | undefined,
  leagueHint?: string,
  geminiApiKey?: string
): Promise<FixtureJob | null> {
  // 1. Fast path — already-fetched daily cache (only if the job has live odds)
  const cached = await readCachedJobs();
  const hit = cached.find((j) => namesMatch(j.home, home) && namesMatch(j.away, away));
  if (hit?.state?.telemetry?.hOdds) return hit;

  // 2. Odds API — choose which sports to query
  // If a cache hit exists (no odds), infer league hint from it to narrow the API call.
  const effectiveLeague = leagueHint ?? hit?.league;
  let oddsJob: FixtureJob | null = null;

  if (oddsApiKey) {
    let sportKeys = Object.keys(SPORT_TO_LEAGUE);
    if (effectiveLeague) {
      const match = Object.entries(SPORT_TO_LEAGUE).find(([, lg]) => lg === effectiveLeague);
      if (match) sportKeys = [match[0]];
    }

    const today = new Date();
    const windowEnd = new Date(today.getTime() + 14 * 86_400_000);
    const dateFrom = `${today.toISOString().slice(0, 10)}T00:00:00Z`;
    const dateTo = `${windowEnd.toISOString().slice(0, 10)}T00:00:00Z`;

    for (const sportKey of sportKeys) {
      try {
        const games = await fetchSportOdds(oddsApiKey, sportKey, dateFrom, dateTo);
        const game = games.find(
          (g) => namesMatch(g.home_team, home) && namesMatch(g.away_team, away)
        );
        if (game) {
          oddsJob = gameToFixtureJob(game, SPORT_TO_LEAGUE[sportKey]!);
          break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("quota")) break; // stop immediately on quota exhaustion
      }
    }
  }

  if (oddsJob) return oddsJob;

  // 3. Gemini gap-fill — fetch odds via Gemini Search when Odds API is unavailable/exhausted
  const league = effectiveLeague ?? "FIFA World Cup";
  const kickoff = hit?.kickoff ?? new Date().toISOString();
  const geminiResults = await geminiOddsGapFill(
    [{ home, away, league, kickoff }],
    geminiApiKey
  );
  if (geminiResults.length) return geminiResults[0]!;

  // 4. Return the no-odds cache hit as last resort (engine will degrade gracefully)
  return hit ?? null;
}
