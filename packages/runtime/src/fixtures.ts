/** Odds API integration — Phase 4.
 *  Fetches today's fixtures + odds, returns FixtureJob[] ready for runBatch.
 *  Falls back to .tmp/fixtures/today.txt when API key is absent or quota exhausted.
 *  Gap-fill: fixtures scraped but not covered by the Odds API get odds via Gemini Search.
 *  Every path is gated through selectFixtures (SportyBet-today membership +
 *  composite score + MAX_FIXTURES_PER_RUN cap) before any per-fixture paid call. */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { FixtureJob, RunState, SoftContextItem, Weather } from "@oracle/engine";
import { parseFixtureList, runPool } from "@oracle/engine";
import type { LLMCallContext } from "@oracle/llm";
import { fetchOddsViaGemini } from "@oracle/llm";
import type { StoragePort } from "@oracle/storage";
import { enrichWithH2H } from "./h2h.js";
import { enrichWithLineups } from "./lineups.js";
import { enrichWithNewsIntel } from "./newsIntel.js";
import { buildOddsProviders, type OddsProvider, runOddsChain } from "./oddsProviders.js";
import {
  DEFAULT_MAX_FIXTURES_PER_RUN,
  loadSportyBetIndex,
  type SelectionCandidate,
  type SportyBetWeatherEntry,
  selectFixtures,
} from "./selectFixtures.js";
import { flattenSidecarOdds } from "./sidecarOdds.js";
import { buildMotivation, buildStatsOverride, buildStatsSoftContext } from "./sportyBetStats.js";
import { namesMatch } from "./teamNames.js";
import { buildTravel } from "./travel.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");
const CACHE_PATH = join(ROOT, ".tmp/fixtures/today.txt");
const ODDS_CACHE_DIR = join(ROOT, ".tmp/odds");

