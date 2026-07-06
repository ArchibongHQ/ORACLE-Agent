/** callBriefing (B1) — Tier 0 local Claude Code → Claude Opus primary → Gemini
 *  temperature ensemble → OpenRouter Tier 2/3 (DeepSeek-first). Pins flag emission
 *  (FRAMING_BIAS_DETECTED, DIVERGENT_TEMPERATURE_ENSEMBLE) and the terminal throw
 *  when no LLM is available. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callBriefing } from "../src/callBriefing.js";
import { _resetClaudeCodeCaches } from "../src/callClaudeCode.js";
import { MODELS, OPENROUTER_MODELS } from "../src/cascade.js";
import {
  chatResponse,
  claudeCodeEnvelope,
  FakeChild,
  flushMicrotasks,
  makeCtx,
  postedModels,
} from "./helpers.js";

const { messagesCreateMock, generateContentMock, spawn, execFile } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
  generateContentMock: vi.fn(),
  spawn: vi.fn(),
  execFile: vi.fn((_cmd: string, _args: string[], cb?: () => void) => cb?.()),
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

vi.mock("node:child_process", () => ({ spawn, execFile }));

const fetchMock = vi.fn();

function claudeText(text: string) {
  return { content: [{ type: "text", text }] };
}

beforeEach(() => {
  messagesCreateMock.mockReset();
  generateContentMock.mockReset();
  fetchMock.mockReset();
  spawn.mockReset();
  execFile.mockClear();
  _resetClaudeCodeCaches();
  delete process.env.ORACLE_RUNTIME;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ORACLE_RUNTIME;
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

describe("callBriefing — OpenRouter Tier 2/3, DeepSeek-first", () => {
  const ctx = makeCtx({ openrouterApiKey: "or-key" });

  it("uses DeepSeek-V4-Flash first when no Claude/Gemini keys", async () => {
    fetchMock.mockResolvedValue(chatResponse('{"primaryPick":"Over 2.5"}'));
    const res = await callBriefing("p", ctx);
    expect(res.model).toBe(OPENROUTER_MODELS.DEEPSEEK_V4_FLASH);
    expect(res.text).toBe('{"primaryPick":"Over 2.5"}');
  });

  it("falls DeepSeek-V4-Flash → DeepSeek-V4-Pro → DeepSeek-R1 → GLM-5.2 in order", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce(chatResponse('{"primaryPick":"X"}'));
    const res = await callBriefing("p", ctx);
    expect(res.model).toBe(OPENROUTER_MODELS.GLM_5_2);
    expect(postedModels(fetchMock)).toEqual([
      OPENROUTER_MODELS.DEEPSEEK_V4_FLASH,
      OPENROUTER_MODELS.DEEPSEEK_V4_PRO,
      OPENROUTER_MODELS.DEEPSEEK_R1,
      OPENROUTER_MODELS.GLM_5_2,
    ]);
  });

  it("reaches OpenRouter after the Gemini ensemble fails completely", async () => {
    generateContentMock.mockRejectedValue(new Error("gemini down"));
    fetchMock.mockResolvedValue(chatResponse("or-briefing"));
    const res = await callBriefing("p", makeCtx({ geminiApiKey: "gk", openrouterApiKey: "ok" }));
    expect(res.model).toBe(OPENROUTER_MODELS.DEEPSEEK_V4_FLASH);
  });
});

describe("callBriefing — Tier 0 local Claude Code", () => {
  it("uses the local CLI result and skips Claude/Gemini/OpenRouter when isLocalRuntime()", async () => {
    process.env.ORACLE_RUNTIME = "local";
    const child = new FakeChild();
    spawn.mockReturnValue(child);
    const promise = callBriefing(
      "p",
      makeCtx({ claudeApiKey: "ck", geminiApiKey: "gk", openrouterApiKey: "ok" })
    );
    await flushMicrotasks();
    child.stdout.emit(
      "data",
      claudeCodeEnvelope({ type: "result", is_error: false, result: '{"primaryPick":"Over 2.5"}' })
    );
    child.emit("close", 0);
    const res = await promise;
    expect(res.text).toBe('{"primaryPick":"Over 2.5"}');
    expect(res.model).toBe("claude-code-local");
    expect(messagesCreateMock).not.toHaveBeenCalled();
    expect(generateContentMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls through to Claude Opus when the local CLI returns null", async () => {
    process.env.ORACLE_RUNTIME = "local";
    spawn.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });
    messagesCreateMock.mockResolvedValueOnce(claudeText('{"primaryPick":"Over 2.5"}'));
    const res = await callBriefing("p", makeCtx({ claudeApiKey: "ck" }));
    expect(res.model).toBe(MODELS.CLAUDE_OPUS);
  });

  it("does not attempt the local CLI when isLocalRuntime() is false (default under Vitest)", async () => {
    messagesCreateMock.mockResolvedValueOnce(claudeText('{"primaryPick":"Over 2.5"}'));
    await callBriefing("p", makeCtx({ claudeApiKey: "ck" }));
    expect(spawn).not.toHaveBeenCalled();
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
    // Full cascade order, paid models before the free tier — locks in the
    // 2026-07-06 ordering-bug fix (deeper paid fallbacks must precede GPT-OSS).
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
