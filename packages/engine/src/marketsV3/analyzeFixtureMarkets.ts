/** all-markets-analysis-prompt-v3 — deterministic all-markets orchestrator.
 *
 *  Per-fixture pipeline: §3.1 lambdas → §3.2 dual split (+ half-share split)
 *  → §0.2 feed-dictionary routing of the fixture's raw allMarkets catalogue →
 *  §3.3–§3.8 engines → §4.1 de-vig → §4.2 class → §5 tiered EV gate → the
 *  fixture's single best surviving selection (§4.3).
 *
 *  Zero LLM calls — pure deterministic script math, per the token-saving
 *  mandate. Pure function; all data arrives in the input struct. */

import { getLeagueParams } from "../execution/index.js";
import type { V3PenaltyFlags } from "../goalsV3/edgeGate.js";
import { computeV3Lambdas, type V3LambdaInput, type V3Lambdas } from "../goalsV3/lambda.js";
import type { Devigged1x2 } from "../goalsV3/matchShape.js";
import { FAMILY_LABEL, type MarketFamily } from "../markets/index.js";
import type { AllMarketEntry, EVMarket, Matrix } from "../types.js";
import { classifyMarket } from "./classes.js";
import { priceExoticsOutcome } from "./engines/exotics.js";
import { priceHalfOutcome, V3_FIRST_HALF_SHARE_DEFAULT } from "./engines/half.js";
import { priceResultOutcome } from "./engines/result.js";
import { priceShapeOutcome } from "./engines/shape.js";
import { priceTimeWindow } from "./engines/time.js";
import { priceTotalsOutcome } from "./engines/totals.js";
import type { V3EngineCtx, V3Price } from "./engines/types.js";
import {
  gateAllMarkets,
  impliedQ,
  type V3AllMarketsAssessment,
  type V3AllMarketsPenaltyFlags,
} from "./evGate.js";
import {
  isSkip,
  type RouteCoverage,
  routeCoverage,
  routeMarket,
  type V3Route,
} from "./feedDictionary.js";
import { buildV3Grid, buildV3HalfGrid } from "./grid.js";
import { type DualSplit, deriveDualSplit } from "./split.js";

export interface V3EmpiricalInputs {
  bttsPctH?: number;
  bttsPctA?: number;
  csPctH?: number;
  csPctA?: number;
  ftsPctH?: number;
  ftsPctA?: number;
}

export interface V3AllMarketsInput {
  fixtureId: string;
  runId: string;
  home: string;
  away: string;
  league: string;
  kickoff: string;
  lambdaInput: V3LambdaInput;
  devigged1x2: Devigged1x2 | null | undefined;
  allMarkets: AllMarketEntry[];
  fhShareH?: number;
  fhShareA?: number;
  empirical?: V3EmpiricalInputs;
  penaltyFlags: V3PenaltyFlags;
  edgeCap?: number;
  noiseGate?: number;
  xgBlend?: boolean;
  /** v3 HFA multiplier (§3.1a). Default 1.10. */
  hfa?: number;
  /** True when λ input uses venue-split data (suppress HFA). */
  venueSplitUsed?: boolean;
}

export interface V3MarketOutcomeAssessment extends V3AllMarketsAssessment {
  family: MarketFamily;
  marketId: string;
  marketName: string;
  outcomeId: string;
  desc: string;
  odds: number;
  mp: number;
}

