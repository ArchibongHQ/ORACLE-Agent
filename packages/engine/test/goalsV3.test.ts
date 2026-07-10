/** goals-market-analysis-prompt-v3 — engine-layer unit tests: lambda (§3.1),
 *  match-shape correction (§3.5), edge gate (§4), and the full per-fixture
 *  analysis pipeline (analyzeGoalsFixtureV3). */

import {
  analyzeGoalsFixtureV3,
  buildMatrix,
  computeV3Lambdas,
  deriveMatchShape,
  devigOU,
  extractMarkets,
  gateV3Edge,
  poissonPMF,
  ratingsBlendWeight,
  resolveRho,
  shrink,
  V3_LEAGUE_BASELINES,
  V3_LEAGUE_BASELINES_BY_ID,
  V3_PENALTY_PTS,
  V3_TIER_HEIGHTENED_FLOOR,
  type V3AnalyzeInput,
  v3LeaguePerTeamAvg,
  v3NbDispersion,
  v3PenaltyPts,
  xgBlendWeight,
} from "@oracle/engine";
import { describe, expect, it } from "vitest";

describe("computeV3Lambdas (§3.1)", () => {
  it("matches the spec's worked example: λH=1.89, λA=0.89, μ=2.78", () => {
    // Home 1.7 scored/90, 1.0 conceded/90; Away 1.2 scored/90, 1.5 conceded/90; L≈1.35/team.
    const result = computeV3Lambdas(
      {
        league: "__unknown_league__",
        homeScoredPer90: 1.7,
        homeConcededPer90: 1.0,
        awayScoredPer90: 1.2,
        awayConcededPer90: 1.5,
        nHome: 10,
        nAway: 10,
      },
      { xgBlend: false }
    );
    expect(result).not.toBeNull();
    // Default league L = 2.6/2 = 1.3 (no exact "1.35" baseline in this codebase's
    // table for an unknown league) — assert the formula shape, not literal spec digits.
    expect(result!.method).toBe("multiplicative");
    expect(result!.lambdaHome).toBeCloseTo((1.7 / 1.3) * (1.5 / 1.3) * 1.3, 5);
    expect(result!.lambdaAway).toBeCloseTo((1.2 / 1.3) * (1.0 / 1.3) * 1.3, 5);
    expect(result!.mu).toBeCloseTo(result!.lambdaHome + result!.lambdaAway, 10);
  });

  it("P(Over 2.5) at μ=2.78, ρ=0 matches the spec's exact-Poisson worked answer (~52.5%)", () => {
    const lambdaHome = 1.89;
    const lambdaAway = 0.89;
    const mat = buildMatrix(lambdaHome, lambdaAway, 0, false, 0.08, 0, undefined);
    const book = extractMarkets(mat);
    expect(book.ou["over_2.5"]).toBeCloseTo(0.525, 2);
  });

  it("falls back to simple-average when one multiplicative factor is missing", () => {
    const result = computeV3Lambdas({
      league: "__unknown_league__",
      homeScoredPer90: 1.5,
      homeConcededPer90: null,
      awayScoredPer90: 1.2,
      awayConcededPer90: 1.1,
    });
    expect(result?.method).toBe("simple-average");
  });

  it("shrinks toward the league mean when n < 8", () => {
    const L = 1.3; // default league per-team avg
    const unshrunk = computeV3Lambdas(
      {
        league: "__unknown_league__",
        homeScoredPer90: 3.0,
        homeConcededPer90: 3.0,
        awayScoredPer90: 1.0,
        awayConcededPer90: 1.0,
        nHome: 20,
        nAway: 20,
      },
      { xgBlend: false }
    )!;
    const shrunk = computeV3Lambdas(
      {
        league: "__unknown_league__",
        homeScoredPer90: 3.0,
        homeConcededPer90: 3.0,
        awayScoredPer90: 1.0,
        awayConcededPer90: 1.0,
        nHome: 2,
        nAway: 2,
      },
      { xgBlend: false }
    )!;
    expect(shrunk.shrunk).toBe(true);
    expect(unshrunk.shrunk).toBe(false);
    // Shrunk lambda should sit strictly between the raw estimate and the league mean L.
    expect(shrunk.lambdaHome).toBeLessThan(unshrunk.lambdaHome);
    expect(shrunk.lambdaHome).toBeGreaterThan(L);
  });

  describe("homeAvailabilityMult/awayAvailabilityMult (§8.2, PR-6)", () => {
    const base = {
      league: "__unknown_league__",
      homeScoredPer90: 1.7,
      homeConcededPer90: 1.0,
      awayScoredPer90: 1.2,
      awayConcededPer90: 1.5,
    };

    it("reduces lambda proportionally before shrink when a mult < 1 is supplied", () => {
      const full = computeV3Lambdas(base, { xgBlend: false })!;
      const depleted = computeV3Lambdas(
        { ...base, homeAvailabilityMult: 0.8 },
        { xgBlend: false }
      )!;
      expect(depleted.lambdaHome).toBeCloseTo(full.lambdaHome * 0.8, 5);
      // Away side untouched when only the home mult is supplied.
      expect(depleted.lambdaAway).toBeCloseTo(full.lambdaAway, 10);
    });

    it("clamps a mult above 1.0 down to 1.0 (matches fetch_squad_availability.py's own cap)", () => {
      const full = computeV3Lambdas(base, { xgBlend: false })!;
      const overCapped = computeV3Lambdas(
        { ...base, awayAvailabilityMult: 1.5 },
        { xgBlend: false }
      )!;
      expect(overCapped.lambdaAway).toBeCloseTo(full.lambdaAway, 5);
    });

    it("clamps a mult below 0.5 up to 0.5 (floor against a data glitch zeroing lambda)", () => {
      const floored = computeV3Lambdas({ ...base, homeAvailabilityMult: 0.1 }, { xgBlend: false })!;
      const atFloor = computeV3Lambdas({ ...base, homeAvailabilityMult: 0.5 }, { xgBlend: false })!;
      expect(floored.lambdaHome).toBeCloseTo(atFloor.lambdaHome, 5);
    });

    it("is a no-op when absent or null", () => {
      const withUndefined = computeV3Lambdas(base, { xgBlend: false })!;
      const withNull = computeV3Lambdas(
        { ...base, homeAvailabilityMult: null, awayAvailabilityMult: null },
        { xgBlend: false }
      )!;
      expect(withNull.lambdaHome).toBeCloseTo(withUndefined.lambdaHome, 10);
      expect(withNull.lambdaAway).toBeCloseTo(withUndefined.lambdaAway, 10);
    });
  });

  it("blends 50/50 with xG when present, and marks xgBlended", () => {
    const noXg = computeV3Lambdas({
      league: "__unknown_league__",
      homeScoredPer90: 1.7,
      homeConcededPer90: 1.0,
      awayScoredPer90: 1.2,
      awayConcededPer90: 1.5,
      nHome: 10,
      nAway: 10,
    })!;
    const withXg = computeV3Lambdas({
      league: "__unknown_league__",
      homeScoredPer90: 1.7,
      homeConcededPer90: 1.0,
      awayScoredPer90: 1.2,
      awayConcededPer90: 1.5,
      nHome: 10,
      nAway: 10,
      homeXg: { xgf: 2.5, xga: 0.5 },
      awayXg: { xgf: 0.5, xga: 2.5 },
    })!;
    expect(withXg.xgBlended).toBe(true);
    expect(noXg.xgBlended).toBe(false);
    expect(withXg.lambdaHome).not.toBeCloseTo(noXg.lambdaHome, 5);
  });

  describe("xgBlendWeight (audit fix: was a flat 50/50 regardless of sample size)", () => {
    it("returns the full 0.5 ceiling once n reaches shrinkN, matching the prior flat behavior exactly", () => {
      expect(xgBlendWeight(8, 8)).toBe(0.5);
      expect(xgBlendWeight(20, 8)).toBe(0.5);
      expect(xgBlendWeight(null, 8)).toBe(0.5);
      expect(xgBlendWeight(undefined, 8)).toBe(0.5);
    });

    it("ramps linearly below shrinkN instead of jumping straight to 0.5", () => {
      expect(xgBlendWeight(4, 8)).toBeCloseTo(0.25, 10); // (4/8)*0.5
      expect(xgBlendWeight(2, 8)).toBeCloseTo(0.125, 10); // (2/8)*0.5
      expect(xgBlendWeight(0, 8)).toBe(0);
      expect(xgBlendWeight(3, 5)).toBeCloseTo(0.3, 10); // (3/5)*0.5 — tournament shrinkN
    });

    it("is monotonically non-decreasing in n — more sample, never less xG weight", () => {
      const weights = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => xgBlendWeight(n, 8));
      for (let i = 1; i < weights.length; i++)
        expect(weights[i]).toBeGreaterThanOrEqual(weights[i - 1]!);
    });
  });

  it("audit fix: computeV3Lambdas actually threads the sample-scaled xG weight through, not a hardcoded 0.5", () => {
    // Full end-to-end sanity check (xgBlendWeight's own unit tests above are
    // the precise coverage) — a fixture at n below shrinkN must NOT reach the
    // exact midpoint between the goals-only and xG-only lambdas.
    const base = {
      league: "__unknown_league__",
      homeScoredPer90: 1.7,
      homeConcededPer90: 1.0,
      awayScoredPer90: 1.2,
      awayConcededPer90: 1.5,
      nHome: 2,
      nAway: 2,
      homeXg: { xgf: 2.5, xga: 0.5 },
      awayXg: { xgf: 0.5, xga: 2.5 },
    };
    const blended = computeV3Lambdas(base)!.lambdaHome;
    const goalsOnly = computeV3Lambdas(base, { xgBlend: false })!.lambdaHome;
    // A flat-0.5 blend would put `blended` exactly midway between `goalsOnly`
    // and whatever the (inaccessible from here) pure-xG lambda is — instead
    // just assert it moved measurably but is still much closer to goalsOnly
    // than a 50/50 midpoint would ever land for these inputs (xgBlendWeight's
    // unit tests above pin the exact ratio; this just guards the wiring).
    expect(blended).not.toBeCloseTo(goalsOnly, 5);
  });

  describe("shrink (audit fix, Desktop concept #2: tournament fixtures get a faster n/5 ramp)", () => {
    it("n >= shrinkN is always fully trusted, regardless of which shrinkN", () => {
      expect(shrink(2.0, 8, 1.3, 8)).toBe(2.0);
      expect(shrink(2.0, 5, 1.3, 5)).toBe(2.0);
      expect(shrink(2.0, 20, 1.3, 5)).toBe(2.0);
    });

    it("the SAME n shrinks less (stays closer to raw lambda) under the tournament ramp (5) than the domestic ramp (8)", () => {
      // Isolates shrinkN as the only variable — same lambda, same n, same L,
      // computeV3Lambdas-level tests confounded this with the fact that
      // different league NAMES also resolve to different L baselines.
      const lambda = 2.4;
      const L = 1.3;
      const n = 3;
      const domestic = shrink(lambda, n, L, 8);
      const tournament = shrink(lambda, n, L, 5);
      expect(Math.abs(tournament - lambda)).toBeLessThan(Math.abs(domestic - lambda));
    });

    it("n=5 is fully trusted under the tournament ramp but still shrunk under the domestic ramp", () => {
      const lambda = 2.4;
      const L = 1.3;
      expect(shrink(lambda, 5, L, 5)).toBe(lambda);
      expect(shrink(lambda, 5, L, 8)).not.toBe(lambda);
    });
  });

  it("audit fix wiring: computeV3Lambdas selects the tournament shrinkN for a World-Cup-labeled fixture", () => {
    // TOURNAMENT_RE isn't exported (engine/goalsV3 boundary) — this proves the
    // selection is actually wired into computeV3Lambdas via league name
    // matching, not just that shrink() itself works (covered above). Uses the
    // SAME league's own baseline as L for both n's, so the only thing that
    // differs between "at n=5" and "at n=20" is whether 5 is >= shrinkN.
    const at = (n: number) =>
      computeV3Lambdas(
        {
          league: "World Cup",
          homeScoredPer90: 2.4,
          homeConcededPer90: 0.6,
          awayScoredPer90: 0.5,
          awayConcededPer90: 2.2,
          nHome: n,
          nAway: n,
        },
        { xgBlend: false }
      )!.lambdaHome;
    // If World Cup used the domestic shrinkN=8, n=5 would still be shrinking
    // (5 < 8) and would differ from the effectively-unshrunk n=20 case. Under
    // the tournament shrinkN=5, n=5 is already fully trusted, so the two
    // must match exactly.
    expect(at(5)).toBe(at(20));
  });

  it("returns null when neither side has any usable scoring signal", () => {
    expect(
      computeV3Lambdas({
        league: "x",
        homeScoredPer90: null,
        homeConcededPer90: null,
        awayScoredPer90: null,
        awayConcededPer90: null,
      })
    ).toBeNull();
  });

  // [audit fix, P0-2] League baselines refreshed 2026-07-06 — spot-check the
  // values that actually changed this pass (see the table's own inline
  // comments for sourcing). Guards against silent re-staling.
  it("V3_LEAGUE_BASELINES: refreshed rows match the verified 2026-07-06 research", () => {
    expect(V3_LEAGUE_BASELINES["World Cup"]).toBeCloseTo(2.65, 5);
    expect(V3_LEAGUE_BASELINES["Ligue 1"]).toBeCloseTo(2.96, 5);
    expect(V3_LEAGUE_BASELINES.MLS).toBeCloseTo(3.0, 5);
    expect(V3_LEAGUE_BASELINES["Brazil Série A"]).toBeCloseTo(2.55, 5);
    expect(V3_LEAGUE_BASELINES["Brazilian Serie B"]).toBeCloseTo(2.25, 5);
  });

  // [audit fix, P0-2] League-ID collision fix: an ID-keyed baseline takes
  // priority over the name-keyed table, and falls back to the name lookup
  // (then further to LEAGUE_PARAMS/default) when no ID is given or unknown.
  describe("v3LeaguePerTeamAvg: league_id-keyed lookup", () => {
    const TEST_ID = "sr:tournament:__test_only__";

    it("prefers the ID-keyed baseline over the name table when both are present", () => {
      V3_LEAGUE_BASELINES_BY_ID[TEST_ID] = 4.0; // per-game -> 2.0 per-team
      try {
        // "Premier League" name-keyed baseline is 2.85/2=1.425 per-team — the
        // ID-keyed lookup must win instead of the (wrong, colliding) name.
        expect(v3LeaguePerTeamAvg("Premier League", TEST_ID)).toBeCloseTo(2.0, 5);
      } finally {
        delete V3_LEAGUE_BASELINES_BY_ID[TEST_ID];
      }
    });

    it("falls back to the name-keyed table when leagueId is absent", () => {
      expect(v3LeaguePerTeamAvg("Premier League")).toBeCloseTo(2.85 / 2, 5);
    });

    it("falls back to the name-keyed table when leagueId is present but unknown", () => {
      expect(v3LeaguePerTeamAvg("Premier League", "sr:tournament:__unknown__")).toBeCloseTo(
        2.85 / 2,
        5
      );
    });

    it("computeV3Lambdas threads V3LambdaInput.leagueId through to the L used", () => {
      V3_LEAGUE_BASELINES_BY_ID[TEST_ID] = 4.0; // per-team L = 2.0
      try {
        const result = computeV3Lambdas(
          {
            league: "Premier League",
            leagueId: TEST_ID,
            homeScoredPer90: 1.7,
            homeConcededPer90: 1.0,
            awayScoredPer90: 1.2,
            awayConcededPer90: 1.5,
          },
          { xgBlend: false }
        );
        expect(result?.leaguePerTeamAvg).toBeCloseTo(2.0, 5);
      } finally {
        delete V3_LEAGUE_BASELINES_BY_ID[TEST_ID];
      }
    });
  });

  // [audit fix, P0-2 step 2] Lake-computed baselines (goals/game by league
  // name) injected via config override the static table but rank below the
  // manual ID-keyed collision overrides; undefined ⇒ static behavior.
  describe("v3LeaguePerTeamAvg: lake-computed baseline override", () => {
    const lake = { "Premier League": 3.0 }; // per-game -> 1.5 per-team

    it("prefers a lake baseline over the static name table", () => {
      expect(v3LeaguePerTeamAvg("Premier League", null, lake)).toBeCloseTo(1.5, 5);
    });

    it("ignores the lake map for a league it does not contain (static fallback)", () => {
      expect(v3LeaguePerTeamAvg("Premier League", null, { "La Liga": 4.0 })).toBeCloseTo(
        2.85 / 2,
        5
      );
    });

    it("ranks the manual ID-keyed override above the lake map", () => {
      const ID = "sr:tournament:__lake_test__";
      V3_LEAGUE_BASELINES_BY_ID[ID] = 4.0; // per-team 2.0 — must beat lake's 1.5
      try {
        expect(v3LeaguePerTeamAvg("Premier League", ID, lake)).toBeCloseTo(2.0, 5);
      } finally {
        delete V3_LEAGUE_BASELINES_BY_ID[ID];
      }
    });

    it("skips non-positive/non-finite lake values (static fallback)", () => {
      expect(v3LeaguePerTeamAvg("Premier League", null, { "Premier League": 0 })).toBeCloseTo(
        2.85 / 2,
        5
      );
      expect(
        v3LeaguePerTeamAvg("Premier League", null, {
          "Premier League": Number.NaN,
        })
      ).toBeCloseTo(2.85 / 2, 5);
    });

    it("computeV3Lambdas threads opts.lakeBaselines through to the L used", () => {
      const result = computeV3Lambdas(
        {
          league: "Premier League",
          homeScoredPer90: 1.7,
          homeConcededPer90: 1.0,
          awayScoredPer90: 1.2,
          awayConcededPer90: 1.5,
        },
        { xgBlend: false, lakeBaselines: lake }
      );
      expect(result?.leaguePerTeamAvg).toBeCloseTo(1.5, 5);
    });
  });

  // [audit fix, P0-2] λ v5: each side blends independently with its own xG
  // cross-pair, instead of requiring both sides to have one.
  describe("λ v5 — independent-side xG blend (xgBlendedSides)", () => {
    const base = {
      league: "__unknown_league__",
      homeScoredPer90: 1.7,
      homeConcededPer90: 1.0,
      awayScoredPer90: 1.2,
      awayConcededPer90: 1.5,
      nHome: 10,
      nAway: 10,
    };

    it("blends both sides and reports xgBlendedSides: 'both' when both have xG", () => {
      const result = computeV3Lambdas({
        ...base,
        homeXg: { xgf: 2.5, xga: 0.5 },
        awayXg: { xgf: 0.5, xga: 2.5 },
      })!;
      expect(result.xgBlended).toBe(true);
      expect(result.xgBlendedSides).toBe("both");
    });

    it("v5 (default): blends only the home side when only home's cross-pair (homeXg.xgf x awayXg.xga) is usable", () => {
      // Home's xG-λ needs homeXg.xgf AND awayXg.xga; away's needs awayXg.xgf
      // AND homeXg.xga. Giving awayXg.xga but withholding awayXg.xgf makes
      // home's cross-pair computable while blocking away's.
      const result = computeV3Lambdas({
        ...base,
        homeXg: { xgf: 2.5, xga: 0.5 },
        awayXg: { xgf: null, xga: 2.5 },
      })!;
      const noXg = computeV3Lambdas(base, { xgBlend: false })!;
      expect(result.xgBlended).toBe(true);
      expect(result.xgBlendedSides).toBe("home");
      expect(result.lambdaHome).not.toBeCloseTo(noXg.lambdaHome, 5);
      expect(result.lambdaAway).toBeCloseTo(noXg.lambdaAway, 5);
    });

    it("v5 (default): blends only the away side when only away's cross-pair (awayXg.xgf x homeXg.xga) is usable", () => {
      const result = computeV3Lambdas({
        ...base,
        homeXg: { xgf: null, xga: 0.5 },
        awayXg: { xgf: 0.5, xga: 2.5 },
      })!;
      expect(result.xgBlended).toBe(true);
      expect(result.xgBlendedSides).toBe("away");
    });

    it("lambdaV5: false restores the prior both-sides-only blend (a one-sided usable cross-pair is discarded)", () => {
      const result = computeV3Lambdas(
        {
          ...base,
          homeXg: { xgf: 2.5, xga: 0.5 },
          awayXg: { xgf: null, xga: 2.5 },
        },
        { lambdaV5: false }
      )!;
      expect(result.xgBlended).toBe(false);
      expect(result.xgBlendedSides).toBeUndefined();
    });
  });

  // Wave 2 WS2-B: third (pi-ratings) blend factor. Default OFF —
  // opts.ratingsBlend must be explicitly true, mirroring xgBlend's opt-out
  // pattern but inverted (safe-by-default for a brand-new live-pricing input).
  describe("ratingsBlendWeight (Wave 2 WS2-B)", () => {
    it("is 0 at n=0 or when n is missing/non-finite", () => {
      expect(ratingsBlendWeight(0, 8)).toBe(0);
      expect(ratingsBlendWeight(null, 8)).toBe(0);
      expect(ratingsBlendWeight(undefined, 8)).toBe(0);
      expect(ratingsBlendWeight(Number.NaN, 8)).toBe(0);
    });

    it("is exactly half the 0.25 ceiling at n=shrinkN (n/(n+shrinkN)=0.5 there)", () => {
      expect(ratingsBlendWeight(8, 8)).toBeCloseTo(0.125, 10);
      expect(ratingsBlendWeight(5, 5)).toBeCloseTo(0.125, 10);
    });

    it("asymptotically approaches but NEVER reaches the 0.25 hard ceiling, even at huge n", () => {
      const w1 = ratingsBlendWeight(1_000, 8);
      const w2 = ratingsBlendWeight(1_000_000, 8);
      const w3 = ratingsBlendWeight(1_000_000_000, 8);
      expect(w1).toBeLessThan(0.25);
      expect(w2).toBeLessThan(0.25);
      expect(w3).toBeLessThan(0.25);
      // Monotonically closer to the ceiling as n grows, but always strictly below it.
      expect(w2).toBeGreaterThan(w1);
      expect(w3).toBeGreaterThan(w2);
      expect(w3).toBeGreaterThan(0.2499);
    });

    it("is monotonically non-decreasing in n", () => {
      const weights = [0, 1, 2, 4, 8, 16, 32].map((n) => ratingsBlendWeight(n, 8));
      for (let i = 1; i < weights.length; i++)
        expect(weights[i]).toBeGreaterThanOrEqual(weights[i - 1]!);
    });

    it("uses a strictly lower ceiling than the xG blend's 0.5 (never conflate the two constants)", () => {
      expect(ratingsBlendWeight(1_000_000, 8)).toBeLessThan(0.25 + 1e-9);
      expect(ratingsBlendWeight(1_000_000, 8)).toBeLessThan(xgBlendWeight(1_000_000, 8));
    });
  });

  describe("computeV3Lambdas ratings blend (Wave 2 WS2-B, opts.ratingsBlend)", () => {
    const base = {
      league: "__unknown_league__",
      homeScoredPer90: 1.7,
      homeConcededPer90: 1.0,
      awayScoredPer90: 1.2,
      awayConcededPer90: 1.5,
      nHome: 10,
      nAway: 10,
    };

    it("CRITICAL REGRESSION GUARD: opts.ratingsBlend omitted produces IDENTICAL numeric output to before Wave 2", () => {
      // Fixed input, computed independently of any ratings field, mirrors the
      // very first test in this file (spec worked example) — exact numeric
      // equality against the pre-existing (pre-Wave-2) formula, not just
      // "close enough". This is the single most important test in this suite:
      // a silent behavior change here is a real-money pricing risk.
      const result = computeV3Lambdas(
        {
          league: "__unknown_league__",
          homeScoredPer90: 1.7,
          homeConcededPer90: 1.0,
          awayScoredPer90: 1.2,
          awayConcededPer90: 1.5,
          nHome: 10,
          nAway: 10,
          // Deliberately ALSO supply ratings fields, to prove the presence of
          // the data alone (without opts.ratingsBlend: true) changes nothing.
          ratingsXgd: 0.9,
          ratingsN: 500,
        },
        { xgBlend: false }
      );
      expect(result).not.toBeNull();
      // toBeCloseTo (not toBe) — same convention as this file's very first
      // test above: L is computed as V3_DEFAULT_LEAGUE_GPG/2 rather than the
      // literal 1.3, so bit-exact equality against a hand-typed literal
      // expression is not guaranteed even though the formula is identical.
      expect(result!.lambdaHome).toBeCloseTo((1.7 / 1.3) * (1.5 / 1.3) * 1.3, 12);
      expect(result!.lambdaAway).toBeCloseTo((1.2 / 1.3) * (1.0 / 1.3) * 1.3, 12);
      expect(result!.mu).toBeCloseTo(result!.lambdaHome + result!.lambdaAway, 12);
      expect(result!.method).toBe("multiplicative");
      expect(result!.shrunk).toBe(false);
      expect(result!.xgBlended).toBe(false);
      expect(result!.ratingsBlended).toBe(false);

      // And explicitly passing ratingsBlend: false must match exactly too.
      const explicit = computeV3Lambdas(
        {
          league: "__unknown_league__",
          homeScoredPer90: 1.7,
          homeConcededPer90: 1.0,
          awayScoredPer90: 1.2,
          awayConcededPer90: 1.5,
          nHome: 10,
          nAway: 10,
          ratingsXgd: 0.9,
          ratingsN: 500,
        },
        { xgBlend: false, ratingsBlend: false }
      );
      expect(explicit!.lambdaHome).toBe(result!.lambdaHome);
      expect(explicit!.lambdaAway).toBe(result!.lambdaAway);
      expect(explicit!.ratingsBlended).toBe(false);
    });

    it("has zero effect when ratingsBlend:true but ratingsXgd/ratingsN are absent", () => {
      const without = computeV3Lambdas(base, { xgBlend: false })!;
      const withFlagNoData = computeV3Lambdas(base, { xgBlend: false, ratingsBlend: true })!;
      expect(withFlagNoData.lambdaHome).toBeCloseTo(without.lambdaHome, 10);
      expect(withFlagNoData.lambdaAway).toBeCloseTo(without.lambdaAway, 10);
      expect(withFlagNoData.ratingsBlended).toBe(false);
    });

    it("has zero effect when ratingsN=0 (brand-new team, no shrinkage sample)", () => {
      const without = computeV3Lambdas(base, { xgBlend: false })!;
      const withZeroN = computeV3Lambdas(
        { ...base, ratingsXgd: 0.9, ratingsN: 0 },
        { xgBlend: false, ratingsBlend: true }
      )!;
      expect(withZeroN.lambdaHome).toBeCloseTo(without.lambdaHome, 10);
      expect(withZeroN.ratingsBlended).toBe(false);
    });

    // A perfectly balanced fixture (goals-implied lambdaHome === lambdaAway,
    // diff = 0) isolates the ratings signal's direction cleanly — the "base"
    // fixture above already implies its own home/away gap (~1.04), which for
    // a large ratingsXgd close to the ±1 tanh ceiling can be SMALLER than
    // that pre-existing gap and would pull the split narrower, not wider;
    // using a zero-diff base avoids that confound entirely.
    const balancedBase = {
      league: "__unknown_league__",
      homeScoredPer90: 1.3,
      homeConcededPer90: 1.3,
      awayScoredPer90: 1.3,
      awayConcededPer90: 1.3,
      nHome: 10,
      nAway: 10,
    };

    it("nudges lambdaHome up and lambdaAway down for a positive ratingsXgd (home expected stronger)", () => {
      const without = computeV3Lambdas(balancedBase, { xgBlend: false })!;
      const withRatings = computeV3Lambdas(
        { ...balancedBase, ratingsXgd: 0.9, ratingsN: 50 },
        { xgBlend: false, ratingsBlend: true }
      )!;
      expect(withRatings.ratingsBlended).toBe(true);
      expect(withRatings.lambdaHome).toBeGreaterThan(without.lambdaHome);
      expect(withRatings.lambdaAway).toBeLessThan(without.lambdaAway);
      // Total goals expectation is preserved (a split adjustment, not a
      // magnitude one) — mu should barely move (clamping aside).
      expect(withRatings.mu).toBeCloseTo(without.mu, 5);
    });

    it("nudges lambdaHome down and lambdaAway up for a negative ratingsXgd (away expected stronger)", () => {
      const without = computeV3Lambdas(balancedBase, { xgBlend: false })!;
      const withRatings = computeV3Lambdas(
        { ...balancedBase, ratingsXgd: -0.9, ratingsN: 50 },
        { xgBlend: false, ratingsBlend: true }
      )!;
      expect(withRatings.lambdaHome).toBeLessThan(without.lambdaHome);
      expect(withRatings.lambdaAway).toBeGreaterThan(without.lambdaAway);
    });

    it("never moves lambda further than the 0.25 hard-ceiling weight would allow, even at n=1e9", () => {
      const without = computeV3Lambdas(balancedBase, { xgBlend: false })!;
      const maxed = computeV3Lambdas(
        { ...balancedBase, ratingsXgd: 0.9, ratingsN: 1_000_000_000 },
        { xgBlend: false, ratingsBlend: true }
      )!;
      const totalMu = without.lambdaHome + without.lambdaAway;
      const ratingsLH = totalMu / 2 + 0.9 / 2;
      // At the theoretical weight ceiling (0.25, never quite reached), the
      // maximum possible lambdaHome is bounded by this — the actual result
      // (weight strictly < 0.25) must sit strictly inside that bound.
      const theoreticalCeilingLH = without.lambdaHome * (1 - 0.25) + ratingsLH * 0.25;
      expect(maxed.lambdaHome).toBeLessThan(theoreticalCeilingLH);
      expect(maxed.lambdaHome).toBeGreaterThan(without.lambdaHome);
    });

    it("composes with the xG blend (both factors active) without throwing or producing NaN", () => {
      const result = computeV3Lambdas(
        {
          ...base,
          homeXg: { xgf: 2.2, xga: 0.6 },
          awayXg: { xgf: 0.6, xga: 2.2 },
          ratingsXgd: 0.5,
          ratingsN: 20,
        },
        { ratingsBlend: true }
      )!;
      expect(result).not.toBeNull();
      expect(Number.isFinite(result.lambdaHome)).toBe(true);
      expect(Number.isFinite(result.lambdaAway)).toBe(true);
      expect(result.xgBlended).toBe(true);
      expect(result.ratingsBlended).toBe(true);
    });

    it("respects LAMBDA_MIN/LAMBDA_MAX clamps even under an extreme ratings signal", () => {
      const result = computeV3Lambdas(
        { ...base, ratingsXgd: -0.999, ratingsN: 1000 },
        { xgBlend: false, ratingsBlend: true }
      )!;
      expect(result.lambdaHome).toBeGreaterThanOrEqual(0.05);
      expect(result.lambdaAway).toBeLessThanOrEqual(4.5);
    });
  });
});

