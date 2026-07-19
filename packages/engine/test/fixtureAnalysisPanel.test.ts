import { describe, expect, it } from "vitest";
import { buildFixtureAnalysisPanel } from "../src/marketsV3/fixtureAnalysisPanel.js";
import type { PatternInput } from "../src/marketsV3/patterns.js";

/** A neutral, mandatory-complete base fixture — matches patterns.test.ts's
 *  convention so both suites share a common baseline. */
function base(overrides: Partial<PatternInput> = {}): PatternInput {
  return {
    homeScoredHome: 1.3,
    homeConcededHome: 1.2,
    awayScoredAway: 1.2,
    awayConcededAway: 1.3,
    ...overrides,
  };
}

/** The reference-doc worked example shared with patterns.test.ts — Arsenal
 *  (home) vs Chelsea (away), a heavy home-favourite fixture with full odds
 *  and corners data supplied. */
const ARSENAL_CHELSEA: PatternInput = base({
  homeScoredHome: 2.4,
  homeConcededHome: 0.6,
  awayScoredAway: 0.8,
  awayConcededAway: 2.2,
  homeOdds: 1.5,
  drawOdds: 4.2,
  awayOdds: 6.0,
  cornersForH: 6.8,
  cornersAgainstH: 3.2,
  cornersForA: 4.2,
  cornersAgainstA: 6.5,
});

const TOL = 0.6; // percentage-point tolerance for rounded (pct()) sums

function isMonotonicDecreasing(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (values[i]! > values[i - 1]!) return false;
  }
  return true;
}