// A bare "python" relies on PATH resolution, which a Windows service host does
// not inherit the same way an interactive shell does — causing a silent spawn
// ENOENT under Servy while working fine from a terminal. Resolve an absolute
// path up front so behavior is identical in both contexts.
export function resolvePythonBin(): string {
  if (process.env.PYTHON_BIN && existsSync(process.env.PYTHON_BIN)) {
    return process.env.PYTHON_BIN;
  }
  if (process.platform === "win32") {
    const candidates = [
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python313", "python.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Python", "bin", "python.exe"),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    // Under a Windows service (LocalSystem) LOCALAPPDATA points at the systemprofile,
    // not the human user whose per-user Python install actually exists — so the
    // candidates above miss. Scan every real user profile's per-user install location
    // (no hardcoded username) and pick the highest Python3* version found.
    const userPython = scanUserProfilesForPython();
    if (userPython) return userPython;
    return "python";
  }
  return "python3";
}
/** Walk C:\Users\<each>\AppData\Local\Programs\Python\Python3* for python.exe.
 *  Returns the highest-versioned match, or undefined if none exist. */
function scanUserProfilesForPython(): string | undefined {
  const usersDir = join(process.env.SystemDrive ?? "C:", "\\", "Users");
  let best: { version: number; path: string } | undefined;
  let users: string[];
  try {
    users = readdirSync(usersDir);
  } catch {
    return undefined;
  }
  for (const user of users) {
    const pyRoot = join(usersDir, user, "AppData", "Local", "Programs", "Python");
    let entries: string[];
    try {
      entries = readdirSync(pyRoot);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const m = /^Python(\d+)$/i.exec(entry);
      if (!m) continue;
      const exe = join(pyRoot, entry, "python.exe");
      if (!existsSync(exe)) continue;
      const version = Number(m[1]);
      if (!best || version > best.version) best = { version, path: exe };
    }
  }
  return best?.path;
}

const PYTHON_BIN = resolvePythonBin();

// ── Odds API sport → ORACLE league name ──────────────────────────────────────
// This is the Odds-API pricing map (sport key → league display name) — it does
// NOT gate fixture eligibility. Fixture selection never filters by league.

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

const KPH_TO_MPH = 0.621371;

/** [PR-18] Converts scrape_fixtures.py's weather block (camelCase, km/h/mm —
 *  matching fetch_weather.py's existing backfill/GBM convention) into
 *  @oracle/engine's Weather shape (wind_mph/rain_mm — the units
 *  applyEnvironmentalPenalties' thresholds were tuned against). Null/absent
 *  input (team outside TEAM_CITY, fetch failure, ORACLE_FETCH_WEATHER=off)
 *  passes through as undefined — the engine already treats a missing Weather
 *  as "no penalty", never a hard requirement. */
export function toEngineWeather(
  raw: SportyBetWeatherEntry | null | undefined
): Weather | undefined {
  if (!raw || (raw.windKph == null && raw.precipMm == null)) return undefined;
  return {
    ...(raw.windKph != null ? { wind_mph: raw.windKph * KPH_TO_MPH } : {}),
    ...(raw.precipMm != null ? { rain_mm: raw.precipMm } : {}),
  };
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
      `selected=${stats.selected} llmRouted=${stats.llmRouted} deduped=${stats.deduped} ` +
      `(bulkOdds=${stats.bulkOdds} priority=${stats.priority} droppedBulkOdds=${stats.droppedBulkOdds})\n`
  );
  // For fixtures selected without bulk odds, inject sidecar odds (all markets)
  // into fetched.odds so the engine reaches the EV-market scan. Also merges
  // sportyBetStats/Odds/StatsCoverage for every fixture, and — via
  // buildStatsOverride/buildStatsSoftContext below — actually wires that data
  // into the engine's xH/xA/oppGA/restH/restA telemetry and the LLM soft
  // context, regardless of path (audited 2026-06-20: this comment used to
  // claim the engine/LLM already consumed H2H/form/xG/standings; they didn't).
  const injectSidecarOdds = (c: SelectionCandidate): FixtureJob => {
    const job = c.job;
    const detail = c.sportyBetDetail;
    const existingOdds = job.state?.pipeline?.fetched?.odds as Record<string, unknown> | undefined;
    const existingFetched = (job.state?.pipeline?.fetched ?? {}) as Record<string, unknown>;
    const existingTel = job.state?.telemetry ?? {};
    const existingSoft = (existingTel.softContext as SoftContextItem[] | undefined) ?? [];

    // Merge full sidecar stats into every fixture (both bulk-odds and sidecar-only paths)
    // [PR-18] `weather` is also lifted to its own fetched.weather key (not just
    // buried in sportyBetStats) since @oracle/engine's applyEnvironmentalPenalties
    // reads fetched.weather directly (execution/index.ts) — same convention as
    // fetched.odds already being both nested in sportyBetOdds and its own key.
    // Converted from scrape_fixtures.py's camelCase/km/h shape to the engine's
    // Weather interface (wind_mph/rain_mm) via toEngineWeather — see there.
    const engineWeather = toEngineWeather(detail?.stats?.weather);
    const statsEnrich =
      detail && !existingFetched.sportyBetStats
        ? {
            sportyBetStats: detail.stats,
            sportyBetOdds: detail.odds,
            sportyBetStatsCoverage: detail.statscoverage,
            ...(engineWeather != null ? { weather: engineWeather } : {}),
          }
        : {};

    // Data-quality-gated hard override of the engine's xH/xA (Alpha-model input)
    // plus the SoS/fatigue inputs the engine already has slots for but the
    // runtime never populated — and the full stats block as LLM soft context
    // (kind: "stats"). Both derive purely from `detail`, so safe to (re)compute
    // even when statsEnrich above was skipped as already-merged — idempotent.
    const statsOverride = buildStatsOverride(detail, job.league);
    const statsContext = buildStatsSoftContext(detail);

    // Deterministic feeds for engine telemetry slots that the runtime never
    // populated from data (only an optional LLM extraction): away-team travel +
    // venue altitude (haversine from the static venue table) and a standings-based
    // dead-rubber motivation signal. Both emit engine scalars AND an advisory
    // softContext item so the Claude arbiter sees the same signal in its prompt.
    const neutralVenue = job.league === "FIFA World Cup";
    const travel = buildTravel(job.home, job.away, { neutralVenue });
    const motivation = buildMotivation(detail);
    const extraSoft: SoftContextItem[] = [];
    if (travel.soft) extraSoft.push(travel.soft);
    if (motivation.soft) extraSoft.push(motivation.soft);

    const mergedSoft = [...existingSoft, ...statsContext, ...extraSoft];
    const softMerge = mergedSoft.length > existingSoft.length ? { softContext: mergedSoft } : {};
    const telemetryExtras = { ...travel.telemetry, ...motivation.telemetry };
    // Raw structured stats passthrough for the Opus arbiter prompt (STEP 0) —
    // alongside, not instead of, the distilled softContext prose above. We pass the
    // curated stats subtabs only (form/standings/goals/H2H/xG/O-U/congestion/
    // shots-corners/recentGoals/scoringConceding/discipline/positionTrend/topScorer)
    // — NOT the odds block: the engine-priced, de-vigged, EV-ranked markets already
    // reach the arbiter as STEP 4 "eligible markets", so re-dumping raw odds here
    // (let alone the 900-row allMarkets) would be redundant noise that dilutes the
    // signal and wastes the token budget. Curated > complete (Workstream I).
    const rawStatsMerge = detail?.stats
      ? { rawStatsBlock: detail.stats as unknown as Record<string, unknown> }
      : {};
    const hasOverrideOrContext =
      statsOverride !== null ||
      statsContext.length > 0 ||
      extraSoft.length > 0 ||
      Object.keys(telemetryExtras).length > 0;

    if (c.hasBulkOdds) {
      // Already has live odds — only touch the job if there's stats/override/context to add
      if (Object.keys(statsEnrich).length === 0 && !hasOverrideOrContext) return job;
      return {
        ...job,
        state: {
          ...job.state,
          telemetry: {
            ...existingTel,
            ...telemetryExtras,
            ...statsOverride,
            ...softMerge,
            ...rawStatsMerge,
          },
          pipeline: {
            ...job.state?.pipeline,
            fetched: { ...existingFetched, ...statsEnrich },
          },
        },
      };
    }

    if (!detail?.odds?.["1x2"]) return job; // no sidecar odds at all

    const flat = flattenSidecarOdds(detail);
    const h = flat.home;
    const d = flat.draw ?? 3.4;
    const a = flat.away;
    if (!h || !a) return job; // can't build a valid 1x2 triple

    const hoursToKO = Math.max(0, (new Date(job.kickoff).getTime() - Date.now()) / 3_600_000);
    return {
      ...job,
      state: {
        ...job.state,
        telemetry: {
          ...existingTel,
          hOdds: h,
          dOdds: d,
          aOdds: a,
          ohO: h,
          oaO: a,
          hoursToKO,
          ...telemetryExtras,
          ...statsOverride,
          ...softMerge,
          ...rawStatsMerge,
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

  // Stamp the per-candidate llmEligible flag (top-N by composite score) onto the
  // job's telemetry so it survives the SelectionCandidate -> FixtureJob rebuild.
  // runBatch reads this to gate the expensive LLM decision tier: every fixture
  // still gets the full deterministic stats/safety analysis, but only the top-N
  // hit the paid/slow LLM decide() path. Without this stamp the flag is lost and
  // all fixtures get LLM-analyzed, defeating the cap entirely.
  const stampEligible = (job: FixtureJob, eligible: boolean): FixtureJob => ({
    ...job,
    state: {
      ...job.state,
      telemetry: { ...(job.state?.telemetry ?? {}), llmEligible: eligible },
    },
  });
  const injected = new Map<SelectionCandidate, FixtureJob>(
    selected.map((c) => [c, stampEligible(injectSidecarOdds(c), c.llmEligible)])
  );
  // Post-injection odds check — NOT c.hasBulkOdds (the pre-injection flag).
  // injectSidecarOdds often successfully attaches real SportyBet sidecar odds
  // to a fixture that started with hasBulkOdds=false; routing those fixtures
  // into geminiOddsGapFill anyway means every sidecar-priced fixture pays the
  // full Tier 1->2->3 cost (up to a 20s Playwright spawn) for odds it already
  // has. Split on whether the job actually carries usable odds after injection.
  const hasUsableOdds = (j: FixtureJob): boolean => Number(j.state?.telemetry?.hOdds ?? 0) > 1;
  if (process.env.ORACLE_DEBUG_INJECT === "1") {
    const withDetail = selected.filter((c) => c.sportyBetDetail).length;
    const withOdds = [...injected.values()].filter(hasUsableOdds).length;
    process.stderr.write(
      `[debug-inject] selected=${selected.length} withDetail=${withDetail} withInjectedOdds=${withOdds}\n`
    );
  }
  return {
    jobs: selected.map((c) => injected.get(c)!),
    withOdds: selected.filter((c) => hasUsableOdds(injected.get(c)!)).map((c) => injected.get(c)!),
    withoutOdds: selected
      .filter((c) => !hasUsableOdds(injected.get(c)!))
      .map((c) => injected.get(c)!),
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

// ── Playwright / Google AI Mode last-resort tier ──────────────────────────────
// Standing rule (CLAUDE.md §6): a missing key MUST NEVER leave a fixture
// unpriced. When both the structured-provider chain AND Gemini return nothing,
// shell out to tools/scrape_google_ai.py and parse decimal odds from the prose.

/** Decimal-odds pattern: a number between 1.01 and 50, two decimal places. */
const _ODDS_RE = /\b([1-4]\d|[1-9])\.\d{2}\b/g;

/** Parse three plausible decimal-odds values (home / draw / away) from Google AI
 *  Mode prose. Heuristic: extract all matches, filter to the valid range, take the
 *  first three in document order. Applies the same overround gate as validateTriple
 *  in oddsProviders.ts (2%–20%). Returns null when no valid triple is found. */
function _parsePlaywrightOddsText(
  text: string
): { home: number; draw: number; away: number; overround: number } | null {
  const matches = [...text.matchAll(_ODDS_RE)].map((m) => Number(m[0]));
  const valid = matches.filter((v) => v >= 1.01 && v <= 50);
  if (valid.length < 3) return null;
  const [home, draw, away] = valid;
  const overround = 1 / home + 1 / draw + 1 / away - 1;
  if (overround < 0.02 || overround > 0.2) return null;
  return { home, draw, away, overround };
}

/** Tree-kill a process on timeout. child.kill() on Windows only signals the
 *  immediate child (python.exe) — if that's killed mid-flight, Playwright's
 *  already-launched chrome-headless-shell.exe is NOT in the same process
 *  group and survives as an orphan (its asyncio "finally: browser.close()"
 *  never runs because the interpreter was killed, not exited normally).
 *  taskkill /T recurses the whole tree; plain child.kill() is the right call
 *  everywhere else. */
function _killTree(pid: number): void {
  if (process.platform === "win32") {
    void import("node:child_process").then(({ execFile }) => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {
        /* best-effort — process may have already exited */
      });
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* process group may not exist if already exited */
    }
  }
}

/** Exported alias for _killTree so other files in this package (e.g.
 *  resolveFixtures.ts's web-search sweep timeout) can tree-kill a spawned
 *  process without reaching past the underscore-prefixed "private" name.
 *  Verified this file's own convention before adding this: every other
 *  `_`-prefixed helper here (_spawnAsync, _parsePlaywrightOddsText) is never
 *  imported elsewhere, while every un-prefixed export (resolvePythonBin,
 *  toEngineWeather, fetchFixtureByName, geminiOddsGapFill, …) is — and
 *  packages/llm/src/callClaudeCode.ts even duplicates this exact tree-kill
 *  logic locally rather than importing _killTree, citing only the
 *  cross-package dependency as the reason. So the underscore convention is
 *  real; this wrapper is the properly-named door through it, not a bypass. */
export function killProcessTree(pid: number): void {
  _killTree(pid);
}

/** Run a child process asynchronously, collecting stdout. Unlike spawnSync, this
 *  does not block the event loop — required so runPool can run multiple Playwright
 *  scrapes concurrently instead of serializing on a blocked main thread. */
function _spawnAsync(
  command: string,
  args: string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv }
): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    void import("node:child_process").then(({ spawn }) => {
      const child = spawn(command, args, { env: opts.env });
      let stdout = "";
      let settled = false;
      const finish = (status: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status, stdout });
      };
      const timer = setTimeout(() => {
        if (child.pid != null) _killTree(child.pid);
        finish(null);
      }, opts.timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", () => finish(null));
      child.on("close", (code) => finish(code));
    });
  });
}

