/** v3 slate arbiter — the ONE LLM call on the goals path (locked plan decision:
 *  replaces per-fixture Sonnet screening + per-fixture decide + per-fixture
 *  arbiter; ~95% token cut).
 *
 *  Reviews the fully-assembled selection (all five outputs, deduplicated) for
 *  what deterministic math cannot see: dead rubbers, motivation collapses,
 *  news/lineup contradictions, hidden correlated risk. The response contract is
 *  DROPS/FLAGS ONLY (ratifying a leg = omitting it): callClaudeCode caps child
 *  stdout at 8KB and JSON.parses the whole CLI envelope, so a per-leg verdict
 *  list over ~39+ legs would risk truncating the envelope into unparseability.
 *
 *  Fail-open like every other local-Claude call site: any failure (binary
 *  missing, timeout, parse fail) returns the slate unchanged with
 *  arbiterStatus "unverified" — the arbiter can only ever remove or annotate
 *  legs, never block delivery. */

import { callClaudeCode } from "@oracle/llm";
import type { GoalsLeg, GoalsSelectionResult } from "../selectGoals.js";
import { computeMiniAccaStats } from "../selectGoals.js";

export const DEFAULT_GOALS_ARBITER_TIMEOUT_MS = 120_000;

export interface SlateArbiterVerdicts {
  /** legKey → reason. Dropped legs are removed from every output. */
  drops: Map<string, string>;
  /** legKey → note. Flagged legs stay but carry the annotation. */
  flags: Map<string, string>;
  status: "verified" | "unverified";
}

/** Stable per-leg key shared between the prompt and the verdict parser. */
export function slateLegKey(leg: GoalsLeg): string {
  return `${leg.home}|${leg.away}|${leg.side}`;
}

/** Exported for reuse by goalsV3/crossBatchVeto.ts (PR-13) — same
 *  dedupe-across-all-five-outputs logic, not a separately-maintained copy. */
export function dedupeLegs(selection: GoalsSelectionResult): GoalsLeg[] {
  const seen = new Map<string, GoalsLeg>();
  for (const pool of [
    selection.legs,
    selection.shortSlipLegs,
    selection.miniAccaLegs,
    selection.outputBLegs,
    selection.outputCLegs,
  ]) {
    for (const leg of pool) {
      const key = slateLegKey(leg);
      if (!seen.has(key)) seen.set(key, leg);
    }
  }
  return [...seen.values()];
}

function legLine(index: number, leg: GoalsLeg): string {
  const edge = leg.adjustedEdge != null ? `adjEdge=${(leg.adjustedEdge * 100).toFixed(1)}pts` : "";
  const tier = leg.tier ? `tier=${leg.tier}` : "";
  const note = leg.rationale ? ` | ${leg.rationale}` : "";
  return (
    `[${index}] ${leg.home} vs ${leg.away} (${leg.league}, KO ${leg.kickoff}) — ` +
    `${leg.side} @ ${leg.odds} mp=${(leg.mp * 100).toFixed(0)}% ${edge} ${tier}${note}`
  );
}

const ARBITER_SYSTEM = `You are ORACLE's final slate arbiter for a goals-only accumulator.
Every leg below already cleared a deterministic edge gate (de-vigged implied probability,
data-quality penalties, a 12-point implausible-edge cap and a 2-point noise gate) — do NOT
re-litigate the math. Your job is only what math cannot see:
  - dead rubbers (nothing to play for: relegated/champions/mid-table season-end)
  - motivation or rotation risk (cup distraction, manager exit, second-string XI)
  - news contradictions (key attacker out, keeper returning, weather)
  - hidden correlated risk across legs (same storyline, shared promotion race)
Respond with ONLY compact JSON, no prose, in exactly this shape:
{"drops":[{"i":<index>,"why":"<short reason>"}],"flags":[{"i":<index>,"why":"<short note>"}]}
Drop a leg ONLY on a concrete, nameable risk. Flag when uncertain. An empty
{"drops":[],"flags":[]} is a valid and common answer. Keep every "why" under 12 words.`;

