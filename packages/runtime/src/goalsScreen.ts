/** Sonnet screening pass — stage 2 of the goals-discovery funnel (mechanical
 *  filter → Sonnet screen → Poisson engine → Opus arbiter → top-N cut).
 *
 *  Takes the ~100-150 fixtures preFilterGoalsCandidates() already mechanically
 *  ranked and runs a batched LLM judgment pass over compact per-fixture
 *  summaries, shortlisting by goals-opportunity strength before the costlier
 *  deterministic engine + Opus arbiter stages run on the survivors.
 *
 *  Model: Claude Sonnet (MODELS.CLAUDE_SONNET) — a narrow, explicit exception
 *  to this codebase's standing "never Sonnet" policy, scoped to this stage
 *  only (see cascade.ts). Chosen for cost reasons: this stage runs over a much
 *  larger fixture count than any other Claude call in the pipeline.
 *
 *  Batched (not one call per fixture) to bound daily cost — ~4-6 calls for a
 *  130-fixture pool at BATCH_SIZE=25, mirroring the FrugalGPT-style cascading
 *  pattern the pre-filter stage already documents. Fails open per batch: a
 *  timeout/error/parse-failure passes that batch through unscreened, ranked by
 *  its pre-filter mechanical score — mirrors arbitrate()'s fail-open contract
 *  in packages/engine/src/decision/index.ts (never blocks the funnel). */

import type { LLMCallContext } from "@oracle/llm";
import { callClaude, MODELS } from "@oracle/llm";
import type { GoalsPreFilterResult } from "./goalsPreFilter.js";

export const DEFAULT_SCREEN_BATCH_SIZE = 28;
const REQUEST_TIMEOUT_MS = 25_000;

export interface GoalsScreenResult {
  /** Index into the input candidates array. */
  index: number;
  /** Sonnet's goals-opportunity rank within its batch (lower = stronger). Absent
   *  when the batch fell through to the unscreened fallback. */
  rank?: number;
  rationale?: string;
  /** false when this entry is an unscreened fail-open fallback, not a real Sonnet verdict. */
  screened: boolean;
}

function compactSummary(candidate: GoalsPreFilterResult, index: number): string {
  const { event, score } = candidate;
  const stats = event.detail?.stats;
  const ou = stats?.overunder;
  const pv = stats?.possessionValue;
  const goals = stats?.goals;
  const parts = [
    `[${index}] ${event.home} vs ${event.away} (${event.league ?? "Unknown league"})`,
    `preFilterScore=${score.toFixed(1)}`,
    ou?.home?.over25_pct != null || ou?.away?.over25_pct != null
      ? `O2.5%=${ou?.home?.over25_pct ?? "?"}/${ou?.away?.over25_pct ?? "?"}`
      : null,
    goals?.home?.avg_scored != null || goals?.away?.avg_scored != null
      ? `avgScored=${goals?.home?.avg_scored ?? "?"}/${goals?.away?.avg_scored ?? "?"}`
      : null,
    pv?.home?.shots_on_target_avg != null || pv?.away?.shots_on_target_avg != null
      ? `shotsOnTarget=${pv?.home?.shots_on_target_avg ?? "?"}/${pv?.away?.shots_on_target_avg ?? "?"}`
      : null,
  ].filter((p): p is string => p !== null);
  return parts.join(", ");
}

const SCREEN_SYSTEM = `You screen football fixtures for GOALS-MARKET betting opportunity
(Over/Under goals, BTTS, Team Total Over) — not match-winner or handicap markets.
You receive a numbered list of fixtures with compact stats. Rank them by how
strong the data-backed case is for a goals-market opportunity, strongest first.
Return ONLY valid JSON: {"ranked":[{"index":N,"rationale":"one short sentence"}]}
Include every fixture index you were given, in ranked order. Do not invent stats
not given to you. A fixture with no extra stats beyond preFilterScore should rank
by that score alone — never omit it.`;

