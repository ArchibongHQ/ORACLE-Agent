/** goals-market-analysis-prompt-v3 — runtime-layer unit tests: eligibility
 *  (§1), weighted completeness (§0.3), predictability ordering (§2), the
 *  slate arbiter (one-LLM-call review), and v3-mode accumulator selection. */

import { describe, expect, it, vi } from "vitest";
import type { BatchJobResult } from "../src/index.js";
import type { SportyBetEvent, SportyBetEventDetail } from "../src/selectFixtures.js";

vi.mock("@oracle/llm", () => ({
  callClaudeCode: vi.fn(),
}));
const { callClaudeCode } = await import("@oracle/llm");

const { classifyEligibility } = await import("../src/goalsV3/eligibility.js");
const { deriveLineHitRates, scoreCompleteness } = await import("../src/goalsV3/completeness.js");
const { scorePredictabilityV3 } = await import("../src/goalsV3/predictability.js");
const { reviewGoalsSlate, applySlateVerdicts, slateLegKey } = await import(
  "../src/goalsV3/slateArbiter.js"
);
const { selectGoalsAccumulator } = await import("../src/selectGoals.js");

function event(overrides: Partial<SportyBetEvent> = {}): SportyBetEvent {
  return {
    home: "Home FC",
    away: "Away FC",
    marketCount: 20,
    league: "Premier League",
    kickoff_utc: "2026-08-01T15:00:00Z",
    detail: {
      eventId: "sr:match:1",
      odds: {
        "1x2": { home: 1.8, draw: 3.6, away: 4.2 },
        ou25: { over: 1.9, under: 1.95 },
      },
      stats: {
        form: { home: { last5: "WWDLW" }, away: { last5: "LDWWL" } },
        goals: {
          home: { avg_scored: 1.8, avg_conceded: 1.0 },
          away: { avg_scored: 1.0, avg_conceded: 1.4 },
        },
        overunder: { home: { over25_pct: 0.55 }, away: { over25_pct: 0.5 } },
      },
    },
    ...overrides,
  };
}

describe("classifyEligibility (§1)", () => {
  it("discards SRL/virtual fixtures regardless of league", () => {
    const e = event({ league: "Premier League", home: "Simulated Reality League FC" });
    expect(classifyEligibility(e).status).toBe("discard");
    expect(classifyEligibility(e).reasons).toContain("srl_virtual");
  });

  it("[Wave-4 WS-A3] FIFA World Cup exact whitelist label passes with no off_whitelist annotation", () => {
    const e = event({ league: "FIFA World Cup" });
    const r = classifyEligibility(e);
    expect(r.status).toBe("eligible");
    expect(r.reasons).not.toContain("off_whitelist");
  });

  it("[Wave-4 WS-A3] a World-Cup-ish label off the exact whitelist string still passes eligibility, annotated off_whitelist only", () => {
    // The real regression this closes: a sidecar league label that reads as
    // "World Cup" but isn't the exact "FIFA World Cup" string in V3_WHITELIST
    // (e.g. Spain v Belgium under a non-exact label) used to hard-discard.
    const e = event({ league: "World Cup 2026 - Group Stage" });
    const r = classifyEligibility(e);
    expect(r.status).toBe("eligible");
    expect(r.reasons).toContain("off_whitelist");
  });

  it("[Wave-4 WS-A3] a fixture in a league not on the union whitelist is no longer discarded — off_whitelist annotation only", () => {
    const e = event({ league: "Some Made-Up Regional League" });
    const r = classifyEligibility(e);
    expect(r.status).toBe("eligible");
    expect(r.reasons).toContain("off_whitelist");
  });

  it("passes a whitelisted league with mandatory odds present", () => {
    const e = event({ league: "Premier League" });
    expect(classifyEligibility(e).status).toBe("eligible");
  });

  it("discards when mandatory odds (1X2 or O/U 2.5) are missing", () => {
    const e = event({
      detail: { eventId: "x", odds: { "1x2": { home: 1.8, draw: 3.6, away: 4.2 } } },
    });
    expect(classifyEligibility(e).status).toBe("discard");
    expect(classifyEligibility(e).reasons).toContain("missing_mandatory_odds");
  });

  it("flags youth/women fixtures as heightened, not discarded", () => {
    expect(classifyEligibility(event({ home: "Real Madrid U19" })).status).toBe("heightened");
    expect(classifyEligibility(event({ home: "England Women" })).status).toBe("heightened");
  });

  it("[Wave-4 WS-A3] friendly (club or international) → heightened + marketRestriction goals_over_only, not discarded", () => {
    const club = classifyEligibility(event({ league: "Club Friendly" }));
    expect(club.status).toBe("heightened");
    expect(club.reasons).toContain("friendly");
    expect(club.marketRestriction).toBe("goals_over_only");

    const intl = classifyEligibility(event({ league: "International Friendly" }));
    expect(intl.status).toBe("heightened");
    expect(intl.reasons).toContain("friendly");
    expect(intl.marketRestriction).toBe("goals_over_only");
  });

  it("[Wave-4 WS-A3] a non-friendly fixture carries no marketRestriction", () => {
    expect(
      classifyEligibility(event({ league: "Premier League" })).marketRestriction
    ).toBeUndefined();
  });

  it("[Wave-4 WS-A3] a low-scoring derby in a non-goals-rich league is heightened, not discarded", () => {
    const e = event({ league: "Premier League", home: "North London Derby FC" });
    const r = classifyEligibility(e);
    expect(r.status).toBe("heightened");
    expect(r.reasons).toContain("derby");
  });

  it("exempts international tournaments from the derby heightened flag", () => {
    const e = event({ league: "FIFA World Cup", home: "Derby County" });
    expect(classifyEligibility(e).status).not.toBe("discard");
    expect(classifyEligibility(e).reasons).not.toContain("derby");
  });
});

