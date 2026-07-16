/** [patterns-engine Wave 2, Phase 3] Coverage for analyzeFixtureMarkets.ts's
 *  "Under -> Asian Handicap pivot" — the owner rule that NO goals_ou/
 *  team_total "Under" outcome may ever reach `evMarkets`/`best`, regardless of
 *  how strong its edge is. Exercises the unconditional splice block right
 *  before `evMarkets.sort(...)` in analyzeFixtureMarketsV3 (search that file
 *  for the comment "[patterns-engine Wave 2, Phase 3] Under -> Asian Handicap
 *  pivot"). This is flag-independent (no ORACLE_V3_PATTERNS gate) — every
 *  fixture below deliberately omits `blendPricing`/`v3Patterns` entirely so
 *  gating runs on the PLAIN (unblended) CLASS_GATE table (evGate.ts), not the
 *  CLASS_GATE_BLEND rescaled bars; the blend-path math is already covered by
 *  blendGate.test.ts/patternGate.test.ts and Phase 3's strip runs identically
 *  either way (it splices evMarkets AFTER both gating branches have already
 *  run, so which table gated a candidate is irrelevant to this suite).
 *
 *  ── Fixture derivation ──────────────────────────────────────────────────
 *  Both fixtures below use league "__unknown_league__" (execution/index.ts's
 *  LEAGUE_PARAMS.Default: homeAvg=1.45, awayAvg=1.15 -> per-team L=1.3, same
 *  fallback patternsIntegration.test.ts's own goalMachineInput relies on),
 *  dynamicRho:0 (buildMatrix's dixonColesTau returns exactly 1.0 whenever
 *  rho===0 — pure independent-Poisson grid, no Dixon-Coles adjustment) and
 *  nHome/nAway=10 (>= goalsV3/lambda.ts's SHRINK_N=8, so the small-sample λ
 *  shrink is a no-op). devigged1x2:null makes goalsV3/matchShape.ts's
 *  deriveMatchShape fall back to the goals-model's own split ("ratio" source)
 *  — the ODDS-anchored split (shapeGrid, used by team_total/BTTS) then equals
 *  the STATS split (statsGrid, used by goals_ou/asian_handicap) exactly, so
 *  every market below prices off literally the same lambdaHome/lambdaAway
 *  pair regardless of which split its engine nominally reads.
 *
 *  FIXTURE_A: homeScoredPer90=1.95, homeConcededPer90=1.0,
 *  awayScoredPer90=0.39, awayConcededPer90=1.0. goalsV3/lambda.ts's
 *  multiplicative formula (scored*oppConceded/L) gives
 *  lambdaHome = 1.95*1.0/1.3 = 1.5, lambdaAway = 0.39*1.0/1.3 = 0.3 ->
 *  mu = 1.8 (a low-scoring match, home dominant 5x). mu=1.8 >= 1.5 keeps
 *  math/index.ts buildMatrix's zip-boost condition (totalXG<1.5) false, so
 *  the grid is pure unboosted independent Poisson.
 *
 *  FIXTURE_B: homeScoredPer90=1.3, homeConcededPer90=0.8,
 *  awayScoredPer90=1.3, awayConcededPer90=1.0 -> lambdaHome=1.0,
 *  lambdaAway=0.8, mu=1.8 too — the SAME total as FIXTURE_A (so the goals_ou
 *  Over/Under market below is byte-identical across both fixtures: the sum of
 *  two independent Poissons is Poisson(mu), which depends only on mu, not the
 *  home/away split) but a far less lopsided split, so BTTS "Yes" has a real,
 *  non-vanishing true probability (needed for scenario 3 below).
 *
 *  True probabilities used (independent-Poisson closed forms, hand-verified
 *  against a standalone script replicating poissonPMF/buildMatrix/devigTwoWay/
 *  gateAllMarkets's plain CLASS_GATE branch bit-for-bit before this file was
 *  written — every "done"/"below_gate" outcome asserted below has a >=0.019
 *  probability-point margin on whichever bar/cap is tightest):
 *    - P(total goals < 2.5) = 0.73062 (both fixtures, mu=1.8 only).
 *    - P(home win), FIXTURE_A (lambdaHome=1.5, lambdaAway=0.3) = 0.68039;
 *      "Home (-0.5)"/"Away (+0.5)" are whole-ball-adjacent half lines (no
 *      push possible) that price as exactly P(home win)/P(not home win).
 *    - P(home goals < 1.5), FIXTURE_A = 0.55783 (marginal Poisson(1.5)).
 *    - P(both teams score), FIXTURE_B (lambdaHome=1.0, lambdaAway=0.8) =
 *      (1-e^-1.0)*(1-e^-0.8) = 0.34809 (independent grid factorises).
 *
 *  Odds below are chosen so each target outcome's rawEdge lands comfortably
 *  BETWEEN the noise gate (0.02) and the class-M/L edge floor (0.05/0.06) on
 *  one side and the ABSOLUTE edge cap (0.12, evGate.ts's V3_EDGE_CAP_DEFAULT)
 *  on the other — a genuinely wide mispricing (e.g. odds far above fair, as a
 *  naive "more generous is safer" instinct might suggest) would in fact push
 *  rawEdge past 0.12 and get CAPPED (outcome "capped", not "done") rather than
 *  admitted, since the plain CLASS_GATE bars are denominated in raw
 *  probability points, not the much smaller CLASS_GATE_BLEND points. Every
 *  odds pair below was picked to leave a >=0.019 margin on every applicable
 *  bar/cap simultaneously (edge floor, absolute cap, and — where class L
 *  applies — the EV% floor and the relative cap) — see the header derivation
 *  above; the complementary side of every 2-way market is asserted to fail
 *  the gate on its own (large negative margin), so it can never contaminate
 *  `best`. */

