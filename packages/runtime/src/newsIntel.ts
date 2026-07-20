/** T0 news / team intelligence enrichment (Perplexity Sonar + Google AI-Mode ensemble).
 *
 *  Runtime pre-batch step (mirrors h2h.ts): fetches injuries/suspensions/lineups/
 *  motivation/travel for each fixture and merges them into
 *  job.state.telemetry.softContext BEFORE the engine runs. Lives in the runtime
 *  layer — not the engine — so file caching stays out of the fs-free engine.
 *
 *  Flow per fixture:
 *    0. Daily Parquet lake (tools/enrich_news.py's 00:00 acquisition, per-team
 *       news) — free, no key required; a hit skips steps 1-3 entirely.
 *    1. Check .tmp/news_intel/<slug>.json file cache (TTL 2h — fast same-day reuse)
 *    2. Check GBrain (news:<slug>) — durable cross-day memory; rehydrate file cache on hit
 *    3. fetchNewsEnsemble — Perplexity Sonar + Google AI-Mode in parallel, merged
 *    4. Persist acquisition to BOTH file cache and GBrain (storage.set)
 *    5. Convert result to SoftContextItem[] and merge into telemetry.softContext
 *    6. Never throws — returns jobs unchanged on any failure
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureJob } from "@oracle/engine";
import { fetchNewsEnsemble, isLocalRuntime, type NewsIntelResult } from "@oracle/llm";
import type { StoragePort } from "@oracle/storage";
import { resolveAlias } from "./teamNames.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");
const NEWS_DIR = join(ROOT, ".tmp/news_intel");
const APIFOOTBALL_BASE = "https://v3.football.api-sports.io";

const CACHE_TTL_MS = 2 * 3_600_000; // 2h — pre-match news firms up close to kickoff
const REQ_DELAY_MS = 1_500; // gentle spacing; Sonar has generous limits
const MAX_JOBS = 30; // cap Sonar calls per batch

interface NewsCache extends NewsIntelResult {
  fetchedAt: string;
}

interface SoftContextItem {
  kind: "lineup" | "injury" | "news" | "motivation" | "stats";
  text: string;
  source: string;
  observedAt: string;
}

function slug(home: string, away: string): string {
  const s = (n: string) =>
    n
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
  return `${s(home)}_vs_${s(away)}`;
}

async function readCache(home: string, away: string): Promise<NewsCache | null> {
  try {
    const text = await readFile(join(NEWS_DIR, `${slug(home, away)}.json`), "utf8");
    const data = JSON.parse(text) as NewsCache;
    if (Date.now() - new Date(data.fetchedAt).getTime() < CACHE_TTL_MS) return data;
  } catch {
    /* miss */
  }
  return null;
}

