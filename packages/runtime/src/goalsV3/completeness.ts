/** goals-market-analysis-prompt-v3 §0.1–§0.3 — data needs, reliability tiers,
 *  and the weighted completeness gate.
 *
 *  Weights (sum 100): O/U 2.5 odds 15 · last-5 form 15 · scored/90 15 ·
 *  conceded/90 15 · O/U hit-rate 10 · xG 10 · H2H 10 · lineups 5 · rest 5.
 *
 *  v4 (PR-4, default on via `enrich.completenessV4`): the mandatory block is
 *  odds/form/scored/conceded only (60) — O/U hit-rate is demoted to a
 *  critical-tier element (§4.2 `hitRateMissing` −1 penalty on missing, NOT a
 *  discard). A mandatory-only fixture now scores 60 < 70 and is legitimately
 *  discarded by the general score floor, not by an explicit mandatory-missing
 *  entry — no re-weighting invented, weights stay v4-verbatim. Set
 *  `enrich.completenessV4: false` (or `ORACLE_V3_COMPLETENESS_V4=off`) to
 *  restore the v3 behavior: hit-rate back in the mandatory (discard-on-missing)
 *  set.
 *
 *  ANY mandatory element missing ⇒ DISCARD regardless of score; score < 70 ⇒
 *  DISCARD. A fixture with all mandatory elements and nothing else scores
 *  exactly at the mandatory-block total and PASSES only if that total ≥ 70 —
 *  under v4 (60) it does not; under legacy v3 (70) it does, by design, so a
 *  no-xG lower-division fixture survives and pays the §4.2 penalty instead.
 *
 *  Also derives the §4.2 penalty flags and the source list for the §6
 *  source-citing rationale, so completeness is computed in exactly one place.
 *
 *  Pure, synchronous — enrichment state arrives via the `enrich` param. */

import type { V3PenaltyFlags } from "@oracle/engine";
import type { SportyBetEventDetail } from "../selectFixtures.js";
import { avgConceded, avgScored } from "../selectGoals.js";

export const V3_COMPLETENESS_WEIGHTS = {
  odds: 15,
  form: 15,
  scored: 15,
  conceded: 15,
  hitRate: 10,
  xg: 10,
  h2h: 10,
  lineups: 5,
  rest: 5,
} as const;

/** v3 legacy: hitRate is mandatory. v4 (default): demoted — see module docstring. */
export type V3MandatoryField = "odds" | "form" | "scored" | "conceded" | "hitRate";

/** v4 §0.3 per-selection hit-rate availability, one flag per priced line —
 *  lets a fixture with e.g. a missing O1.5 hit-rate but a present O2.5 one
 *  apply `hitRateMissing` only to the O1.5 candidate (PR-4). Undefined entries
 *  mean "unknown" — callers fall back to the fixture-wide flag below. */
export interface V3LineHitRates {
  over15?: boolean;
  over25?: boolean;
  over35?: boolean;
  btts?: boolean;
}

export interface V3EnrichmentState {
  /** True when enrichWithH2H (football-data.org) supplied H2H for this fixture. */
  h2hEnriched?: boolean;
  /** True when a confirmed or predicted lineup summary exists for this fixture. */
  lineupsAvailable?: boolean;
  /** v4 completeness gate (PR-4). Default true (config.v3CompletenessV4 !== false
   *  at the call site) — set false to restore hit-rate to the mandatory set. */
  completenessV4?: boolean;
}

/** Per-line hit-rate presence for the goals path's §0.3 per-selection penalty
 *  (PR-4) — both sides required, matching the fixture-wide `hasHitRate` check
 *  below. Exported so the worker's goals loop can build `V3AnalyzeInput.lineHitRates`
 *  without re-deriving the same field paths. */
export function deriveLineHitRates(detail: SportyBetEventDetail | undefined): V3LineHitRates {
  const ou = detail?.stats?.overunder;
  const btts = detail?.stats?.scoringConceding;
  const bothSides = (h: unknown, a: unknown): boolean =>
    typeof h === "number" && typeof a === "number";
  return {
    over15: bothSides(ou?.home?.over15_pct, ou?.away?.over15_pct),
    over25: bothSides(ou?.home?.over25_pct, ou?.away?.over25_pct),
    over35: bothSides(ou?.home?.over35_pct, ou?.away?.over35_pct),
    btts: bothSides(btts?.home?.btts_rate, btts?.away?.btts_rate),
  };
}

export interface V3Completeness {
  /** Weighted score 0–100. */
  score: number;
  /** Mandatory elements absent (non-empty ⇒ discard regardless of score). */
  mandatoryMissing: V3MandatoryField[];
  /** §4.2 penalty flags derived from the same field inspection. */
  penaltyFlags: V3PenaltyFlags;
  /** Data-source names for the §6 rationale (e.g. "sportybet-gismo", "understat-xg"). */
  sources: string[];
}

/** v3 §1.2 heightened-bar trend alignment: both teams' season O/U 2.5 hit-rates
 *  point the same way at ≥60%. */