describe("buildFixtureAnalysisPanel", () => {
  it("worked example (Arsenal vs Chelsea) — result1x2 sums to ~100, Home is the clear favourite, market/delta populated", () => {
    const panel = buildFixtureAnalysisPanel(ARSENAL_CHELSEA);
    expect(panel).not.toBeNull();
    const { result1x2 } = panel!;
    expect(result1x2.map((r) => r.label)).toEqual(["Home", "Draw", "Away"]);

    const sum = result1x2.reduce((s, r) => s + r.modelPct, 0);
    expect(sum).toBeGreaterThan(100 - TOL);
    expect(sum).toBeLessThan(100 + TOL);

    const home = result1x2.find((r) => r.label === "Home")!;
    const draw = result1x2.find((r) => r.label === "Draw")!;
    const away = result1x2.find((r) => r.label === "Away")!;
    expect(home.modelPct).toBeGreaterThan(draw.modelPct);
    expect(home.modelPct).toBeGreaterThan(away.modelPct);

    // Odds were supplied for all three legs — devig must populate market/delta.
    for (const row of result1x2) {
      expect(row.marketPct).not.toBeNull();
      expect(row.deltaPct).not.toBeNull();
      expect(row.deltaPct).toBeCloseTo(row.modelPct - row.marketPct!, 1);
    }
  });

  it("BTTS: market populates when odds are supplied, both null when omitted but modelPct still computed", () => {
    const withOdds = buildFixtureAnalysisPanel(
      base({ ...ARSENAL_CHELSEA, bttsYesOdds: 1.9, bttsNoOdds: 1.85 })
    );
    expect(withOdds).not.toBeNull();
    for (const row of withOdds!.btts) {
      expect(row.marketPct).not.toBeNull();
      expect(row.deltaPct).not.toBeNull();
    }

    const withoutOdds = buildFixtureAnalysisPanel(ARSENAL_CHELSEA);
    expect(withoutOdds).not.toBeNull();
    for (const row of withoutOdds!.btts) {
      expect(row.marketPct).toBeNull();
      expect(row.deltaPct).toBeNull();
      expect(Number.isFinite(row.modelPct)).toBe(true);
    }
    expect(withoutOdds!.btts.map((r) => r.label)).toEqual(["Yes", "No"]);
  });

  it("Goals O/U: exact 4 standard lines in order, each Over+Under ~= 100, strictly decreasing Over% as the line rises", () => {
    const panel = buildFixtureAnalysisPanel(ARSENAL_CHELSEA);
    expect(panel).not.toBeNull();
    const { goalsOU } = panel!;
    expect(goalsOU.map((l) => l.line)).toEqual([1.5, 2.5, 3.5, 4.5]);
    for (const l of goalsOU) {
      expect(l.overPct + l.underPct).toBeGreaterThan(100 - TOL);
      expect(l.overPct + l.underPct).toBeLessThan(100 + TOL);
    }
    expect(isMonotonicDecreasing(goalsOU.map((l) => l.overPct))).toBe(true);
    // Strictly decreasing (no ties) for this fixture's non-degenerate rates.
    for (let i = 1; i < goalsOU.length; i++) {
      expect(goalsOU[i]!.overPct).toBeLessThan(goalsOU[i - 1]!.overPct);
    }
  });

  it("Corners O/U: 4 standard lines with all corner fields supplied, decreasing Over%; empty array when corner fields are omitted", () => {
    const withCorners = buildFixtureAnalysisPanel(ARSENAL_CHELSEA);
    expect(withCorners).not.toBeNull();
    const { cornersOU } = withCorners!;
    expect(cornersOU.map((l) => l.line)).toEqual([8.5, 9.5, 10.5, 11.5]);
    expect(isMonotonicDecreasing(cornersOU.map((l) => l.overPct))).toBe(true);
    for (const l of cornersOU) {
      expect(l.overPct + l.underPct).toBeGreaterThan(100 - TOL);
      expect(l.overPct + l.underPct).toBeLessThan(100 + TOL);
    }

    const withoutCorners = buildFixtureAnalysisPanel(base());
    expect(withoutCorners).not.toBeNull();
    expect(withoutCorners!.cornersOU).toEqual([]);

    // Partial corner data (only 3 of 4 fields) must also degrade to empty —
    // the module requires all four before computing anything.
    const partialCorners = buildFixtureAnalysisPanel(
      base({ cornersForH: 6.8, cornersAgainstH: 3.2, cornersForA: 4.2 })
    );
    expect(partialCorners).not.toBeNull();
    expect(partialCorners!.cornersOU).toEqual([]);
  });

  it("Team Goals O/U: home and away both populated with 4 decreasing lines, depending only on required xG fields", () => {
    const panel = buildFixtureAnalysisPanel(base());
    expect(panel).not.toBeNull();
    const { teamGoalsOU } = panel!;
    expect(teamGoalsOU.home.map((l) => l.line)).toEqual([1.5, 2.5, 3.5, 4.5]);
    expect(teamGoalsOU.away.map((l) => l.line)).toEqual([1.5, 2.5, 3.5, 4.5]);
    expect(isMonotonicDecreasing(teamGoalsOU.home.map((l) => l.overPct))).toBe(true);
    expect(isMonotonicDecreasing(teamGoalsOU.away.map((l) => l.overPct))).toBe(true);
  });

  it("Team To Score First: home+away+noGoal ~= 100, home clearly exceeds away for the heavy-favourite fixture", () => {
    const panel = buildFixtureAnalysisPanel(ARSENAL_CHELSEA);
    expect(panel).not.toBeNull();
    const { teamToScoreFirst } = panel!;
    const sum = teamToScoreFirst.home + teamToScoreFirst.away + teamToScoreFirst.noGoal;
    expect(sum).toBeGreaterThan(100 - TOL);
    expect(sum).toBeLessThan(100 + TOL);
    expect(teamToScoreFirst.home).toBeGreaterThan(teamToScoreFirst.away);
  });

  it("Team To Score First: degenerate near-zero rates produce a very high noGoal% without dividing by zero", () => {
    const panel = buildFixtureAnalysisPanel(
      base({
        homeScoredHome: 0.01,
        homeConcededHome: 0.01,
        awayScoredAway: 0.01,
        awayConcededAway: 0.01,
      })
    );
    expect(panel).not.toBeNull();
    const { teamToScoreFirst } = panel!;
    expect(Number.isFinite(teamToScoreFirst.home)).toBe(true);
    expect(Number.isFinite(teamToScoreFirst.away)).toBe(true);
    expect(Number.isFinite(teamToScoreFirst.noGoal)).toBe(true);
    expect(teamToScoreFirst.noGoal).toBeGreaterThan(95);
  });

  it("Score Analysis: outcomePct sums to ~100, each column has <=5 rows sorted descending, home-column top-5 sum < outcomePct.home, score format and orientation are correct", () => {
    const panel = buildFixtureAnalysisPanel(ARSENAL_CHELSEA);
    expect(panel).not.toBeNull();
    const { scoreAnalysis } = panel!;
    const { outcomePct, home, draw, away } = scoreAnalysis;

    const outcomeSum = outcomePct.home + outcomePct.draw + outcomePct.away;
    expect(outcomeSum).toBeGreaterThan(100 - TOL);
    expect(outcomeSum).toBeLessThan(100 + TOL);

    for (const col of [home, draw, away]) {
      expect(col.length).toBeLessThanOrEqual(5);
      for (let i = 1; i < col.length; i++) {
        expect(col[i]!.pct).toBeLessThanOrEqual(col[i - 1]!.pct);
      }
      for (const row of col) {
        expect(row.score).toMatch(/^\d+-\d+$/);
      }
    }

    // Top-5 home scorelines are a strict subset of the full home-win mass
    // for this fixture (distribution isn't concentrated in <5 cells).
    const homeTop5Sum = home.reduce((s, r) => s + r.pct, 0);
    expect(homeTop5Sum).toBeLessThan(outcomePct.home);

    // Orientation: every "home" row's home-goals digit exceeds away-goals;
    // every "away" row is the reverse; every "draw" row is equal.
    for (const row of home) {
      const [h, a] = row.score.split("-").map(Number);
      expect(h!).toBeGreaterThan(a!);
    }
    for (const row of away) {
      const [h, a] = row.score.split("-").map(Number);
      expect(h!).toBeLessThan(a!);
    }
    for (const row of draw) {
      const [h, a] = row.score.split("-").map(Number);
      expect(h!).toBe(a!);
    }
  });

  it("returns null when a required field is NaN", () => {
    expect(buildFixtureAnalysisPanel(base({ homeScoredHome: Number.NaN }))).toBeNull();
    expect(buildFixtureAnalysisPanel(base({ awayConcededAway: Number.NaN }))).toBeNull();
  });

  it("returns null when a required field is Infinity", () => {
    expect(
      buildFixtureAnalysisPanel(base({ homeConcededHome: Number.POSITIVE_INFINITY }))
    ).toBeNull();
    expect(
      buildFixtureAnalysisPanel(base({ awayScoredAway: Number.NEGATIVE_INFINITY }))
    ).toBeNull();
  });

  it("an unrecognised league string does not throw and still returns a valid panel", () => {
    expect(() => buildFixtureAnalysisPanel(base(), "Not A Real League")).not.toThrow();
    const panel = buildFixtureAnalysisPanel(base(), "Not A Real League");
    expect(panel).not.toBeNull();
    expect(panel!.result1x2).toHaveLength(3);
  });

  it("omitting the league argument entirely also works", () => {
    expect(() => buildFixtureAnalysisPanel(base())).not.toThrow();
    const panel = buildFixtureAnalysisPanel(base());
    expect(panel).not.toBeNull();
  });

  it("is deterministic — identical input produces byte-identical output", () => {
    const a = buildFixtureAnalysisPanel(ARSENAL_CHELSEA);
    const b = buildFixtureAnalysisPanel(ARSENAL_CHELSEA);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
