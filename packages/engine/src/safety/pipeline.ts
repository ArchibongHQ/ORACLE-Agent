/** [Wave 3, WS3-A] SafetyPipeline extraction — stage 1 + stage 2.
 *
 *  Verbatim lift of execution/index.ts `_run`'s post-pricing block, in the
 *  SAME order the legacy engine always ran it in:
 *    steam-chaser veto → portfolio correlation/covariance hard-cap →
 *    AntiSycophancy → RAG → ConvergenceScorer → tier/family multipliers →
 *    MLSafetyFilter → rag.addToStore.
 *  Source-agnostic: takes evMarkets + a shared match-context blob (`context`,
 *  duck-typed the same way AntiSycophancyCircuit/RAGSystem/ConvergenceScorer/
 *  MLSafetyFilter already consumed it pre-extraction — this function does not
 *  change that contract) so both the legacy pricer's candidates AND v3's
 *  Kelly-staked candidates (via `v3AssessmentsToEvMarkets` below) can be run
 *  through the exact same safety stage.
 *
 *  `_sensitivityAnalyze` (execution/index.ts) is deliberately NOT part of this
 *  extraction — it recursively calls `ExecutionEngine._run`, which isn't
 *  source-agnostic (v3 has no equivalent recursive entry point) and doesn't
 *  read/write anything this pipeline stage touches beyond `evMarkets[0]`'s
 *  label/ev, which this pipeline never reorders or removes. The caller keeps
 *  running it separately, gated by the same `skipSensitivity` flag.
 *
 *  `scanAllMarketsFallback` is likewise NOT part of this extraction — it's a
 *  pricing stage (alongside `scanMarkets`), not a safety stage; the recon note
 *  in the Wave-3 plan groups it with `scanMarkets`, not "the whole safety
 *  layer". The caller merges its output into `evMarkets` BEFORE calling
 *  `runSafetyPipeline`, so every candidate (scanMarkets + fallback) is subject
 *  to the steam-chaser veto and everything downstream — pre-extraction, the
 *  steam-chaser veto ran before the fallback merge and so never saw fallback
 *  candidates; no test encodes that exemption (fallback produces zero
 *  candidates in every current fixture/golden test, since none stub
 *  `fetched.sportyBetOdds.allMarkets`), and folding fallback candidates into
 *  the same veto is the correct behavior per Q4's "no market is skipped for
 *  consideration" mandate — this is a deliberate, documented judgment call,
 *  not an oversight. */

import type { StoragePort } from "@oracle/storage";
import { FAMILY_LABEL, type MarketFamily } from "../markets/index.js";
import type { V3MarketOutcomeAssessment } from "../marketsV3/analyzeFixtureMarkets.js";
import { dirOfDesc } from "../marketsV3/descParse.js";
import { TOTALS_FAMILIES } from "../marketsV3/sanity.js";
import { CorrelationMatrix, isSteamChaser, optimizedKelly } from "../math/index.js";
import { RAGSystem } from "../rag/index.js";
import type { EVMarket, Matrix } from "../types.js";
import {
  AntiSycophancyCircuit,
  type ConvergenceResult,
  ConvergenceScorer,
  familyPenaltyMultiplier,
  MLSafetyFilter,
  type MLSafetyResult,
} from "./index.js";

export interface SafetyPipelineInput {
  evMarkets: EVMarket[];
  matrix: Matrix;
  telemetry: Record<string, unknown>;
  calibFactorFor: (family: MarketFamily | undefined) => number;
  /** Full match-context blob AntiSycophancyCircuit.execute / RAGSystem.
   *  findSimilar+addToStore / ConvergenceScorer.compute / MLSafetyFilter.
   *  evaluate all consume via a `Record<string, unknown>` cast (pre-existing
   *  duck-typing in safety/index.ts + rag/index.ts, unchanged by this
   *  extraction). For the legacy path this is the fixture's own `RunResult`
   *  (cast down); for the v3 shadow path (batch/index.ts) it's a lightweight
   *  clone of the legacy `RunResult` with `evMarkets` swapped for the
   *  v3-adapted set — same fixture-level context (λ, odds, mes, drawRisk
   *  factors), different market candidates. This function keeps
   *  `context.evMarkets` in sync with its own local `evMarkets` copy as it
   *  mutates — callers should read the RETURNED `evMarkets`, not re-read
   *  `context.evMarkets` afterward. */
  context: Record<string, unknown>;
  fetched: Record<string, unknown>;
  storage: StoragePort;
  sharpCompressionTag: boolean;
  /** Mirrors `_run`'s own `skipSensitivity` param — gates the portfolio-
   *  correlation block exactly as it did pre-extraction (recursive
   *  perturbation runs from `_sensitivityAnalyze` pass `true` here too, same
   *  as before). */
  skipSensitivity: boolean;
  safetyMode: "legacy" | "penalty";
  sharpFeedVerified: boolean;
  expectedScoreline: string;
  home: unknown;
  away: unknown;
}

