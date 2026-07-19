/** Fixture "Data Analysis" panel — mathematical modeling + visual-report data
 *  for one fixture, synthesizing the same deterministic v3 primitives
 *  (buildV3Grid/buildV3HalfGrid/resultProbs/devig/NB corners tail) the live
 *  pricer uses, into the chart-shaped output the owner's reference
 *  screenshot showed (2026-07-19): Result 1X2 with market deltas, BTTS,
 *  Goals O/U at multiple lines, First Half Winner, Team To Score First,
 *  Corners O/U at multiple lines, per-team Goals O/U (home/away split), and
 *  a Score analysis section (outcome pie + ranked top scorelines per
 *  outcome).
 *
 *  Display/report-only: this module NEVER feeds picks, ranking, or the +EV
 *  gate — it exists so a reader can see the model's own probability surface
 *  next to the market's, the same way the Green Flags block shows the
 *  pattern detector's reasoning. Reuses `detectPatterns`'s PatternInput as
 *  its input contract (the report layer already builds one of these per
 *  fixture — see packages/runtime/src/reportPatterns.ts) rather than
 *  inventing a second input shape, but computes its own expected goals via
 *  the SAME matchup-adjusted convention `detectGoalMachine` uses
 *  (expHome=(homeScoredHome+awayConcededAway)/2) rather than the live
 *  pricer's full λ fallback ladder (computeV3Lambdas) — that ladder consumes
 *  a differently-shaped V3LambdaInput built from the live per-fixture run,
 *  not from the report-time PatternInput this panel receives; reusing it
 *  here would mean building a third parallel input mapper. This keeps the
 *  panel's math internally consistent with the same green-flags input it's
 *  rendered alongside, at the cost of NOT being byte-identical to the live
 *  pick engine's own λ (same honesty tradeoff reportPatterns.ts's header
 *  already documents for its own numbers).
 *
 *  Pure math, no I/O. */

import { resolveRho } from "../goalsV3/lambda.js";
import { devigThreeWay, devigTwoWay } from "../markets/devig.js";
import { poissonPMF } from "../math/index.js";
import {
  CORNERS_R_DEFAULT,
  clampCornersDispersion,
  nbTailOver,
  nbTailUnder,
} from "./engines/corners.js";
import { V3_FIRST_HALF_SHARE_DEFAULT } from "./engines/half.js";
import { buildV3Grid, buildV3HalfGrid, resultProbs, sumWhere } from "./grid.js";
import type { PatternInput } from "./patterns.js";

/** One outcome's model probability alongside the market's devigged fair
 *  probability (when odds were supplied) and the delta between them
 *  (model − market, percentage points). `marketPct` / `deltaPct` are null
 *  when no usable odds exist for this outcome — never fabricated. */
export interface ModelVsMarket {
  label: string;
  modelPct: number;
  marketPct: number | null;
  deltaPct: number | null;
}

export interface GoalsLine {
  line: number;
  overPct: number;
  underPct: number;
}

export interface ScorelineRow {
  score: string;
  pct: number;
}

export interface FixtureAnalysisPanel {
  /** Full-time 1X2 — model vs market (devigged) with delta. */
  result1x2: ModelVsMarket[];
  /** BTTS Yes/No — model vs market (devigged) with delta. */
  btts: ModelVsMarket[];
  /** Full-time total-goals Over/Under at the doc's standard lines. */
  goalsOU: GoalsLine[];
  /** First-half 1X2 — model only (no reliable market devig source at
   *  report-build time; see header comment). */
  firstHalfWinner: { home: number; draw: number; away: number };
  /** "Team to score first" — competing independent-Poisson-race derivation,
   *  not implemented anywhere else in the engine (see teamToScoreFirst()). */
  teamToScoreFirst: { home: number; noGoal: number; away: number };
  /** Combined-corners Over/Under at the doc's standard lines. Empty when
   *  corners inputs are missing (never fabricated). */
  cornersOU: GoalsLine[];
  /** Per-team goals O/U, home side scoring at home / away side scoring away
   *  (marginal Poisson, not the joint grid — matches the doc's per-team
   *  framing). Each array empty when that side's rate is unavailable. */
  teamGoalsOU: { home: GoalsLine[]; away: GoalsLine[] };
  /** Score analysis: ranked top scorelines within EACH outcome (home win /
   *  draw / away win), probabilities are P(exact score) — NOT re-normalised
   *  within the outcome, so they sum to that outcome's own resultProbs
   *  share, matching the reference screenshot's "3 columns summing to each
   *  outcome's total probability" layout. */
  scoreAnalysis: {
    outcomePct: { home: number; draw: number; away: number };
    home: ScorelineRow[];
    draw: ScorelineRow[];
    away: ScorelineRow[];
  };
}

