/** B1 — Briefing layer.
 *  Spec: ORACLE_v2026_8_0.jsx lines 5140–5210.
 *  Tier 0: local Claude Code CLI (advisory — tried first whenever isLocalRuntime()).
 *  Tier 1: Claude Opus (temperature=0). Fallback: Gemini temperature ensemble (T=[0.4,0.8,1.2]).
 *  Emits DIVERGENT_TEMPERATURE_ENSEMBLE when no majority market in ensemble.
 *  Emits FRAMING_BIAS_DETECTED when neutral-persona Kelly diverges >15%. */
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { callClaudeCode, isLocalRuntime } from "./callClaudeCode.js";
import { callOpenRouterJson } from "./callOpenRouter.js";
import { MODELS, OPENROUTER_MODELS } from "./cascade.js";
import type { LLMCallContext } from "./types.js";

const BRIEFING_OR_SYSTEM =
  "You are ORACLE's pre-match briefing analyst. Analyse the provided fixture context and return your assessment as valid JSON.";

/** Per-call timeout. The Anthropic/Gemini SDKs' own defaults let a hung connection
 *  stall a fixture indefinitely — bound it so briefing falls through to the next
 *  tier quickly instead of hanging. */
const REQUEST_TIMEOUT_MS = 20_000;

export interface BriefingResult {
  text: string;
  model: string;
  flags: string[];
}

const TEMPERATURES = [0.4, 0.8, 1.2] as const;

function majority(picks: string[]): string | null {
  const counts: Record<string, number> = {};
  for (const p of picks) counts[p] = (counts[p] ?? 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!top[0]) return null;
  return top[0][1] >= 2 ? top[0][0] : null;
}

/** Extract primary market from briefing text (looks for first JSON "primaryPick" key). */
function extractMarket(text: string): string {
  const m = text.match(/"primaryPick"\s*:\s*"([^"]+)"/);
  return m?.[1] ?? text.slice(0, 60);
}

/** Call Gemini briefing ensemble at three temperatures.
 *  Returns text of majority pick; sets DIVERGENT_TEMPERATURE_ENSEMBLE flag if no majority. */
async function geminiEnsembleBriefing(
  prompt: string,
  ctx: LLMCallContext,
  flags: string[]
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: ctx.config.geminiApiKey });
  const results = await Promise.allSettled(
    TEMPERATURES.map((temp) =>
      ai.models.generateContent({
        model: MODELS.GEMINI_FLASH,
        contents: prompt,
        config: {
          temperature: temp,
          thinkingConfig: { thinkingBudget: 0 },
          abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      })
    )
  );

  const texts: string[] = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<{ text?: string }>).value.text ?? "")
    .filter(Boolean);

  if (!texts.length) throw new Error("Gemini briefing ensemble: all calls failed");

  const markets = texts.map(extractMarket);
  const maj = majority(markets);
  if (!maj) flags.push("DIVERGENT_TEMPERATURE_ENSEMBLE");

  // Use the text that produced the majority market, or first if divergent
  const idx = maj ? markets.indexOf(maj) : 0;
  return texts[idx] ?? texts[0]!;
}

/** Neutral-persona divergence check: re-run Claude with neutral framing.
 *  If Kelly fraction diverges >15%, push FRAMING_BIAS_DETECTED. */
async function checkFramingBias(
  primaryText: string,
  prompt: string,
  ctx: LLMCallContext,
  flags: string[]
): Promise<void> {
  try {
    const client = new Anthropic({ apiKey: ctx.config.claudeApiKey });
    const neutralPrompt = `You are a neutral analyst with no prior position. ${prompt}`;
    const resp = await client.messages.create(
      {
        model: MODELS.CLAUDE_OPUS,
        max_tokens: 1024,
        temperature: 0,
        messages: [{ role: "user", content: neutralPrompt }],
      },
      { timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 }
    );
    const neutralText = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    const kellyMatch = primaryText.match(/"stake"\s*:\s*([\d.]+)/);
    const neutralMatch = neutralText.match(/"stake"\s*:\s*([\d.]+)/);
    if (kellyMatch && neutralMatch) {
      const diff = Math.abs(parseFloat(kellyMatch[1]!) - parseFloat(neutralMatch[1]!));
      if (diff > 0.15) flags.push("FRAMING_BIAS_DETECTED");
    }
  } catch {
    // Non-fatal — framing bias check is advisory
  }
}

/** callBriefing — primary entry point for B1 layer. */
export async function callBriefing(prompt: string, ctx: LLMCallContext): Promise<BriefingResult> {
  const flags: string[] = [];

  // Tier 0: local Claude Code CLI — advisory, tried whenever the binary is
  // available. Never throws; null falls through to Claude Opus unchanged.
  // Skips the framing-bias check: that check re-runs the SAME model with a
  // neutral persona to compare Kelly fractions, which is meaningless across
  // two different models (local CLI vs the Claude API).
  if (isLocalRuntime()) {
    const localText = await callClaudeCode(prompt);
    if (localText) {
      return { text: localText, model: "claude-code-local", flags };
    }
  }

  // Primary: Claude Opus via HTTP API (only when a key is configured — local CLI is preferred)
  if (ctx.config.claudeApiKey) {
    try {
      const client = new Anthropic({ apiKey: ctx.config.claudeApiKey });
      const resp = await client.messages.create(
        {
          model: MODELS.CLAUDE_OPUS,
          max_tokens: 4096,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        },
        { timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 }
      );
      const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
      if (text) {
        await checkFramingBias(text, prompt, ctx, flags);
        return { text, model: MODELS.CLAUDE_OPUS, flags };
      }
    } catch {
      // Fall through to Gemini ensemble
    }
  }

  // Fallback: Gemini temperature ensemble
  if (ctx.config.geminiApiKey) {
    try {
      const text = await geminiEnsembleBriefing(prompt, ctx, flags);
      return { text, model: MODELS.GEMINI_FLASH, flags };
    } catch {
      // Fall through to OpenRouter tiers
    }
  }

  // Tier 2/3: OpenRouter — GLM-5.2 → GLM-5.1 → DeepSeek → Kimi-2.7 → GPT → Qwen3 → Minimax-M3
  // then free-tier safety net (GPT-OSS-120B → Nemotron → Qwen3-Next 80B → etc.)
  if (ctx.config.openrouterApiKey) {
    for (const model of [
      OPENROUTER_MODELS.GLM_5_2,
      OPENROUTER_MODELS.GLM_5_1,
      OPENROUTER_MODELS.DEEPSEEK_R1,
      OPENROUTER_MODELS.KIMI_K2_7,
      OPENROUTER_MODELS.GPT_4O,
      OPENROUTER_MODELS.QWEN3_235B_THINKING,
      OPENROUTER_MODELS.MINIMAX_M3,
      OPENROUTER_MODELS.GPT_OSS_120B,
      OPENROUTER_MODELS.NEMOTRON_SUPER_120B,
      OPENROUTER_MODELS.QWEN3_NEXT_80B,
    ]) {
      const text = await callOpenRouterJson(
        BRIEFING_OR_SYSTEM,
        prompt,
        model,
        ctx.config.openrouterApiKey,
        0
      );
      if (text) return { text, model, flags };
    }
  }

  throw new Error("callBriefing: no LLM available");
}
