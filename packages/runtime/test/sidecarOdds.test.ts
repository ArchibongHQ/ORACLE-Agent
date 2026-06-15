/** Unit tests for flattenSidecarOdds() — pure function, all branches. */

import { describe, expect, it } from "vitest";
import type { SportyBetEventDetail } from "../src/selectFixtures.js";
import { flattenSidecarOdds } from "../src/sidecarOdds.js";

function detail(odds: Record<string, unknown>): SportyBetEventDetail {
  return {
    eventId: "test",
    odds,
    stats: null,
    statscoverage: {},
  } as unknown as SportyBetEventDetail;
}

describe("flattenSidecarOdds — 1x2 direct", () => {
  it("maps home/draw/away from 1x2 block", () => {
    const flat = flattenSidecarOdds(detail({ "1x2": { home: 2.1, draw: 3.4, away: 4.0 } }));
    expect(flat["home"]).toBe(2.1);
    expect(flat["draw"]).toBe(3.4);
    expect(flat["away"]).toBe(4.0);
  });

  it("rejects odds <= 1 (toNum guard)", () => {
    const flat = flattenSidecarOdds(detail({ "1x2": { home: 0.9, draw: 1.0, away: 1.5 } }));
    expect(flat["home"]).toBeUndefined();
    expect(flat["draw"]).toBeUndefined();
    expect(flat["away"]).toBe(1.5);
  });

  it("rejects odds > 200 (upper ceiling)", () => {
    const flat = flattenSidecarOdds(detail({ "1x2": { home: 201, draw: 3.4, away: 4.0 } }));
    expect(flat["home"]).toBeUndefined();
    expect(flat["draw"]).toBe(3.4);
  });
});

describe("flattenSidecarOdds — DNB synthetic 1x2 fallback", () => {
  it("reconstructs home/draw/away when 1x2 is absent but DNB has both sides", () => {
    const flat = flattenSidecarOdds(detail({ dnb: { home: 1.6, away: 2.5 } }));
    expect(flat["home"]).toBeDefined();
    expect(flat["away"]).toBeDefined();
    expect(flat["draw"]).toBeDefined();
    // Synthetic values must be > 1
    expect(flat["home"]!).toBeGreaterThan(1);
    expect(flat["draw"]!).toBeGreaterThan(1);
  });

  it("uses dnbH as home proxy when only home DNB available", () => {
    const flat = flattenSidecarOdds(detail({ dnb: { home: 1.8 } }));
    expect(flat["home"]).toBe(1.8);
    expect(flat["away"]).toBeUndefined();
    expect(flat["draw"]).toBeUndefined();
  });

  it("uses dnbA as away proxy when only away DNB available", () => {
    const flat = flattenSidecarOdds(detail({ dnb: { away: 3.0 } }));
    expect(flat["away"]).toBe(3.0);
    expect(flat["home"]).toBeUndefined();
  });

  it("caps synthetic draw at 3.4 when implied draw probability is negligible", () => {
    // Very even match: dnbH ≈ dnbA ≈ 2 → pD ≈ 0 → cap fires
    const flat = flattenSidecarOdds(detail({ dnb: { home: 2.0, away: 2.0 } }));
    expect(flat["draw"]).toBe(3.4);
  });
});

describe("flattenSidecarOdds — totals (OU)", () => {
  it("maps over_2.5 and under_2.5", () => {
    const flat = flattenSidecarOdds(detail({ ou25: { over: 1.85, under: 1.95 } }));
    expect(flat["over_2.5"]).toBe(1.85);
    expect(flat["under_2.5"]).toBe(1.95);
  });

  it("maps over_1.5 and under_1.5", () => {
    const flat = flattenSidecarOdds(detail({ ou15: { over: 1.4, under: 2.8 } }));
    expect(flat["over_1.5"]).toBe(1.4);
    expect(flat["under_1.5"]).toBe(2.8);
  });

  it("maps over_3.5 and under_3.5", () => {
    const flat = flattenSidecarOdds(detail({ ou35: { over: 2.3, under: 1.6 } }));
    expect(flat["over_3.5"]).toBe(2.3);
    expect(flat["under_3.5"]).toBe(1.6);
  });
});