describe("scoreCompleteness (§0.3)", () => {
  it("scores exactly 70 (passes) with only the five mandatory fields present", () => {
    const c = scoreCompleteness(event().detail);
    expect(c.mandatoryMissing).toEqual([]);
    expect(c.score).toBe(70);
  });

  it("discards (flags mandatoryMissing) when a mandatory field is absent", () => {
    const detail: SportyBetEventDetail = {
      eventId: "x",
      odds: { "1x2": { home: 1.8, draw: 3.6, away: 4.2 }, ou25: { over: 1.9 } },
      // no stats block at all — form/scored/conceded/hitRate all missing
    };
    const c = scoreCompleteness(detail);
    // v4 default: hitRate is demoted out of the mandatory set (PR-4) — only
    // form/scored/conceded (the true v4 mandatory block) trigger the discard list.
    expect(c.mandatoryMissing).toEqual(expect.arrayContaining(["form", "scored", "conceded"]));
    expect(c.mandatoryMissing).not.toContain("hitRate");
    expect(c.score).toBeLessThan(70);
  });

  it("v4 (PR-4): a mandatory-only fixture (odds/form/scored/conceded, no hitRate) scores 60 and is discarded by the score floor, not by mandatoryMissing", () => {
    const detail: SportyBetEventDetail = {
      ...event().detail,
      stats: { ...event().detail!.stats, overunder: undefined },
    } as SportyBetEventDetail;
    const c = scoreCompleteness(detail);
    expect(c.mandatoryMissing).toEqual([]);
    expect(c.score).toBe(60);
    expect(c.penaltyFlags.hitRateMissing).toBe(true);
  });

  it("rollback flag: completenessV4=false restores hitRate to the mandatory (discard) set", () => {
    const detail: SportyBetEventDetail = {
      ...event().detail,
      stats: { ...event().detail!.stats, overunder: undefined },
    } as SportyBetEventDetail;
    const c = scoreCompleteness(detail, { completenessV4: false });
    expect(c.mandatoryMissing).toEqual(["hitRate"]);
    expect(c.score).toBe(60);
  });

  it("adds optional-tier points for xG, H2H, lineups, rest on top of the 70 base", () => {
    const detail: SportyBetEventDetail = {
      ...event().detail,
      stats: {
        ...event().detail!.stats,
        xg: { home: { xgf: 1.6, xga: 1.0, src: "understat" }, away: { xgf: 1.0, xga: 1.5 } },
        congestion: { home: { rest_days: 5 }, away: { rest_days: 6 } },
      },
    } as SportyBetEventDetail;
    const c = scoreCompleteness(detail, { h2hEnriched: true, lineupsAvailable: true });
    expect(c.score).toBe(100); // 70 mandatory + 10 xg + 10 h2h + 5 lineups + 5 rest
  });

  it("derives the xgEstimated penalty flag from a google_ai xG source", () => {
    const detail: SportyBetEventDetail = {
      ...event().detail,
      stats: {
        ...event().detail!.stats,
        xg: { home: { xgf: 1.6, src: "google_ai" }, away: { xgf: 1.0, src: "google_ai" } },
      },
    } as SportyBetEventDetail;
    const c = scoreCompleteness(detail);
    expect(c.penaltyFlags.xgEstimated).toBe(true);
    expect(c.penaltyFlags.xgMissing).toBe(false);
  });

  it("flags xgMissing when no xG block is present at all", () => {
    const c = scoreCompleteness(event().detail);
    expect(c.penaltyFlags.xgMissing).toBe(true);
  });
});

