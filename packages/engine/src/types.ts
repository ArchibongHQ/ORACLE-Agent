/** Shared types for @oracle/engine. These are imported by oracle_math.ts and all engine modules. */

import type { FamilyLabel, MarketFamily } from "./markets/index.js";

// [Wave 2, WS2-D + review cleanup] Canonically defined here (this package's
// foundational leaf module, where DecisionContext already lives) rather than
// in decision/index.ts — the original split had types.ts importing these
// shapes back from decision/index.ts while decision/index.ts imported
// DecisionContext from types.ts, a genuine circular reference between the
// two files. decision/index.ts re-exports these for backward compat.

/** [WS2-D] Duck-typed mirror of @oracle/runtime's `FeedIntegrityVerdict`
 *  shape (packages/runtime/src/feedIntegrity.ts, v5 Rule 0.14) — @oracle/
 *  engine cannot import @oracle/runtime directly (circular dependency, same
 *  reason DecisionContext.rawStatsBlock stays a bare Record below), so the
 *  prompt builders accept this narrower shape instead of the real type.
 *  Optional and purely additive — omission renders no FEED INTEGRITY section
 *  (safe default, never a false "clean" claim). */
export interface FeedIntegritySignal {
  verdict: "clean" | "contaminated" | "flagged";
  reason?: string;
  detail?: string;
}

/** [WS2-D] Minimal, duck-typed mirror of marketsV3/sanity.ts's
 *  `V3SanityResult` (v5 §5.6 — cap-rate/directional skew, computed once per
 *  slate) — narrowed to just what the per-fixture arbiter needs to factor
 *  the slate-wide picture into an individual ratify/override call. Optional/
 *  additive/safe-default, same contract as the two signals above. */
export interface SlateSanitySignal {
  flags: string[];
  capRate?: number | null;
}

/** The real value space of PickRef.market/EVMarket.market: FAMILY_LABEL display
 *  strings emitted by scanMarkets' `check()`, plus the two special-path literals
 *  set outside the family system (execution/index.ts scanAllMarketsFallback,
 *  decision/marketExecutor.ts). The decision/index.ts:64 "1x2" placeholder is a
 *  pre-existing casing mismatch against FAMILY_LABEL.match_result ("1X2") —
 *  carried through as-is, not fixed here. */
export type PickRefMarket = FamilyLabel | "1x2" | "AllMarkets Scan" | "LLM Market Executor";

/** A 2D goal-probability matrix: matrix[homeGoals][awayGoals] = P(score). */
export type Matrix = number[][];

/** Performance regime for variance / momentum analysis. */
export type Regime = "NEUTRAL" | "MOMENTUM" | "MEAN_REVERSION" | "ACCELERATING" | "DECELERATING";

/** Draw / low-scoring regime classification (PRD §4). */
export type ScoringRegime = "NORMAL" | "LOW_SCORING";

/** Outcome space for 1X2 markets. */
export type Outcome = "home" | "draw" | "away";

/** Ranking modes — risk-preference filters over calibrated probabilities (PRD §5). */
export type RankingMode = "CONFIDENCE_WEIGHTED" | "MAX_PROBABILITY" | "MAX_EV";

/** Fixture resolution outcome (PRD §9, §11A.2). */
export type ResolveOutcome = "RESOLVED" | "AMBIGUOUS" | "NO_DATA";

/** Liquidity classification for CLV gate (PRD §8.3). */
export type LiquidityTag = "CLV_ELIGIBLE" | "CALIBRATION_ONLY";

/** CLV data quality (source of the "closing" odds, PRD §8.3 v1.2). */
export type ClvSourceQuality = "TICK_LEVEL" | "KICKOFF_PROXY" | "UNKNOWN";

/** Soft-context evidence item supplied to the LLM decision layer (PRD §6 v1.2). */
export interface SoftContextItem {
  kind: "lineup" | "injury" | "news" | "motivation" | "stats";
  text: string;
  source: string;
  observedAt: string; // ISO-8601; must be < kickoff (anti-leakage)
}

/** Edge confidence grade — replaces "NO_BET" literal across all output surfaces.
 *  STRONG: EV ≥ 0.05; LEAN: 0 < EV < 0.05; NO_EDGE: EV ≤ 0 (honest no-edge verdict);
 *  MISSING_DATA: the final arbiter judged the evidence insufficient to decide either
 *  way — distinct from NO_EDGE (which means "evidence is sufficient and says no edge"). */
export type ConfidenceGrade = "STRONG" | "LEAN" | "NO_EDGE" | "MISSING_DATA";

/** The structured JSON the LLM decision layer must return (PRD §6, Appendix B). */
export interface DecisionOutput {
  primaryPick: PickRef;
  altPick?: PickRef;
  confidence: number; // 0–1 (numeric, for backward compat with existing callers)
  grade: ConfidenceGrade; // human-facing label derived from EV
  rationale: string;
  rejectedAndWhy: string[];
  /** Set when ORACLE_LOCAL_DECISION="true": whether the local-Claude final arbiter
   *  actually reviewed this pick. "unverified" means the arbiter call failed (binary
   *  missing, timeout, bad parse) and the pre-arbiter cascade pick was used as-is —
   *  callers/UI should label the output accordingly. Absent when the arbiter is off. */
  arbiterStatus?: "verified" | "unverified";
}

/** Exact LLM call bundle for audit replay (PRD §6 determinism, Appendix B).
 *  temperature is "default" only for the opt-in local-Claude-Code tier, which
 *  samples at the CLI's account default and has no knob to pin to 0 — every
 *  API tier still pins 0. Never write "default" without it being literally true. */
export interface DecisionReplay {
  prompt: string;
  rawResponse: string;
  model: string;
  temperature: 0 | "default";
}

/** Shadow comparison: GLM-5.2 evaluated in parallel with the real decision tier,
 *  never affecting primaryPick. Observability only. Absent when the OpenRouter
 *  key is missing or the shadow call fails (fail-open, non-fatal). */
export interface DecisionShadow {
  model: string; // OPENROUTER_MODELS.GLM_5_2
  pick: DecisionOutput;
  agree: boolean; // true when shadow.pick.primaryPick.market === real pick.primaryPick.market
}