import {
  type AllMarketEntry,
  analyzeFixtureMarketsV3,
  dirOfDesc,
  type V3AllMarketsInput,
} from "@oracle/engine";
import { describe, expect, it } from "vitest";
import { TOTALS_FAMILIES } from "../src/marketsV3/sanity.js";

// Over/Under (goals_ou), catalog id 18. Under 2.5 @ 1.55 vs Over 2.5 @ 2.82:
// q_under ~= 0.6452 (additive devig) -> rawEdge ~= 0.7306-0.6452 = 0.0853
// (class M since 1.55 is in (1.50,3.00]; M's bar is 0.05, margin +0.035; cap
// margin 0.12-0.0853=+0.035) -- "done" with comfortable room on both sides.
// The complementary Over 2.5 leg (q~=0.3547) carries rawEdge ~= -0.0853,
// nowhere near any bar -- "below_gate" by a wide margin, so it never survives
// to contest `best`. Reused byte-identically across FIXTURE_A and FIXTURE_B
// (see header -- both share mu=1.8).
const TOTALS_MARKET: AllMarketEntry = {
  id: "18",
  name: "Over/Under",
  specifier: "total=2.5",
  outcomes: [
    { id: "1", desc: "Over 2.5", odds: "2.82" },
    { id: "2", desc: "Under 2.5", odds: "1.55" },
  ],
};

// Handicap (asian_handicap), catalog id 16, whole-ball line -0.5 (no push
// possible on a half-ball line). Home (-0.5) @ 1.68 vs Away (+0.5) @ 2.47:
// q_home ~= 0.5952 -> rawEdge ~= 0.6804-0.5952 = 0.0852 (class M, bar margin
// +0.035, cap margin +0.035) -- "done". Away (+0.5) (q~=0.4048) carries
// rawEdge ~= -0.0852 -- "below_gate" by a wide margin. FIXTURE_A only (the
// AH pick this suite's scenario 1 needs to survive as `best`).
const HANDICAP_MARKET: AllMarketEntry = {
  id: "16",
  name: "Handicap",
  specifier: "hcp=-0.5",
  outcomes: [
    { id: "1", desc: "Home (-0.5)", odds: "1.68" },
    { id: "2", desc: "Away (+0.5)", odds: "2.47" },
  ],
};