function parseVerdicts(
  raw: string,
  legs: GoalsLeg[]
): { drops: Map<string, string>; flags: Map<string, string> } | null {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      drops?: Array<{ i?: number; why?: string }>;
      flags?: Array<{ i?: number; why?: string }>;
    };
    const toMap = (entries: Array<{ i?: number; why?: string }> | undefined) => {
      const map = new Map<string, string>();
      for (const e of entries ?? []) {
        if (typeof e.i !== "number" || e.i < 0 || e.i >= legs.length) continue;
        map.set(slateLegKey(legs[e.i]), String(e.why ?? "").slice(0, 120));
      }
      return map;
    };
    return { drops: toMap(parsed.drops), flags: toMap(parsed.flags) };
  } catch {
    return null;
  }
}

/** Review the assembled slate with one local-Claude call. */
export async function reviewGoalsSlate(
  selection: GoalsSelectionResult,
  opts: { timeoutMs?: number } = {}
): Promise<SlateArbiterVerdicts> {
  const unverified: SlateArbiterVerdicts = {
    drops: new Map(),
    flags: new Map(),
    status: "unverified",
  };
  const legs = dedupeLegs(selection);
  if (legs.length === 0) return { ...unverified, status: "verified" };

  const prompt = `${ARBITER_SYSTEM}\n\n=== SLATE (${legs.length} legs) ===\n${legs
    .map((leg, i) => legLine(i, leg))
    .join("\n")}`;

  const raw = await callClaudeCode(prompt, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_GOALS_ARBITER_TIMEOUT_MS,
  });
  if (!raw) return unverified;
  const verdicts = parseVerdicts(raw, legs);
  if (!verdicts) return unverified;
  return { ...verdicts, status: "verified" };
}

/** Apply arbiter verdicts: dropped legs removed from every output (never
 *  backfilled — §6 "never pad"), flagged legs annotated in place. Combined
 *  probabilities/odds for slips that lost legs are recomputed as plain products
 *  (the copula-corrected numbers upstream are close enough for display; the
 *  legs themselves are what get booked). */
export function applySlateVerdicts(
  selection: GoalsSelectionResult,
  verdicts: SlateArbiterVerdicts
): GoalsSelectionResult {
  if (verdicts.drops.size === 0 && verdicts.flags.size === 0) return selection;

  const keep = (legs: GoalsLeg[]): GoalsLeg[] =>
    legs
      .filter((leg) => !verdicts.drops.has(slateLegKey(leg)))
      .map((leg) => {
        const flag = verdicts.flags.get(slateLegKey(leg));
        return flag ? { ...leg, arbiterFlag: flag } : leg;
      });

  const legs = keep(selection.legs);
  const shortSlipLegs = keep(selection.shortSlipLegs);
  const miniAccaLegs = keep(selection.miniAccaLegs);
  const outputBLegs = keep(selection.outputBLegs);
  const outputCLegs = keep(selection.outputCLegs);

  const prod = (xs: GoalsLeg[], f: (l: GoalsLeg) => number): number =>
    xs.reduce((acc, l) => acc * f(l), 1);
  const droppedFromLong = legs.length !== selection.legs.length;
  const droppedFromShort = shortSlipLegs.length !== selection.shortSlipLegs.length;
  const droppedFromMini = miniAccaLegs.length !== selection.miniAccaLegs.length;
  const miniAccaStats = droppedFromMini ? computeMiniAccaStats(miniAccaLegs) : null;

  return {
    ...selection,
    legs,
    shortSlipLegs,
    miniAccaLegs,
    outputBLegs,
    outputCLegs,
    combinedProb: droppedFromLong ? prod(legs, (l) => l.mp) : selection.combinedProb,
    combinedOdds: droppedFromLong ? prod(legs, (l) => l.odds) : selection.combinedOdds,
    shortSlipCombinedProb: droppedFromShort
      ? prod(shortSlipLegs, (l) => l.mp)
      : selection.shortSlipCombinedProb,
    shortSlipCombinedOdds: droppedFromShort
      ? prod(shortSlipLegs, (l) => l.odds)
      : selection.shortSlipCombinedOdds,
    ...(miniAccaStats ?? {}),
  };
}
