/** B6 — LLM regime hint (advisory).
 *  Spec: ORACLE_v2026_8_0.jsx (B6 section).
 *  Advisory Gemini Flash label from T2/T3 soft-context.
 *  Does NOT override the deterministic regime used for math — advisory only.
 *  Returns a RegimeHint that the engine may log but never feed back into probability math. */
import { GoogleGenAI } from "@google/genai";
import { callOpenRouterJson } from "./callOpenRouter.js";
import { MODELS, OPENROUTER_MODELS } from "./cascade.js";
import type { LLMCallContext } from "./types.js";

export type RegimeHintLabel =
  | "HIGH_SCORING"
  | "LOW_SCORING"
  | "VOLATILE"
  | "DEFENSIVE"
  | "STANDARD"
  | "UNKNOWN";

export interface RegimeHint {
  label: RegimeHintLabel;
  rationale: string;
  confidence: number; // 0–1
  model: string;
  advisory: true; // always true — reminds callers this must not feed back into math
}

const REGIME_SYSTEM = `You are an advisory football regime classifier.
Based on the soft-context evidence provided, return ONLY valid JSON:
{"label":"HIGH_SCORING"|"LOW_SCORING"|"VOLATILE"|"DEFENSIVE"|"STANDARD","rationale":"...","confidence":0.0}
confidence: 0=pure guess, 1=strong evidence. This is advisory — it does NOT change probability math.`;

function parseHintResponse(text: string): {
  label: RegimeHintLabel;
  rationale: string;
  confidence: number;
} {
  const valid: RegimeHintLabel[] = [
    "HIGH_SCORING",
    "LOW_SCORING",
    "VOLATILE",
    "DEFENSIVE",
    "STANDARD",
  ];
  try {
    const cleaned = text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("no JSON");
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const label: RegimeHintLabel = valid.includes(String(obj.label) as RegimeHintLabel)
      ? (String(obj.label) as RegimeHintLabel)
      : "UNKNOWN";
    return {
      label,
      rationale: String(obj.rationale ?? ""),
      confidence: Math.max(0, Math.min(1, Number(obj.confidence ?? 0.5))),
    };
  } catch {
    return { label: "UNKNOWN", rationale: text.slice(0, 200), confidence: 0 };
  }
}

/** callRegimeHint — advisory regime label from soft-context. Returns UNKNOWN + advisory:true on any error. */
export async function callRegimeHint(
  softContextSummary: string,
  ctx: LLMCallContext
): Promise<RegimeHint> {
  const fallback: RegimeHint = {
    label: "UNKNOWN",
    rationale: "no Gemini key or call failed",
    confidence: 0,
    model: "none",
    advisory: true,
  };

  // Tier 1: Gemini Flash (when key present)
  if (ctx.config.geminiApiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey: ctx.config.geminiApiKey });
      const result = await ai.models.generateContent({
        model: MODELS.GEMINI_FLASH,
        contents: `${REGIME_SYSTEM}\n\nSoft context:\n${softContextSummary}`,
        config: { thinkingConfig: { thinkingBudget: 0 } },
      });
      const text = result.text ?? "";
      const parsed = parseHintResponse(text);
      return { ...parsed, model: MODELS.GEMINI_FLASH, advisory: true };
    } catch {
      // Fall through to OpenRouter Tier 3 (advisory only — Tier 2 is overkill here)
    }
  }

  // Tier 2/3: OpenRouter cascade — advisory only, GLM-5.2 → DeepSeek → GPT → free nets
  if (ctx.config.openrouterApiKey) {
    for (const model of [
      OPENROUTER_MODELS.GLM_5_2,
      OPENROUTER_MODELS.DEEPSEEK_R1,
      OPENROUTER_MODELS.GPT_4O,
      OPENROUTER_MODELS.GPT_OSS_120B,
      OPENROUTER_MODELS.NEMOTRON_SUPER_120B,
    ]) {
      try {
        const raw = await callOpenRouterJson(
          REGIME_SYSTEM,
          softContextSummary,
          model,
          ctx.config.openrouterApiKey,
          0
        );
        if (raw) {
          const parsed = parseHintResponse(raw);
          return { ...parsed, model, advisory: true };
        }
      } catch {
        // still advisory — try next model
      }
    }
  }

  return fallback;
}