/** Reference to a specific market + odds combination. */
export interface PickRef {
  market: PickRefMarket;
  side?: string;
  odds: number;
  stake?: number; // Kelly fraction, 0–1
  /** Threaded from the source EVMarket (see EVMarket.sourcedFromScan) when
   *  validateSelection/deterministicDecide resolve this pick against the
   *  eligible-bets list — provenance for the full allMarkets catalogue scan,
   *  now that `market` carries the real FAMILY_LABEL rather than a literal
   *  "AllMarkets Scan" marker. */
  sourcedFromScan?: boolean;
}

/** One outcome of a raw SportyBet allMarkets entry (tools/scrape_fixtures.py's
 *  _parse_all_markets) — verbatim id/desc/odds straight from the API. */
export interface AllMarketOutcome {
  id: string;
  desc?: string | null;
  odds?: string | null;
}

/** One raw SportyBet market entry (900+ per liquid fixture). Generic capture of
 *  every market beyond the ~9 families scanMarkets() prices syntactically —
 *  shared between the deterministic generic combo-market pricer
 *  (execution/index.ts) and the LLM market-executor (decision/marketExecutor.ts),
 *  both of which need the exact same raw shape. */
export interface AllMarketEntry {
  id: string;
  name?: string | null;
  desc?: string | null;
  group?: string | null;
  specifier?: string | null;
  outcomes: AllMarketOutcome[];
}

/** An EV-positive market candidate surfaced by scanMarkets.
 *  cat/label are the canonical JSX field names; market/side/modelProb are backward-compat aliases. */
export interface EVMarket {
  cat: string; // market category: "Goals O/U", "Asian Handicap", etc.
  label: string; // specific bet: "Over 2.5", "AH Home +0.5", etc.
  market: PickRefMarket; // = cat  (kept for decision module compat)
  side?: string; // = label (kept for PickRef compat)
  /** Canonical ORACLE market family. Set by all scanMarkets BLOCKs and the
   *  allMarkets fallback scan. Absent only for the 1x2 placeholder pick. */
  family?: MarketFamily;
  mp: number; // model probability
  modelProb: number; // = mp   (kept for safety module compat)
  ip: number; // implied probability (1/odds)
  rawEdge: number; // mp - ip
  ev: number;
  odds: number;
  stake: number;
  stakeAmt: number;
  rankingScore: number;
  varianceMod: number;
  veto?: string | boolean;
  /** Set by scanAllMarketsFallback: this candidate came from the full raw
   *  allMarkets catalogue scan rather than the family-gated scanMarkets
   *  BLOCKs. Preserves scan provenance now that cat/market carry the real
   *  FAMILY_LABEL instead of the literal "AllMarkets Scan". */
  sourcedFromScan?: boolean;
}

