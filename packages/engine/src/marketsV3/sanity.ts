/** all-markets-analysis-prompt-v3 §5.6/Phase 6 — slate-level sanity checks (PR-3).
 *
 *  A post-hoc audit over a whole day's gate assessments — never suppresses a
 *  pick, only flags when the MODEL (not any single fixture) looks off:
 *    (a) cap-rate: capped / (capped + done-with-raw-edge>5pts) > 0.25 ⇒ the
 *        model is running systematically hot (too many "almost done but
 *        capped" selections relative to genuine survivors).
 *    (b) result-family skew: DONE result-class picks (DNB/DC/AH/handicap/
 *        winning-margin) lean ≥70% one side — could be real market
 *        inefficiency, or a systematic HFA/shape bug. Flagged either way.
 *    (c) totals skew: DONE totals-class picks (O/U, team totals) lean ≥70%
 *        one direction.
 *
 *  `goalsSlateSanityChecks` runs (a)+(c) only — the lean goals path has no
 *  result-class candidates (no DNB/AH/handicap markets on that pipeline).
 *
 *  Wired into the report layer in PR-5 (outputs.ts's `formatFinalSummary`);
 *  this module stays pure/fixture-agnostic so it's testable standalone.
 *  Structural (duck-typed) input so it accepts both the all-markets
 *  `V3MarketOutcomeAssessment` and the goals-path `V3MarketAssessment`
 *  without importing either (no cross-pipeline coupling). Pure math, no I/O. */

import { dirOfDesc, sideOfDesc } from "./descParse.js";

const CAP_RATE_THRESHOLD = 0.25;
const SKEW_THRESHOLD = 0.7;
const RAW_EDGE_HOT_THRESHOLD = 0.05;

const RESULT_FAMILIES = new Set([
  "dnb",
  "double_chance",
  "asian_handicap",
  "handicap",
  "winning_margin",
]);
const TOTALS_FAMILIES = new Set(["goals_ou", "team_total"]);
/** Goals-path `cat` values are FAMILY_LABEL human strings, not MarketFamily ids. */
const GOALS_TOTALS_CATS = new Set(["Goals O/U", "Team Total"]);

export type V3SanityFlag =
  | "model_miscalibration"
  | "result_skew_home"
  | "result_skew_away"
  | "totals_skew_over"
  | "totals_skew_under";

export interface V3SanityResult {
  flags: V3SanityFlag[];
  capRate: number | null;
  resultHomeShare: number | null;
  resultAwayShare: number | null;
  totalsOverShare: number | null;
  totalsUnderShare: number | null;
}

interface SanityGateOutcome {
  outcome: "done" | "capped" | "noise" | "below_gate" | "below_edge";
  rawEdge: number;
}

/** All-markets assessment shape (structurally matches V3MarketOutcomeAssessment). */
export interface AllMarketsSanityInput extends SanityGateOutcome {
  family: string;
  desc: string;
}

/** Goals-path assessment shape (structurally matches V3MarketAssessment). */
export interface GoalsSanityInput extends SanityGateOutcome {
  cat: string;
  label: string;
}

/** (a) cap-rate. Division guard: a quiet slate (denominator 0) reports
 *  capRate=null, never NaN — absence of signal is not a miscalibration flag. */
function capRateCheck(assessments: SanityGateOutcome[]): {
  flag: V3SanityFlag | null;
  capRate: number | null;
} {
  const capped = assessments.filter((a) => a.outcome === "capped").length;
  const hotDone = assessments.filter(
    (a) => a.outcome === "done" && a.rawEdge > RAW_EDGE_HOT_THRESHOLD
  ).length;
  const denom = capped + hotDone;
  if (denom === 0) return { flag: null, capRate: null };
  const capRate = capped / denom;
  return { flag: capRate > CAP_RATE_THRESHOLD ? "model_miscalibration" : null, capRate };
}

function resultSkewCheck(assessments: AllMarketsSanityInput[]): {
  flag: V3SanityFlag | null;
  homeShare: number | null;
  awayShare: number | null;
} {
  const done = assessments.filter((a) => a.outcome === "done" && RESULT_FAMILIES.has(a.family));
  let home = 0;
  let away = 0;
  for (const a of done) {
    const side = sideOfDesc(a.desc);
    if (side === "home") home++;
    else if (side === "away") away++;
  }
  const total = home + away;
  if (total === 0) return { flag: null, homeShare: null, awayShare: null };
  const homeShare = home / total;
  const awayShare = away / total;
  if (homeShare >= SKEW_THRESHOLD) return { flag: "result_skew_home", homeShare, awayShare };
  if (awayShare >= SKEW_THRESHOLD) return { flag: "result_skew_away", homeShare, awayShare };
  return { flag: null, homeShare, awayShare };
}

