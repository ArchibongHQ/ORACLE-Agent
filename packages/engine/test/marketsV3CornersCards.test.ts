/** all-markets-analysis-prompt-v3 P7 — §3.9 conditional modules (corners NB,
 *  cards Poisson). Dormant unless both odds and stats exist. */

import {
  buildCardsGrid,
  buildCornersGrid,
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
  priceCardsLikeHandicap,
  priceCardsLikeRange,
  priceCardsOutcome,
  priceCardsVariant,
  priceCornersLikeHandicap,
  priceCornersLikeRange,
  priceCornersOutcome,
  priceCornersVariant,
  priceShotsOutcome,
  routeMarket,
  shotsMeans,
  sumWhere,
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

  it("a zero (or negative) mean prices near-certain UNDER, not OVER (review-caught bug)", () => {
    // Before the fix, nbPMF(k, 0, r) returned 0 for every k (including k=0),
    // so nbCDF stayed 0 forever and nbTailOver(line, 0, r) came back ~1 — a
    // team truly averaging 0 corners/shots priced as near-certain OVER any
    // line instead of near-certain UNDER. Mean is now floored at 0.01 (same
    // convention as math/index.ts's poissonPMF), so P(X=0) dominates instead.
    expect(nbPMF(0, 0, 10)).toBeGreaterThan(0.9);
    expect(nbCDF(0, 0, 10)).toBeGreaterThan(0.9);
    expect(nbTailOver(0.5, 0, 10)).toBeLessThan(0.1);
    expect(nbTailUnder(0.5, 0, 10)).toBeGreaterThan(0.9);
    // Negative mean (shouldn't occur upstream, but the guard must not invert either).
    expect(nbTailUnder(0.5, -1, 10)).toBeGreaterThan(0.9);
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

// ── PR-22: joint grids + 1X2/handicap/range/odd-even variants ──────────────

describe("buildCornersGrid / buildCardsGrid (golden: marginals sum to ~1)", () => {
  it("corners grid sums to ~1 across the whole surface (independence: home marginal × away marginal)", () => {
    const means = cornersMeans({ cornersForH: 6, cornersForA: 4.5 })!;
    const grid = buildCornersGrid(means);
    const total = sumWhere(grid, () => true);
    expect(total).toBeCloseTo(1, 6);
  });

  it("cards grid sums to ~1", () => {
    const means = cardsMeans({ cardsAvgH: 2.0, cardsAvgA: 1.8 })!;
    const grid = buildCardsGrid(means);
    const total = sumWhere(grid, () => true);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe("corners/cards 1X2 (priceCornersVariant/priceCardsVariant)", () => {
  it("corners 1X2 home/draw/away sums to ~1", () => {
    const means = cornersMeans({ cornersForH: 6, cornersForA: 4.5 })!;
    const home = priceCornersVariant(means, "home", "1x2")!;
    const draw = priceCornersVariant(means, "draw", "1x2")!;
    const away = priceCornersVariant(means, "away", "1x2")!;
    expect(home + draw + away).toBeCloseTo(1, 5);
  });

  it("corners 1X2 favors the side with the higher mean", () => {
    const means = cornersMeans({ cornersForH: 8, cornersForA: 3 })!; // lopsided home
    const home = priceCornersVariant(means, "home", "1x2")!;
    const away = priceCornersVariant(means, "away", "1x2")!;
    expect(home).toBeGreaterThan(away);
  });

  it("cards 1X2 sums to ~1", () => {
    const means = cardsMeans({ cardsAvgH: 2.0, cardsAvgA: 1.8 })!;
    const home = priceCardsVariant(means, "home", "1x2")!;
    const draw = priceCardsVariant(means, "draw", "1x2")!;
    const away = priceCardsVariant(means, "away", "1x2")!;
    expect(home + draw + away).toBeCloseTo(1, 5);
  });

  it("returns null for an unrecognised 1X2 desc", () => {
    const means = cornersMeans({ cornersForH: 6, cornersForA: 4.5 })!;
    expect(priceCornersVariant(means, "maybe", "1x2")).toBeNull();
  });
});

describe("corners/cards handicap (push case + both desc formats)", () => {
  it("a whole-line handicap's win + push + (implied) loss covers the full grid — verify via the raw grid, not just the conditional price", () => {
    const means = cornersMeans({ cornersForH: 6, cornersForA: 6 })!; // symmetric
    const grid = buildCornersGrid(means);
    // Home (-0) i.e. pk: win iff home>away, push iff equal.
    const pWin = sumWhere(grid, (h, a) => h - a > 0);
    const pPush = sumWhere(grid, (h, a) => h - a === 0);
    const pLoss = sumWhere(grid, (h, a) => h - a < 0);
    expect(pWin + pPush + pLoss).toBeCloseTo(1, 5);
    // Symmetric means ⇒ win and loss mass should be equal (draw/push is the
    // only asymmetry-free split point).
    expect(pWin).toBeCloseTo(pLoss, 5);

    const priced = priceCornersLikeHandicap(grid, "home (-0)");
    // Conditional price = pWin / (1 - pPush); on a symmetric grid this is 0.5.
    expect(priced).toBeCloseTo(0.5, 5);
  });

  it("accepts both the paren format (Corner Handicap) and the bare-sign format (Bookings Handicap)", () => {
    const cMeans = cornersMeans({ cornersForH: 8, cornersForA: 4 })!;
    const cardsM = cardsMeans({ cardsAvgH: 3, cardsAvgA: 1.5 })!;
    const cornersPriced = priceCornersLikeHandicap(buildCornersGrid(cMeans), "home (+1.5)");
    const cardsPriced = priceCardsLikeHandicap(buildCardsGrid(cardsM), "home -1.5");
    expect(cornersPriced).not.toBeNull();
    expect(cardsPriced).not.toBeNull();
    expect(cornersPriced!).toBeGreaterThan(0);
    expect(cornersPriced!).toBeLessThan(1);
  });

  it("a half-line handicap has no push (win + loss = 1 exactly)", () => {
    const means = cornersMeans({ cornersForH: 6, cornersForA: 6 })!;
    const grid = buildCornersGrid(means);
    const home = priceCornersLikeHandicap(grid, "home (-0.5)")!;
    const away = priceCornersLikeHandicap(grid, "away (+0.5)")!;
    expect(home + away).toBeCloseTo(1, 6);
  });

  it("returns null for an unparseable handicap desc", () => {
    const grid = buildCornersGrid(cornersMeans({ cornersForH: 6, cornersForA: 6 })!);
    expect(priceCornersLikeHandicap(grid, "draw")).toBeNull();
  });
});

describe("corners/cards range (closed buckets + open-ended '+' tails)", () => {
  it('"9-11" prices the closed bucket as the sum of cells where total is in [9,11]', () => {
    const means = cornersMeans({ cornersForH: 6, cornersForA: 4.5 })!;
    const grid = buildCornersGrid(means);
    const expected = sumWhere(grid, (h, a) => h + a >= 9 && h + a <= 11);
    expect(priceCornersLikeRange(grid, "9-11")).toBeCloseTo(expected, 10);
  });

  it('"12+" (catalog "Corner Range" bucket) prices as an open-ended tail, P(total>=12)', () => {
    const means = cornersMeans({ cornersForH: 6, cornersForA: 4.5 })!;
    const grid = buildCornersGrid(means);
    const expectedTail = sumWhere(grid, (h, a) => h + a >= 12);
    const expectedExact = sumWhere(grid, (h, a) => h + a === 12);
    expect(expectedTail).toBeGreaterThan(expectedExact); // proves the two differ
    expect(priceCornersLikeRange(grid, "12+")).toBeCloseTo(expectedTail, 10);
  });

  it('team-scoped range ("7+", side="home") uses only the home marginal, not the match total', () => {
    const means = cornersMeans({ cornersForH: 6, cornersForA: 4.5 })!;
    const grid = buildCornersGrid(means);
    const expected = sumWhere(grid, (h) => h >= 7);
    expect(priceCornersLikeRange(grid, "7+", "home")).toBeCloseTo(expected, 10);
  });

  it('single-value bucket "4" (catalog "Exact Bookings") prices as an exact match, not a range', () => {
    const means = cardsMeans({ cardsAvgH: 2, cardsAvgA: 2 })!;
    const grid = buildCardsGrid(means);
    const expected = sumWhere(grid, (h, a) => h + a === 4);
    expect(priceCardsLikeRange(grid, "4")).toBeCloseTo(expected, 10);
  });

  it("the full bucket ladder (0-8/9-11/12+) sums to ~1 (Corner Range's actual outcome set)", () => {
    const means = cornersMeans({ cornersForH: 6, cornersForA: 4.5 })!;
    const grid = buildCornersGrid(means);
    const low = priceCornersLikeRange(grid, "0-8")!;
    const mid = priceCornersLikeRange(grid, "9-11")!;
    const high = priceCornersLikeRange(grid, "12+")!;
    expect(low + mid + high).toBeCloseTo(1, 5);
  });
});

describe("corners odd-even (no cards equivalent exists in the catalog)", () => {
  it("odd + even sums to ~1", () => {
    const means = cornersMeans({ cornersForH: 6, cornersForA: 4.5 })!;
    const odd = priceCornersVariant(means, "odd", "odd-even")!;
    const even = priceCornersVariant(means, "even", "odd-even")!;
    expect(odd + even).toBeCloseTo(1, 6);
  });

  it("cards has no odd-even variant — priceCardsVariant's switch has no case for it, so it falls through to the O/U default and returns null for 'Odd' (not a valid O/U desc)", () => {
    const means = cardsMeans({ cardsAvgH: 2, cardsAvgA: 1.8 })!;
    expect(priceCardsVariant(means, "odd", "odd-even")).toBeNull();
  });
});

describe("priceCornersVariant/priceCardsVariant default (variant undefined/team-total) — unchanged pre-PR-22 behavior", () => {
  it("undefined variant reproduces priceCornersOutcome exactly", () => {
    const means = cornersMeans({ cornersForH: 6, cornersForA: 4.5 })!;
    expect(priceCornersVariant(means, "Over 9.5")).toBe(priceCornersOutcome(means, "Over 9.5"));
  });

  it('"team-total" variant reproduces priceCornersOutcome(desc, side) exactly', () => {
    const means = cornersMeans({ cornersForH: 8, cornersForA: 3 })!;
    expect(priceCornersVariant(means, "Over 2.5", "team-total", "home")).toBe(
      priceCornersOutcome(means, "Over 2.5", "home")
    );
  });
});

describe("shots-on-target (shotsMeans/priceShotsOutcome)", () => {
  it("is dormant when either side's SoT average is missing", () => {
    expect(shotsMeans({ sotForH: 5 })).toBeNull();
    expect(shotsMeans({})).toBeNull();
  });

  it("prices a match-total line via NB tail — hand-computed against nbTailOver directly", () => {
    const means = shotsMeans({ sotForH: 6, sotForA: 4 })!; // total mean 10
    const over = priceShotsOutcome(means, "Over 8.5")!;
    const expected = nbTailOver(8.5, 10, means.r);
    expect(over).toBeCloseTo(expected, 10);
    const under = priceShotsOutcome(means, "Under 8.5")!;
    expect(over + under).toBeCloseTo(1, 6);
  });

  it("prices a team-total line off the correct side's mean", () => {
    const means = shotsMeans({ sotForH: 7, sotForA: 2 })!;
    const homeOver = priceShotsOutcome(means, "Over 3.5", "home")!;
    const awayOver = priceShotsOutcome(means, "Over 3.5", "away")!;
    expect(homeOver).toBeGreaterThan(awayOver);
  });

  it("returns null for an unparseable description", () => {
    const means = shotsMeans({ sotForH: 6, sotForA: 4 })!;
    expect(priceShotsOutcome(means, "Yes")).toBeNull();
  });
});

describe("routeMarket — PR-22 corners/cards/shots variant routing table", () => {
  const entry = (id: string, name: string, specifier?: string) => ({
    id,
    name,
    outcomes: [{ id: "o1", desc: "placeholder", odds: "2.0" }],
    ...(specifier ? { specifier } : {}),
  });

  it('routes "Corners 1X2" (id 162) to engine corners, variant 1x2', () => {
    const r = routeMarket(entry("162", "Corners 1X2"));
    expect(r).toMatchObject({ engine: "corners", family: "corners", variant: "1x2" });
  });

  it('routes "Bookings 1X2" (id 136) to engine cards, variant 1x2', () => {
    const r = routeMarket(entry("136", "Bookings 1X2"));
    expect(r).toMatchObject({ engine: "cards", family: "cards", variant: "1x2" });
  });

  it('routes "Corner Handicap" (id 165) to variant handicap', () => {
    const r = routeMarket(entry("165", "Corner Handicap", "hcp=1.5"));
    expect(r).toMatchObject({ engine: "corners", variant: "handicap" });
  });

  it('routes "Bookings Handicap" (id 900312) to variant handicap', () => {
    const r = routeMarket(entry("900312", "Bookings Handicap", "hcp=1.5"));
    expect(r).toMatchObject({ engine: "cards", variant: "handicap" });
  });

  it('routes "Corner Range" (id 169) to variant range, no side', () => {
    const r = routeMarket(entry("169", "Corner Range", "variant=low"));
    expect(r).toMatchObject({ engine: "corners", variant: "range", side: undefined });
  });

  it('routes "Home Team Corner Range" (id 170) to variant range with side="home"', () => {
    const r = routeMarket(entry("170", "Home Team Corner Range", "variant=low"));
    expect(r).toMatchObject({ engine: "corners", variant: "range", side: "home" });
  });

  it('routes "Exact Bookings" (id 142) to variant range (cards uses "exact" not "range")', () => {
    const r = routeMarket(entry("142", "Exact Bookings"));
    expect(r).toMatchObject({ engine: "cards", variant: "range" });
  });

  it('routes "Away Team Exact Bookings" (id 144) to variant range with side="away"', () => {
    const r = routeMarket(entry("144", "Away Team Exact Bookings"));
    expect(r).toMatchObject({ engine: "cards", variant: "range", side: "away" });
  });

  it('routes "Odd/Even Corners" (id 172) to variant odd-even', () => {
    const r = routeMarket(entry("172", "Odd/Even Corners"));
    expect(r).toMatchObject({ engine: "corners", variant: "odd-even" });
  });

  it('routes "Home Team Total Corners" (id 900300) to variant team-total, side="home" — name has NO "over/under" substring, only the outcomes do', () => {
    const r = routeMarket(entry("900300", "Home Team Total Corners", "total=1.5"));
    expect(r).toMatchObject({ engine: "corners", variant: "team-total", side: "home", total: 1.5 });
  });

  it('routes "Away Team Total Bookings" (id 900305) to variant team-total, side="away"', () => {
    const r = routeMarket(entry("900305", "Away Team Total Bookings", "total=1.5"));
    expect(r).toMatchObject({ engine: "cards", variant: "team-total", side: "away", total: 1.5 });
  });

  it('the match-total O/U path stays unchanged (no variant field) — "Corners - Over/Under" (id 166)', () => {
    const r = routeMarket(entry("166", "Corners - Over/Under", "total=9.5"));
    expect(r).toMatchObject({ engine: "corners", total: 9.5 });
    expect((r as { variant?: string }).variant).toBeUndefined();
  });

  it('"Xth Corner" (id 163, per-event sequencing — no grid model) stays dormant', () => {
    const r = routeMarket(entry("163", "Xth Corner", "cornernr=1"));
    expect(r).toEqual({ skip: true, reason: "corners-dormant" });
  });

  it('"Total Booking Points" (id 138, points-weighted, not count-weighted) stays dormant, not accidentally priced as O/U', () => {
    const r = routeMarket(entry("138", "Total Booking Points", "total=15.5"));
    expect(r).toEqual({ skip: true, reason: "cards-dormant" });
  });

  it('"Home Team Sending Off" (id 147, red-card-specific — no matching rate tracked) stays dormant', () => {
    const r = routeMarket(entry("147", "Home Team Sending Off"));
    expect(r).toEqual({ skip: true, reason: "cards-dormant" });
  });

  it('routes "Shots on Target Over/Under" (id 900393, match total) to engine shots', () => {
    const r = routeMarket(entry("900393", "Shots on Target Over/Under", "total=8.5"));
    expect(r).toMatchObject({ engine: "shots", family: "shots", total: 8.5, side: undefined });
  });

  it('routes "Home Team Shots on Target O/U" (id 900546, abbreviated "O/U" not "over/under") to engine shots, side="home"', () => {
    const r = routeMarket(entry("900546", "Home Team Shots on Target O/U", "total=1.5"));
    expect(r).toMatchObject({ engine: "shots", family: "shots", side: "home", total: 1.5 });
  });

  it('"Shots on Target 1X2" (id 900318, no total= specifier, no model) stays dormant', () => {
    const r = routeMarket(entry("900318", "Shots on Target 1X2"));
    expect(r).toEqual({ skip: true, reason: "shots-dormant" });
  });

  it('plain "Shots Over/Under" (no "on target") is NOT carved out — stays a non-goal-metric skip via OTHER_METRIC_RE, unaffected by PR-22', () => {
    const r = routeMarket(entry("900394", "Shots Over/Under", "total=10.5"));
    expect(r).toEqual({ skip: true, reason: "non-goal-metric" });
  });
});
