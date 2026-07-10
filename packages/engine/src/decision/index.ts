/** Decision layer — Phase 4 full implementation.
 *  decide() calls Claude Opus; falls back to deterministic when key is absent or call fails.
 *  validateSelection enforces hard gates in code — no LLM instruction can bypass them. */

import type { StoragePort } from "@oracle/storage";
import { STORAGE_KEYS, withKeyLock } from "@oracle/storage";
import type {
  ConfidenceGrade,
  DecisionContext,
  DecisionOutput,
  DecisionReplay,
  DecisionShadow,
  EVMarket,
  OracleConfig,
  PickRef,
} from "../types.js";
import { type MarketExecutorRiskParams, runAllMarketsLlmExecutor } from "./marketExecutor.js";

/** Paired output from decide() — decision for downstream gates, replay for the ledger. */
export interface DecisionResult {
  decision: DecisionOutput;
  replay: DecisionReplay | null;
  /** Retired 2026-07-10: GLM-5.2 is now a real cascade rung (see decideInner /
   *  _tryOpenRouter below), not an observability-only shadow comparison — this
   *  field is always undefined now. Kept for API compatibility with existing
   *  callers (batch/index.ts destructures `shadow: decisionShadow`) — the
   *  DecisionShadow type itself (packages/engine/src/types.ts) is now dead and
   *  a candidate for a future cleanup pass; not touched here (out of this
   *  workstream's file scope). */
  shadow?: DecisionShadow;
  /** The eligible-bets list actually used for the arbiter + downstream gates.
   *  Only set (and widened by one synthetic EVMarket) when the all-markets LLM
   *  executor tier supplied a validated candidate — either as the draft outright
   *  ("full" scope) or spliced in alongside the existing candidates without
   *  forcing the draft ("unmapped" scope, PR-23) — absent otherwise, so callers
   *  should fall back to their own input eligibleBets when this is undefined. */
  eligibleBets?: EVMarket[];
}

// DecisionContext is the canonical fixture-evidence type — defined in types.ts (Appendix B),
// re-exported here for callers that import from the decision module.
export type { DecisionContext };

// ── Grade helpers ─────────────────────────────────────────────────────────────

/** Derive a ConfidenceGrade from expected-value. Thresholds are tunable constants. */
export function gradeFromEV(ev: number): ConfidenceGrade {
  if (ev >= 0.05) return "STRONG";
  if (ev > 0) return "LEAN";
  return "NO_EDGE";
}

const VALID_GRADES = new Set<string>(["STRONG", "LEAN", "NO_EDGE", "MISSING_DATA"]);

function coerceGrade(raw: unknown, ev: number): ConfidenceGrade {
  if (typeof raw === "string" && VALID_GRADES.has(raw)) return raw as ConfidenceGrade;
  return gradeFromEV(ev);
}

// ── Deterministic fallback ────────────────────────────────────────────────────