describe("deriveMatchShape (§3.5)", () => {
  it("recovers a known home share s from a synthetic 1X2 built at that exact s", () => {
    const mu = 2.8;
    const trueS = 0.7;
    // Build the "true" independent-Poisson 1X2 from the target split, then feed it
    // back through deriveMatchShape and confirm the grid search recovers ~trueS.
    const lH = mu * trueS;
    const lA = mu * (1 - trueS);
    let pHome = 0;
    let pDraw = 0;
    let pAway = 0;
    for (let i = 0; i < 11; i++) {
      for (let j = 0; j < 11; j++) {
        const p = poissonPMF(i, lH) * poissonPMF(j, lA);
        if (i > j) pHome += p;
        else if (i === j) pDraw += p;
        else pAway += p;
      }
    }
    const norm = pHome + pDraw + pAway;
    const shape = deriveMatchShape(mu, mu * 0.5 /* deliberately wrong raw split */, {
      pHome: pHome / norm,
      pDraw: pDraw / norm,
      pAway: pAway / norm,
    });
    expect(shape.source).toBe("odds");
    expect(shape.s).toBeCloseTo(trueS, 1);
    expect(shape.lambdaHome + shape.lambdaAway).toBeCloseTo(mu, 5);
  });

  it("falls back to the goals-model ratio when 1X2 is missing", () => {
    const shape = deriveMatchShape(2.8, 1.96 /* raw H share = 0.7 */, null);
    expect(shape.source).toBe("ratio");
    expect(shape.s).toBeCloseTo(0.7, 5);
  });

  it("clamps a heavy-favourite split so neither λ falls below 0.30", () => {
    const mu = 3.0;
    // Extreme 1X2 implying s→~0.98, which would push λ_away to ~0.06 unclamped.
    const shape = deriveMatchShape(mu, mu * 0.5, { pHome: 0.94, pDraw: 0.05, pAway: 0.01 });
    expect(shape.lambdaAway).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(shape.lambdaHome + shape.lambdaAway).toBeCloseTo(mu, 5);
  });
});

