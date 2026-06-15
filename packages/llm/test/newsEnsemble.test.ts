/** fetchNewsViaGoogleAiMode + fetchNewsEnsemble — the Perplexity-absent fallback path.
 *  Pins: Google AI-Mode scrape → Gemini reshape, the parallel ensemble merge with
 *  cross-provider agreement confidence boost, and the "never throws, null terminal"
 *  contract when scraping/keys are unavailable. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { generateContentMock, scrapeMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
  scrapeMock: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

vi.mock("@oracle/research", () => ({
  scrapeGoogleAiMode: scrapeMock,
}));

const { fetchNewsViaGoogleAiMode, fetchNewsEnsemble } = await import("../src/callNewsIntel.js");

const KO = "2026-06-12T15:00:00Z";
const OBSERVED = "2026-06-12T13:00:00Z";

function g(text: string) {
  return { text };
}

const RESHAPED = JSON.stringify({
  injuries: ["Player X (Home) — out"],
  suspensions: [],
  lineupHints: ["4-3-3 confirmed"],
  motivationFlags: ["relegation battle"],
  travelFlags: [],
  confidence: 0.7,
});

const fetchMock = vi.fn();

beforeEach(() => {
  generateContentMock.mockReset();
  scrapeMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchNewsViaGoogleAiMode", () => {
  it("returns null without scraping when geminiKey is empty", async () => {
    expect(await fetchNewsViaGoogleAiMode("H", "A", "L", KO, "")).toBeNull();
    expect(scrapeMock).not.toHaveBeenCalled();
  });

  it("returns null when the scrape yields nothing", async () => {
    scrapeMock.mockResolvedValue(null);
    expect(await fetchNewsViaGoogleAiMode("H", "A", "L", KO, "gk")).toBeNull();
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("reshapes scraped prose into NewsIntelResult, carrying scrape sources + observedAt", async () => {
    scrapeMock.mockResolvedValue({
      text: "Home are without Player X. They line up 4-3-3 and are fighting relegation.",
      sources: ["https://bbc.co.uk/x", "https://sky.com/y"],
      observedAt: OBSERVED,
    });
    generateContentMock.mockResolvedValueOnce(g(RESHAPED));

    const res = await fetchNewsViaGoogleAiMode("H", "A", "L", KO, "gk");
    expect(res).toMatchObject({
      injuries: ["Player X (Home) — out"],
      lineupHints: ["4-3-3 confirmed"],
      sources: ["https://bbc.co.uk/x", "https://sky.com/y"],
      confidence: 0.7,
      observedAt: OBSERVED,
    });
    expect(res?.model).toContain("google-ai-mode");
  });

  it("returns null on low-confidence reshape", async () => {
    scrapeMock.mockResolvedValue({ text: "vague", sources: [], observedAt: OBSERVED });
    generateContentMock.mockResolvedValueOnce(g(JSON.stringify({ injuries: [], confidence: 0.2 })));
    expect(await fetchNewsViaGoogleAiMode("H", "A", "L", KO, "gk")).toBeNull();
  });

  it("never throws when the reshape call rejects", async () => {
    scrapeMock.mockResolvedValue({ text: "x", sources: [], observedAt: OBSERVED });
    generateContentMock.mockRejectedValue(new Error("genai down"));
    await expect(fetchNewsViaGoogleAiMode("H", "A", "L", KO, "gk")).resolves.toBeNull();
  });
});

describe("fetchNewsEnsemble", () => {
  it("returns null when no provider key is supplied", async () => {
    expect(await fetchNewsEnsemble("H", "A", "L", KO, {})).toBeNull();
    expect(scrapeMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses only the Google AI-Mode path when Perplexity key is absent", async () => {
    scrapeMock.mockResolvedValue({ text: "x", sources: ["https://s"], observedAt: OBSERVED });
    generateContentMock.mockResolvedValueOnce(g(RESHAPED));

    const res = await fetchNewsEnsemble("H", "A", "L", KO, { geminiKey: "gk" });
    expect(res?.model).toContain("google-ai-mode");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("merges both providers and boosts confidence when they agree on a fact", async () => {
    // Perplexity (fetch) returns the same injury as Google AI-Mode → agreement boost.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: RESHAPED } }],
        citations: ["https://pp"],
      }),
    });
    scrapeMock.mockResolvedValue({ text: "x", sources: ["https://g"], observedAt: OBSERVED });
    generateContentMock.mockResolvedValueOnce(g(RESHAPED));

    const res = await fetchNewsEnsemble("H", "A", "L", KO, {
      perplexityKey: "pk",
      geminiKey: "gk",
    });
    expect(res?.model).toBe("ensemble");
    // Both report the same injury + lineup → confidence boosted above the 0.7 base.
    expect(res?.confidence).toBeGreaterThan(0.7);
    // Sources unioned across providers.
    expect(res?.sources).toEqual(expect.arrayContaining(["https://pp", "https://g"]));
    // Injury deduped to a single entry despite both reporting it.
    expect(res?.injuries).toEqual(["Player X (Home) — out"]);
  });

  it("returns the single available result when only one provider yields data", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 }); // Perplexity fails
    scrapeMock.mockResolvedValue({ text: "x", sources: ["https://g"], observedAt: OBSERVED });
    generateContentMock.mockResolvedValueOnce(g(RESHAPED));

    const res = await fetchNewsEnsemble("H", "A", "L", KO, {
      perplexityKey: "pk",
      geminiKey: "gk",
    });
    expect(res?.model).toContain("google-ai-mode");
  });

  it("returns null when every provider yields nothing — never throws", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    scrapeMock.mockResolvedValue(null);
    await expect(
      fetchNewsEnsemble("H", "A", "L", KO, { perplexityKey: "pk", geminiKey: "gk" })
    ).resolves.toBeNull();
  });
});