function deterministicDecide(
  allMarkets: EVMarket[],
  rationale = "Deterministic top pick"
): DecisionResult {
  // Always pick the best-ranked market even if EV ≤ 0; grade reflects the edge honestly.
  const sorted = [...allMarkets].sort((a, b) => b.ev - a.ev);
  const top = sorted[0];
  if (!top) {
    // No markets at all — manufacture a placeholder pick so no fixture is ever dropped.
    // The NO_EDGE grade communicates the honest verdict without omitting the fixture.
    const placeholder: PickRef = { market: "1x2", side: "home", odds: 1, stake: 0 };
    return {
      decision: {
        primaryPick: placeholder,
        confidence: 0,
        grade: "NO_EDGE",
        rationale: "No markets available",
        rejectedAndWhy: [],
      },
      replay: null,
    };
  }
  const pick: PickRef = { market: top.market, side: top.side, odds: top.odds, stake: top.stake };
  return {
    decision: {
      primaryPick: pick,
      confidence: top.modelProb,
      grade: gradeFromEV(top.ev),
      rationale,
      rejectedAndWhy: [],
    },
    replay: null,
  };
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(eligibleBets: EVMarket[], ctx: DecisionContext): string {
  const {
    fixture,
    fp,
    lambdaH,
    lambdaA,
    expectedScoreline,
    regime,
    convergenceTier,
    convergenceScore,
    mlAllowed,
    drawRisk,
    betTrigger,
    portfolioCorrelation,
    hoursToKO,
    softContext,
  } = ctx;

  const betLines = eligibleBets
    .map(
      (m, i) =>
        `${i + 1}. [${m.cat}] ${m.label}  mp=${(m.mp * 100).toFixed(1)}%  odds=${m.odds}  ev=+${(m.ev * 100).toFixed(1)}%  stake=${(m.stake * 100).toFixed(1)}% Kelly`
    )
    .join("\n");

  const softLines = (softContext ?? [])
    .map((s) => `[${s.kind.toUpperCase()}] ${s.text}`)
    .join("\n");

  return `You are ORACLE's gated betting decision engine. Return ONLY valid JSON — no markdown, no preamble.

=== FIXTURE ===
${fixture.home} vs ${fixture.away}  |  ${fixture.league}  |  ${fixture.kickoff}

=== PROBABILITIES ===
Home: ${(fp.home * 100).toFixed(1)}%  |  Draw: ${(fp.draw * 100).toFixed(1)}%  |  Away: ${(fp.away * 100).toFixed(1)}%
Poisson: λH=${lambdaH.toFixed(2)}  λA=${lambdaA.toFixed(2)}  |  xScore: ${expectedScoreline}  |  Regime: ${regime}

=== RISK SIGNALS ===
Convergence: ${convergenceTier} (${convergenceScore}/100)
ML Filter: ${mlAllowed ? "PASS" : "BLOCKED"}  |  Draw Risk: ${drawRisk}
Ante-Post Debate Trigger: ${betTrigger}
Portfolio Correlation: ${portfolioCorrelation !== null ? portfolioCorrelation.toFixed(3) : "N/A"}
Hours to Kickoff: ${hoursToKO !== undefined ? hoursToKO.toFixed(1) : "unknown"}

=== ELIGIBLE BETS (ranked by model score) ===
${betLines || "NONE"}
${softLines ? `\n=== SOFT CONTEXT ===\n${softLines}` : ""}
=== DECISION RULES ===
Accept (STRONG) when: convergence STRONG or MODERATE, mlAllowed=true, ev>4%, hoursToKO>1
Grade LEAN when: betTrigger=RED without strong independent evidence, mlAllowed=false, portfolioCorrelation>0.6, or ev<5%
Grade NO_EDGE when: ev<=0 — still return the best-ranked market in primaryPick
MoneyLine picks forbidden when drawRisk=VERY_HIGH
Treat [STATS] soft-context lines (SportyBet form/standings/H2H/season goals/over-under/fixture-load) as real evidence, not background colour: when they reinforce the model-favoured side, that supports grading toward STRONG; when they contradict it (e.g. one-sided H2H or standings gap against the model's pick, heavy fixture congestion for the favourite), lower confidence accordingly or prefer altPick — you may only choose among the ELIGIBLE BETS above, never invent a market.

=== REQUIRED OUTPUT (JSON only, no other text) ===
{"primaryPick":{"market":"...","side":"...","odds":0.0,"stake":0.00},"altPick":{"market":"...","side":"...","odds":0.0,"stake":0.00},"confidence":0.0,"grade":"STRONG","rationale":"...","rejectedAndWhy":[]}
"grade" must be one of: "STRONG", "LEAN", "NO_EDGE". Always set primaryPick to the best-ranked market.
"market" and "side" must be copied EXACTLY (verbatim, including any prefix like "DNB") from the bracketed label in the ELIGIBLE BETS list above — e.g. "DNB Home", not "Home". Do not paraphrase or shorten it.
"altPick" is optional.`;
}

// ── Final arbiter prompt (local Claude Code) ─────────────────────────────────

const ARBITER_TIMEOUT_MS = 45_000;

/** Prompt for the mandatory final-arbiter pass — ORACLE_LOCAL_DECISION="true".
 *  Unlike buildPrompt() (which asks an LLM to pick from eligible markets cold),
 *  this hands the arbiter everything already assembled — the engine math, the
 *  soft-context evidence, and the upstream cascade's own draft pick + rationale
 *  — and asks it to audit that reasoning before ratifying or overriding it.
 *  Authored as a explicit walk-through (stats → news intel → rationale → math →
 *  verdict) per operator instruction, rather than a bare "return JSON" ask, so
 *  the model's chain of reasoning is forced to touch every evidence category
 *  instead of pattern-matching straight to an answer. */
/** Renders DecisionContext.rawStatsBlock as labeled key-value lines, not prose
 *  — structured raw data alongside (not replacing) the existing softContext
 *  prose. Recurses one level into nested objects (e.g. {home:{...},away:{...}})
 *  since rawStatsBlock mirrors @oracle/runtime's SportyBetStats shape (form/
 *  standings/goals/h2h/xg/overunder/congestion/possessionValue), every
 *  top-level key of which is either a flat scalar/array or a {home,away} pair. */
/** Inline-renders a nested value (object, array, or array-of-objects) for the
 *  one-level-deep "side" slots below — e.g. h2h.matches is an array of match
 *  objects nested inside the h2h object, two levels deep, so the rendering
 *  itself must recurse rather than assume "side" values bottom out at scalars. */
function renderInline(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(renderInline).join("; ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .filter(([, vv]) => vv != null)
      .map(([k, vv]) => `${k}=${renderInline(vv)}`)
      .join(", ");
  }
  return String(v);
}

function renderRawStatsBlock(block: Record<string, unknown> | undefined): string {
  if (!block) return "";
  const lines: string[] = [];
  for (const [key, value] of Object.entries(block)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value.length) lines.push(`- ${key}: ${value.join("; ")}`);
      continue;
    }
    if (typeof value === "object") {
      const parts = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v != null)
        .map(([side, v]) =>
          typeof v === "object" && v !== null ? `${side}={${renderInline(v)}}` : `${side}=${v}`
        );
      if (parts.length) lines.push(`- ${key}: ${parts.join(", ")}`);
      continue;
    }
    lines.push(`- ${key}: ${value}`);
  }
  return lines.join("\n");
}