export interface SafetyPipelineResult {
  evMarkets: EVMarket[];
  portfolioCorrelation: number | null;
  correlatedParlayRisk: Array<{ a: string; b: string; rho: number }> | null;
  debate: Record<string, unknown>;
  convergence: ConvergenceResult;
  mlFilter: MLSafetyResult;
}

/** [PR-17, moved here Wave 3 WS3-A — logic unchanged] Scales one evMarket's
 *  already-computed optimizedKelly stake by its ConvergenceScorer tier's
 *  kellyMultiplier — a standalone pure function so it's directly
 *  unit-testable without needing to engineer a specific convergence score
 *  through the full pipeline. Mutates evMarket in place, matching this file's
 *  post-processing convention (the portfolio-correlation veto block above
 *  does the same). Full Kelly (multiplier >= 1) is a no-op — the stake
 *  already reflects it. NOISE (multiplier <= 0) vetoes the market outright
 *  rather than leaving a live positive-EV pick with a stake the tier guidance
 *  explicitly says not to deploy. Re-exported from execution/index.ts for
 *  backward compatibility (batch/index.ts and the `@oracle/engine` barrel
 *  both import it from there). */
export function applyConvergenceTierToStake(evMarket: EVMarket, kellyMultiplier: number): void {
  if (kellyMultiplier >= 1) return;
  if (kellyMultiplier <= 0) {
    evMarket.veto = "CONVERGENCE_NOISE_VETO";
    evMarket.stake = 0;
    evMarket.stakeAmt = 0;
    return;
  }
  evMarket.stake *= kellyMultiplier;
  evMarket.stakeAmt *= kellyMultiplier;
}

