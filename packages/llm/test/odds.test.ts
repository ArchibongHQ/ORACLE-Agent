/** fetchOddsViaGemini — odds bounds (1.01–50), price drift, overround validation, model
 *  cascade (Flash → Flash-Lite → knowledge fallback on gemini-2.0-flash), null terminals. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOddsViaGemini } from "../src/callOdds.js";
import { MODELS } from "../src/cascade.js";
import { calledModels, makeCtx } from "./helpers.js";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

// Hardcoded in callOdds.ts (knowledge-based fallback) — not part of the cascade constants.
const FALLBACK_MODEL = "gemini-2.0-flash";

const ctx = makeCtx({ geminiApiKey: "gk" });
const KO = "2026-06-12T15:00:00Z";

function g(text: string) {
  return { text };
}

const VALID_TWO_SOURCE = JSON.stringify({
  home_odds: [2.0, 2.0],
  draw_odds: [3.4, 3.4],
  away_odds: [3.6, 3.6],
  sources: ["bet365", "betway"],
});

const FALLBACK_VALID = '{"home":2.1,"draw":3.3,"away":3.5}';

beforeEach(() => {
  generateContentMock.mockReset();
});

describe("fetchOddsViaGemini — happy paths", () => {
  it("returns consensus means + confidence for clean two-source odds", async () => {
    generateContentMock.mockResolvedValueOnce(g(VALID_TWO_SOURCE));
    const res = await fetchOddsViaGemini("H", "A", "L", KO, ctx);
    expect(res).toMatchObject({ home: 2.0, draw: 3.4, away: 3.6 });
    expect(res?.sources).toEqual(["bet365", "betway"]);
    expect(res?.confidence).toBeCloseTo(0.7);
    expect(res?.overround).toBeCloseTo(1 / 2.0 + 1 / 3.4 + 1 / 3.6 - 1);
    expect(calledModels(generateContentMock)).toEqual([MODELS.GEMINI_FLASH]);
  });

  it("accepts single-source odds with confidence 0.7", async () => {
    generateContentMock.mockResolvedValueOnce(
      g('{"home_odds":[2.0],"draw_odds":[3.4],"away_odds":[3.6],"sources":["bet365"]}')
    );
    const res = await fetchOddsViaGemini("H", "A", "L", KO, ctx);
    expect(res?.confidence).toBeCloseTo(0.7);
    expect(res?.sources).toEqual(["bet365"]);
  });
});

describe("fetchOddsViaGemini — validation gates", () => {
  it("returns null without any call when the Gemini key is absent", async () => {
    expect(await fetchOddsViaGemini("H", "A", "L", KO, makeCtx())).toBeNull();
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("rejects odds outside 1.01–50 on both cascade tiers, then uses the fallback", async () => {
    const bad = JSON.stringify({
      home_odds: [60, 60],
      draw_odds: [3.4, 3.4],
      away_odds: [3.6, 3.6],
      sources: ["a", "b"],
    });
    generateContentMock
      .mockResolvedValueOnce(g(bad))
      .mockResolvedValueOnce(g(bad))
      .mockResolvedValueOnce(g(FALLBACK_VALID));
    const res = await fetchOddsViaGemini("H", "A", "L", KO, ctx);
    expect(res).toMatchObject({ home: 2.1, draw: 3.3, away: 3.5, confidence: 0.65 });
    expect(res?.sources).toEqual(["gemini-estimate"]);
    expect(calledModels(generateContentMock)).toEqual([
      MODELS.GEMINI_FLASH,
      MODELS.GEMINI_FLASH_LITE,
      FALLBACK_MODEL,
    ]);
  });

  it("goes straight to the fallback on an insufficient_sources error", async () => {
    generateContentMock
      .mockResolvedValueOnce(g('{"error":"insufficient_sources"}'))
      .mockResolvedValueOnce(g(FALLBACK_VALID));
    const res = await fetchOddsViaGemini("H", "A", "L", KO, ctx);
    expect(res?.sources).toEqual(["gemini-estimate"]);
    expect(calledModels(generateContentMock)).toEqual([MODELS.GEMINI_FLASH, FALLBACK_MODEL]);
  });

  it("returns null directly when drift pushes confidence below 0.65 — no fallback", async () => {
    // home drift 10% (< MAX_PRICE_DRIFT 12%) but mean drift > 2% → no bonus → conf 0.6
    generateContentMock.mockResolvedValueOnce(
      g(
        JSON.stringify({
          home_odds: [2.0, 2.2],
          draw_odds: [3.4, 3.4],
          away_odds: [3.6, 3.6],
          sources: ["a", "b"],
        })
      )
    );
    expect(await fetchOddsViaGemini("H", "A", "L", KO, ctx)).toBeNull();
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("rejects drift >12% on a single price and cascades to the next model", async () => {
    generateContentMock
      .mockResolvedValueOnce(
        g(
          JSON.stringify({
            home_odds: [2.0, 2.4],
            draw_odds: [3.4, 3.4],
            away_odds: [3.6, 3.6],
            sources: ["a", "b"],
          })
        )
      )
      .mockResolvedValueOnce(g(VALID_TWO_SOURCE));
    const res = await fetchOddsViaGemini("H", "A", "L", KO, ctx);
    expect(res?.home).toBe(2.0);
    expect(calledModels(generateContentMock)).toEqual([
      MODELS.GEMINI_FLASH,
      MODELS.GEMINI_FLASH_LITE,
    ]);
  });

  it("rejects an implausible overround (implied sum < 1.02) and cascades", async () => {
    generateContentMock
      .mockResolvedValueOnce(
        g('{"home_odds":[2.6],"draw_odds":[3.9],"away_odds":[3.4],"sources":["a"]}')
      )
      .mockResolvedValueOnce(g(VALID_TWO_SOURCE));
    const res = await fetchOddsViaGemini("H", "A", "L", KO, ctx);
    expect(res?.home).toBe(2.0);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when fields are missing, tier 2 has no JSON, and the fallback throws", async () => {
    generateContentMock
      .mockResolvedValueOnce(g('{"home_odds":[2.0],"draw_odds":[3.4],"sources":["a"]}'))
      .mockResolvedValueOnce(g("no json here"))
      .mockRejectedValueOnce(new Error("down"));
    expect(await fetchOddsViaGemini("H", "A", "L", KO, ctx)).toBeNull();
    expect(generateContentMock).toHaveBeenCalledTimes(3);
  });

  it("returns null when the fallback emits out-of-bounds odds", async () => {
    generateContentMock
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValueOnce(g('{"home":0.9,"draw":3.3,"away":3.5}'));
    expect(await fetchOddsViaGemini("H", "A", "L", KO, ctx)).toBeNull();
  });
});