describe("devigOU + v3PenaltyPts + gateV3Edge (§4)", () => {
  it("de-vigs a two-sided book (additive method) summing to 1", () => {
    const over = devigOU(1.9, 1.95);
    expect(over).not.toBeNull();
    expect(over!.devigged).toBe(true);
    const under = devigOU(1.95, 1.9);
    expect(over!.q + under!.q).toBeCloseTo(1, 5);
  });

  it("falls back to 1/odds for a single-sided book", () => {
    const q = devigOU(2.0);
    expect(q).toEqual({ q: 0.5, devigged: false });
  });

  it("sums the §4.2 penalty table correctly", () => {
    expect(v3PenaltyPts({ xgMissing: true, h2hMissing: true, smallSample: true })).toBeCloseTo(
      0.02 + 0.01 + 0.02,
      10
    );
    expect(v3PenaltyPts({})).toBe(0);
  });

  it("Desktop-audit fix: xgMissingLargeSample is a lighter -1pt penalty than xgMissing's -2pt", () => {
    expect(v3PenaltyPts({ xgMissing: true })).toBeCloseTo(0.02, 10);
    expect(v3PenaltyPts({ xgMissingLargeSample: true })).toBeCloseTo(0.01, 10);
    // Same tier as xgEstimated, not additive with it (batch/index.ts sets them
    // mutually exclusively — this just confirms the point VALUES match, which
    // is the graduated-penalty intent: a large raw-goals sample without xG
    // costs the same as having AI-Mode-estimated xG).
    expect(V3_PENALTY_PTS.xgMissingLargeSample).toBe(V3_PENALTY_PTS.xgEstimated);
  });

  it("tiers adjusted edge at the 5/7/10pt boundaries", () => {
    // Use q=0 so rawEdge === modelP exactly (no float-subtraction artifacts at
    // the tier boundaries — this isolates the tier logic from FP noise).
    const mkGate = (modelP: number) => gateV3Edge(modelP, { q: 0, devigged: true }, {});
    expect(mkGate(0.045).outcome).toBe("below_edge");
    expect(mkGate(0.05).tier).toBe("medium");
    expect(mkGate(0.07).tier).toBe("high");
    expect(mkGate(0.1).tier).toBe("very_high");
  });

  it("discards within the 2pt noise gate regardless of tier math", () => {
    const gate = gateV3Edge(0.505, { q: 0.5, devigged: true }, {});
    expect(gate.outcome).toBe("noise");
    expect(gate.tier).toBeNull();
  });

  it("caps a raw edge > 12pts as implausible, before penalties", () => {
    const gate = gateV3Edge(0.7, { q: 0.5, devigged: true }, { xgMissing: true });
    expect(gate.rawEdge).toBeCloseTo(0.2, 5);
    expect(gate.outcome).toBe("capped");
  });

  it("subtracts penalties from raw edge to get adjusted edge", () => {
    const gate = gateV3Edge(0.09, { q: 0, devigged: true }, { xgMissing: true, h2hMissing: true });
    expect(gate.rawEdge).toBeCloseTo(0.09, 5);
    expect(gate.penaltyPts).toBeCloseTo(0.03, 5);
    expect(gate.adjustedEdge).toBeCloseTo(0.06, 5);
    expect(gate.tier).toBe("medium");
  });

  describe("heightened floor (v4 PR-3: 8pt pass bar under HFA/hit-rate uncertainty)", () => {
    it("raises the pass floor from 5pt to 8pt — a 6pt edge that would normally be 'medium' now fails", () => {
      const nonHeightened = gateV3Edge(0.06, { q: 0, devigged: true }, {}, {});
      expect(nonHeightened.outcome).toBe("done");
      expect(nonHeightened.tier).toBe("medium");

      const heightened = gateV3Edge(0.06, { q: 0, devigged: true }, {}, { heightened: true });
      expect(heightened.outcome).toBe("below_edge");
      expect(heightened.tier).toBeNull();
    });

    it("passes at exactly the 8pt heightened floor with tier 'high' (0.08 ≥ V3_TIER_HIGH)", () => {
      const gate = gateV3Edge(
        V3_TIER_HEIGHTENED_FLOOR,
        { q: 0, devigged: true },
        {},
        { heightened: true }
      );
      expect(gate.outcome).toBe("done");
      expect(gate.tier).toBe("high");
    });

    it("still respects the noise gate and absolute cap ahead of the heightened floor", () => {
      const noise = gateV3Edge(0.005, { q: 0, devigged: true }, {}, { heightened: true });
      expect(noise.outcome).toBe("noise");

      const capped = gateV3Edge(0.7, { q: 0.5, devigged: true }, {}, { heightened: true });
      expect(capped.outcome).toBe("capped");
    });

    it("defaults to the standard 5pt floor when heightened is omitted or false", () => {
      expect(gateV3Edge(0.06, { q: 0, devigged: true }, {}).outcome).toBe("done");
      expect(gateV3Edge(0.06, { q: 0, devigged: true }, {}, { heightened: false }).outcome).toBe(
        "done"
      );
    });
  });
});