// Home O/U (team_total), catalog id 19 -- the HOME side's own goal total
// (shape engine, side derived from the market name containing "home").
// Under 1.5 @ 2.11 vs Over 1.5 @ 1.90: q_under ~= 0.4738 -> rawEdge ~=
// 0.5578-0.4738 = 0.0840 (class M, bar margin +0.034, cap margin +0.036) --
// "done". Over 1.5 (q~=0.5262) carries rawEdge ~= -0.0840 -- "below_gate".
// FIXTURE_A only.
const TEAM_TOTAL_MARKET: AllMarketEntry = {
  id: "19",
  name: "Home O/U",
  specifier: "total=1.5",
  outcomes: [
    { id: "1", desc: "Over 1.5", odds: "1.90" },
    { id: "2", desc: "Under 1.5", odds: "2.11" },
  ],
};

// GG/NG (btts), catalog id 29. Yes @ 3.87 vs No @ 1.35 against FIXTURE_B's
// true P(BTTS)=0.34809: q_yes ~= 0.2588 -> rawEdge ~= 0.0893 (class L since
// 3.87>3.00; L's edge bar is 0.06, margin +0.029; L's EV% bar is 15%, actual
// ~34.5%, margin +19.5pts; the relative cap trips only when rawEdge/q>0.4 --
// here it's ~0.345, margin +0.055 below that; absolute cap margin
// 0.12-0.0893=+0.031) -- "done" with every applicable bar/cap cleared with
// room to spare. No (q~=0.7412) carries rawEdge ~= -0.0893 -- "below_gate".
// FIXTURE_B only (no Handicap market is offered alongside it -- scenario 3
// needs it structurally impossible for an AH pick to exist).
const BTTS_MARKET: AllMarketEntry = {
  id: "29",
  name: "GG/NG",
  outcomes: [
    { id: "1", desc: "Yes", odds: "3.87" },
    { id: "2", desc: "No", odds: "1.35" },
  ],
};

/** FIXTURE_B's own hand-derived true P(BTTS Yes) -- see file header. Supplied
 *  back into empirical.bttsPctH/bttsPctA below (both sides equal to this
 *  exact value) so shape.ts's empirical blend
 *  (P_final = (1-w)*model + w*empirical) is an EXACT no-op regardless of
 *  blend weight w (model and empirical are numerically identical), while
 *  still avoiding the -0.01 marketStatMissing penalty shape.ts's withBlend
 *  applies whenever the empirical rate is undefined -- the fixture's BTTS
 *  pricing stays exactly the pure-model value derived in the header with
 *  zero perturbation and zero penalty. */
const BTTS_YES_MODEL_P = 0.348090483;

interface LambdaProfile {
  homeScoredPer90: number;
  homeConcededPer90: number;
  awayScoredPer90: number;
  awayConcededPer90: number;
}

// lambdaHome = homeScoredPer90*awayConcededPer90/L = 1.95*1.0/1.3 = 1.5
// lambdaAway = awayScoredPer90*homeConcededPer90/L = 0.39*1.0/1.3 = 0.3
const FIXTURE_A: LambdaProfile = {
  homeScoredPer90: 1.95,
  homeConcededPer90: 1.0,
  awayScoredPer90: 0.39,
  awayConcededPer90: 1.0,
};

// lambdaHome = 1.3*1.0/1.3 = 1.0 ; lambdaAway = 1.3*0.8/1.3 = 0.8
const FIXTURE_B: LambdaProfile = {
  homeScoredPer90: 1.3,
  homeConcededPer90: 0.8,
  awayScoredPer90: 1.3,
  awayConcededPer90: 1.0,
};

