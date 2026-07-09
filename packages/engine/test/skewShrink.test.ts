import { describe, expect, it } from "vitest";
import type { AllMarketsSanityInput, V3SanityResult } from "../src/marketsV3/sanity.js";
import {
  formatSkewShrinkShadow,
  SKEW_SHRINK_FRACTION_DEFAULT,
  shadowSkewShrink,
} from "../src/marketsV3/skewShrink.js";

function assessment(over: Partial<AllMarketsSanityInput> = {}): AllMarketsSanityInput {
  return {
    family: "dnb",
    desc: "Home DNB",
    outcome: "done",
    rawEdge: 0.1,
    adjustedEdge: 0.08,
    cls: "M",
    ...over,
  };
}

function sanity(flags: V3SanityResult["flags"]): V3SanityResult {
  return {
    flags,
    capRate: null,
    resultHomeShare: null,
    resultAwayShare: null,
    totalsOverShare: null,
    totalsUnderShare: null,
  };
}

describe("shadowSkewShrink", () => {
  it("returns no candidates when no sanity flag fired", () => {
    const result = shadowSkewShrink([assessment()], sanity([]));
    expect(result.candidates).toEqual([]);
  });

  it("model_miscalibration has no shrink target — no candidates even with assessments present", () => {
    const result = shadowSkewShrink([assessment()], sanity(["model_miscalibration"]));
    expect(result.candidates).toEqual([]);
  });

  it("flags a result_skew_home 'done' pick and computes the shrunk edge via rawEdge*(1-s)", () => {
    // rawEdge=0.10, adjustedEdge=0.08, shrink 0.5 -> shrunkAdjustedEdge = 0.08 - 0.10*0.5 = 0.03
    const result = shadowSkewShrink(
      [assessment({ family: "dnb", desc: "Home DNB", rawEdge: 0.1, adjustedEdge: 0.08, cls: "M" })],
      sanity(["result_skew_home"]),
      0.5
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.shrunkAdjustedEdge).toBeCloseTo(0.03, 10);
  });

  it("class M gate (minAdjEdge=0.05): demotes when the shrunk edge falls below it, survives when it doesn't", () => {
    const demoted = shadowSkewShrink(
      [assessment({ rawEdge: 0.1, adjustedEdge: 0.08, cls: "M" })],
      sanity(["result_skew_home"]),
      0.5 // shrunk = 0.08 - 0.05 = 0.03 < 0.05 minAdjEdge
    );
    expect(demoted.candidates[0]!.wouldBeDemoted).toBe(true);

    const survives = shadowSkewShrink(
      [assessment({ rawEdge: 0.1, adjustedEdge: 0.09, cls: "M" })],
      sanity(["result_skew_home"]),
      0.35 // shrunk = 0.09 - 0.035 = 0.055 >= 0.05 minAdjEdge
    );
    expect(survives.candidates[0]!.wouldBeDemoted).toBe(false);
  });

  it("ignores a 'done' pick outside the flagged family (totals family under a result-skew flag)", () => {
    const result = shadowSkewShrink(
      [assessment({ family: "goals_ou", desc: "Over 2.5" })], // goals_ou isn't in RESULT_FAMILIES
      sanity(["result_skew_home"])
    );
    expect(result.candidates).toEqual([]);
  });

  it("ignores a 'done' pick that isn't in the majority direction (Away pick under a Home skew flag)", () => {
    const result = shadowSkewShrink(
      [assessment({ family: "dnb", desc: "Away DNB" })],
      sanity(["result_skew_home"])
    );
    expect(result.candidates).toEqual([]);
  });

  it("ignores non-'done' outcomes even in the flagged family/direction", () => {
    const result = shadowSkewShrink(
      [assessment({ family: "dnb", desc: "Home DNB", outcome: "capped" })],
      sanity(["result_skew_home"])
    );
    expect(result.candidates).toEqual([]);
  });

  it("an unrecognized cls is reported but never claims a demotion it can't verify", () => {
    const result = shadowSkewShrink(
      [assessment({ cls: "unknown" })],
      sanity(["result_skew_home"]),
      0.9 // aggressive shrink that would demote any real class
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.wouldBeDemoted).toBe(false);
  });

  it("totals_skew_over targets goals_ou/team_total families with an 'Over' desc", () => {
    const result = shadowSkewShrink(
      [
        assessment({
          family: "goals_ou",
          desc: "Over 2.5",
          rawEdge: 0.1,
          adjustedEdge: 0.02,
          cls: "M",
        }),
        assessment({
          family: "goals_ou",
          desc: "Under 2.5",
          rawEdge: 0.1,
          adjustedEdge: 0.08,
          cls: "M",
        }),
      ],
      sanity(["totals_skew_over"])
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.desc).toBe("Over 2.5");
  });

  it("uses SKEW_SHRINK_FRACTION_DEFAULT (0.35) when no fraction is passed", () => {
    const result = shadowSkewShrink(
      [assessment({ rawEdge: 0.1, adjustedEdge: 0.08 })],
      sanity(["result_skew_home"])
    );
    expect(result.shrinkFraction).toBe(SKEW_SHRINK_FRACTION_DEFAULT);
    expect(result.candidates[0]!.shrunkAdjustedEdge).toBeCloseTo(0.08 - 0.1 * 0.35, 10);
  });

  it("review fix: excludes an ambiguous 'Home or Away' double-chance cover from result_skew_home — sideOfDesc() returns null for it, same as sanity.ts's own skew tally", () => {
    // Real production desc (SportyBet 12-cover), family double_chance is in
    // RESULT_FAMILIES. Before reusing sideOfDesc, a bare /\bhome\b/i regex
    // matched this too, sweeping in a pick sanity.ts itself excludes from
    // the home-skew population.
    const result = shadowSkewShrink(
      [
        assessment({
          family: "double_chance",
          desc: "Home or Away",
          rawEdge: 0.1,
          adjustedEdge: 0.08,
          cls: "M",
        }),
      ],
      sanity(["result_skew_home"]),
      0.5
    );
    expect(result.candidates).toEqual([]);
  });

  it("does not demote exactly at the class-gate boundary, matching evGate.ts's >= convention", () => {
    // cls M minAdjEdge=0.05. rawEdge=0.1, adjustedEdge=0.085, shrink=0.35
    // -> shrunkAdjustedEdge = 0.085 - 0.1*0.35 = 0.05 exactly.
    const result = shadowSkewShrink(
      [assessment({ rawEdge: 0.1, adjustedEdge: 0.085, cls: "M" })],
      sanity(["result_skew_home"]),
      0.35
    );
    expect(result.candidates[0]!.shrunkAdjustedEdge).toBeCloseTo(0.05, 10);
    expect(result.candidates[0]!.wouldBeDemoted).toBe(false);
  });

  it("accumulates candidates from two simultaneous flags (result_skew_home + totals_skew_over) without duplication or cross-family interference", () => {
    const result = shadowSkewShrink(
      [
        assessment({ family: "dnb", desc: "Home DNB", rawEdge: 0.1, adjustedEdge: 0.08, cls: "M" }),
        assessment({
          family: "goals_ou",
          desc: "Over 2.5",
          rawEdge: 0.1,
          adjustedEdge: 0.02,
          cls: "M",
        }),
      ],
      sanity(["result_skew_home", "totals_skew_over"])
    );
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.filter((c) => c.desc === "Home DNB")).toHaveLength(1);
    expect(result.candidates.filter((c) => c.desc === "Over 2.5")).toHaveLength(1);
  });
});

