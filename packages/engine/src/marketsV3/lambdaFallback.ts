/** marketsV3 §3.1c — "no fixture dies" λ fallback ladder (Phase 4,
 *  stateful-rolling-elephant plan).
 *
 *  `computeV3Lambdas` (goalsV3/lambda.ts) returns null only when a side has
 *  ZERO usable scoring signal (both scoredPer90 and concededPer90 missing —
 *  a genuinely under-scraped fixture). Rather than let such a fixture vanish
 *  from the slate silently, this module tries progressively weaker, always
 *  HONESTLY-LABELED data sources before giving up entirely:
 *
 *    F1 — head-to-head history (this exact matchup's own O2.5 hit rate)
 *    F2 — season hit-rate inversion (each team's own O2.5 rate, independent
 *         of this specific pairing)
 *    F3 — league baseline (no team-specific data at all — the league's own
 *         average goals/team/game, split by the league's home/away ratio)
 *    F4 — market-implied via the devigged 1X2 book
 *
 *  F1-F3 are independent of the fixture's own odds, so a +EV pick priced off
 *  them is a real (if thin) edge. F4 derives λ FROM the same market it would
 *  then be priced against — pricing EV off it is circular, not a real edge
 *  (v6.2 §3.1c honesty rule) — CALLERS MUST force any F4-based assessment to
 *  watchlist-only, never Tier① QUALIFIED, regardless of gate outcome.
 *
 *  F5 (a single scraped Over/Under line's devigged probability, per the
 *  original plan) is deliberately deferred: F4's devigged-1X2 book is
 *  available for every fixture that reaches pricing at all (no odds ⇒ no
 *  fixture in the pipeline), making it a strict superset of F5's coverage
 *  for a fraction of the parsing complexity (F5 would need anchored O/U-line
 *  extraction from the raw allMarkets catalogue, out of scope for this
 *  pass) — documented here rather than silently dropped.
 *
 *  Pure math, no I/O — same convention as goalsV3/lambda.ts. */

import { getLeagueParams } from "../execution/index.js";
import type { V3Lambdas } from "../goalsV3/lambda.js";
import { LAMBDA_MAX, LAMBDA_MIN, v3LeaguePerTeamAvg } from "../goalsV3/lambda.js";
import { clamp, poissonPMF } from "../math/index.js";

export type LambdaBasis = "h2h" | "hit-rate" | "league-baseline" | "market-implied-1x2";

/** F4 is the only basis whose EV would be circular against its own source
 *  odds — callers gate Tier① eligibility on this set, not a hardcoded string. */
export const CIRCULAR_LAMBDA_BASES: ReadonlySet<LambdaBasis> = new Set(["market-implied-1x2"]);

export interface LambdaFallbackResult {
  lambdas: V3Lambdas;
  basis: LambdaBasis;
  /** Human-readable, threaded to watchlist/report rows, e.g. "priced on league baseline (F3)". */
  label: string;
}

/** Matches buildV3Grid's scoreline ceiling elsewhere in marketsV3 — goals
 *  beyond this are negligible-probability tail, not a real cutoff. */
const MAX_TOTAL_GOALS = 12;
const BISECTION_ITERATIONS = 30;
/** Upper bisection bound for the implied total-goals mu. 20 keeps
 *  tailProb(20, line=2.5) effectively 1.0 (no realistic O2.5 hit-rate, even
 *  from a tiny H2H/season sample, saturates that high) — wide enough that a
 *  legitimate near-100% observed rate still inverts to a distinct mu instead
 *  of pinning at the search ceiling (adversarial review finding, 2026-07-20:
 *  the prior hi=8 saturated around overPct≈0.986, silently losing precision
 *  on the two non-circular, real-money rungs F1/F2). */
const BISECTION_HI = 20;

/** Invert a single over/under hit-rate into an implied total-goals mu via
 *  bisection on the Poisson survival function. P(total > line) is monotone
 *  increasing in mu, so bisection converges reliably without a closed form. */
