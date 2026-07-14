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
    // [refactor wave 1] P0-2 blend / P0-3 safety posture / P1-3 feed integrity /
    // P1-4 sharp-feed latch — a misconfigured deploy of the refactor flags must
    // be visible from the first log line, same rationale as PR-11.
    v3Blend: cfg.v3Blend,
    safetyMode: cfg.safetyMode,
    feedIntegrity: cfg.feedIntegrity,
    sharpFeedVerified: cfg.sharpFeedVerified,
    // [Wave 2] P0-1 segment calibration epoch / P1-1 pi-ratings / P1-4 sharp
    // feed — same "visible from the first log line" rationale as Wave 1's row.
    calibrationEpochStart: cfg.calibrationEpochStart,
    v3Ratings: cfg.v3Ratings,
    sharpFeed: cfg.sharpFeed,
    // [Wave 3] P1-2 SafetyPipeline extraction / legacy-pricer rollback lever —
    // same "visible from the first log line" rationale as Waves 1-2's rows.
    v3Safety: cfg.v3Safety,
    legacyPricer: cfg.legacyPricer,
    // [Wave 4-accuracy] blend-priced gating + totals empirical blend levers.
    v3BlendPricing: cfg.v3BlendPricing,
    v3TotalsEmpirical: cfg.v3TotalsEmpirical,
    // [X-carveout] default-off Class X carve-out lever.
    v3XCarveout: cfg.v3XCarveout,
    enableGoalsOnlyMode: cfg.enableGoalsOnlyMode,
    enableNewsIntel: cfg.enableNewsIntel,
    enableLlmMarketExecutor: cfg.enableLlmMarketExecutor,
    llmExecutorScope: cfg.llmExecutorScope,
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
  // team-overall season aggregates (stats.goals.home/away, keyed by which
  // side of TODAY'S fixture a team is on, not by that team's own historical
  // venue split) — only the xG blend has a real venue-conditioned source
  // (venueXgf/venueXga) wired into lambda today.
  //
  // Correction from an earlier draft of this comment: a real venue-split
  // source DOES already exist and is already scraped —
  // SportyBetEventDetail.stats.scoringConceding.{home,away}.scored_avg/
  // conceded_avg (packages/runtime/src/selectFixtures.ts's
  // ScoringConcedingProfile — "home team carries its home split, away team
  // its away split"), and sportyBetStats.ts already reads it for SoS/BTTS/
  // clean-sheet rates. It's simply never routed into the
  // scoredPer90H/A/concededPer90H/A fields that actually feed lambda. So the
  // fix, when someone picks this up, is "wire scoringConceding into
  // buildStatsOverride's override.scoredPer90H/A" — a smaller change than
  // sourcing new data — not a data-acquisition project. Left as a follow-up;
  // this PR only adds the loud warning so the flag can't be flipped on
  // silently in the meantime.
  if (cfg.v3VenueSplitUsed) {
    process.stderr.write(
      "[worker] WARN: ORACLE_V3_VENUE_SPLIT=on, but neither the main all-markets " +
        "batch nor the goals-v3 pipeline currently routes true venue-split " +
        "scored/conceded data into lambda (only xG has a venue-conditioned source " +
        "wired) — HFA is being suppressed with nothing compensating for it. A real " +
        "venue-split source already exists and is already scraped " +
        "(SportyBetEventDetail.stats.scoringConceding) but isn't wired into " +
        "buildV3Input/buildGoalsV3Input's scoredPer90H/A yet — wire that before " +
        "relying on this flag.\n"
    );
  }
}
