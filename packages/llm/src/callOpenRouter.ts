/** Generic OpenAI-compatible transport for OpenRouter (Tier 2/3 fallbacks).
 *  Modeled on callKimi.ts — never throws, returns null on any failure so callers
 *  degrade gracefully. All decision/CVL/briefing callers pass temperature=0 and
 *  jsonMode=true; acquisition passes free-text (no jsonMode).
 *
 *  Uses response_format: { type: "json_object" } only — never json_schema, which
 *  silently drops reasoning tokens on R1 and other reasoning models. */

import { OPENROUTER_BASE_URL } from "./cascade.js";

const ENDPOINT = `${OPENROUTER_BASE_URL}/chat/completions`;

/** Per-call timeout. Without this, a hung upstream model blocks the entire
 *  decision cascade indefinitely — native fetch has no default timeout. */
const REQUEST_TIMEOUT_MS = 20_000;

export type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** Redact substrings shaped like secrets (bearer tokens, API keys, JWTs) before
 *  logging — an OpenRouter error response/exception is not under this
 *  codebase's control and could echo back an Authorization header or key
 *  fragment (auth-failure responses on some providers do this). Mirrors
 *  callClaudeCode.ts's _redact (kept file-local — that helper is private to
 *  its own module). */
function _redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
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

/** Log one diagnostic line for a callOpenRouter failure branch, then return
 *  null — every failure path funnels through here, same convention as
 *  callClaudeCode.ts's _fail. */
function _fail(reason: string): null {
  process.stderr.write(`[callOpenRouter] ${reason}\n`);
  return null;
}

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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) return _fail(`HTTP ${resp.status} (model=${model})`);

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return _fail(`empty response text (model=${model})`);

    return text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
  } catch (err) {
    return _fail(
      `request failed (model=${model}): ${_sanitizeForLog(err instanceof Error ? err.message : String(err))}`
    );
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
