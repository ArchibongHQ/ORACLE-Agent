/** Shared helpers for @oracle/llm tests — ctx factory + mock inspection utilities. */
import { EventEmitter } from "node:events";
import { type Mock, vi } from "vitest";
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

/** Fake child_process for callClaudeCode tier-0 tests — mirrors claudeCode.test.ts's
 *  local fixture. Pair with `vi.mock("node:child_process", ...)` (must stay file-local;
 *  vi.mock hoisting can't cross modules) and `flushMicrotasks` below. */
export class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  pid = 4242;
}

/** _spawnWithStdin (callClaudeCode.ts) wires up listeners inside a dynamic
 *  import()'s .then() — emitting on a FakeChild synchronously right after the
 *  call races that microtask. Await this first so listeners are attached. */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A `claude -p --output-format json` success/error envelope, as a stdout Buffer. */
export function claudeCodeEnvelope(body: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(body), "utf8");
}
