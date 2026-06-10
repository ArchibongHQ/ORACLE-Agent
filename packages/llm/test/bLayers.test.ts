/** Smoke coverage for B3–B6 helpers: callRedTeam, callRegimeHint, synthesizePostmortems,
 *  embedText/makeEmbedder. Gemini SDK mocked; OpenRouter tier via stubbed fetch. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { synthesizePostmortems } from "../src/callPostmortem.js";
import { callRedTeam } from "../src/callRedTeam.js";
import { callRegimeHint } from "../src/callRegimeHint.js";
import { DECISION_CASCADE, MODELS, OPENROUTER_MODELS } from "../src/cascade.js";
import { embedText, makeEmbedder } from "../src/embed.js";
import { chatResponse, makeCtx, postedModels } from "./helpers.js";

const { generateContentMock, embedContentMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
  embedContentMock: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock, embedContent: embedContentMock };
  },
}));

const fetchMock = vi.fn();
const ctx = makeCtx({ geminiApiKey: "gk" });

beforeEach(() => {
  generateContentMock.mockReset();
  embedContentMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callRedTeam (B3)", () => {
  it("parses a structured critique from the first cascade model", async () => {
    generateContentMock.mockResolvedValueOnce({
      text: '{"critique":"weak edge","weaknesses":["w1"],"alternativePick":"Alt","confidenceScore":0.8}',
    });
    const res = await callRedTeam("p", ctx);
    expect(res).toEqual({
      critique: "weak edge",
      weaknesses: ["w1"],
      alternativePick: "Alt",
      confidenceScore: 0.8,
      model: DECISION_CASCADE[0],
    });
  });

  it("degrades malformed JSON to a raw-text critique with confidence 0.5 — no throw", async () => {
    generateContentMock.mockResolvedValueOnce({ text: "free-form rant" });
    const res = await callRedTeam("p", ctx);
    expect(res.critique).toBe("free-form rant");
    expect(res.weaknesses).toEqual([]);
    expect(res.confidenceScore).toBe(0.5);
  });

  it('drops alternativePick when the model returns the string "null"', async () => {
    generateContentMock.mockResolvedValueOnce({
      text: '{"critique":"c","weaknesses":[],"alternativePick":"null","confidenceScore":0.4}',
    });
    expect((await callRedTeam("p", ctx)).alternativePick).toBeUndefined();
  });

  it("throws when the decision cascade is exhausted", async () => {
    generateContentMock.mockRejectedValue(new Error("quota"));
    await expect(callRedTeam("p", ctx)).rejects.toThrow(/callRedTeam cascade exhausted/);
    expect(generateContentMock).toHaveBeenCalledTimes(DECISION_CASCADE.length);
  });
});

describe("callRegimeHint (B6)", () => {
  it("returns a parsed advisory hint from Gemini Flash", async () => {
    generateContentMock.mockResolvedValueOnce({
      text: '{"label":"HIGH_SCORING","rationale":"open game","confidence":0.7}',
    });
    expect(await callRegimeHint("soft ctx", ctx)).toEqual({
      label: "HIGH_SCORING",
      rationale: "open game",
      confidence: 0.7,
      model: MODELS.GEMINI_FLASH,
      advisory: true,
    });
  });

  it("coerces an invalid label to UNKNOWN", async () => {
    generateContentMock.mockResolvedValueOnce({
      text: '{"label":"CHAOTIC","rationale":"r","confidence":0.9}',
    });
    expect((await callRegimeHint("s", ctx)).label).toBe("UNKNOWN");
  });

  it("falls to GLM-4.5 Air (free) when Gemini throws and an OpenRouter key exists", async () => {
    generateContentMock.mockRejectedValue(new Error("down"));
    fetchMock.mockResolvedValue(
      chatResponse('{"label":"DEFENSIVE","rationale":"r","confidence":0.5}')
    );
    const res = await callRegimeHint("s", makeCtx({ geminiApiKey: "gk", openrouterApiKey: "or" }));
    expect(res.label).toBe("DEFENSIVE");
    expect(res.model).toBe(OPENROUTER_MODELS.GLM_4_5_AIR);
    expect(postedModels(fetchMock)).toEqual([OPENROUTER_MODELS.GLM_4_5_AIR]);
  });

  it("returns the UNKNOWN fallback (never throws) when no tier is available", async () => {
    const res = await callRegimeHint("s", makeCtx());
    expect(res).toEqual({
      label: "UNKNOWN",
      rationale: "no Gemini key or call failed",
      confidence: 0,
      model: "none",
      advisory: true,
    });
  });
});

describe("synthesizePostmortems (B5)", () => {
  const loss = {
    fixtureId: "f1",
    homeTeam: "H",
    awayTeam: "A",
    marketPicked: "Over 2.5",
    rootCause: "early red card",
    signalsThatFired: ["xg-edge"],
    signalsThatShouldHaveFired: ["discipline-risk"],
  };

  it("returns empty rules without calling Gemini when the key is absent", async () => {
    const out = await synthesizePostmortems([loss], makeCtx());
    expect(out).toEqual([{ ...loss, synthesizedRule: "" }]);
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("attaches trimmed rules and degrades failed entries to an empty rule", async () => {
    generateContentMock
      .mockResolvedValueOnce({ text: "  Avoid Overs when discipline risk is high.  " })
      .mockRejectedValueOnce(new Error("down"));
    const out = await synthesizePostmortems([loss, { ...loss, fixtureId: "f2" }], ctx);
    expect(out[0]?.synthesizedRule).toBe("Avoid Overs when discipline risk is high.");
    expect(out[1]?.synthesizedRule).toBe("");
  });

  it("truncates synthesized rules to 200 characters", async () => {
    generateContentMock.mockResolvedValueOnce({ text: "x".repeat(300) });
    const out = await synthesizePostmortems([loss], ctx);
    expect(out[0]?.synthesizedRule).toHaveLength(200);
  });
});

describe("embedText / makeEmbedder (B4)", () => {
  it("returns the embedding vector on success", async () => {
    embedContentMock.mockResolvedValueOnce({ embeddings: [{ values: [0.1, 0.2, 0.3] }] });
    expect(await embedText("t", ctx)).toEqual([0.1, 0.2, 0.3]);
  });

  it("returns null when the key is absent", async () => {
    expect(await embedText("t", makeCtx())).toBeNull();
    expect(embedContentMock).not.toHaveBeenCalled();
  });

  it("returns null when the response has no values", async () => {
    embedContentMock.mockResolvedValueOnce({ embeddings: [] });
    expect(await embedText("t", ctx)).toBeNull();
  });

  it("returns null when the SDK throws — never throws", async () => {
    embedContentMock.mockRejectedValueOnce(new Error("quota"));
    await expect(embedText("t", ctx)).resolves.toBeNull();
  });

  it("makeEmbedder binds the context and delegates to embedText", async () => {
    embedContentMock.mockResolvedValueOnce({ embeddings: [{ values: [1] }] });
    const embed = makeEmbedder(ctx);
    expect(await embed("hello")).toEqual([1]);
    expect((embedContentMock.mock.calls[0]?.[0] as { contents: string }).contents).toBe("hello");
  });
});
