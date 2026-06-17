/** callBriefing (B1) — Claude Opus primary → Gemini temperature ensemble → OpenRouter
 *  Tier 2/3. Pins flag emission (FRAMING_BIAS_DETECTED, DIVERGENT_TEMPERATURE_ENSEMBLE)
 *  and the terminal throw when no LLM is available. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callBriefing } from "../src/callBriefing.js";
import { MODELS, OPENROUTER_MODELS } from "../src/cascade.js";
import { chatResponse, makeCtx, postedModels } from "./helpers.js";

const { messagesCreateMock, generateContentMock } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
  generateContentMock: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: messagesCreateMock };
  },
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

const fetchMock = vi.fn();

function claudeText(text: string) {
  return { content: [{ type: "text", text }] };
}

beforeEach(() => {
  messagesCreateMock.mockReset();
  generateContentMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callBriefing — Claude Opus primary", () => {
  it("returns Claude text with no flags when neutral stake agrees", async () => {
    const primary = '{"primaryPick":"Over 2.5","stake":0.05}';
    messagesCreateMock
      .mockResolvedValueOnce(claudeText(primary))
      .mockResolvedValueOnce(claudeText('{"primaryPick":"Over 2.5","stake":0.06}'));
    const res = await callBriefing("p", makeCtx({ claudeApiKey: "ck" }));
    expect(res).toEqual({ text: primary, model: MODELS.CLAUDE_OPUS, flags: [] });
    expect(messagesCreateMock).toHaveBeenCalledTimes(2); // primary + framing-bias check
  });

  it("flags FRAMING_BIAS_DETECTED when neutral-persona Kelly diverges >15%", async () => {
    messagesCreateMock
      .mockResolvedValueOnce(claudeText('{"primaryPick":"Over 2.5","stake":0.05}'))
      .mockResolvedValueOnce(claudeText('{"primaryPick":"Over 2.5","stake":0.30}'));
    const res = await callBriefing("p", makeCtx({ claudeApiKey: "ck" }));
    expect(res.flags).toEqual(["FRAMING_BIAS_DETECTED"]);
  });

  it("framing-bias check failure is non-fatal — still returns the primary text", async () => {
    messagesCreateMock
      .mockResolvedValueOnce(claudeText('{"primaryPick":"Over 2.5","stake":0.05}'))
      .mockRejectedValueOnce(new Error("rate limit"));
    const res = await callBriefing("p", makeCtx({ claudeApiKey: "ck" }));
    expect(res.model).toBe(MODELS.CLAUDE_OPUS);
    expect(res.flags).toEqual([]);
  });
});

describe("callBriefing — Gemini temperature ensemble fallback", () => {
  const ctx = makeCtx({ claudeApiKey: "ck", geminiApiKey: "gk" });

  it("runs the ensemble at T=[0.4,0.8,1.2] and returns the majority text", async () => {
    messagesCreateMock.mockRejectedValue(new Error("claude down"));
    generateContentMock
      .mockResolvedValueOnce({ text: '{"primaryPick":"Over 2.5"}' })
      .mockResolvedValueOnce({ text: '{"primaryPick":"Over 2.5","x":1}' })
      .mockResolvedValueOnce({ text: '{"primaryPick":"Home"}' });
    const res = await callBriefing("p", ctx);
    expect(res.model).toBe(MODELS.GEMINI_FLASH);
    expect(res.text).toBe('{"primaryPick":"Over 2.5"}');
    expect(res.flags).toEqual([]);
    const temps = generateContentMock.mock.calls.map(
      (c) => (c[0] as { config: { temperature: number } }).config.temperature
    );
    expect(temps).toEqual([0.4, 0.8, 1.2]);
  });

  it("flags DIVERGENT_TEMPERATURE_ENSEMBLE when no majority market emerges", async () => {
    messagesCreateMock.mockRejectedValue(new Error("claude down"));
    generateContentMock
      .mockResolvedValueOnce({ text: '{"primaryPick":"A"}' })
      .mockResolvedValueOnce({ text: '{"primaryPick":"B"}' })
      .mockResolvedValueOnce({ text: '{"primaryPick":"C"}' });
    const res = await callBriefing("p", ctx);
    expect(res.flags).toContain("DIVERGENT_TEMPERATURE_ENSEMBLE");
    expect(res.text).toBe('{"primaryPick":"A"}'); // first text when divergent
  });
});

describe("callBriefing — OpenRouter Tier 2/3", () => {
  const ctx = makeCtx({ openrouterApiKey: "or-key" });

  it("uses Qwen3 235B Thinking (Tier 2) when no Claude/Gemini keys", async () => {
    fetchMock.mockResolvedValue(chatResponse('{"primaryPick":"Over 2.5"}'));
    const res = await callBriefing("p", ctx);
    expect(res.model).toBe(OPENROUTER_MODELS.QWEN3_235B_THINKING);
    expect(res.text).toBe('{"primaryPick":"Over 2.5"}');
  });

  it("falls to GPT-OSS-120B (Tier 3) when Tier 2 fails", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce(chatResponse('{"primaryPick":"X"}'));
    const res = await callBriefing("p", ctx);
    expect(res.model).toBe(OPENROUTER_MODELS.GPT_OSS_120B);
    expect(postedModels(fetchMock)).toEqual([
      OPENROUTER_MODELS.QWEN3_235B_THINKING,
      OPENROUTER_MODELS.GPT_OSS_120B,
    ]);
  });

  it("reaches OpenRouter after the Gemini ensemble fails completely", async () => {
    generateContentMock.mockRejectedValue(new Error("gemini down"));
    fetchMock.mockResolvedValue(chatResponse("or-briefing"));
    const res = await callBriefing("p", makeCtx({ geminiApiKey: "gk", openrouterApiKey: "ok" }));
    expect(res.model).toBe(OPENROUTER_MODELS.QWEN3_235B_THINKING);
  });
});

describe("callBriefing — exhaustion", () => {
  it("throws when no keys are configured at all", async () => {
    await expect(callBriefing("p", makeCtx())).rejects.toThrow(/callBriefing: no LLM available/);
  });

  it("throws when every tier fails", async () => {
    messagesCreateMock.mockRejectedValue(new Error("c"));
    generateContentMock.mockRejectedValue(new Error("g"));
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const ctx = makeCtx({ claudeApiKey: "ck", geminiApiKey: "gk", openrouterApiKey: "ok" });
    await expect(callBriefing("p", ctx)).rejects.toThrow(/callBriefing: no LLM available/);
  });
});