/** Last-resort: spawn scrape_google_ai.py for one fixture, parse 1X2 from the
 *  Google AI Mode answer. Skipped in test environments (VITEST=true) and when
 *  ORACLE_NO_PLAYWRIGHT=true to avoid slow spawns in CI / unit tests.
 *  Uses an async spawn (not spawnSync) so runPool can run several of these
 *  concurrently instead of blocking the event loop one fixture at a time. */
async function fetchOddsViaPlaywright(
  home: string,
  away: string,
  league: string
): Promise<GapOdds | null> {
  if (process.env.VITEST || process.env.ORACLE_NO_PLAYWRIGHT === "true") return null;
  const query = `${home} vs ${away} ${league} betting odds 1X2`;
  const scriptPath = join(ROOT, "tools/scrape_google_ai.py");
  // 28s outer / ~18s inner (scrape_google_ai.py's own goto+wait+networkidle
  // budget): the outer deadline must stay comfortably above the script's
  // internal one so its own `finally: browser.close()` wins normally — a
  // hard taskkill /T /F on a mid-flight Python process can leave
  // chrome-headless-shell.exe orphaned on Windows (job-object quirk), and
  // those orphans compound across runs until they starve GAP_FILL_CONCURRENCY.
  const result = await _spawnAsync(
    PYTHON_BIN,
    [scriptPath, "--query", query, "--wait-ms", "4000"],
    {
      timeoutMs: 28_000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    }
  );
  if (result.status !== 0 || !result.stdout) return null;
  let payload: { ok?: boolean; result?: { text?: string } };
  try {
    payload = JSON.parse(result.stdout) as { ok?: boolean; result?: { text?: string } };
  } catch {
    return null;
  }
  if (!payload.ok || !payload.result?.text) return null;
  const parsed = _parsePlaywrightOddsText(payload.result.text);
  if (!parsed) return null;
  return {
    home: parsed.home,
    draw: parsed.draw,
    away: parsed.away,
    odds_source: "playwright_google_ai",
    odds_quality: "degraded",
    confidence: 0.45,
    sources: "google_ai_mode",
  };
}

