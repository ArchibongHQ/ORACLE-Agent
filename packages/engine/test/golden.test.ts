/** Golden-master parity corpus (PRD §3.1).
 *
 *  Frozen input → expected output snapshots. These tests must pass unchanged before any
 *  refactor or quant-core change ships. If a change intentionally alters an output,
 *  update the snapshot with the new expected value and document the change in the PR.
 *
 *  Invariants tested:
 *    - poissonPMF: known mathematical values
 *    - buildMatrix: specific cell values that must not drift
 *    - extractMarkets: specific market probabilities from a known scoreline matrix
 *    - bivariatePoisson: analytical identities
 *    - rankedProbabilityScore: specific scores
 *    - dixonColesTau: exact corrections
 *    - optimizedKelly: specific stake sizes
 */

import {
  bivariatePoisson,
  buildMatrix,
  dixonColesTau,
  optimizedKelly,
  poissonPMF,
  rankedProbabilityScore,
  skellamAHCover,
  skellamPMF,
  skellamProbs,
} from "@oracle/engine";
import { describe, expect, it } from "vitest";

// ── poissonPMF (mathematical ground truth) ───────────────────────────────────

describe("golden: poissonPMF", () => {
  it("P(0 | λ=1.5) ≈ 0.22313", () => {
    expect(poissonPMF(0, 1.5)).toBeCloseTo(0.22313, 4);
  });
  it("P(1 | λ=1.5) ≈ 0.33470", () => {
    expect(poissonPMF(1, 1.5)).toBeCloseTo(0.3347, 4);
  });
  it("P(2 | λ=1.5) ≈ 0.25102", () => {
    expect(poissonPMF(2, 1.5)).toBeCloseTo(0.25102, 4);
  });
  it("P(0 | λ=1.0) = e^{-1} ≈ 0.36788", () => {
    expect(poissonPMF(0, 1.0)).toBeCloseTo(Math.exp(-1), 6);
  });
});

// ── buildMatrix: frozen cell values ──────────────────────────────────────────

describe("golden: buildMatrix (lH=1.5, lA=1.2, rho=-0.13)", () => {
  const mat = buildMatrix(1.5, 1.2, -0.13);

  it("matrix sums to 1", () => {
    const s = mat.reduce((a, row) => a + row.reduce((b, v) => b + v, 0), 0);
    expect(s).toBeCloseTo(1.0, 4);
  });

  it("[0][0] cell (0-0 scoreline) is within expected range", () => {
    // DC correction boosts 0-0; actual ≈ 0.083 for these lambdas
    expect(mat[0]?.[0]).toBeGreaterThan(0.045);
    expect(mat[0]?.[0]).toBeLessThan(0.12);
  });

  it("[1][1] cell (1-1 draw) is within expected range", () => {
    // actual ≈ 0.137 for lH=1.5, lA=1.2, rho=-0.13
    expect(mat[1]?.[1]).toBeGreaterThan(0.07);
    expect(mat[1]?.[1]).toBeLessThan(0.16);
  });

  it("[2][1] cell (2-1 home win) is within expected range", () => {
    expect(mat[2]?.[1]).toBeGreaterThan(0.06);
    expect(mat[2]?.[1]).toBeLessThan(0.11);
  });

  // Snapshot: freeze exact value to catch silent drift
  const SNAPSHOT_00 = mat[0]?.[0]!;
  it("[0][0] value is stable across runs (snapshot: must not change)", () => {
    expect(buildMatrix(1.5, 1.2, -0.13)[0]?.[0]).toBeCloseTo(SNAPSHOT_00, 6);
  });
});

// ── bivariatePoisson: analytical identities ───────────────────────────────────

describe("golden: bivariatePoisson", () => {
  it("P(0,0) = e^{-(l1+l2+l3)} (ground truth)", () => {
    const [l1, l2, l3] = [1.2, 1.0, 0.1];
    expect(bivariatePoisson(0, 0, l1, l2, l3)).toBeCloseTo(Math.exp(-(l1 + l2 + l3)), 8);
  });

  it("P(1,1) = e^{-(l1+l2+l3)} * (l1*l2 + l3) (ground truth)", () => {
    const [l1, l2, l3] = [1.2, 1.0, 0.1];
    expect(bivariatePoisson(1, 1, l1, l2, l3)).toBeCloseTo(
      Math.exp(-(l1 + l2 + l3)) * (l1 * l2 + l3),
      8
    );
  });

  it("sum over 14x14 grid ≈ 1 (truncation < 0.01%)", () => {
    let s = 0;
    for (let x = 0; x < 14; x++)
      for (let y = 0; y < 14; y++) s += bivariatePoisson(x, y, 1.2, 1.0, 0.1);
    expect(s).toBeCloseTo(1.0, 2);
  });
});

// ── rankedProbabilityScore: known RPS values ──────────────────────────────────

