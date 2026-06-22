/** SwarmOrchestrator — Level-2 per-fixture sub-agent swarm.
 *
 *  For high-conviction fixtures (APEX/PRIME), fans out N independent worker agents
 *  that each vote on the best pick from the eligible set, then aggregates by
 *  confidence-weighted voting. The result is ADVISORY EVIDENCE only — it is injected
 *  into the decision's softContext and surfaced as a divergence risk flag. It NEVER
 *  sets the authoritative primaryPick; decide() + validateSelection() remain the
 *  final arbiters (deterministic-first guarantee, CLAUDE.md).
 *
 *  Worker model: Kimi K2.6 (cheap, strong tool-use) when a Kimi key is present;
 *  otherwise the swarm is skipped (returns null). Never throws. */

import type { EVMarket, OracleConfig, SoftContextItem } from "../types.js";

export interface SwarmVote {
  pick: string;
  confidence: number;
  rationale: string;
  model: string;
}

export interface SwarmResult {
  /** Confidence-weighted consensus pick label (advisory). */
  consensusPick: string;
  /** 0–1; share of voting weight NOT on the consensus pick. High = disagreement. */
  divergence: number;
  votes: SwarmVote[];
  workers: number;
  model: string;
  /** True when divergence exceeds the risk threshold (caller may trigger CVL). */
  highDivergence: boolean;
}

const DIVERGENCE_THRESHOLD = 0.4;
const MAX_WORKERS = 7;

/** Worker count by convergence tier. MARGINAL/NOISE get none (deterministic only). */
export function swarmWorkersForTier(tier: string): number {
  switch (tier) {
    case "APEX":
      return 7;
    case "PRIME":
      return 5;
    case "VIABLE":
      return 3;
    default:
      return 0; // MARGINAL / NOISE / UNKNOWN
  }
}

function buildWorkerPrompt(
  fixture: { home: string; away: string; league: string; kickoff: string },
  eligible: EVMarket[],
  softContext?: SoftContextItem[]
): string {
  const bets = eligible
    .slice(0, 8)
    .map(
      (m, i) =>
        `${i + 1}. ${m.label} (${m.cat}) — modelProb ${(m.mp * 100).toFixed(1)}%, odds ${m.odds}, EV +${(m.ev * 100).toFixed(1)}%`
    )
    .join("\n");
  const news = (softContext ?? [])
    .map((s) => `[${s.kind}] ${s.text}`)
    .slice(0, 8)
    .join("\n");
  return `Fixture: ${fixture.home} vs ${fixture.away} (${fixture.league}, ${fixture.kickoff})
Eligible bets:
${bets || "NONE"}
${news ? `\nPre-match intelligence:\n${news}` : ""}

Vote for the single best pick (use the EXACT label) or "NO_EDGE" if no pick is justified.`;
}

/** Confidence-weighted aggregation. Returns consensus + divergence. */
function aggregate(votes: SwarmVote[]): { consensusPick: string; divergence: number } {
  if (!votes.length) return { consensusPick: "NO_EDGE", divergence: 1 };
  const weight = new Map<string, number>();
  let total = 0;
  for (const v of votes) {
    const w = Math.max(0.01, v.confidence);
    weight.set(v.pick, (weight.get(v.pick) ?? 0) + w);
    total += w;
  }
  let bestPick = "NO_EDGE";
  let bestWeight = -1;
  for (const [pick, w] of weight) {
    if (w > bestWeight) {
      bestWeight = w;
      bestPick = pick;
    }
  }
  const divergence = total > 0 ? 1 - bestWeight / total : 1;
  return { consensusPick: bestPick, divergence };
}

/** runSwarm — fan out `workers` Kimi voters, aggregate. Returns null when disabled,
 *  no key, no eligible bets, or all workers fail. */