function buildArbiterPrompt(
  eligibleBets: EVMarket[],
  ctx: DecisionContext,
  draft: DecisionOutput,
  draftModel: string
): string {
  const { fixture, fp, lambdaH, lambdaA, expectedScoreline, regime, softContext, rawStatsBlock } =
    ctx;

  const rawStatsLines = renderRawStatsBlock(rawStatsBlock);
  const statsLines = (softContext ?? [])
    .filter((s) => s.kind === "stats")
    .map((s) => `- ${s.text}`)
    .join("\n");
  const newsLines = (softContext ?? [])
    .filter((s) => s.kind !== "stats")
    .map((s) => `- [${s.kind.toUpperCase()}] ${s.text}`)
    .join("\n");

  const betLines = eligibleBets
    .map(
      (m, i) =>
        `${i + 1}. [${m.cat}] ${m.label}  modelProb=${(m.mp * 100).toFixed(1)}%  odds=${m.odds}  ev=+${(m.ev * 100).toFixed(1)}%  stake=${(m.stake * 100).toFixed(1)}% Kelly`
    )
    .join("\n");

  return `You are ORACLE's final betting-decision arbiter. You review everything the
deterministic engine and upstream models produced and issue the FINAL pick — you are
the last checkpoint before this goes to the user, not a draft generator. Return ONLY
valid JSON — no markdown, no preamble, no commentary outside the JSON object.

Work through these five steps in order before you decide. Do not skip a step even if
you think you already know the answer — each step exists to catch a different failure
mode (stale stats, ignored injury news, a plausible-sounding rationale built on a math
error, an engine number that doesn't match the market).

STEP 0 — RAW PER-CATEGORY DATA (form/standings/goals/H2H/xG/over-under/congestion/
shots-corners-possession, straight from the source — not summarized into prose)
${rawStatsLines || "(none supplied)"}

STEP 1 — STATS (does the hard data support a side?)
${statsLines || "(none supplied)"}

STEP 2 — NEWS INTEL (does anything here change or override the stats read — injuries,
lineup news, motivation, travel, weather?)
${newsLines || "(none supplied)"}

STEP 3 — UPSTREAM RATIONALE (the draft pick already produced by ${draftModel} — audit
its reasoning, don't just rubber-stamp it)
Draft pick: ${JSON.stringify(draft.primaryPick)}
Draft grade: ${draft.grade}  |  Draft confidence: ${draft.confidence}
Draft rationale: ${draft.rationale}
Draft rejectedAndWhy: ${JSON.stringify(draft.rejectedAndWhy)}

STEP 4 — DECISION-ENGINE MATH (does the draft pick actually follow from these numbers?)
Fixture: ${fixture.home} vs ${fixture.away}  |  ${fixture.league}  |  ${fixture.kickoff}
Model probabilities: Home=${(fp.home * 100).toFixed(1)}%  Draw=${(fp.draw * 100).toFixed(1)}%  Away=${(fp.away * 100).toFixed(1)}%
Poisson: λH=${lambdaH.toFixed(2)}  λA=${lambdaA.toFixed(2)}  xScore=${expectedScoreline}  Regime=${regime}
Eligible markets (ranked):
${betLines || "NONE — no positive-EV market exists for this fixture"}

=== YOUR VERDICT ===
Choose exactly one of:
(a) RATIFY the draft pick as-is if steps 0-4 hold up under your own review.
(b) OVERRIDE with a different market from the eligible list above if your review of
    steps 0-3 contradicts the draft (e.g. the raw data or news intel the draft
    under-weighted, a stats signal pointing the other way, or a math/rationale
    mismatch you caught in step 4). You may only choose a market that appears in the
    eligible list — never invent one.
(c) FLAG missing data: if the raw-data, stats, and news-intel sections are too thin to
    support a confident verdict either way (e.g. all are "(none supplied)" or
    near-empty, or a key data point like lineups/injuries is conspicuously absent for a
    fixture close to kickoff), set grade to "MISSING_DATA" and explain what's missing in
    rationale. This is the honest answer when you don't have enough to decide — do not
    force a pick.

=== REQUIRED OUTPUT (JSON only) ===
{"primaryPick":{"market":"...","side":"...","odds":0.0,"stake":0.00},"altPick":{"market":"...","side":"...","odds":0.0,"stake":0.00},"confidence":0.0,"grade":"STRONG","rationale":"...","rejectedAndWhy":[]}
"grade" must be one of: "STRONG", "LEAN", "NO_EDGE", "MISSING_DATA". Your rationale must
state which of (a)/(b)/(c) you chose and why, referencing the specific step that drove it.
"market" and "side" must be copied EXACTLY (verbatim, including any prefix like "DNB") from
the bracketed label in the eligible markets list above — e.g. "DNB Home", not "Home". Do not
paraphrase or shorten it.
"altPick" is optional. Omit primaryPick.stake/odds details you're unsure of rather than
guessing — 0 is the honest default, not a fabricated number.`;
}