function buildInput(profile: LambdaProfile, allMarkets: AllMarketEntry[]): V3AllMarketsInput {
  return {
    fixtureId: "f-under-ah-pivot",
    runId: "r-under-ah-pivot",
    home: "Home FC",
    away: "Away FC",
    league: "__unknown_league__",
    kickoff: new Date().toISOString(),
    lambdaInput: {
      league: "__unknown_league__",
      ...profile,
      nHome: 10,
      nAway: 10,
    },
    // Ratio fallback (goals-model split kept as-is) -- shapeGrid == statsGrid
    // exactly, see file header.
    devigged1x2: null,
    allMarkets,
    penaltyFlags: {},
    // rho=0 -> dixonColesTau===1 everywhere (no Dixon-Coles adjustment); both
    // fixtures' mu=1.8 also keeps buildMatrix's zip-boost condition
    // (totalXG<1.5) false regardless.
    dynamicRho: 0,
    empirical: {
      // Present only to null out engines/totals.ts's goals_ou marketStatMissing
      // -1pt penalty (ouHitRateMissing checks presence unconditionally,
      // independent of totalsEmpirical below) -- VALUES don't matter since
      // totalsEmpirical:false (next field) keeps the O/U pricer model-only.
      // Same convention patternsIntegration.test.ts's goalMachineInput uses.
      ou25PctH: 0.5,
      ou25PctA: 0.5,
      // See BTTS_YES_MODEL_P's own comment -- exact no-op blend + no penalty.
      // Harmless when BTTS_MARKET isn't in `allMarkets` for a given fixture.
      bttsPctH: BTTS_YES_MODEL_P,
      bttsPctA: BTTS_YES_MODEL_P,
      nH: 10,
      nA: 10,
    },
    totalsEmpirical: false,
    // blendPricing/v3Patterns intentionally omitted: this suite exercises the
    // plain (unblended) CLASS_GATE path deliberately (see file header) --
    // Phase 3's strip is unconditional and flag-independent, so the blend
    // math itself doesn't need re-covering here (blendGate.test.ts/
    // patternGate.test.ts already do).
  };
}

type Result = NonNullable<ReturnType<typeof analyzeFixtureMarketsV3>>;

function findAssessment(result: Result, family: string, desc: string) {
  const a = result.assessments.find((x) => x.family === family && x.desc === desc);
  if (!a) throw new Error(`no assessment for family=${family} desc=${desc}`);
  return a;
}