const STANDARD_GOALS_LINES = [1.5, 2.5, 3.5, 4.5] as const;
const STANDARD_CORNERS_LINES = [8.5, 9.5, 10.5, 11.5] as const;
const TOP_SCORELINES_PER_OUTCOME = 5;

const pct = (p: number): number => Math.round(p * 1000) / 10; // 1 decimal place, 0-100 scale

function modelVsMarketTwoWay(
  labelA: string,
  labelB: string,
  modelA: number,
  modelB: number,
  oddsA: number | undefined,
  oddsB: number | undefined
): ModelVsMarket[] {
  const fair = devigTwoWay(oddsA, oddsB);
  return [
    {
      label: labelA,
      modelPct: pct(modelA),
      marketPct: fair ? pct(fair[0]) : null,
      deltaPct: fair ? pct(modelA - fair[0]) : null,
    },
    {
      label: labelB,
      modelPct: pct(modelB),
      marketPct: fair ? pct(fair[1]) : null,
      deltaPct: fair ? pct(modelB - fair[1]) : null,
    },
  ];
}

/** Matchup-adjusted expected goals — the SAME convention detectGoalMachine
 *  (patterns.ts) already uses, kept identical so this panel's headline
 *  numbers agree with the Green Flags block it's rendered alongside. */
function expectedGoals(input: PatternInput): { expHome: number; expAway: number } {
  return {
    expHome: (input.homeScoredHome + input.awayConcededAway) / 2,
    expAway: (input.awayScoredAway + input.homeConcededHome) / 2,
  };
}

function goalsOULines(mat: number[][], lines: readonly number[]): GoalsLine[] {
  return lines.map((line) => {
    const overPct = sumWhere(mat, (h, a) => h + a > line);
    return { line, overPct: pct(overPct), underPct: pct(1 - overPct) };
  });
}

/** Marginal single-side Over/Under from a plain Poisson PMF (not the joint
 *  grid) — matches the doc's per-team framing, where each team's total is
 *  assessed independently of the opponent's score. Truncates the tail at 12
 *  goals (P(X>12) is negligible for realistic λ) folded into the last bucket
 *  so probabilities are exact, not approximate. */
function teamGoalsOULines(lambda: number, lines: readonly number[]): GoalsLine[] {
  const MAX_K = 12;
  const pmf: number[] = [];
  let cum = 0;
  for (let k = 0; k <= MAX_K; k++) {
    const p = poissonPMF(k, lambda);
    pmf.push(p);
    cum += p;
  }
  // Fold remaining tail mass into the last bucket so cdf(MAX_K) == 1.
  const tail = Math.max(0, 1 - cum);
  const lastIdx = pmf.length - 1;
  pmf[lastIdx] = (pmf[lastIdx] ?? 0) + tail;

  return lines.map((line) => {
    const belowOrEq = Math.floor(line);
    let cdf = 0;
    for (let k = 0; k <= belowOrEq && k < pmf.length; k++) cdf += pmf[k] ?? 0;
    const overPct = 1 - cdf;
    return { line, overPct: pct(overPct), underPct: pct(1 - overPct) };
  });
}

/** "Team to score first" — competing independent Poisson processes. Treats
 *  each side's goal-scoring as a Poisson arrival process with rate λ over
 *  the match; the probability neither side scores is e^-(λh+λa), and
 *  conditional on SOME goal being scored, the first-scorer probability
 *  splits in proportion to each side's rate (a standard competing-Poisson-
 *  race result, memoryless-arrivals property — not derived from the score
 *  grid, which only gives FINAL score distribution, not scoring ORDER). Not
 *  implemented anywhere else in the engine; new derivation for this panel. */
function teamToScoreFirst(
  expHome: number,
  expAway: number
): { home: number; noGoal: number; away: number } {
  const totalRate = expHome + expAway;
  const noGoal = Math.exp(-totalRate);
  const someGoal = 1 - noGoal;
  const home = totalRate > 0 ? someGoal * (expHome / totalRate) : 0;
  const away = totalRate > 0 ? someGoal * (expAway / totalRate) : 0;
  return { home: pct(home), noGoal: pct(noGoal), away: pct(away) };
}

/** Ranked top-N scorelines within one outcome (home win / draw / away win),
 *  probabilities are the RAW grid cell values (P(exact score)), summing to
 *  that outcome's own resultProbs share — matches the reference screenshot
 *  where each outcome column's rows sum to that outcome's overall percentage,
 *  not to 100% independently. */
