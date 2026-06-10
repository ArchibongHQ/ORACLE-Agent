/** Generic OpenAI-compatible transport for OpenRouter (Tier 2/3 fallbacks).
 *  Modeled on callKimi.ts — never throws, returns null on any failure so callers
 *  degrade gracefully. All decision/CVL/briefing callers pass temperature=0 and
 *  jsonMode=true; acquisition passes free-text (no jsonMode).
 *
 *  Uses response_format: { type: "json_object" } only — never json_schema, which
 *  silently drops reasoning tokens on R1 and other reasoning models. */

import { OPENROUTER_BASE_URL } from "./cascade.js";

const ENDPOINT = `${OPENROUTER_BASE_URL}/chat/completions`;

export type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** Low-level call. Returns the assistant message text, or null on any failure. */
export async function callOpenRouter(
  messages: OpenRouterMessage[],
  model: string,
  apiKey: string,
  opts?: { temperature?: number; maxTokens?: number; jsonMode?: boolean }
): Promise<string | null> {
  if (!apiKey) return null;

  try {
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts?.temperature ?? 0,
      max_tokens: opts?.maxTokens ?? 2048,
    };
    if (opts?.jsonMode === true) {
      body.response_format = { type: "json_object" };
    }

    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return null;

    return text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
  } catch {
    return null;
  }
}

/** Convenience helper for JSON-output layers — builds the system+user message pair
 *  and forces jsonMode. Returns the cleaned response text or null. */
export async function callOpenRouterJson(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  apiKey: string,
  temperature = 0
): Promise<string | null> {
  return callOpenRouter(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    model,
    apiKey,
    { temperature, jsonMode: true }
  );
}