describe("formatSkewShrinkShadow", () => {
  it("returns null when there are no candidates at all", () => {
    expect(formatSkewShrinkShadow({ shrinkFraction: 0.35, candidates: [] })).toBeNull();
  });

  it("returns null when candidates exist but none would be demoted", () => {
    expect(
      formatSkewShrinkShadow({
        shrinkFraction: 0.35,
        candidates: [
          {
            family: "dnb",
            desc: "Home DNB",
            cls: "M",
            rawEdge: 0.1,
            adjustedEdge: 0.09,
            shrunkAdjustedEdge: 0.055,
            wouldBeDemoted: false,
          },
        ],
      })
    ).toBeNull();
  });

  it("lists only the demoted candidates, labeled 'shadow, not applied'", () => {
    const line = formatSkewShrinkShadow({
      shrinkFraction: 0.35,
      candidates: [
        {
          family: "dnb",
          desc: "Home DNB",
          cls: "M",
          rawEdge: 0.1,
          adjustedEdge: 0.08,
          shrunkAdjustedEdge: 0.045,
          wouldBeDemoted: true,
        },
        {
          family: "dnb",
          desc: "Home Handicap",
          cls: "L",
          rawEdge: 0.1,
          adjustedEdge: 0.2,
          shrunkAdjustedEdge: 0.15,
          wouldBeDemoted: false,
        },
      ],
    });
    expect(line).not.toBeNull();
    expect(line).toContain("shadow");
    expect(line).toContain("not applied");
    expect(line).toContain("would demote 1 pick(s)");
    expect(line).toContain("Home DNB");
    expect(line).not.toContain("Home Handicap");
  });
});
