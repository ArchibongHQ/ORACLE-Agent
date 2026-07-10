/** ratings/walkForward.ts — walk-forward RPS/significance harness (Wave 2
 *  WS2-B). No real historical data is available in this sandbox, so these
 *  tests prove the HARNESS itself correctly implements the accept/reject
 *  logic against synthetic data with a KNOWN margin — not that real
 *  pi-ratings data clears the bar (that's a later, data-dependent step). */

import type { Outcome, RatingsWalkForwardFixture } from "@oracle/engine";
import {
  rankedProbabilityScore,
  runRatingsWalkForward,
  significanceAcceptGate,
} from "@oracle/engine";
import { describe, expect, it } from "vitest";

const OUTCOMES: Outcome[] = ["home", "draw", "away"];

/** Deterministic synthetic set: N fixtures, evenly cycling through
 *  home/draw/away as the actual outcome. `candidateBias` controls how much
 *  more probability the candidate forecast assigns to the true outcome
 *  relative to a flat baseline — 0 means candidate === baseline (no signal),
 *  a positive value means the candidate is measurably better calibrated. */
function syntheticFixtures(n: number, candidateBias: number): RatingsWalkForwardFixture[] {
  const fixtures: RatingsWalkForwardFixture[] = [];
  for (let i = 0; i < n; i++) {
    const outcome = OUTCOMES[i % 3]!;
    const baselineForecast = { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
    const others = OUTCOMES.filter((o) => o !== outcome);
    const candidateForecast = {
      [outcome]: 1 / 3 + candidateBias,
      [others[0]!]: 1 / 3 - candidateBias / 2,
      [others[1]!]: 1 / 3 - candidateBias / 2,
    };
    fixtures.push({ baselineForecast, candidateForecast, outcome });
  }
  return fixtures;
}

describe("runRatingsWalkForward (Wave 2 WS2-B harness)", () => {
  it("computes baselineRps/candidateRps via rankedProbabilityScore, same length/order as input", () => {
    const fixtures = syntheticFixtures(400, 0.25);
    const result = runRatingsWalkForward(fixtures, { minN: 300, nBootstrap: 100 });
    expect(result.baselineRps).toHaveLength(400);
    expect(result.candidateRps).toHaveLength(400);
    // Spot-check a couple of entries against calling rankedProbabilityScore directly.
    expect(result.baselineRps[0]).toBe(
      rankedProbabilityScore(fixtures[0]!.baselineForecast, fixtures[0]!.outcome)
    );
    expect(result.candidateRps[7]).toBe(
      rankedProbabilityScore(fixtures[7]!.candidateForecast, fixtures[7]!.outcome)
    );
  });

  it("ACCEPTS when the candidate reliably beats the baseline by a known, well-above-floor margin", () => {
    // Every fixture's candidate forecast is closer to the true outcome than
    // the flat baseline by a fixed amount — this must clear both the
    // effect-size floor (0.002) and the bootstrap-CI significance test
    // deterministically (the improvement is uniform across fixtures, so the
    // bootstrap CI collapses to a point at the true delta, which is
    // decisively negative for RPS).
    const fixtures = syntheticFixtures(400, 0.25);
    const result = runRatingsWalkForward(fixtures, { minN: 300, nBootstrap: 200 });
    expect(result.gate.accept).toBe(true);
    expect(result.gate.delta).toBeLessThan(0); // RPS: lower = better = negative delta
    expect(result.gate.effectSize).toBeGreaterThan(0.002);
    expect(result.gate.n).toBe(400);
  });

  it("REJECTS when the candidate is identical to the baseline (zero true signal, below effect-size floor)", () => {
    const fixtures = syntheticFixtures(400, 0); // candidate === baseline
    const result = runRatingsWalkForward(fixtures, { minN: 300, nBootstrap: 100 });
    expect(result.gate.accept).toBe(false);
    expect(result.gate.reason).toMatch(/BELOW_EFFECT_SIZE_FLOOR/);
    expect(result.gate.delta).toBe(0);
  });

  it("REJECTS below minN even with a large, otherwise-qualifying improvement margin", () => {
    const fixtures = syntheticFixtures(50, 0.25); // well below default minN=300
    const result = runRatingsWalkForward(fixtures, { nBootstrap: 100 });
    expect(result.gate.accept).toBe(false);
    expect(result.gate.reason).toMatch(/INSUFFICIENT_SAMPLES/);
    expect(result.gate.n).toBe(50);
  });

  it("wires straight through to significanceAcceptGate — same verdict as calling it directly on the RPS arrays", () => {
    const fixtures = syntheticFixtures(400, 0.25);
    const options = { minN: 300, nBootstrap: 150 };
    const result = runRatingsWalkForward(fixtures, options);
    const direct = significanceAcceptGate(result.baselineRps, result.candidateRps, options);
    expect(result.gate.accept).toBe(direct.accept);
    expect(result.gate.delta).toBeCloseTo(direct.delta, 10);
  });
});