function topScorelinesFor(
  mat: number[][],
  pred: (home: number, away: number) => boolean
): ScorelineRow[] {
  const rows: ScorelineRow[] = [];
  for (let i = 0; i < mat.length; i++) {
    const row = mat[i];
    if (!row) continue;
    for (let j = 0; j < row.length; j++) {
      if (!pred(i, j)) continue;
      const p = row[j] ?? 0;
      if (p > 0) rows.push({ score: `${i}-${j}`, pct: pct(p) });
    }
  }
  rows.sort((a, b) => b.pct - a.pct);
  return rows.slice(0, TOP_SCORELINES_PER_OUTCOME);
}

/** Build the full Data Analysis panel for one fixture. `league` resolves the
 *  Dixon-Coles rho (falls back to the global default for an unrecognised
 *  league — resolveRho never throws). Returns null only when neither core
 *  goal rate is usable (mirrors buildReportPatternInput's own null contract
 *  — PatternInput's four venue-split fields are actually required/non-
 *  optional on the type, so this only guards against non-finite values a
 *  caller might still pass through a loosely-typed boundary). */
export function buildFixtureAnalysisPanel(
  input: PatternInput,
  league?: string
): FixtureAnalysisPanel | null {
  const { homeScoredHome, homeConcededHome, awayScoredAway, awayConcededAway } = input;
  if (
    !Number.isFinite(homeScoredHome) ||
    !Number.isFinite(homeConcededHome) ||
    !Number.isFinite(awayScoredAway) ||
    !Number.isFinite(awayConcededAway)
  ) {
    return null;
  }

  const { expHome, expAway } = expectedGoals(input);
  const rho = resolveRho(league ?? input.league ?? "");
  const grid = buildV3Grid(expHome, expAway, rho);
  const halfGrid = buildV3HalfGrid(
    expHome * V3_FIRST_HALF_SHARE_DEFAULT,
    expAway * V3_FIRST_HALF_SHARE_DEFAULT
  );

  const rp = resultProbs(grid);
  const result1x2: ModelVsMarket[] = (() => {
    const fair = devigThreeWay(input.homeOdds, input.drawOdds, input.awayOdds);
    const rows: [string, number][] = [
      ["Home", rp.pHome],
      ["Draw", rp.pDraw],
      ["Away", rp.pAway],
    ];
    return rows.map(([label, modelP], idx) => ({
      label,
      modelPct: pct(modelP),
      marketPct: fair ? pct(fair[idx] ?? 0) : null,
      deltaPct: fair ? pct(modelP - (fair[idx] ?? 0)) : null,
    }));
  })();

  const bttsYesP = sumWhere(grid, (h, a) => h > 0 && a > 0);
  const btts = modelVsMarketTwoWay(
    "Yes",
    "No",
    bttsYesP,
    1 - bttsYesP,
    input.bttsYesOdds,
    input.bttsNoOdds
  );

  const goalsOU = goalsOULines(grid, STANDARD_GOALS_LINES);

  const hfProbs = resultProbs(halfGrid);
  const firstHalfWinner = {
    home: pct(hfProbs.pHome),
    draw: pct(hfProbs.pDraw),
    away: pct(hfProbs.pAway),
  };

  const tsf = teamToScoreFirst(expHome, expAway);

  const cornersR = clampCornersDispersion(CORNERS_R_DEFAULT);
  const cornersForH = input.cornersForH;
  const cornersAgainstA = input.cornersAgainstA;
  const cornersForA = input.cornersForA;
  const cornersAgainstH = input.cornersAgainstH;
  let cornersOU: GoalsLine[] = [];
  if (
    Number.isFinite(cornersForH) &&
    Number.isFinite(cornersAgainstA) &&
    Number.isFinite(cornersForA) &&
    Number.isFinite(cornersAgainstH)
  ) {
    const expCornersH = ((cornersForH as number) + (cornersAgainstA as number)) / 2;
    const expCornersA = ((cornersForA as number) + (cornersAgainstH as number)) / 2;
    const meanCorners = expCornersH + expCornersA;
    cornersOU = STANDARD_CORNERS_LINES.map((line) => ({
      line,
      overPct: pct(nbTailOver(line, meanCorners, cornersR)),
      underPct: pct(nbTailUnder(line, meanCorners, cornersR)),
    }));
  }

  const teamGoalsOU = {
    home: teamGoalsOULines(expHome, STANDARD_GOALS_LINES),
    away: teamGoalsOULines(expAway, STANDARD_GOALS_LINES),
  };

  const scoreAnalysis = {
    outcomePct: { home: pct(rp.pHome), draw: pct(rp.pDraw), away: pct(rp.pAway) },
    home: topScorelinesFor(grid, (h, a) => h > a),
    draw: topScorelinesFor(grid, (h, a) => h === a),
    away: topScorelinesFor(grid, (h, a) => h < a),
  };

  return {
    result1x2,
    btts,
    goalsOU,
    firstHalfWinner,
    teamToScoreFirst: tsf,
    cornersOU,
    teamGoalsOU,
    scoreAnalysis,
  };
}
