/** B5 — Postmortem synthesis.
 *  Spec: ORACLE_v2026_8_0.jsx (B5 section).
 *  After resolved losses, uses Gemini Flash-Lite to synthesize a rule from the failure pattern.
 *  The synthesized rule is stored as synthesizedRule on the entry (optional field).
 *  Batched: processes an array of loss entries, returns updated entries with synthesizedRule set.
 *  Called in apps/worker resolution path. */
import { GoogleGenAI } from "@google/genai";
import { MODELS } from "./cascade.js";
import type { LLMCallContext } from "./types.js";

export interface PostmortemLossInput {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  marketPicked: string;
  rootCause: string;
  signalsThatFired: string[];
  signalsThatShouldHaveFired: string[];
}

export interface PostmortemSynthesisResult extends PostmortemLossInput {
  synthesizedRule: string;
}

function buildSynthesisPrompt(entry: PostmortemLossInput): string {
  return `You are ORACLE's postmortem analyst. Given this betting loss, synthesize ONE concise rule (max 30 words) to avoid this failure in future.
Return ONLY the rule as plain text — no JSON, no preamble.

Fixture: ${entry.homeTeam} vs ${entry.awayTeam}
Market: ${entry.marketPicked}
Root cause: ${entry.rootCause}
Signals fired: ${entry.signalsThatFired.join(", ") || "none"}
Signals missed: ${entry.signalsThatShouldHaveFired.join(", ") || "none"}`;
}

/** synthesizePostmortems — batch process resolved losses, return entries with synthesizedRule.
 *  Entries that fail synthesis get synthesizedRule = '' (empty). */
export async function synthesizePostmortems(
  losses: PostmortemLossInput[],
  ctx: LLMCallContext
): Promise<PostmortemSynthesisResult[]> {
  if (!ctx.config.geminiApiKey || !losses.length) {
    return losses.map((l) => ({ ...l, synthesizedRule: "" }));
  }

  const ai = new GoogleGenAI({ apiKey: ctx.config.geminiApiKey });

  const settled = await Promise.allSettled(
    losses.map((entry) =>
      ai.models.generateContent({
        model: MODELS.GEMINI_FLASH_LITE,
        contents: buildSynthesisPrompt(entry),
        config: { thinkingConfig: { thinkingBudget: 0 } },
      })
    )
  );

  return losses.map((entry, i) => {
    const result = settled[i];
    const rule =
      result?.status === "fulfilled" ? (result.value.text ?? "").trim().slice(0, 200) : "";
    return { ...entry, synthesizedRule: rule };
  });
}
