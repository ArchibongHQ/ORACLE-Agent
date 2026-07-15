import { GoogleGenAI } from "@google/genai";
import { callOpenRouter } from "./callOpenRouter.js";
import {
  ACQUISITION_CASCADE,
  DECISION_CASCADE,
  MODELS,
  OPENROUTER_MODELS,
  THINKING_LEVELS,
} from "./cascade.js";
import type { LLMCallContext } from "./types.js";

/** Per-call timeout. Without this, a hung model in the cascade blocks every
 *  model after it (and the entire fixture) indefinitely. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Redact substrings shaped like secrets (bearer tokens, API keys, JWTs) before
 *  logging — Google's own APIs are known to echo an invalid key's value back
 *  in error text, so any err.message reaching a log line must be scrubbed
 *  first. Mirrors callClaudeCode.ts's _redact (kept file-local — that helper
 *  is private to its own module). */
function _redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]")
    .replace(/\bAIza[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]"); // Google API-key shape
}

/** Prepare a diagnostic string for a log line: redact secret-shaped substrings,
 *  strip control/line-break characters, then truncate. Mirrors
 *  callClaudeCode.ts's _sanitizeForLog. */
function _sanitizeForLog(s: string, max = 300): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping C0 control chars from untrusted upstream output before logging
  const stripped = _redact(s.trim()).replace(/[\x00-\x1f\x7f\u2028\u2029\u0085]+/g, " ");
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
}

/** Log one diagnostic line for a callGemini failure branch. Returns nothing
 *  meaningful — call sites in this file use it as a side-effecting statement
 *  mid-loop (control flow already falls through to the next cascade tier
 *  unchanged), not as a `return` value, unlike callClaudeCode.ts's _fail. */
function _fail(reason: string): null {
  process.stderr.write(`[callGemini] ${reason}\n`);
  return null;
}

/** fetchGeminiWithCascade — lifted from ORACLE_v2026_8_0.jsx §2.
 *  Tries each model in the acquisition cascade; returns first successful text. */
export async function fetchGeminiWithCascade(prompt: string, ctx: LLMCallContext): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: ctx.config.geminiApiKey });
  const errors: string[] = [];

  for (const modelId of ACQUISITION_CASCADE) {
    try {
      const result = await ai.models.generateContent({
        model: modelId,
        contents: prompt,
        config: {
          thinkingConfig: { thinkingBudget: 0 },
          abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      });
      const text = result.text;
      if (text) return text;
      _fail(`${modelId}: empty response text`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${modelId}: ${msg}`);
      _fail(`${modelId}: ${_sanitizeForLog(msg)}`);
    }
  }

  // Tier 2/3: OpenRouter — paid-first cascade then free safety net LAST.
  // Order per owner directive 2026-07-06: DeepSeek-V4-Flash → DeepSeek-V4-Pro →
  // DeepSeek-R1 → GLM-5.2 → GLM-5.1 → Kimi-K2 → GPT-4o → Qwen3-235B-Thinking →
  // Minimax-M3 → Minimax-M2.5 → MiMo-V2.5 → Qwen3-Coder-480B → Qwen3-Coder-Next →
  // LongCat-Flash-Chat → Nemotron-3-Ultra, then free tier: GPT-OSS-120B →
  // Nemotron-Super → Qwen3-Next-80B → GPT-OSS-20B.
  const orKey = ctx.config.openrouterApiKey;
  if (orKey) {
    for (const model of [
      OPENROUTER_MODELS.DEEPSEEK_V4_FLASH,
      OPENROUTER_MODELS.DEEPSEEK_V4_PRO,
      OPENROUTER_MODELS.DEEPSEEK_R1,
      OPENROUTER_MODELS.GLM_5_2,
      OPENROUTER_MODELS.GLM_5_1,
      OPENROUTER_MODELS.KIMI_K2,
      OPENROUTER_MODELS.GPT_4O,
      OPENROUTER_MODELS.QWEN3_235B_THINKING,
      OPENROUTER_MODELS.MINIMAX_M3,
      OPENROUTER_MODELS.MINIMAX_M2_5,
      OPENROUTER_MODELS.MIMO_V2_5_PRO,
      OPENROUTER_MODELS.QWEN3_CODER_480B,
      OPENROUTER_MODELS.QWEN3_CODER_NEXT,
      OPENROUTER_MODELS.LONGCAT_FLASH_CHAT,
      OPENROUTER_MODELS.NEMOTRON_3_ULTRA,
      OPENROUTER_MODELS.GPT_OSS_120B,
      OPENROUTER_MODELS.NEMOTRON_SUPER_120B,
      OPENROUTER_MODELS.QWEN3_NEXT_80B,
      OPENROUTER_MODELS.GPT_OSS_20B,
    ]) {
      const text = await callOpenRouter([{ role: "user", content: prompt }], model, orKey, {
        temperature: 0,
        maxTokens: 4096,
      });
      if (text) return text;
    }
  }

  throw new Error(`Gemini cascade exhausted. Errors: ${errors.join(" | ")}`);
}

/** callGeminiDecision — Gemini decision layer with Pro → Flash cascade.
 *  Temperature 0 for auditability (PRD §6 v1.2). Thinking level HIGH for reasoning quality. */
export async function callGeminiDecision(prompt: string, ctx: LLMCallContext): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: ctx.config.geminiApiKey });
  const errors: string[] = [];

  for (const modelId of DECISION_CASCADE) {
    try {
      const result = await ai.models.generateContent({
        model: modelId,
        contents: prompt,
        config: {
          temperature: 0,
          thinkingConfig: { thinkingBudget: 8192 },
          abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      });
      const text = result.text;
      if (text) return text;
      _fail(`${modelId}: empty response text`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${modelId}: ${msg}`);
      _fail(`${modelId}: ${_sanitizeForLog(msg)}`);
    }
  }

  throw new Error(`Gemini decision cascade exhausted. Errors: ${errors.join(" | ")}`);
}

export { MODELS, THINKING_LEVELS };