function invertOverRateToMu(overPct: number | null | undefined, line: number): number | null {
  if (typeof overPct !== "number" || !Number.isFinite(overPct) || overPct <= 0 || overPct >= 1) {
    return null;
  }
  const floorGoal = Math.floor(line) + 1;
  const tailProb = (mu: number): number => {
    let p = 0;
    for (let g = floorGoal; g <= MAX_TOTAL_GOALS; g++) p += poissonPMF(g, mu);
    return p;
  };
  let lo = 0.1;
  let hi = BISECTION_HI;
  for (let i = 0; i < BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (tailProb(mid) < overPct) lo = mid;
    else hi = mid;
  }
  return clamp((lo + hi) / 2, LAMBDA_MIN * 2, MAX_TOTAL_GOALS);
}

/** Split a total-goals mu into home/away lambdas using the league's own
 *  home/away scoring split — none of the fallback rungs below carry a
 *  fixture-specific home/away asymmetry signal of their own. */
function splitByLeagueRatio(
  muTotal: number,
  league: string
): { lambdaHome: number; lambdaAway: number } {
  const lp = getLeagueParams(league);
  const total = lp.homeAvg + lp.awayAvg;
  // Defensive-in-depth (testing review finding, 2026-07-20): every entry in
  // execution/index.ts's LEAGUE_PARAMS table, including its Default fallback
  // (homeAvg 1.45 / awayAvg 1.15), is a positive figure — total > 0 always
  // holds today, so this 0.55 branch is not reachable through any current
  // league string. Kept as a real, non-degenerate fallback (not a 50/50
  // punt) rather than assuming that invariant can never change.
  const homeShare = total > 0 ? lp.homeAvg / total : 0.55;
  return {
    lambdaHome: clamp(muTotal * homeShare, LAMBDA_MIN, LAMBDA_MAX),
    lambdaAway: clamp(muTotal * (1 - homeShare), LAMBDA_MIN, LAMBDA_MAX),
  };
}

function toV3Lambdas(
  lambdaHome: number,
  lambdaAway: number,
  league: string,
  leagueId: string | null | undefined,
  lakeBaselines: Record<string, number> | null | undefined
): V3Lambdas {
  return {
    lambdaHome,
    lambdaAway,
    mu: lambdaHome + lambdaAway,
    // Distinct from computeV3Lambdas' own "multiplicative"/"simple-average"
    // labels (maintainability review finding, 2026-07-20) — this λ came from
    // the F1-F4 ladder, not either of that function's real formulas; reusing
    // "simple-average" would let a reader auditing by .method misattribute a
    // fallback-ladder fixture to the real simple-average path.
    method: "fallback",
    shrunk: true,
    xgBlended: false,
    leaguePerTeamAvg: v3LeaguePerTeamAvg(league, leagueId, lakeBaselines),
    hfaApplied: false,
    ratingsBlended: false,
  };
}

/** F4's own split: skew the league-baseline mu by the devigged 1X2 book's
 *  home/away probability differential. Exported so its arithmetic can be
 *  unit-tested directly — the real F1-F3 ladder always resolves before F4 is
 *  reached (v3LeaguePerTeamAvg's hardcoded default means F3 never fails), so
 *  this branch is otherwise untestable through computeLambdaFallback alone
 *  (testing review finding, 2026-07-20). */
export function computeMarketImpliedSplit(
  muTotal: number,
  devigged1x2: { pHome: number; pDraw: number; pAway: number }
): { lambdaHome: number; lambdaAway: number } {
  const skew = clamp(devigged1x2.pHome - devigged1x2.pAway, -0.6, 0.6);
  return {
    lambdaHome: clamp(muTotal / 2 + skew * muTotal * 0.35, LAMBDA_MIN, LAMBDA_MAX),
    lambdaAway: clamp(muTotal / 2 - skew * muTotal * 0.35, LAMBDA_MIN, LAMBDA_MAX),
  };
}

