/** callKimiVote / callOpenRouterVote — swarm workers. Pins the "never throws, null on
 *  failure" contract and the vote-parsing rules (confidence clamp, empty pick → null). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callKimiVote, callOpenRouterVote } from "../src/callKimi.js";
import { MODELS, OPENROUTER_MODELS } from "../src/cascade.js";
import { chatResponse } from "./helpers.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callKimiVote", () => {
  it("posts to the Moonshot endpoint with KIMI_SWARM and parses the vote", async () => {
    fetchMock.mockResolvedValue(
      chatResponse('{"pick":"Over 2.5","confidence":0.8,"rationale":"value edge"}')
    );
    const vote = await callKimiVote("prompt", "mk");
    expect(vote).toEqual({
      pick: "Over 2.5",
      confidence: 0.8,
      rationale: "value edge",
      model: MODELS.KIMI_SWARM,
    });
    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
    const body = JSON.parse(opts.body) as { model: string; temperature: number };
    expect(body.model).toBe(MODELS.KIMI_SWARM);
    expect(body.temperature).toBe(0.4);
  });

  it("clamps self-reported confidence into [0,1]", async () => {
    fetchMock.mockResolvedValue(chatResponse('{"pick":"NO_BET","confidence":7}'));
    expect((await callKimiVote("p", "mk"))?.confidence).toBe(1);
  });

  it("returns null without fetching when the key is empty", async () => {
    expect(await callKimiVote("p", "")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on non-ok HTTP status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    expect(await callKimiVote("p", "mk")).toBeNull();
  });

  it("returns null on malformed vote JSON — never throws", async () => {
    fetchMock.mockResolvedValue(chatResponse("certainly! here is my vote"));
    await expect(callKimiVote("p", "mk")).resolves.toBeNull();
  });

  it("returns null when the pick is empty", async () => {
    fetchMock.mockResolvedValue(chatResponse('{"pick":"","confidence":0.5}'));
    expect(await callKimiVote("p", "mk")).toBeNull();
  });

  it("returns null when fetch rejects — never throws", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    await expect(callKimiVote("p", "mk")).resolves.toBeNull();
  });
});

describe("callOpenRouterVote", () => {
  it("routes through OpenRouter with the given model and parses the vote", async () => {
    fetchMock.mockResolvedValue(
      chatResponse('{"pick":"Home Win","confidence":0.6,"rationale":"r"}')
    );
    const vote = await callOpenRouterVote("p", OPENROUTER_MODELS.GPT_OSS_120B, "or");
    expect(vote).toEqual({
      pick: "Home Win",
      confidence: 0.6,
      rationale: "r",
      model: OPENROUTER_MODELS.GPT_OSS_120B,
    });
    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain("openrouter.ai");
    expect((JSON.parse(opts.body) as { model: string }).model).toBe(OPENROUTER_MODELS.GPT_OSS_120B);
  });

  it("returns null when the transport fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    expect(await callOpenRouterVote("p", OPENROUTER_MODELS.GPT_OSS_120B, "or")).toBeNull();
  });
});