describe("deriveLineHitRates (§0.3 per-selection, PR-4)", () => {
  it("reports each line's hit-rate availability independently", () => {
    const detail: SportyBetEventDetail = {
      ...event().detail,
      stats: {
        ...event().detail!.stats,
        overunder: {
          home: { over15_pct: 0.8, over25_pct: 0.55 },
          away: { over15_pct: 0.75 }, // over25_pct missing on the away side only
        },
        scoringConceding: {
          home: { btts_rate: 0.5 },
          away: { btts_rate: 0.4 },
        },
      },
    } as SportyBetEventDetail;
    const rates = deriveLineHitRates(detail);
    expect(rates.over15).toBe(true);
    expect(rates.over25).toBe(false); // one side missing ⇒ not available
    expect(rates.over35).toBe(false); // neither side has it
    expect(rates.btts).toBe(true);
  });

  it("returns all-false when no overunder/scoringConceding stats exist", () => {
    const detail: SportyBetEventDetail = { eventId: "x" };
    const rates = deriveLineHitRates(detail);
    expect(rates).toEqual({ over15: false, over25: false, over35: false, btts: false });
  });
});

describe("scorePredictabilityV3 (§2, ordering only)", () => {
  it("awards points for a short home favourite and a defensive mismatch", () => {
    const score = scorePredictabilityV3(event());
    // home odds 1.8 is NOT < 1.6, so no favourite bonus; away conceded 1.4 is not
    // > 1.5 either — assert the function returns a sane non-negative number and
    // that tightening the inputs increases it (relative behavior, not a magic constant).
    expect(score).toBeGreaterThanOrEqual(0);
    const hotter = scorePredictabilityV3(
      event({
        detail: {
          ...event().detail,
          odds: { "1x2": { home: 1.5, draw: 4.0, away: 6.0 }, ou25: { over: 1.9 } },
          stats: {
            ...event().detail!.stats,
            goals: {
              home: { avg_scored: 2.0, avg_conceded: 1.9 },
              away: { avg_scored: 1.8, avg_conceded: 1.6 },
            },
            form: { home: { last5: "WWWWW", streak: 5 }, away: { last5: "LLLLL", streak: -5 } },
            congestion: { home: { rest_days: 2 }, away: { rest_days: 2 } },
          },
        } as SportyBetEventDetail,
      })
    );
    expect(hotter).toBeGreaterThan(score);
    expect(hotter).toBeLessThanOrEqual(100);
  });
});