/** Runs the mandatory final-arbiter pass over an already-produced draft decision.
 *  Called once per fixture, after the existing cascade (Tier 1-4) has produced
 *  `draft` — never instead of it. On success, the arbiter's verdict IS the
 *  decision returned to the rest of the pipeline (validateSelection's hard gates
 *  still apply downstream, unchanged). On any failure (binary missing, timeout,
 *  bad parse), falls back to `draft` labelled arbiterStatus="unverified" so
 *  callers/UI can tell the difference — the pipeline never blocks on this.
 *
 *  Model: no explicit opts.model is passed to callClaudeCode below, so this
 *  inherits callClaudeCode.ts's DEFAULT_MODEL — Opus (owner instruction
 *  2026-07-10). ARBITER_TIMEOUT_MS is unchanged. */
async function arbitrate(
  eligibleBets: EVMarket[],
  ctx: DecisionContext,
  draft: DecisionResult
): Promise<DecisionResult> {
  if (process.env.ORACLE_LOCAL_DECISION !== "true") return draft;

  const { callClaudeCode, isLocalRuntime } = await import("@oracle/llm");
  if (!isLocalRuntime()) {
    return { ...draft, decision: { ...draft.decision, arbiterStatus: "unverified" } };
  }

  const draftModel = draft.replay?.model ?? "deterministic";
  const prompt = buildArbiterPrompt(eligibleBets, ctx, draft.decision, draftModel);
  const raw = await callClaudeCode(prompt, { timeoutMs: ARBITER_TIMEOUT_MS });
  const parsed = raw ? parseDecisionResponse(raw) : null;

  if (!raw || !parsed) {
    return { ...draft, decision: { ...draft.decision, arbiterStatus: "unverified" } };
  }

  return {
    ...draft,
    decision: { ...parsed, arbiterStatus: "verified" },
    replay: { prompt, rawResponse: raw, model: "claude-code-arbiter", temperature: "default" },
  };
}

// ── JSON parser with fence stripping ─────────────────────────────────────────

function parseDecisionResponse(text: string): DecisionOutput | null {
  try {
    // Strip code fences
    const cleaned = text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    // Find first { ... last }
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return null;

    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;

    // Validate minimum shape
    if (!("primaryPick" in obj) || !("confidence" in obj)) return null;
    // primaryPick must be an object (PickRef) — reject legacy "NO_BET" string responses
    if (typeof obj.primaryPick !== "object" || obj.primaryPick === null) return null;

    const confidence = Number(obj.confidence ?? 0);
    const pickObj = obj.primaryPick as PickRef;
    // Derive EV from the pick's odds for grade calculation when not provided
    const evApprox = (1 / (pickObj.odds || 1) - 1) * confidence;

    return {
      primaryPick: pickObj,
      altPick: obj.altPick as PickRef | undefined,
      confidence,
      grade: coerceGrade(obj.grade, evApprox),
      rationale: String(obj.rationale ?? ""),
      rejectedAndWhy: (obj.rejectedAndWhy as string[] | undefined) ?? [],
    };
  } catch {
    return null;
  }
}

// ── Public: buildEligibleBets ─────────────────────────────────────────────────

export function buildEligibleBets(evMarkets: EVMarket[]): EVMarket[] {
  return evMarkets.filter((m) => !m.veto && m.ev > 0);
}

// ── Public: decide ────────────────────────────────────────────────────────────

// Model IDs come from @oracle/llm cascade.ts (MODELS / OPENROUTER_MODELS) via the same
// dynamic imports each tier already performs — no static @oracle/llm coupling, so the
// deterministic path still runs when the LLM module is absent.

