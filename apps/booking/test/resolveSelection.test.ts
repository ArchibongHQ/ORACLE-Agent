import { describe, expect, it } from "vitest";
import { mapMarket } from "../src/marketMap.js";
import {
  ODDS_MISMATCH_TOLERANCE,
  resolveSelection,
  type SportyBetEventData,
} from "../src/resolveSelection.js";

/** Minimal event-data builder — only `markets` matters to resolveSelection. */
function event(markets: SportyBetEventData["markets"]): SportyBetEventData {
  return { eventId: "sr:match:1", gameId: "1", markets };
}

describe("resolveSelection — odds ladder cross-line bind (incident regression a)", () => {
  // The actual incident: normalise() stripped decimals ("Over 1.5" -> "over
  // 15") and matched with String.includes(), so "over 15".includes("over 1")
  // bound the pick to the WRONG line. A real Over/Under market publishes one
  // entry per line, same header, distinct specifier.
  const ladder = event([
    {
      id: "m-0.5",
      name: "Over/Under",
      specifier: "total=0.5",
      outcomes: [
        { id: "o-0.5-over", desc: "Over", odds: "1.20" },
        { id: "o-0.5-under", desc: "Under", odds: "4.00" },
      ],
    },
    {
      id: "m-1",
      name: "Over/Under",
      specifier: "total=1",
      outcomes: [
        { id: "o-1-over", desc: "Over", odds: "1.50" },
        { id: "o-1-under", desc: "Under", odds: "2.60" },
      ],
    },
    {
      id: "m-1.5",
      name: "Over/Under",
      specifier: "total=1.5",
      outcomes: [
        { id: "o-1.5-over", desc: "Over", odds: "1.80" },
        { id: "o-1.5-under", desc: "Under", odds: "2.00" },
      ],
    },
    {
      id: "m-2.5",
      name: "Over/Under",
      specifier: "total=2.5",
      outcomes: [
        { id: "o-2.5-over", desc: "Over", odds: "2.50" },
        { id: "o-2.5-under", desc: "Under", odds: "1.50" },
      ],
    },
  ]);

  it('"Over 1.5" binds the total=1.5 entry, never "Over 1" or another line', () => {
    const mapping = mapMarket("Goals O/U", "Over 1.5");
    expect(mapping).toEqual({
      sportyMarket: "Over/Under",
      sportySelection: "Over 1.5",
      line: 1.5,
      family: "goals_ou",
    });
    const res = resolveSelection(ladder, { mapping: mapping!, odds: 1.8 });
    expect(res.matched).toBe(true);
    if (!res.matched) throw new Error("expected match");
    expect(res.selection.marketId).toBe("m-1.5");
    expect(res.selection.outcomeId).toBe("o-1.5-over");
    // Explicitly not the decoy lines the old bidirectional-includes bug
    // would have matched ("over 15".includes("over 1")):
    expect(res.selection.marketId).not.toBe("m-1");
    expect(res.selection.outcomeId).not.toBe("o-1-over");
  });

  it('"Over 1" (the shorter line) binds its own entry, not "Over 1.5"', () => {
    const mapping = mapMarket("Goals O/U", "Over 1");
    const res = resolveSelection(ladder, { mapping: mapping!, odds: 1.5 });
    expect(res.matched).toBe(true);
    if (!res.matched) throw new Error("expected match");
    expect(res.selection.marketId).toBe("m-1");
    expect(res.selection.outcomeId).toBe("o-1-over");
  });
});