/** The config injected at the system boundary — never read from window/process.env inside @oracle/engine. */
export interface OracleConfig {
  geminiApiKey: string;
  claudeApiKey: string;
  perplexityApiKey?: string; // T0 news/team intelligence (Perplexity Sonar)
  kimiApiKey?: string; // swarm worker model (Kimi K2.6 via Moonshot)
  openrouterApiKey?: string; // Tier 2/3 fallbacks via OpenRouter (single key, optional)
  openWeatherApiKey?: string;
  footballDataApiKey?: string;
  apiFootballKey?: string;
  oddsApiKey?: string;
  sharpApiIoKey?: string; // structured free-odds fallback (SharpAPI.io, sharp books)
  oddsApiIoKey?: string; // structured free-odds fallback (Odds-API.io, 100 req/hr free)
  oddsPapiKey?: string; // structured free-odds fallback (OddsPapi v4, Pinnacle/SBOBet)
  sportsGameOddsKey?: string; // structured free-odds fallback (SportsGameOdds, Pinnacle)
  bankroll: number;
  rankingMode?: RankingMode; // default CONFIDENCE_WEIGHTED
  useBivariatePoisson?: boolean; // PRD §8.1, default false
  useSkellam?: boolean; // PRD §8.2, default false
  useNegBinom?: boolean; // NB overdispersion in score marginals, default false
  nbDispersion?: number; // NB dispersion param r (default 10; larger → closer to Poisson)
  useMCRuin?: boolean; // blend simulated ruin probability into varMultiplier, default false
  costCeilingUsd?: { perRun: number; perDay: number }; // PRD §11A.4
  // Feature flags (Phase 1+, all default false/undefined)
  usePiRatingsCanonical?: boolean;
  enableCalibratedZip?: boolean;
  quarantineMarketVelocity?: boolean;
  enableSoftmaxBlend?: boolean;
  xgPrimaryWeight?: number; // default 0.40
  lowScoreZipWeight?: number; // default 0.08
  // Web search fallback for odds (when Odds API fails)
  enableWebSearchOddsFallback?: boolean; // default true
  webOddsMinConsensus?: number; // default 3
  webOddsVarianceThreshold?: number; // default 0.025 (±2.5%)
  // Web search fallback for match results (when API-Football + football-data.org both miss)
  enableWebSearchResultsFallback?: boolean; // default true
  webResultsMinConsensus?: number; // default 2 (goals are exact integers, not within-variance)
  // B-layer feature flags (all default false)
  enableBriefing?: boolean; // B1: Claude Opus + Gemini temp ensemble briefing
  enableCVL?: boolean; // B2: Claude Sonnet adversarial verification
  // T0 + swarm (all default false/undefined)
  enableNewsIntel?: boolean; // T0: Perplexity Sonar news/injury/lineup intelligence
  cloudNewsSync?: boolean; // merge cloud-routine news/xG from the git `data` branch post-enrichment
  enableSwarm?: boolean; // Level-2: per-fixture sub-agent swarm (APEX/PRIME)
  batchConcurrency?: number; // Level-1: max concurrent fixtures (default 8)
  maxFixturesPerRun?: number; // pre-analysis fixture selection cap (default 50)
  // Goals-only accumulator pipeline (runGoalsBatch) — gates per-leg selection
  goalsMinConfidence?: number; // model `mp` floor per goals leg (default 0.75)
  goalsMinImplied?: number; // implied-prob floor per goals leg (default 0.70)
  goalsTargetLegs?: number; // max legs in the goals accumulator (default 39)
  // When true, scanMarkets only computes goals-shaped markets (Goals O/U, Asian 2
  // Goals, Team Total) and BTTS — AH/DNB/Double-Chance/Win-Either-Half/First-Half
  // are skipped entirely (not computed, not just filtered from output). Temporary
  // pivot to prove prediction accuracy in goal markets before re-expanding scope.
  enableGoalsOnlyMode?: boolean;
  // GBM residual model (tools/gbm_residual.py) — TS inference shim in ./gbm/index.ts.
  // Default OFF: the currently-saved model fails its own walk-forward significance
  // gate (gate_passed=false in .tmp/models/gbm_residual_meta.json — RPS improvement
  // -0.0012 vs the +0.002 threshold). Wiring is built and tested; only flip this on
  // once a retrained model actually clears the gate.
  enableGbmResidual?: boolean;
  gbmModelPath?: string; // default ".tmp/models/gbm_residual.json"
  gbmBlendWeight?: number; // default 0.15 — low-weight nudge, same shape as the Skellam blend
  // Hardware capabilities (populated at runtime boundary, never inside @oracle/engine)
  isVps?: boolean; // ORACLE_IS_VPS=true or systemd-detect-virt detects VM
  hasNvidiaGpu?: boolean; // nvidia-smi available and returned a GPU name
  enableAutoResearch?: boolean; // ORACLE_AUTORESEARCH_ENABLED=true + GPU/VPS required
  // All-markets LLM execution tier (decision/marketExecutor.ts) — default OFF.
  // When on, an LLM agent (local Claude Code CLI) reasons over the FULL raw
  // allMarkets catalogue (900+ entries on a liquid fixture) plus the engine's
  // own parameters for every llmEligible fixture, REPLACING the eligibleBets-
  // constrained decide() cascade rather than augmenting it — per owner
  // instruction, no market family is privileged over any other for consideration.
  // Concurrency is hardware-aware locally (computeMarketExecutorConcurrency) and
  // scales to ~1 agent per fixture on VPS, where it also ignores costCeilingUsd
  // (uncapped spend on VPS is an explicit owner choice, not an oversight).
  // Derived from llmExecutorScope below (true whenever scope !== "off") —
  // kept as its own field since most call sites only ever need the boolean.
  enableLlmMarketExecutor?: boolean;
  // PR-23: tri-state scope for the executor above, parsed from the SAME
  // ENABLE_LLM_MARKET_EXECUTOR env var ("true"⇒"full", "unmapped"⇒"unmapped",
  // anything else⇒"off"). "full" is the pre-PR-23 behavior verbatim (executor
  // reasons over the ENTIRE catalogue and its pick becomes the draft
  // outright — batch/index.ts still demotes it to off when v3 supplied
  // candidates, since a second full-catalogue pass over an already-priced
  // fixture is pure waste). "unmapped" is new: batch/index.ts does NOT
  // demote it when v3 ran — instead it narrows what the executor sees to
  // just this fixture's recoverable skip-tail (computeTailMarkets in
  // feedDictionary.ts), and decide() only SPLICES a validated pick into
  // effectiveEligible rather than forcing it to be the draft, so the
  // existing EV-ranked cascade/arbiter decides whether it actually wins.
  llmExecutorScope?: "full" | "unmapped" | "off";
  // goals-market-analysis-prompt-v3 gates applied to goals-family markets
  // (Goals O/U, Team Total, BTTS) in the MAIN batch's scanMarkets admission —
  // the noise gate and the §4.4 implausible-edge cap, without the goals-batch
  // penalty table (penalty inputs are sidecar/goals-specific). Default OFF;
  // ships behind its own flag until the goals-only batch (which always runs
  // these gates) is proven in production. Non-goals families are untouched.
  enableV3MainGates?: boolean;
  v3EdgeCap?: number; // default 0.12 — raw edge above this vetoes with reason "v3-cap"
  v3NoiseGate?: number; // default 0.02 — |rawEdge| at/below this vetoes with reason "v3-noise"
  // all-markets-analysis-prompt-v3 — deterministic all-markets engine
  // (marketsV3/analyzeFixtureMarketsV3). "on": replaces the legacy scanMarkets
  // eligibleBets with v3's gate-surviving candidates for this fixture (fails
  // open to legacy eligible on any v3 error/null — a missing/thin data point
  // never blocks the batch). "shadow": v3 still runs (for future comparison
  // instrumentation) but its output is discarded; legacy eligible is used
  // unchanged. "off"/undefined: v3 doesn't run at all — zero overhead,
  // byte-identical to pre-v3 behavior. Default "on" (owner decision).
  enableMarketsV3?: "on" | "shadow" | "off";
  // v4 HFA (home-field advantage) term — applied to λ multiplicatively when
  // venueSplitUsed is false (data is team-overall, not true home/away split).
  // Default 1.10 (10% home advantage per §3.1a). Set to 1.0 to disable.
  v3Hfa?: number;
  // True when λ input comes from venue-split data (home team's home rate, away
  // team's away rate), which already incorporates field advantage; false when
  // input is season-aggregate stats and HFA multiplier should be applied.
  // Default false (most sources provide team-overall stats, not splits).
  v3VenueSplitUsed?: boolean;
  // λ v5: each side of the xG blend (goalsV3/lambda.ts) blends independently
  // when its own cross-pair exists, instead of requiring both sides to have a
  // full xG pair before blending either; the xG-λ also gets small-sample
  // shrinkage. Default true. Set ORACLE_V3_LAMBDA_V5=off to restore the prior
  // both-sides-only, unshrunk xG blend.
  v3LambdaV5?: boolean;
  // Lake-computed league baselines (goals/game keyed by canonical league name),
  // from tools/compute_league_baselines.py via .tmp/oracle-store/league_baselines
  // .json. When present, computeV3Lambdas prefers these over the static
  // V3_LEAGUE_BASELINES table (static stays the fallback for absent leagues) —
  // the audit P0-2 staleness fix. Loaded only when ORACLE_V3_LAKE_BASELINES is
  // on; undefined otherwise ⇒ byte-identical to the static-only behavior.
  v3LakeBaselines?: Record<string, number>;
  // Lake-fitted per-league HFA multipliers (goals-model home-edge m = sqrt(home
  // gpg / away gpg), from tools/compute_league_baselines.py's hfaByName). When
  // present, the all-markets λ core uses the fixture league's fitted m instead
  // of the global v3Hfa (falls back to v3Hfa for leagues absent from the map).
  // Loaded only when ORACLE_V3_LAKE_HFA is on (full-audit P3). Undefined ⇒ the
  // global v3Hfa applies everywhere, as before.
  v3HfaByLeague?: Record<string, number>;
  // v4 gate deltas: heightened EV bars (S {5%,7%}, M {8%}, L {9%,20%}, X excluded),
  // exact-goals/multigoals routing + odds-band classing, sample-scaled empirical blend,
  // sanity checks. Default true. Set ORACLE_V3_GATES_V4=off to restore v3 semantics.
  v3GatesV4?: boolean;
  // v4 completeness: O/U hit-rate demoted from mandatory to critical-tier penalty +
  // per-selection line hit-rates. Default true. Set ORACLE_V3_COMPLETENESS_V4=off to
  // restore hit-rate to the mandatory (discard-on-missing) set.
  v3CompletenessV4?: boolean;
  // PR-5a slate pre-filter: gateMarketsV3Slate eligibility+completeness over
  // sidecar-mapped fixtures before the daily chunk loop (fail-open). Default
  // true. Set ORACLE_MARKETS_V3_GATE=off to analyze the ungated slate.
  marketsV3Gate?: boolean;
  // PR-5b: Outputs A–D + sanity assembly for the all-markets daily batch —
  // replaces the legacy ad-hoc 39-cap trim (league-tier+confidence) with the
  // §7 tie-break ranking sourced from each fixture's v3Best. Only acts when
  // enableMarketsV3 === "on". Default true. Set ORACLE_MARKETS_V3_OUTPUTS=off
  // to keep the exact legacy trim (regression pin).
  marketsV3Outputs?: boolean;
  // PR-20: slate-wide route-coverage rollup (RunManifest.marketCoverage +
  // BatchSummary.marketCoverageNote) — pure telemetry, never gates a pick.
  // Default true. ORACLE_MARKETS_COVERAGE=off skips the rollup computation
  // entirely (byte-identical manifest/summary to pre-PR-20).
  marketsCoverageNote?: boolean;
  // PR-21: load the runtime catalog overlay (markets observed since the last
  // catalog.generated.ts regeneration) at worker startup. Default FALSE —
  // unlike the other markets-v3 flags this one starts off until PR-20's
  // coverage data shows the "uncatalogued" skip tail is material; the weekly
  // diff-only advisory print runs regardless of this flag.
  catalogOverlay?: boolean;
  // PR-6: corners/cards routing — Over/Under total-line markets priced via the
  // NB (corners) / Poisson (cards) modules when both odds and season stats
  // exist. Default true. ORACLE_V3_CORNERS_CARDS=off withholds the raw stats
  // from buildV3Input so ctx.corners/.cards stay null (dormant, byte-identical
  // to pre-PR-6 — routing itself is unconditional, only ctx population is gated).
  v3CornersCards?: boolean;
  // PR-22: 1x2/handicap/range/odd-even corners/cards variants (match/team-total
  // O/U — the pre-PR-22 surface above — are unaffected by this flag). Default
  // true. ORACLE_V3_CORNERS_CARDS_EXT=off suppresses only the new variants;
  // routeMarket() still classifies them (coverage stays accurate), pricing
  // just returns null for that outcome (same "route unconditional, ctx gates
  // pricing" convention v3CornersCards itself uses).
  v3CornersCardsExt?: boolean;
  // PR-22: shots-on-target O/U module (engines/shots.ts). Default true.
  // ORACLE_V3_SHOTS_OU=off withholds sotForH/A from buildV3Input so
  // ctx.shots stays null (dormant, byte-identical to pre-PR-22) — same
  // withhold-not-un-route convention as v3CornersCards.
  v3ShotsOu?: boolean;
  // PR-6: R10 cross-check — re-verify the fixture's best goals-family v3 pick
  // against the independent goals-only engine (in-process, zero extra LLM
  // cost). Default true. ORACLE_V3_GOALS_CROSSCHECK=off skips the hook
  // entirely even when one is supplied (byte-identical to pre-PR-6).
  v3GoalsCrossCheck?: boolean;
  // PR-8 posture A: skip the paid draft LLM cascade for fixtures whose candidate
  // set came from the deterministic v3 engine — the arbiter still reviews the top-N.
  // Default true (ORACLE_V3_DETERMINISTIC_DRAFT=off to restore the LLM draft cascade).
  // Inert on any fixture where v3 did not supply candidates.
  v3DeterministicDraft?: boolean;
  // PR-8: which convergence tiers may spend on the optional LLM extras
  // (briefing / swarm / CVL). "apex" = APEX only (default, most demoted); "all" =
  // the route's own tier decisions (APEX+PRIME briefing/CVL, +VIABLE swarm).
  // Only matters when enableBriefing/enableCVL/enableSwarm are set.
  llmExtrasTiers?: "apex" | "all";
  // PR-7: calibration feedback loop. Three-state:
  //   "off"    — write side inert, read side never loads the ledger (calibFactor=1.0)
  //   "shadow" — write side settles resolved picks into the ledger, but the read
  //              side only LOGS the would-be calibFactor/isotonic deltas; the
  //              engine still runs at calibFactor=1.0 (no behaviour change)
  //   "on"     — write side settles + read side stamps state.ledger so the engine's
  //              calibFactor + isotonic 1x2 calibration activate live
  //   "segment" — [Wave 2, WS2-A] like "on", but calibFactorFor resolves a
  //              per-(league,family)-segment factor once that segment clears
  //              its own significanceAcceptGate (minN 300, effect 0.002),
  //              falling back to the existing global factor otherwise.
  // Default "shadow" (ORACLE_CALIBRATION_LEDGER) for the first 1-2 weeks.
  calibrationLedger?: "off" | "shadow" | "on" | "segment";
  // [refactor P0-2] Market-anchored blend (v5 §5.8): the de-vigged market price
  // is the prior, the model adjusts it. Three-state:
  //   "off"    — blend fields not computed (byte-identical to pre-P0-2 gating)
  //   "shadow" — wModel/pBlend/blendEdge computed + persisted on every
  //              assessment, but the odds≥4.00 blend gate is NOT enforced
  //   "on"     — fields computed AND candidates at odds ≥ 4.00 must also pass
  //              blendEdge ≥ +5% (Class L/X bars unchanged — this is additive)
  // Default "on" per the change list (the underdog fix).
  v3Blend?: "off" | "shadow" | "on";
  // [refactor P0-3] Safety-layer posture. "penalty" (default) converts the
  // mis-scoped MLSafetyFilter hard rejects (odds-band, xG, draw-risk, upset
  // league, sharp fade, miscalibration) into market-family penalties /
  // stake-tier downgrades; hard rejects remain only for integrity failures
  // (contamination, missing mandatory data, promo markets, withdrawn odds,
  // started fixtures). "legacy" restores the pre-refactor hard-reject set —
  // the rollback lever.
  safetyMode?: "legacy" | "penalty";
  // [refactor P1-3] Feed-integrity stage (v5 Rule 0.14): SRL-twin block
  // comparison, fixtures-vs-markets headline 1X2 cross-check, duplicate-block
  // scan. "on" (default) = contamination is an integrity-class hard reject;
  // "shadow" = checks run + log, nothing rejected; "off" = checks skipped.
  feedIntegrity?: "off" | "shadow" | "on";
  // [refactor P1-4] True only once the sharp-reference odds feed is verified
  // live (≥95% pick coverage over 7 consecutive slates). Until then the
  // ConvergenceScorer's sharp-dependent signals (S02 consensus, S03 RLM,
  // S04 compression, S05 CLV survival) are zero-weighted — they'd otherwise
  // compute on air when the only odds source is the soft book being bet into.
  sharpFeedVerified?: boolean;
  // [Wave 2, WS2-A] ISO date (e.g. "2026-07-10") marking the Wave-1 deploy —
  // the P0-2/P0-3 pricing-behavior boundary. Per-segment calibration must only
  // accumulate {n,wins,pSum} from picks whose BetRecord.epoch is on/after this
  // date; pre-epoch records reflect the OLD pricing and would poison segment
  // factors if mixed in. Sourced from ORACLE_CALIBRATION_EPOCH_START.
  calibrationEpochStart?: string;
  // [Wave 2, WS2-B] pi-ratings blended into goalsV3 lambda as a third factor.
  // "shadow" (default) computes diagnostic deltas only — never applied to a
  // live lambda — until the walk-forward harness clears +0.002 RPS; "on" only
  // ever hand-set after that bar is cleared, never as a rollout default.
  v3Ratings?: "off" | "shadow" | "on";
  // [Wave 2, WS2-C] Sharp-reference odds feed (Odds API primary + Playwright/
  // Google-AI-Mode fallback). "shadow" (default) persists CLV records
  // ({pick_odds, sharp_fair_at_pick, sharp_fair_at_close}) without yet being
  // the criterion that flips `sharpFeedVerified` — that flip requires the
  // documented ≥95%-coverage-over-7-slates bar, checked separately.
  sharpFeed?: "off" | "shadow" | "on";
  // [Wave 3, WS3-A] SafetyPipeline extraction — "shadow" (default) runs the
  // extracted pipeline alongside legacy `_run` when `usedV3`, logging a
  // structured diff into the run manifest without DecisionContext reading
  // its output yet; "on" is Wave-4 territory, gated on golden tests +
  // dual-run diff review, never hand-flipped early.
  v3Safety?: "off" | "shadow" | "on";
  // [Wave 3, WS3-A] Rollback lever for the legacy pricer (scanMarkets /
  // scanAllMarketsFallback) — "on" (default) keeps it live; "off" is Wave 4's
  // eventual cutover flag, gated on a ≥7-slate parity report +
  // UNPRICED_BY_DESIGN registry closing the coverage gap.
  legacyPricer?: "on" | "off";
  // [Wave 4-accuracy] Market-anchored blend pricing for ALL v3 candidates (not
  // just odds ≥ 4.00): gates/EV/confidence/ranking/stakes evaluate on
  // pBlend = (1−wModel)·q_fair + wModel·P_model with rescaled class bars
  // (S≥1.0/M≥1.5/L≥2.0/X≥2.0 blended pts + blend-EV floors). Caps + noise
  // floor stay on RAW edge so shrunken edges can never admit a capped pick.
  // "on" (default) per owner decision, validated by the Phase-0 slate replay;
  // "off" = byte-identical legacy gating (rollback lever).
  v3BlendPricing?: "on" | "off";
  // [Wave 4-accuracy] Empirical hit-rate blend for totals O/U 1.5/2.5/3.5
  // (same w = 0.3·min(n,5)/5 convention shape.ts already uses for BTTS%/CS%).
  // Applies ONLY to the default goals counter — corners/cards/team-total
  // reuse of priceOU must stay model-only. "on" (default, owner decision).
  v3TotalsEmpirical?: "on" | "off";
  // [X-carveout 2026-07-11] High-conviction Class X exception to the blend
  // gate — the repo's FIRST deliberate gate-RELAXATION flag (every other flag
  // only raises bars; owner decision). Class X is otherwise unreachable under
  // v3BlendPricing (rawEdgeBlend ≤ 0.40×0.12 = 0.048 minus the raw-space −5pt
  // exotic penalty can never reach the 0.02 blend floor). "off" (default) =
  // byte-identical gating. "shadow" = tag would-pass X assessments
  // (xCarveout: "shadow_pass") for ledger evidence; outcome unchanged. "on" =
  // admit qualifying X candidates at confidence "medium" (floor band, never
  // higher). Every other X bar still applies at full strength: odds ≤ 15,
  // blendEV ≥ 12%, EV floor, raw caps/noise, heightened X-exclusion, plus
  // required data-quality conviction (real xG AND completeness ≥ 0.8). See
  // evGate.ts X_CARVEOUT_PENALTY_RESCALE.
  v3XCarveout?: "off" | "shadow" | "on";
  // [patterns-engine Wave 1] Pattern/trend-detection gate mode (off | shadow | on), default shadow.
  v3Patterns?: "off" | "shadow" | "on";
}

