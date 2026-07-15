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

describe("fetchNewsIntelligence diagnostic logging", () => {
  it("logs the sonar HTTP status on HTTP failure", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce(sonarResponse(GOOD_CONTENT, ["https://c"]));
    await fetchNewsIntelligence("H", "A", "L", KO, "pk");
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("[callNewsIntel] sonar HTTP 500")
    );
    writeSpy.mockRestore();
  });

  it("logs 'no JSON object found' plus the exhausted-cascade summary on malformed content", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fetchMock.mockResolvedValue(sonarResponse("no json in this reply"));
    await fetchNewsIntelligence("H", "A", "L", KO, "pk");
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("[callNewsIntel] no JSON object found in sonar content")
    );
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("[callNewsIntel] perplexity sonar cascade exhausted")
    );
    writeSpy.mockRestore();
  });

  it("logs the sanitized error reason when a model throws", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fetchMock.mockRejectedValue(new Error("network"));
    await fetchNewsIntelligence("H", "A", "L", KO, "pk");
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("[callNewsIntel] sonar cascade"));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("network"));
    writeSpy.mockRestore();
  });

  it("redacts a hyphenated provider-key shape from a logged sonar-cascade error", async () => {
    // Regression: the redaction regex used to require [A-Za-z0-9]{10,} right
    // after "sk-" with no hyphens allowed, so a real Perplexity/Anthropic key
    // shape (hyphenated) would slip through un-redacted if an upstream error
    // ever echoed one back — this file logs raw upstream error text verbatim.
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fetchMock.mockRejectedValue(
      new Error("invalid key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456")
    );
    await fetchNewsIntelligence("H", "A", "L", KO, "pk");
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456");
    expect(logged).toContain("[REDACTED]");
    writeSpy.mockRestore();
  });
});
