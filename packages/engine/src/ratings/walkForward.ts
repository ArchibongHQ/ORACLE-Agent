/** Wave 2 WS2-B — walk-forward validation harness for the pi-ratings λ blend.
 *
 *  Purpose: prove, on a set of resolved historical fixtures, whether adding
 *  the pi-ratings blend (goalsV3/lambda.ts's `opts.ratingsBlend`) actually
 *  improves forecast quality over the existing goals+xG-only baseline — the
 *  gate `buildRatingsLambdaInput`'s header requires before a caller may ever
 *  flip `ORACLE_V3_RATINGS` out of "shadow" and pass `opts.ratingsBlend: true`
 *  in production.
 *
 *  Method: RPS (ranked probability score, `math/index.ts`'s
 *  `rankedProbabilityScore` — lower is better) per fixture for the baseline
 *  1X2 forecast vs. the candidate (ratings-blended) 1X2 forecast, then
 *  `calibration/index.ts`'s `significanceAcceptGate` bootstrap-tests whether
 *  the candidate's mean RPS is reliably lower than the baseline's — minN=300,
 *  effectSizeFloor=0.002 by default (the "+0.002 RPS bar"), entire 95%
 *  bootstrap CI must sit on the improvement side. This module does not
 *  reimplement either — it only orchestrates them over paired forecasts.
 *
 *  This harness takes pre-computed forecast pairs, not raw fixtures — it has
 *  no opinion on how a caller produced the baseline/candidate forecasts (that
 *  is Wave 3's job: run computeV3Lambdas twice per historical fixture, once
 *  with opts.ratingsBlend false and once true, turn each into a 1X2 forecast,
 *  and pass the pairs here). Keeping this layer forecast-in/verdict-out is
 *  what makes it usable both for a real backtest AND for the synthetic-data
 *  self-tests in ratingsWalkForward.test.ts that prove the accept/reject
 *  logic itself is wired correctly (no real historical data is available in
 *  this sandbox to prove real ratings data clears the bar — that is a
 *  separate, later step, not this module's job). */

import {
  type SignificanceGateOptions,
  type SignificanceGateResult,
  significanceAcceptGate,
} from "../calibration/index.js";
import { type Forecast, type Outcome, rankedProbabilityScore } from "../math/index.js";

export interface RatingsWalkForwardFixture {
  /** 1X2 forecast produced WITHOUT the pi-ratings blend (opts.ratingsBlend
   *  false/omitted) — today's live behavior. */
  baselineForecast: Forecast;
  /** 1X2 forecast produced WITH the pi-ratings blend (opts.ratingsBlend
   *  true) — the candidate under test. */
  candidateForecast: Forecast;
  /** Actual resolved outcome for this historical fixture. */
  outcome: Outcome | Forecast;
}

export interface RatingsWalkForwardResult {
  /** significanceAcceptGate's verdict — `accept: true` iff the candidate
   *  (ratings-blended) forecasts clear the RPS improvement bar. */
  gate: SignificanceGateResult;
  /** Per-fixture RPS for the baseline forecast, same order as the input. */
  baselineRps: number[];
  /** Per-fixture RPS for the candidate forecast, same order as the input. */
  candidateRps: number[];
}

/** Runs the walk-forward RPS comparison + significance gate over a set of
 *  paired historical forecasts. Reuses `rankedProbabilityScore` and
 *  `significanceAcceptGate` verbatim — this function's only job is wiring
 *  them together correctly (RPS is a "lower is better" metric, which is
 *  exactly the orientation `significanceAcceptGate` expects: it accepts when
 *  candidate's mean is reliably BELOW baseline's). */
export function runRatingsWalkForward(
  fixtures: RatingsWalkForwardFixture[],
  options: SignificanceGateOptions = {}
): RatingsWalkForwardResult {
  const baselineRps = fixtures.map((f) => rankedProbabilityScore(f.baselineForecast, f.outcome));
  const candidateRps = fixtures.map((f) => rankedProbabilityScore(f.candidateForecast, f.outcome));
  const gate = significanceAcceptGate(baselineRps, candidateRps, options);
  return { gate, baselineRps, candidateRps };
}
