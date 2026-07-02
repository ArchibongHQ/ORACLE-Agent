/** all-markets-analysis-prompt-v3 P7 — §3.9 conditional modules (corners NB,
 *  cards Poisson). Dormant unless both odds and stats exist. */

import {
  CORNERS_R_DEFAULT,
  CORNERS_R_MAX,
  CORNERS_R_MIN,
  cardsMeans,
  clampCornersDispersion,
  cornersMeans,
  nbCDF,
  nbPMF,
  nbTailOver,
  nbTailUnder,
  priceCardsOutcome,
  priceCornersOutcome,
} from "@oracle/engine";
import { describe, expect, it } from "vitest";

describe("clampCornersDispersion", () => {
  it("defaults to 10 when absent", () => {
    expect(clampCornersDispersion()).toBe(CORNERS_R_DEFAULT);
    expect(clampCornersDispersion(undefined)).toBe(CORNERS_R_DEFAULT);
    expect(clampCornersDispersion(Number.NaN)).toBe(CORNERS_R_DEFAULT);
  });
  it("clamps to [8,12] per spec", () => {
    expect(clampCornersDispersion(2)).toBe(CORNERS_R_MIN);
    expect(clampCornersDispersion(50)).toBe(CORNERS_R_MAX);
    expect(clampCornersDispersion(9)).toBe(9);
  });
});

describe("Negative Binomial math (nbPMF/nbCDF)", () => {
  it("PMF sums to ~1 across a wide k range", () => {
    let total = 0;
    for (let k = 0; k < 60; k++) total += nbPMF(k, 10, 10);
    expect(total).toBeCloseTo(1, 3);
  });

  it("the distribution's own mean (Σ k·PMF(k)) matches the input mean", () => {
    let mean = 0;
    for (let k = 0; k < 80; k++) mean += k * nbPMF(k, 10.5, 10);
    expect(mean).toBeCloseTo(10.5, 1);
  });

  it("nbCDF(k) approaches 1 as k grows and is monotonic", () => {
    const c10 = nbCDF(10, 10, 10);
    const c30 = nbCDF(30, 10, 10);
    expect(c30).toBeGreaterThan(c10);
    expect(c30).toBeCloseTo(1, 3);
  });

  it("nbTailOver + nbTailUnder sum to 1 at a half line", () => {
    const over = nbTailOver(9.5, 10, 10);
    const under = nbTailUnder(9.5, 10, 10);
    expect(over + under).toBeCloseTo(1, 6);
  });

  it("a higher mean shifts more mass above a fixed line", () => {
    const lowMean = nbTailOver(9.5, 8, 10);
    const highMean = nbTailOver(9.5, 12, 10);
    expect(highMean).toBeGreaterThan(lowMean);
  });

  it("higher dispersion r (less overdispersion) tightens the distribution around the mean", () => {
    // At the same mean, a higher r means variance (mean + mean²/r) is lower,
    // so P(Over line) close to the mean should sit nearer 50% either way but
    // the TAIL further out should shrink as r grows.
    const farLine = 20; // well above mean=10
    const wideTail = nbTailOver(farLine, 10, CORNERS_R_MIN); // more overdispersion
    const tightTail = nbTailOver(farLine, 10, CORNERS_R_MAX); // less overdispersion
    expect(wideTail).toBeGreaterThan(tightTail);
  });
});

describe("cornersMeans (dormancy + blending)", () => {
  it("is dormant (null) when a side has no signal at all", () => {
    expect(cornersMeans({ cornersForH: 5.5 })).toBeNull(); // away side totally dark
  });

  it("blends corners-for with the opponent's corners-against when both exist", () => {
    const means = cornersMeans({
      cornersForH: 6.0,
      cornersAgainstA: 5.0, // away concedes 5.0 corners/game on average
      cornersForA: 4.5,
      cornersAgainstH: 5.5,
    });
    expect(means).not.toBeNull();
    expect(means!.home).toBeCloseTo((6.0 + 5.0) / 2, 5);
    expect(means!.away).toBeCloseTo((4.5 + 5.5) / 2, 5);
    expect(means!.total).toBeCloseTo(means!.home + means!.away, 10);
    expect(means!.r).toBe(CORNERS_R_DEFAULT);
  });

  it("falls back to the single available signal per side (no blend needed)", () => {
    const means = cornersMeans({ cornersForH: 6.0, cornersForA: 4.5 });
    expect(means).toEqual({ home: 6.0, away: 4.5, total: 10.5, r: CORNERS_R_DEFAULT });
  });

  it("respects a supplied dispersion, clamped", () => {
    const means = cornersMeans({ cornersForH: 5, cornersForA: 5, dispersion: 20 });
    expect(means!.r).toBe(CORNERS_R_MAX);
  });
});

describe("priceCornersOutcome", () => {
  it("prices a match-total Over/Under half line", () => {
    const means = cornersMeans({ cornersForH: 6, cornersForA: 4.5 })!;
    const over = priceCornersOutcome(means, "Over 9.5");
    const under = priceCornersOutcome(means, "Under 9.5");
    expect(over).not.toBeNull();
    expect(over! + under!).toBeCloseTo(1, 6);
  });

  it("prices a team-total line off the correct side's mean", () => {
    const means = cornersMeans({ cornersForH: 8, cornersForA: 3 })!; // lopsided
    const homeOver = priceCornersOutcome(means, "Over 2.5", "home")!;
    const awayOver = priceCornersOutcome(means, "Over 2.5", "away")!;
    expect(homeOver).toBeGreaterThan(awayOver);
  });

  it("returns null for an unparseable description", () => {
    const means = cornersMeans({ cornersForH: 6, cornersForA: 4.5 })!;
    expect(priceCornersOutcome(means, "Yes")).toBeNull();
  });
});

describe("cardsMeans (dormancy)", () => {
  it("is dormant when either side's cards average is missing", () => {
    expect(cardsMeans({ cardsAvgH: 2.1 })).toBeNull();
    expect(cardsMeans({})).toBeNull();
  });

  it("sums both sides for the match total", () => {
    const means = cardsMeans({ cardsAvgH: 2.1, cardsAvgA: 1.8 });
    expect(means?.home).toBe(2.1);
    expect(means?.away).toBe(1.8);
    expect(means?.total).toBeCloseTo(3.9, 10);
  });
});

describe("priceCardsOutcome", () => {
  it("prices the priority U5.5 match-cards line", () => {
    const means = cardsMeans({ cardsAvgH: 2.0, cardsAvgA: 2.0 })!; // total mean 4.0
    const under = priceCardsOutcome(means, "Under 5.5")!;
    const over = priceCardsOutcome(means, "Over 5.5")!;
    expect(under).toBeGreaterThan(0.5); // mean 4.0 well under a 5.5 line
    expect(over + under).toBeCloseTo(1, 6);
  });

  it("prices a team-side cards total", () => {
    const means = cardsMeans({ cardsAvgH: 3.0, cardsAvgA: 1.0 })!;
    const homeOver = priceCardsOutcome(means, "Over 1.5", "home")!;
    const awayOver = priceCardsOutcome(means, "Over 1.5", "away")!;
    expect(homeOver).toBeGreaterThan(awayOver);
  });
});
