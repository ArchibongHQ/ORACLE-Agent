import { describe, expect, it } from "vitest";
import { mapMarket } from "../src/marketMap.js";

describe("mapMarket — team total", () => {
  it("routes Home Total Over 0.5 to the team-total market, not match-total", () => {
    // Regression: cat "Team Total" contains "total" and previously fell through
    // to the generic Over/Under (match-total) branch, mapping to the wrong market.
    const m = mapMarket("Team Total", "Home Total Over 0.5");
    expect(m).toEqual({ sportyMarket: "Home Team Total", sportySelection: "Over 0.5" });
    // Crucially NOT the match-total market:
    expect(m?.sportyMarket).not.toBe("Over/Under");
  });

  it("routes Away Total Over 0.5", () => {
    expect(mapMarket("Team Total", "Away Total Over 0.5")).toEqual({
      sportyMarket: "Away Team Total",
      sportySelection: "Over 0.5",
    });
  });

  it("handles the Under direction and a 1.5 line", () => {
    expect(mapMarket("Team Total", "Home Total Under 1.5")).toEqual({
      sportyMarket: "Home Team Total",
      sportySelection: "Under 1.5",
    });
  });

  it("falls through to match-total when neither home nor away is specified", () => {
    // No home/away side → the team-total branch declines, and a sideless
    // "Total Over 0.5" reasonably falls through to the generic match-total.
    expect(mapMarket("Team Total", "Total Over 0.5")).toEqual({
      sportyMarket: "Over/Under",
      sportySelection: "Over 0.5",
    });
  });

  it("returns null when there is no numeric line", () => {
    expect(mapMarket("Team Total", "Home Total Over")).toBeNull();
  });
});

describe("mapMarket — match goals total still works", () => {
  it("maps Over 1.5 / Over 2.5 to the match Over/Under market", () => {
    expect(mapMarket("Goals O/U", "Over 1.5")).toEqual({
      sportyMarket: "Over/Under",
      sportySelection: "Over 1.5",
    });
    expect(mapMarket("Goals O/U", "Over 2.5")).toEqual({
      sportyMarket: "Over/Under",
      sportySelection: "Over 2.5",
    });
  });
});

describe("mapMarket — Asian 2 Goals", () => {
  // Regression: cat "Asian 2 Goals" contains "asian" and previously fell
  // through to the Asian Handicap branch, which only recognises home/away
  // sides — "Asian Over/Under 2 Goals" has neither, so it always returned
  // null and silently dropped every leg in this category.
  it("routes Asian Over 2 Goals to its own market, not Asian Handicap", () => {
    const m = mapMarket("Asian 2 Goals", "Asian Over 2 Goals");
    expect(m).toEqual({ sportyMarket: "Asian Total Goals", sportySelection: "Over 2" });
    expect(m?.sportyMarket).not.toBe("Asian Handicap");
  });

  it("routes Asian Under 2 Goals", () => {
    expect(mapMarket("Asian 2 Goals", "Asian Under 2 Goals")).toEqual({
      sportyMarket: "Asian Total Goals",
      sportySelection: "Under 2",
    });
  });
});

describe("mapMarket — Win Either Half", () => {
  // Regression: no branch matched "win either half" at all, so every pick
  // in this category returned null before reaching fixture/team matching.
  it("routes Win Either Half (H) to Home", () => {
    expect(mapMarket("Win Either Half", "Win Either Half (H)")).toEqual({
      sportyMarket: "Win Either Half",
      sportySelection: "Home",
    });
  });

  it("routes Win Either Half (A) to Away", () => {
    expect(mapMarket("Win Either Half", "Win Either Half (A)")).toEqual({
      sportyMarket: "Win Either Half",
      sportySelection: "Away",
    });
  });
});

describe("mapMarket — First Half", () => {
  // Regression: no branch matched "first half" at all, so every pick in
  // this category returned null before reaching fixture/team matching.
  it("routes FH Under 1.5 Goals to 1st Half Goals", () => {
    expect(mapMarket("First Half", "FH Under 1.5 Goals")).toEqual({
      sportyMarket: "1st Half Goals",
      sportySelection: "Under 1.5",
    });
  });

  it("routes FH Draw to 1st Half Result", () => {
    expect(mapMarket("First Half", "FH Draw")).toEqual({
      sportyMarket: "1st Half Result",
      sportySelection: "X",
    });
  });
});

describe("mapMarket — catalog fallback (PR-15)", () => {
  it("maps a family with no hand-rolled branch (Odd/Even) via MARKET_CATALOG", () => {
    // "Odd/Even" isn't one of the ~10 hand-rolled families above at all —
    // this only resolves via the catalog fallback added in PR-15.
    expect(mapMarket("Odd/Even", "Odd")).toEqual({
      sportyMarket: "Odd/Even",
      sportySelection: "Odd",
    });
    expect(mapMarket("Odd/Even", "Even")).toEqual({
      sportyMarket: "Odd/Even",
      sportySelection: "Even",
    });
  });

  it("is case/whitespace-tolerant on the side but requires an exact outcome match", () => {
    expect(mapMarket("Odd/Even", "  odd  ")).toEqual({
      sportyMarket: "Odd/Even",
      sportySelection: "Odd",
    });
  });

  it("returns null when the side doesn't match any of the catalogued outcomes", () => {
    expect(mapMarket("Odd/Even", "Maybe")).toBeNull();
  });

  it("returns null when cat doesn't match any catalogued market name", () => {
    expect(mapMarket("Not A Real Market", "Whatever")).toBeNull();
  });

  it("returns null when side is missing entirely", () => {
    expect(mapMarket("Odd/Even", null)).toBeNull();
  });

  it("still prefers the hand-rolled branches over the catalog fallback (1x2 unaffected)", () => {
    expect(mapMarket("1x2", "Home")).toEqual({ sportyMarket: "1X2", sportySelection: "1" });
  });
});
