import { describe, expect, it } from "vitest";
import {
  detectPatterns,
  PATTERN_THRESHOLDS,
  type PatternInput,
} from "../src/marketsV3/patterns.js";

/** A neutral, mandatory-complete base fixture — no pattern fires. Individual
 *  tests override only the fields the profile under test needs. */
function base(overrides: Partial<PatternInput> = {}): PatternInput {
  return {
    homeScoredHome: 1.3,
    homeConcededHome: 1.2,
    awayScoredAway: 1.2,
    awayConcededAway: 1.3,
    nHome: 6,
    nAway: 6,
    ...overrides,
  };
}

/** No recommendation this module ever produces may be an "Under" (owner rule). */
function assertNoUnder(side: string | null): void {
  if (side) expect(side.toLowerCase()).not.toContain("under");
}

describe("detectPatterns", () => {
  it("reference doc worked example — Arsenal (home) vs Chelsea (away): Heavy Superior + Goal Machine, never Under", () => {
    const report = detectPatterns(
      base({
        homeScoredHome: 2.4,
        homeConcededHome: 0.6,
        awayScoredAway: 0.8,
        awayConcededAway: 2.2,
        ou25PctH: 0.8,
        ou25PctA: 0.6,
        bttsPctH: 0.4,
        bttsPctA: 0.6,
        cornersForH: 6.8,
        cornersAgainstH: 3.2,
        cornersForA: 4.2,
        cornersAgainstA: 6.5,
        homeOdds: 1.5,
        drawOdds: 4.2,
        awayOdds: 6.0,
        nHome: 5,
        nAway: 5,
      })
    );
    const kinds = report.patterns.map((p) => p.kind);
    expect(kinds).toContain("heavy_superior");
    expect(kinds).toContain("goal_machine");
    // Heavy Superior is the strongest signal here (net gap 3.20/game).
    expect(report.topPattern?.kind).toBe("heavy_superior");
    expect(report.topPattern?.side).toBe("home");
    expect(report.recommendedFamily).toBe("asian_handicap");
    expect(report.confidence).not.toBeNull();
    // No pattern's recommendation is ever an Under.
    for (const p of report.patterns) assertNoUnder(p.recommendedSide);
    assertNoUnder(report.recommendedSide);
  });

  it("Heavy Superior fires on a lopsided venue-split mismatch and recommends the dominant side's AH", () => {
    const report = detectPatterns(
      base({
        homeScoredHome: 2.6,
        homeConcededHome: 0.5,
        awayScoredAway: 0.6,
        awayConcededAway: 2.4,
        homeOdds: 1.55,
      })
    );
    const hit = report.patterns.find((p) => p.kind === "heavy_superior");
    expect(hit).toBeDefined();
    expect(hit?.side).toBe("home");
    expect(hit?.recommendedFamily).toBe("asian_handicap");
    assertNoUnder(hit?.recommendedSide ?? null);
  });

  it("Heavy Superior can favour the away side too", () => {
    const report = detectPatterns(
      base({
        homeScoredHome: 0.6,
        homeConcededHome: 2.3,
        awayScoredAway: 2.5,
        awayConcededAway: 0.5,
      })
    );
    const hit = report.patterns.find((p) => p.kind === "heavy_superior");
    expect(hit?.side).toBe("away");
    expect(hit?.recommendedSide).toBe("Away");
  });

  it("Goal Machine fires on a high matchup-adjusted total and recommends Over 2.5 (never Under)", () => {
    const report = detectPatterns(
      base({
        homeScoredHome: 2.2,
        homeConcededHome: 1.6,
        awayScoredAway: 1.8,
        awayConcededAway: 1.7,
        ou25PctH: 0.78,
        ou25PctA: 0.74,
      })
    );
    const hit = report.patterns.find((p) => p.kind === "goal_machine");
    expect(hit).toBeDefined();
    expect(hit?.recommendedFamily).toBe("goals_ou");
    expect(hit?.recommendedSide).toBe("Over 2.5");
    assertNoUnder(hit?.recommendedSide ?? null);
  });

  it("Goal Machine prefers BTTS Yes when the signal is a two-sided score trend, not a high total", () => {
    const report = detectPatterns(
      base({
        homeScoredHome: 1.5,
        homeConcededHome: 1.3,
        awayScoredAway: 1.4,
        awayConcededAway: 1.35,
        bttsPctH: 0.82,
        bttsPctA: 0.8,
      })
    );
    const hit = report.patterns.find((p) => p.kind === "goal_machine");
    expect(hit).toBeDefined();
    expect(hit?.recommendedFamily).toBe("btts");
    expect(hit?.recommendedSide).toBe("Yes");
  });

  it("Corner Kings fires on a high combined corner expectation and recommends a total-corners Over", () => {
    const report = detectPatterns(
      base({
        cornersForH: 7.2,
        cornersAgainstH: 6.0,
        cornersForA: 6.4,
        cornersAgainstA: 6.8,
      })
    );
    const hit = report.patterns.find((p) => p.kind === "corner_kings");
    expect(hit).toBeDefined();
    expect(hit?.recommendedFamily).toBe("corners");
    expect(hit?.recommendedSide).toMatch(/^Over \d/);
  });

  it("Anomaly fires when a venue-split favourite is priced as a market underdog", () => {
    const report = detectPatterns(
      base({
        homeScoredHome: 2.2,
        homeConcededHome: 0.8,
        awayScoredAway: 0.9,
        awayConcededAway: 1.9,
        homeOdds: 2.6, // market underprices the clear venue-split favourite
      })
    );
    const hit = report.patterns.find((p) => p.kind === "anomaly");
    expect(hit).toBeDefined();
    expect(hit?.side).toBe("home");
    expect(hit?.recommendedFamily).toBe("dnb");
  });

  it("returns an empty report when nothing fires", () => {
    const report = detectPatterns(base());
    expect(report.patterns).toHaveLength(0);
    expect(report.topPattern).toBeNull();
    expect(report.strength).toBe(0);
    expect(report.confidence).toBeNull();
    expect(report.recommendedFamily).toBeNull();
  });

  it("degrades gracefully — venue-split goals alone, all optional fields absent, never throws", () => {
    const report = detectPatterns({
      homeScoredHome: 2.5,
      homeConcededHome: 0.5,
      awayScoredAway: 0.6,
      awayConcededAway: 2.3,
    });
    expect(report.topPattern?.kind).toBe("heavy_superior");
    expect(report.strength).toBeGreaterThan(0);
    expect(report.strength).toBeLessThanOrEqual(1);
  });

  it("is deterministic — identical input yields identical output", () => {
    const input = base({
      homeScoredHome: 2.4,
      homeConcededHome: 0.6,
      awayScoredAway: 0.8,
      awayConcededAway: 2.2,
      ou25PctH: 0.8,
      ou25PctA: 0.6,
    });
    expect(detectPatterns(input)).toEqual(detectPatterns(input));
  });

  it("thin venue sample sets a trap warning and discounts strength", () => {
    const rich = detectPatterns(
      base({
        homeScoredHome: 2.6,
        homeConcededHome: 0.5,
        awayScoredAway: 0.6,
        awayConcededAway: 2.4,
        nHome: 8,
        nAway: 8,
      })
    );
    const thin = detectPatterns(
      base({
        homeScoredHome: 2.6,
        homeConcededHome: 0.5,
        awayScoredAway: 0.6,
        awayConcededAway: 2.4,
        nHome: 2,
        nAway: 2,
      })
    );
    expect(thin.strength).toBeLessThan(rich.strength);
    expect(thin.trapWarning).toMatch(/thin venue sample/i);
  });

  it("exposes tunable thresholds", () => {
    expect(PATTERN_THRESHOLDS.gmExpTotalMin).toBeGreaterThan(0);
    expect(PATTERN_THRESHOLDS.hsGapMin).toBeGreaterThan(0);
  });
});
