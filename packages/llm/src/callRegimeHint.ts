/** B6 — LLM regime hint (advisory).
 *  Spec: ORACLE_v2026_8_0.jsx (B6 section).
 *  Advisory Gemini Flash label from T2/T3 soft-context.
 *  Does NOT override the deterministic regime used for math — advisory only.
 *  Returns a RegimeHint that the engine may log but never feed back into probability math. */
import { GoogleGenAI } from "@google/genai";
import { MODELS } from "./cascade.js";
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

  if (!ctx.config.geminiApiKey) return fallback;

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
    return fallback;
  }
}