describe("resolveSelection — Home Team Total vs match Total (incident regression b)", () => {
  // The actual incident: "home team total".includes("total") let the header
  // gate pass for a bare match-total market. Fixture includes both a decoy
  // named literally "Total" (mirrors the incident text) and the real
  // per-team market at the SAME line/odds-shape, so only the anchored,
  // one-directional header rule can tell them apart.
  const withDecoyNamedTotal = event([
    {
      id: "decoy-total",
      name: "Total",
      specifier: "total=1.5",
      outcomes: [
        { id: "decoy-over", desc: "Over", odds: "1.80" },
        { id: "decoy-under", desc: "Under", odds: "2.00" },
      ],
    },
    {
      id: "home-team-total",
      name: "Home Team Total",
      specifier: "total=1.5",
      outcomes: [
        { id: "htt-over", desc: "Over", odds: "2.10" },
        { id: "htt-under", desc: "Under", odds: "1.65" },
      ],
    },
  ]);

  it('"Home Total Over 1.5" binds Home Team Total, never the bare "Total" decoy', () => {
    const mapping = mapMarket("Team Total", "Home Total Over 1.5");
    expect(mapping?.sportyMarket).toBe("Home Team Total");
    const res = resolveSelection(withDecoyNamedTotal, { mapping: mapping!, odds: 2.1 });
    expect(res.matched).toBe(true);
    if (!res.matched) throw new Error("expected match");
    expect(res.selection.marketId).toBe("home-team-total");
    expect(res.selection.marketId).not.toBe("decoy-total");
  });

  const withDecoyMatchTotal = event([
    {
      id: "match-total",
      name: "Over/Under",
      specifier: "total=1.5",
      outcomes: [
        { id: "mt-over", desc: "Over", odds: "1.80" },
        { id: "mt-under", desc: "Under", odds: "2.00" },
      ],
    },
    {
      id: "home-team-total",
      name: "Home Team Total",
      specifier: "total=1.5",
      outcomes: [
        { id: "htt-over", desc: "Over", odds: "2.10" },
        { id: "htt-under", desc: "Under", odds: "1.65" },
      ],
    },
  ]);

  it('"Home Total Over 1.5" binds Home Team Total, never the match "Over/Under" market', () => {
    const mapping = mapMarket("Team Total", "Home Total Over 1.5");
    const res = resolveSelection(withDecoyMatchTotal, { mapping: mapping!, odds: 2.1 });
    expect(res.matched).toBe(true);
    if (!res.matched) throw new Error("expected match");
    expect(res.selection.marketId).toBe("home-team-total");
    expect(res.selection.marketId).not.toBe("match-total");
  });
});

describe("resolveSelection — correct bind succeeds (c)", () => {
  it("resolves plain 1X2 Home with no line", () => {
    const mapping = mapMarket("1x2", "Home");
    const data = event([
      {
        id: "1x2",
        name: "1X2",
        specifier: "",
        outcomes: [
          { id: "h", desc: "1", odds: "1.90" },
          { id: "d", desc: "X", odds: "3.40" },
          { id: "a", desc: "2", odds: "4.20" },
        ],
      },
    ]);
    const res = resolveSelection(data, { mapping: mapping!, odds: 1.9 });
    expect(res.matched).toBe(true);
    if (!res.matched) throw new Error("expected match");
    expect(res.selection).toEqual({
      marketId: "1x2",
      specifier: "",
      outcomeId: "h",
      odds: 1.9,
      label: "1",
    });
  });

  it("resolves a line via the outcome-desc shape (no specifier, line embedded in desc)", () => {
    const mapping = mapMarket("Goals O/U", "Over 1.5");
    const data = event([
      {
        id: "ou-desc-shape",
        name: "Over/Under",
        specifier: "",
        outcomes: [
          { id: "over-1.5", desc: "Over 1.5", odds: "1.80" },
          { id: "under-1.5", desc: "Under 1.5", odds: "2.00" },
        ],
      },
    ]);
    const res = resolveSelection(data, { mapping: mapping!, odds: 1.8 });
    expect(res.matched).toBe(true);
    if (!res.matched) throw new Error("expected match");
    expect(res.selection.outcomeId).toBe("over-1.5");
  });
});

describe("resolveSelection — ambiguous duplicate (d)", () => {
  it("two distinct candidates for the same target ⇒ unmatched(ambiguous)", () => {
    const mapping = mapMarket("Goals O/U", "Over 1.5");
    const data = event([
      {
        id: "dup-1",
        name: "Over/Under",
        specifier: "total=1.5",
        outcomes: [{ id: "dup-1-over", desc: "Over", odds: "1.80" }],
      },
      {
        id: "dup-2",
        name: "Over/Under",
        specifier: "total=1.5",
        outcomes: [{ id: "dup-2-over", desc: "Over", odds: "1.85" }],
      },
    ]);
    const res = resolveSelection(data, { mapping: mapping!, odds: 1.8 });
    expect(res.matched).toBe(false);
    if (res.matched) throw new Error("expected unmatched");
    expect(res.unmatched.reason).toBe("ambiguous");
  });
});

