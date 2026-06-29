/** LLM screening pass — stage 2 of the full-market discovery funnel (mechanical
 *  filter → screening stage → Poisson engine → Opus arbiter → top-N cut).
 *
 *  Takes the full daily SportyBet fixture pool (up to 1000 fixtures after pool
 *  size increase) already mechanically ranked and runs a batched LLM judgment
 *  pass over compact per-fixture summaries, shortlisting by overall edge
 *  potential — goals markets first, but any positive-EV market edge counts.
 *
 *  Model: calls callClaudeCode() (local CLI transport), the same Opus pin as
 *  every other Claude call site in this pipeline.
 *
 *  Batched (not one call per fixture) to bound daily cost — ~10 calls for a
 *  1000-fixture pool at BATCH_SIZE=100. Fails open per batch: a
 *  timeout/error/parse-failure passes that batch through unscreened, ranked by
 *  its pre-filter mechanical score — mirrors arbitrate()'s fail-open contract
 *  in packages/engine/src/decision/index.ts (never blocks the funnel). */

import type { LLMCallContext } from "@oracle/llm";
import { callClaudeCode } from "@oracle/llm";
import type { GoalsPreFilterResult } from "./goalsPreFilter.js";

export const DEFAULT_SCREEN_BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 60_000; // raised from 25s: BATCH_SIZE=100 prompts are ~10x larger

export interface GoalsScreenResult {
  /** Index into the input candidates array. */
  index: number;
  /** Goals-opportunity rank within its batch (lower = stronger). Absent when
   *  the batch fell through to the unscreened fallback. */
  rank?: number;
  rationale?: string;
  /** false when this entry is an unscreened fail-open fallback, not a real screening verdict. */
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

const SCREEN_SYSTEM = `You screen football fixtures for betting edge across ALL available markets.
Prioritise goals-market opportunities first (Over/Under goals, BTTS, Team Total Over,
Correct Score) — then handicap/result markets (Asian Handicap, DNB, Double Chance,
Win Either Half) — then any other market with a clear data-backed edge.
You receive a numbered list of fixtures with compact stats. Rank them by overall
edge potential, strongest first. A strong goals signal (high O2.5%, high avgScored,
high shots on target) indicates goals-market edge and should rank near the top.
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

/** Screens one batch via the local Claude Code CLI. Returns null on any failure
 *  (timeout, missing key, throw, unparseable response) — caller falls back to
 *  the unscreened pre-filter order for that batch, never blocks. */
async function screenBatch(
  batch: GoalsPreFilterResult[],
  _ctx: LLMCallContext
): Promise<GoalsScreenResult[] | null> {
  const summaries = batch.map((c, i) => compactSummary(c, i)).join("\n");
  const prompt = `${SCREEN_SYSTEM}\n\nFixtures:\n${summaries}`;
  try {
    const raw = await callClaudeCode(prompt, { timeoutMs: REQUEST_TIMEOUT_MS });
    if (!raw) return null;
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
  }
}

/** Screens the full pre-filtered candidate pool in batches, run sequentially —
 *  each batch is an independent API call. Running them one-at-a-time avoids
 *  concurrent memory spikes on memory-constrained hosts (Windows OOM guard).
 *  Each batch's local indices are remapped back to indices into `candidates`.
 *  On a batch failure, that batch's fixtures are returned unscreened
 *  (screened=false), in their existing pre-filter order — the merged output is
 *  always the same length as the input, just with some entries marked unscreened
 *  rather than dropped. */
export async function screenGoalsCandidates(
  candidates: GoalsPreFilterResult[],
  ctx: LLMCallContext,
  batchSize: number = DEFAULT_SCREEN_BATCH_SIZE
): Promise<GoalsScreenResult[]> {
  const batchStarts: number[] = [];
  for (let start = 0; start < candidates.length; start += batchSize) batchStarts.push(start);

  const batchResults: Array<{
    start: number;
    batch: GoalsPreFilterResult[];
    screened: GoalsScreenResult[] | null;
  }> = [];
  for (const start of batchStarts) {
    const batch = candidates.slice(start, start + batchSize);
    const screened = await screenBatch(batch, ctx);
    batchResults.push({ start, batch, screened });
  }

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

/** Merges screen results back onto the candidate pool, sorted by the screening
 *  rank (screened entries first, ranked ascending), with unscreened entries
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