/** Calls LLMs to select the best bet, then runs the mandatory final-arbiter pass.
 *
 *  Draft cascade (multi-tier — produces the candidate the arbiter will review).
 *  Owner-mandated reorder, 2026-07-10:
 *   1. Local Claude Code CLI (Opus) — no API key needed; fires whenever
 *                       isLocalRuntime() is true
 *   2. Gemini 3.5 Flash — when geminiApiKey present (fires if rung 1 was
 *                       unavailable or returned nothing)
 *   3. OpenRouter, free tier only — GLM-5.2 → DeepSeek-V4-Pro → DeepSeek-V4-Flash →
 *                       Gemma 4, STRICTLY free (:free) variants. Each named model's
 *                       own :free slug is tried first, immediately followed by its
 *                       verified free reasoning substitute where the named model has
 *                       no live free endpoint — see cascade.ts's OPENROUTER_MODELS
 *                       header comment for sources. Fires when openrouterApiKey present.
 *   4. Deterministic  — when all LLMs unavailable or parse fails
 *
 *  Final arbiter — ORACLE_LOCAL_DECISION="true" (global, applies to every fixture
 *  through every analysis pipeline — daily batch, punt, CLI fixture lookup, since
 *  they all route through this one function):
 *  local Claude Code (Opus) reviews the draft's stats, news intel, rationale,
 *  and engine math, then RATIFIES it, OVERRIDES it with a different eligible
 *  market, or FLAGS MISSING_DATA. The arbiter's verdict becomes the returned
 *  decision. On any arbiter failure (binary missing, non-local runtime, timeout,
 *  bad parse), the draft is returned as-is with arbiterStatus="unverified" so
 *  callers/UI can tell the difference — never blocks the pipeline. When the flag
 *  is unset, behaves exactly as before (draft cascade only, no arbiterStatus).
 *
 *  Always returns { decision, replay } — replay is null on the deterministic path
 *  with the arbiter off. `shadow` on the result is always undefined now — the
 *  GLM-5.2 shadow comparison was retired when GLM-5.2 became a real cascade rung
 *  (rung 3) instead of an observability-only side call; the field is kept only for
 *  API compatibility with existing callers (see DecisionResult.shadow above). */
export async function decide(
  eligibleBets: EVMarket[],
  ctx?: DecisionContext,
  config?: Pick<
    OracleConfig,
    | "claudeApiKey"
    | "geminiApiKey"
    | "openrouterApiKey"
    | "enableLlmMarketExecutor"
    | "llmExecutorScope"
  >,
  forceDeterministic = false,
  marketExecutorRisk?: MarketExecutorRiskParams,
  // PR-8 LLM demote/gate (posture A):
  //   skipDraftLlm — v3 already supplied deterministic candidates, so skip the paid
  //     draft LLM cascade (and the market-executor tier) and use the deterministic
  //     draft; the arbiter still reviews it on eligible fixtures. Inert when v3 off.
  //   skipArbiter — this fixture is outside the top-N, so skip the per-fixture
  //     arbiter entirely (today it runs for EVERY fixture with candidates).
  opts: { skipDraftLlm?: boolean; skipArbiter?: boolean } = {}
): Promise<DecisionResult> {
  let effectiveEligible = eligibleBets;
  let draft: DecisionResult | undefined;
  // A deterministic draft is forced either by the caller's top-N gate
  // (forceDeterministic) or by posture A skipping the draft cascade when v3 supplied
  // the candidate set.
  const useDeterministicDraft = forceDeterministic || opts.skipDraftLlm === true;
  // PR-23: the executor's own gate must NOT inherit skipDraftLlm under
  // "unmapped" scope. batch/index.ts sets skipDraftLlm=true precisely when
  // v3 supplied candidates (PR-8 posture A, cost optimization on the PAID
  // draft cascade) — which is EXACTLY when unmapped-scope's tail sweep is
  // meant to run. Only forceDeterministic (this fixture isn't llmEligible —
  // the plan's own "skip when tail empty or !llmEligible" rule) gates the
  // executor in unmapped scope. "full"/legacy scope is unchanged: both
  // forceDeterministic and skipDraftLlm block it, since a second
  // full-catalogue LLM pass is pure waste whenever the draft is already
  // being forced deterministic for ANY reason.
  const executorGateOpen =
    config?.llmExecutorScope === "unmapped" ? !forceDeterministic : !useDeterministicDraft;

  // Q4 (owner-directed): when on, REPLACES the eligibleBets-constrained cascade
  // below for this fixture — an LLM agent reasons over the full allMarkets
  // catalogue instead of being limited to the ~9 priced families. Fail-open: any
  // missing data/call/parse/validation failure leaves draft unset and falls
  // through to the normal cascade exactly as if the flag were off.
  if (config?.enableLlmMarketExecutor && ctx && executorGateOpen && marketExecutorRisk) {
    const executed = await runAllMarketsLlmExecutor(ctx, marketExecutorRisk);
    if (executed) {
      // Splice the executor's pick into the eligible set so the arbiter (which
      // audits the draft against an eligible list) and validateSelection's
      // Gate 1 downstream both recognise it, even though scanMarkets() never
      // priced this exact market — it's still a server-validated EVMarket.
      // Exposed back via DecisionResult.eligibleBets so callers (batch/index.ts)
      // use the SAME widened list for their own post-decide() gates/reporting.
      effectiveEligible = [executed.market, ...eligibleBets];
      // PR-23: "full" scope (config.llmExecutorScope undefined or "full" —
      // the pre-PR-23 behavior, unchanged) makes the executor's pick the
      // draft outright. "unmapped" scope only SPLICES it into
      // effectiveEligible above — draft stays unset here, so it falls
      // through to decideInner's normal cascade below, which now sees the
      // widened pool and picks whichever candidate (v3's or the executor's)
      // actually ranks best by EV, same rule everything else in this
      // pipeline already uses. The arbiter (further below) reviews the same
      // widened list either way.
      if (config.llmExecutorScope !== "unmapped") {
        draft = {
          decision: executed.decision,
          replay: executed.replay,
          eligibleBets: effectiveEligible,
        };
      }
    }
  }

  if (!draft) draft = await decideInner(effectiveEligible, ctx, config, useDeterministicDraft);

  let result = draft;
  // PR-8: the per-fixture arbiter now respects the top-N cap — skipArbiter is set
  // for fixtures outside the llmEligible set, so only top-N picks still pay the
  // arbiter LLM cost (previously every fixture with candidates did).
  if (!opts.skipArbiter && ctx && effectiveEligible.length) {
    result = await arbitrate(effectiveEligible, ctx, draft);
  }
  // PR-23: neither decideInner() nor arbitrate() set eligibleBets themselves —
  // only the executor-direct-draft branch above does. Under "unmapped" scope
  // (splice, not draft) that branch never runs, so without this the widened
  // list would silently vanish before reaching callers (batch/index.ts's
  // effectiveEligible = executedEligible ?? eligible). effectiveEligible !==
  // eligibleBets (reference check) is only true when the executor actually
  // spliced something in, so this is a no-op whenever it didn't.
  if (result.eligibleBets === undefined && effectiveEligible !== eligibleBets) {
    result = { ...result, eligibleBets: effectiveEligible };
  }

  return result;
}

