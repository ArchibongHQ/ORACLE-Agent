/** Shared helpers for @oracle/llm tests — ctx factory + mock inspection utilities. */
import type { Mock } from "vitest";
import type { LLMCallContext, LLMKeyConfig } from "../src/types.js";

export function makeCtx(config: Partial<LLMKeyConfig> = {}): LLMCallContext {
  return {
    config: { claudeApiKey: "", geminiApiKey: "", bankroll: 1000, ...config },
    requestedAt: "2026-06-10T00:00:00Z",
  };
}

/** An OpenAI-compatible chat/completions success response for a stubbed fetch. */
export function chatResponse(content: string) {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
}

/** `model` field of each fetch-mock POST body, in call order. */
export function postedModels(fetchMock: Mock): string[] {
  return fetchMock.mock.calls.map((c) => {
    const [, opts] = c as [string, { body: string }];
    return (JSON.parse(opts.body) as { model: string }).model;
  });
}

/** `model` field of each genai generateContent request, in call order. */
export function calledModels(mock: Mock): string[] {
  return mock.mock.calls.map((c) => (c[0] as { model: string }).model);
}