describe("analyzeFixtureMarketsV3 — Under -> AH pivot (Wave 2, Phase 3)", () => {
  it("a genuinely gate-clearing Under is stripped from evMarkets but a genuinely gate-clearing real Asian Handicap pick survives as best", () => {
    const result = analyzeFixtureMarketsV3(buildInput(FIXTURE_A, [TOTALS_MARKET, HANDICAP_MARKET]));
    expect(result).not.toBeNull();
    const r = result!;

    // (a) sanity: the Under WOULD have qualified on its own honest merit.
    const under = findAssessment(r, "goals_ou", "Under 2.5");
    expect(under.outcome).toBe("done");

    // (b) ...yet it is absent from evMarkets: neither the exact side...
    expect(r.evMarkets.some((m) => m.family === "goals_ou" && m.side === "Under 2.5")).toBe(false);
    // ...nor ANY entry whose family+direction matches the kill rule
    // (isKilledUnder's own definition, mirrored here).
    expect(
      r.evMarkets.some(
        (m) => !!m.family && TOTALS_FAMILIES.has(m.family) && dirOfDesc(m.side ?? "") === "under"
      )
    ).toBe(false);

    // (c) best is non-null and is NOT an Under.
    expect(r.best).not.toBeNull();
    expect(dirOfDesc(r.best!.side ?? "")).not.toBe("under");

    // (d) the real, honestly-priced Asian Handicap pick is present in
    // evMarkets and is exactly what survived as best -- nothing fabricated,
    // nothing dropped in its place.
    const ahMarket = r.evMarkets.find((m) => m.family === "asian_handicap");
    expect(ahMarket).toBeDefined();
    expect(r.evMarkets).toHaveLength(1); // Over 2.5 / Away (+0.5) both fail the gate on their own merit
    expect(r.best).toBe(ahMarket);
    expect(r.best!.side).toBe("Home (-0.5)");
  });

  it("team_total Under (Home O/U, catalog id 19) is also stripped, not just goals_ou", () => {
    const result = analyzeFixtureMarketsV3(buildInput(FIXTURE_A, [TEAM_TOTAL_MARKET]));
    expect(result).not.toBeNull();
    const r = result!;

    // Sanity: Home O/U's Under 1.5 WOULD have qualified on its own merit.
    const under = findAssessment(r, "team_total", "Under 1.5");
    expect(under.outcome).toBe("done");

    expect(r.evMarkets.some((m) => m.family === "team_total" && m.side === "Under 1.5")).toBe(
      false
    );
    // Nothing else was offered in this fixture's catalogue (Over 1.5 fails
    // the gate on its own, per the file header), so the strip leaves
    // evMarkets empty and best null -- same "never fabricate" outcome as
    // scenario 4 below, for the OTHER TOTALS_FAMILIES member.
    expect(r.evMarkets).toEqual([]);
    expect(r.best).toBeNull();
  });

  it("never drop: when no real AH pick clears the gate but another non-Under market does, that other market becomes best", () => {
    const result = analyzeFixtureMarketsV3(buildInput(FIXTURE_B, [TOTALS_MARKET, BTTS_MARKET]));
    expect(result).not.toBeNull();
    const r = result!;

    // Sanity: both the Under and the BTTS "Yes" candidate genuinely clear
    // the gate on their own merit in this fixture.
    const under = findAssessment(r, "goals_ou", "Under 2.5");
    expect(under.outcome).toBe("done");
    const yes = findAssessment(r, "btts", "Yes");
    expect(yes.outcome).toBe("done");

    // No Under anywhere in evMarkets...
    expect(r.evMarkets.some((m) => m.family === "goals_ou")).toBe(false);
    // ...and no Handicap/asian_handicap candidate could possibly exist --
    // this fixture's allMarkets carries no such entry at all.
    expect(r.evMarkets.every((m) => m.family !== "asian_handicap")).toBe(true);

    // The genuine survivor (BTTS, not specifically AH) becomes best.
    expect(r.best).not.toBeNull();
    expect(r.best!.family).toBe("btts");
    expect(r.best!.side).toBe("Yes");
  });

  it("never fabricate: when the Under is the ONLY candidate that clears the gate anywhere in the fixture, evMarkets ends up empty and best is null", () => {
    const result = analyzeFixtureMarketsV3(buildInput(FIXTURE_A, [TOTALS_MARKET]));
    expect(result).not.toBeNull();
    const r = result!;

    const under = findAssessment(r, "goals_ou", "Under 2.5");
    expect(under.outcome).toBe("done");
    // The complementary Over 2.5 leg never clears the gate on its own (see
    // file header) -- nothing else in this fixture's catalogue could survive.
    const over = findAssessment(r, "goals_ou", "Over 2.5");
    expect(over.outcome).not.toBe("done");

    // The strip leaves evMarkets empty -- "no bet", never a fabricated
    // replacement and never the banned Under slipping through.
    expect(r.evMarkets).toEqual([]);
    expect(r.best).toBeNull();
  });

  it("Under assessments remain visible in `assessments` (and can be outcome:'done') for transparency even though they never reach evMarkets", () => {
    const result = analyzeFixtureMarketsV3(buildInput(FIXTURE_A, [TOTALS_MARKET, HANDICAP_MARKET]));
    expect(result).not.toBeNull();
    const r = result!;

    expect(
      r.assessments.some(
        (a) => a.family === "goals_ou" && a.desc === "Under 2.5" && a.outcome === "done"
      )
    ).toBe(true);

    // Cross-check against scenario 1's own evMarkets exclusion, in the same
    // result object, to make the "assessments untouched, evMarkets spliced"
    // contrast explicit in one place.
    expect(r.evMarkets.some((m) => m.family === "goals_ou" && m.side === "Under 2.5")).toBe(false);
  });
});
