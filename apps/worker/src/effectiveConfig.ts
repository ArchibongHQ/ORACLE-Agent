/** [PR-11, audit item] Startup diagnostics: dump the resolved ORACLE_* flags
 *  (not the raw env — the already-parsed booleans/numbers/modes actually in
 *  effect) so a misconfigured deploy is visible in the log from the first
 *  line, instead of only showing up as unexplained behavior hours later.
 *  Takes config/goalsV3Config as parameters (defaulting to the real
 *  workerContext.ts instances) so it's testable without depending on
 *  process.env at import time. */
import type { OracleConfig } from "@oracle/engine";
import type { GoalsV3Config } from "@oracle/runtime";
import { config, goalsV3Config } from "./workerContext.js";

export function printEffectiveConfig(
  cfg: OracleConfig = config,
  goalsCfg: GoalsV3Config = goalsV3Config
): void {
  const flags = {
    enableMarketsV3: cfg.enableMarketsV3,
    enableV3MainGates: cfg.enableV3MainGates,
    v3Hfa: cfg.v3Hfa,
    v3VenueSplitUsed: cfg.v3VenueSplitUsed,
    v3LambdaV5: cfg.v3LambdaV5,
    v3GatesV4: cfg.v3GatesV4,
    v3CompletenessV4: cfg.v3CompletenessV4,
    v3CornersCards: cfg.v3CornersCards,
    v3GoalsCrossCheck: cfg.v3GoalsCrossCheck,
    marketsV3Gate: cfg.marketsV3Gate,
    marketsV3Outputs: cfg.marketsV3Outputs,
    marketsCoverageNote: cfg.marketsCoverageNote,
    catalogOverlay: cfg.catalogOverlay,
    calibrationLedger: cfg.calibrationLedger,
    enableGoalsOnlyMode: cfg.enableGoalsOnlyMode,
    enableNewsIntel: cfg.enableNewsIntel,
    enableLlmMarketExecutor: cfg.enableLlmMarketExecutor,
    enableGbmResidual: cfg.enableGbmResidual,
    useNegBinom: cfg.useNegBinom,
    nbDispersion: cfg.nbDispersion,
    useMCRuin: cfg.useMCRuin,
    isVps: cfg.isVps,
    hasNvidiaGpu: cfg.hasNvidiaGpu,
    goalsV3XgBlend: goalsCfg.xgBlend,
    goalsV3EdgeCap: goalsCfg.edgeCap,
    goalsV3NoiseGate: goalsCfg.noiseGate,
  };
  process.stdout.write(`[worker] effective config: ${JSON.stringify(flags)}\n`);

  // v3VenueSplitUsed asserts input λ already carries a true home/away split
  // (home team's own home-venue rate, away team's own away-venue rate),
  // which is why it's allowed to suppress the v3Hfa multiplier. Verified
  // against the actual lambda-input call sites (packages/engine/src/batch/
  // index.ts's buildV3Input, apps/worker/src/goalsV3Pipeline.ts's
  // buildGoalsV3Input): both source homeScoredPer90/awayScoredPer90 etc. from
  // team-overall season aggregates (blendRecencyScored over
  // stats.goals.home/away, keyed by which side of TODAY'S fixture a team is
  // on, not by that team's own historical venue split) — only the xG blend
  // has a real venue-conditioned source (venueXgf/venueXga). Flipping this
  // flag on today would silently suppress HFA with nothing compensating for
  // it in either pipeline.
  if (cfg.v3VenueSplitUsed) {
    process.stderr.write(
      "[worker] WARN: ORACLE_V3_VENUE_SPLIT=on, but neither the main all-markets " +
        "batch nor the goals-v3 pipeline currently produces true venue-split " +
        "scored/conceded data (only xG has a venue-conditioned source) — HFA is " +
        "being suppressed with nothing compensating for it. Wire real per-venue " +
        "data into buildV3Input/buildGoalsV3Input before relying on this flag.\n"
    );
  }
}
