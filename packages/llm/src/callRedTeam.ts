/** B3 — Red-team critique layer.
 *  Spec: ORACLE_v2026_8_0.jsx lines 5305–5328.
 *  Gemini Pro → Flash cascade with thinking_level HIGH.
 *  Returns JSON: { critique, weaknesses, alternativePick?, confidenceScore }.
 *  CLI subcommand only — NOT auto-run in batch. */
import { GoogleGenAI } from '@google/genai';
import type { LLMCallContext } from './types.js';
import { MODELS, DECISION_CASCADE } from './cascade.js';

export interface RedTeamResult {
  critique: string;
  weaknesses: string[];
  alternativePick?: string;
  confidenceScore: number;   // 0–1 estimate of pick surviving scrutiny
  model: string;
}

const RED_TEAM_SYSTEM = `You are a critical adversarial analyst tasked with stress-testing a betting pick.
Find every weakness: statistical, situational, and contrarian.
Return ONLY valid JSON:
{"critique":"...","weaknesses":["..."],"alternativePick":"optional better pick or null","confidenceScore":0.0}
confidenceScore: 0=pick is terrible, 1=pick survives all scrutiny.`;

function parseRedTeamResponse(text: string): Omit<RedTeamResult, 'model'> {
  try {
    const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON');
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    return {
      critique: String(obj['critique'] ?? ''),
      weaknesses: Array.isArray(obj['weaknesses']) ? (obj['weaknesses'] as unknown[]).map(String) : [],
      alternativePick: obj['alternativePick'] && obj['alternativePick'] !== 'null'
        ? String(obj['alternativePick'])
        : undefined,
      confidenceScore: Math.max(0, Math.min(1, Number(obj['confidenceScore'] ?? 0.5))),
    };
  } catch {
    return { critique: text.slice(0, 500), weaknesses: [], confidenceScore: 0.5 };
  }
}

/** callRedTeam — adversarial critique. CLI-only; not wired into batch auto-run. */
export async function callRedTeam(
  prompt: string,
  ctx: LLMCallContext,
): Promise<RedTeamResult> {
  const ai = new GoogleGenAI({ apiKey: ctx.config.geminiApiKey });
  const errors: string[] = [];

  for (const modelId of DECISION_CASCADE) {
    try {
      const result = await ai.models.generateContent({
        model: modelId,
        contents: `${RED_TEAM_SYSTEM}\n\n${prompt}`,
        config: {
          temperature: 0.3,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 16384 },
        },
      });
      const text = result.text ?? '';
      if (text) {
        return { ...parseRedTeamResponse(text), model: modelId };
      }
    } catch (err) {
      errors.push(`${modelId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`callRedTeam cascade exhausted. Errors: ${errors.join(' | ')}`);
}
