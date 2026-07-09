/** PR-25 item 4 — non-penalty xG (npxG) as a distinct finishing-luck signal,
 *  surfaced alongside the existing xgf/xga pair rather than folded into it.
 *
 *  Rationale (real-time research, 2026-07-09 — see PMC10075453 "Expected goals
 *  in football: improving model performance" and multiple independent
 *  practitioner sources): npxG strips penalty conversions, which are a
 *  discrete, taker-dependent event unrelated to open-play scoring quality — a
 *  team's actual scoring rate running well above its own npxG (or well below
 *  it) is the standard "finishing luck" signal that tends to mean-revert
 *  within a handful of matches, more reliably than raw goal difference does
 *  in the same window.
 *
 *  SHADOW MODE ONLY, matching every other new signal this audit introduced
 *  (skewShrink.ts, tournament-prior shrink, graduated xG penalty): this module
 *  never touches lambda, pricing, or a real pick. It flags fixtures where a
 *  team's actual scoring rate diverges from its FBref-only npxG rate by more
 *  than `thresholdPct`, for the daily report — a diagnostic, not a filter.
 *  Promote to an actual lambda regression only once ledger evidence backs it.
 *
 *  Coverage caveat: npxgf is FBref season-aggregate only (build_xg_table.py's
 *  _load_fbref_xg) — absent for Understat/FotMob/Sofascore/AI-mode-sourced
 *  teams, so this fires far less often than skewShrink. That's expected, not
 *  a bug; a fixture with no FBref npxG coverage simply isn't evaluated.
 *
 *  Pure math, no I/O. */

export const FINISHING_REGRESSION_THRESHOLD_DEFAULT = 0.25;

export interface FinishingRegressionInput {
  homeNpxgf?: number | null;
  homeScoredPer90?: number | null;
  awayNpxgf?: number | null;
  awayScoredPer90?: number | null;
}

export interface FinishingRegressionCandidate {
  side: "home" | "away";
  npxgf: number;
  actualScoredPer90: number;
  /** actualScoredPer90 / npxgf — 1.0 = exactly matching npxG, >1 overperforming
   *  (running hot), <1 underperforming (running cold). */
  ratio: number;
  direction: "overperforming" | "underperforming";
}

export interface FinishingRegressionResult {
  thresholdPct: number;
  candidates: FinishingRegressionCandidate[];
}

/** Evaluate one side's actual-vs-npxG ratio. Returns null when npxgf is
 *  absent/non-positive (no FBref coverage — the common case) or the actual
 *  rate is missing, never a fabricated 0/1. */
function evaluateSide(
  side: "home" | "away",
  npxgf: number | null | undefined,
  actualScoredPer90: number | null | undefined,
  thresholdPct: number
): FinishingRegressionCandidate | null {
  if (typeof npxgf !== "number" || !Number.isFinite(npxgf) || npxgf <= 0) return null;
  if (typeof actualScoredPer90 !== "number" || !Number.isFinite(actualScoredPer90)) return null;
  const ratio = actualScoredPer90 / npxgf;
  const deviation = Math.abs(ratio - 1);
  if (deviation < thresholdPct) return null;
  return {
    side,
    npxgf,
    actualScoredPer90,
    ratio,
    direction: ratio > 1 ? "overperforming" : "underperforming",
  };
}

/** Shadow-evaluate a single fixture's two sides against their FBref npxG rate.
 *  Cheap no-op when neither side has npxG coverage or neither diverges past
 *  `thresholdPct` — an empty result is the common, valid outcome. */
export function shadowFinishingRegression(
  input: FinishingRegressionInput,
  thresholdPct: number = FINISHING_REGRESSION_THRESHOLD_DEFAULT
): FinishingRegressionResult {
  const candidates: FinishingRegressionCandidate[] = [];
  const home = evaluateSide("home", input.homeNpxgf, input.homeScoredPer90, thresholdPct);
  if (home) candidates.push(home);
  const away = evaluateSide("away", input.awayNpxgf, input.awayScoredPer90, thresholdPct);
  if (away) candidates.push(away);
  return { thresholdPct, candidates };
}

/** Report line for the daily Telegram/log summary, alongside
 *  formatSkewShrinkShadow/formatSanityFlags. Null when nothing diverges. */
export function formatFinishingRegressionShadow(
  fixtureLabel: string,
  result: FinishingRegressionResult
): string | null {
  if (result.candidates.length === 0) return null;
  const pct = Math.round(result.thresholdPct * 100);
  const list = result.candidates
    .map(
      (c) =>
        `${c.side} ${c.direction} npxG by ${Math.abs(Math.round((c.ratio - 1) * 100))}% (${c.actualScoredPer90.toFixed(2)} actual vs ${c.npxgf.toFixed(2)} npxG)`
    )
    .join("; ");
  return `${fixtureLabel}: finishing-luck shadow (±${pct}% threshold, not applied) — ${list}`;
}
