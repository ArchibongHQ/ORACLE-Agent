/** callOpenRouter / callOpenRouterJson — OpenRouter transport. Pins the "never throws,
 *  returns null on any failure" contract. All network calls stubbed via global fetch. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callOpenRouter, callOpenRouterJson } from "../src/callOpenRouter.js";
import { OPENROUTER_BASE_URL, OPENROUTER_MODELS } from "../src/cascade.js";
import { chatResponse } from "./helpers.js";

const fetchMock = vi.fn();

function lastBody(): Record<string, unknown> {
  const [, opts] = fetchMock.mock.calls.at(-1) as [string, { body: string }];
  return JSON.parse(opts.body) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callOpenRouter", () => {
  const messages = [{ role: "user" as const, content: "hi" }];

  it("returns the assistant text on success", async () => {
    fetchMock.mockResolvedValue(chatResponse("hello"));
    expect(await callOpenRouter(messages, OPENROUTER_MODELS.GLM_5_1, "key")).toBe("hello");
  });

  it("POSTs to chat/completions with bearer auth and the requested model", async () => {
    fetchMock.mockResolvedValue(chatResponse("x"));
    await callOpenRouter(messages, OPENROUTER_MODELS.QWEN3_235B_THINKING, "sk-or");
    const [url, opts] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect(opts.headers.Authorization).toBe("Bearer sk-or");
    expect(lastBody().model).toBe(OPENROUTER_MODELS.QWEN3_235B_THINKING);
  });

  it("defaults temperature 0 / max_tokens 2048 and omits response_format", async () => {
    fetchMock.mockResolvedValue(chatResponse("x"));
    await callOpenRouter(messages, OPENROUTER_MODELS.GLM_5_1, "key");
    const body = lastBody();
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(2048);
    expect(body).not.toHaveProperty("response_format");
  });

  it("sets response_format json_object only when jsonMode is true", async () => {
    fetchMock.mockResolvedValue(chatResponse("{}"));
    await callOpenRouter(messages, OPENROUTER_MODELS.GLM_5_1, "key", { jsonMode: true });
    expect(lastBody().response_format).toEqual({ type: "json_object" });
  });

  it("strips markdown code fences from the response", async () => {
    fetchMock.mockResolvedValue(chatResponse('```json\n{"a":1}\n```'));
    expect(await callOpenRouter(messages, OPENROUTER_MODELS.GLM_5_1, "key")).toBe('{"a":1}');
  });

  it("returns null without calling fetch when the key is empty", async () => {
    expect(await callOpenRouter(messages, OPENROUTER_MODELS.GLM_5_1, "")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on non-ok HTTP status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    expect(await callOpenRouter(messages, OPENROUTER_MODELS.GLM_5_1, "key")).toBeNull();
  });

  it("returns null when choices/message/content is missing", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    expect(await callOpenRouter(messages, OPENROUTER_MODELS.GLM_5_1, "key")).toBeNull();
  });

  it("returns null when fetch rejects — never throws", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    await expect(callOpenRouter(messages, OPENROUTER_MODELS.GLM_5_1, "key")).resolves.toBeNull();
  });

  it("returns null when the response body is not JSON — never throws", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("bad json");
      },
    });
    await expect(callOpenRouter(messages, OPENROUTER_MODELS.GLM_5_1, "key")).resolves.toBeNull();
  });
});

describe("callOpenRouterJson", () => {
  it("builds system+user messages and forces jsonMode", async () => {
    fetchMock.mockResolvedValue(chatResponse('{"ok":true}'));
    const out = await callOpenRouterJson("SYS", "USER", OPENROUTER_MODELS.GPT_OSS_120B, "key");
    expect(out).toBe('{"ok":true}');
    const body = lastBody();
    expect(body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USER" },
    ]);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("returns null instead of throwing when the transport fails", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(
      callOpenRouterJson("SYS", "USER", OPENROUTER_MODELS.GPT_OSS_120B, "key")
    ).resolves.toBeNull();
  });

  it("returns null when the key is empty", async () => {
    expect(await callOpenRouterJson("SYS", "USER", OPENROUTER_MODELS.GPT_OSS_120B, "")).toBeNull();
  });
});