describe("flattenSidecarOdds — team totals Over 0.5", () => {
  it("maps tt_home_05.over to home_ou_over_0_5", () => {
    const flat = flattenSidecarOdds(detail({ tt_home_05: { over: 1.3, under: 3.33 } }));
    expect(flat["home_ou_over_0_5"]).toBe(1.3);
  });

  it("maps tt_away_05.over to away_ou_over_0_5", () => {
    const flat = flattenSidecarOdds(detail({ tt_away_05: { over: 1.18, under: 4.5 } }));
    expect(flat["away_ou_over_0_5"]).toBe(1.18);
  });

  it("omits team-total keys when absent or invalid", () => {
    const flat = flattenSidecarOdds(detail({ tt_home_05: { over: 1.0 } }));
    expect(flat["home_ou_over_0_5"]).toBeUndefined();
    expect(flat["away_ou_over_0_5"]).toBeUndefined();
  });
});

describe("flattenSidecarOdds — BTTS", () => {
  it("maps btts_yes and btts_no", () => {
    const flat = flattenSidecarOdds(detail({ btts: { yes: 1.75, no: 2.1 } }));
    expect(flat["btts_yes"]).toBe(1.75);
    expect(flat["btts_no"]).toBe(2.1);
  });
});

describe("flattenSidecarOdds — Draw No Bet explicit keys", () => {
  it("maps dnb_h and dnb_a", () => {
    const flat = flattenSidecarOdds(detail({ dnb: { home: 1.6, away: 2.5 } }));
    expect(flat["dnb_h"]).toBe(1.6);
    expect(flat["dnb_a"]).toBe(2.5);
  });
});

describe("flattenSidecarOdds — Double Chance", () => {
  it("maps dc_1x, dc_x2, dc_12", () => {
    const flat = flattenSidecarOdds(detail({ dc: { "1x": 1.2, x2: 1.6, "12": 1.1 } }));
    expect(flat["dc_1x"]).toBe(1.2);
    expect(flat["dc_x2"]).toBe(1.6);
    expect(flat["dc_12"]).toBe(1.1);
  });
});

describe("flattenSidecarOdds — Asian Handicap", () => {
  it("maps ah_h and ah_a generic keys", () => {
    const flat = flattenSidecarOdds(detail({ ah: { home: 1.9, away: 2.0, line: 0 } }));
    expect(flat["ah_h"]).toBe(1.9);
    expect(flat["ah_a"]).toBe(2.0);
  });

  it("maps line-specific key e.g. ah_hp05 for line 0.5", () => {
    const flat = flattenSidecarOdds(detail({ ah: { home: 1.85, away: 2.05, line: 0.5 } }));
    expect(flat["ah_hp05"]).toBe(1.85);
    expect(flat["ah_ap05"]).toBe(2.05);
  });

  it("maps line-specific key ah_hp25 for line 2.5", () => {
    const flat = flattenSidecarOdds(detail({ ah: { home: 1.7, away: 2.2, line: 2.5 } }));
    expect(flat["ah_hp25"]).toBe(1.7);
    expect(flat["ah_ap25"]).toBe(2.2);
  });
});

describe("flattenSidecarOdds — empty / null odds", () => {
  it("returns empty object when odds block is null", () => {
    const flat = flattenSidecarOdds(detail({}));
    expect(Object.keys(flat)).toHaveLength(0);
  });

  it("returns empty object when detail.odds is undefined", () => {
    const d = { eventId: "x", stats: null, statscoverage: {} } as unknown as SportyBetEventDetail;
    const flat = flattenSidecarOdds(d);
    expect(Object.keys(flat)).toHaveLength(0);
  });
});
