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

describe("detectPatterns — broadened v6.2 catalog (2026-07-18)", () => {
  it("G4 BTTS Banker fires on high two-sided BTTS% with low clean-sheet rates, distinct from goal_machine", () => {
    const report = detectPatterns(
      base({
        // expTotal = 2.3, below gmExpTotalMin (2.7) — isolates btts_banker
        // from goal_machine's bttsStrong fallback.
        homeScoredHome: 1.2,
        homeConcededHome: 1.1,
        awayScoredAway: 1.1,
        awayConcededAway: 1.2,
        bttsPctH: 0.75,
        bttsPctA: 0.72,
        csPctH: 0.15,
        csPctA: 0.2,
      })
    );
    const hit = report.patterns.find((p) => p.kind === "btts_banker");
    expect(hit).toBeDefined();
    expect(report.patterns.find((p) => p.kind === "goal_machine")).toBeUndefined();
    expect(hit?.recommendedFamily).toBe("btts");
    expect(hit?.recommendedSide).toBe("Yes");
    assertNoUnder(hit?.recommendedSide ?? null);
  });

  it("G4 does not fire when either side keeps clean sheets often (BTTS is strong but not banker-strong)", () => {
    const report = detectPatterns(
      base({
        bttsPctH: 0.75,
        bttsPctA: 0.72,
        csPctH: 0.5, // >= bbCsMax — a clean-sheet-prone side breaks the banker read
        csPctA: 0.2,
      })
    );
    expect(report.patterns.find((p) => p.kind === "btts_banker")).toBeUndefined();
  });

  it("G7 H2H Venue Dominance fires when one side won >=3 of the last 4 meetings at this venue → DNB", () => {
    const report = detectPatterns(
      base({
        h2hMeetings: [
          { result: "home_win", totalGoals: 2, btts: false, atCurrentVenue: true },
          { result: "home_win", totalGoals: 3, btts: true, atCurrentVenue: true },
          { result: "away_win", totalGoals: 1, btts: false, atCurrentVenue: true },
          { result: "home_win", totalGoals: 2, btts: false, atCurrentVenue: true },
        ],
      })
    );
    const hit = report.patterns.find((p) => p.kind === "h2h_dominance");
    expect(hit).toBeDefined();
    expect(hit?.side).toBe("home");
    expect(hit?.recommendedFamily).toBe("dnb");
    expect(hit?.recommendedSide).toBe("Home");
    assertNoUnder(hit?.recommendedSide ?? null);
  });

  it("G7 fires on an unbroken Over-2.5 H2H trend across >=4 meetings (any venue) → Over 2.5", () => {
    const report = detectPatterns(
      base({
        h2hMeetings: [
          { result: "home_win", totalGoals: 3, btts: true, atCurrentVenue: false },
          { result: "away_win", totalGoals: 4, btts: true, atCurrentVenue: false },
          { result: "draw", totalGoals: 3, btts: false, atCurrentVenue: false },
          { result: "home_win", totalGoals: 3, btts: true, atCurrentVenue: false },
        ],
      })
    );
    const hit = report.patterns.find((p) => p.kind === "h2h_dominance");
    expect(hit).toBeDefined();
    expect(hit?.recommendedFamily).toBe("goals_ou");
    expect(hit?.recommendedSide).toBe("Over 2.5");
  });

  it("G7 is NOT-EVALUABLE (no hit) without per-meeting H2H data — never inferred from the aggregate rate", () => {
    const report = detectPatterns(base({ h2hOversRate: 0.9 }));
    expect(report.patterns.find((p) => p.kind === "h2h_dominance")).toBeUndefined();
  });

  it("half_share fires on a fast-starting fixture (1H goal share well above league-neutral) → 1H Over", () => {
    const report = detectPatterns(base({ fhShareH: 0.65, fhShareA: 0.6 }));
    const hit = report.patterns.find((p) => p.kind === "half_share");
    expect(hit).toBeDefined();
    expect(hit?.recommendedSide).toBe("1H Over");
    assertNoUnder(hit?.recommendedSide ?? null);
  });

  it("half_share fires on a slow-starting fixture (1H goal share well below league-neutral) → 2H Over", () => {
    const report = detectPatterns(base({ fhShareH: 0.25, fhShareA: 0.3 }));
    const hit = report.patterns.find((p) => p.kind === "half_share");
    expect(hit).toBeDefined();
    expect(hit?.recommendedSide).toBe("2H Over");
  });

  it("half_share does not recommend the unpriceable HT/FT combo market (v6.2 §9.13)", () => {
    const report = detectPatterns(base({ fhShareH: 0.65, fhShareA: 0.6 }));
    const hit = report.patterns.find((p) => p.kind === "half_share");
    expect(hit?.recommendedFamily).toBe("goals_ou");
    expect(hit?.recommendedSide?.toLowerCase()).not.toContain("ht/ft");
  });
});

