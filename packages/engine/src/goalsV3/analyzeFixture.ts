/** goals-market-analysis-prompt-v3 — deterministic per-fixture analysis.
 *
 *  The lean goals path: v3 lambdas (multiplicative + shrinkage + xG blend) →
 *  joint scoreline matrix with the engine's Dixon–Coles low-score correction
 *  (locked plan decision: DC is kept — the exact-tail requirement is still met,
 *  and DC strictly improves the 0-0/1-0/0-1/1-1 cells that decide Over 1.5 and
 *  Team Over 0.5) → O/U from the raw-μ matrix, BTTS/team totals from a SECOND
 *  matrix built on the §3.5 match-shape split → §4 edge gate per market.
 *
 *  Replaces runAnalysis/ExecutionEngine for the goals batch: no ensemble, no
 *  per-fixture LLM, <1 ms per fixture. Emits a FixtureJobSuccess-conformant
 *  `job` so selectGoalsAccumulator consumes it unchanged, plus the full v3
 *  assessment trail (including capped/noise discards) for the report layer.
 *
 *  Pure function — all data arrives in the input struct; no runtime imports. */

import type { BatchJobResult, FixtureJobSuccess } from "../batch/index.js";
import { devigThreeWay, FAMILY_LABEL } from "../markets/index.js";
import { buildMatrix, extractMarkets } from "../math/index.js";
import type { ConfidenceGrade, EVMarket, RunResult } from "../types.js";
import { devigOU, gateV3Edge, type V3EdgeAssessment, type V3PenaltyFlags } from "./edgeGate.js";
import { computeV3Lambdas, resolveRho, type V3LambdaInput, type V3Lambdas } from "./lambda.js";
import { deriveMatchShape, type MatchShape } from "./matchShape.js";

/** Decimal odds the goals path prices. Absent side of a pair ⇒ 1/odds implied. */
export interface V3FixtureOdds {
  over15?: number | null;
  under15?: number | null;
  over25?: number | null;
  under25?: number | null;
  homeTotalOver05?: number | null;
  awayTotalOver05?: number | null;
  bttsYes?: number | null;
  bttsNo?: number | null;
  home1x2?: number | null;
  draw1x2?: number | null;
  away1x2?: number | null;
}

/** v4 §0.3 per-selection hit-rate availability (PR-4) — structurally matches
 *  runtime's `V3LineHitRates` (deriveLineHitRates), not imported directly since
 *  the engine package never depends on runtime. Undefined entries mean
 *  "unknown for this line" — the candidate falls back to the fixture-wide
 *  `penaltyFlags.hitRateMissing`. */
export interface V3LineHitRates {
  over15?: boolean;
  over25?: boolean;
  over35?: boolean;
  btts?: boolean;
}

export interface V3AnalyzeInput {
  fixtureId: string;
  runId: string;
  home: string;
  away: string;
  league: string;
  kickoff: string;
  odds: V3FixtureOdds;
  lambdaInput: V3LambdaInput;
  penaltyFlags: V3PenaltyFlags;
  /** v3 weighted completeness score (0–100) from the runtime scorer. */
  completeness: number;
  /** Data-source names for the §6 source-citing rationale. */
  sources: string[];
  /** Optional NB overdispersion r (validated to [8,20] — §3.2 "never r = 2"). */
  nbDispersion?: number;
  /** 50/50 xG blend toggle (GOALS_V3_XG_BLEND). Default on. */
  xgBlend?: boolean;
  edgeCap?: number;
  noiseGate?: number;
  /** v3 HFA multiplier (§3.1a). Default 1.10 (10% home advantage). */
  hfa?: number;
  /** True when λ input uses venue-split data (suppress HFA multiplier). */
  venueSplitUsed?: boolean;
  /** λ v5 independent-side xG blend (ORACLE_V3_LAMBDA_V5). Default on. */
  lambdaV5?: boolean;
  /** v4 heightened gates: 8pt pass floor under HFA/hit-rate uncertainty (PR-3). */
  heightened?: boolean;
  /** v4 §0.3 per-selection hit-rates (PR-4) — overrides `penaltyFlags.hitRateMissing`
   *  per candidate line when the matching entry is defined. */
  lineHitRates?: V3LineHitRates;
  /** Per-league dynamic rho refit from the calibration ledger's observed
   *  scoreline frequencies (CalibrationMetrics.dynamicRhoParams, §8.1 NR-MLE).
   *  Falls back to the static getLeagueParams(league).baseRho when absent
   *  (calibrationLedger mode "off"/"shadow", or a league with n<30 samples). */
  dynamicRho?: number;
}