async function decideInner(
  eligibleBets: EVMarket[],
  ctx?: DecisionContext,
  config?: Pick<OracleConfig, "claudeApiKey" | "geminiApiKey" | "openrouterApiKey">,
  forceDeterministic = false
): Promise<DecisionResult> {
  if (!eligibleBets.length) {
    // No positive-EV bets — return the placeholder NO_EDGE pick
    return deterministicDecide([], "No positive-EV bets — NO_EDGE grade");
  }

  // Two-tier gate: fixtures outside the top-N (by composite stats score) get the
  // full deterministic engine analysis but skip the paid/slow LLM decision tier.
  // Only the top-N (llmEligible) reach Claude/Gemini/OpenRouter for final picks.
  if (forceDeterministic) return deterministicDecide(eligibleBets);

  // Skip paid LLM tiers when context is missing
  if (!ctx) return deterministicDecide(eligibleBets);

  const prompt = buildPrompt(eligibleBets, ctx);
  const geminiKey = config?.geminiApiKey ?? "";
  const openrouterKey = config?.openrouterApiKey ?? "";

  // ── Rung 1: local Claude Code CLI (Opus, no API key needed) ──────────────
  // isLocalRuntime() guards the spawn — must NOT be removed. Without it, a real
  // `claude` binary on PATH is called during every Vitest run, causing 5–45s
  // hangs and intermittent CI failures on dev boxes with the CLI installed.
  try {
    const { callClaudeCode, isLocalRuntime, MODELS } = await import("@oracle/llm");
    if (isLocalRuntime()) {
      const raw = await callClaudeCode(prompt, { timeoutMs: 45_000 });
      if (raw) {
        const replay: DecisionReplay = {
          prompt,
          rawResponse: raw,
          model: MODELS.CLAUDE_OPUS,
          temperature: 0,
        };
        const parsed = parseDecisionResponse(raw);
        if (parsed) return { decision: parsed, replay };
      }
    }
  } catch {
    // Fall through to Gemini
  }

  return await _tryGemini(
    prompt,
    geminiKey,
    openrouterKey,
    eligibleBets,
    "Claude local unavailable"
  );
}

/** ── Rung 2: Gemini 3.5 Flash — fires only when rung 1 (local Claude Code)
 *  was unavailable (isLocalRuntime()=false) or returned nothing. Pure Gemini
 *  call: does NOT re-attempt local Claude Code (that was rung 1's job) — on
 *  any failure (missing key, call error, bad parse) falls straight through to
 *  the OpenRouter free-tier cascade (rungs 3-6). callGeminiDecision() throws
 *  when its own internal Pro→Flash cascade is exhausted; caught here like any
 *  other tier failure. */
