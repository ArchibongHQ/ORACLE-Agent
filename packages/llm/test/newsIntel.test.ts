/** fetchNewsIntelligence (T0, Perplexity Sonar) — sonar-pro → sonar cascade. Pins the
 *  low-confidence null gate and the "never throws, null terminal" contract. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchNewsIntelligence } from "../src/callNewsIntel.js";
import { postedModels } from "./helpers.js";

const fetchMock = vi.fn();
const KO = "2026-06-12T15:00:00Z";

const GOOD_CONTENT = JSON.stringify({
  injuries: ["Player X (Home) — out"],
  suspensions: [],
  lineupHints: ["4-3-3 confirmed"],
  motivationFlags: ["relegation battle"],
  travelFlags: [],
  confidence: 0.8,
});

function sonarResponse(content: string, citations: string[] = []) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }], citations }),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchNewsIntelligence", () => {
  it("returns null without fetching when the key is empty", async () => {
    expect(await fetchNewsIntelligence("H", "A", "L", KO, "")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses a sonar-pro result with citations as sources", async () => {
    fetchMock.mockResolvedValue(sonarResponse(GOOD_CONTENT, ["https://a", "https://b"]));
    const res = await fetchNewsIntelligence("H", "A", "L", KO, "pk");
    expect(res).toMatchObject({
      injuries: ["Player X (Home) — out"],
      lineupHints: ["4-3-3 confirmed"],
      motivationFlags: ["relegation battle"],
      sources: ["https://a", "https://b"],
      confidence: 0.8,
      model: "perplexity-sonar-pro",
    });
    expect(postedModels(fetchMock)).toEqual(["sonar-pro"]);
  });

  it("returns null on confidence below 0.4 without trying the sonar fallback", async () => {
    fetchMock.mockResolvedValue(sonarResponse(JSON.stringify({ injuries: [], confidence: 0.2 })));
    expect(await fetchNewsIntelligence("H", "A", "L", KO, "pk")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back from sonar-pro to sonar on HTTP failure", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce(sonarResponse(GOOD_CONTENT, ["https://c"]));
    const res = await fetchNewsIntelligence("H", "A", "L", KO, "pk");
    expect(res?.model).toBe("perplexity-sonar");
    expect(postedModels(fetchMock)).toEqual(["sonar-pro", "sonar"]);
  });

  it("cascades past malformed JSON, then returns null when sonar is also malformed", async () => {
    fetchMock.mockResolvedValue(sonarResponse("no json in this reply"));
    expect(await fetchNewsIntelligence("H", "A", "L", KO, "pk")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when both models throw — never throws", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    await expect(fetchNewsIntelligence("H", "A", "L", KO, "pk")).resolves.toBeNull();
  });
});
