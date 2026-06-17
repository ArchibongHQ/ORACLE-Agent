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
    } catch (err) {
      errors.push(`${modelId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Tier 2/3: OpenRouter — working free models first (GPT-OSS-120B → Nemotron
  // Super 120B → Qwen3-Next 80B), free text, no jsonMode. Retired :free slugs
  // (GLM-4.5-Air, DeepSeek-V4-Flash) removed — they 404 on OpenRouter now.
  const orKey = ctx.config.openrouterApiKey;
  if (orKey) {
    for (const model of [
      OPENROUTER_MODELS.GPT_OSS_120B,
      OPENROUTER_MODELS.NEMOTRON_SUPER_120B,
      OPENROUTER_MODELS.QWEN3_NEXT_80B,
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
    } catch (err) {
      errors.push(`${modelId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`Gemini decision cascade exhausted. Errors: ${errors.join(" | ")}`);
}

export { MODELS, THINKING_LEVELS };