export function heightenedTrendsAligned(detail: SportyBetEventDetail | undefined): boolean {
  const ou = detail?.stats?.overunder;
  const h = ou?.home?.over25_pct;
  const a = ou?.away?.over25_pct;
  if (typeof h !== "number" || typeof a !== "number") return false;
  return (h >= 0.6 && a >= 0.6) || (h <= 0.4 && a <= 0.4);
}

const SMALL_SAMPLE_GAMES = 5;

/** Score one fixture's data completeness per §0.3 and derive penalty flags. */
export function scoreCompleteness(
  detail: SportyBetEventDetail | undefined,
  enrich: V3EnrichmentState = {}
): V3Completeness {
  const stats = detail?.stats;
  const sources: string[] = [];
  const mandatoryMissing: V3MandatoryField[] = [];
  let score = 0;

  // ── Mandatory block (70) ───────────────────────────────────────────────────
  const hasOdds = detail?.odds?.ou25?.over != null;
  if (hasOdds) score += V3_COMPLETENESS_WEIGHTS.odds;
  else mandatoryMissing.push("odds");

  const form = stats?.form;
  const recentGoals = stats?.recentGoals;
  const hasForm =
    (form?.home?.last5 != null && form?.away?.last5 != null) ||
    (recentGoals?.home?.scored_avg != null && recentGoals?.away?.scored_avg != null);
  if (hasForm) score += V3_COMPLETENESS_WEIGHTS.form;
  else mandatoryMissing.push("form");

  const scoredH = avgScored(detail, "home");
  const scoredA = avgScored(detail, "away");
  const hasScored = scoredH !== null && scoredA !== null;
  if (hasScored) score += V3_COMPLETENESS_WEIGHTS.scored;
  else mandatoryMissing.push("scored");

  const concededH = avgConceded(detail, "home");
  const concededA = avgConceded(detail, "away");
  const hasConceded = concededH !== null && concededA !== null;
  if (hasConceded) score += V3_COMPLETENESS_WEIGHTS.conceded;
  else mandatoryMissing.push("conceded");

  const ou = stats?.overunder;
  const hasHitRate =
    typeof ou?.home?.over25_pct === "number" && typeof ou?.away?.over25_pct === "number";
  const completenessV4 = enrich.completenessV4 !== false;
  if (hasHitRate) score += V3_COMPLETENESS_WEIGHTS.hitRate;
  else if (!completenessV4) mandatoryMissing.push("hitRate");

  if (hasOdds || hasForm || hasScored || hasConceded || hasHitRate) {
    sources.push("sportybet-gismo");
  }

  // ── Critical / valuable tiers (30) ────────────────────────────────────────
  const xgH = stats?.xg?.home;
  const xgA = stats?.xg?.away;
  const hasXg = xgH?.xgf != null && xgA?.xgf != null;
  const xgSrcs = [xgH?.src, xgA?.src].filter((s): s is string => typeof s === "string");
  // Estimated when AI-Mode-sourced OR when the xGA half is a league-mean fill
  // (build_xg_table.py xgaSrc tag) — either way the softer §4.2 penalty applies.
  const xgEstimated =
    hasXg &&
    (xgSrcs.some((s) => s === "google_ai") ||
      xgH?.xgaSrc === "estimated" ||
      xgA?.xgaSrc === "estimated");
  if (hasXg) {
    score += V3_COMPLETENESS_WEIGHTS.xg;
    for (const s of new Set(xgSrcs)) sources.push(`${s}-xg`);
  }

  const h2h = stats?.h2h;
  const hasH2h =
    (typeof h2h?.total === "number" && h2h.total > 0) ||
    (h2h?.matches?.length ?? 0) > 0 ||
    enrich.h2hEnriched === true;
  if (hasH2h) {
    score += V3_COMPLETENESS_WEIGHTS.h2h;
    if (enrich.h2hEnriched) sources.push("football-data-h2h");
  }

  if (enrich.lineupsAvailable) {
    score += V3_COMPLETENESS_WEIGHTS.lineups;
    sources.push("api-football-lineups");
  }

  const congestion = stats?.congestion;
  const hasRest = congestion?.home?.rest_days != null || congestion?.away?.rest_days != null;
  if (hasRest) score += V3_COMPLETENESS_WEIGHTS.rest;

  // ── §4.2 penalty flags (single source of truth) ───────────────────────────
  const played = [
    stats?.standings?.home?.played,
    stats?.standings?.away?.played,
    recentGoals?.home?.n,
    recentGoals?.away?.n,
  ].filter((n): n is number => typeof n === "number" && n > 0);
  const smallSample = played.length > 0 && Math.min(...played) < SMALL_SAMPLE_GAMES;

  const penaltyFlags: V3PenaltyFlags = {
    xgMissing: !hasXg,
    xgEstimated,
    h2hMissing: !hasH2h,
    lineupsUnconfirmed: !enrich.lineupsAvailable,
    restEstimated: !hasRest,
    smallSample,
    hitRateMissing: !hasHitRate,
  };

  return { score, mandatoryMissing, penaltyFlags, sources };
}
