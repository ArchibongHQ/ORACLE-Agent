/** Universal Under ban (safety/underBan.ts) — owner rule, locked decision ②:
 *  "no Under ever ships". Covers the shared text primitive (isUnderDesc),
 *  the EVMarket-shaped helpers, and the word-boundary safety against
 *  substring false positives ("Sunderland" etc). */
import { describe, expect, it } from "vitest";
import { hasUnderComponent, isUnderDesc, stripUnderComponents } from "../src/safety/underBan.js";
import type { EVMarket } from "../src/types.js";

function market(overrides: Partial<EVMarket> = {}): EVMarket {
  return {
    cat: "Goals O/U",
    label: "Over 2.5",
    market: "Goals O/U",
    side: "Over 2.5",
    family: "goals_ou",
    mp: 0.6,
    modelProb: 0.6,
    ip: 0.5,
    rawEdge: 0.1,
    ev: 0.2,
    odds: 2.0,
    stake: 0.05,
    stakeAmt: 50,
    rankingScore: 0.2,
    varianceMod: 1,
    ...overrides,
  };
}

describe("isUnderDesc", () => {
  it("detects a plain Under total", () => {
    expect(isUnderDesc("Under 2.5")).toBe(true);
    expect(isUnderDesc("under 2.5")).toBe(true); // case-insensitive
  });

  it("detects Under inside a combo leg", () => {
    expect(isUnderDesc("Home & Under 2.5")).toBe(true);
    expect(isUnderDesc("Under 2.5 & BTTS No")).toBe(true);
    expect(isUnderDesc("Draw & Under 2.5")).toBe(true);
  });

  it("detects Under inside a half-market label", () => {
    expect(isUnderDesc("SH Under 1.5")).toBe(true);
    expect(isUnderDesc("1H Under 0.5")).toBe(true);
  });

  it("does not flag Over markets", () => {
    expect(isUnderDesc("Over 2.5")).toBe(false);
    expect(isUnderDesc("Home & Over 2.5")).toBe(false);
  });

  it("does not flag non-totals markets", () => {
    expect(isUnderDesc("Home")).toBe(false);
    expect(isUnderDesc("Draw No Bet Away")).toBe(false);
    expect(isUnderDesc("BTTS Yes")).toBe(false);
    expect(isUnderDesc("2-1")).toBe(false);
  });

  it("does NOT false-positive on 'Sunderland' or other words containing 'under' as a substring", () => {
    expect(isUnderDesc("Sunderland")).toBe(false);
    expect(isUnderDesc("Sunderland To Win")).toBe(false);
    expect(isUnderDesc("Home & Sunderland")).toBe(false);
    // A genuine edge case: both a real Under AND "Sunderland" present —
    // must still detect the real Under (word boundary correctly isolates it).
    expect(isUnderDesc("Sunderland Under 2.5")).toBe(true);
  });

  it("does NOT false-positive on a bare word-boundary-safe use of 'under' with no attached numeric line (adversarial review finding, 2026-07-19)", () => {
    // Real totals-direction Unders are always followed by a numeric line —
    // no market in the actual catalogue ever emits a bare "Under" token. A
    // plain \bunder\b check alone would still catch these hypothetical
    // narrative phrases (word-boundary-safe, but no number attached); the
    // number-anchored check removes that risk category entirely rather than
    // relying on catalogue inspection to rule it out.
    expect(isUnderDesc("Manchester United Under Pressure")).toBe(false);
    expect(isUnderDesc("Team Under Review")).toBe(false);
  });

  it("catches Under lines regardless of decimal/hyphen formatting, including the corner/card 'Under 19.5'-style high lines", () => {
    expect(isUnderDesc("Under-19.5")).toBe(true); // hyphenated line format
    expect(isUnderDesc("Under 19.5")).toBe(true); // a real catalogue line (corners/cards), not a youth-team reference
    expect(isUnderDesc("Under19.5")).toBe(true); // no space before the number
  });

  it("handles null/undefined/empty text without throwing", () => {
    expect(isUnderDesc(undefined)).toBe(false);
    expect(isUnderDesc(null)).toBe(false);
    expect(isUnderDesc("")).toBe(false);
  });
});

describe("hasUnderComponent", () => {
  it("reads side when present", () => {
    expect(hasUnderComponent(market({ side: "Under 2.5", label: "Over 2.5" }))).toBe(true);
  });

  it("falls back to label when side is absent", () => {
    const m = market({ side: undefined, label: "Under 2.5" });
    expect(hasUnderComponent(m)).toBe(true);
  });

  it("returns false for a genuine Over candidate", () => {
    expect(hasUnderComponent(market({ side: "Over 2.5" }))).toBe(false);
  });

  it("is family-agnostic — fires on combo/half families exactly like goals_ou", () => {
    expect(hasUnderComponent(market({ family: "combo", side: "Home & Under 2.5" }))).toBe(true);
    expect(hasUnderComponent(market({ family: "half", side: "SH Under 1.5" }))).toBe(true);
    expect(hasUnderComponent(market({ family: undefined, side: "Under 2.5" }))).toBe(true);
  });
});

describe("stripUnderComponents", () => {
  it("removes every Under candidate regardless of family, keeps everything else", () => {
    const list = [
      market({ side: "Over 2.5", family: "goals_ou" }),
      market({ side: "Under 2.5", family: "goals_ou" }),
      market({ side: "Home & Under 2.5", family: "combo" }),
      market({ side: "SH Under 1.5", family: "half" }),
      market({ side: "Home", family: "match_result" }),
    ];
    const stripped = stripUnderComponents(list);
    expect(stripped).toHaveLength(2);
    expect(stripped.map((m) => m.side)).toEqual(["Over 2.5", "Home"]);
  });

  it("returns a NEW array — never mutates the input", () => {
    const list = [market({ side: "Under 2.5" })];
    const stripped = stripUnderComponents(list);
    expect(stripped).not.toBe(list);
    expect(list).toHaveLength(1); // original untouched
  });

  it("returns an empty array (not a throw) when every candidate is an Under", () => {
    const list = [market({ side: "Under 2.5" }), market({ side: "SH Under 0.5" })];
    expect(stripUnderComponents(list)).toEqual([]);
  });

  it("handles an empty input list", () => {
    expect(stripUnderComponents([])).toEqual([]);
  });
});