/** Input state for ExecutionEngine.run() — all fields optional for incremental construction. */
export interface RunState {
  telemetry?: {
    piH?: number;
    piA?: number;
    xH?: number;
    xA?: number;
    restH?: number;
    restA?: number;
    travelKm?: number;
    altitudeM?: number;
    hoursToKO?: number;
    hOdds?: number;
    dOdds?: number;
    aOdds?: number;
    ohO?: number;
    oaO?: number;
    broll?: number;
    peakBroll?: number;
    injPenH?: number;
    injPenA?: number;
    motivationScore?: number;
    isDerby?: boolean;
    xgMode?: "empirical" | "estimated";
    xg_confidence?: "low" | "medium" | "high";
    xg_sources_count?: number;
    rawOddsPayload?: Record<string, unknown>;
    oppGA_H?: number;
    oppGA_A?: number;
    // ── all-markets-analysis-prompt-v3 typed market-specific stats, populated
    // by the runtime's buildStatsOverride (previously rawStatsBlock prose only).
    // §3.5 shape-engine empirical blend inputs (0..1 season rates, venue split):
    bttsPctH?: number;
    bttsPctA?: number;
    csPctH?: number;
    csPctA?: number;
    ftsPctH?: number;
    ftsPctA?: number;
    /** §3.5 empirical-blend sample size (match count, recentGoals last-5 window)
     *  behind bttsPct/csPct/ftsPct above (PR-3). */
    formNH?: number;
    formNA?: number;
    /** §3.6 half-engine ρ inputs: first-half share of each team's goals (0..1). */
    fhShareH?: number;
    fhShareA?: number;
    /** §3.9 corners module (Negative Binomial) inputs, per game. */
    cornersForH?: number;
    cornersForA?: number;
    cornersAgainstH?: number;
    cornersAgainstA?: number;
    /** §3.9 cards module (Poisson) inputs: total cards per game. */
    cardsAvgH?: number;
    cardsAvgA?: number;
    /** PR-25 item 2, shadow-diagnostic only (marketsV3/refereeCardsShadow.ts)
     *  — the assigned referee's lake-computed shrunk cards-per-game rate.
     *  FIXTURE-level, not home/away split (one referee, both teams). Never
     *  feeds cardsAvgH/cardsAvgA above or the live cards Poisson mean. */
    refereeCardsRate?: number;
    refereeName?: string;
    /** [patterns-engine Wave 2, Phase 0] Signed win/loss streak + last-5
     *  points, direct passthrough from sportyBetStats.ts's StatsOverride of
     *  the same name — see that file's doc comment for the sign convention
     *  and marketsV3/patterns.ts's PatternInput consumers. */
    streakH?: number;
    streakA?: number;
    last5PtsH?: number;
    last5PtsA?: number;
    /** PR-22 shots-on-target module (Negative Binomial) inputs, per game. */
    sotForH?: number;
    sotForA?: number;
    /** §2 prioritisation / §1.2 heightened-trend inputs: season O/U hit-rates,
     *  venue split (stats_season_overunder). ou25 also feeds the totals engine's
     *  per-line marketStatMissing flag (PR-4). */
    ouO15H?: number;
    ouO15A?: number;
    ouO25H?: number;
    ouO25A?: number;
    ouO35H?: number;
    ouO35A?: number;
    /** §1.2 heightened eligibility (youth/women/friendly/cup-final), stamped by
     *  the PR-5a slate pre-filter — gates this fixture with the stricter v4
     *  heightened bars. Absent ⇒ normal bars. */
    v3Heightened?: boolean;
    softContext?: SoftContextItem[];
    /** Raw structured per-category stats passthrough (see DecisionContext.rawStatsBlock) —
     *  same loose-passthrough convention as rawOddsPayload. */
    rawStatsBlock?: Record<string, unknown>;
    // ── all-markets-analysis-prompt-v3 §3.1 raw multiplicative-λ inputs.
    // Deliberately separate from xH/xA (the legacy Alpha-model's already-
    // blended output) — v3 runs its OWN multiplicative+shrinkage+xG-blend from
    // these raw per-90 rates, independent of and ungated by the legacy
    // override's MIN_PLAYED threshold (v3 has its own shrinkage/sample logic).
    scoredPer90H?: number;
    concededPer90H?: number;
    scoredPer90A?: number;
    concededPer90A?: number;
    xgfH?: number;
    xgaH?: number;
    xgfA?: number;
    xgaA?: number;
    /** Non-penalty xG-for / expected-assisted-goals-for, per-match rate —
     *  FBref-only (PR-25 item 4). Shadow-diagnostic input only (see
     *  marketsV3/finishingRegression.ts) — not consumed by the live λ core. */
    npxgfH?: number;
    npxgfA?: number;
    xagfH?: number;
    xagfA?: number;
    nHome?: number;
    nAway?: number;
    /** Match-day squad availability multiplier (§8.2, PR-6) — see
     *  V3LambdaInput.home/awayAvailabilityMult. */
    homeAvailabilityMult?: number;
    awayAvailabilityMult?: number;
    [key: string]: unknown;
  };
  pipeline?: {
    fixture?: {
      home?: string;
      away?: string;
      league?: string;
      date?: string;
      [key: string]: unknown;
    };
    fetched?: Record<string, unknown>;
  };
  ledger?: {
    bets?: Array<{ outcome?: string; [key: string]: unknown }>;
    metrics?: {
      calibFactor?: number;
      bbnParams?: Record<string, unknown>;
      dynamicRhoParams?: Record<string, number>;
      zipCoeffs?: unknown;
      ahAccuracy?: Record<string, unknown>;
      [key: string]: unknown;
    };
  };
}

