/** B2 — Claude Verification Layer (CVL).
 *  Spec: ORACLE_v2026_8_0.jsx lines 5239–5294.
 *  Adversarial review of chosen pick using Claude Opus — every Claude call in this
 *  pipeline targets Opus/Fable-5-or-newer, never Sonnet or older (operator instruction).
 *  Returns { status, stamp, override? } — skipped when no Claude key. */
import Anthropic from "@anthropic-ai/sdk";
import { callClaudeCode, isLocalRuntime } from "./callClaudeCode.js";
import { callOpenRouterJson } from "./callOpenRouter.js";
import { MODELS, OPENROUTER_MODELS } from "./cascade.js";
import type { LLMCallContext } from "./types.js";

/** Per-call timeout. The Anthropic SDK's own default lets a hung connection
 *  stall a fixture indefinitely — bound it so CVL falls through to OpenRouter
 *  tiers quickly instead of hanging. */
const REQUEST_TIMEOUT_MS = 20_000;

export type CvlStatus = "APPROVED" | "OVERRIDE" | "VETO" | "SKIPPED";

export interface CvlResult {
  status: CvlStatus;
  stamp: string; // ISO timestamp
  override?: string; // alternative pick label when status === 'OVERRIDE'
  rationale: string;
  model: string;
}

const CVL_SYSTEM = `You are an adversarial bet-verification agent.
You receive a proposed primary pick from ORACLE. Your job is to find flaws.
Return ONLY valid JSON: {"status":"APPROVED"|"OVERRIDE"|"VETO","rationale":"...","override":"optional alternative pick label"}
VETO: clear flaw (wrong market side, odds discrepancy, negative EV).
OVERRIDE: pick is sound but a clearly superior alternative exists (state it in override field).
APPROVED: pick is sound with no better alternative.`;

/** Returns null on any parse failure — callers must treat null as "could not
 *  verify this response" and fall through to the next tier, NOT default to a
 *  confident APPROVED. A confident-looking default here would let malformed
 *  output from the unreliable tier-0 local CLI silently bypass the entire
 *  adversarial-verification safety layer. */
function parseCvlResponse(text: string): {
  status: CvlStatus;
  rationale: string;
  override?: string;
} | null {
  try {
    const cleaned = text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    if (!["APPROVED", "OVERRIDE", "VETO"].includes(String(obj.status))) return null;
    return {
      status: obj.status as CvlStatus,
      rationale: String(obj.rationale ?? ""),
      override: obj.override ? String(obj.override) : undefined,
    };
  } catch {
    return null;
  }
}

/** OpenRouter CVL attempt — reuses CVL_SYSTEM + parseCvlResponse. Returns null on failure. */
async function callVerificationViaOpenRouter(
  prompt: string,
  model: string,
  apiKey: string
): Promise<CvlResult | null> {
  const raw = await callOpenRouterJson(CVL_SYSTEM, prompt, model, apiKey, 0);
  if (!raw) return null;
  const parsed = parseCvlResponse(raw);
  if (!parsed) return null;
  return { ...parsed, stamp: new Date().toISOString(), model };
}

/** callVerification — adversarial Claude Opus review of a proposed pick.
 *  Tier 0: local Claude Code CLI, pinned to Opus (advisory, tried first whenever
 *  isLocalRuntime()). Fallback: GLM-5.2 → GLM-5.1 → GPT-oss-120B via OpenRouter
 *  before returning SKIPPED. */
export async function callVerification(prompt: string, ctx: LLMCallContext): Promise<CvlResult> {
  // Tier 0: local Claude Code CLI — never throws; null (incl. unparseable
  // output) falls through unchanged to Tier 1, never defaults to APPROVED.
  if (isLocalRuntime()) {
    const raw = await callClaudeCode(`${CVL_SYSTEM}\n\n${prompt}`);
    const parsed = raw ? parseCvlResponse(raw) : null;
    if (parsed) {
      return { ...parsed, stamp: new Date().toISOString(), model: "claude-code-local" };
    }
  }

  // Tier 1: Claude Sonnet (when key present)
  if (ctx.config.claudeApiKey) {
    try {
      const client = new Anthropic({ apiKey: ctx.config.claudeApiKey });
      const resp = await client.messages.create(
        {
          model: MODELS.CLAUDE_OPUS,
          max_tokens: 1024,
          temperature: 0,
          system: CVL_SYSTEM,
          messages: [{ role: "user", content: prompt }],
        },
        { timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 }
      );
      const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
      const parsed = parseCvlResponse(text);
      if (parsed) {
        return { ...parsed, stamp: new Date().toISOString(), model: MODELS.CLAUDE_OPUS };
      }
      // Unparseable Opus output — fall through to OpenRouter tiers rather
      // than returning a spread of null.
    } catch {
      // Fall through to OpenRouter tiers
    }
  }

  // Tier 2/3: OpenRouter — GLM-5.2 → GLM-5.1 → DeepSeek → Kimi-K2 → GPT → Qwen3 → Minimax-M3
  // then free safety net (GPT-OSS-120B)
  if (ctx.config.openrouterApiKey) {
    for (const model of [
      OPENROUTER_MODELS.GLM_5_2,
      OPENROUTER_MODELS.GLM_5_1,
      OPENROUTER_MODELS.DEEPSEEK_R1,
      OPENROUTER_MODELS.KIMI_K2,
      OPENROUTER_MODELS.GPT_4O,
      OPENROUTER_MODELS.QWEN3_235B_THINKING,
      OPENROUTER_MODELS.MINIMAX_M3,
      OPENROUTER_MODELS.GPT_OSS_120B,
    ]) {
      const result = await callVerificationViaOpenRouter(
        prompt,
        model,
        ctx.config.openrouterApiKey
      );
      if (result) return result;
    }
  }

  return {
    status: "SKIPPED",
    stamp: new Date().toISOString(),
    rationale: "CVL error — all tiers failed",
    model: "none",
  };
}