export async function runSwarm(
  workers: number,
  fixture: { home: string; away: string; league: string; kickoff: string },
  eligible: EVMarket[],
  config: OracleConfig,
  softContext?: SoftContextItem[]
): Promise<SwarmResult | null> {
  if (!config.enableSwarm || (!config.kimiApiKey && !config.openrouterApiKey)) return null;
  const n = Math.max(0, Math.min(MAX_WORKERS, workers));
  if (n === 0 || eligible.length === 0) return null;

  // Namespace import — read symbols off `llm` lazily so a Kimi-only path never touches
  // the OpenRouter exports (keeps callers that mock only callKimiVote working).
  let llm: typeof import("@oracle/llm");
  try {
    llm = await import("@oracle/llm");
  } catch {
    return null;
  }

  const prompt = buildWorkerPrompt(fixture, eligible, softContext);
  // Worker 0's existing (Kimi/OpenRouter) assignment, computed once so the
  // tier-0 local-CLI attempt below can fall back to it on a null.
  const voteFor = (i: number): Promise<SwarmVote | null> => {
    // Spread temperature across workers for genuine diversity of opinion.
    const temp = 0.2 + (i / Math.max(1, n)) * 0.6;
    // Tier 1: Kimi (Moonshot) when present.
    if (config.kimiApiKey) {
      return llm.callKimiVote(prompt, config.kimiApiKey, { temperature: temp });
    }
    // Tier 2/3: OpenRouter — first half paid MiMo, rest alternate working free
    // models (GPT-OSS-120B / Nemotron Super 120B). Kimi-K2.6:free was retired
    // by OpenRouter (404), so swarm workers use the confirmed-working free pair.
    const orKey = config.openrouterApiKey!;
    const M = llm.OPENROUTER_MODELS;
    if (i < Math.ceil(n / 2)) {
      return llm.callOpenRouterVote(prompt, M.MIMO_V2_5_PRO, orKey, { temperature: temp });
    }
    const freeModel = i % 2 === 0 ? M.GPT_OSS_120B : M.NEMOTRON_SUPER_120B;
    return llm.callOpenRouterVote(prompt, freeModel, orKey, { temperature: temp });
  };

  const settled = await Promise.allSettled(
    Array.from({ length: n }, async (_, i) => {
      // Tier 0: one worker slot tries the local Claude Code CLI (advisory) —
      // adds a model-diverse voice to the panel without collapsing the
      // temperature spread the rest of the workers rely on for diversity.
      if (i === 0 && llm.isLocalRuntime()) {
        const local = await llm.callClaudeCodeVote(prompt);
        if (local) return local;
      }
      return voteFor(i);
    })
  );

  const votes: SwarmVote[] = settled
    .filter(
      (r): r is PromiseFulfilledResult<SwarmVote> => r.status === "fulfilled" && r.value != null
    )
    .map((r) => r.value);

  if (!votes.length) return null;

  const { consensusPick, divergence } = aggregate(votes);
  return {
    consensusPick,
    divergence,
    votes,
    workers: votes.length,
    model: votes[0]?.model,
    highDivergence: divergence > DIVERGENCE_THRESHOLD,
  };
}

/** Convert a swarm result into advisory SoftContextItems for the decision prompt. */
export function swarmToSoftContext(result: SwarmResult): SoftContextItem[] {
  const observedAt = new Date().toISOString();
  const items: SoftContextItem[] = [
    {
      kind: "news",
      text: `[SWARM_CONSENSUS] ${result.workers} workers → "${result.consensusPick}" (divergence ${(result.divergence * 100).toFixed(0)}%)`,
      source: "swarm-consensus",
      observedAt,
    },
  ];
  if (result.highDivergence) {
    items.push({
      kind: "news",
      text: `[SWARM_HIGH_DIVERGENCE] workers disagree (${(result.divergence * 100).toFixed(0)}%) — treat pick with extra caution`,
      source: "swarm-consensus",
      observedAt,
    });
  }
  return items;
}