async function _tryGemini(
  prompt: string,
  geminiKey: string,
  openrouterKey: string,
  eligibleBets: EVMarket[],
  priorFailReason: string
): Promise<DecisionResult> {
  if (geminiKey) {
    try {
      const { callGeminiDecision, MODELS } = await import("@oracle/llm");
      const raw = await callGeminiDecision(prompt, {
        config: { claudeApiKey: "", geminiApiKey: geminiKey, bankroll: 0 },
        requestedAt: new Date().toISOString(),
      });
      if (raw) {
        const parsed = parseDecisionResponse(raw);
        if (parsed) {
          const replay: DecisionReplay = {
            prompt,
            rawResponse: raw,
            model: MODELS.GEMINI_FLASH,
            temperature: 0,
          };
          return { decision: parsed, replay };
        }
      }
    } catch {
      // Fall through to OpenRouter
    }
  }

  return await _tryOpenRouter(
    prompt,
    openrouterKey,
    eligibleBets,
    `${priorFailReason} — Gemini unavailable`
  );
}

/** ── Rungs 3-6: OpenRouter free-tier cascade — GLM-5.2 → DeepSeek-V4-Pro →
 *  DeepSeek-V4-Flash → Gemma 4. STRICTLY free (:free) variants per owner
 *  directive 2026-07-10 — this is the decision-path cascade only; contrast
 *  with the DeepSeek-first PAID cascade other call sites (callGemini.ts,
 *  callVerification.ts, callRegimeHint.ts — out of this workstream's scope)
 *  still use unchanged. Each named model's own :free slug is tried first
 *  (GLM-5.2 and DeepSeek have no confirmed live :free endpoint as of
 *  2026-07-10 — see cascade.ts's OPENROUTER_MODELS header comment for
 *  sources — so those two attempts are expected to fail and the loop just
 *  skips them), immediately followed by the verified free reasoning
 *  substitute. Each model is tried at temperature 0 with JSON mode; the first
 *  that parses wins. All fail (or no key) → deterministic fallback.
 *  callOpenRouterJson never throws. */
async function _tryOpenRouter(
  prompt: string,
  openrouterKey: string,
  eligibleBets: EVMarket[],
  priorFailReason: string
): Promise<DecisionResult> {
  if (!openrouterKey) {
    return deterministicDecide(
      eligibleBets,
      `${priorFailReason} — no OpenRouter key — deterministic fallback`
    );
  }

  const { callOpenRouterJson, OPENROUTER_MODELS } = await import("@oracle/llm");
  for (const model of [
    OPENROUTER_MODELS.GLM_5_2_FREE,
    OPENROUTER_MODELS.GLM_4_5_AIR_FREE,
    OPENROUTER_MODELS.DEEPSEEK_V4_PRO_FREE,
    OPENROUTER_MODELS.NEMOTRON_3_ULTRA_FREE,
    OPENROUTER_MODELS.DEEPSEEK_V4_FLASH_FREE,
    OPENROUTER_MODELS.NEMOTRON_NANO_OMNI_REASONING_FREE,
    OPENROUTER_MODELS.GEMMA_4_26B_MOE_FREE,
    OPENROUTER_MODELS.GEMMA_4_31B_FREE,
  ]) {
    const raw = await callOpenRouterJson(
      "You are ORACLE's gated betting decision engine. Return ONLY valid JSON.",
      prompt,
      model,
      openrouterKey,
      0
    );
    if (!raw) continue;
    const parsed = parseDecisionResponse(raw);
    if (!parsed) continue;
    const replay: DecisionReplay = {
      prompt,
      rawResponse: raw,
      model,
      temperature: 0,
    };
    return { decision: parsed, replay };
  }

  return deterministicDecide(
    eligibleBets,
    `${priorFailReason} — OpenRouter cascade exhausted — deterministic fallback`
  );
}

// ── Public: validateSelection ─────────────────────────────────────────────────