// ── Phase 2 Scored History Ledger ─────────────────────────────────────────────

/** Increment when AnalysisRecord shape changes — write-once per record. */
export const ANALYSIS_SCHEMA_VERSION = 1;

/** Full analysis snapshot stored after each ExecutionEngine.run() call (PRD §11, Appendix B). */
export interface AnalysisRecord {
  // ── Appendix B identity fields ──────────────────────────────────────────────
  analysisId: string; // hash(fixtureId:rankingMode:calibrationSnapshotId) — idempotency key
  runId: string; // per-batch run identifier
  schemaVersion: number; // always ANALYSIS_SCHEMA_VERSION
  calibrationSnapshotId: string; // which calibration was active (e.g. "calib_2026-06-02")
  // ── Fixture fields ──────────────────────────────────────────────────────────
  fixtureId: string;
  home: string;
  away: string;
  league: string;
  kickoff: string; // ISO-8601
  // ── Model output ────────────────────────────────────────────────────────────
  lambdaH: number;
  lambdaA: number;
  probabilities: { home: number; draw: number; away: number };
  regime: string;
  rankingMode: RankingMode;
  liquidityTag: LiquidityTag;
  evMarkets: EVMarket[];
  // ── Decision layer ──────────────────────────────────────────────────────────
  llmPick: DecisionOutput | null;
  deterministicTopPick: EVMarket | null;
  decisionReplay: DecisionReplay | null; // prompt + rawResponse + model + temperature (0, or "default" for local-Claude-Code)
  // ── Provenance ──────────────────────────────────────────────────────────────
  frozenOddsAtAnalysis: Record<string, unknown> | null;
  analysedAt: string; // ISO-8601
}