export async function runSafetyPipeline(input: SafetyPipelineInput): Promise<SafetyPipelineResult> {
  let evMarkets = input.evMarkets;

  // Steam chaser veto
  evMarkets = evMarkets.map((m) =>
    isSteamChaser(input.sharpCompressionTag, m.ev)
      ? { ...m, veto: "STEAM_CHASER_VETO", stake: 0, stakeAmt: 0 }
      : m
  );

  // Portfolio covariance + correlated parlay hard cap (BUG-M05 FIX)
  let portfolioCorrelation: number | null = null;
  let correlatedParlayRisk: Array<{ a: string; b: string; rho: number }> | null = null;
  if (!input.skipSensitivity && evMarkets.length >= 2) {
    let maxRho = 0;
    const penalties = new Array<number>(evMarkets.length).fill(1.0);
    const correlatedPairs: Array<{ a: string; b: string; rho: number }> = [];
    const vetoSet = new Set<number>();
    for (let i = 0; i < evMarkets.length - 1; i++) {
      // Already-vetoed/non-positive-EV markets can never be selected downstream
      // regardless of correlation — skip the whole inner loop for them rather
      // than computing O(n) correlation pairs that are discarded either way.
      if (evMarkets[i]?.veto || (evMarkets[i]?.ev ?? 0) <= 0) continue;
      for (let j = i + 1; j < evMarkets.length; j++) {
        if (evMarkets[j]?.veto || (evMarkets[j]?.ev ?? 0) <= 0) continue;
        const rho = CorrelationMatrix.compute(
          input.matrix,
          evMarkets[i]?.label,
          evMarkets[j]?.label
        );
        if (rho > 0.1) {
          maxRho = Math.max(maxRho, rho);
          const pen = 1 / (1 + rho);
          penalties[i] = Math.min(penalties[i]!, pen);
          penalties[j] = Math.min(penalties[j]!, pen);
        }
        if (rho > 0.7) {
          correlatedPairs.push({
            a: evMarkets[i]?.label,
            b: evMarkets[j]?.label,
            rho: parseFloat(rho.toFixed(3)),
          });
          vetoSet.add((evMarkets[i]?.ev ?? 0) >= (evMarkets[j]?.ev ?? 0) ? j : i);
        }
      }
    }
    for (let i = 0; i < evMarkets.length; i++) {
      if (vetoSet.has(i)) {
        evMarkets[i]!.stake = 0;
        evMarkets[i]!.stakeAmt = 0;
        evMarkets[i]!.veto = "CORRELATED_PARLAY_VETO";
      } else {
        evMarkets[i]!.stakeAmt *= penalties[i]!;
        evMarkets[i]!.stake *= penalties[i]!;
      }
    }
    portfolioCorrelation = maxRho;
    correlatedParlayRisk = correlatedPairs;
  }

  // Keep the shared context blob's evMarkets in sync before handing it to
  // AntiSycophancy/RAG/Convergence/MLSafetyFilter, all of which read
  // `context.evMarkets` internally via their Record<string, unknown> cast.
  input.context.evMarkets = evMarkets;

  const debate = new AntiSycophancyCircuit().execute(input.context);
  input.context.debate = debate;

  const rag = new RAGSystem(input.storage);
  await rag.init();
  const ragSimilar = rag.findSimilar(input.context, 5);
  const convergence = new ConvergenceScorer().compute(
    input.context,
    ragSimilar as unknown as Record<string, unknown>[],
    { sharpSignalsEnabled: input.sharpFeedVerified }
  );
  input.context.convergence = convergence;

  // [PR-17] ConvergenceScorer's per-tier Kelly guidance (Full/Half/Quarter/
  // Do-not-bet) — every scored candidate carries its OWN tier, not just the
  // apex pick, so multiply each one's already-computed Kelly stake by its
  // tier's kellyMultiplier directly.
  for (const scored of convergence.scores) {
    const evMarket = evMarkets.find(
      (m) => !m.veto && (m.label === scored.market || m.market === scored.market)
    );
    if (!evMarket) continue;
    applyConvergenceTierToStake(evMarket, scored.tier.kellyMultiplier);
  }

  // [P0-3] safetyMode="penalty" (default) turns the former MLSafetyFilter
  // hard rejects into market-FAMILY stake downgrades instead of
  // fixture-wide kills. "legacy" preserves the old hard-reject behavior via
  // evaluate()'s early returns.
  const mlFilterResult = new MLSafetyFilter().evaluate(
    input.fetched,
    input.context,
    input.telemetry,
    { mode: input.safetyMode }
  );
  if (input.safetyMode === "penalty") {
    const penaltySignals = mlFilterResult.penaltySignals;
    for (const evMarket of evMarkets) {
      if (evMarket.veto) continue;
      const mult = familyPenaltyMultiplier(evMarket.cat, penaltySignals);
      if (mult < 1) applyConvergenceTierToStake(evMarket, mult);
    }
  }

  await rag.addToStore(input.context, {
    evMarkets,
    debate,
    expectedScoreline: input.expectedScoreline,
    home: input.home,
    away: input.away,
  });

  return {
    evMarkets,
    portfolioCorrelation,
    correlatedParlayRisk,
    debate,
    convergence,
    mlFilter: mlFilterResult,
  };
}

/** [Wave 3, WS3-A] v3AssessmentsToEvMarkets — adapts v3's gate-surviving
 *  assessments (which carry `stake: 0`/`stakeAmt: 0` — v3's deterministic
 *  engine only gates/ranks, it never Kelly-stakes) into the same `EVMarket[]`
 *  shape the legacy pricer produces, WITH real Kelly stakes, so the stage-2
 *  shadow run can be compared apples-to-apples against the legacy pipeline's
 *  fully-staked output. Mirrors marketsV3/analyzeFixtureMarkets.ts's own
 *  EVMarket-literal shape (cat/market = FAMILY_LABEL[family], label/side =
 *  desc, ev = mp*odds-1) plus a real `optimizedKelly` stake using the
 *  fixture's segment calibFactor (same call shape execution/index.ts's
 *  analysis1x2 stakes use — base 0.25, edge = adjustedEdge, modelProb = mp). */