describe("detectPatterns — trap flags T1-T5 (v6.2 §2.5.2)", () => {
  // Trap flags contextualize a firing pattern (v6.2: they warn about a
  // specific green flag's reliability) — detectTrapFlags only runs when a
  // top pattern exists, so every case below pairs its trap fields with a
  // heavy_superior setup (same numbers as the earlier worked examples).
  const withPattern = (overrides: Partial<PatternInput>) =>
    base({
      homeScoredHome: 2.6,
      homeConcededHome: 0.5,
      awayScoredAway: 0.6,
      awayConcededAway: 2.4,
      ...overrides,
    });

  it("T1 Key Absence fires when a side's key player is reported out", () => {
    const report = detectPatterns(withPattern({ homeKeyPlayerOut: true }));
    expect(report.trapFlags.some((t) => t.kind === "T1")).toBe(true);
  });

  it("T2 Congestion fires on an asymmetric rest mismatch", () => {
    const report = detectPatterns(withPattern({ restDaysH: 2, restDaysA: 6 }));
    const t2 = report.trapFlags.find((t) => t.kind === "T2");
    expect(t2).toBeDefined();
    expect(t2?.text).toMatch(/home/i);
  });

  it("T2 falls back to the single restDaysMin threshold when only one side's rest is known", () => {
    const report = detectPatterns(withPattern({ restDaysMin: 1 }));
    expect(report.trapFlags.some((t) => t.kind === "T2")).toBe(true);
  });

  it("T3 H2H Anomaly fires when the favoured (pattern) side hasn't beaten this opponent in the last 3 meetings", () => {
    const report = detectPatterns(
      base({
        homeScoredHome: 2.6,
        homeConcededHome: 0.5,
        awayScoredAway: 0.6,
        awayConcededAway: 2.4, // heavy_superior, side=home
        h2hMeetings: [
          { result: "away_win", totalGoals: 2, btts: false, atCurrentVenue: false },
          { result: "draw", totalGoals: 1, btts: false, atCurrentVenue: false },
          { result: "away_win", totalGoals: 2, btts: false, atCurrentVenue: false },
        ],
      })
    );
    expect(report.topPattern?.side).toBe("home");
    expect(report.trapFlags.some((t) => t.kind === "T3")).toBe(true);
  });

  it("T4 Scoring Dip fires when the favoured side's recent scoring is well below its baseline", () => {
    const report = detectPatterns(
      base({
        homeScoredHome: 2.4,
        homeConcededHome: 0.5,
        awayScoredAway: 0.6,
        awayConcededAway: 2.3, // heavy_superior, side=home
        recentScoredH: 0.8, // <= 40% of the 2.4 baseline
      })
    );
    expect(report.topPattern?.side).toBe("home");
    const t4 = report.trapFlags.find((t) => t.kind === "T4");
    expect(t4).toBeDefined();
  });

  it("T5 False Favourite fires on a short-priced favourite with weak recent-form PPG", () => {
    const report = detectPatterns(withPattern({ homeOdds: 1.4, last5PtsH: 3 }));
    const t5 = report.trapFlags.find((t) => t.kind === "T5");
    expect(t5).toBeDefined();
    expect(t5?.text).toMatch(/home/i);
  });

  it("trapWarning is backward-compatible: mirrors trapFlags[0] when any T-series flag fired", () => {
    const report = detectPatterns(
      base({
        homeScoredHome: 2.6,
        homeConcededHome: 0.5,
        awayScoredAway: 0.6,
        awayConcededAway: 2.4,
        homeKeyPlayerOut: true,
      })
    );
    expect(report.trapWarning).toBe(report.trapFlags[0]?.text);
  });

  it("no trap flags fire on a clean, contradiction-free fixture", () => {
    const report = detectPatterns(
      base({
        homeScoredHome: 2.6,
        homeConcededHome: 0.5,
        awayScoredAway: 0.6,
        awayConcededAway: 2.4,
        nHome: 8,
        nAway: 8,
      })
    );
    expect(report.trapFlags).toHaveLength(0);
  });
});
