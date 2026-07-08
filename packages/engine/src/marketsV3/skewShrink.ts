/** Desktop-audit concept #4 — auto-conservatism when a §5.6 skew check fires.
 *
 *  sanity.ts's slateSanityChecks is a POST-HOC, whole-slate audit: it can only
 *  know a family/direction is skewed AFTER every fixture in the day's batch
 *  has already been assessed and gated. There is no single-fixture hook where
 *  "the slate turned out skewed" is knowable in advance, so this can never be
 *  a live per-fixture gate the way evGate.ts/edgeGate.ts are — it is
 *  necessarily a SEPARATE, slate-level pass that runs after sanity, over the
 *  same already-gated assessments.
 *
 *  SHADOW MODE ONLY (by design, matching the audit's own "shadow-mode first,
 *  ledger-validated" instruction): this module never removes or re-ranks a
 *  real pick. It answers "if a majority-direction pick's model probability
 *  were shrunk toward the market's implied probability by `shrinkFraction`,
 *  would it still have cleared its own class gate?" and reports which ones
 *  wouldn't have — a diagnostic line for the daily report, not a filter.
 *  Promoting this from shadow-diagnostic to an actual pool filter is a
 *  deliberate follow-up once the diagnostic has been ledger-validated
 *  (do the flagged picks actually underperform their un-shrunk peers?),
 *  not something to flip silently.
 *
 *  The shrink math needs no stored modelP/q: rawEdge = modelP - q by
 *  definition, so shrinking modelP toward q by fraction s scales rawEdge by
 *  (1-s) directly (shrunkRawEdge = rawEdge*(1-s) = (modelP*(1-s)+q*s) - q).
 *  adjustedEdge = rawEdge - penaltyPts, and penaltyPts doesn't change under
 *  this shrink, so shrunkAdjustedEdge = adjustedEdge - rawEdge*s. Only
 *  rawEdge, adjustedEdge, and cls (for the class gate lookup) need to be
 *  carried on the stored assessment — see batch/index.ts's V3AssessmentStat.
 *
 *  Pure math, no I/O. */

import { dirOfDesc, sideOfDesc } from "./descParse.js";
import { CLASS_GATE } from "./evGate.js";
import {
  type AllMarketsSanityInput,
  RESULT_FAMILIES,
  TOTALS_FAMILIES,
  type V3SanityFlag,
  type V3SanityResult,
} from "./sanity.js";

export const SKEW_SHRINK_FRACTION_DEFAULT = 0.35;

/** Which skew flag implicates which family set + majority side/direction the
 *  shrink should target. Only "done" outcomes matter — capped/noise/below_edge
 *  assessments never reached a pick in the first place.
 *
 *  matchesDesc reuses sanity.ts's own sideOfDesc/dirOfDesc (the exact
 *  functions that decided whether this flag fired) rather than a separate
 *  regex — a bug caught in review: an ad-hoc `/\bhome\b/i` match would have
 *  swept in ambiguous covers like "Home or Away" (a real double_chance
 *  12-cover desc, RESULT_FAMILIES, priced by engines/result.ts) that
 *  sideOfDesc() deliberately returns null for and sanity.ts's own tally
 *  excludes from both the home and away count. Reusing the same classifier
 *  keeps this pass's candidate population a strict subset of whatever
 *  actually produced the flag. */
const SKEW_TARGET: Partial<
  Record<V3SanityFlag, { families: Set<string>; matchesDesc: (desc: string) => boolean }>
> = {
  result_skew_home: {
    families: RESULT_FAMILIES,
    matchesDesc: (desc) => sideOfDesc(desc) === "home",
  },
  result_skew_away: {
    families: RESULT_FAMILIES,
    matchesDesc: (desc) => sideOfDesc(desc) === "away",
  },
  totals_skew_over: {
    families: TOTALS_FAMILIES,
    matchesDesc: (desc) => dirOfDesc(desc) === "over",
  },
  totals_skew_under: {
    families: TOTALS_FAMILIES,
    matchesDesc: (desc) => dirOfDesc(desc) === "under",
  },
};