export interface V3AllMarketsResult {
  lambdas: V3Lambdas;
  split: DualSplit;
  fhShare: number;
  fhShareIsDefault: boolean;
  coverage: RouteCoverage;
  /** Every gate-surviving OR capped assessment (report/transparency). */
  assessments: V3MarketOutcomeAssessment[];
  capped: V3MarketOutcomeAssessment[];
  /** Gate-surviving candidates, ranked by adjusted edge (best first). §4.3
   *  caps this to the fixture's single best per-run in the P6 output layer;
   *  the orchestrator returns the full survivor list so P3/P5 can splice
   *  whichever candidates they need into decide(). */
  evMarkets: EVMarket[];
  best: EVMarket | null;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

function clampShare(v: number): number {
  return Math.min(0.8, Math.max(0.2, v));
}

function resolveFhShare(input: V3AllMarketsInput): { share: number; isDefault: boolean } {
  const { fhShareH, fhShareA } = input;
  if (typeof fhShareH === "number" && typeof fhShareA === "number") {
    return { share: clampShare((fhShareH + fhShareA) / 2), isDefault: false };
  }
  return { share: V3_FIRST_HALF_SHARE_DEFAULT, isDefault: true };
}

function priceOutcome(
  ctx: V3EngineCtx,
  route: V3Route,
  marketName: string,
  desc: string
): V3Price | null {
  switch (route.engine) {
    case "totals":
      return priceTotalsOutcome(ctx, route, desc);
    case "result":
      return priceResultOutcome(ctx, route, marketName, desc);
    case "shape":
      return priceShapeOutcome(ctx, route, marketName, desc);
    case "half":
      return priceHalfOutcome(ctx, route, marketName, desc);
    case "time":
      return route.minute !== undefined ? priceTimeWindow(ctx.mu, route.minute, desc) : null;
    case "exotics":
      return priceExoticsOutcome(ctx, route, marketName, desc);
    default:
      return null;
  }
}

const parseOdds = (raw: string | null | undefined): number | null => {
  const n = raw != null ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(n) && n > 1 ? n : null;
};

/** Devig context for one market: 2-way → the other outcome's odds; exactly
 *  3-way → the full outcome set (§4.1 normalise); else single-price. */
function impliedQFor(
  entry: AllMarketEntry,
  outcomeIdx: number,
  odds: number
): { q: number; devigged: boolean } | null {
  const oddsList = entry.outcomes.map((o) => parseOdds(o.odds));
  if (entry.outcomes.length === 2) {
    const other = oddsList[1 - outcomeIdx];
    return impliedQ(odds, other ?? undefined);
  }
  if (entry.outcomes.length === 3 && oddsList.every((o) => o !== null)) {
    return impliedQ(odds, undefined, oddsList as number[]);
  }
  return impliedQ(odds);
}

export function analyzeFixtureMarketsV3(input: V3AllMarketsInput): V3AllMarketsResult | null {
  const lambdas = computeV3Lambdas(input.lambdaInput, {
    xgBlend: input.xgBlend,
    hfa: input.hfa,
    venueSplitUsed: input.venueSplitUsed,
  });
  if (!lambdas) return null;

  const rho = getLeagueParams(input.league).baseRho;
  const split = deriveDualSplit(lambdas, input.devigged1x2);
  const statsGrid = buildV3Grid(split.stats.lambdaHome, split.stats.lambdaAway, rho);
  const shapeGrid = buildV3Grid(split.odds.lambdaHome, split.odds.lambdaAway, rho);

  const { share: fhShare, isDefault: fhShareIsDefault } = resolveFhShare(input);
  const halfPair = (lH: number, lA: number): [Matrix, Matrix] => [
    buildV3HalfGrid(lH * fhShare, lA * fhShare),
    buildV3HalfGrid(lH * (1 - fhShare), lA * (1 - fhShare)),
  ];

  const ctx: V3EngineCtx = {
    statsGrid,
    shapeGrid,
    mu: lambdas.mu,
    split,
    fhShare,
    fhShareIsDefault,
    halfStats: halfPair(split.stats.lambdaHome, split.stats.lambdaAway),
    halfShape: halfPair(split.odds.lambdaHome, split.odds.lambdaAway),
    empirical: input.empirical ?? {},
  };

  const coverage = routeCoverage(input.allMarkets);
  const assessments: V3MarketOutcomeAssessment[] = [];
  const capped: V3MarketOutcomeAssessment[] = [];
  const evMarkets: EVMarket[] = [];

  for (const entry of input.allMarkets) {
    const route = routeMarket(entry);
    if (isSkip(route)) continue;
    const marketName = entry.name ?? entry.desc ?? "";

    entry.outcomes.forEach((outcome, idx) => {
      const desc = outcome.desc ?? "";
      const odds = parseOdds(outcome.odds);
      if (!odds || !desc) return;
      const price = priceOutcome(ctx, route, marketName, desc);
      if (!price) return;

      const q = impliedQFor(entry, idx, odds);
      if (!q) return;

      const marketClass = classifyMarket(route.family, odds);
      const flags: V3AllMarketsPenaltyFlags = {
        ...input.penaltyFlags,
        exoticClass: marketClass === "X",
        marketStatMissing: price.marketStatMissing === true,
        shapeDisagreement: price.resultClass === true && split.shapeDisagreement,
      };

      const gate = gateAllMarkets(price.p, q, odds, marketClass, flags, {
        edgeCap: input.edgeCap,
        noiseGate: input.noiseGate,
      });

      const assessment: V3MarketOutcomeAssessment = {
        ...gate,
        family: route.family,
        marketId: entry.id,
        marketName,
        outcomeId: outcome.id,
        desc,
        odds,
        mp: round3(price.p),
      };
      assessments.push(assessment);
      if (gate.outcome === "capped") capped.push(assessment);
      if (gate.outcome !== "done" || !gate.confidence) return;

      const label = FAMILY_LABEL[route.family];
      evMarkets.push({
        cat: label,
        label: desc,
        market: label,
        side: desc,
        family: route.family,
        mp: price.p,
        modelProb: price.p,
        ip: gate.q,
        rawEdge: gate.rawEdge,
        ev: price.p * odds - 1,
        odds,
        stake: 0,
        stakeAmt: 0,
        rankingScore: gate.adjustedEdge,
        varianceMod: 1,
      });
    });
  }

  evMarkets.sort((a, b) => b.rankingScore - a.rankingScore);

  return {
    lambdas,
    split,
    fhShare,
    fhShareIsDefault,
    coverage,
    assessments,
    capped,
    evMarkets,
    best: evMarkets[0] ?? null,
  };
}
