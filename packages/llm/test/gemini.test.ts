/** fetchGeminiWithCascade / callGeminiDecision — Gemini SDK mocked; OpenRouter Tier 2/3
 *  exercised via stubbed fetch. Pins cascade order and the terminal throw behavior. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callGeminiDecision, fetchGeminiWithCascade } from "../src/callGemini.js";
import { ACQUISITION_CASCADE, DECISION_CASCADE, OPENROUTER_MODELS } from "../src/cascade.js";
import { calledModels, chatResponse, makeCtx, postedModels } from "./helpers.js";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

const fetchMock = vi.fn();
const ctx = makeCtx({ geminiApiKey: "gk" });
const ctxWithOr = makeCtx({ geminiApiKey: "gk", openrouterApiKey: "or-key" });

beforeEach(() => {
  generateContentMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGeminiWithCascade", () => {
  it("returns tier-1 text without trying further tiers", async () => {
    generateContentMock.mockResolvedValueOnce({ text: "tier1" });
    expect(await fetchGeminiWithCascade("p", ctx)).toBe("tier1");
    expect(calledModels(generateContentMock)).toEqual([ACQUISITION_CASCADE[0]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls to the next cascade model when tier 1 throws", async () => {
    generateContentMock
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce({ text: "tier2" });
    expect(await fetchGeminiWithCascade("p", ctx)).toBe("tier2");
    expect(calledModels(generateContentMock)).toEqual(ACQUISITION_CASCADE);
  });

  it("treats an empty text response as a miss and continues the cascade", async () => {
    generateContentMock
      .mockResolvedValueOnce({ text: "" })
      .mockResolvedValueOnce({ text: "tier2" });
    expect(await fetchGeminiWithCascade("p", ctx)).toBe("tier2");
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("throws with collected errors when all Gemini tiers fail and no OpenRouter key", async () => {
    generateContentMock.mockRejectedValue(new Error("quota"));
    await expect(fetchGeminiWithCascade("p", ctx)).rejects.toThrow(/Gemini cascade exhausted/);
    await expect(fetchGeminiWithCascade("p", ctx)).rejects.toThrow(/quota/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls to OpenRouter models in order after Gemini exhaustion", async () => {
    generateContentMock.mockRejectedValue(new Error("down"));
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce(chatResponse("or-text"));
    expect(await fetchGeminiWithCascade("p", ctxWithOr)).toBe("or-text");
    expect(postedModels(fetchMock)).toEqual([OPENROUTER_MODELS.GLM_5_2, OPENROUTER_MODELS.GLM_5_1]);
  });

  it("throws after Gemini + all OpenRouter tiers fail", async () => {
    generateContentMock.mockRejectedValue(new Error("down"));
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchGeminiWithCascade("p", ctxWithOr)).rejects.toThrow(
      /Gemini cascade exhausted/
    );
    expect(postedModels(fetchMock)).toEqual([
      OPENROUTER_MODELS.GLM_5_2,
      OPENROUTER_MODELS.GLM_5_1,
      OPENROUTER_MODELS.DEEPSEEK_R1,
      OPENROUTER_MODELS.KIMI_K2,
      OPENROUTER_MODELS.GPT_4O,
      OPENROUTER_MODELS.QWEN3_235B_THINKING,
      OPENROUTER_MODELS.MINIMAX_M3,
      OPENROUTER_MODELS.GPT_OSS_120B,
      OPENROUTER_MODELS.NEMOTRON_SUPER_120B,
      OPENROUTER_MODELS.QWEN3_NEXT_80B,
    ]);
  });
});

describe("callGeminiDecision", () => {
  it("returns tier-1 text on success", async () => {
    generateContentMock.mockResolvedValueOnce({ text: "decision" });
    expect(await callGeminiDecision("p", ctx)).toBe("decision");
    expect(calledModels(generateContentMock)).toEqual([DECISION_CASCADE[0]]);
  });

  it("walks the decision cascade in order when tier 1 throws", async () => {
    generateContentMock
      .mockRejectedValueOnce(new Error("500"))
      .mockResolvedValueOnce({ text: "fallback" });
    expect(await callGeminiDecision("p", ctx)).toBe("fallback");
    expect(calledModels(generateContentMock)).toEqual(DECISION_CASCADE);
  });

  it("throws when exhausted — no OpenRouter fallback even with a key", async () => {
    generateContentMock.mockRejectedValue(new Error("quota"));
    await expect(callGeminiDecision("p", ctxWithOr)).rejects.toThrow(
      /Gemini decision cascade exhausted/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