export interface LambdaFallbackInput {
  league: string;
  leagueId?: string | null;
  lakeBaselines?: Record<string, number> | null;
  /** F1 — this fixture's own H2H over-2.5 hit rate (StatsOverride.h2hOversRate
   *  / V3AllMarketsInput.h2hOversRate, computed by selectFixtures.ts's
   *  computeH2hAggregate() from real head-to-head scorelines). */
  h2hOver25Pct?: number | null;
  /** F2 — each team's own season O2.5 hit-rate (V3EmpiricalInputs.ou25PctH/A),
   *  independent of this specific pairing. Averaged when both sides exist;
   *  either alone is still used when only one side has data. */
  ou25PctH?: number | null;
  ou25PctA?: number | null;
  /** F4 — devigged 1X2 market probabilities (already computed upstream for
   *  every fixture that reaches pricing at all). */
  devigged1x2?: { pHome: number; pDraw: number; pAway: number } | null;
}

export function computeLambdaFallback(input: LambdaFallbackInput): LambdaFallbackResult | null {
  // F1 — H2H-derived.
  {
    const mu = invertOverRateToMu(input.h2hOver25Pct, 2.5);
    if (mu !== null) {
      const { lambdaHome, lambdaAway } = splitByLeagueRatio(mu, input.league);
      return {
        lambdas: toV3Lambdas(
          lambdaHome,
          lambdaAway,
          input.league,
          input.leagueId,
          input.lakeBaselines
        ),
        basis: "h2h",
        label: "priced on head-to-head history (F1)",
      };
    }
  }

  // F2 — hit-rate inversion (each team's own season O/U rate).
  {
    const pcts = [input.ou25PctH, input.ou25PctA].filter(
      (p): p is number => typeof p === "number" && Number.isFinite(p)
    );
    if (pcts.length > 0) {
      const avgPct = pcts.reduce((a, b) => a + b, 0) / pcts.length;
      const mu = invertOverRateToMu(avgPct, 2.5);
      if (mu !== null) {
        const { lambdaHome, lambdaAway } = splitByLeagueRatio(mu, input.league);
        return {
          lambdas: toV3Lambdas(
            lambdaHome,
            lambdaAway,
            input.league,
            input.leagueId,
            input.lakeBaselines
          ),
          basis: "hit-rate",
          label: "priced on season O/U hit-rate inversion (F2)",
        };
      }
    }
  }

  // F3 — league baseline. Always resolvable (v3LeaguePerTeamAvg has a
  // hardcoded default floor), so this rung never itself returns null.
  {
    const L = v3LeaguePerTeamAvg(input.league, input.leagueId, input.lakeBaselines);
    if (L > 0) {
      const { lambdaHome, lambdaAway } = splitByLeagueRatio(L * 2, input.league);
      return {
        lambdas: toV3Lambdas(
          lambdaHome,
          lambdaAway,
          input.league,
          input.leagueId,
          input.lakeBaselines
        ),
        basis: "league-baseline",
        label: "priced on league baseline (F3)",
      };
    }
  }

  // F4 — market-implied via the devigged 1X2 book. Watchlist-only at the
  // caller (CIRCULAR_LAMBDA_BASES) — pricing EV off a λ derived from the
  // fixture's own odds is circular, not a real edge.
  if (input.devigged1x2) {
    const L = v3LeaguePerTeamAvg(input.league, input.leagueId, input.lakeBaselines);
    const { lambdaHome, lambdaAway } = computeMarketImpliedSplit(L * 2, input.devigged1x2);
    return {
      lambdas: toV3Lambdas(
        lambdaHome,
        lambdaAway,
        input.league,
        input.leagueId,
        input.lakeBaselines
      ),
      basis: "market-implied-1x2",
      label: "priced on market-implied 1X2 (F4, watchlist-only — circular EV)",
    };
  }

  // Defensive-in-depth, not reachable today: F3 above always resolves (same
  // hardcoded-default guarantee documented on that rung), so this null only
  // fires if a future caller reaches this function with neither H2H/hit-rate/
  // devigged1x2 data NOR a league string v3LeaguePerTeamAvg can resolve —
  // which, given that function's own unconditional default floor, cannot
  // happen through any input shape this interface allows (testing review
  // finding, 2026-07-20).
  return null;
}
