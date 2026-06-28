/** Q5 — investigative backtest, NOT a unit test (no pass/fail assertion on the
 *  numbers below; see test/lowScoringBacktest.report.test.ts for the thin
 *  runner). Replays historical resolved fixtures through detectLowScoringRegime
 *  under a grid of threshold variants and reports actual Under-2.5/draw hit-rate
 *  per combination, so the 4 hardcoded constants in detectLowScoringRegime
 *  (packages/engine/src/math/index.ts) can be checked against real outcomes
 *  before anyone hand-tunes them further.
 *
 *  Reuses detectLowScoringRegime() itself to derive the 4 raw signals
 *  (expTotal/pUnder25/lowScoreMass/maxSide) per fixture — no metric is
 *  reimplemented here, only re-gated under different threshold combinations.
 *  The matrix is rebuilt from the persisted lambdaH/lambdaA via buildMatrix()
 *  at a fixed default rho (LEAGUE_PARAMS.Default.baseRho = -0.13), since the
 *  per-fixture realized rho the production ensemble used isn't persisted in
 *  AnalysisRecord — an approximation, but one that applies uniformly across
 *  every threshold combination, so relative comparisons between them stay valid
 *  even though the absolute classification carries some reconstruction error. */
import { buildMatrix, detectLowScoringRegime } from "../../src/math/index.js";
import type { AnalysisRecord, ResolutionRecord } from "../../src/types.js";

const DEFAULT_BACKTEST_RHO = -0.13;

export interface LowScoringThresholds {
  expTotalMax: number;
  pUnder25Min: number;
  lowScoreMassMin: number;
  maxSideMax: number;
}

/** The 4 constants exactly as hardcoded in detectLowScoringRegime today. */
export const CURRENT_THRESHOLDS: LowScoringThresholds = {
  expTotalMax: 2.35,
  pUnder25Min: 0.58,
  lowScoreMassMin: 0.34,
  maxSideMax: 0.52,
};

export interface JoinedRecord {
  analysis: AnalysisRecord;
  resolution: ResolutionRecord;
}

interface FixtureSignals {
  expTotal: number;
  pUnder25: number;
  lowScoreMass: number;
  maxSide: number;
  actualUnder25: boolean;
  actualDraw: boolean;
}

/** Joins analysis + resolution records on fixtureId — the only field guaranteed
 *  present on both (per types.ts's identity fields). */
export function joinRecords(
  analysisRecords: AnalysisRecord[],
  resolutionRecords: ResolutionRecord[]
): JoinedRecord[] {
  const byFixtureId = new Map(analysisRecords.map((a) => [a.fixtureId, a]));
  const joined: JoinedRecord[] = [];
  for (const resolution of resolutionRecords) {
    const analysis = byFixtureId.get(resolution.fixtureId);
    if (analysis) joined.push({ analysis, resolution });
  }
  return joined;
}

function deriveSignals(joined: JoinedRecord): FixtureSignals {
  const { analysis, resolution } = joined;
  const mat = buildMatrix(analysis.lambdaH, analysis.lambdaA, DEFAULT_BACKTEST_RHO);
  const regime = detectLowScoringRegime(mat, analysis.lambdaH, analysis.lambdaA);
  return {
    expTotal: regime.expTotal,
    pUnder25: regime.pUnder25,
    lowScoreMass: regime.lowScoreMass,
    maxSide: regime.maxSide,
    actualUnder25: resolution.homeGoals + resolution.awayGoals < 2.5,
    actualDraw: resolution.actualResult === "draw",
  };
}

function classifyLowScoring(s: FixtureSignals, t: LowScoringThresholds): boolean {
  return (
    s.expTotal < t.expTotalMax &&
    s.pUnder25 > t.pUnder25Min &&
    s.lowScoreMass > t.lowScoreMassMin &&
    s.maxSide < t.maxSideMax
  );
}

export interface ThresholdGridResult {
  thresholds: LowScoringThresholds;
  isCurrent: boolean;
  classifiedCount: number;
  under25HitRate: number | null;
  drawHitRate: number | null;
}

export interface BacktestReport {
  totalJoinedFixtures: number;
  /** Minimum classified-LOW_SCORING sample size before a grid row's hit-rate is
   *  treated as meaningful — mirrors this codebase's existing convention
   *  (isotonicCalibrateFp's own "no-op if <30 resolved" gate). */
  minSampleSize: number;
  hasSufficientData: boolean;
  grid: ThresholdGridResult[];
  /** Set only when a non-current combo clears minSampleSize AND beats the
   *  current thresholds' under25HitRate by recommendMarginPct or more. */
  recommendation: ThresholdGridResult | null;
}

const GRID_STEPS = {
  expTotalMax: [2.15, 2.35, 2.55],
  pUnder25Min: [0.5, 0.58, 0.65],
  lowScoreMassMin: [0.28, 0.34, 0.4],
  maxSideMax: [0.48, 0.52, 0.56],
};

