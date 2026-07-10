/** [refactor P1-3] Feed-integrity (v5 Rule 0.14) tests, anchored on the live
 *  2026-07-09 France v Morocco incident: a real World Cup fixture's 736-row
 *  Markets-tab block was byte-identical to its SRL twin's, while the
 *  fixtures-sheet headline 1X2 (1.62/4.15/6.18) disagreed with the markets-tab
 *  1X2 (1.79/3.66/4.56). The deterministic layer priced garbage confidently —
 *  this stage must flag it automatically. This test IS the Wave-1 merge gate.
 */
import { describe, expect, it } from "vitest";
import {
  checkFixtureIntegrity,
  crossCheckHeadline1x2,
  detectSrlTwin,
  type MarketsBlockEntry,
  runFeedIntegrity,
  scanDuplicateBlocks,
} from "../src/feedIntegrity.js";

/** Build a realistic ~30-entry markets block (well over the 20-entry meaningful
 *  floor). Deterministic prices so the twin can be made identical or divergent. */
function makeBlock(seed: number): MarketsBlockEntry[] {
  const entries: MarketsBlockEntry[] = [];
  // 1X2 headline
  entries.push({ market: "1X2", outcome: "1", odds: 1.79 });
  entries.push({ market: "1X2", outcome: "X", odds: 3.66 });
  entries.push({ market: "1X2", outcome: "2", odds: 4.56 });
  // O/U ladder + BTTS + DC + DNB — 27 more entries
  for (let line = 5; line <= 45; line += 5) {
    const t = (line / 10).toFixed(1);
    entries.push({
      market: "Over/Under",
      specifier: `total=${t}`,
      outcome: "Over",
      odds: 1.4 + seed + line / 100,
    });
    entries.push({
      market: "Over/Under",
      specifier: `total=${t}`,
      outcome: "Under",
      odds: 2.6 - line / 100,
    });
  }
  entries.push({ market: "GG/NG", outcome: "GG", odds: 1.72 + seed });
  entries.push({ market: "GG/NG", outcome: "NG", odds: 2.05 });
  entries.push({ market: "Double Chance", outcome: "1X", odds: 1.22 });
  entries.push({ market: "Double Chance", outcome: "12", odds: 1.28 });
  entries.push({ market: "Draw No Bet", outcome: "1", odds: 1.35 });
  entries.push({ market: "Draw No Bet", outcome: "2", odds: 3.1 });
  return entries;
}

const FR_MA_HEADLINE_FIXTURES = { home: 1.62, draw: 4.15, away: 6.18 }; // fixtures-sheet
// markets-tab 1X2 is 1.79/3.66/4.56 (baked into makeBlock's first three rows)

describe("Rule 0.14a — SRL-twin contamination (France v Morocco replay)", () => {
  it("detectSrlTwin flags a real block byte-identical to its SRL twin", () => {
    const real = makeBlock(0);
    const twin = makeBlock(0); // identical prices
    const { contaminated, identityRatio } = detectSrlTwin(real, twin);
    expect(contaminated).toBe(true);
    expect(identityRatio).toBeCloseTo(1.0, 5);
  });

  it("runFeedIntegrity contaminates the REAL fixture (headline-only), not the twin", () => {
    const blocks = new Map<string, MarketsBlockEntry[]>([
      ["France|Morocco", makeBlock(0)],
      ["France SRL|Morocco SRL", makeBlock(0)],
    ]);
    const headlines = new Map([["France|Morocco", FR_MA_HEADLINE_FIXTURES]]);
    const report = runFeedIntegrity(blocks, headlines);

    const real = checkFixtureIntegrity("France|Morocco", report);
    expect(real?.verdict).toBe("contaminated");
    expect(real?.reason).toBe("srl_twin");
    expect(real?.headlineOnly).toBe(true);
    expect(report.contaminatedCount).toBeGreaterThanOrEqual(1);
  });
});

describe("Rule 0.14b — fixtures-vs-markets headline 1X2 cross-check", () => {
  it("flags the France v Morocco headline mismatch (1.62/4.15/6.18 vs 1.79/3.66/4.56)", () => {
    const { mismatch, detail } = crossCheckHeadline1x2(FR_MA_HEADLINE_FIXTURES, makeBlock(0));
    expect(mismatch).toBe(true);
    expect(detail).toContain("mismatch");
  });

  it("does NOT flag when the two sources agree within rounding tolerance", () => {
    const { mismatch } = crossCheckHeadline1x2(
      { home: 1.79, draw: 3.66, away: 4.57 },
      makeBlock(0)
    );
    expect(mismatch).toBe(false);
  });
});

describe("Rule 0.14c — duplicate-block scan", () => {
  it("groups distinct fixtures sharing a byte-identical block", () => {
    const blocks = new Map<string, MarketsBlockEntry[]>([
      ["TeamA|TeamB", makeBlock(0)],
      ["TeamC|TeamD", makeBlock(0)],
      ["TeamE|TeamF", makeBlock(0.01)], // different prices
    ]);
    const groups = scanDuplicateBlocks(blocks);
    expect(groups.length).toBe(1);
    expect(groups[0]!.sort()).toEqual(["TeamA|TeamB", "TeamC|TeamD"]);
  });
});

describe("negative cases — clean slates are not flagged", () => {
  it("distinct real fixtures with different odds stay clean", () => {
    const blocks = new Map<string, MarketsBlockEntry[]>([
      ["France|Morocco", makeBlock(0)],
      ["Spain|Portugal", makeBlock(0.02)],
    ]);
    const headlines = new Map([
      ["France|Morocco", { home: 1.79, draw: 3.66, away: 4.56 }], // agrees with block
      ["Spain|Portugal", { home: 1.81, draw: 3.66, away: 4.56 }],
    ]);
    const report = runFeedIntegrity(blocks, headlines);
    expect(report.contaminatedCount).toBe(0);
    expect(report.flaggedCount).toBe(0);
  });

  it("a small shared overlap (< 20 entries) is NOT enough to contaminate", () => {
    const tiny: MarketsBlockEntry[] = [
      { market: "1X2", outcome: "1", odds: 1.79 },
      { market: "1X2", outcome: "X", odds: 3.66 },
      { market: "1X2", outcome: "2", odds: 4.56 },
    ];
    const { contaminated } = detectSrlTwin(tiny, tiny);
    expect(contaminated).toBe(false);
  });
});
