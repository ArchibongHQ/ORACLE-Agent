import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "./cascade.js";
import type { LLMCallContext } from "./types.js";

/** Per-call timeout + retry cap. The SDK's own default (no explicit timeout,
 *  maxRetries=2) lets a hung connection stall a fixture indefinitely and
 *  retries multiply that wait — bound both so a failure here falls through
 *  to the next cascade tier (Gemini/OpenRouter) quickly instead of hanging. */
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 1;

/** Call Claude for a structured JSON decision (temperature=0, model pinned — PRD §6 v1.2). */
export async function callClaude(
  prompt: string,
  ctx: LLMCallContext,
  opts: { model?: string; maxTokens?: number } = {}
): Promise<string> {
  const client = new Anthropic({ apiKey: ctx.config.claudeApiKey });
  const model = opts.model ?? MODELS.CLAUDE_OPUS;
  const response = await client.messages.create(
    {
      model,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: 0, // mandatory for auditability (PRD §6 v1.2)
      messages: [{ role: "user", content: prompt }],
    },
    { timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES }
  );
  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response block type from Claude");
  return block.text;
}