function buildGrid(): LowScoringThresholds[] {
  const grid: LowScoringThresholds[] = [];
  for (const expTotalMax of GRID_STEPS.expTotalMax) {
    for (const pUnder25Min of GRID_STEPS.pUnder25Min) {
      for (const lowScoreMassMin of GRID_STEPS.lowScoreMassMin) {
        for (const maxSideMax of GRID_STEPS.maxSideMax) {
          grid.push({ expTotalMax, pUnder25Min, lowScoreMassMin, maxSideMax });
        }
      }
    }
  }
  return grid;
}

function isCurrentCombo(t: LowScoringThresholds): boolean {
  return (
    t.expTotalMax === CURRENT_THRESHOLDS.expTotalMax &&
    t.pUnder25Min === CURRENT_THRESHOLDS.pUnder25Min &&
    t.lowScoreMassMin === CURRENT_THRESHOLDS.lowScoreMassMin &&
    t.maxSideMax === CURRENT_THRESHOLDS.maxSideMax
  );
}

/** Runs the full grid backtest over already-joined historical records.
 *  minSampleSize defaults to 30 (this codebase's existing minimum-sample
 *  convention) — below that, hasSufficientData is false and recommendation
 *  is always null regardless of what the numbers say, per the owner
 *  instruction: only change the hardcoded constants on clear evidence,
 *  otherwise document as already well-calibrated and close the item. */
export function runBacktest(
  joined: JoinedRecord[],
  opts: { minSampleSize?: number; recommendMarginPct?: number } = {}
): BacktestReport {
  const minSampleSize = opts.minSampleSize ?? 30;
  const recommendMarginPct = opts.recommendMarginPct ?? 0.03;

  const signals = joined.map(deriveSignals);
  const grid = buildGrid();
  if (!grid.some(isCurrentCombo)) grid.push({ ...CURRENT_THRESHOLDS });

  const results: ThresholdGridResult[] = grid.map((thresholds) => {
    const classified = signals.filter((s) => classifyLowScoring(s, thresholds));
    const n = classified.length;
    const under25HitRate = n ? classified.filter((s) => s.actualUnder25).length / n : null;
    const drawHitRate = n ? classified.filter((s) => s.actualDraw).length / n : null;
    return {
      thresholds,
      isCurrent: isCurrentCombo(thresholds),
      classifiedCount: n,
      under25HitRate,
      drawHitRate,
    };
  });

  const current = results.find((r) => r.isCurrent) ?? null;
  const hasSufficientData = (current?.classifiedCount ?? 0) >= minSampleSize;

  let recommendation: ThresholdGridResult | null = null;
  if (hasSufficientData && current?.under25HitRate != null) {
    const candidates = results.filter(
      (r) =>
        !r.isCurrent &&
        r.classifiedCount >= minSampleSize &&
        r.under25HitRate != null &&
        r.under25HitRate - current.under25HitRate! >= recommendMarginPct
    );
    candidates.sort((a, b) => (b.under25HitRate ?? 0) - (a.under25HitRate ?? 0));
    recommendation = candidates[0] ?? null;
  }

  return {
    totalJoinedFixtures: joined.length,
    minSampleSize,
    hasSufficientData,
    grid: results,
    recommendation,
  };
}

/** Plain-text summary for console output — top 5 rows by under25HitRate
 *  (min sample size met), the current thresholds' own row, and the verdict. */
export function formatBacktestReport(report: BacktestReport): string {
  const lines: string[] = [];
  lines.push(
    `Joined fixtures (analysis + resolution, matched on fixtureId): ${report.totalJoinedFixtures}`
  );
  lines.push(`Minimum sample size per combo to trust its hit-rate: ${report.minSampleSize}`);

  const current = report.grid.find((r) => r.isCurrent);
  if (current) {
    lines.push(
      `Current thresholds: n=${current.classifiedCount}, Under2.5 hit-rate=${
        current.under25HitRate != null ? (current.under25HitRate * 100).toFixed(1) + "%" : "n/a"
      }, Draw hit-rate=${current.drawHitRate != null ? (current.drawHitRate * 100).toFixed(1) + "%" : "n/a"}`
    );
  }

  if (!report.hasSufficientData) {
    lines.push(
      `INSUFFICIENT DATA — current thresholds' classified sample (${current?.classifiedCount ?? 0}) is below the ${report.minSampleSize} minimum. No threshold change recommended; document as already well-calibrated per the existing Poisson/DC research validation and close this item until more resolved fixtures accumulate.`
    );
    return lines.join("\n");
  }

  if (report.recommendation) {
    const r = report.recommendation;
    lines.push(
      `RECOMMENDATION: thresholds ${JSON.stringify(r.thresholds)} clear the current combo's Under2.5 hit-rate by >=3pp at n=${r.classifiedCount} (${((r.under25HitRate ?? 0) * 100).toFixed(1)}%). Consider adopting.`
    );
  } else {
    lines.push(
      "No alternate combination clears the current thresholds' hit-rate by a meaningful margin — current thresholds are already well-calibrated. No change recommended."
    );
  }

  return lines.join("\n");
}