describe("reviewGoalsSlate + applySlateVerdicts (slate arbiter)", () => {
  function job(home: string, away: string, mp = 0.8): BatchJobResult {
    return {
      status: "ok",
      analysisId: `a_${home}`,
      runId: "r1",
      fixtureId: `f_${home}`,
      home,
      away,
      league: "Premier League",
      kickoff: "2026-08-01T15:00:00Z",
      result: {
        fp: { home: 0.5, draw: 0.25, away: 0.25 },
        evMarkets: [
          {
            cat: "Goals O/U",
            label: "Over 1.5",
            market: "goals_ou",
            side: "Over 1.5",
            mp,
            modelProb: mp,
            ip: 0.6,
            rawEdge: mp - 0.6,
            ev: 0.1,
            odds: 1.5,
            stake: 0,
            stakeAmt: 0,
            rankingScore: 0.1,
            varianceMod: 1,
            v3: {
              rawEdge: mp - 0.6,
              penaltyPts: 0,
              adjustedEdge: mp - 0.6,
              tier: "high",
              q: 0.6,
              devigged: true,
              rationale: "test leg",
              sources: ["sportybet-gismo"],
              completeness: 90,
            },
          },
        ],
        oddsAvailable: true,
        bayesian_lH: 1.5,
        bayesian_lA: 1.0,
        expectedScoreline: "2-1",
        portfolioCorrelation: null,
        correlatedParlayRisk: null,
      },
      decision: {
        primaryPick: { market: "goals_ou", side: "Over 1.5", odds: 1.5 },
        confidence: mp,
        grade: "STRONG",
        rationale: "test",
        rejectedAndWhy: [],
      },
      decisionReplay: null,
      eligibleBets: [],
      primaryPick: null,
      llmEligible: true,
    } as unknown as BatchJobResult;
  }

  function selectionOf(jobs: BatchJobResult[]) {
    return selectGoalsAccumulator(jobs, { v3: true, target: 39 });
  }

  it("returns status=verified with empty verdicts when the slate is empty", async () => {
    const verdicts = await reviewGoalsSlate(selectionOf([]));
    expect(verdicts.status).toBe("verified");
    expect(verdicts.drops.size).toBe(0);
  });

  it("fails open (unverified, no changes) when callClaudeCode returns null", async () => {
    vi.mocked(callClaudeCode).mockResolvedValue(null);
    const selection = selectionOf([job("A", "B")]);
    const verdicts = await reviewGoalsSlate(selection);
    expect(verdicts.status).toBe("unverified");
    const applied = applySlateVerdicts(selection, verdicts);
    expect(applied).toBe(selection); // no-op when no drops/flags
  });

  it("fails open when the response is unparseable", async () => {
    vi.mocked(callClaudeCode).mockResolvedValue("not json");
    const verdicts = await reviewGoalsSlate(selectionOf([job("A", "B")]));
    expect(verdicts.status).toBe("unverified");
  });

  it("parses drops/flags and applySlateVerdicts removes the dropped leg everywhere", async () => {
    const selection = selectionOf([job("A", "B"), job("C", "D")]);
    // index 0 in the arbiter's numbered slate corresponds to whichever leg the
    // dedup pass lists first — assert on the leg's key instead of a fixed index.
    vi.mocked(callClaudeCode).mockResolvedValue(
      JSON.stringify({ drops: [{ i: 0, why: "dead rubber" }], flags: [] })
    );
    const verdicts = await reviewGoalsSlate(selection);
    expect(verdicts.status).toBe("verified");
    expect(verdicts.drops.size).toBe(1);
    const applied = applySlateVerdicts(selection, verdicts);
    for (const pool of [applied.legs, applied.shortSlipLegs]) {
      for (const leg of pool) {
        expect(verdicts.drops.has(slateLegKey(leg))).toBe(false);
      }
    }
  });
});

