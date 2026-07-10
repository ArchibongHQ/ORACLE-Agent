/** [Wave 3, WS3-A] SafetyPipeline extraction — stage 1 stub.
 *  Target shape: a verbatim, source-agnostic lift of execution/index.ts's
 *  `_run` post-pricing block (steam-chaser veto → portfolio correlation →
 *  AntiSycophancy → RAG → ConvergenceScorer → tier/family multipliers →
 *  MLSafetyFilter → rag.addToStore), so both the legacy pricer and v3 can
 *  route their priced candidates through one safety stage. Golden tests must
 *  pass unchanged once WS3-A lifts the real logic in here — this stub only
 *  establishes the typechecking signature. */

import type { MarketFamily } from "../markets/index.js";
import type { EVMarket, Matrix } from "../types.js";

export interface SafetyPipelineInput {
  evMarkets: EVMarket[];
  matrix: Matrix;
  telemetry: Record<string, unknown>;
  calibFactorFor: (family: MarketFamily | undefined) => number;
}

export interface SafetyPipelineResult {
  evMarkets: EVMarket[];
  portfolioCorrelation?: number;
  correlatedParlayRisk?: Array<{ a: string; b: string; rho: number }>;
}

export function runSafetyPipeline(_input: SafetyPipelineInput): SafetyPipelineResult {
  throw new Error("runSafetyPipeline: not yet implemented (Wave 3, WS3-A)");
}
