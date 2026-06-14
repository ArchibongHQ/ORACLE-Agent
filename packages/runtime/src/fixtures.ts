/** Odds API integration — Phase 4.
 *  Fetches today's fixtures + odds, returns FixtureJob[] ready for runBatch.
 *  Falls back to .tmp/fixtures/today.txt when API key is absent or quota exhausted.
 *  Gap-fill: fixtures scraped but not covered by the Odds API get odds via Gemini Search.
 *  Every path is gated through selectFixtures (SportyBet-today membership +
 *  composite score + MAX_FIXTURES_PER_RUN cap) before any per-fixture paid call. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { FixtureJob, RunState } from "@oracle/engine";
import { parseFixtureList } from "@oracle/engine";
import type { LLMCallContext } from "@oracle/llm";
import { fetchOddsViaGemini } from "@oracle/llm";
import { enrichWithH2H } from "./h2h.js";
import { enrichWithLineups } from "./lineups.js";
import { enrichWithNewsIntel } from "./newsIntel.js";
import { buildOddsProviders, type OddsProvider, runOddsChain } from "./oddsProviders.js";
import {
  DEFAULT_MAX_FIXTURES_PER_RUN,
  loadSportyBetIndex,
  type SelectionCandidate,
  selectFixtures,
} from "./selectFixtures.js";
import { flattenSidecarOdds } from "./sidecarOdds.js";
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

// ── Pre-analysis selection (quota guard) ──────────────────────────────────────

/** Gate the fixture pool BEFORE any per-fixture paid call (gap-fill chain,
 *  web search, H2H/news enrichment): SportyBet-today membership + composite
 *  score + hard cap. See selectFixtures.ts for scoring.
 *  One clock for the sidecar staleness check AND the today-filter, so the two
 *  cannot disagree across a UTC midnight boundary. Logs go to stderr — stdout
 *  must stay clean for `oracle run --json` consumers. */
async function applySelection(
  pool: SelectionCandidate[],
  cap: number
): Promise<{ jobs: FixtureJob[]; withOdds: FixtureJob[]; withoutOdds: FixtureJob[] }> {
  const now = new Date();
  const index = await loadSportyBetIndex(now.toISOString().slice(0, 10));
  const { selected, stats } = selectFixtures(pool, { cap, sportyBet: index, now });
  if (stats.failOpen)
    process.stderr.write("[select] WARN sportybet index unavailable — fail-open\n");
  process.stderr.write(
    `[select] pool=${stats.pool} today=${stats.today} sportybet=${stats.sportyBet} ` +
      `selected=${stats.selected} (bulkOdds=${stats.bulkOdds} priority=${stats.priority} ` +
      `droppedBulkOdds=${stats.droppedBulkOdds})\n`
  );
  // For fixtures selected without bulk odds, inject sidecar odds (all markets)
  // into fetched.odds so the engine reaches the EV-market scan. Also merges
  // sportyBetStats/Odds/StatsCoverage for every fixture so the safety filter
  // and LLM prompt have H2H, form, xG, and standings regardless of path.
  const injectSidecarOdds = (c: SelectionCandidate): FixtureJob => {
    const job = c.job;
    const detail = c.sportyBetDetail;
    const existingOdds = job.state?.pipeline?.fetched?.odds as Record<string, unknown> | undefined;
    const existingFetched = (job.state?.pipeline?.fetched ?? {}) as Record<string, unknown>;

    // Merge full sidecar stats into every fixture (both bulk-odds and sidecar-only paths)
    const statsEnrich = detail && !existingFetched.sportyBetStats
      ? {
          sportyBetStats: detail.stats,
          sportyBetOdds: detail.odds,
          sportyBetStatsCoverage: detail.statscoverage,
        }
      : {};

    if (c.hasBulkOdds) {
      // Already has live odds — only add stats if missing
      if (Object.keys(statsEnrich).length === 0) return job;
      return {
        ...job,
        state: {
          ...job.state,
          pipeline: {
            ...job.state?.pipeline,
            fetched: { ...existingFetched, ...statsEnrich },
          },
        },
      };
    }

    if (!detail?.odds?.["1x2"]) return job; // no sidecar odds at all

    const flat = flattenSidecarOdds(detail);
    const h = flat["home"];
    const d = flat["draw"] ?? 3.4;
    const a = flat["away"];
    if (!h || !a) return job; // can't build a valid 1x2 triple

    const hoursToKO = Math.max(0, (new Date(job.kickoff).getTime() - Date.now()) / 3_600_000);
    return {
      ...job,
      state: {
        ...job.state,
        telemetry: {
          ...(job.state?.telemetry ?? {}),
          hOdds: h,
          dOdds: d,
          aOdds: a,
          ohO: h,
          oaO: a,
          hoursToKO,
        },
        pipeline: {
          ...job.state?.pipeline,
          fetched: {
            ...existingFetched,
            ...statsEnrich,
            odds: { ...(existingOdds ?? {}), ...flat },
          },
        },
      },
    };
  };

  const injected = new Map<SelectionCandidate, FixtureJob>(
    selected.map((c) => [c, injectSidecarOdds(c)])
  );
  return {
    jobs: selected.map((c) => injected.get(c)!),
    withOdds: selected.filter((c) => c.hasBulkOdds).map((c) => injected.get(c)!),
    withoutOdds: selected.filter((c) => !c.hasBulkOdds).map((c) => injected.get(c)!),
  };
}

