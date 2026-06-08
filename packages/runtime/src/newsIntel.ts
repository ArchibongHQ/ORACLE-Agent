/** T0 news / team intelligence enrichment (Perplexity Sonar).
 *
 *  Runtime pre-batch step (mirrors h2h.ts): fetches injuries/suspensions/lineups/
 *  motivation/travel for each fixture and merges them into
 *  job.state.telemetry.softContext BEFORE the engine runs. Lives in the runtime
 *  layer — not the engine — so file caching stays out of the fs-free engine.
 *
 *  Flow per fixture:
 *    1. Check .tmp/news_intel/<slug>.json cache (TTL 2h — news firms up near kickoff)
 *    2. Call fetchNewsIntelligence (Perplexity Sonar, sonar-pro -> sonar)
 *    3. Convert result to SoftContextItem[] and merge into telemetry.softContext
 *    4. Never throws — returns jobs unchanged on any failure
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureJob } from "@oracle/engine";
import { fetchNewsIntelligence, type NewsIntelResult } from "@oracle/llm";

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

/** Convert a NewsIntelResult into advisory SoftContextItems (same mapping the engine used). */
function toSoftContext(intel: NewsIntelResult): SoftContextItem[] {
  const observedAt = new Date().toISOString();
  const items: SoftContextItem[] = [];
  const push = (kind: SoftContextItem["kind"], texts: string[]) => {
    for (const text of texts)
      items.push({ kind, text, source: `perplexity-${intel.model}`, observedAt });
  };
  push("injury", intel.injuries);
  push("injury", intel.suspensions); // suspensions are absence signals, same kind
  push("lineup", intel.lineupHints);
  push("motivation", intel.motivationFlags);
  push("news", intel.travelFlags);
  return items;
}

/** Enrich up to MAX_JOBS fixtures with Perplexity news intelligence.
 *  Cache-first; merges into job.state.telemetry.softContext. Never throws. */
export async function enrichWithNewsIntel(
  jobs: FixtureJob[],
  apiKey: string | undefined
): Promise<FixtureJob[]> {
  if (!apiKey) return jobs;

  const eligible = jobs.map((job, idx) => ({ job, idx })).slice(0, MAX_JOBS);
  if (eligible.length === 0) return jobs;

  const enriched = [...jobs];
  let apiCalls = 0;
  let filled = 0;

  for (const { job, idx } of eligible) {
    try {
      let cached = await readCache(job.home, job.away);

      if (!cached) {
        if (apiCalls > 0) await new Promise((r) => setTimeout(r, REQ_DELAY_MS));
        const intel = await fetchNewsIntelligence(
          job.home,
          job.away,
          job.league,
          job.kickoff,
          apiKey
        );
        apiCalls++;
        if (intel) {
          cached = { ...intel, fetchedAt: new Date().toISOString() };
          await writeCache(job.home, job.away, cached);
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
      const _msg = err instanceof Error ? err.message : String(err);
    }
  }

  if (filled > 0) {
  }

  return enriched;
}
