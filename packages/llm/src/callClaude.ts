import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "./cascade.js";
import type { LLMCallContext } from "./types.js";

/** Call Claude for a structured JSON decision (temperature=0, model pinned — PRD §6 v1.2). */
export async function callClaude(
  prompt: string,
  ctx: LLMCallContext,
  opts: { model?: string; maxTokens?: number } = {}
): Promise<string> {
  const client = new Anthropic({ apiKey: ctx.config.claudeApiKey });
  const model = opts.model ?? MODELS.CLAUDE_OPUS;
  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: 0, // mandatory for auditability (PRD §6 v1.2)
    messages: [{ role: "user", content: prompt }],
  });
  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response block type from Claude");
  return block.text;
}