export interface SkewShrinkCandidate {
  family: string;
  desc: string;
  cls: string;
  rawEdge: number;
  adjustedEdge: number;
  shrunkAdjustedEdge: number;
  /** True when the shrunk edge would no longer clear its own class gate
   *  (CLASS_GATE[cls].minAdjEdge) — the pick this shadow pass flags. */
  wouldBeDemoted: boolean;
}

export interface SkewShrinkResult {
  shrinkFraction: number;
  /** Empty when no skew flag fired, or every flagged-direction pick already
   *  clears the shrunk bar — a clean shadow pass is a legitimate, common
   *  outcome, not an error. */
  candidates: SkewShrinkCandidate[];
}

/** Shadow-evaluate every "done", flagged-family, majority-direction
 *  assessment against a shrunk adjusted edge. Only evaluates families/
 *  directions an actual sanity flag named — an unflagged slate returns
 *  candidates: [] without inspecting anything (cheap no-op, matches
 *  sanity.ts's own "no flags fired" fast path). */
export function shadowSkewShrink(
  assessments: AllMarketsSanityInput[],
  sanity: V3SanityResult,
  shrinkFraction: number = SKEW_SHRINK_FRACTION_DEFAULT
): SkewShrinkResult {
  if (sanity.flags.length === 0) return { shrinkFraction, candidates: [] };

  const candidates: SkewShrinkCandidate[] = [];
  for (const flag of sanity.flags) {
    const target = SKEW_TARGET[flag];
    if (!target) continue; // model_miscalibration has no shrink target — cap-rate isn't a direction
    for (const a of assessments) {
      if (a.outcome !== "done") continue;
      if (!target.families.has(a.family)) continue;
      if (!target.matchesDesc(a.desc)) continue;

      const shrunkAdjustedEdge = a.adjustedEdge - a.rawEdge * shrinkFraction;
      // Known limitation (review-noted, not fixed): always checks the BASE
      // CLASS_GATE, never CLASS_GATE_HEIGHTENED — whether a given "done"
      // outcome was actually gated against the heightened table isn't
      // carried on the stored assessment. This can only make the shadow
      // pass UNDER-report demotions for heightened-gated fixtures (a
      // heightened bar is stricter, so some picks this reports as
      // surviving would actually have been demoted against their real
      // gate) — the safe direction for a diagnostic that must never falsely
      // claim a demotion, but not perfectly accurate. Revisit if/when this
      // gets promoted past shadow-mode.
      const gate = CLASS_GATE[a.cls as keyof typeof CLASS_GATE];
      // An unrecognized cls can't be gate-checked — report the shrunk number
      // but never claim a demotion we can't actually verify.
      const wouldBeDemoted = gate ? shrunkAdjustedEdge < gate.minAdjEdge : false;

      candidates.push({
        family: a.family,
        desc: a.desc,
        cls: a.cls,
        rawEdge: a.rawEdge,
        adjustedEdge: a.adjustedEdge,
        shrunkAdjustedEdge,
        wouldBeDemoted,
      });
    }
  }
  return { shrinkFraction, candidates };
}

/** Report line for the daily Telegram/log summary, alongside formatSanityFlags.
 *  Only mentions demotions — a shadow candidate that still clears its gate
 *  under shrinkage isn't interesting enough to list individually. */
export function formatSkewShrinkShadow(result: SkewShrinkResult): string | null {
  const demoted = result.candidates.filter((c) => c.wouldBeDemoted);
  if (demoted.length === 0) return null;
  const pct = Math.round(result.shrinkFraction * 100);
  const list = demoted
    .map(
      (c) =>
        `${c.desc} (${c.cls}, ${(c.adjustedEdge * 100).toFixed(1)}pt→${(c.shrunkAdjustedEdge * 100).toFixed(1)}pt)`
    )
    .join("; ");
  return `Skew shrink (shadow, -${pct}%, not applied): would demote ${demoted.length} pick(s) — ${list}`;
}
