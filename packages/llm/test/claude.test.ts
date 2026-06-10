/** callClaude — Anthropic SDK boundary mocked. Pins: returns the text block, throws on a
 *  non-text block, and propagates SDK errors (no internal fallback tier in this function). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callClaude } from "../src/callClaude.js";
import { MODELS } from "../src/cascade.js";
import { makeCtx } from "./helpers.js";

const { messagesCreateMock } = vi.hoisted(() => ({ messagesCreateMock: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: messagesCreateMock };
  },
}));

const ctx = makeCtx({ claudeApiKey: "ck" });

beforeEach(() => {
  messagesCreateMock.mockReset();
});

describe("callClaude", () => {
  it("returns the text block on success", async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: "text", text: "answer" }] });
    expect(await callClaude("p", ctx)).toBe("answer");
  });

  it("pins model CLAUDE_OPUS and temperature 0 by default", async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: "text", text: "x" }] });
    await callClaude("p", ctx);
    const req = messagesCreateMock.mock.calls[0]?.[0] as { model: string; temperature: number };
    expect(req.model).toBe(MODELS.CLAUDE_OPUS);
    expect(req.temperature).toBe(0);
  });

  it("honours an explicit model override", async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: "text", text: "x" }] });
    await callClaude("p", ctx, { model: MODELS.CLAUDE_SONNET });
    expect((messagesCreateMock.mock.calls[0]?.[0] as { model: string }).model).toBe(
      MODELS.CLAUDE_SONNET
    );
  });

  it("throws on a non-text first block", async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: "tool_use" }] });
    await expect(callClaude("p", ctx)).rejects.toThrow(/Unexpected response block type/);
  });

  it("propagates SDK errors — caller owns the fallback", async () => {
    messagesCreateMock.mockRejectedValue(new Error("overloaded"));
    await expect(callClaude("p", ctx)).rejects.toThrow("overloaded");
  });
});
