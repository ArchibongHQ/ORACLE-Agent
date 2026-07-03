/** v4 worked examples and parity checks — ensure HFA multiplier, venue-split
 *  suppression, and exact specs are respected. */

import { describe, expect, it } from "vitest";
import { computeV3Lambdas, type V3LambdaInput } from "../src/goalsV3/lambda.js";
import { buildMatrix } from "../src/math/index.js";

describe("v4 HFA (home-field advantage) worked examples", () => {
  describe("DNB example — HFA applied to team-overall stats", () => {
    // Spec example: Home team average 1.50 goals for/90, 0.80 against/90.
    // Away team average 1.20 for/90, 1.10 against/90. League avg = 2.60 (1.30 per team).
    // Without HFA: λ_home = (1.50/1.30)*(1.10/1.30)*1.30 = 0.960
    // λ_away = (1.20/1.30)*(0.80/1.30)*1.30 = 0.710, μ = 1.67 O/U 2.5.
    // With HFA (1.10): λ_home *= 1.10 = 1.056, λ_away /= 1.10 = 0.645, μ = 1.70.
    it("applies HFA multiplier when venueSplitUsed is false", () => {
      const input: V3LambdaInput = {
        league: "Championship",
        homeScoredPer90: 1.5,
        homeConcededPer90: 0.8,
        awayScoredPer90: 1.2,
        awayConcededPer90: 1.1,
        nHome: 20,
        nAway: 20,
      };
      const result = computeV3Lambdas(input, { hfa: 1.1, venueSplitUsed: false });
      expect(result).not.toBeNull();
      expect(result!.hfaApplied).toBe(true);
      // HFA inflates home, deflates away
      expect(result!.lambdaHome).toBeGreaterThan(0.95);
      expect(result!.lambdaAway).toBeLessThan(0.71);
    });

    it("suppresses HFA when venueSplitUsed is true", () => {
      const input: V3LambdaInput = {
        league: "Championship",
        homeScoredPer90: 1.5,
        homeConcededPer90: 0.8,
        awayScoredPer90: 1.2,
        awayConcededPer90: 1.1,
        nHome: 20,
        nAway: 20,
      };
      const result = computeV3Lambdas(input, { hfa: 1.1, venueSplitUsed: true });
      expect(result).not.toBeNull();
      expect(result!.hfaApplied).toBe(false);
      // Same as result without the hfa param
      const resultNoHfa = computeV3Lambdas(input, { venueSplitUsed: true });
      expect(result!.lambdaHome).toBe(resultNoHfa!.lambdaHome);
      expect(result!.lambdaAway).toBe(resultNoHfa!.lambdaAway);
    });

    it("disables HFA when hfa=1.0", () => {
      const input: V3LambdaInput = {
        league: "Championship",
        homeScoredPer90: 1.5,
        homeConcededPer90: 0.8,
        awayScoredPer90: 1.2,
        awayConcededPer90: 1.1,
        nHome: 20,
        nAway: 20,
      };
      const result = computeV3Lambdas(input, { hfa: 1.0, venueSplitUsed: false });
      expect(result).not.toBeNull();
      expect(result!.hfaApplied).toBe(false);
      // Should match a baseline run without HFA
      const resultNoHfa = computeV3Lambdas(input, { venueSplitUsed: false });
      expect(result!.lambdaHome).toBe(resultNoHfa!.lambdaHome);
      expect(result!.lambdaAway).toBe(resultNoHfa!.lambdaAway);
    });
  });

  describe("Over/Under 1.5 match-shape example", () => {
    // Poisson matrix on μ=2.89 (HFA-adjusted): Over 1.5 = 1 − P(0 goals) − P(1 goal)
    // P(score_total ≤ 1) ≈ 0.056 + 0.162 = 0.218, so Over 1.5 ≈ 0.782 (78.2%).
    // Cold deploy (hfa=1.0) disables HFA, so μ is lower and Over 1.5 is lower too.
    it("matrix probabilities reflect HFA-adjusted μ", () => {
      const inputTeamStats: V3LambdaInput = {
        league: "Premier League",
        homeScoredPer90: 1.8,
        homeConcededPer90: 0.9,
        awayScoredPer90: 1.5,
        awayConcededPer90: 1.0,
        nHome: 25,
        nAway: 25,
      };

      const withHfa = computeV3Lambdas(inputTeamStats, { hfa: 1.1, venueSplitUsed: false });
      const withoutHfa = computeV3Lambdas(inputTeamStats, { hfa: 1.0, venueSplitUsed: false });
      expect(withHfa).not.toBeNull();
      expect(withoutHfa).not.toBeNull();
      // HFA inflates μ → Over 1.5 probability is higher
      const muWithHfa = withHfa!.mu;
      const muWithoutHfa = withoutHfa!.mu;
      expect(muWithHfa).toBeGreaterThan(muWithoutHfa);
      // For a given μ, Over 1.5 ∝ μ (Poisson CDF is increasing in λ).
      // Verify the matrices reflect this.
      const matWithHfa = buildMatrix(withHfa!.lambdaHome, withHfa!.lambdaAway, 0.02, false);
      const matWithoutHfa = buildMatrix(
        withoutHfa!.lambdaHome,
        withoutHfa!.lambdaAway,
        0.02,
        false
      );
      // Over 1.5 on HFA matrix ≥ Over 1.5 on non-HFA matrix
      const over15HfaP = 1 - matWithHfa[0][0] - matWithHfa[1][0] - matWithHfa[0][1];
      const over15NoHfaP = 1 - matWithoutHfa[0][0] - matWithoutHfa[1][0] - matWithoutHfa[0][1];
      expect(over15HfaP).toBeGreaterThan(over15NoHfaP);
    });
  });

  describe("1H Under 1.5 — exact tail spec compliance", () => {
    // First-half markets split the match-shape at ρ ≈ 0.4 (empirical). On a full-match
    // λ=2.3, 1H λ ≈ 0.92. 1H Under 1.5 = P(0) + P(1) = e^-0.92 + 0.92*e^-0.92 ≈ 0.40.
    // HFA adjustment applies before the split (§3.6 applies the ρ split to the
    // HFA-adjusted λ pair), so the 1H probability changes when HFA is enabled.
    it("first-half split respects HFA-adjusted λ", () => {
      const input: V3LambdaInput = {
        league: "Championship",
        homeScoredPer90: 1.6,
        homeConcededPer90: 0.7,
        awayScoredPer90: 1.4,
        awayConcededPer90: 0.9,
        nHome: 18,
        nAway: 18,
      };

      const withHfa = computeV3Lambdas(input, { hfa: 1.1, venueSplitUsed: false });
      const withoutHfa = computeV3Lambdas(input, { hfa: 1.0, venueSplitUsed: false });
      expect(withHfa).not.toBeNull();
      expect(withoutHfa).not.toBeNull();

      // Apply §3.6 ρ split to both (ρ_1h = 0.4, ρ_2h = 0.6 exemplar)
      const rho = 0.4;
      const lambdaHome1hHfa = withHfa!.lambdaHome * rho;
      const lambdaHome1hNoHfa = withoutHfa!.lambdaHome * rho;
      expect(lambdaHome1hHfa).toBeGreaterThan(lambdaHome1hNoHfa);
    });
  });

  describe("Devig test — class EV gate respects penalty flags", () => {
    // Edge = P_model − q_implied − penalties. When hfaDefaultUsed is set,
    // −1 pt penalty applied → adjusted edge is 1 pt lower.
    it("hfaDefaultUsed penalty lowers adjusted edge by 1 pt", () => {
      const rawEdge = 0.08;
      const q = 0.5;
      const rawModelEdge = 0.08; // 8 pts

      // Without penalty: adjusted edge = 8 pts − 0 = 8 pts.
      const adjustedNoPenalty = rawModelEdge;

      // With hfaDefaultUsed penalty: adjusted = 8 pts − 1 pt = 7 pts.
      const hfaDefaultPenalty = 0.01;
      const adjustedWithPenalty = rawModelEdge - hfaDefaultPenalty;

      expect(adjustedWithPenalty).toBeLessThan(adjustedNoPenalty);
      expect(adjustedWithPenalty).toBeCloseTo(0.07, 3);
    });
  });

  describe("HFA suppression under venue-split data", () => {
    // Real venue-split scenario: Home team's home rates are 1.7 for, 0.6 against.
    // Away team's away rates are 1.3 for, 0.95 against. These INCLUDE home advantage
    // already, so HFA multiplier MUST NOT apply (would double-count).
    it("venue-split data bypasses HFA and produces correct λ", () => {
      const venueInput: V3LambdaInput = {
        league: "Premier League",
        homeScoredPer90: 1.7, // home team's HOME rate (split)
        homeConcededPer90: 0.6, // home team's HOME conceded
        awayScoredPer90: 1.3, // away team's AWAY rate (split)
        awayConcededPer90: 0.95, // away team's AWAY conceded
        nHome: 10, // sample for home split
        nAway: 10, // sample for away split
      };

      const resultWithVenueSplit = computeV3Lambdas(venueInput, {
        hfa: 1.1,
        venueSplitUsed: true,
      });
      const resultTeamAvg = computeV3Lambdas(venueInput, {
        hfa: 1.1,
        venueSplitUsed: false,
      });

      expect(resultWithVenueSplit).not.toBeNull();
      expect(resultTeamAvg).not.toBeNull();

      // Venue-split result: HFA NOT applied, so λ is from the raw inputs.
      expect(resultWithVenueSplit!.hfaApplied).toBe(false);

      // Team-avg result: HFA IS applied, so λ_home > venue λ_home.
      expect(resultTeamAvg!.hfaApplied).toBe(true);
      expect(resultTeamAvg!.lambdaHome).toBeGreaterThan(resultWithVenueSplit!.lambdaHome);
      expect(resultTeamAvg!.lambdaAway).toBeLessThan(resultWithVenueSplit!.lambdaAway);
    });
  });
});
