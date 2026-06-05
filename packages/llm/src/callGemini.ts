import { GoogleGenAI } from '@google/genai';
import type { LLMCallContext } from './types.js';
import { MODELS, THINKING_LEVELS, ACQUISITION_CASCADE, DECISION_CASCADE } from './cascade.js';

/** fetchGeminiWithCascade — lifted from ORACLE_v2026_8_0.jsx §2.
 *  Tries each model in the acquisition cascade; returns first successful text. */
export async function fetchGeminiWithCascade(
  prompt: string,
  ctx: LLMCallContext,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: ctx.config.geminiApiKey });
  const errors: string[] = [];

  for (const modelId of ACQUISITION_CASCADE) {
    try {
      const result = await ai.models.generateContent({
        model: modelId,
        contents: prompt,
        config: { thinkingConfig: { thinkingBudget: 0 } },
      });
      const text = result.text;
      if (text) return text;
    } catch (err) {
      errors.push(`${modelId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`Gemini cascade exhausted. Errors: ${errors.join(' | ')}`);
}

/** callGeminiDecision — Gemini decision layer with Pro → Flash cascade.
 *  Temperature 0 for auditability (PRD §6 v1.2). Thinking level HIGH for reasoning quality. */
export async function callGeminiDecision(
  prompt: string,
  ctx: LLMCallContext,
): Promise<string> {
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
        },
      });
      const text = result.text;
      if (text) return text;
    } catch (err) {
      errors.push(`${modelId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`Gemini decision cascade exhausted. Errors: ${errors.join(' | ')}`);
}

export { MODELS, THINKING_LEVELS };