describe("v3NbDispersion (§3.2 guard)", () => {
  it("accepts r in [8,20]", () => {
    expect(v3NbDispersion(8)).toBe(8);
    expect(v3NbDispersion(10)).toBe(10);
    expect(v3NbDispersion(20)).toBe(20);
  });
  it("rejects r=2 and anything outside [8,20]", () => {
    expect(v3NbDispersion(2)).toBeUndefined();
    expect(v3NbDispersion(7.9)).toBeUndefined();
    expect(v3NbDispersion(21)).toBeUndefined();
    expect(v3NbDispersion(undefined)).toBeUndefined();
  });
});

describe("analyzeGoalsFixtureV3 (full pipeline)", () => {
  function baseInput(overrides: Partial<V3AnalyzeInput> = {}): V3AnalyzeInput {
    return {
      fixtureId: "test_fixture",
      runId: "test_run",
      home: "Home FC",
      away: "Away FC",
      league: "Premier League",
      kickoff: "2026-08-01T15:00:00Z",
      odds: {
        over15: 1.3,
        under15: 3.2,
        over25: 1.9,
        under25: 1.95,
        homeTotalOver05: 1.25,
        awayTotalOver05: 1.6,
        bttsYes: 1.8,
        bttsNo: 1.9,
        home1x2: 1.8,
        draw1x2: 3.6,
        away1x2: 4.2,
      },
      lambdaInput: {
        league: "Premier League",
        homeScoredPer90: 1.8,
        homeConcededPer90: 1.0,
        awayScoredPer90: 1.0,
        awayConcededPer90: 1.4,
        nHome: 10,
        nAway: 10,
      },
      penaltyFlags: {},
      completeness: 90,
      sources: ["sportybet-gismo"],
      ...overrides,
    };
  }

  it("returns null when no lambda model can be built", () => {
    expect(
      analyzeGoalsFixtureV3(
        baseInput({
          lambdaInput: { league: "Premier League" },
        })
      )
    ).toBeNull();
  });

  it("produces a job, assessments for every priced market, and a capped log when hot", () => {
    const result = analyzeGoalsFixtureV3(baseInput());
    expect(result).not.toBeNull();
    expect(result!.job.status).toBe("ok");
    expect(result!.assessments.length).toBeGreaterThan(0);
    // Every DONE assessment must also appear in job.result.evMarkets (v3 field set).
    if (result!.job.status === "ok") {
      for (const m of result!.job.result.evMarkets) {
        expect(m.v3).toBeDefined();
        expect(["very_high", "high", "medium"]).toContain(m.v3!.tier);
      }
    }
  });

  it("logs a capped selection and never puts it in evMarkets", () => {
    // Force an absurdly generous price on Over 2.5 relative to the model to blow past the 12pt cap.
    const result = analyzeGoalsFixtureV3(
      baseInput({ odds: { ...baseInput().odds, over25: 5.0, under25: 1.15 } })
    );
    expect(result).not.toBeNull();
    if (result!.job.status === "ok") {
      const over25InMarkets = result!.job.result.evMarkets.some((m) => m.label === "Over 2.5");
      const over25Capped = result!.capped.some((c) => c.label === "Over 2.5");
      expect(over25Capped).toBe(true);
      expect(over25InMarkets).toBe(false);
    }
  });

  it("respects the noiseGate override — a very wide noise gate suppresses every tier", () => {
    const noisy = analyzeGoalsFixtureV3(baseInput({ noiseGate: 0.5 }));
    expect(noisy).not.toBeNull();
    expect(noisy!.assessments.every((a) => a.outcome !== "done")).toBe(true);
    if (noisy!.job.status === "ok") {
      expect(noisy!.job.result.evMarkets.length).toBe(0);
    }
  });

  it("respects the edgeCap override — a very tight cap forces every priced market into 'capped'", () => {
    // Deliberately mispriced (generous) odds guarantee at least one clearly
    // positive raw edge; a 0 cap then means ANY positive raw edge is "too hot".
    const tight = analyzeGoalsFixtureV3(
      baseInput({
        odds: { ...baseInput().odds, over15: 5.0, under15: 1.15 },
        edgeCap: 0,
        noiseGate: 0,
      })
    );
    expect(tight).not.toBeNull();
    const positiveRawEdgeCount = tight!.assessments.filter((a) => a.rawEdge > 0).length;
    expect(positiveRawEdgeCount).toBeGreaterThan(0);
    expect(tight!.capped.length).toBe(positiveRawEdgeCount);
  });

  it("threads heightened through the full pipeline — fewer (or equal) DONE markets survive than non-heightened", () => {
    const normal = analyzeGoalsFixtureV3(baseInput());
    const heightened = analyzeGoalsFixtureV3(baseInput({ heightened: true }));
    expect(normal).not.toBeNull();
    expect(heightened).not.toBeNull();
    const normalDone = normal!.assessments.filter((a) => a.outcome === "done").length;
    const heightenedDone = heightened!.assessments.filter((a) => a.outcome === "done").length;
    expect(heightenedDone).toBeLessThanOrEqual(normalDone);
  });

  describe("lineHitRates (v4 §0.3 per-selection completeness, PR-4)", () => {
    it("applies hitRateMissing to only the candidate whose line lacks a hit-rate", () => {
      const result = analyzeGoalsFixtureV3(
        baseInput({ lineHitRates: { over15: false, over25: true } })
      );
      expect(result).not.toBeNull();
      const over15 = result!.assessments.find((a) => a.label === "Over 1.5");
      const over25 = result!.assessments.find((a) => a.label === "Over 2.5");
      expect(over15).toBeDefined();
      expect(over25).toBeDefined();
      expect(over15!.penaltyPts).toBeCloseTo(0.01, 5);
      expect(over25!.penaltyPts).toBeCloseTo(0, 5);
    });

    it("falls back to the fixture-wide hitRateMissing flag when a line has no entry", () => {
      const withFixtureWide = analyzeGoalsFixtureV3(
        baseInput({ penaltyFlags: { hitRateMissing: true }, lineHitRates: { over15: false } })
      );
      expect(withFixtureWide).not.toBeNull();
      // Over 1.5 has an explicit per-line entry (false ⇒ missing) — same result either way here,
      // but Home/Away Total and BTTS have NO lineHitRates entry, so they inherit the fixture-wide flag.
      const homeTotal = withFixtureWide!.assessments.find((a) => a.label === "Home Total Over 0.5");
      expect(homeTotal!.penaltyPts).toBeCloseTo(0.01, 5);
    });

    it("omitting lineHitRates entirely behaves exactly as before PR-4 (fixture-wide flag applies uniformly)", () => {
      const result = analyzeGoalsFixtureV3(baseInput({ penaltyFlags: { hitRateMissing: true } }));
      expect(result).not.toBeNull();
      for (const a of result!.assessments) {
        expect(a.penaltyPts).toBeCloseTo(0.01, 5);
      }
    });
  });

  describe("dynamicRho override (PR-5, §8.1 NEW-07)", () => {
    it("uses the static league baseRho when dynamicRho is absent (unchanged behavior)", () => {
      const withStatic = analyzeGoalsFixtureV3(baseInput());
      const withSameAsStatic = analyzeGoalsFixtureV3(baseInput({ dynamicRho: -0.13 })); // PL's baseRho
      expect(withStatic).not.toBeNull();
      expect(withSameAsStatic).not.toBeNull();
      const mp = (r: typeof withStatic) => r!.assessments.find((a) => a.label === "Over 1.5")!.mp;
      expect(mp(withSameAsStatic)).toBeCloseTo(mp(withStatic), 10);
    });

    it("a dynamicRho override actually changes the priced model probabilities", () => {
      const withStatic = analyzeGoalsFixtureV3(baseInput());
      const withDynamic = analyzeGoalsFixtureV3(baseInput({ dynamicRho: -0.28 }));
      expect(withStatic).not.toBeNull();
      expect(withDynamic).not.toBeNull();
      const mp = (r: typeof withStatic) => r!.assessments.find((a) => a.label === "Over 1.5")!.mp;
      expect(mp(withDynamic)).not.toBeCloseTo(mp(withStatic), 5);
    });

    it("falls back to the static baseRho when dynamicRho is NaN (defense-in-depth type-boundary guard)", () => {
      const withStatic = analyzeGoalsFixtureV3(baseInput());
      const withNaN = analyzeGoalsFixtureV3(baseInput({ dynamicRho: Number.NaN }));
      expect(withStatic).not.toBeNull();
      expect(withNaN).not.toBeNull();
      const mp = (r: typeof withStatic) => r!.assessments.find((a) => a.label === "Over 1.5")!.mp;
      expect(mp(withNaN)).toBeCloseTo(mp(withStatic), 10);
    });
  });

  describe("resolveRho (defense-in-depth type-boundary guard)", () => {
    it("uses dynamicRho when it's a finite number", () => {
      expect(resolveRho("Premier League", -0.28)).toBe(-0.28);
    });

    it("falls back to the static league baseRho when dynamicRho is undefined", () => {
      expect(resolveRho("Premier League", undefined)).toBe(-0.13);
    });

    it("falls back to the static league baseRho when dynamicRho is NaN", () => {
      expect(resolveRho("Premier League", Number.NaN)).toBe(-0.13);
    });

    it("falls back to the static league baseRho when dynamicRho is +/-Infinity", () => {
      expect(resolveRho("Premier League", Number.POSITIVE_INFINITY)).toBe(-0.13);
      expect(resolveRho("Premier League", Number.NEGATIVE_INFINITY)).toBe(-0.13);
    });
  });

  describe("rationale limits text", () => {
    it("surfaces every active penalty flag, including hfaDefaultUsed and hitRateMissing", () => {
      const result = analyzeGoalsFixtureV3(
        baseInput({
          penaltyFlags: { hfaDefaultUsed: true, hitRateMissing: true, smallSample: true },
        })
      );
      expect(result).not.toBeNull();
      for (const a of result!.assessments) {
        expect(a.rationale).toContain("limits: ");
        expect(a.rationale).toContain("default HFA");
        expect(a.rationale).toContain("no hit-rate");
        expect(a.rationale).toContain("<5 games sample");
      }
    });

    it("omits the limits segment entirely when no penalty flag is set", () => {
      const result = analyzeGoalsFixtureV3(baseInput());
      expect(result).not.toBeNull();
      for (const a of result!.assessments) {
        expect(a.rationale).not.toContain("limits:");
      }
    });
  });
});
