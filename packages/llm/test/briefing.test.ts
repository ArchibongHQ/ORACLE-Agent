/** callBriefing (B1) — Tier 0 local Claude Code → Claude Opus primary → Gemini
 *  temperature ensemble → OpenRouter Tier 2/3 (free-tier only, 2026-07-10 policy:
 *  briefing is an optional extra, never justifies paid-tier spend). Pins flag
 *  emission (FRAMING_BIAS_DETECTED, DIVERGENT_TEMPERATURE_ENSEMBLE) and the
 *  terminal throw when no LLM is available. */
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

describe("callBriefing — OpenRouter Tier 2/3, free-tier only", () => {
  const ctx = makeCtx({ openrouterApiKey: "or-key" });

  it("uses GLM-5.2's own :free slug first when no Claude/Gemini keys", async () => {
    fetchMock.mockResolvedValue(chatResponse('{"primaryPick":"Over 2.5"}'));
    const res = await callBriefing("p", ctx);
    expect(res.model).toBe(OPENROUTER_MODELS.GLM_5_2_FREE);
    expect(res.text).toBe('{"primaryPick":"Over 2.5"}');
  });

  it("falls GLM-5.2:free → GLM-4.5-Air:free → DeepSeek-V4-Pro:free → Nemotron-3-Ultra:free in order", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce(chatResponse('{"primaryPick":"X"}'));
    const res = await callBriefing("p", ctx);
    expect(res.model).toBe(OPENROUTER_MODELS.NEMOTRON_3_ULTRA_FREE);
    expect(postedModels(fetchMock)).toEqual([
      OPENROUTER_MODELS.GLM_5_2_FREE,
      OPENROUTER_MODELS.GLM_4_5_AIR_FREE,
      OPENROUTER_MODELS.DEEPSEEK_V4_PRO_FREE,
      OPENROUTER_MODELS.NEMOTRON_3_ULTRA_FREE,
    ]);
  });

  it("reaches OpenRouter after the Gemini ensemble fails completely", async () => {
    generateContentMock.mockRejectedValue(new Error("gemini down"));
    fetchMock.mockResolvedValue(chatResponse("or-briefing"));
    const res = await callBriefing("p", makeCtx({ geminiApiKey: "gk", openrouterApiKey: "ok" }));
    expect(res.model).toBe(OPENROUTER_MODELS.GLM_5_2_FREE);
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

describe("callBriefing diagnostic logging", () => {
  it("logs when the tier-0 local CLI produces no text", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.ORACLE_RUNTIME = "local";
    spawn.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });
    messagesCreateMock.mockResolvedValueOnce(claudeText('{"primaryPick":"Over 2.5"}'));
    await callBriefing("p", makeCtx({ claudeApiKey: "ck" }));
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("[callBriefing] tier 0 local CLI produced no text")
    );
    writeSpy.mockRestore();
  });

  it("logs an empty-response-text diagnostic when Claude Opus returns no text", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    messagesCreateMock.mockResolvedValueOnce(claudeText(""));
    fetchMock.mockResolvedValue(chatResponse('{"primaryPick":"Over 2.5"}'));
    await callBriefing("p", makeCtx({ claudeApiKey: "ck", openrouterApiKey: "ok" }));
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("[callBriefing] Claude Opus tier: empty response text")
    );
    writeSpy.mockRestore();
  });

  it("logs the sanitized error reason when the Claude Opus tier throws", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    messagesCreateMock.mockRejectedValue(new Error("rate limit"));
    fetchMock.mockResolvedValue(chatResponse('{"primaryPick":"Over 2.5"}'));
    await callBriefing("p", makeCtx({ claudeApiKey: "ck", openrouterApiKey: "ok" }));
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("[callBriefing] Claude Opus tier")
    );
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("rate limit"));
    writeSpy.mockRestore();
  });

  it("logs each rejected temperature-ensemble call plus the Gemini-tier catch when every call fails", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    generateContentMock.mockRejectedValue(new Error("gemini down"));
    fetchMock.mockResolvedValue(chatResponse('{"primaryPick":"Over 2.5"}'));
    await callBriefing("p", makeCtx({ geminiApiKey: "gk", openrouterApiKey: "ok" }));
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("[callBriefing] temperature ensemble T=0.4")
    );
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("[callBriefing] Gemini ensemble tier")
    );
    writeSpy.mockRestore();
  });

  it("logs the sanitized error reason when the framing-bias check throws", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    messagesCreateMock
      .mockResolvedValueOnce(claudeText('{"primaryPick":"Over 2.5","stake":0.05}'))
      .mockRejectedValueOnce(new Error("rate limit"));
    await callBriefing("p", makeCtx({ claudeApiKey: "ck" }));
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("[callBriefing] framing-bias check")
    );
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("rate limit"));
    writeSpy.mockRestore();
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
    // Full free-tier-only cascade order (2026-07-10 policy) — each named
    // rung's own :free slug immediately followed by its verified free
    // substitute, then the pre-existing free tail as deeper fallbacks.
    expect(postedModels(fetchMock)).toEqual([
      OPENROUTER_MODELS.GLM_5_2_FREE,
      OPENROUTER_MODELS.GLM_4_5_AIR_FREE,
      OPENROUTER_MODELS.DEEPSEEK_V4_PRO_FREE,
      OPENROUTER_MODELS.NEMOTRON_3_ULTRA_FREE,
      OPENROUTER_MODELS.DEEPSEEK_V4_FLASH_FREE,
      OPENROUTER_MODELS.NEMOTRON_NANO_OMNI_REASONING_FREE,
      OPENROUTER_MODELS.GEMMA_4_26B_MOE_FREE,
      OPENROUTER_MODELS.GEMMA_4_31B_FREE,
      OPENROUTER_MODELS.GPT_OSS_120B,
      OPENROUTER_MODELS.NEMOTRON_SUPER_120B,
      OPENROUTER_MODELS.QWEN3_NEXT_80B,
      OPENROUTER_MODELS.GPT_OSS_20B,
    ]);
  });
});
