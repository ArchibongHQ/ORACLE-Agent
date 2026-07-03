/** all-markets-analysis-prompt-v3 — goals-batch verification arbiter (owner
 *  requirement R10).
 *
 *  When the all-markets v3 engine picks a goals-family market (Goals O/U,
 *  Team Total, BTTS) for a fixture, cross-check it against the INDEPENDENT
 *  goals-only v3 engine (analyzeGoalsFixtureV3) for the SAME fixture — pure
 *  deterministic math, zero extra LLM cost, no lock contention (an in-process
 *  call inside the same batch invocation the all-markets pick already ran in).
 *
 *  Owner-locked semantics (downgrade + re-gate, not a hard veto — a hard veto
 *  over-discards since the goals engine's candidate menu is narrower than the
 *  all-markets engine's):
 *    - AGREE: the goals engine independently prices this EXACT market label
 *      and its own gate also clears it ⇒ confirm, annotate "goals-verified".
 *    - DISAGREE: the goals engine prices this exact market but discards/caps/
 *      no-edges it ⇒ apply a −2pt adjusted-edge penalty AND downgrade
 *      confidence one tier, then RE-RUN the class's EV gate on the new edge;
 *      the pick survives only if it still clears its (now stricter) bar.
 *    - NO DATA: the goals engine's fixed candidate menu (Over 1.5/2.5, Home/
 *      Away Total Over 0.5, BTTS Yes) doesn't cover this exact label (e.g. the
 *      all-markets pick was "Over 3.5" or "BTTS No") ⇒ skip silently, no
 *      opinion to cross-check against.
 *
 *  Pure — no I/O of its own; callers assemble the goals-engine input the same
 *  way the goals batch already does (buildV3Odds/v3SampleSize/v3TeamXg-style
 *  extraction from the fixture's raw stats). */

import {
  analyzeGoalsFixtureV3,
  CLASS_GATE,
  type MarketFamily,
  type V3AllMarketsAssessment,
  type V3AnalyzeInput,
  type V3Confidence,
  v3Confidence,
} from "@oracle/engine";

/** Goals-family MarketFamily values the cross-check applies to — mirrors
 *  classes.ts's goals-shape families, the only ones analyzeGoalsFixtureV3
 *  has any opinion on. */
export const GOALS_CROSSCHECK_FAMILIES: ReadonlySet<MarketFamily> = new Set<MarketFamily>([
  "goals_ou",
  "team_total",
  "btts",
]);

/** §5.3-equivalent downgrade penalty applied on disagreement (owner-locked). */
export const CROSSCHECK_DISAGREE_PENALTY = 0.02;

const CONFIDENCE_DOWNGRADE: Record<V3Confidence, V3Confidence> = {
  very_high: "high",
  high: "medium",
  medium: "medium", // floor — the re-gate below decides survival, not the label
};

export type CrossCheckVerdict = "agree" | "disagree" | "no_data";

export interface CrossCheckResult {
  verdict: CrossCheckVerdict;
  /** The re-gated assessment to use downstream — identical to the input on
   *  "agree"/"no_data", downgraded (and possibly failing) on "disagree". */
  assessment: V3AllMarketsAssessment;
  /** False only when verdict="disagree" AND the downgraded edge no longer
   *  clears its class's EV gate — the caller should drop the pick. */
  survives: boolean;
  /** One-line note for the rationale/Telegram annotation. */
  annotation: string;
}

/** Re-run the class EV gate on a −2pt-penalized edge (disagreement path). */
function downgradeAndRegate(
  original: V3AllMarketsAssessment,
  odds: number
): V3AllMarketsAssessment {
  const newAdjustedEdge = original.adjustedEdge - CROSSCHECK_DISAGREE_PENALTY;
  const newAdjEvPct = original.q > 0 ? newAdjustedEdge / original.q : 0;
  const gate = CLASS_GATE[original.cls];
  const passes =
    newAdjustedEdge >= gate.minAdjEdge &&
    (gate.minAdjEvPct === null || newAdjEvPct >= gate.minAdjEvPct) &&
    (gate.maxOdds === null || odds <= gate.maxOdds);
  // "One confidence-tier downgrade" applies to the ORIGINAL label, not a
  // recomputation off the new edge (which would already reflect a lower edge
  // and compound the downgrade). Falls back to an edge-based confidence only
  // when the original pick had none.
  const confidence = original.confidence
    ? CONFIDENCE_DOWNGRADE[original.confidence]
    : v3Confidence(original.cls, newAdjustedEdge, newAdjEvPct);
  return {
    ...original,
    adjustedEdge: newAdjustedEdge,
    adjEvPct: newAdjEvPct,
    penaltyPts: original.penaltyPts + CROSSCHECK_DISAGREE_PENALTY,
    outcome: passes ? "done" : "below_gate",
    confidence: passes ? confidence : null,
  };
}

/** Find the goals engine's own assessment for the EXACT SAME market label
 *  (its candidate menu is fixed: "Over 1.5", "Over 2.5", "Home Total Over
 *  0.5", "Away Total Over 0.5", "BTTS Yes") — undefined when it doesn't price
 *  this label at all. */
function findMatchingGoalsAssessment(
  goalsResult: ReturnType<typeof analyzeGoalsFixtureV3>,
  label: string
) {
  return goalsResult?.assessments.find((a) => a.label === label);
}

/** Cross-check one all-markets goals-family pick against the goals-only v3
 *  engine for the same fixture. `pick` is the pricing/gate output the
 *  all-markets engine already computed (V3MarketOutcomeAssessment satisfies
 *  V3AllMarketsAssessment); `label`/`odds` identify the exact market;
 *  `goalsInput` is the SAME fixture assembled as goalsV3's own input shape. */
export function crossCheckGoalsPick(
  pick: V3AllMarketsAssessment,
  label: string,
  odds: number,
  goalsInput: V3AnalyzeInput
): CrossCheckResult {
  const goalsResult = analyzeGoalsFixtureV3(goalsInput);
  const matched = findMatchingGoalsAssessment(goalsResult, label);

  if (!matched) {
    return {
      verdict: "no_data",
      assessment: pick,
      survives: true,
      annotation: `goals-crosscheck: no independent opinion on "${label}" (outside the goals engine's fixed menu)`,
    };
  }

  if (matched.outcome === "done") {
    return {
      verdict: "agree",
      assessment: pick,
      survives: true,
      annotation: `goals-verified: independent goals engine also clears "${label}" (${(matched.rawEdge * 100).toFixed(1)}pt raw edge, ${matched.tier ?? "n/a"} tier)`,
    };
  }

  const downgraded = downgradeAndRegate(pick, odds);
  const survives = downgraded.outcome === "done";
  return {
    verdict: "disagree",
    assessment: downgraded,
    survives,
    annotation: survives
      ? `goals-crosscheck disagreement: independent goals engine ${matched.outcome} "${label}" — downgraded to ${(downgraded.adjustedEdge * 100).toFixed(1)}pt adj edge, still clears the ${downgraded.cls} gate`
      : `goals-crosscheck disagreement: independent goals engine ${matched.outcome} "${label}" — downgraded edge no longer clears the ${downgraded.cls} gate, dropping`,
  };
}
