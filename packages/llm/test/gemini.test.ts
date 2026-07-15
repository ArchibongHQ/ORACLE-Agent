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
    expect(postedModels(fetchMock)).toEqual([
      OPENROUTER_MODELS.DEEPSEEK_V4_FLASH,
      OPENROUTER_MODELS.DEEPSEEK_V4_PRO,
    ]);
  });

  it("throws after Gemini + all OpenRouter tiers fail", async () => {
    generateContentMock.mockRejectedValue(new Error("down"));
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchGeminiWithCascade("p", ctxWithOr)).rejects.toThrow(
      /Gemini cascade exhausted/
    );
    expect(postedModels(fetchMock)).toEqual([
      OPENROUTER_MODELS.DEEPSEEK_V4_FLASH,
      OPENROUTER_MODELS.DEEPSEEK_V4_PRO,
      OPENROUTER_MODELS.DEEPSEEK_R1,
      OPENROUTER_MODELS.GLM_5_2,
      OPENROUTER_MODELS.GLM_5_1,
      OPENROUTER_MODELS.KIMI_K2,
      OPENROUTER_MODELS.GPT_4O,
      OPENROUTER_MODELS.QWEN3_235B_THINKING,
      OPENROUTER_MODELS.MINIMAX_M3,
      OPENROUTER_MODELS.MINIMAX_M2_5,
      OPENROUTER_MODELS.MIMO_V2_5_PRO,
      OPENROUTER_MODELS.QWEN3_CODER_480B,
      OPENROUTER_MODELS.QWEN3_CODER_NEXT,
      OPENROUTER_MODELS.LONGCAT_FLASH_CHAT,
      OPENROUTER_MODELS.NEMOTRON_3_ULTRA,
      OPENROUTER_MODELS.GPT_OSS_120B,
      OPENROUTER_MODELS.NEMOTRON_SUPER_120B,
      OPENROUTER_MODELS.QWEN3_NEXT_80B,
      OPENROUTER_MODELS.GPT_OSS_20B,
    ]);
  });
});

describe("callGemini diagnostic logging", () => {
  it("logs the sanitized error reason when a Gemini acquisition-cascade model throws", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    generateContentMock
      .mockRejectedValueOnce(new Error("503 model overloaded"))
      .mockResolvedValueOnce({ text: "tier2" });
    await fetchGeminiWithCascade("p", ctx);
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[callGemini]"));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("503 model overloaded"));
    writeSpy.mockRestore();
  });

  it("logs an empty-response-text diagnostic when a Gemini model returns no text", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    generateContentMock
      .mockResolvedValueOnce({ text: "" })
      .mockResolvedValueOnce({ text: "tier2" });
    await fetchGeminiWithCascade("p", ctx);
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("empty response text"));
    writeSpy.mockRestore();
  });

  it("redacts a Google API-key-shaped substring from a logged error message", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    generateContentMock.mockRejectedValue(
      new Error("API key not valid: AIzaSyD-abcdefghijklmnopqrstuvwxyz1234")
    );
    await expect(fetchGeminiWithCascade("p", ctx)).rejects.toThrow();
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain("AIzaSyD-abcdefghijklmnopqrstuvwxyz1234");
    expect(logged).toContain("[REDACTED]");
    writeSpy.mockRestore();
  });

  it("logs the sanitized error reason when a decision-cascade model throws", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    generateContentMock
      .mockRejectedValueOnce(new Error("500 internal"))
      .mockResolvedValueOnce({ text: "fallback" });
    await callGeminiDecision("p", ctx);
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[callGemini]"));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("500 internal"));
    writeSpy.mockRestore();
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
