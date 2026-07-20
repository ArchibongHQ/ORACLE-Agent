import { describe, expect, it } from "vitest";
import {
  applyConcordance,
  detectPatterns,
  PATTERN_THRESHOLDS,
  type PatternHit,
  type PatternInput,
  type TrapFlag,
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

describe("detectPatterns — §2.5.4 overall-basis fallback (Phase 3, patterns-v62-core)", () => {
  it("heavy_superior fires on venue basis (or basis omitted) but needs a bigger gap on overall basis", () => {
    // gap = 2.2/game: clears the venue-basis bar (hsGapMin 2.0 / hsHomeNetMin
    // 1.0) but not the overall-tightened bar (2.0*1.3=2.6 / 1.0*1.3=1.3).
    const fixture = base({
      homeScoredHome: 1.6,
      homeConcededHome: 0.5,
      awayScoredAway: 0.3,
      awayConcededAway: 1.4,
    });
    const venueReport = detectPatterns(fixture);
    expect(venueReport.topPattern?.kind).toBe("heavy_superior");

    const omittedReport = detectPatterns({ ...fixture, basis: undefined });
    expect(omittedReport.topPattern?.kind).toBe("heavy_superior");

    const overallReport = detectPatterns({ ...fixture, basis: "overall" });
    expect(overallReport.topPattern).toBeNull();
  });

  it("a bigger gap still fires heavy_superior on overall basis, with a ° rationale marker", () => {
    const fixture = base({
      homeScoredHome: 1.8,
      homeConcededHome: 0.5,
      awayScoredAway: 0.2,
      awayConcededAway: 1.5,
      basis: "overall",
    });
    const report = detectPatterns(fixture);
    expect(report.topPattern?.kind).toBe("heavy_superior");
    expect(report.topPattern?.rationale).toContain("°");
    expect(report.topPattern?.rationale).toMatch(/overall-basis/);
  });

  it("venue basis (or omitted) never adds the ° marker", () => {
    const fixture = base({
      homeScoredHome: 1.8,
      homeConcededHome: 0.5,
      awayScoredAway: 0.2,
      awayConcededAway: 1.5,
    });
    const report = detectPatterns(fixture);
    expect(report.topPattern?.rationale).not.toContain("°");
  });

  it("confidence is capped at 'medium' on overall basis even when the same fixture's venue-basis confidence is high/very_high", () => {
    const strongFixture = base({
      homeScoredHome: 2.4,
      homeConcededHome: 0.6,
      awayScoredAway: 0.8,
      awayConcededAway: 2.2,
      ou25PctH: 0.8,
      ou25PctA: 0.6,
      homeOdds: 1.5,
      nHome: 10,
      nAway: 10,
    });
    const venueReport = detectPatterns(strongFixture);
    expect(venueReport.confidence === "high" || venueReport.confidence === "very_high").toBe(true);

    const overallReport = detectPatterns({ ...strongFixture, basis: "overall" });
    expect(overallReport.confidence).toBe("medium");
  });

  it("echoes PatternInput.basis onto PatternReport.basis — null when the caller never set it, even with no pattern firing", () => {
    expect(detectPatterns(base({ basis: "venue" })).basis).toBe("venue");
    expect(detectPatterns(base({ basis: "overall" })).basis).toBe("overall");
    expect(detectPatterns(base()).basis).toBeNull();
  });

  it("corner_kings is NOT tightened by overall basis — its data (corners) has independent provenance from the venue-split goal fields", () => {
    const fixture = base({
      cornersForH: 8,
      cornersAgainstH: 3,
      cornersForA: 5,
      cornersAgainstA: 7,
    });
    const venueReport = detectPatterns(fixture);
    const overallReport = detectPatterns({ ...fixture, basis: "overall" });
    expect(venueReport.topPattern?.kind).toBe("corner_kings");
    expect(overallReport.topPattern?.kind).toBe("corner_kings");
    expect(overallReport.topPattern?.score).toBe(venueReport.topPattern?.score);
    expect(overallReport.topPattern?.rationale).not.toContain("°");
  });

  it("goal_machine fires on venue basis but needs a higher total/ou25% on overall basis", () => {
    // expTotal=2.75: clears venue's gmExpTotalMin(2.7) but not overall's
    // (2.7*1.1=2.97). ou25PctH=0.72: clears venue's gmOu25Min(0.7) but not
    // overall's (0.7+0.05=0.75).
    const fixture = base({
      homeScoredHome: 1.5,
      homeConcededHome: 1.3,
      awayScoredAway: 1.3,
      awayConcededAway: 1.4,
      ou25PctH: 0.72,
    });
    const venueReport = detectPatterns(fixture);
    expect(venueReport.topPattern?.kind).toBe("goal_machine");

    const overallReport = detectPatterns({ ...fixture, basis: "overall" });
    expect(overallReport.topPattern).toBeNull();
  });

  it("btts_banker fires on venue basis but needs a higher BTTS% on overall basis", () => {
    // bttsPctH/A=0.72: clears venue's bbBttsMin(0.7) but not overall's
    // (0.7+0.05=0.75). csPctH/A=0.3 clears both csMax bars regardless.
    const fixture = base({ bttsPctH: 0.72, bttsPctA: 0.72, csPctH: 0.3, csPctA: 0.3 });
    const venueReport = detectPatterns(fixture);
    expect(venueReport.topPattern?.kind).toBe("btts_banker");

    const overallReport = detectPatterns({ ...fixture, basis: "overall" });
    expect(overallReport.topPattern).toBeNull();
  });

  it("anomaly fires on venue basis but needs a bigger gap/odds mismatch on overall basis", () => {
    // netGap=1.1: clears venue's anomalyNetGapMin(1.0) but not overall's
    // (1.0*1.3=1.3). homeOdds=2.25: clears venue's anomalyUnderpricedOdds(2.2)
    // but not overall's (2.2+0.15=2.35).
    const fixture = base({
      homeScoredHome: 1.8,
      homeConcededHome: 1.0,
      awayScoredAway: 0.9,
      awayConcededAway: 1.2,
      homeOdds: 2.25,
    });
    const venueReport = detectPatterns(fixture);
    expect(venueReport.topPattern?.kind).toBe("anomaly");

    const overallReport = detectPatterns({ ...fixture, basis: "overall" });
    expect(overallReport.topPattern).toBeNull();
  });

  it("combined mechanisms in one detectPatterns() call: overall-basis cap wins over a concordance lift, and a discordant T4 is promoted ahead of a non-discordant T1", () => {
    // Same "bigger gap still fires on overall basis" heavy_superior setup,
    // PLUS a second, independently-derived home-side signal (anomaly via
    // streak) for concordance, PLUS both a T1 (key absence) and a T4
    // (scoring dip) trap.
    const fixture = base({
      homeScoredHome: 1.8,
      homeConcededHome: 0.5,
      awayScoredAway: 0.2,
      awayConcededAway: 1.5,
      streakH: 5, // clears anomaly's streakMin on both venue(3) and overall(4+1)
      homeKeyPlayerOut: true, // T1 — non-discordant
      recentScoredH: 0.5, // <= 1.8*0.4 baseline — T4, discordant (favours home)
    });

    const venueReport = detectPatterns(fixture);
    expect(venueReport.patterns.some((p) => p.kind === "anomaly" && p.side === "home")).toBe(true);
    // Concordance (2 home-side patterns) should be ELIGIBLE to lift venue-basis
    // confidence — confirms this fixture actually exercises concordance, not
    // just the overall-basis cap alone.
    expect(venueReport.confidence === "high" || venueReport.confidence === "very_high").toBe(true);
    expect(venueReport.trapFlags[0]?.kind).toBe("T4"); // discordant, promoted ahead of T1

    const overallReport = detectPatterns({ ...fixture, basis: "overall" });
    // The overall-basis cap wins even though concordance would otherwise lift
    // it further — "no confidence uplift on overall basis" holds under ANY
    // combination of mechanisms, not just in isolation.
    expect(overallReport.confidence).toBe("medium");
    expect(overallReport.trapFlags[0]?.kind).toBe("T4");
    expect(overallReport.trapFlags[1]?.kind).toBe("T1");
  });
});

describe("applyConcordance (Phase 3, v6.2 §5.9 concordance/discordance)", () => {
  const topHome: PatternHit = {
    kind: "heavy_superior",
    score: 0.6,
    side: "home",
    recommendedFamily: "asian_handicap",
    recommendedSide: "Home",
    rationale: "test top pattern",
  };
  const secondHomeHit: PatternHit = {
    kind: "anomaly",
    score: 0.5,
    side: "home",
    recommendedFamily: "dnb",
    recommendedSide: "Home",
    rationale: "test corroborating hit",
  };
  const awayHit: PatternHit = {
    kind: "anomaly",
    score: 0.5,
    side: "away",
    recommendedFamily: "dnb",
    recommendedSide: "Away",
    rationale: "test opposite-side hit",
  };
  const neutralHit: PatternHit = {
    kind: "goal_machine",
    score: 0.5,
    recommendedFamily: "goals_ou",
    recommendedSide: "Over 2.5",
    rationale: "test side-neutral hit",
  };

  it("lifts confidence one band when a second pattern shares the top pattern's side", () => {
    const result = applyConcordance([topHome, secondHomeHit], topHome, 0.5, "medium", []);
    expect(result.confidence).toBe("high");
  });

  it("caps the lift at very_high — never overflows past the top band", () => {
    const result = applyConcordance([topHome, secondHomeHit], topHome, 0.5, "very_high", []);
    expect(result.confidence).toBe("very_high");
  });

  it("does not lift when only the top pattern itself carries that side (no second corroborating hit)", () => {
    const result = applyConcordance([topHome], topHome, 0.5, "medium", []);
    expect(result.confidence).toBe("medium");
  });

  it("does not lift when a second pattern fires on the OPPOSITE side", () => {
    const result = applyConcordance([topHome, awayHit], topHome, 0.5, "medium", []);
    expect(result.confidence).toBe("medium");
  });

  it("does not lift when a second pattern fires but is side-neutral (no .side at all)", () => {
    const result = applyConcordance([topHome, neutralHit], topHome, 0.5, "medium", []);
    expect(result.confidence).toBe("medium");
  });

  it("never lifts a null confidence — nothing to lift below confMedium", () => {
    const result = applyConcordance([topHome, secondHomeHit], topHome, 0.1, null, []);
    expect(result.confidence).toBeNull();
  });

  it("a discordant trap (T3/T4/T5) costs a 0.01 (1pt) strength penalty", () => {
    const t4: TrapFlag = { kind: "T4", text: "scoring dip" };
    const result = applyConcordance([topHome], topHome, 0.5, "medium", [t4]);
    expect(result.strength).toBeCloseTo(0.49, 5);
  });

  it("the strength penalty clamps at 0 — never goes negative", () => {
    const t4: TrapFlag = { kind: "T4", text: "scoring dip" };
    const result = applyConcordance([topHome], topHome, 0.005, "medium", [t4]);
    expect(result.strength).toBe(0);
  });

  it("a discordant trap is promoted to trapFlags[0] ahead of a non-discordant (T1) trap that fired first", () => {
    const t1: TrapFlag = { kind: "T1", text: "key absence" };
    const t4: TrapFlag = { kind: "T4", text: "scoring dip" };
    const result = applyConcordance([topHome], topHome, 0.5, "medium", [t1, t4]);
    expect(result.trapFlags[0]).toBe(t4);
    expect(result.trapFlags[1]).toBe(t1);
  });

  it("T1/T2 (non-discordant) never cost a strength penalty or reorder anything on their own", () => {
    const t1: TrapFlag = { kind: "T1", text: "key absence" };
    const t2: TrapFlag = { kind: "T2", text: "congestion" };
    const result = applyConcordance([topHome], topHome, 0.5, "medium", [t1, t2]);
    expect(result.strength).toBe(0.5);
    expect(result.trapFlags).toEqual([t1, t2]);
  });

  it("no trap flags at all: strength/trapFlags pass through unchanged", () => {
    const result = applyConcordance([topHome], topHome, 0.5, "medium", []);
    expect(result.strength).toBe(0.5);
    expect(result.trapFlags).toEqual([]);
  });
});
