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

Vote for the single best pick (use the EXACT label) or "NO_BET".`;
}

/** Confidence-weighted aggregation. Returns consensus + divergence. */
function aggregate(votes: SwarmVote[]): { consensusPick: string; divergence: number } {
  if (!votes.length) return { consensusPick: "NO_BET", divergence: 1 };
  const weight = new Map<string, number>();
  let total = 0;
  for (const v of votes) {
    const w = Math.max(0.01, v.confidence);
    weight.set(v.pick, (weight.get(v.pick) ?? 0) + w);
    total += w;
  }
  let bestPick = "NO_BET";
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
  if (!config.enableSwarm || !config.kimiApiKey) return null;
  const n = Math.max(0, Math.min(MAX_WORKERS, workers));
  if (n === 0 || eligible.length === 0) return null;

  let callKimiVote: typeof import("@oracle/llm")["callKimiVote"];
  try {
    ({ callKimiVote } = await import("@oracle/llm"));
  } catch {
    return null;
  }

  const prompt = buildWorkerPrompt(fixture, eligible, softContext);
  const settled = await Promise.allSettled(
    Array.from({ length: n }, (_, i) =>
      // Spread temperature across workers for genuine diversity of opinion.
      callKimiVote(prompt, config.kimiApiKey!, { temperature: 0.2 + (i / Math.max(1, n)) * 0.6 })
    )
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
