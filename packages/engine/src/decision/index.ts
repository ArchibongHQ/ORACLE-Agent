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

/** Paired output from decide() — decision for downstream gates, replay for the ledger. */
export interface DecisionResult {
  decision: DecisionOutput;
  replay: DecisionReplay | null;
  /** GLM-5.2 shadow comparison — observability only, never affects `decision`. */
  shadow?: DecisionShadow;
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

const VALID_GRADES = new Set<string>(["STRONG", "LEAN", "NO_EDGE"]);

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
Accept (STRONG) when: convergence STRONG or MODERATE, mlAllowed=true, ev>4%, hoursToKO>4
Grade LEAN when: betTrigger=RED without strong independent evidence, mlAllowed=false, portfolioCorrelation>0.6, or ev<5%
Grade NO_EDGE when: ev<=0 — still return the best-ranked market in primaryPick
MoneyLine picks forbidden when drawRisk=VERY_HIGH

=== REQUIRED OUTPUT (JSON only, no other text) ===
{"primaryPick":{"market":"...","side":"...","odds":0.0,"stake":0.00},"altPick":{"market":"...","side":"...","odds":0.0,"stake":0.00},"confidence":0.0,"grade":"STRONG","rationale":"...","rejectedAndWhy":[]}
"grade" must be one of: "STRONG", "LEAN", "NO_EDGE". Always set primaryPick to the best-ranked market.
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

// ── GLM-5.2 shadow run ────────────────────────────────────────────────────────

/** Evaluates GLM-5.2 against the same prompt the real decision tier received,
 *  for observability only — never affects the returned decision. Fail-open:
 *  any error or missing key returns undefined. Research context: GLM-5.2 sits
 *  at decision-layer Tier 3 (last resort) behind Claude/Gemini/free OpenRouter
 *  models; this shadow run tests whether it would pick differently before any
 *  cascade reordering is considered. */
async function shadowDecideWithGlm52(
  prompt: string,
  openrouterKey: string,
  realPick: DecisionOutput
): Promise<DecisionShadow | undefined> {
  if (!openrouterKey) return undefined;
  try {
    const { callOpenRouterJson, OPENROUTER_MODELS } = await import("@oracle/llm");
    const raw = await callOpenRouterJson(
      "You are ORACLE's gated betting decision engine. Return ONLY valid JSON.",
      prompt,
      OPENROUTER_MODELS.GLM_5_2,
      openrouterKey,
      0
    );
    if (!raw) return undefined;
    const parsed = parseDecisionResponse(raw);
    if (!parsed) return undefined;
    return {
      model: OPENROUTER_MODELS.GLM_5_2,
      pick: parsed,
      agree: parsed.primaryPick.market === realPick.primaryPick.market,
    };
  } catch {
    return undefined;
  }
}

// ── Public: decide ────────────────────────────────────────────────────────────

// Model IDs come from @oracle/llm cascade.ts (MODELS / OPENROUTER_MODELS) via the same
// dynamic imports each tier already performs — no static @oracle/llm coupling, so the
// deterministic path still runs when the LLM module is absent.

/** Calls LLMs to select the best bet.
 *
 *  Fallback chain (multi-tier):
 *   1. Claude Opus    — when claudeApiKey present
 *   2. Gemini 3.5     — when geminiApiKey present (fires if Claude key absent OR Claude call fails)
 *   3. OpenRouter     — GLM-5.1 → GPT-oss-120B → DeepSeek R1 (when openrouterApiKey present)
 *   4. Deterministic  — when all LLMs unavailable or parse fails
 *
 *  Always returns { decision, replay } — replay is null on the deterministic path.
 *  When the real decision came from an LLM tier and an OpenRouter key is present,
 *  also runs a non-blocking GLM-5.2 shadow comparison (see `shadow` on the result). */
export async function decide(
  eligibleBets: EVMarket[],
  ctx?: DecisionContext,
  config?: Pick<OracleConfig, "claudeApiKey" | "geminiApiKey" | "openrouterApiKey">,
  forceDeterministic = false
): Promise<DecisionResult> {
  const result = await decideInner(eligibleBets, ctx, config, forceDeterministic);
  if (!ctx || result.replay === null || !config?.openrouterApiKey) return result;

  // Skip when GLM-5.2 itself already produced the real decision (Tier 3 last
  // resort) — shadowing it against itself is a wasted call with a trivial result.
  const { OPENROUTER_MODELS } = await import("@oracle/llm");
  if (result.replay.model === OPENROUTER_MODELS.GLM_5_2) return result;

  const prompt = buildPrompt(eligibleBets, ctx);
  const shadow = await shadowDecideWithGlm52(prompt, config.openrouterApiKey, result.decision);
  return shadow ? { ...result, shadow } : result;
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
  const requestedAt = new Date().toISOString();
  const geminiKey = config?.geminiApiKey ?? "";
  const openrouterKey = config?.openrouterApiKey ?? "";

  // ── Tier 1: Claude Opus ───────────────────────────────────────────────────
  if (config?.claudeApiKey) {
    try {
      const { callClaude, MODELS } = await import("@oracle/llm");
      const raw = await callClaude(
        prompt,
        {
          config: { claudeApiKey: config.claudeApiKey, geminiApiKey: geminiKey, bankroll: 0 },
          requestedAt,
        },
        { model: MODELS.CLAUDE_OPUS, maxTokens: 1024 }
      );
      const replay: DecisionReplay = {
        prompt,
        rawResponse: raw,
        model: MODELS.CLAUDE_OPUS,
        temperature: 0,
      };
      const parsed = parseDecisionResponse(raw);
      if (!parsed) {
        return await _tryGemini(
          prompt,
          geminiKey,
          openrouterKey,
          requestedAt,
          eligibleBets,
          "Claude parse failure"
        );
      }
      return { decision: parsed, replay };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return await _tryGemini(prompt, geminiKey, openrouterKey, requestedAt, eligibleBets, reason);
    }
  }

  // ── Tier 1 skipped (no claudeApiKey) → go straight to Gemini ─────────────
  return await _tryGemini(
    prompt,
    geminiKey,
    openrouterKey,
    requestedAt,
    eligibleBets,
    "No Claude key"
  );
}

async function _tryGemini(
  prompt: string,
  geminiKey: string,
  openrouterKey: string,
  requestedAt: string,
  eligibleBets: EVMarket[],
  claudeFailReason: string
): Promise<DecisionResult> {
  if (!geminiKey) {
    return await _tryOpenRouter(
      prompt,
      openrouterKey,
      eligibleBets,
      `${claudeFailReason} — no Gemini key`
    );
  }

  // ── Tier 2: Gemini 3.5 ────────────────────────────────────────────────────
  try {
    const { callGeminiDecision, MODELS } = await import("@oracle/llm");
    const raw = await callGeminiDecision(prompt, {
      config: { claudeApiKey: "", geminiApiKey: geminiKey, bankroll: 0 },
      requestedAt,
    });
    const replay: DecisionReplay = {
      prompt,
      rawResponse: raw,
      model: MODELS.GEMINI_PRO,
      temperature: 0,
    };
    const parsed = parseDecisionResponse(raw);
    if (!parsed) {
      return await _tryOpenRouter(prompt, openrouterKey, eligibleBets, "Gemini parse failure");
    }
    return { decision: parsed, replay };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return await _tryOpenRouter(
      prompt,
      openrouterKey,
      eligibleBets,
      `Gemini unavailable (${reason})`
    );
  }
}

/** ── Tier 3: OpenRouter cascade — GLM-5.1 → GPT-oss-120B → DeepSeek R1.
 *  Each model is tried at temperature 0 with JSON mode; the first that parses wins.
 *  All fail (or no key) → deterministic fallback. callOpenRouterJson never throws. */
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
  // Working-free models first (verified live on the project account, no credits
  // needed), then paid GLMs as a last resort for when the account is funded.
  // Cycling through several free models means a transient 429 on one just rolls
  // to the next instead of dropping straight to the deterministic fallback.
  for (const model of [
    OPENROUTER_MODELS.GPT_OSS_120B,
    OPENROUTER_MODELS.NEMOTRON_SUPER_120B,
    OPENROUTER_MODELS.QWEN3_NEXT_80B,
    OPENROUTER_MODELS.GPT_OSS_20B,
    OPENROUTER_MODELS.LLAMA_3_3_70B,
    OPENROUTER_MODELS.GLM_5_2,
    OPENROUTER_MODELS.GLM_5_1,
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

  // Gate 1: pick must be in eligible set
  const found = eligibleBets.find((m) => m.market === ref.market);
  if (!found) {
    return deterministicDecide(
      eligibleBets,
      `Rejected: ${ref.market} not in eligible set — deterministic fallback`
    ).decision;
  }

  // Gate 2: ML safety filter blocked — downgrade to NO_EDGE (pick stays for reporting)
  if (mlFilter?.mlAllowed === false) {
    return {
      ...pick,
      grade: "NO_EDGE",
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
