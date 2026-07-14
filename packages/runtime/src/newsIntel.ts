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

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");
const NEWS_DIR = join(ROOT, ".tmp/news_intel");

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
  const { perplexityApiKey, geminiApiKey, storage, cacheOnly } = opts;
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

  process.stderr.write(`[newsIntel] filled=${filled}/${eligible.length} (lake=${lakeHits})\n`);

  return { jobs: enriched, yield: { attempted: eligible.length, enriched: filled, failed } };
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