function parseScreenResponse(
  text: string,
  batchSize: number
): Array<{ index: number; rationale: string }> | null {
  try {
    const cleaned = text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as { ranked?: unknown };
    if (!Array.isArray(obj.ranked)) return null;
    const seen = new Set<number>();
    const ranked = obj.ranked
      .map((r) => r as { index?: unknown; rationale?: unknown })
      .filter((r) => typeof r.index === "number" && r.index >= 0 && r.index < batchSize)
      // Dedup by index, keeping the first (highest-ranked) occurrence — an LLM
      // repeating an index under token pressure must not silently demote that
      // candidate's real rank to whichever duplicate happened to sort last.
      .filter((r) => {
        const idx = r.index as number;
        if (seen.has(idx)) return false;
        seen.add(idx);
        return true;
      })
      .map((r) => ({ index: r.index as number, rationale: String(r.rationale ?? "") }));
    if (ranked.length === 0) return null;
    return ranked;
  } catch {
    return null;
  }
}

/** Screens one batch via Sonnet. Returns null on any failure (timeout, missing
 *  key, throw, unparseable response) — caller falls back to the unscreened
 *  pre-filter order for that batch, never blocks. */
async function screenBatch(
  batch: GoalsPreFilterResult[],
  ctx: LLMCallContext
): Promise<GoalsScreenResult[] | null> {
  if (!ctx.config.claudeApiKey) return null;
  const summaries = batch.map((c, i) => compactSummary(c, i)).join("\n");
  const prompt = `${SCREEN_SYSTEM}\n\nFixtures:\n${summaries}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      callClaude(prompt, ctx, { model: MODELS.CLAUDE_SONNET, maxTokens: 2048 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("goalsScreen timeout")), REQUEST_TIMEOUT_MS);
      }),
    ]);
    const parsed = parseScreenResponse(raw, batch.length);
    if (!parsed) return null;
    return parsed.map((r, rank) => ({
      index: r.index,
      rank,
      rationale: r.rationale,
      screened: true,
    }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Screens the full pre-filtered candidate pool in batches, run concurrently —
 *  each batch is an independent API call with no data dependency on any other
 *  batch, so running them in parallel bounds wall-clock latency to roughly the
 *  slowest single batch instead of the sum of all batches. Each batch's local
 *  indices are remapped back to indices into `candidates`. On a batch failure,
 *  that batch's fixtures are returned unscreened (screened=false), in their
 *  existing pre-filter order — the merged output is always the same length as
 *  the input, just with some entries marked unscreened rather than dropped. */
export async function screenGoalsCandidates(
  candidates: GoalsPreFilterResult[],
  ctx: LLMCallContext,
  batchSize: number = DEFAULT_SCREEN_BATCH_SIZE
): Promise<GoalsScreenResult[]> {
  const batchStarts: number[] = [];
  for (let start = 0; start < candidates.length; start += batchSize) batchStarts.push(start);

  const batchResults = await Promise.all(
    batchStarts.map(async (start) => {
      const batch = candidates.slice(start, start + batchSize);
      const screened = await screenBatch(batch, ctx);
      return { start, batch, screened };
    })
  );

  const results: GoalsScreenResult[] = [];
  for (const { start, batch, screened } of batchResults) {
    if (screened) {
      for (const r of screened) {
        results.push({ ...r, index: start + r.index });
      }
    } else {
      for (let i = 0; i < batch.length; i++) {
        results.push({ index: start + i, screened: false });
      }
    }
  }
  return results;
}

/** Merges screen results back onto the candidate pool, sorted by Sonnet's
 *  ranking (screened entries first, ranked ascending), with unscreened entries
 *  appended in their original pre-filter order. Fail-open: an entirely-failed
 *  screening pass (every batch null) returns the unscreened pre-filter order
 *  unchanged, never an empty list. */
export function mergeScreenedCandidates(
  candidates: GoalsPreFilterResult[],
  screenResults: GoalsScreenResult[]
): GoalsPreFilterResult[] {
  const byIndex = new Map(screenResults.map((r) => [r.index, r]));
  const screened: Array<{ candidate: GoalsPreFilterResult; rank: number }> = [];
  const unscreened: GoalsPreFilterResult[] = [];
  candidates.forEach((candidate, i) => {
    const r = byIndex.get(i);
    if (r?.screened && r.rank !== undefined) {
      screened.push({ candidate, rank: r.rank });
    } else {
      unscreened.push(candidate);
    }
  });
  screened.sort((a, b) => a.rank - b.rank);
  return [...screened.map((s) => s.candidate), ...unscreened];
}