async function writeCache(home: string, away: string, data: NewsCache): Promise<void> {
  await mkdir(NEWS_DIR, { recursive: true });
  await writeFile(
    join(NEWS_DIR, `${slug(home, away)}.json`),
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

/** Convert a NewsIntelResult into advisory SoftContextItems (same mapping the engine used).
 *  `source` carries provenance: perplexity-… | google-ai-mode-… | ensemble.
 *  `observedAt` is the acquisition recency anchor carried through from the provider. */
function toSoftContext(intel: NewsIntelResult): SoftContextItem[] {
  const observedAt = intel.observedAt ?? new Date().toISOString();
  const items: SoftContextItem[] = [];
  const push = (kind: SoftContextItem["kind"], texts: string[]) => {
    for (const text of texts) items.push({ kind, text, source: intel.model, observedAt });
  };
  push("injury", intel.injuries);
  push("injury", intel.suspensions); // suspensions are absence signals, same kind
  push("lineup", intel.lineupHints);
  push("motivation", intel.motivationFlags);
  push("news", intel.travelFlags);
  return items;
}

export interface NewsIntelOpts {
  /** Perplexity Sonar key — enables the Sonar path. */
  perplexityApiKey?: string;
  /** Gemini key — enables the Google AI-Mode scrape + Gemini reshape fallback. */
  geminiApiKey?: string;
  /** Durable GBrain store for cross-day "remember this match" persistence. */
  storage?: StoragePort;
  /** Cache-only mode: read the daily lake / file cache / GBrain ONLY — never trigger
   *  the live ensemble (Perplexity/Playwright/Claude scrape). Used by the goals-ACCA
   *  pipeline, which must consume news already enriched during the daily-scrape phase
   *  (enrich_news.py + the main batch) rather than launch per-fixture live scraping
   *  in the middle of its own analysis run. Default false (full live acquisition). */
  cacheOnly?: boolean;
  /** [Phase 3, patterns-v62-core] API-Football key — enables the one-sweep
   *  /injuries?date=YYYY-MM-DD pre-pass below (see fetchInjuriesSweep). Same
   *  env var (API_FOOTBALL_KEY) resolveFixtures.ts already uses for finished-
   *  match resolution; free tier = 100 req/day, all endpoints, so one call
   *  per slate is negligible against that budget. Absent ⇒ the sweep is
   *  skipped entirely (data-never-a-blocker: every fixture still gets the
   *  existing per-fixture lake/cache/ensemble tiers unchanged). */
  apiFootballKey?: string;
}

interface AFInjuryEntry {
  player?: { name?: string; type?: string; reason?: string };
  team?: { name?: string };
}
interface AFInjuriesResponse {
  response?: AFInjuryEntry[];
  errors?: Record<string, unknown> | unknown[];
}

/** [Phase 3, patterns-v62-core] One-sweep API-Football v3
 *  `/injuries?date=YYYY-MM-DD` fetch — ONE call returns every injury/
 *  suspension across the WHOLE day's slate, joined onto individual fixtures
 *  by team name below (exact alias-resolved match — see
 *  injurySweepToSoftContext's own doc comment for why the substring-tolerant
 *  namesMatch isn't used for this specific global join) — NOT a per-fixture
 *  call like the existing
 *  Perplexity/Google AI-Mode ensemble. A cheap, additive pre-pass: it never
 *  replaces the existing per-fixture tiers, only adds one more source of
 *  "injury" SoftContextItems ahead of them.
 *  Never throws — any fetch/parse/rate-limit failure returns an empty map,
 *  and every caller falls through to the unchanged existing tiers (data-
 *  never-a-blocker rule): an uncovered league just keeps today's coverage
 *  exactly as it was before this sweep existed. */
async function fetchInjuriesSweep(
  apiFootballKey: string,
  date: string
): Promise<Map<string, string[]>> {
  const byTeam = new Map<string, string[]>();
  try {
    const res = await fetch(`${APIFOOTBALL_BASE}/injuries?date=${date}`, {
      headers: { "x-apisports-key": apiFootballKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return byTeam;
    const body = (await res.json()) as AFInjuriesResponse;
    // Same free-plan date-window rejection shape resolveFixtures.ts's
    // fetchFinishedMatchesApiFootball already guards against — HTTP 200 with
    // a populated `errors` field rather than a non-2xx status.
    const errCount = Array.isArray(body.errors)
      ? body.errors.length
      : body.errors
        ? Object.keys(body.errors).length
        : 0;
    if (errCount > 0) return byTeam;

    for (const entry of body.response ?? []) {
      const team = entry.team?.name;
      const player = entry.player?.name;
      if (!team || !player) continue;
      const reason = entry.player?.type ?? entry.player?.reason ?? "unavailable";
      const list = byTeam.get(team) ?? [];
      list.push(`${player} (${reason})`);
      byTeam.set(team, list);
    }
  } catch {
    /* network/parse failure — empty map, callers unaffected */
  }
  return byTeam;
}

/** Joins one team's slice of the injuries-sweep map into SoftContextItems,
 *  same "injury" kind + shape every other source already produces
 *  (toSoftContext/lakeRowToSoftContext) so downstream consumers (LLM
 *  briefing, human reports) don't need a new code path for this source.
 *
 *  Exact alias-resolved match ONLY (adversarial review finding, 2026-07-20)
 *  — deliberately does NOT use namesMatch's substring-tolerant fallback
 *  here. namesMatch was designed for small, already-date/fixture-scoped
 *  candidate pairs (e.g. matching one odds-provider row against one known
 *  fixture); this function instead linearly scans EVERY team in the WHOLE
 *  day's global injuries response. Substring tolerance at that scale is
 *  genuinely dangerous: short/generic club names collide ("Union" would
 *  substring-match both Union Berlin and Unión Santa Fe; "America" both
 *  Club América and América-MG), silently attaching a real but WRONG
 *  club's injuries as a fabricated "key player out" signal onto an
 *  unrelated fixture. resolveAlias still normalises case/diacritics/suffixes
 *  and resolves the same alias table namesMatch uses — only the substring
 *  fallback is removed. */
function injurySweepToSoftContext(
  byTeam: Map<string, string[]>,
  teamName: string,
  observedAt: string
): SoftContextItem[] {
  const target = resolveAlias(teamName);
  if (!target) return [];
  for (const [afTeam, injuries] of byTeam) {
    if (resolveAlias(afTeam) === target) {
      return injuries.map((text) => ({
        kind: "injury",
        text,
        source: "api-football-injuries",
        observedAt,
      }));
    }
  }
  return [];
}

/** Map one per-team lake news row into SoftContextItems. "perplexity" rows
 *  carry the same structured shape callNewsIntel.ts produces (parsed from
 *  raw_json, written by tools/enrich_news.py's fetch_perplexity); "google_ai"
 *  rows are unstructured scraped prose (Phase A scope — no LLM reshape step in
 *  Python) and become one raw "news" item, which softContext already supports
 *  as free text. "rss_news"/"transfermarkt"/"fotmob"/"sofascore" rows (added
 *  2026-06-23 — see tools/enrich_news.py) are summary-only: each source's
 *  Python writer already condenses its raw_json into a one-line `summary`
 *  (see tools/enrich_news.py's _summary_from_* helpers), so this just emits
 *  that string under "stats" — the LLM-decision soft-context kind already
 *  used by sportyBetStats.ts's buildStatsSoftContext for the same purpose.
 *  "cloud_news" rows (written by tools/sync_cloud_news.py from the daily
 *  cloud routine) carry the same structured shape and parse identically. A
 *  malformed/unparseable row degrades to []. */
function lakeRowToSoftContext(row: {
  source: string;
  summary: string;
  rawJson: string;
  scrapedAt: string;
}): SoftContextItem[] {
  if (row.source === "perplexity" || row.source === "cloud_news") {
    try {
      const obj = JSON.parse(row.rawJson) as {
        injuries?: string[];
        suspensions?: string[];
        lineupHints?: string[];
        motivationFlags?: string[];
        travelFlags?: string[];
        model?: string;
      };
      const model =
        obj.model ?? (row.source === "cloud_news" ? "cloud-routine-lake" : "perplexity-lake");
      const items: SoftContextItem[] = [];
      const push = (kind: SoftContextItem["kind"], texts: string[] | undefined) => {
        for (const text of texts ?? [])
          items.push({ kind, text, source: model, observedAt: row.scrapedAt });
      };
      push("injury", obj.injuries);
      push("injury", obj.suspensions);
      push("lineup", obj.lineupHints);
      push("motivation", obj.motivationFlags);
      push("news", obj.travelFlags);
      return items;
    } catch {
      return [];
    }
  }
  if (row.source === "google_ai" && row.summary) {
    return [
      { kind: "news", text: row.summary, source: "google-ai-mode-lake", observedAt: row.scrapedAt },
    ];
  }
  if (row.source === "rss_news" && row.summary) {
    return [{ kind: "news", text: row.summary, source: "rss-lake", observedAt: row.scrapedAt }];
  }
  // OneFootball — confirmed/predicted lineups: the goals model cares most about
  // attacker availability, so route to the "lineup" kind (STEP 2 of the arbiter).
  if (row.source === "onefootball" && row.summary) {
    return [
      { kind: "lineup", text: row.summary, source: "onefootball-lake", observedAt: row.scrapedAt },
    ];
  }
  // Evening Standard — World Cup squad / injury news (general reportage).
  if (row.source === "evening_standard" && row.summary) {
    return [
      {
        kind: "news",
        text: row.summary,
        source: "evening-standard-lake",
        observedAt: row.scrapedAt,
      },
    ];
  }
  // Guardian Football — high-quality injury/squad/tactical reportage.
  if (row.source === "guardian_football" && row.summary) {
    return [
      { kind: "news", text: row.summary, source: "guardian-lake", observedAt: row.scrapedAt },
    ];
  }
  // Olé Internacional — La Liga/Serie A/Bundesliga from South American lens;
  // useful for motivation/Copa America hangover signals.
  if (row.source === "ole_internacional" && row.summary) {
    return [{ kind: "news", text: row.summary, source: "ole-lake", observedAt: row.scrapedAt }];
  }
  // FootballCritic — wide global club/transfer/injury headline coverage.
  if (row.source === "footballcritic" && row.summary) {
    return [
      { kind: "news", text: row.summary, source: "footballcritic-lake", observedAt: row.scrapedAt },
    ];
  }
  if (
    (row.source === "transfermarkt" || row.source === "fotmob" || row.source === "sofascore") &&
    row.summary
  ) {
    return [
      { kind: "stats", text: row.summary, source: `${row.source}-lake`, observedAt: row.scrapedAt },
    ];
  }
  // PR-8 generic default: any lake writer with a non-empty summary and an
  // unrecognised source is surfaced as news, tagged "<source>-lake". This
  // permanently closes the "7th source" gap class — a new Python lake writer is
  // visible to the decision layer with zero TS changes here. Empty-summary rows
  // still drop.
  if (row.summary) {
    return [
      { kind: "news", text: row.summary, source: `${row.source}-lake`, observedAt: row.scrapedAt },
    ];
  }
  return [];
}

/** Store-first read: today's per-team news from the Parquet lake, for both
 *  sides of the fixture. Dynamic import + broad catch, mirroring
 *  selectFixtures.ts's loadSportyBetIndex — a missing/broken dailyStore module
 *  degrades to [] so the caller falls through to file-cache/GBrain/live-
 *  ensemble unchanged. Never throws. */
async function loadLakeNews(today: string, home: string, away: string): Promise<SoftContextItem[]> {
  try {
    const { loadDailyNews, teamSlug } = await import("./dailyStore.js");
    const [homeRows, awayRows] = await Promise.all([
      loadDailyNews(today, teamSlug(home)),
      loadDailyNews(today, teamSlug(away)),
    ]);
    return [...(homeRows ?? []), ...(awayRows ?? [])].flatMap(lakeRowToSoftContext);
  } catch {
    return [];
  }
}

const gbrainKey = (home: string, away: string): string => `news:${slug(home, away)}`;

/** GBrain durable lookup, honoring the same 2h recency window as the file cache. */
async function readGbrain(
  storage: StoragePort | undefined,
  home: string,
  away: string
): Promise<NewsCache | null> {
  if (!storage) return null;
  try {
    const data = await storage.get<NewsCache>(gbrainKey(home, away));
    if (data && Date.now() - new Date(data.fetchedAt).getTime() < CACHE_TTL_MS) return data;
  } catch {
    /* miss */
  }
  return null;
}

/** Per-slate yield report for enrichWithNewsIntelReport — makes news-intel
 *  coverage visible to callers (e.g. a batch summary) instead of only ever
 *  logging to stderr. `disabledReason` is not set by this module for a
 *  populated slate; it exists so a caller that short-circuits BEFORE invoking
 *  enrichment (e.g. ENABLE_NEWS_INTEL=false upstream) can still hand back a
 *  well-formed NewsIntelYield with a reason attached, using the exact same
 *  shape as a real run. */
export interface NewsIntelYield {
  attempted: number;
  enriched: number;
  failed: number;
  disabledReason?: string; // set when enrichment was skipped entirely (e.g. "flag off")
  /** [Phase 3, patterns-v62-core] Present only when apiFootballKey was
   *  supplied (the sweep ran at all). `matchedFixtures` counts fixtures
   *  where at least one side joined against the sweep's team map — an
   *  uncovered league (matchedFixtures well below attempted) is a signal to
   *  check coverage, not a bug; those fixtures simply keep their existing
   *  lake/cache/ensemble/Playwright tiers unchanged. */
  injuriesSweep?: { teamsCovered: number; matchedFixtures: number };
}

/** Enrich up to MAX_JOBS fixtures with news intelligence, reporting per-fixture
 *  yield counts alongside the enriched jobs.
 *  Lookup order per fixture: daily Parquet lake (free, no key) -> file cache
 *  -> GBrain -> live ensemble acquisition (Perplexity if keyed, else the
 *  keyless Google AI-Mode + local-Claude reshape tier — see callNewsIntel.ts).
 *  Persists live acquisitions to BOTH file cache and GBrain. Never throws. */
export async function enrichWithNewsIntelReport(
  jobs: FixtureJob[],
  opts: NewsIntelOpts
): Promise<{ jobs: FixtureJob[]; yield: NewsIntelYield }> {
  const { perplexityApiKey, geminiApiKey, storage, cacheOnly, apiFootballKey } = opts;
  const hasLiveKeys = !!perplexityApiKey || !!geminiApiKey || isLocalRuntime();
  // Whether to look beyond the daily lake (file cache + GBrain + maybe live ensemble).
  // In cacheOnly mode we still read file cache + GBrain but never invoke the live
  // ensemble — so the deeper lookup runs whenever there are live keys OR cacheOnly.
  const useDeeperLookup = hasLiveKeys || !!cacheOnly;
  // No provider key at all: the live ensemble, if it runs, falls through to the
  // keyless Google AI-Mode + local-Claude reshape tier only. Surfaced once per
  // slate (not per fixture) so the degraded mode is visible without log spam.
  const keylessMode = !perplexityApiKey && !geminiApiKey;
  let warnedKeyless = false;

  const eligible = jobs.map((job, idx) => ({ job, idx })).slice(0, MAX_JOBS);
  if (eligible.length === 0) {
    return { jobs, yield: { attempted: 0, enriched: 0, failed: 0 } };
  }

  const today = new Date().toISOString().slice(0, 10);
  const sweepObservedAt = new Date().toISOString();
  // [Phase 3, patterns-v62-core] ONE call for the whole slate — run before
  // the per-fixture loop below (which stays per-fixture for the existing
  // lake/cache/ensemble tiers). Empty map (key absent or the sweep failed)
  // ⇒ every fixture's injurySweepToSoftContext lookup below is a harmless no-op.
  const injuriesByTeam = apiFootballKey
    ? await fetchInjuriesSweep(apiFootballKey, today)
    : new Map<string, string[]>();
  let injuriesMatchedFixtures = 0;

  const enriched = [...jobs];
  let apiCalls = 0;
  let filled = 0;
  let failed = 0;
  let lakeHits = 0;

  for (const { job, idx } of eligible) {
    try {
      // 0. daily Parquet lake — store-first, free, no key needed.
      let items = await loadLakeNews(today, job.home, job.away);
      if (items.length > 0) lakeHits++;

      if (items.length === 0 && useDeeperLookup) {
        // 1. file cache (fast same-day reuse)
        let cached = await readCache(job.home, job.away);

        // 2. GBrain durable memory — rehydrate file cache on hit so next run is local
        if (!cached) {
          const fromGbrain = await readGbrain(storage, job.home, job.away);
          if (fromGbrain) {
            cached = fromGbrain;
            await writeCache(job.home, job.away, cached);
          }
        }

        // 3. acquire via ensemble (Perplexity + Google AI-Mode in parallel).
        //    Skipped entirely in cacheOnly mode — the goals pipeline must consume
        //    news enriched during the daily-scrape phase, never launch live
        //    per-fixture scraping mid-analysis.
        if (!cached && !cacheOnly) {
          if (keylessMode && !warnedKeyless) {
            console.warn("[newsIntel] no provider key — running keyless AI-Mode tier only");
            warnedKeyless = true;
          }
          if (apiCalls > 0) await new Promise((r) => setTimeout(r, REQ_DELAY_MS));
          const intel = await fetchNewsEnsemble(job.home, job.away, job.league, job.kickoff, {
            perplexityKey: perplexityApiKey,
            geminiKey: geminiApiKey,
          });
          apiCalls++;
          if (intel) {
            cached = { ...intel, fetchedAt: new Date().toISOString() };
            // 4. persist to BOTH file cache and GBrain
            await writeCache(job.home, job.away, cached);
            if (storage) {
              try {
                await storage.set(gbrainKey(job.home, job.away), cached);
              } catch {
                /* GBrain persist is best-effort */
              }
            }
          }
        }

        if (cached) items = toSoftContext(cached);
      }

      // [Phase 3, patterns-v62-core] Injuries sweep join — additive, applied
      // AFTER the lake/cache/ensemble tiers above (never gates them: this
      // runs regardless of whether `items` is already populated, and never
      // counts toward the `items.length === 0` deeper-lookup check above —
      // injuries-only coverage should never suppress the richer lineup/
      // motivation/travel signal those tiers can still provide).
      if (injuriesByTeam.size > 0) {
        const sweepItems = [
          ...injurySweepToSoftContext(injuriesByTeam, job.home, sweepObservedAt),
          ...injurySweepToSoftContext(injuriesByTeam, job.away, sweepObservedAt),
        ];
        if (sweepItems.length > 0) {
          items = [...items, ...sweepItems];
          injuriesMatchedFixtures++;
        }
      }

      if (!items.length) {
        failed++;
        continue;
      }

      const existingState = enriched[idx]?.state ?? {};
      const existingTel = existingState.telemetry ?? {};
      const existingSoft = (existingTel.softContext as SoftContextItem[] | undefined) ?? [];

      enriched[idx] = {
        ...enriched[idx]!,
        state: {
          ...existingState,
          telemetry: {
            ...existingTel,
            softContext: [...existingSoft, ...items],
          },
        },
      };
      filled++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[newsIntel] WARN ${job.home} vs ${job.away}: ${msg}\n`);
    }
  }

  process.stderr.write(
    `[newsIntel] filled=${filled}/${eligible.length} (lake=${lakeHits}${apiFootballKey ? `, injuries=${injuriesMatchedFixtures}/${eligible.length}` : ""})\n`
  );

  return {
    jobs: enriched,
    yield: {
      attempted: eligible.length,
      enriched: filled,
      failed,
      ...(apiFootballKey
        ? {
            injuriesSweep: {
              teamsCovered: injuriesByTeam.size,
              matchedFixtures: injuriesMatchedFixtures,
            },
          }
        : {}),
    },
  };
}

/** Enrich up to MAX_JOBS fixtures with news intelligence. Thin wrapper over
 *  enrichWithNewsIntelReport for callers that only need the enriched jobs —
 *  same signature/behavior as before yield-reporting was added. Never throws. */
export async function enrichWithNewsIntel(
  jobs: FixtureJob[],
  opts: NewsIntelOpts
): Promise<FixtureJob[]> {
  const { jobs: result } = await enrichWithNewsIntelReport(jobs, opts);
  return result;
}
