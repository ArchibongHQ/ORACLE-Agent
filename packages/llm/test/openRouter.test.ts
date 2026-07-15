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

describe("callOpenRouter diagnostic logging", () => {
  const messages = [{ role: "user" as const, content: "hi" }];

  it("logs the HTTP status on non-ok status", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    await callOpenRouter(messages, OPENROUTER_MODELS.GLM_5_1, "key");
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[callOpenRouter] HTTP 429"));
    writeSpy.mockRestore();
  });

  it("logs empty response text when choices/message/content is missing", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await callOpenRouter(messages, OPENROUTER_MODELS.GLM_5_1, "key");
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("[callOpenRouter] empty response text")
    );
    writeSpy.mockRestore();
  });

  it("logs the sanitized error message when fetch rejects", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    await callOpenRouter(messages, OPENROUTER_MODELS.GLM_5_1, "key");
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("[callOpenRouter] request failed")
    );
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("ECONNRESET"));
    writeSpy.mockRestore();
  });

  it("redacts a bearer-token-shaped substring from a logged error message", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fetchMock.mockRejectedValue(new Error("auth failed: Bearer sk-abcdefghijklmnop123456"));
    await callOpenRouter(messages, OPENROUTER_MODELS.GLM_5_1, "key");
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain("sk-abcdefghijklmnop123456");
    expect(logged).toContain("[REDACTED]");
    writeSpy.mockRestore();
  });

  it("redacts a hyphenated provider-key shape (e.g. sk-or-v1-..., sk-ant-...) from a logged error message", async () => {
    // Regression: the redaction regex used to require [A-Za-z0-9]{10,} right
    // after "sk-" with no hyphens allowed, so real hyphenated key shapes
    // (OpenRouter's sk-or-v1-..., Anthropic's sk-ant-api03-...) slipped through
    // un-redacted whenever an upstream error echoed one back.
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fetchMock.mockRejectedValue(
      new Error("invalid key: sk-or-v1-abcdefghijklmnopqrstuvwxyz123456")
    );
    await callOpenRouter(messages, OPENROUTER_MODELS.GLM_5_1, "key");
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain("sk-or-v1-abcdefghijklmnopqrstuvwxyz123456");
    expect(logged).toContain("[REDACTED]");
    writeSpy.mockRestore();
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