export interface V3ToEvMarketsOptions {
  bankroll: number;
  dqs: number;
  councilPenalty: boolean;
  varMultiplier: number;
  drawdownPenalty: number;
  calibFactorFor: (family: MarketFamily | undefined) => number;
}

export function v3AssessmentsToEvMarkets(
  assessments: V3MarketOutcomeAssessment[],
  opts: V3ToEvMarketsOptions
): EVMarket[] {
  return assessments
    .filter(
      (a) =>
        a.outcome === "done" &&
        // [Phase 3, Under->AH pivot — adversarial review finding,
        // 2026-07-16] This is the canonical Kelly staker feeding `eligible`/
        // the live arbiter candidate pool and ultimately `primaryPick`.
        // analyzeFixtureMarketsV3 strips Unders from its OWN `evMarkets`
        // return value only, deliberately leaving `assessments` untouched
        // for transparency — so this filter is the one place that must
        // exclude them before a gate-passing Under can reach real staking.
        !(TOTALS_FAMILIES.has(a.family) && dirOfDesc(a.desc) === "under")
    )
    .map((a) => {
      const calibFactor = opts.calibFactorFor(a.family);
      const stake = optimizedKelly(
        a.adjustedEdge,
        a.odds,
        opts.dqs,
        opts.councilPenalty,
        opts.varMultiplier,
        opts.drawdownPenalty,
        calibFactor,
        0.25,
        a.mp
      );
      const label = FAMILY_LABEL[a.family];
      return {
        cat: label,
        label: a.desc,
        market: label,
        side: a.desc,
        family: a.family,
        mp: a.mp,
        modelProb: a.mp,
        ip: a.q,
        rawEdge: a.rawEdge,
        ev: a.ev,
        odds: a.odds,
        stake,
        stakeAmt: stake * opts.bankroll,
        rankingScore: a.adjustedEdge,
        varianceMod: opts.varMultiplier,
      };
    })
    .sort((a, b) => b.rankingScore - a.rankingScore);
}

/** [Wave 3, WS3-A] Structured diff between the legacy safety-pipeline output
 *  (source of truth — DecisionContext always reads this) and the v3-adapted
 *  shadow run (diagnostic-only, stage-2). Logged into the batch result for a
 *  run-manifest consumer to persist; never read back into any live decision
 *  path from here. */
export interface SafetyShadowDiff {
  legacyTopLabel: string | null;
  legacyTopEv: number | null;
  v3TopLabel: string | null;
  v3TopEv: number | null;
  topMarketMatches: boolean;
  legacyCandidateCount: number;
  v3CandidateCount: number;
  legacyPortfolioCorrelation: number | null;
  v3PortfolioCorrelation: number | null;
}

function topSurvivor(evMarkets: EVMarket[]): EVMarket | null {
  return (
    evMarkets
      .filter((m) => !m.veto && m.ev > 0)
      .sort((a, b) => b.rankingScore - a.rankingScore)[0] ?? null
  );
}

export function buildSafetyShadowDiff(
  legacy: SafetyPipelineResult,
  v3Adapted: SafetyPipelineResult
): SafetyShadowDiff {
  const legacyTop = topSurvivor(legacy.evMarkets);
  const v3Top = topSurvivor(v3Adapted.evMarkets);
  return {
    legacyTopLabel: legacyTop?.label ?? null,
    legacyTopEv: legacyTop?.ev ?? null,
    v3TopLabel: v3Top?.label ?? null,
    v3TopEv: v3Top?.ev ?? null,
    topMarketMatches: Boolean(legacyTop && v3Top && legacyTop.label === v3Top.label),
    legacyCandidateCount: legacy.evMarkets.length,
    v3CandidateCount: v3Adapted.evMarkets.length,
    legacyPortfolioCorrelation: legacy.portfolioCorrelation,
    v3PortfolioCorrelation: v3Adapted.portfolioCorrelation,
  };
}