/** Increment when ResolutionRecord shape changes — write-once per record. */
export const RESOLUTION_SCHEMA_VERSION = 2;

/** Resolution record written after the match result is known (PRD §10, Appendix B). */
export interface ResolutionRecord {
  fixtureId: string;
  runId: string; // resolveDay run identifier (PRD Appendix B)
  schemaVersion: number; // always RESOLUTION_SCHEMA_VERSION
  actualResult: "home" | "draw" | "away";
  homeGoals: number;
  awayGoals: number;
  realisedCLV: number | null; // null when liquidityTag !== CLV_ELIGIBLE
  clvSourceQuality: ClvSourceQuality; // provenance tag for the closing-odds proxy (PRD §8.3)
  /** Real home-side odds velocity (1/snapshotOdds - 1/frozenOddsAtAnalysis), from
   *  the T-30m closing-odds snapshot (PR-8b) — null when no snapshot was
   *  captured for this fixture. Schema version 2. Post-hoc observability only,
   *  computed here (not at analysis time) because a T-30m snapshot by
   *  construction can't exist before ORACLE's decision is made hours earlier. */
  realisedSteamVelocity: number | null;
  /** lstmMarketDecoderProxy's sharpCompression verdict on realisedSteamVelocity
   *  — null when no snapshot was captured. Schema version 2. */
  sharpCompressionDetected: boolean | null;
  rpsContribution: number; // rankedProbabilityScore(forecast, actualResult)
  drawCalibrationPoint: { league: string; predicted: number; realised: number } | null;
  resolvedAt: string; // ISO-8601
}