/** Map cached fixtures to selection candidates — cached odds count as bulk. */
function cachedCandidates(jobs: FixtureJob[]): SelectionCandidate[] {
  return jobs.map((j) => ({
    job: j,
    hasBulkOdds: Boolean(j.state?.telemetry?.hOdds),
    llmEligible: false,
  }));
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
 *  free-API provider chain first (SharpAPI.io → API-Football → …), then fall back to
 *  Gemini Search for any still unresolved. Returns only jobs with confident odds. */
export async function geminiOddsGapFill(
  unmatched: FixtureJob[],
  geminiApiKey: string | undefined,
  providers: OddsProvider[] = []
): Promise<FixtureJob[]> {
  if (unmatched.length === 0) return [];
  const hasChain = providers.some((p) => p.hasQuota());
  if (!geminiApiKey && !hasChain) return [];

  const ctx: LLMCallContext | null = geminiApiKey
    ? {
        config: { claudeApiKey: "", geminiApiKey, bankroll: 0 },
        requestedAt: new Date().toISOString(),
      }
    : null;

  const filled: FixtureJob[] = [];

  for (const job of unmatched) {
    try {
      let resolved: GapOdds | null = null;

      // Tier 1: structured providers (sharp JSON beats LLM-scraped prose).
      if (hasChain) {
        const chain = await runOddsChain(providers, job.home, job.away, job.league, job.kickoff);
        if (chain && [chain.home, chain.draw, chain.away].every((v) => v >= 1.01 && v <= 50)) {
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
        if (g && [g.home, g.draw, g.away].every((v) => v >= 1.01 && v <= 50)) {
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
  sharpApiIoKey?: string,
  apiFootballKey?: string,
  oddsApiIoKey?: string,
  oddsPapiKey?: string,
  sportsGameOddsKey?: string,
  maxFixturesPerRun: number = DEFAULT_MAX_FIXTURES_PER_RUN
): Promise<FetchResult> {
  // Structured free-API odds providers (SharpAPI.io → API-Football → Odds-API.io
  // → OddsPapi → SportsGameOdds). Built once; the gap-fill tries this chain
  // before the Gemini/web-search degraded path.
  const oddsProviders = buildOddsProviders({
    sharpApiIoKey,
    apiFootballKey,
    oddsApiIoKey,
    oddsPapiKey,
    sportsGameOddsKey,
  });

  // T0 news intel runs after H2H on every return path (cache-first, non-fatal);
  // API-Football lineups (file-read from fetch_lineups.py output) merge last.
  const enrich = async (jobs: FixtureJob[]): Promise<FixtureJob[]> => {
    const withH2H = await enrichWithH2H(jobs, footballDataApiKey);
    const withNews = await enrichWithNewsIntel(withH2H, perplexityApiKey);
    return enrichWithLineups(withNews);
  };

  if (!oddsApiKey) {
    const cached = await readCachedJobs();
    const sel = await applySelection(cachedCandidates(cached), maxFixturesPerRun);
    const filled = await geminiOddsGapFill(sel.withoutOdds, geminiApiKey, oddsProviders);
    const jobs = await enrich([...sel.withOdds, ...filled]);
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

  if (errors.length) process.stderr.write(`[fixtures] odds api errors: ${errors.join("; ")}\n`);

  if (oddsJobs.length > 0) {
    // Merge into today.txt without overwriting scraped fixtures
    await mergeCache(oddsJobs);

    // Select before gap-fill: scraped fixtures with no Odds API match only get
    // the per-fixture chain if they survive the SportyBet-today gate + cap
    const scraped = await readCachedJobs();
    const unmatched = findUnmatched(scraped, oddsJobs);
    const sel = await applySelection(
      [
        ...oddsJobs.map((j) => ({ job: j, hasBulkOdds: true, llmEligible: false })),
        ...unmatched.map((j) => ({ job: j, hasBulkOdds: false, llmEligible: false })),
      ],
      maxFixturesPerRun
    );
    const filled = await geminiOddsGapFill(sel.withoutOdds, geminiApiKey, oddsProviders);

    const allJobs = await enrich([...sel.withOdds, ...filled]);
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
      const sel = await applySelection(cachedCandidates(cached), maxFixturesPerRun);
      if (sel.jobs.length > 0) {
        const enhanced = await fetchWebSearchOdds(sel.jobs, true);
        const enrichedJobs = await enrich(enhanced);
        return {
          jobs: enrichedJobs,
          source: "web_search_consensus",
          quality: "degraded",
          fetchedAt: new Date().toISOString(),
        };
      }
    }
  }

  // Fall back to cache + Gemini gap-fill
  const cached = await readCachedJobs();
  if (cached.length) {
    const sel = await applySelection(cachedCandidates(cached), maxFixturesPerRun);
    const filled = await geminiOddsGapFill(sel.jobs, geminiApiKey, oddsProviders);
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
      jobs: sel.jobs,
      source: sel.jobs.length ? "cache" : "empty",
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
 *  1.5. SportyBet sidecar: scan sportybet_today.json for a name match — provides
 *       kickoff/league context for African/Asian fixtures absent from today.txt.
 *  2. Odds API. With a leagueHint, only that sport is queried; otherwise every
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

  // 1.5. SportyBet sidecar — covers fixtures from SportyBet that are not in SPORT_TO_LEAGUE.
  //      When the sidecar has odds for this fixture, build a FixtureJob directly from it
  //      and return immediately — no Odds API call required.
  let sidecarLeague: string | undefined;
  let sidecarKickoff: string | undefined;
  if (!hit) {
    const today = new Date().toISOString().slice(0, 10);
    const sidecarIndex = await loadSportyBetIndex(today);
    if (sidecarIndex) {
      const sbHit = sidecarIndex.events.find(
        (ev) => namesMatch(ev.home, home) && namesMatch(ev.away, away)
      );
      if (sbHit) {
        sidecarLeague = sbHit.league ?? undefined;
        sidecarKickoff = sbHit.kickoff_utc ?? undefined;
        // If this sidecar event has detail+odds, build the job directly — no external API needed
        const detail = sbHit.detail ?? sidecarIndex.detailByKey.get(
          `${home.toLowerCase()}|${away.toLowerCase()}`
        );
        if (detail?.odds?.["1x2"]) {
          const flat = flattenSidecarOdds(detail);
          if (flat["home"] && flat["away"]) {
            return {
              home,
              away,
              league: sidecarLeague ?? "Unknown",
              kickoff: sidecarKickoff ?? new Date().toISOString(),
              state: {
                pipeline: {
                  fetched: {
                    odds: flat,
                    sportyBetStats: detail.stats,
                    sportyBetOdds: detail.odds,
                    sportyBetStatsCoverage: detail.statscoverage,
                  },
                },
              },
            };
          }
        }
      }
    }
  }

  // 2. Odds API — choose which sports to query
  // Prefer explicit leagueHint → sidecar league → cache hit league (narrowest query first).
  const effectiveLeague = leagueHint ?? sidecarLeague ?? hit?.league;
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
  const kickoff = hit?.kickoff ?? sidecarKickoff ?? new Date().toISOString();
  const geminiResults = await geminiOddsGapFill([{ home, away, league, kickoff }], geminiApiKey);
  if (geminiResults.length) return geminiResults[0]!;

  // 4. Return the no-odds cache hit as last resort (engine will degrade gracefully)
  return hit ?? null;
}
