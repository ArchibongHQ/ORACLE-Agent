/** callVerification (B2/CVL) — Tier 0 local Claude Code → Claude Opus →
 *  OpenRouter GLM-5.2 → GLM-5.1 → GPT-oss-120B.
 *  Pins: malformed/unparseable JSON falls through to the next tier (never
 *  defaults to a confident APPROVED — that would silently bypass the
 *  adversarial-verification safety layer); terminal behavior is SKIPPED
 *  (never throws). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetClaudeCodeCaches } from "../src/callClaudeCode.js";
import { callVerification } from "../src/callVerification.js";
import { MODELS, OPENROUTER_MODELS } from "../src/cascade.js";
import {
  chatResponse,
  claudeCodeEnvelope,
  FakeChild,
  flushMicrotasks,
  makeCtx,
  postedModels,
} from "./helpers.js";

const { messagesCreateMock, spawn, execFile } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
  spawn: vi.fn(),
  execFile: vi.fn((_cmd: string, _args: string[], cb?: () => void) => cb?.()),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: messagesCreateMock };
  },
}));

vi.mock("node:child_process", () => ({ spawn, execFile }));

const fetchMock = vi.fn();
const ctxClaude = makeCtx({ claudeApiKey: "ck" });

function claudeText(text: string) {
  return { content: [{ type: "text", text }] };
}

beforeEach(() => {
  messagesCreateMock.mockReset();
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

describe("callVerification — Claude Opus tier", () => {
  it("parses a VETO verdict", async () => {
    messagesCreateMock.mockResolvedValue(
      claudeText('{"status":"VETO","rationale":"odds discrepancy"}')
    );
    const res = await callVerification("p", ctxClaude);
    expect(res.status).toBe("VETO");
    expect(res.rationale).toBe("odds discrepancy");
    expect(res.model).toBe(MODELS.CLAUDE_OPUS);
    expect(Number.isNaN(Date.parse(res.stamp))).toBe(false);
  });

  it("parses OVERRIDE with the alternative pick", async () => {
    messagesCreateMock.mockResolvedValue(
      claudeText('{"status":"OVERRIDE","rationale":"better EV","override":"AH Home -0.5"}')
    );
    const res = await callVerification("p", ctxClaude);
    expect(res.status).toBe("OVERRIDE");
    expect(res.override).toBe("AH Home -0.5");
  });

  it("falls through to SKIPPED on malformed JSON — never defaults to APPROVED", async () => {
    messagesCreateMock.mockResolvedValue(claudeText("I cannot verify this pick."));
    const res = await callVerification("p", ctxClaude);
    expect(res.status).toBe("SKIPPED");
  });

  it("falls through to SKIPPED on an unknown status string — never defaults to APPROVED", async () => {
    messagesCreateMock.mockResolvedValue(claudeText('{"status":"MAYBE","rationale":"hmm"}'));
    expect((await callVerification("p", ctxClaude)).status).toBe("SKIPPED");
  });
});

describe("callVerification — OpenRouter fallback tiers, GLM-first", () => {
  it("uses GLM-5.2 when Claude throws", async () => {
    messagesCreateMock.mockRejectedValue(new Error("claude down"));
    fetchMock.mockResolvedValue(chatResponse('{"status":"APPROVED","rationale":"sound"}'));
    const ctx = makeCtx({ claudeApiKey: "ck", openrouterApiKey: "or" });
    const res = await callVerification("p", ctx);
    expect(res.status).toBe("APPROVED");
    expect(res.model).toBe(OPENROUTER_MODELS.GLM_5_2);
    expect(postedModels(fetchMock)).toEqual([OPENROUTER_MODELS.GLM_5_2]);
  });

  it("falls GLM-5.2 → GLM-5.1 → GPT-oss-120B in order", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce(chatResponse('{"status":"VETO","rationale":"flaw"}'));
    const res = await callVerification("p", makeCtx({ openrouterApiKey: "or" }));
    expect(res.status).toBe("VETO");
    expect(res.model).toBe(OPENROUTER_MODELS.GPT_OSS_120B);
    expect(postedModels(fetchMock)).toEqual([
      OPENROUTER_MODELS.GLM_5_2,
      OPENROUTER_MODELS.GLM_5_1,
      OPENROUTER_MODELS.GPT_OSS_120B,
    ]);
  });
});

describe("callVerification — Tier 0 local Claude Code", () => {
  it("uses the local CLI result and skips Claude/OpenRouter when isLocalRuntime()", async () => {
    process.env.ORACLE_RUNTIME = "local";
    const child = new FakeChild();
    spawn.mockReturnValue(child);
    const promise = callVerification("p", makeCtx({ claudeApiKey: "ck", openrouterApiKey: "or" }));
    await flushMicrotasks();
    child.stdout.emit(
      "data",
      claudeCodeEnvelope({
        type: "result",
        is_error: false,
        result: '{"status":"VETO","rationale":"local flaw"}',
      })
    );
    child.emit("close", 0);
    const res = await promise;
    expect(res.status).toBe("VETO");
    expect(res.model).toBe("claude-code-local");
    expect(messagesCreateMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls through to Claude Opus when the local CLI returns null", async () => {
    process.env.ORACLE_RUNTIME = "local";
    spawn.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });
    messagesCreateMock.mockResolvedValue(claudeText('{"status":"APPROVED","rationale":"sound"}'));
    const res = await callVerification("p", ctxClaude);
    expect(res.status).toBe("APPROVED");
    expect(res.model).toBe(MODELS.CLAUDE_OPUS);
  });

  it("does not attempt the local CLI when isLocalRuntime() is false (default under Vitest)", async () => {
    messagesCreateMock.mockResolvedValue(claudeText('{"status":"APPROVED","rationale":"sound"}'));
    await callVerification("p", ctxClaude);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("callVerification — terminal SKIPPED behavior", () => {
  it("returns SKIPPED 'all tiers failed' when Claude throws and OpenRouter fails", async () => {
    messagesCreateMock.mockRejectedValue(new Error("down"));
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const ctx = makeCtx({ claudeApiKey: "ck", openrouterApiKey: "or" });
    const res = await callVerification("p", ctx);
    expect(res.status).toBe("SKIPPED");
    expect(res.rationale).toBe("CVL error — all tiers failed");
    expect(res.model).toBe(MODELS.CLAUDE_OPUS);
  });

  it("returns SKIPPED 'no Claude key' with model none when no keys configured", async () => {
    const res = await callVerification("p", makeCtx());
    expect(res.status).toBe("SKIPPED");
    expect(res.rationale).toBe("no Claude key");
    expect(res.model).toBe("none");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