/** Concurrency for the gap-fill pool. Tiers 1-2 (provider chain, Gemini) are
 *  plain network calls and tolerate high concurrency. Tier 3 (Playwright)
 *  spawns a full headless Chromium browser per fixture via scrape_google_ai.py
 *  — running 6 of those at once on a single machine causes real resource
 *  contention (verified: 6 concurrent browser launches all stalled at ~0% CPU
 *  for minutes, never completing). Cap the whole pool at the lower, browser-safe
 *  concurrency since any fixture in the batch might fall through to Tier 3. */
const GAP_FILL_CONCURRENCY = 3;

/** For fixtures not covered by the Odds API, acquire odds from the structured
 *  free-API provider chain first (SharpAPI.io → API-Football → …), then fall back to
 *  Gemini Search, and finally to the Playwright/Google-AI-Mode scraper (§6 no-data-blocker).
 *  Returns only jobs with confident odds.
 *
 *  Runs fixtures through runPool (not a sequential for-loop) — the Tier 3
 *  Playwright fallback alone can take 45-50s per fixture, so resolving them
 *  one at a time made this function the dominant cost of the entire daily
 *  batch on slates where ODDS_API_KEY is absent/invalid. */
export async function geminiOddsGapFill(
  unmatched: FixtureJob[],
  geminiApiKey: string | undefined,
  providers: OddsProvider[] = []
): Promise<FixtureJob[]> {
  if (unmatched.length === 0) return [];
  const hasChain = providers.some((p) => p.hasQuota());
  // No early-exit when both key and chain are absent — Playwright (tier 3) always fires.

  const ctx: LLMCallContext | null = geminiApiKey
    ? {
        config: { claudeApiKey: "", geminiApiKey, bankroll: 0 },
        requestedAt: new Date().toISOString(),
      }
    : null;

  await mkdir(ODDS_CACHE_DIR, { recursive: true });

  const results = await runPool<FixtureJob, FixtureJob | null>(
    unmatched,
    GAP_FILL_CONCURRENCY,
    async (job) => {
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

        // Tier 2: Gemini Search consensus (degraded).
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

        // Tier 3: Playwright / Google AI Mode — §6 no-data-blocker last resort.
        if (!resolved) {
          const p = await fetchOddsViaPlaywright(job.home, job.away, job.league);
          if (p) resolved = p;
        }

        if (!resolved) return null;

        const filledJob = jobFromGapOdds(job, resolved);

        // Write odds to cache for inspection — distinct path per fixture, safe under concurrency.
        const slug = `${job.home}_vs_${job.away}`
          .toLowerCase()
          .replace(/\s+/g, "_")
          .replace(/[^a-z0-9_]/g, "");
        await writeFile(
          join(ODDS_CACHE_DIR, `${slug}.json`),
          JSON.stringify(filledJob.state?.pipeline?.fetched?.odds, null, 2),
          "utf8"
        );

        return filledJob;
      } catch {
        return null; // non-fatal — move to next fixture
      }
    }
  );

  return results.filter((r): r is FixtureJob => r != null);
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
  minConsensus?: number,
  varianceThreshold?: number
): Promise<FixtureJob[]> {
  // Caller already gates on config.enableWebSearchOddsFallback before reaching here.
  if (jobs.length === 0) return jobs;

  try {
    const { spawnSync } = await import("node:child_process");
    const fixtureLines = jobs.map((j) => `${j.home} vs ${j.away}, ${j.league}, ${j.kickoff}`);
    const fixtureContent = fixtureLines.join("\n");

    // Write temp fixture list
    const tmpPath = join(ROOT, ".tmp/web_search_fixtures.txt");
    await writeFile(tmpPath, fixtureContent, "utf8");

    // Spawn Python scraper
    const cliArgs = [join(ROOT, "tools/scrape_live_odds.py"), "--fixtures", tmpPath, "--quiet"];
    if (minConsensus != null) cliArgs.push("--min-consensus", String(minConsensus));
    if (varianceThreshold != null) cliArgs.push("--variance-threshold", String(varianceThreshold));
    const result = spawnSync(PYTHON_BIN, cliArgs, {
      encoding: "utf8",
      timeout: 120_000, // 2 min per fixture
    });

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
  maxFixturesPerRun: number = DEFAULT_MAX_FIXTURES_PER_RUN,
  storage?: StoragePort,
  webOddsMinConsensus?: number,
  webOddsVarianceThreshold?: number
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
    const withNews = await enrichWithNewsIntel(withH2H, {
      perplexityApiKey,
      geminiApiKey,
      storage,
    });
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
  // Per-league failures worth surfacing (HTTP 5xx, parse errors, etc.). A dead
  // key (401) or exhausted quota (429) is NOT an error here — it's an expected
  // degraded-mode signal handled separately so it doesn't spam stderr every run.
  const errors: string[] = [];
  // Set when the Odds API is unusable for the whole run — either quota exhausted
  // (429) or a dead/invalid key (401). Both mean every league call will fail
  // identically, so we stop hammering and route to the same degraded fallback
  // (web search → cache + structured-provider/Gemini gap-fill) below.
  let oddsApiUnusable = false;
  let unusableReason = "";

  for (const [sportKey, league] of Object.entries(SPORT_TO_LEAGUE)) {
    try {
      const games = await fetchSportOdds(oddsApiKey, sportKey, dateFrom, dateTo);
      for (const game of games) {
        const job = gameToFixtureJob(game, league);
        if (job) oddsJobs.push(job);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A dead key (invalid key / 401) is run-fatal just like an exhausted quota:
      // every remaining league would fail identically, so stop and fall through
      // to the degraded path instead of looping the dead key across all leagues.
      // Record it as a degradation reason, not a per-league error (no log spam).
      if (msg.includes("quota") || msg.includes("invalid key")) {
        oddsApiUnusable = true;
        unusableReason = msg.includes("quota") ? "quota exhausted" : "invalid key";
        break;
      }
      errors.push(`${sportKey}: ${msg}`);
    }
  }

  // Only surface genuinely unexpected per-league failures. The 401/429
  // degradation is logged once, concisely, below — not as an error list.
  if (errors.length) process.stderr.write(`[fixtures] odds api errors: ${errors.join("; ")}\n`);
  if (oddsApiUnusable) {
    process.stderr.write(
      `[fixtures] odds api unavailable (${unusableReason}) — using fallback odds\n`
    );
  }

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

  // Odds API unusable (quota exhausted OR dead key) — degraded cascade over the
  // cached/scraped fixtures, best source first:
  //   1. structured free-API providers + Gemini search  (geminiOddsGapFill)
  //   2. Python web-scraper consensus                    (fetchWebSearchOdds)
  //   3. raw cache with no odds                          (no_odds)
  // Structured providers run before the slower, lower-quality web scraper so a
  // dead/exhausted Odds API key still yields priced, analysable fixtures.
  const cached = await readCachedJobs();
  if (cached.length) {
    const sel = await applySelection(cachedCandidates(cached), maxFixturesPerRun);

    // applySelection already injected FULL sidecar odds (1X2 + ou15/ou25/team-totals)
    // into every fixture that matched the SportyBet sidecar — those are the priced,
    // analysable jobs. Keep them as-is; only the ones STILL without a 1X2 price need
    // the structured-provider / Gemini gap-fill. Replacing the whole set with the
    // gap-fill output (1X2-only) would discard the richer sidecar goals markets.
    const hasOdds = (j: FixtureJob): boolean =>
      Number(j.state?.telemetry?.hOdds ?? 0) > 1 ||
      Number((j.state?.pipeline?.fetched?.odds as Record<string, number> | undefined)?.home ?? 0) >
        1;
    const priced = sel.jobs.filter(hasOdds);
    const unpriced = sel.jobs.filter((j) => !hasOdds(j));

    // Gap-fill only the unpriced remainder via structured providers → Gemini search.
    const gapFilled = await geminiOddsGapFill(unpriced, geminiApiKey, oddsProviders);
    const gapKeys = new Set(gapFilled.map((j) => `${j.home}|${j.away}|${j.kickoff}`));
    // Python web-scraper consensus for whatever the structured chain still missed.
    const stillUnpriced = unpriced.filter((j) => !gapKeys.has(`${j.home}|${j.away}|${j.kickoff}`));
    const webFilled =
      enableWebSearchFallback && stillUnpriced.length > 0
        ? (
            await fetchWebSearchOdds(stillUnpriced, webOddsMinConsensus, webOddsVarianceThreshold)
          ).filter(hasOdds)
        : [];

    const allPriced = [...priced, ...gapFilled, ...webFilled];
    if (allPriced.length > 0) {
      const enrichedJobs = await enrich(allPriced);
      return {
        jobs: enrichedJobs,
        source: priced.length ? "cache" : "web_search_consensus",
        quality: "degraded",
        fetchedAt: new Date().toISOString(),
      };
    }

    // Nothing priced anywhere — return raw selection, marked no_odds.
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
        const detail =
          sbHit.detail ??
          sidecarIndex.detailByKey.get(`${home.toLowerCase()}|${away.toLowerCase()}`);
        if (detail?.odds?.["1x2"]) {
          const flat = flattenSidecarOdds(detail);
          if (flat.home && flat.away) {
            const statsOverride = buildStatsOverride(detail, sidecarLeague);
            const statsContext = buildStatsSoftContext(detail);
            const travel = buildTravel(home, away, {
              neutralVenue: sidecarLeague === "FIFA World Cup",
            });
            const motivation = buildMotivation(detail);
            const adHocSoft = [
              ...statsContext,
              ...(travel.soft ? [travel.soft] : []),
              ...(motivation.soft ? [motivation.soft] : []),
            ];
            return {
              home,
              away,
              league: sidecarLeague ?? "Unknown",
              kickoff: sidecarKickoff ?? new Date().toISOString(),
              state: {
                telemetry: {
                  ...travel.telemetry,
                  ...motivation.telemetry,
                  ...statsOverride,
                  ...(adHocSoft.length ? { softContext: adHocSoft } : {}),
                  ...(detail.stats
                    ? { rawStatsBlock: detail.stats as unknown as Record<string, unknown> }
                    : {}),
                },
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
