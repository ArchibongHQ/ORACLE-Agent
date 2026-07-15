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

/** Redact substrings shaped like secrets (bearer tokens, API keys, JWTs) before
 *  logging — Claude/Gemini SDK error text is not under this codebase's
 *  control and could echo back an Authorization header or key fragment.
 *  Mirrors callClaudeCode.ts's _redact (kept file-local — that helper is
 *  private to its own module). */
function _redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]{10,}/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]");
}

/** Prepare a diagnostic string for a log line: redact secret-shaped substrings,
 *  strip control/line-break characters, then truncate. Mirrors
 *  callClaudeCode.ts's _sanitizeForLog. */
function _sanitizeForLog(s: string, max = 300): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping C0 control chars from untrusted upstream output before logging
  const stripped = _redact(s.trim()).replace(/[\x00-\x1f\x7f\u2028\u2029\u0085]+/g, " ");
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
}

/** Log one diagnostic line for a callBriefing failure branch, then return
 *  null — same convention as callClaudeCode.ts's _fail. Call sites that are
 *  mid-catch (not returning) use this as a side-effecting statement instead. */
function _fail(reason: string): null {
  process.stderr.write(`[callBriefing] ${reason}\n`);
  return null;
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

  results.forEach((r, i) => {
    if (r.status === "rejected") {
      _fail(
        `temperature ensemble T=${TEMPERATURES[i]}: ${_sanitizeForLog(r.reason instanceof Error ? r.reason.message : String(r.reason))}`
      );
    }
  });

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
  } catch (err) {
    _fail(
      `framing-bias check: ${_sanitizeForLog(err instanceof Error ? err.message : String(err))}`
    );
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
    _fail("tier 0 local CLI produced no text");
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
      _fail("Claude Opus tier: empty response text");
    } catch (err) {
      _fail(
        `Claude Opus tier: ${_sanitizeForLog(err instanceof Error ? err.message : String(err))}`
      );
      // Fall through to Gemini ensemble
    }
  }

  // Fallback: Gemini temperature ensemble
  if (ctx.config.geminiApiKey) {
    try {
      const text = await geminiEnsembleBriefing(prompt, ctx, flags);
      return { text, model: MODELS.GEMINI_FLASH, flags };
    } catch (err) {
      _fail(
        `Gemini ensemble tier: ${_sanitizeForLog(err instanceof Error ? err.message : String(err))}`
      );
      // Fall through to OpenRouter tiers
    }
  }

  // Tier 2/3: OpenRouter, FREE MODELS ONLY (2026-07-10 policy: briefing is an
  // optional extra layer, not the gated decision path, so it never justifies
  // paid-tier spend — contrast with decision/index.ts's rungs 1-2, which are
  // local-CLI/Gemini and don't touch OpenRouter at all until here).
  // GLM-5.2 → DeepSeek-V4-Pro → DeepSeek-V4-Flash → Gemma 4, each tried at its
  // own :free slug first then its verified free reasoning substitute (GLM-5.2
  // and DeepSeek have no confirmed live :free endpoint as of 2026-07-10 — see
  // cascade.ts's OPENROUTER_MODELS header comment for sources), then the
  // pre-existing free tail as deeper fallbacks: GPT-OSS-120B → Nemotron-Super
  // → Qwen3-Next-80B → GPT-OSS-20B.
  if (ctx.config.openrouterApiKey) {
    for (const model of [
      OPENROUTER_MODELS.GLM_5_2_FREE,
      OPENROUTER_MODELS.GLM_4_5_AIR_FREE,
      OPENROUTER_MODELS.DEEPSEEK_V4_PRO_FREE,
      OPENROUTER_MODELS.NEMOTRON_3_ULTRA_FREE,
      OPENROUTER_MODELS.DEEPSEEK_V4_FLASH_FREE,
      OPENROUTER_MODELS.NEMOTRON_NANO_OMNI_REASONING_FREE,
      OPENROUTER_MODELS.GEMMA_4_26B_MOE_FREE,
      OPENROUTER_MODELS.GEMMA_4_31B_FREE,
      OPENROUTER_MODELS.GPT_OSS_120B,
      OPENROUTER_MODELS.NEMOTRON_SUPER_120B,
      OPENROUTER_MODELS.QWEN3_NEXT_80B,
      OPENROUTER_MODELS.GPT_OSS_20B,
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
