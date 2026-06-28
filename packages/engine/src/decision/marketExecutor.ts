/** All-markets LLM execution tier (Q4 — owner-directed architecture change).
 *
 *  REPLACES (not augments) the eligibleBets-constrained decide() cascade for
 *  llmEligible fixtures when OracleConfig.enableLlmMarketExecutor is on. A single
 *  LLM agent (local Claude Code CLI — the same "Opus" tier every other
 *  decision-layer call site already uses) reasons over the FULL raw SportyBet
 *  allMarkets catalogue (900+ entries on a liquid fixture) plus the engine's own
 *  deterministic parameters (lambdas/probabilities/regime), and picks the single
 *  best-edge outcome from ANYWHERE in that catalogue — no market family is
 *  privileged for consideration over any other, per owner instruction.
 *
 *  Fail-open like every other LLM tier in this codebase: missing data, a failed
 *  call, a bad parse, or a failed server-side EV validation all return null —
 *  the caller (decide()) falls through to the existing eligibleBets cascade.
 *  This tier never blocks the pipeline; it only ever supplies a candidate once
 *  it can prove one out cleanly against the fixture's REAL quoted odds (never
 *  the LLM's restated odds — same Gate-1.5 philosophy as validateSelection). */

import { adjEV, clamp, hurdle, optimizedKelly } from "../math/index.js";
import type {
  AllMarketEntry,
  AllMarketOutcome,
  DecisionContext,
  DecisionOutput,
  DecisionReplay,
  EVMarket,
} from "../types.js";

const EXECUTOR_TIMEOUT_MS = 60_000;
// Defensive cap — a compact one-line-per-outcome serialization keeps even a
// 900-market fixture well under this, but a pathological catalogue (multiple
// thousand entries) is chunked rather than silently truncated.
const MAX_PROMPT_CHARS = 250_000;

export interface MarketExecutorRiskParams {
  dqs: number;
  councilPenalty: boolean;
  varMultiplier: number;
  drawdownPenalty: number;
  calibFactor: number;
  bankroll: number;
}

export interface MarketExecutorResult {
  market: EVMarket;
  decision: DecisionOutput;
  replay: DecisionReplay;
}

function gradeFromEv(ev: number): DecisionOutput["grade"] {
  if (ev >= 0.05) return "STRONG";
  if (ev > 0) return "LEAN";
  return "NO_EDGE";
}

function findOutcome(
  allMarkets: AllMarketEntry[],
  marketId: string,
  outcomeId: string
): { market: AllMarketEntry; outcome: AllMarketOutcome } | null {
  for (const m of allMarkets) {
    if (String(m.id) !== String(marketId)) continue;
    const outcome = (m.outcomes ?? []).find((o) => String(o.id) === String(outcomeId));
    if (outcome) return { market: m, outcome };
  }
  return null;
}

function serializeMarkets(allMarkets: AllMarketEntry[]): string[] {
  return allMarkets.map((m) => {
    const head = `${m.name || m.desc || m.id}${m.specifier ? ` (${m.specifier})` : ""}`;
    const outs = (m.outcomes ?? [])
      .map((o) => `[${m.id}|${o.id}] ${o.desc ?? o.id} @ ${o.odds ?? "?"}`)
      .join(" ; ");
    return `${head}: ${outs}`;
  });
}

/** Splits the serialized market lines into chunks under MAX_PROMPT_CHARS — a
 *  no-op for the overwhelming majority of fixtures (a 900-market catalogue
 *  serializes to well under this limit), only engaging on a pathological
 *  catalogue size. Chunks are evaluated sequentially (see the caller), never
 *  concurrently — sub-fixture parallelism is not part of the concurrency
 *  budget the owner specified (fixture-level only). */
function chunkLines(lines: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length > MAX_PROMPT_CHARS && current.length) {
      chunks.push(current);
      current = [];
      len = 0;
    }
    current.push(line);
    len += line.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks.length ? chunks : [[]];
}

function buildExecutorPrompt(ctx: DecisionContext, marketLines: string[]): string {
  const { fixture, fp, lambdaH, lambdaA, expectedScoreline, regime } = ctx;
  return `You are ORACLE's all-markets execution agent. You receive the deterministic
engine's own computed parameters for one football fixture, plus the COMPLETE raw
market catalogue the bookmaker publishes for it — every market, every outcome, no
family pre-filtered out. Markets you don't recognise by name should still be
evaluated using goal-based reasoning grounded in the parameters below (total-goals
bands, correct-score, handicap lines, team totals, multi-result combos, etc).

Your job: find the SINGLE outcome across the ENTIRE catalogue with the strongest
data-backed positive edge against its quoted odds. Estimate your own model
probability for that exact outcome (0-1), grounded in the parameters below — do
not pick a market just because it's familiar; reason about the actual numbers.

=== FIXTURE ===
${fixture.home} vs ${fixture.away} | ${fixture.league} | ${fixture.kickoff}

=== DETERMINISTIC ENGINE PARAMETERS ===
Home=${(fp.home * 100).toFixed(1)}% Draw=${(fp.draw * 100).toFixed(1)}% Away=${(fp.away * 100).toFixed(1)}%
Poisson: lambdaH=${lambdaH.toFixed(2)} lambdaA=${lambdaA.toFixed(2)} | Expected score: ${expectedScoreline} | Regime: ${regime}

=== FULL MARKET CATALOGUE (${marketLines.length} markets) ===
${marketLines.join("\n")}

=== REQUIRED OUTPUT (JSON only, no markdown, no prose outside the object) ===
{"marketId":"...","outcomeId":"...","estimatedProb":0.0,"rationale":"one or two sentences"}
If no outcome in the catalogue has a defensible edge, return:
{"marketId":null,"outcomeId":null,"estimatedProb":0,"rationale":"why nothing clears the bar"}`;
}