/** One market's full v3 assessment — kept for every priced market including
 *  discards, so the report layer can show the §4.4 capped log. */
export interface V3MarketAssessment extends V3EdgeAssessment {
  /** EVMarket.cat / EVMarket.label the engine convention uses. */
  cat: string;
  label: string;
  odds: number;
  mp: number;
  rationale: string;
}

/** v3 metadata attached to each emitted EVMarket (structural extension —
 *  selectGoals reads it in v3 mode to build GoalsLeg tier/edge fields). */
export interface V3MarketMeta {
  rawEdge: number;
  penaltyPts: number;
  adjustedEdge: number;
  tier: "very_high" | "high" | "medium";
  q: number;
  devigged: boolean;
  rationale: string;
  sources: string[];
  completeness: number;
}

export type V3EVMarket = EVMarket & { v3?: V3MarketMeta };

export interface V3FixtureResult {
  job: BatchJobResult;
  lambdas: V3Lambdas;
  shape: MatchShape;
  /** Every market assessed, DONE and discarded alike (report/transparency). */
  assessments: V3MarketAssessment[];
  /** §4.4 capped selections (raw edge > cap) — logged, never bet. */
  capped: V3MarketAssessment[];
}

/** §3.2 NB guard: r must land in [8,20]; anything else (esp. r=2) falls back
 *  to plain Poisson. */
export function v3NbDispersion(r: number | undefined): number | undefined {
  if (r == null || !Number.isFinite(r)) return undefined;
  return r >= 8 && r <= 20 ? r : undefined;
}

const GOALS_OU_LABEL = FAMILY_LABEL.goals_ou;
const TEAM_TOTAL_LABEL = FAMILY_LABEL.team_total;
const BTTS_LABEL = FAMILY_LABEL.btts;

/** v4 §0.3 (PR-4): maps a candidate's label to its `V3LineHitRates` key. Team
 *  Total 0.5 lines are deliberately absent — they have their own FTS%/CS%
 *  sample-scaled empirical weighting (PR-3), not an O/U hit-rate concept. */
const LINE_HIT_RATE_KEY: Record<string, keyof V3LineHitRates> = {
  "Over 1.5": "over15",
  "Over 2.5": "over25",
  "BTTS Yes": "btts",
};

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Limits text per penalty flag — exhaustive over V3PenaltyFlags so a flag
 *  that penalizes the edge can never silently skip the rationale. */
const LIMIT_TEXT: Record<keyof V3PenaltyFlags, string> = {
  xgMissing: "no xG",
  xgEstimated: "xG estimated (AI-Mode)",
  h2hMissing: "no H2H",
  lineupsUnconfirmed: "lineups unconfirmed",
  restEstimated: "rest estimated",
  smallSample: "<5 games sample",
  hfaDefaultUsed: "default HFA",
  hitRateMissing: "no hit-rate",
};

/** Build the one-line §6 rationale: market view vs price, with data limits. */
function buildRationale(
  label: string,
  a: V3EdgeAssessment,
  mp: number,
  flags: V3PenaltyFlags,
  sources: string[]
): string {
  const limits: string[] = [];
  for (const key of Object.keys(LIMIT_TEXT) as Array<keyof V3PenaltyFlags>) {
    if (flags[key]) limits.push(LIMIT_TEXT[key]);
  }
  const src = sources.length ? sources.join("+") : "sidecar";
  const lim = limits.length ? `; limits: ${limits.join(", ")}` : "";
  return (
    `${label}: model ${(mp * 100).toFixed(1)}% vs ${a.devigged ? "de-vigged" : "single-sided"} ` +
    `${(a.q * 100).toFixed(1)}% → adj edge ${(a.adjustedEdge * 100).toFixed(1)}pts ` +
    `(raw ${(a.rawEdge * 100).toFixed(1)}, −${(a.penaltyPts * 100).toFixed(0)} penalties). ` +
    `Sources: ${src}${lim}`
  );
}