/** Odds shape captured by the T-30m closing snapshot (PR-8a) — a curated subset
 *  of scrape_fixtures.py's _parse_odds() output. Declared independently of
 *  @oracle/runtime's SportyBetOdds (structurally identical core fields) since
 *  @oracle/engine must not depend on @oracle/runtime. */
export interface ClosingOddsSnapshotOdds {
  "1x2"?: {
    home?: number | string | null;
    draw?: number | string | null;
    away?: number | string | null;
  } | null;
  ou15?: { over?: number | string | null; under?: number | string | null } | null;
  ou25?: { over?: number | string | null; under?: number | string | null } | null;
  ou35?: { over?: number | string | null; under?: number | string | null } | null;
  btts?: { yes?: number | string | null; no?: number | string | null } | null;
  dc?: {
    "1x"?: number | string | null;
    "12"?: number | string | null;
    x2?: number | string | null;
  } | null;
  dnb?: { home?: number | string | null; away?: number | string | null } | null;
  ah?: {
    line?: number | null;
    home?: number | string | null;
    away?: number | string | null;
  } | null;
}

/** Increment when ClosingOddsSnapshot shape changes. */
export const CLOSING_ODDS_SCHEMA_VERSION = 1;

/** T-30m re-snapshot for a fixture ORACLE already analyzed (PR-8a). One entry
 *  per fixtureId (upserted, not appended — apps/worker/src/closingOddsSweep.ts
 *  dedupes by fixtureId before the write). Consumed by resolveFixtures.ts (real
 *  CLV, clvSourceQuality "TICK_LEVEL", and a real steam/sharp-compression
 *  signal on ResolutionRecord — both computed post-hoc at resolve time, since
 *  the T-30m snapshot by construction can't exist before ORACLE's decision is
 *  already made hours earlier). */
export interface ClosingOddsSnapshot {
  fixtureId: string; // matches AnalysisRecord.fixtureId exactly (makeFixtureId output)
  eventId: string; // SportyBet/Sportradar match ID used for the scrape
  kickoff: string; // ISO-8601, copied from the AnalysisRecord at capture time
  snapshotAt: string; // ISO-8601, when the scrape actually ran
  odds: ClosingOddsSnapshotOdds;
}

/** Input to the LLM decision layer (PRD §6, Appendix B). */
export interface DecisionInput {
  eligibleBets: EVMarket[];
  evidence: DecisionContext; // fixture context — DecisionContext is the evidence block
  softContext: SoftContextItem[] | "NONE";
}