describe("selectGoalsAccumulator v3 mode — Output B/C and mini-ACCA", () => {
  function v3Job(
    home: string,
    away: string,
    league: string,
    label: string,
    odds: number,
    mp: number,
    adjustedEdge: number,
    tier: "very_high" | "high" | "medium" = "high",
    kickoff = "2026-08-01T15:00:00Z"
  ): BatchJobResult {
    return {
      status: "ok",
      analysisId: `a_${home}`,
      runId: "r1",
      fixtureId: `f_${home}`,
      home,
      away,
      league,
      kickoff,
      result: {
        fp: { home: 0.5, draw: 0.25, away: 0.25 },
        evMarkets: [
          {
            cat: "Goals O/U",
            label,
            market: "goals_ou",
            side: label,
            mp,
            modelProb: mp,
            ip: mp - adjustedEdge,
            rawEdge: adjustedEdge,
            ev: 0.1,
            odds,
            stake: 0,
            stakeAmt: 0,
            rankingScore: adjustedEdge,
            varianceMod: 1,
            v3: {
              rawEdge: adjustedEdge,
              penaltyPts: 0,
              adjustedEdge,
              tier,
              q: mp - adjustedEdge,
              devigged: true,
              rationale: "test",
              sources: ["sportybet-gismo"],
              completeness: 90,
            },
          },
        ],
        oddsAvailable: true,
        bayesian_lH: 1.5,
        bayesian_lA: 1.0,
        expectedScoreline: "2-1",
        portfolioCorrelation: null,
        correlatedParlayRisk: null,
      },
      decision: {
        primaryPick: { market: "goals_ou", side: label, odds },
        confidence: mp,
        grade: "STRONG",
        rationale: "test",
        rejectedAndWhy: [],
      },
      decisionReplay: null,
      eligibleBets: [],
      primaryPick: null,
      llmEligible: true,
    } as unknown as BatchJobResult;
  }

  it("Output B admits a high-odds/low-mp leg that would fail the 0.72 mp floor", () => {
    // odds=4.5, mp=0.30 — would NEVER qualify for the long/short slip (mp floor
    // 0.72) but is exactly the capped-edge-cap-compliant shape Output B must show.
    const jobs = [v3Job("A", "B", "Premier League", "Over 2.5", 4.5, 0.3, 0.08, "high")];
    const selection = selectGoalsAccumulator(jobs, { v3: true, target: 39 });
    expect(selection.outputBLegs.length).toBe(1);
    expect(selection.outputBLegs[0]!.mp).toBeLessThan(0.72);
    // The same low-mp leg must NOT appear in the mp-floored long slip.
    expect(selection.legs.length).toBe(0);
  });

  it("mini-ACCA fix regression: no more mislabeled 0.85 'correlation' haircut — cross-league legs (rho=0) resolve to the naive product via the same copula helper the long/short slips use", () => {
    const jobs = [
      v3Job("A", "B", "Premier League", "Over 1.5", 1.5, 0.8, 0.08),
      v3Job("C", "D", "La Liga", "Over 1.5", 1.6, 0.75, 0.07, "high", "2026-08-01T20:00:00Z"),
    ];
    const selection = selectGoalsAccumulator(jobs, { v3: true, target: 39 });
    expect(selection.miniAccaLegs.length).toBe(2);
    const naive = selection.miniAccaLegs.reduce((acc, l) => acc * l.mp, 1);
    // Different leagues -> pairwiseCrossFixtureCorrelation = 0 -> copulaJointProbability
    // skips the pair entirely and returns the plain independent product, no haircut.
    expect(selection.miniAccaCombinedProb).toBeCloseTo(naive, 10);
  });

  it("mini-ACCA fix regression: reports true EV at the combined offered price, surfacing parlay margin compounding", () => {
    const jobs = [
      v3Job("A", "B", "Premier League", "Over 1.5", 1.5, 0.8, 0.08),
      v3Job("C", "D", "La Liga", "Over 1.5", 1.6, 0.75, 0.07, "high", "2026-08-01T20:00:00Z"),
    ];
    const selection = selectGoalsAccumulator(jobs, { v3: true, target: 39 });
    const expectedEv = selection.miniAccaCombinedProb * selection.miniAccaCombinedOdds - 1;
    expect(selection.miniAccaTrueEv).toBeCloseTo(expectedEv, 10);
  });

  it("mini-ACCA rejects same-league legs even across different kickoffs", () => {
    const jobs = [
      v3Job("A", "B", "Premier League", "Over 1.5", 1.5, 0.8, 0.08, "high", "2026-08-01T15:00:00Z"),
      v3Job(
        "C",
        "D",
        "Premier League",
        "Over 1.5",
        1.6,
        0.75,
        0.07,
        "high",
        "2026-08-02T15:00:00Z"
      ),
    ];
    const selection = selectGoalsAccumulator(jobs, { v3: true, target: 39 });
    expect(selection.miniAccaLegs.length).toBe(1);
  });
});
