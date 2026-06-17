/** T0 news / team intelligence enrichment (Perplexity Sonar + Google AI-Mode ensemble).
 *
 *  Runtime pre-batch step (mirrors h2h.ts): fetches injuries/suspensions/lineups/
 *  motivation/travel for each fixture and merges them into
 *  job.state.telemetry.softContext BEFORE the engine runs. Lives in the runtime
 *  layer — not the engine — so file caching stays out of the fs-free engine.
 *
 *  Flow per fixture:
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
import { fetchNewsEnsemble, type NewsIntelResult } from "@oracle/llm";
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
  kind: "lineup" | "injury" | "news" | "motivation";
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
  /** Gemini key — enables the Google AI-Mode scrape + reshape fallback. */
  geminiApiKey?: string;
  /** Durable GBrain store for cross-day "remember this match" persistence. */
  storage?: StoragePort;
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

/** Enrich up to MAX_JOBS fixtures with ensemble news intelligence.
 *  Lookup order per fixture: file cache -> GBrain -> ensemble acquisition.
 *  Persists acquisitions to BOTH file cache and GBrain. Never throws. */
export async function enrichWithNewsIntel(
  jobs: FixtureJob[],
  opts: NewsIntelOpts
): Promise<FixtureJob[]> {
  const { perplexityApiKey, geminiApiKey, storage } = opts;
  if (!perplexityApiKey && !geminiApiKey) return jobs;

  const eligible = jobs.map((job, idx) => ({ job, idx })).slice(0, MAX_JOBS);
  if (eligible.length === 0) return jobs;

  const enriched = [...jobs];
  let apiCalls = 0;
  let filled = 0;

  for (const { job, idx } of eligible) {
    try {
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

      // 3. acquire via ensemble (Perplexity + Google AI-Mode in parallel)
      if (!cached) {
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

      if (!cached) continue;

      const items = toSoftContext(cached);
      if (!items.length) continue;

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
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[newsIntel] WARN ${job.home} vs ${job.away}: ${msg}\n`);
    }
  }

  process.stderr.write(`[newsIntel] filled=${filled}/${eligible.length}\n`);

  return enriched;
}