function totalsSkewCheckAllMarkets(assessments: AllMarketsSanityInput[]): {
  flag: V3SanityFlag | null;
  overShare: number | null;
  underShare: number | null;
} {
  const done = assessments.filter((a) => a.outcome === "done" && TOTALS_FAMILIES.has(a.family));
  return totalsSkewFromDescs(done.map((a) => a.desc));
}

function totalsSkewCheckGoals(assessments: GoalsSanityInput[]): {
  flag: V3SanityFlag | null;
  overShare: number | null;
  underShare: number | null;
} {
  const done = assessments.filter((a) => a.outcome === "done" && GOALS_TOTALS_CATS.has(a.cat));
  return totalsSkewFromDescs(done.map((a) => a.label));
}

function totalsSkewFromDescs(descs: string[]): {
  flag: V3SanityFlag | null;
  overShare: number | null;
  underShare: number | null;
} {
  let over = 0;
  let under = 0;
  for (const desc of descs) {
    const dir = dirOfDesc(desc);
    if (dir === "over") over++;
    else if (dir === "under") under++;
  }
  const total = over + under;
  if (total === 0) return { flag: null, overShare: null, underShare: null };
  const overShare = over / total;
  const underShare = under / total;
  if (overShare >= SKEW_THRESHOLD) return { flag: "totals_skew_over", overShare, underShare };
  if (underShare >= SKEW_THRESHOLD) return { flag: "totals_skew_under", overShare, underShare };
  return { flag: null, overShare, underShare };
}

/** Full all-markets slate sweep: (a) cap-rate + (b) result-skew + (c) totals-skew. */
export function slateSanityChecks(assessments: AllMarketsSanityInput[]): V3SanityResult {
  const cap = capRateCheck(assessments);
  const result = resultSkewCheck(assessments);
  const totals = totalsSkewCheckAllMarkets(assessments);
  const flags = [cap.flag, result.flag, totals.flag].filter((f): f is V3SanityFlag => f !== null);
  return {
    flags,
    capRate: cap.capRate,
    resultHomeShare: result.homeShare,
    resultAwayShare: result.awayShare,
    totalsOverShare: totals.overShare,
    totalsUnderShare: totals.underShare,
  };
}

/** Goals-only slate sweep: (a) cap-rate + (c) totals-skew — no result-class
 *  candidates exist on the lean goals path. */
export function goalsSlateSanityChecks(assessments: GoalsSanityInput[]): V3SanityResult {
  const cap = capRateCheck(assessments);
  const totals = totalsSkewCheckGoals(assessments);
  const flags = [cap.flag, totals.flag].filter((f): f is V3SanityFlag => f !== null);
  return {
    flags,
    capRate: cap.capRate,
    resultHomeShare: null,
    resultAwayShare: null,
    totalsOverShare: totals.overShare,
    totalsUnderShare: totals.underShare,
  };
}

const FLAG_LABEL: Record<V3SanityFlag, string> = {
  model_miscalibration: "cap-rate >25% — model may be running hot (too many capped selections)",
  result_skew_home:
    "result-family picks skew ≥70% Home — verify HFA/shape isn't systematically biased",
  result_skew_away:
    "result-family picks skew ≥70% Away — verify HFA/shape isn't systematically biased",
  totals_skew_over: "totals picks skew ≥70% Over — verify λ isn't running hot",
  totals_skew_under: "totals picks skew ≥70% Under — verify λ isn't running cold",
};

/** Render sanity flags for the report. Named `formatSanityFlags` (not
 *  `formatFinalSummary`) to avoid colliding with outputs.ts's existing
 *  Phase-6 `formatFinalSummary` export — PR-5 composes this output into that
 *  renderer. Sanity NEVER suppresses a pick; this is an audit line only. */
export function formatSanityFlags(result: V3SanityResult): string {
  if (result.flags.length === 0) return "Sanity checks: clean (no flags)";
  return `Sanity checks: ${result.flags.map((f) => FLAG_LABEL[f]).join("; ")}`;
}
