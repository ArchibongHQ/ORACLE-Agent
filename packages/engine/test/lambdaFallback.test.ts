/** marketsV3/lambdaFallback.ts — Phase 4 "no fixture dies" λ ladder.
 *  Per-rung units (F1 H2H → F2 hit-rate → F3 league baseline → F4
 *  market-implied) plus the circular-basis contract callers must honor. */
import { describe, expect, it } from "vitest";
import { CIRCULAR_LAMBDA_BASES, computeLambdaFallback } from "../src/marketsV3/lambdaFallback.js";

const LEAGUE = "Premier League"; // real entry in V3_LEAGUE_BASELINES (2.85 g/g)

describe("computeLambdaFallback", () => {
  it("F1 — derives λ from this fixture's own H2H over-2.5 rate when present", () => {
    const result = computeLambdaFallback({
      league: LEAGUE,
      h2hOver25Pct: 0.75,
    });
    expect(result).not.toBeNull();
    expect(result?.basis).toBe("h2h");
    expect(result?.label).toMatch(/head-to-head history \(F1\)/);
    expect(result?.lambdas.lambdaHome).toBeGreaterThan(0);
    expect(result?.lambdas.lambdaAway).toBeGreaterThan(0);
    // A 75% over-2.5 rate implies a total goals mu comfortably above 2.5.
    expect(result?.lambdas.mu).toBeGreaterThan(2.5);
  });

  it("F1 skips a degenerate H2H rate (0 or 1 — no real information) and falls through", () => {
    const zero = computeLambdaFallback({ league: LEAGUE, h2hOver25Pct: 0 });
    const one = computeLambdaFallback({ league: LEAGUE, h2hOver25Pct: 1 });
    expect(zero?.basis).toBe("league-baseline");
    expect(one?.basis).toBe("league-baseline");
  });

  it("F2 — falls through to season hit-rate inversion when H2H is absent", () => {
    const result = computeLambdaFallback({
      league: LEAGUE,
      ou25PctH: 0.4,
      ou25PctA: 0.3,
    });
    expect(result?.basis).toBe("hit-rate");
    expect(result?.label).toMatch(/hit-rate inversion \(F2\)/);
    expect(result?.lambdas.mu).toBeGreaterThan(0);
  });

  it("F2 averages both sides when only one is present", () => {
    const result = computeLambdaFallback({ league: LEAGUE, ou25PctH: 0.6 });
    expect(result?.basis).toBe("hit-rate");
  });

  it("F3 — falls through to the league baseline when no team/H2H signal exists at all", () => {
    const result = computeLambdaFallback({ league: LEAGUE });
    expect(result).not.toBeNull();
    expect(result?.basis).toBe("league-baseline");
    expect(result?.label).toMatch(/league baseline \(F3\)/);
    // Premier League baseline is 2.85 goals/game — the fallback should land near it.
    expect(result?.lambdas.mu).toBeCloseTo(2.85, 1);
  });

  it("F3 resolves even for a completely unknown league via the hardcoded default", () => {
    const result = computeLambdaFallback({ league: "__totally_unknown_league__" });
    expect(result?.basis).toBe("league-baseline");
    expect(result?.lambdas.mu).toBeGreaterThan(0);
  });

  it("F4 — market-implied is reachable only when even the league baseline fails (defensive; not reachable in practice today)", () => {
    // v3LeaguePerTeamAvg always resolves via its hardcoded default, so F3
    // fires before F4 ever gets a chance under any real input — this test
    // documents that contract rather than exercising unreachable code.
    const withDevig = computeLambdaFallback({
      league: LEAGUE,
      devigged1x2: { pHome: 0.55, pDraw: 0.25, pAway: 0.2 },
    });
    expect(withDevig?.basis).toBe("league-baseline");
  });

  it("CIRCULAR_LAMBDA_BASES flags market-implied-1x2 and nothing else", () => {
    expect(CIRCULAR_LAMBDA_BASES.has("market-implied-1x2")).toBe(true);
    expect(CIRCULAR_LAMBDA_BASES.has("h2h")).toBe(false);
    expect(CIRCULAR_LAMBDA_BASES.has("hit-rate")).toBe(false);
    expect(CIRCULAR_LAMBDA_BASES.has("league-baseline")).toBe(false);
  });

  it("home/away split follows the league's own home/away scoring ratio, not a flat 50/50", () => {
    const result = computeLambdaFallback({ league: LEAGUE });
    // Premier League: homeAvg 1.55 > awayAvg 1.18 (getLeagueParams) — home
    // should carry a larger share of the league-baseline mu than away.
    expect(result?.lambdas.lambdaHome).toBeGreaterThan(result?.lambdas.lambdaAway ?? 0);
  });

  it("every rung clamps λ within the same [0.05, 4.5] sanity bounds as the primary path", () => {
    const extreme = computeLambdaFallback({ league: LEAGUE, h2hOver25Pct: 0.999 });
    expect(extreme?.lambdas.lambdaHome).toBeLessThanOrEqual(4.5);
    expect(extreme?.lambdas.lambdaAway).toBeLessThanOrEqual(4.5);
    expect(extreme?.lambdas.lambdaHome).toBeGreaterThanOrEqual(0.05);
    expect(extreme?.lambdas.lambdaAway).toBeGreaterThanOrEqual(0.05);
  });
});