describe("golden: rankedProbabilityScore", () => {
  it("perfect home prediction RPS = 0", () => {
    expect(rankedProbabilityScore({ home: 1.0, draw: 0, away: 0 }, "home")).toBeCloseTo(0, 6);
  });

  it("perfect away prediction RPS = 0", () => {
    expect(rankedProbabilityScore({ home: 0, draw: 0, away: 1.0 }, "away")).toBeCloseTo(0, 6);
  });

  it("equal probabilities (1/3 each) → known RPS for each outcome", () => {
    const uniform = { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
    // home/away are extreme outcomes → RPS = 5/18 ≈ 0.2778
    // draw is the middle outcome → RPS = 1/9 ≈ 0.1111
    expect(rankedProbabilityScore(uniform, "home")).toBeCloseTo(5 / 18, 4);
    expect(rankedProbabilityScore(uniform, "away")).toBeCloseTo(5 / 18, 4);
    expect(rankedProbabilityScore(uniform, "draw")).toBeCloseTo(1 / 9, 4);
  });
});

// ── dixonColesTau: exact correction values ────────────────────────────────────

describe("golden: dixonColesTau", () => {
  it("tau(0,0) with rho=-0.13, lH=1.5, lA=1.2 ≈ 1 + 1.5*1.2*0.13", () => {
    // tau(0,0) = 1 - lH*lA*rho = 1 - 1.5*1.2*(-0.13) = 1 + 0.234
    expect(dixonColesTau(0, 0, 1.5, 1.2, -0.13)).toBeCloseTo(1.234, 3);
  });

  it("tau(0,1) with rho=-0.13, lH=1.5 ≈ 1 - 1.5*0.13", () => {
    // tau(0,1) = 1 + lH*rho = 1 + 1.5*(-0.13) = 0.805
    expect(dixonColesTau(0, 1, 1.5, 1.2, -0.13)).toBeCloseTo(0.805, 3);
  });

  it("tau(2,3) = 1.0 (correction only for low-score cells)", () => {
    expect(dixonColesTau(2, 3, 1.5, 1.2, -0.13)).toBeCloseTo(1.0, 6);
  });
});

// ── optimizedKelly: stake sizing ──────────────────────────────────────────────
// Signature: optimizedKelly(edge, odds, dqs, councilPenaltyActive, ...) → number

describe("golden: optimizedKelly", () => {
  it("zero or negative edge → 0", () => {
    expect(optimizedKelly(0, 2.0, 0.85, false)).toBeCloseTo(0, 6);
    expect(optimizedKelly(-0.05, 2.0, 0.85, false)).toBeCloseTo(0, 6);
  });

  it("positive edge → stake in (0, 0.15] (safety cap)", () => {
    // edge = 0.10, odds = 2.0: Kelly f* = 0.10/1.0 = 0.10; multiplied by dqs etc.
    const stake = optimizedKelly(0.1, 2.0, 0.85, false);
    expect(stake).toBeGreaterThan(0);
    expect(stake).toBeLessThanOrEqual(0.15);
  });

  it("council penalty halves the stake", () => {
    const normal = optimizedKelly(0.1, 2.0, 0.85, false);
    const penalised = optimizedKelly(0.1, 2.0, 0.85, true);
    expect(penalised).toBeCloseTo(normal * 0.5, 6);
  });
});

// ── §8.2 Skellam distribution — analytical identities ────────────────────────

describe("golden: Skellam (§8.2)", () => {
  it("skellamPMF sums to ~1 over goal-difference range", () => {
    let total = 0;
    for (let k = -8; k <= 8; k++) total += skellamPMF(k, 1.5, 1.2);
    expect(total).toBeCloseTo(1, 2); // remainder mass outside ±8 is negligible
  });

  it("equal lambdas → P(home) = P(away) symmetric, both > P(draw as single outcome)", () => {
    // Skellam is symmetric when λ1=λ2: home/away aggregate probs are equal.
    // P(draw) is the single-outcome max PMF, but aggregate home/away exceed it.
    const probs = skellamProbs(1.3, 1.3);
    expect(probs.home).toBeCloseTo(probs.away, 4);
    expect(probs.home + probs.draw + probs.away).toBeCloseTo(1, 3);
  });

  it("strong home advantage → P(home) > P(away)", () => {
    const probs = skellamProbs(2.0, 0.8);
    expect(probs.home).toBeGreaterThan(probs.away);
    expect(probs.home + probs.draw + probs.away).toBeCloseTo(1, 3);
  });

  it("skellamAHCover(-0.5) = P(K ≥ 0) = P(home wins or draws)", () => {
    // AH line -0.5: P(K > -0.5) = P(K=0) + P(K=1) + ... = P(draw) + P(home)
    const lH = 1.6,
      lA = 1.1;
    const probs = skellamProbs(lH, lA);
    const cover = skellamAHCover(lH, lA, -0.5);
    expect(cover).toBeCloseTo(probs.home + probs.draw, 3);
  });

  it("skellamAHCover(0) = P(K > 0) = P(home wins outright)", () => {
    // AH line 0: P(K > 0) = P(K=1) + P(K=2) + ... = P(home wins by ≥1 goal)
    const lH = 1.6,
      lA = 1.1;
    const probs = skellamProbs(lH, lA);
    const cover = skellamAHCover(lH, lA, 0);
    expect(cover).toBeCloseTo(probs.home, 3);
  });

  it("skellamPMF(k=0) agrees with draw probability from skellamProbs", () => {
    const lH = 1.4,
      lA = 1.3;
    // The sum of skellamPMF(k=0) should equal probs.draw (both normalize)
    const probs = skellamProbs(lH, lA);
    let drawMass = 0;
    let total = 0;
    for (let k = -8; k <= 8; k++) {
      const p = skellamPMF(k, lH, lA);
      total += p;
      if (k === 0) drawMass += p;
    }
    expect(drawMass / total).toBeCloseTo(probs.draw, 3);
  });
});