/** Hard gates enforced in code — no LLM instruction can bypass these. */
export function validateSelection(
  pick: DecisionOutput,
  eligibleBets: EVMarket[],
  mlFilter?: { mlAllowed?: boolean; drawRisk?: string }
): DecisionOutput {
  const ref = pick.primaryPick;

  // Gate 1: pick must be in eligible set. Matched on market AND side — matching
  // on market (category) alone would accept any same-category EVMarket (e.g.
  // any "Goals O/U" line) regardless of which specific side/line the LLM named,
  // which would then let Gate 1.5 below overwrite stake/odds with the WRONG
  // market's numbers. MISSING_DATA is exempt — the arbiter is explicitly
  // allowed to decline to commit to a market (e.g. when eligibleBets is empty),
  // and forcing a deterministic placeholder here would silently erase that
  // honest "not enough evidence" verdict and replace it with a fabricated pick.
  // Side is matched with light normalization (case, whitespace, parenthetical
  // team names stripped). Models paraphrase e.g. "DNB Home" as "Home" or
  // "Home (Sturm Graz)", so we allow a suffix match (one side is the tail of the
  // other separated by a space): "dnb home" endsWith " home" → match. Plain
  // includes() was rejected because "over 1.5".includes("over 1") is true, which
  // would cross-match O/U 1.5 to a model pick of "Over 1" in markets that list
  // both integer and half-ball lines (goals, corners, shots).
  const normalizeSide = (s: string) =>
    s
      .replace(/\([^)]*\)/g, "")
      .trim()
      .toLowerCase();
  const found = eligibleBets.find((m) => {
    if (m.market !== ref.market) return false;
    if (!ref.side) return true;
    if (!m.side) return false;
    const a = normalizeSide(m.side);
    const b = normalizeSide(ref.side);
    return a === b || a.endsWith(" " + b) || b.endsWith(" " + a);
  });
  if (!found && pick.grade !== "MISSING_DATA") {
    return deterministicDecide(
      eligibleBets,
      `Rejected: ${ref.market} not in eligible set — deterministic fallback`
    ).decision;
  }

  // Gate 1.5: the LLM may choose WHICH eligible market to recommend, but the
  // stake/odds MAGNITUDE must always be the engine's own number for that exact
  // market, never the LLM's restated (and unreconciled) figure — the LLM
  // self-reports stake/odds in its JSON response (see buildPrompt/
  // buildArbiterPrompt's required output schema) and that figure flowed
  // downstream unmodified until this fix, letting an LLM transcription error
  // silently misstate the actual Kelly stake or price the engine computed.
  if (found) {
    pick = {
      ...pick,
      primaryPick: { ...ref, odds: found.odds, stake: found.stake },
    };
  }

  // Gate 2 (ML safety filter → NO_EDGE) and Gate 3 (MoneyLine draw-risk block)
  // removed per owner instruction 2026-06-30: the LLM arbiter over 1000+ markets
  // is now the quality gate. Fixtures with thin data are excluded upstream
  // (SRL/virtual filtered at selectFixtures; league scoring controls llmEligible
  // routing) — any fixture that reaches here has real markets and the LLM should
  // find edge, not be silently downgraded to NO_EDGE by a deterministic heuristic.
  return pick;
}

// ── Public: logDisagreement (debate RED verdicts) ─────────────────────────────

/** Writes RED-verdict debate results to the disagreement log for SkillOpt. */
export async function logDisagreement(
  storage: StoragePort,
  debateResult: Record<string, unknown>
): Promise<void> {
  const referee = debateResult.referee as Record<string, unknown> | undefined;
  if (!referee) return;

  const verdicts = referee.verdicts as Array<Record<string, unknown>> | undefined;
  const redVerdicts = (verdicts ?? []).filter((v) => v.verdict === "RED");
  if (!redVerdicts.length) return;

  // Serialized read-modify-write — safe under concurrent fixture processing.
  await withKeyLock(STORAGE_KEYS.decisionDisagreementLog, async () => {
    const existing =
      (await storage.get<Array<Record<string, unknown>>>(STORAGE_KEYS.decisionDisagreementLog)) ??
      [];
    await storage.set(STORAGE_KEYS.decisionDisagreementLog, [
      ...existing,
      {
        type: "DEBATE_RED",
        timestamp: Date.now(),
        overallTrigger: referee.overallTrigger,
        redVerdicts,
      },
    ]);
  });
}

// ── Public: logPickDisagreement (LLM vs deterministic) ───────────────────────

/** Writes a disagreement entry when LLM pick differs from the deterministic top.
 *  This is the primary training signal for the SkillOpt loop. */
export async function logPickDisagreement(
  storage: StoragePort,
  llmPick: DecisionOutput,
  deterministicTop: EVMarket | null,
  fixture: { home: string; away: string; league: string; kickoff: string; fixtureId: string }
): Promise<void> {
  if (!deterministicTop) return;

  const llmMarket = llmPick.primaryPick.market;

  if (llmMarket === deterministicTop.market) return; // no disagreement

  // Serialized read-modify-write — safe under concurrent fixture processing.
  await withKeyLock(STORAGE_KEYS.decisionDisagreementLog, async () => {
    const existing =
      (await storage.get<Array<Record<string, unknown>>>(STORAGE_KEYS.decisionDisagreementLog)) ??
      [];
    await storage.set(STORAGE_KEYS.decisionDisagreementLog, [
      ...existing,
      {
        type: "LLM_DISAGREE",
        timestamp: Date.now(),
        fixtureId: fixture.fixtureId,
        home: fixture.home,
        away: fixture.away,
        league: fixture.league,
        kickoff: fixture.kickoff,
        llmPick: llmMarket,
        llmSide: llmPick.primaryPick.side ?? null,
        llmOdds: llmPick.primaryPick.odds ?? null,
        deterministicPick: deterministicTop.market,
        deterministicSide: deterministicTop.side ?? null,
        deterministicOdds: deterministicTop.odds,
        confidence: llmPick.confidence,
        rationale: llmPick.rationale,
      },
    ]);
  });
}