describe("resolveSelection — odds guard (e)", () => {
  it("resolved odds 3x off the engine's priced odds ⇒ unmatched(odds_mismatch)", () => {
    const mapping = mapMarket("1x2", "Home");
    const data = event([
      {
        id: "1x2",
        name: "1X2",
        specifier: "",
        outcomes: [{ id: "h", desc: "1", odds: "1.90" }],
      },
    ]);
    const res = resolveSelection(data, { mapping: mapping!, odds: 1.9 * 3 });
    expect(res.matched).toBe(false);
    if (res.matched) throw new Error("expected unmatched");
    expect(res.unmatched.reason).toBe("odds_mismatch");
  });

  it("stays within tolerance for ordinary live-price drift", () => {
    const mapping = mapMarket("1x2", "Home");
    const data = event([
      {
        id: "1x2",
        name: "1X2",
        specifier: "",
        outcomes: [{ id: "h", desc: "1", odds: "1.90" }],
      },
    ]);
    // 10% drift, inside ODDS_MISMATCH_TOLERANCE (0.25).
    const res = resolveSelection(data, { mapping: mapping!, odds: 1.9 * 1.1 });
    expect(res.matched).toBe(true);
  });

  it("exports the documented tolerance", () => {
    expect(ODDS_MISMATCH_TOLERANCE).toBe(0.25);
  });
});

describe("resolveSelection — unmapped market stays unmatched (f)", () => {
  it('"Asian Total Goals" never confirmed live ⇒ no_market_header, never a guess', () => {
    const mapping = mapMarket("Asian 2 Goals", "Asian Over 2 Goals");
    expect(mapping).toEqual({
      sportyMarket: "Asian Total Goals",
      sportySelection: "Over 2",
      line: 2,
    });
    // Realistic fixture: the event has ordinary markets, but nothing shaped
    // like "Asian Total Goals" — matches the live-probe finding recorded in
    // marketMap.ts/resolvePageTarget.
    const data = event([
      {
        id: "1x2",
        name: "1X2",
        specifier: "",
        outcomes: [{ id: "h", desc: "1", odds: "1.90" }],
      },
      {
        id: "ou-1.5",
        name: "Over/Under",
        specifier: "total=1.5",
        outcomes: [{ id: "o", desc: "Over", odds: "1.80" }],
      },
    ]);
    const res = resolveSelection(data, { mapping: mapping!, odds: 1.8 });
    expect(res.matched).toBe(false);
    if (res.matched) throw new Error("expected unmatched");
    expect(res.unmatched.reason).toBe("no_market_header");
  });
});

describe("resolveSelection — line-free pick rejects a lined specifier", () => {
  it('a plain "1X2" pick never binds a minute-window "1X2" carrying a specifier', () => {
    const mapping = mapMarket("1x2", "Home");
    const data = event([
      {
        id: "1x2-windowed",
        name: "1X2",
        specifier: "total=10",
        outcomes: [{ id: "windowed-h", desc: "1", odds: "1.95" }],
      },
      {
        id: "1x2-plain",
        name: "1X2",
        specifier: "",
        outcomes: [{ id: "plain-h", desc: "1", odds: "1.90" }],
      },
    ]);
    const res = resolveSelection(data, { mapping: mapping!, odds: 1.9 });
    expect(res.matched).toBe(true);
    if (!res.matched) throw new Error("expected match");
    expect(res.selection.marketId).toBe("1x2-plain");
    expect(res.selection.marketId).not.toBe("1x2-windowed");
  });
});

describe("resolveSelection — suspended and no-outcome reasons", () => {
  it("all surviving candidates suspended (odds <= 1) ⇒ unmatched(suspended)", () => {
    const mapping = mapMarket("1x2", "Home");
    const data = event([
      {
        id: "1x2",
        name: "1X2",
        specifier: "",
        outcomes: [{ id: "h", desc: "1", odds: "1.00" }],
      },
    ]);
    const res = resolveSelection(data, { mapping: mapping!, odds: 1.9 });
    expect(res.matched).toBe(false);
    if (res.matched) throw new Error("expected unmatched");
    expect(res.unmatched.reason).toBe("suspended");
  });

  it("header matches but no outcome direction matches ⇒ unmatched(no_outcome)", () => {
    const mapping = mapMarket("1x2", "Home");
    const data = event([
      {
        id: "1x2",
        name: "1X2",
        specifier: "",
        outcomes: [{ id: "d", desc: "X", odds: "3.40" }],
      },
    ]);
    const res = resolveSelection(data, { mapping: mapping!, odds: 1.9 });
    expect(res.matched).toBe(false);
    if (res.matched) throw new Error("expected unmatched");
    expect(res.unmatched.reason).toBe("no_outcome");
  });
});
