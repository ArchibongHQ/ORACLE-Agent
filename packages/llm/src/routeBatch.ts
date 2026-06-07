/** B7 — Dynamic batch model-routing.
 *  Spec: ORACLE_v2026_8_0.jsx (B7 section).
 *  APEX/PRIME fixtures → full path: Opus + CVL + briefing.
 *  MARGINAL/NOISE → Flash-Lite acquisition only.
 *  VIABLE → standard path (Gemini decision cascade, no briefing/CVL).
 *  Reads convergence.tier from the batch job result — reuses ConvergenceTier from safety/index.ts. */

export type RouteTier = 'APEX' | 'PRIME' | 'VIABLE' | 'MARGINAL' | 'NOISE';

export interface BatchRoute {
  tier: RouteTier;
  useOpus: boolean;
  useCVL: boolean;
  useBriefing: boolean;
  acquisitionModel: string;
  swarmWorkers: number;   // Level-2 sub-agent count (0 = no swarm)
}

import { MODELS } from './cascade.js';

const APEX_PRIME = new Set<RouteTier>(['APEX', 'PRIME']);
const MARGINAL_NOISE = new Set<RouteTier>(['MARGINAL', 'NOISE']);

/** Determine model routing for a single fixture based on its convergence tier.
 *  Call this before decide() to know which optional layers to activate. */
export function routeFixture(convergenceTier: string): BatchRoute {
  const tier = (APEX_PRIME.has(convergenceTier as RouteTier) ||
                MARGINAL_NOISE.has(convergenceTier as RouteTier) ||
                convergenceTier === 'VIABLE')
    ? convergenceTier as RouteTier
    : 'VIABLE';

  if (APEX_PRIME.has(tier)) {
    return {
      tier,
      useOpus: true,
      useCVL: true,
      useBriefing: true,
      acquisitionModel: MODELS.GEMINI_FLASH,
      swarmWorkers: tier === 'APEX' ? 7 : 5,
    };
  }

  if (MARGINAL_NOISE.has(tier)) {
    return {
      tier,
      useOpus: false,
      useCVL: false,
      useBriefing: false,
      acquisitionModel: MODELS.GEMINI_FLASH_LITE,
      swarmWorkers: 0,
    };
  }

  // VIABLE — standard path
  return {
    tier,
    useOpus: false,
    useCVL: false,
    useBriefing: false,
    acquisitionModel: MODELS.GEMINI_FLASH,
    swarmWorkers: 3,
  };
}
