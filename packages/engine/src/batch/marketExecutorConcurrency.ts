/** Dynamic concurrency for the all-markets LLM executor tier (Q4c) — per owner
 *  instruction: 2-3 agents locally, scaled by current RAM/CPU load, widening to
 *  ~1 agent per fixture on VPS/cloud (uncapped by cost ceiling there — see
 *  runBatch's shouldStop override). Local concurrency intentionally stays low:
 *  each call is a real local Claude Code CLI process spawn, and running many at
 *  once on a dev box competes with everything else on that machine. */
import os from "node:os";

export function computeMarketExecutorConcurrency(
  fixtureCount: number,
  isVps: boolean | undefined
): number {
  const bounded = Math.max(1, fixtureCount || 1);
  if (isVps) return bounded;
  const cpus = os.cpus()?.length || 1;
  const freeGb = os.freemem() / 1024 ** 3;
  const ramBudget = freeGb >= 6 ? 3 : freeGb >= 3 ? 2 : 1;
  const cpuBudget = Math.max(1, Math.min(3, cpus - 1));
  return Math.max(1, Math.min(ramBudget, cpuBudget, bounded));
}
