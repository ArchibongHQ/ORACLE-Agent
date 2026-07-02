/** goals-market-analysis-prompt-v3 §3.1 — expected goals per side (λ).
 *
 *  Multiplicative attack × defence × league model:
 *      λ_home = (H_scored/90 ÷ L) × (A_conceded/90 ÷ L) × L
 *      λ_away = (A_scored/90 ÷ L) × (H_conceded/90 ÷ L) × L
 *  where L = league average goals per TEAM per game. Falls back to the simple
 *  average ((scored + opp conceded) / 2) when a factor is missing. Small-sample
 *  regression (n < 8): λ_adj = λ_raw × (n/8) + L × (1 − n/8). Optional 50/50
 *  blend with an xG-based λ computed through the same formula (xG is more
 *  stable on small samples — spec §3.1 refinement).
 *
 *  Pure math, no I/O, no runtime imports. */

import { getLeagueParams } from "../execution/index.js";
import { clamp } from "../math/index.js";

/** v3 §3.4 league baselines — goals per GAME (halve for per-team L). Spec table
 *  verbatim; entries the engine's LEAGUE_PARAMS also covers defer to the spec
 *  here because the v3 gate math was calibrated against these totals. */
export const V3_LEAGUE_BASELINES: Record<string, number> = {
  "World Cup": 2.75,
  "Premier League": 2.85,
  Bundesliga: 3.15,
  "La Liga": 2.65,
  "Serie A": 2.6,
  "Ligue 1": 2.75,
  Eredivisie: 3.2,
  Championship: 2.55,
  "Brazilian Serie B": 2.4,
  "Botola Pro": 2.3,
  "USL League Two": 3.0,
  "Copa Chile": 2.6,
};

/** Default league total (goals per game) when neither the v3 table nor the
 *  engine's LEAGUE_PARAMS knows the league. */
export const V3_DEFAULT_LEAGUE_GPG = 2.6;

/** League average goals per TEAM per game (the `L` of §3.1). Lookup order:
 *  v3 spec table → engine LEAGUE_PARAMS (homeAvg + awayAvg is the league's
 *  per-game total) → 2.60 default. */
export function v3LeaguePerTeamAvg(league: string): number {
  const spec = V3_LEAGUE_BASELINES[league];
  if (spec) return spec / 2;
  const lp = getLeagueParams(league);
  if (lp) return (lp.homeAvg + lp.awayAvg) / 2;
  return V3_DEFAULT_LEAGUE_GPG / 2;
}

/** Per-team xG rates (per match, from the rolling xG table). `estimated` marks
 *  AI-Mode-sourced figures (softer penalty than missing, §0.2 fallback tier). */
export interface V3TeamXg {
  /** xG for (created) per match. */
  xgf?: number | null;
  /** xG against (conceded) per match. */
  xga?: number | null;
}

export interface V3LambdaInput {
  league: string;
  homeScoredPer90?: number | null;
  homeConcededPer90?: number | null;
  awayScoredPer90?: number | null;
  awayConcededPer90?: number | null;
  /** Matches behind the home/away season averages (shrinkage trigger, n < 8). */
  nHome?: number | null;
  nAway?: number | null;
  /** Venue-appropriate xG rates when available (home team's home split,
   *  away team's away split — falls back to season aggregate upstream). */
  homeXg?: V3TeamXg | null;
  awayXg?: V3TeamXg | null;
}

export interface V3Lambdas {
  lambdaHome: number;
  lambdaAway: number;
  mu: number;
  /** Which §3.1 formula produced the goals-based λ. */
  method: "multiplicative" | "simple-average";
  /** True when small-sample regression (n < 8) moved either λ. */
  shrunk: boolean;
  /** True when the 50/50 xG blend was applied. */
  xgBlended: boolean;
  /** Per-team L used (league goals per team per game). */
  leaguePerTeamAvg: number;
}

const SHRINK_N = 8;
/** λ sanity clamp — a team model outside this range is a data artifact, not a
 *  forecast (0.05 keeps Poisson tails well-defined; 4.5 exceeds any real team). */
const LAMBDA_MIN = 0.05;
const LAMBDA_MAX = 4.5;

function isRate(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** One side's multiplicative λ; null when either factor is missing. */
function multiplicativeLambda(
  scoredPer90: number | null | undefined,
  oppConcededPer90: number | null | undefined,
  L: number
): number | null {
  if (!isRate(scoredPer90) || !isRate(oppConcededPer90)) return null;
  return (scoredPer90 / L) * (oppConcededPer90 / L) * L;
}

/** One side's simple-average fallback λ; null when both inputs are missing. */
function simpleAverageLambda(
  scoredPer90: number | null | undefined,
  oppConcededPer90: number | null | undefined
): number | null {
  const s = isRate(scoredPer90) ? scoredPer90 : null;
  const c = isRate(oppConcededPer90) ? oppConcededPer90 : null;
  if (s === null && c === null) return null;
  if (s !== null && c !== null) return (s + c) / 2;
  return s ?? c;
}

/** §3.1 small-sample regression toward the league mean (cap n at 8). */
function shrink(lambda: number, n: number | null | undefined, L: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n >= SHRINK_N) return lambda;
  const w = Math.max(0, n) / SHRINK_N;
  return lambda * w + L * (1 - w);
}

/** Compute v3 lambdas for one fixture. Both sides use the multiplicative model
 *  when all four factors exist; a side missing a factor drops the WHOLE fixture
 *  to the simple-average method (mixing formulas across sides would skew the
 *  split the match-shape step later corrects). Returns null when neither team
 *  has any usable scoring signal — the completeness gate upstream should have
 *  discarded such fixtures already. */
export function computeV3Lambdas(
  input: V3LambdaInput,
  opts: { xgBlend?: boolean } = {}
): V3Lambdas | null {
  const L = v3LeaguePerTeamAvg(input.league);

  let method: V3Lambdas["method"] = "multiplicative";
  let rawH = multiplicativeLambda(input.homeScoredPer90, input.awayConcededPer90, L);
  let rawA = multiplicativeLambda(input.awayScoredPer90, input.homeConcededPer90, L);
  if (rawH === null || rawA === null) {
    method = "simple-average";
    rawH = simpleAverageLambda(input.homeScoredPer90, input.awayConcededPer90);
    rawA = simpleAverageLambda(input.awayScoredPer90, input.homeConcededPer90);
  }
  if (rawH === null || rawA === null) return null;

  const shrunkH = shrink(rawH, input.nHome, L);
  const shrunkA = shrink(rawA, input.nAway, L);
  const shrunk = shrunkH !== rawH || shrunkA !== rawA;

  // Optional 50/50 xG blend (§3.1 refinement): xG-based λ through the same
  // multiplicative shape — home creation vs away concession and vice versa.
  let lH = shrunkH;
  let lA = shrunkA;
  let xgBlended = false;
  if (opts.xgBlend !== false) {
    const xgH = multiplicativeLambda(input.homeXg?.xgf, input.awayXg?.xga, L);
    const xgA = multiplicativeLambda(input.awayXg?.xgf, input.homeXg?.xga, L);
    if (xgH !== null && xgA !== null) {
      lH = (shrunkH + xgH) / 2;
      lA = (shrunkA + xgA) / 2;
      xgBlended = true;
    }
  }

  lH = clamp(lH, LAMBDA_MIN, LAMBDA_MAX);
  lA = clamp(lA, LAMBDA_MIN, LAMBDA_MAX);
  return {
    lambdaHome: lH,
    lambdaAway: lA,
    mu: lH + lA,
    method,
    shrunk,
    xgBlended,
    leaguePerTeamAvg: L,
  };
}
