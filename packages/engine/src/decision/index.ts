/** Decision layer — Phase 4 full implementation.
 *  decide() calls Claude Opus; falls back to deterministic when key is absent or call fails.
 *  validateSelection enforces hard gates in code — no LLM instruction can bypass them. */

import type { StoragePort } from "@oracle/storage";
import { STORAGE_KEYS, withKeyLock } from "@oracle/storage";
import type {
  DecisionContext,
  DecisionOutput,
  DecisionReplay,
  EVMarket,
  OracleConfig,
  PickRef,
} from "../types.js";

/** Paired output from decide() — decision for downstream gates, replay for the ledger. */
export interface DecisionResult {
  decision: DecisionOutput;
  replay: DecisionReplay | null;
}

// DecisionContext is the canonical fixture-evidence type — defined in types.ts (Appendix B),
// re-exported here for callers that import from the decision module.
export type { DecisionContext };

// ── Deterministic fallback ────────────────────────────────────────────────────

function deterministicDecide(
  eligibleBets: EVMarket[],
  rationale = "Deterministic top pick"
): DecisionResult {
  if (!eligibleBets.length) {
    return {
      decision: {
        primaryPick: "NO_BET",
        confidence: 0,
        rationale: "No eligible bets",
        rejectedAndWhy: [],
      },
      replay: null,
    };
  }
  const top = eligibleBets[0]!;
  const pick: PickRef = { market: top.market, side: top.side, odds: top.odds, stake: top.stake };
  return {
    decision: { primaryPick: pick, confidence: top.modelProb, rationale, rejectedAndWhy: [] },
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

=== ELIGIBLE BETS (ranked by model score) ===
${betLines || "NONE"}
${softLines ? `\n=== SOFT CONTEXT (Gemini acquisition) ===\n${softLines}` : ""}
=== DECISION RULES ===
Accept when: convergence STRONG or MODERATE, mlAllowed=true, ev>4%, hoursToKO>4
Lean NO_BET when: betTrigger=RED without strong independent evidence, mlAllowed=false, portfolioCorrelation>0.6
MoneyLine picks forbidden when drawRisk=VERY_HIGH

=== REQUIRED OUTPUT (JSON only, no other text) ===
{"primaryPick":{"market":"...","side":"...","odds":0.0,"stake":0.00},"altPick":{"market":"...","side":"...","odds":0.0,"stake":0.00},"confidence":0.0,"rationale":"...","rejectedAndWhy":[]}
Set "primaryPick" to "NO_BET" (string) when no bet is justified.
"altPick" is optional.`;
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

    return {
      primaryPick: obj.primaryPick as DecisionOutput["primaryPick"],
      altPick: obj.altPick as PickRef | undefined,
      confidence: Number(obj.confidence ?? 0),
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

// Decision-path model IDs. Kept in sync with @oracle/llm cascade.ts MODELS — the canonical source.
// Hardcoded here (not imported) to avoid forcing a static @oracle/llm import on the deterministic path,
// which must run even when the LLM module is absent. Update both locations together.
const CLAUDE_DECISION_MODEL = "claude-opus-4-8"; // = MODELS.CLAUDE_OPUS
const GEMINI_DECISION_MODEL = "gemini-3.5-flash"; // = MODELS.GEMINI_PRO (3.5 Flash; was gemini-3.1-pro-preview)

/** Calls LLMs to select the best bet.
 *
 *  Fallback chain (three tiers):
 *   1. Claude Opus   — when claudeApiKey present
 *   2. Gemini 2.5 Pro — when geminiApiKey present (fires if Claude key absent OR Claude call fails)
 *   3. Deterministic  — when both LLMs unavailable or parse fails
 *
 *  Always returns { decision, replay } — replay is null on the deterministic path. */
export async function decide(
  eligibleBets: EVMarket[],
  ctx?: DecisionContext,
  config?: Pick<OracleConfig, "claudeApiKey" | "geminiApiKey">
): Promise<DecisionResult> {
  if (!eligibleBets.length) {
    return {
      decision: {
        primaryPick: "NO_BET",
        confidence: 0,
        rationale: "No eligible bets",
        rejectedAndWhy: [],
      },
      replay: null,
    };
  }

  // Skip all LLM tiers when context is missing
  if (!ctx) return deterministicDecide(eligibleBets);

  const prompt = buildPrompt(eligibleBets, ctx);
  const requestedAt = new Date().toISOString();
  const geminiKey = config?.geminiApiKey ?? "";

  // ── Tier 1: Claude Opus ───────────────────────────────────────────────────
  if (config?.claudeApiKey) {
    try {
      const { callClaude } = await import("@oracle/llm");
      const raw = await callClaude(
        prompt,
        {
          config: { claudeApiKey: config.claudeApiKey, geminiApiKey: geminiKey, bankroll: 0 },
          requestedAt,
        },
        { model: CLAUDE_DECISION_MODEL, maxTokens: 1024 }
      );
      const replay: DecisionReplay = {
        prompt,
        rawResponse: raw,
        model: CLAUDE_DECISION_MODEL,
        temperature: 0,
      };
      const parsed = parseDecisionResponse(raw);
      if (!parsed) {
        return await _tryGemini(
          prompt,
          geminiKey,
          requestedAt,
          eligibleBets,
          "Claude parse failure"
        );
      }
      return { decision: parsed, replay };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return await _tryGemini(prompt, geminiKey, requestedAt, eligibleBets, reason);
    }
  }

  // ── Tier 1 skipped (no claudeApiKey) → go straight to Gemini ─────────────
  return await _tryGemini(prompt, geminiKey, requestedAt, eligibleBets, "No Claude key");
}

async function _tryGemini(
  prompt: string,
  geminiKey: string,
  requestedAt: string,
  eligibleBets: EVMarket[],
  claudeFailReason: string
): Promise<DecisionResult> {
  if (!geminiKey) {
    return deterministicDecide(
      eligibleBets,
      `${claudeFailReason} — no Gemini key — deterministic fallback`
    );
  }

  // ── Tier 2: Gemini 2.5 Pro ────────────────────────────────────────────────
  try {
    const { callGeminiDecision } = await import("@oracle/llm");
    const raw = await callGeminiDecision(prompt, {
      config: { claudeApiKey: "", geminiApiKey: geminiKey, bankroll: 0 },
      requestedAt,
    });
    const replay: DecisionReplay = {
      prompt,
      rawResponse: raw,
      model: GEMINI_DECISION_MODEL,
      temperature: 0,
    };
    const parsed = parseDecisionResponse(raw);
    if (!parsed) {
      return {
        ...deterministicDecide(eligibleBets, "Gemini parse failure — deterministic fallback"),
        replay,
      };
    }
    return { decision: parsed, replay };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return deterministicDecide(
      eligibleBets,
      `Gemini unavailable (${reason}) — deterministic fallback`
    );
  }
}

// ── Public: validateSelection ─────────────────────────────────────────────────

/** Hard gates enforced in code — no LLM instruction can bypass these. */
export function validateSelection(
  pick: DecisionOutput,
  eligibleBets: EVMarket[],
  mlFilter?: { mlAllowed?: boolean; drawRisk?: string }
): DecisionOutput {
  if (pick.primaryPick === "NO_BET") return pick;

  const ref = pick.primaryPick as PickRef;

  // Gate 1: pick must be in eligible set
  const found = eligibleBets.find((m) => m.market === ref.market);
  if (!found) {
    return deterministicDecide(
      eligibleBets,
      `Rejected: ${ref.market} not in eligible set — deterministic fallback`
    ).decision;
  }

  // Gate 2: ML safety filter blocked
  if (mlFilter?.mlAllowed === false) {
    return {
      primaryPick: "NO_BET",
      confidence: 0,
      rationale: "ML safety filter blocked all bets",
      rejectedAndWhy: ["mlFilter.mlAllowed=false"],
    };
  }

  // Gate 3: MoneyLine forbidden when draw risk is VERY_HIGH
  if ((found.cat === "1x2" || found.market === "1x2") && mlFilter?.drawRisk === "VERY_HIGH") {
    const nonMl = eligibleBets.filter((m) => m.cat !== "1x2" && m.market !== "1x2");
    return deterministicDecide(nonMl, "MoneyLine rejected: VERY_HIGH draw risk").decision;
  }

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

  const llmRef = llmPick.primaryPick === "NO_BET" ? null : (llmPick.primaryPick as PickRef);
  const llmMarket = llmRef?.market ?? "NO_BET";

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
        llmSide: llmRef?.side ?? null,
        llmOdds: llmRef?.odds ?? null,
        deterministicPick: deterministicTop.market,
        deterministicSide: deterministicTop.side ?? null,
        deterministicOdds: deterministicTop.odds,
        confidence: llmPick.confidence,
        rationale: llmPick.rationale,
      },
    ]);
  });
}