interface ExecutorResponse {
  marketId: string | null;
  outcomeId: string | null;
  estimatedProb: number;
  rationale: string;
}

function parseExecutorResponse(text: string): ExecutorResponse | null {
  try {
    const cleaned = text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    return {
      marketId: obj.marketId != null ? String(obj.marketId) : null,
      outcomeId: obj.outcomeId != null ? String(obj.outcomeId) : null,
      estimatedProb: Number(obj.estimatedProb ?? 0),
      rationale: String(obj.rationale ?? ""),
    };
  } catch {
    return null;
  }
}

/** Validates one parsed executor response against the REAL catalogue + odds,
 *  never the LLM's restated numbers. Returns null when the pick doesn't survive
 *  validation (unknown id, bad odds, non-positive EV, edge below hurdle). */
function validateAndBuild(
  parsed: ExecutorResponse,
  allMarkets: AllMarketEntry[],
  risk: MarketExecutorRiskParams,
  prompt: string,
  raw: string
): MarketExecutorResult | null {
  if (!parsed.marketId || !parsed.outcomeId) return null;
  const found = findOutcome(allMarkets, parsed.marketId, parsed.outcomeId);
  if (!found) return null;

  const odds = parseFloat(found.outcome.odds ?? "");
  if (!Number.isFinite(odds) || odds <= 1) return null;
  const mp = clamp(parsed.estimatedProb, 0.001, 0.999);
  const ip = 1 / odds;
  const rawEdge = mp - ip;
  const ev = adjEV(mp, odds);
  if (ev <= 0 || rawEdge < hurdle(mp)) return null;

  const stake = clamp(
    optimizedKelly(
      rawEdge,
      odds,
      risk.dqs,
      risk.councilPenalty,
      risk.varMultiplier,
      risk.drawdownPenalty,
      risk.calibFactor,
      0.25,
      mp
    ),
    0,
    0.25
  );

  const label = `${found.market.desc || found.market.name || found.market.id} — ${found.outcome.desc ?? found.outcome.id}`;
  const market: EVMarket = {
    cat: "LLM Market Executor",
    label,
    market: "LLM Market Executor",
    side: found.outcome.desc ?? undefined,
    mp,
    modelProb: mp,
    ip,
    rawEdge,
    ev,
    odds,
    stake,
    stakeAmt: stake * (risk.bankroll || 1000),
    rankingScore: ev,
    varianceMod: 1.0,
  };

  const decision: DecisionOutput = {
    primaryPick: { market: market.market, side: market.side, odds, stake },
    confidence: mp,
    grade: gradeFromEv(ev),
    rationale: parsed.rationale || "All-markets LLM executor pick",
    rejectedAndWhy: [],
  };

  const replay: DecisionReplay = {
    prompt,
    rawResponse: raw,
    model: "claude-code-market-executor",
    temperature: "default",
  };

  return { market, decision, replay };
}

/** Runs the all-markets LLM executor for one fixture. Returns null (fail-open)
 *  on any missing data, runtime guard, call failure, or validation failure. */
export async function runAllMarketsLlmExecutor(
  ctx: DecisionContext,
  risk: MarketExecutorRiskParams
): Promise<MarketExecutorResult | null> {
  if (!ctx.allMarkets?.length) return null;

  let callClaudeCode: typeof import("@oracle/llm")["callClaudeCode"];
  try {
    const llm = await import("@oracle/llm");
    // isLocalRuntime() guard — must not be removed. Without it a real `claude`
    // binary on PATH gets spawned on every Vitest run (5-45s hangs), same class
    // of bug the existing arbitrate()/_agentOrchestrate() guards already prevent.
    if (!llm.isLocalRuntime()) return null;
    callClaudeCode = llm.callClaudeCode;
  } catch {
    return null;
  }

  const chunks = chunkLines(serializeMarkets(ctx.allMarkets));
  let best: MarketExecutorResult | null = null;

  for (const chunk of chunks) {
    if (!chunk.length) continue;
    const prompt = buildExecutorPrompt(ctx, chunk);
    let raw: string | null = null;
    try {
      raw = await callClaudeCode(prompt, { timeoutMs: EXECUTOR_TIMEOUT_MS });
    } catch {
      continue;
    }
    if (!raw) continue;
    const parsed = parseExecutorResponse(raw);
    if (!parsed) continue;
    const built = validateAndBuild(parsed, ctx.allMarkets, risk, prompt, raw);
    if (built && (!best || built.market.ev > best.market.ev)) best = built;
  }

  return best;
}
