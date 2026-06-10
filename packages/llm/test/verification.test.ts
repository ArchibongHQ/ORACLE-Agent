/** callVerification (B2/CVL) — Claude Sonnet primary → OpenRouter GLM-5.1 → GPT-oss-120B.
 *  Pins: malformed JSON defaults to APPROVED, terminal behavior is SKIPPED (never throws). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callVerification } from "../src/callVerification.js";
import { MODELS, OPENROUTER_MODELS } from "../src/cascade.js";
import { chatResponse, makeCtx, postedModels } from "./helpers.js";

const { messagesCreateMock } = vi.hoisted(() => ({ messagesCreateMock: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: messagesCreateMock };
  },
}));

const fetchMock = vi.fn();
const ctxClaude = makeCtx({ claudeApiKey: "ck" });

function claudeText(text: string) {
  return { content: [{ type: "text", text }] };
}

beforeEach(() => {
  messagesCreateMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callVerification — Claude Sonnet tier", () => {
  it("parses a VETO verdict", async () => {
    messagesCreateMock.mockResolvedValue(
      claudeText('{"status":"VETO","rationale":"odds discrepancy"}')
    );
    const res = await callVerification("p", ctxClaude);
    expect(res.status).toBe("VETO");
    expect(res.rationale).toBe("odds discrepancy");
    expect(res.model).toBe(MODELS.CLAUDE_SONNET);
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

  it("defaults to APPROVED on malformed JSON — does not throw", async () => {
    messagesCreateMock.mockResolvedValue(claudeText("I cannot verify this pick."));
    const res = await callVerification("p", ctxClaude);
    expect(res.status).toBe("APPROVED");
    expect(res.rationale).toMatch(/parse error — defaulting APPROVED/);
  });

  it("coerces an unknown status string to APPROVED", async () => {
    messagesCreateMock.mockResolvedValue(claudeText('{"status":"MAYBE","rationale":"hmm"}'));
    expect((await callVerification("p", ctxClaude)).status).toBe("APPROVED");
  });
});

describe("callVerification — OpenRouter fallback tiers", () => {
  it("uses GLM-5.1 when Claude throws", async () => {
    messagesCreateMock.mockRejectedValue(new Error("claude down"));
    fetchMock.mockResolvedValue(chatResponse('{"status":"APPROVED","rationale":"sound"}'));
    const ctx = makeCtx({ claudeApiKey: "ck", openrouterApiKey: "or" });
    const res = await callVerification("p", ctx);
    expect(res.status).toBe("APPROVED");
    expect(res.model).toBe(OPENROUTER_MODELS.GLM_5_1);
    expect(postedModels(fetchMock)).toEqual([OPENROUTER_MODELS.GLM_5_1]);
  });

  it("falls from GLM-5.1 to GPT-oss-120B in order", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce(chatResponse('{"status":"VETO","rationale":"flaw"}'));
    const res = await callVerification("p", makeCtx({ openrouterApiKey: "or" }));
    expect(res.status).toBe("VETO");
    expect(res.model).toBe(OPENROUTER_MODELS.GPT_OSS_120B);
    expect(postedModels(fetchMock)).toEqual([
      OPENROUTER_MODELS.GLM_5_1,
      OPENROUTER_MODELS.GPT_OSS_120B,
    ]);
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
    expect(res.model).toBe(MODELS.CLAUDE_SONNET);
  });

  it("returns SKIPPED 'no Claude key' with model none when no keys configured", async () => {
    const res = await callVerification("p", makeCtx());
    expect(res.status).toBe("SKIPPED");
    expect(res.rationale).toBe("no Claude key");
    expect(res.model).toBe("none");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