interface Candidate {
  cat: string;
  label: string;
  odds: number;
  oppositeOdds?: number | null;
  mp: number;
}

/** Analyze one fixture through the full v3 deterministic pipeline. Returns null
 *  when no λ model can be built (should not happen behind the completeness
 *  gate, which requires season averages). */
export function analyzeGoalsFixtureV3(input: V3AnalyzeInput): V3FixtureResult | null {
  const lambdas = computeV3Lambdas(input.lambdaInput, {
    xgBlend: input.xgBlend,
    hfa: input.hfa,
    venueSplitUsed: input.venueSplitUsed,
    lambdaV5: input.lambdaV5,
  });
  if (!lambdas) return null;

  const rho = resolveRho(input.league, input.dynamicRho);
  const nb = v3NbDispersion(input.nbDispersion);

  // Raw-μ matrix: O/U totals (§3.2 exact tail, DC-corrected cells).
  const totalMat = buildMatrix(lambdas.lambdaHome, lambdas.lambdaAway, rho, false, 0.08, 0, nb);
  const totalBook = extractMarkets(totalMat);

  // Match-shape matrix: BTTS + team totals on the odds-consistent split (§3.5).
  const devigged1x2 = devigThreeWay(
    input.odds.home1x2 ?? undefined,
    input.odds.draw1x2 ?? undefined,
    input.odds.away1x2 ?? undefined
  );
  const shape = deriveMatchShape(
    lambdas.mu,
    lambdas.lambdaHome,
    devigged1x2 ? { pHome: devigged1x2[0], pDraw: devigged1x2[1], pAway: devigged1x2[2] } : null
  );
  const shapeMat = buildMatrix(shape.lambdaHome, shape.lambdaAway, rho, false, 0.08, 0, nb);
  const shapeBook = extractMarkets(shapeMat);

  const candidates: Candidate[] = [];
  const push = (
    cat: string,
    label: string,
    mp: number,
    odds: number | null | undefined,
    oppositeOdds?: number | null
  ): void => {
    if (odds && Number.isFinite(odds) && odds > 1) {
      candidates.push({ cat, label, odds, oppositeOdds, mp });
    }
  };
  push(
    GOALS_OU_LABEL,
    "Over 1.5",
    totalBook.ou["over_1.5"] ?? 0,
    input.odds.over15,
    input.odds.under15
  );
  push(
    GOALS_OU_LABEL,
    "Over 2.5",
    totalBook.ou["over_2.5"] ?? 0,
    input.odds.over25,
    input.odds.under25
  );
  push(
    TEAM_TOTAL_LABEL,
    "Home Total Over 0.5",
    shapeBook.teamH["over_0.5"] ?? 0,
    input.odds.homeTotalOver05
  );
  push(
    TEAM_TOTAL_LABEL,
    "Away Total Over 0.5",
    shapeBook.teamA["over_0.5"] ?? 0,
    input.odds.awayTotalOver05
  );
  push(BTTS_LABEL, "BTTS Yes", shapeBook.btts, input.odds.bttsYes, input.odds.bttsNo);

  const assessments: V3MarketAssessment[] = [];
  const capped: V3MarketAssessment[] = [];
  const evMarkets: V3EVMarket[] = [];
  for (const c of candidates) {
    const q = devigOU(c.odds, c.oppositeOdds);
    if (!q) continue;
    // v4 §0.3 (PR-4): a defined per-line entry overrides the fixture-wide
    // hitRateMissing flag for THIS candidate only — a fixture missing its O1.5
    // hit-rate but not its O2.5 one shouldn't penalize the O2.5 pick.
    const lineKey = LINE_HIT_RATE_KEY[c.label];
    const lineHasRate = lineKey ? input.lineHitRates?.[lineKey] : undefined;
    const flags: V3PenaltyFlags =
      lineHasRate === undefined
        ? input.penaltyFlags
        : { ...input.penaltyFlags, hitRateMissing: !lineHasRate };
    const gate = gateV3Edge(c.mp, q, flags, {
      edgeCap: input.edgeCap,
      noiseGate: input.noiseGate,
      heightened: input.heightened,
    });
    const rationale = buildRationale(c.label, gate, c.mp, flags, input.sources);
    const assessment: V3MarketAssessment = {
      ...gate,
      cat: c.cat,
      label: c.label,
      odds: c.odds,
      mp: round3(c.mp),
      rationale,
    };
    assessments.push(assessment);
    if (gate.outcome === "capped") capped.push(assessment);
    if (gate.outcome !== "done" || !gate.tier) continue;
    // §4.4 fallback-to-next-best is inherent: capped/noise/below-edge markets
    // simply never enter evMarkets, so selection picks among survivors.
    evMarkets.push({
      cat: c.cat,
      label: c.label,
      market: c.cat as EVMarket["market"],
      side: c.label,
      mp: c.mp,
      modelProb: c.mp,
      ip: gate.q,
      rawEdge: gate.rawEdge,
      ev: c.mp * c.odds - 1,
      odds: c.odds,
      stake: 0,
      stakeAmt: 0,
      rankingScore: gate.adjustedEdge,
      varianceMod: 1,
      v3: {
        rawEdge: gate.rawEdge,
        penaltyPts: gate.penaltyPts,
        adjustedEdge: gate.adjustedEdge,
        tier: gate.tier,
        q: gate.q,
        devigged: gate.devigged,
        rationale,
        sources: input.sources,
        completeness: input.completeness,
      },
    });
  }
  evMarkets.sort((a, b) => (b.v3?.adjustedEdge ?? 0) - (a.v3?.adjustedEdge ?? 0));

  const fp = { home: 0, draw: 0, away: 0 };
  const N = totalMat.length;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const p = totalMat[i]?.[j] ?? 0;
      if (i > j) fp.home += p;
      else if (i === j) fp.draw += p;
      else fp.away += p;
    }
  }

  const best = evMarkets[0] ?? null;
  const grade: ConfidenceGrade = best
    ? best.v3?.tier === "medium"
      ? "LEAN"
      : "STRONG"
    : "NO_EDGE";
  const result: RunResult = {
    fp,
    evMarkets,
    oddsAvailable: candidates.length > 0,
    bayesian_lH: lambdas.lambdaHome,
    bayesian_lA: lambdas.lambdaAway,
    expectedScoreline: `${Math.round(lambdas.lambdaHome)}-${Math.round(lambdas.lambdaAway)}`,
    portfolioCorrelation: null,
    correlatedParlayRisk: null,
    v3: {
      mu: lambdas.mu,
      method: lambdas.method,
      shrunk: lambdas.shrunk,
      xgBlended: lambdas.xgBlended,
      shapeS: shape.s,
      shapeSource: shape.source,
      completeness: input.completeness,
      cappedCount: capped.length,
    },
  };

  const job: FixtureJobSuccess = {
    status: "ok",
    analysisId: `v3:${input.fixtureId}`,
    runId: input.runId,
    fixtureId: input.fixtureId,
    home: input.home,
    away: input.away,
    league: input.league,
    kickoff: input.kickoff,
    result,
    decision: {
      primaryPick: best
        ? { market: best.market, side: best.label, odds: best.odds }
        : { market: "1x2", odds: 0 },
      confidence: best?.mp ?? 0,
      grade,
      rationale: best?.v3?.rationale ?? "no market cleared the v3 edge gate",
      rejectedAndWhy: assessments
        .filter((a) => a.outcome !== "done")
        .map((a) => `${a.label}: ${a.outcome} (raw ${(a.rawEdge * 100).toFixed(1)}pts)`),
    },
    decisionReplay: null,
    eligibleBets: evMarkets,
    primaryPick: best,
    llmEligible: true,
  };

  return { job, lambdas, shape, assessments, capped };
}