/** Fixture evidence block alias (PRD Appendix B uses DecisionContext by another name). */
export interface DecisionContext {
  fixture: { home: string; away: string; league: string; kickoff: string };
  fp: { home: number; draw: number; away: number };
  lambdaH: number;
  lambdaA: number;
  expectedScoreline: string;
  regime: string;
  convergenceTier: string;
  convergenceScore: number;
  mlAllowed: boolean;
  drawRisk: string;
  betTrigger: string;
  portfolioCorrelation: number | null;
  /** Hours from now to kickoff (RunState.telemetry.hoursToKO passthrough) —
   *  surfaced in the prompt's RISK SIGNALS block so the "Accept when
   *  hoursToKO>1" decision rule (oracle_decision_rubric.md) is actually
   *  evaluable by the LLM instead of referencing a value it's never given.
   *  Undefined when the telemetry source didn't populate it. */
  hoursToKO?: number;
  softContext?: SoftContextItem[];
  /** Raw structured per-category fixture data (form/standings/goals/h2h/xg/
   *  overunder/congestion/possessionValue + H2H scorelines where available) —
   *  passthrough from RunState.telemetry.rawStatsBlock. Engine-agnostic
   *  (Record<string, unknown>, same convention as rawOddsPayload) since the
   *  concrete shape (SportyBetStats) is defined in @oracle/runtime, which
   *  @oracle/engine cannot import without a circular dependency. Consumed only
   *  by the arbiter prompt builder to give it raw data alongside the existing
   *  distilled softContext prose. */
  rawStatsBlock?: Record<string, unknown>;
  /** Raw SportyBet allMarkets catalogue (900+ entries on a liquid fixture) —
   *  passthrough from fetched.sportyBetOdds.allMarkets. Consumed by the
   *  all-markets LLM executor tier (decision/marketExecutor.ts) when
   *  config.enableLlmMarketExecutor is on; ignored otherwise. */
  allMarkets?: AllMarketEntry[];
  /** [Wave 2, WS2-A] v5 Rule 0.14 feed-integrity verdict for this fixture —
   *  passed through to buildPrompt/buildArbiterPrompt (decision/index.ts,
   *  WS2-D) when populated by the caller (batch/index.ts). Optional/additive;
   *  omission means the prompt simply skips the FEED INTEGRITY section. */
  integrity?: FeedIntegritySignal;
  /** [Wave 2, WS2-A] v5 §5.6 slate-wide sanity-check result, shared across
   *  every fixture in the same batch run — same optional/additive contract. */
  slateSanity?: SlateSanitySignal;
}

// ── §11A Agent Ops Contract ────────────────────────────────────────────────────

export const RUN_MANIFEST_SCHEMA_VERSION = 1;

/** Typed error taxonomy for all agent operations (PRD §11A). */
export type AgentErrorCode =
  | "NO_DATA"
  | "AMBIGUOUS_FIXTURE"
  | "ODDS_UNAVAILABLE"
  | "RATE_LIMITED"
  | "COST_CEILING_HIT"
  | "LLM_PARSE_FAIL"
  | "VALIDATION_REJECT"
  | "PERSISTENCE_FAIL"
  | "DRY_RUN"
  | "INTERNAL";

/** Structured agent error with typed code and retriability signal. */
export interface AgentError {
  code: AgentErrorCode;
  fixtureId?: string;
  message: string;
  retriable: boolean;
  detail?: unknown;
}

/** Per-fixture outcome line in a RunManifest. */
export interface FixtureOutcome {
  fixtureId: string;
  home: string;
  away: string;
  league: string;
  kickoff: string;
  status: "ok" | "error";
  pick: PickRef | null;
  grade: ConfidenceGrade | null;
  confidence: number | null;
  errorCode: AgentErrorCode | null;
  errorMessage: string | null;
  stakePct: number | null;
}

/** Emitted once per batch — machine-readable audit log of the entire run (PRD §11A). */
export interface RunManifest {
  runId: string;
  schemaVersion: number; // always RUN_MANIFEST_SCHEMA_VERSION
  startedAt: string; // ISO-8601
  finishedAt: string; // ISO-8601
  mode: RankingMode;
  trigger: "scheduled" | "manual" | "backfill";
  calibrationSnapshotId: string;
  fixtures: FixtureOutcome[];
  totals: {
    analysed: number;
    actionable: number;
    errors: number;
    totalRecommendedStakePct: number;
  };
  cost: {
    estimatedUsd: number | null;
    ceilingUsd: number | null;
    halted: boolean;
  };
  errors: AgentError[];
  /** PR-20: slate-wide route-coverage rollup (packages/runtime's
   *  rollupCoverage) — additive/optional so existing manifest.json readers and
   *  the storage-persisted history are unaffected. Absent when v3 didn't run
   *  or ORACLE_MARKETS_COVERAGE=off. */
  marketCoverage?: {
    total: number;
    routed: number;
    priced: number;
    gatePassed: number;
    topUnrouted: Array<{ name: string; count: number }>;
  };
}

/** Output of ExecutionEngine.run(). Index signature allows spread of fixture fields. */
export type RunResult = {
  fp: { home: number; draw: number; away: number };
  evMarkets: EVMarket[];
  oddsAvailable: boolean;
  bayesian_lH: number;
  bayesian_lA: number;
  expectedScoreline: string;
  portfolioCorrelation: number | null;
  correlatedParlayRisk: Array<{ a: string; b: string; rho: number }> | null;
  /** Set only when ORACLE_AGENT_VERIFY="true" and a local Claude Code runtime
   *  verified this fixture's engine output against the scraped evidence. */
  agentVerification?: {
    lambdasConsistent: boolean;
    topMarketSupported: boolean;
    flags: string[];
    orchestratorNote: string;
  };
  /** Coverage of the raw SportyBet allMarkets catalogue against the canonical
   *  market index (packages/engine/src/markets). Lets the daily report show how
   *  much of what the book published the engine recognises and can price.
   *  Undefined when the fixture carried no allMarkets payload. */
  marketCoverage?: MarketCoverage;
  [key: string]: unknown;
};

/** How a fixture's raw allMarkets entries map onto the canonical index:
 *  priced ≤ priceable ≤ inCatalog ≤ total. `total` counts distinct market
 *  entries (not per-outcome). */
export interface MarketCoverage {
  total: number; // raw allMarkets entries seen
  inCatalog: number; // entries whose market id is in the canonical index
  priceable: number; // entries whose catalog family has a deterministic model
  priced: number; // entries that actually produced an EV candidate
}
