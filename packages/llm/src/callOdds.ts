/** Gemini-powered odds acquisition for fixtures not covered by the Odds API.
 *  Uses Google Search grounding to find consensus 1X2 odds from multiple bookmakers.
 *  Returns null when confidence is too low — caller falls back to no-odds path. */

import { GoogleGenAI } from '@google/genai';
import type { LLMCallContext } from './types.js';
import { MODELS } from './cascade.js';

export interface OddsAcquisitionResult {
  home: number;
  draw: number;
  away: number;
  /** 0–1 confidence score based on source count and agreement */
  confidence: number;
  sources: string[];
  overround: number;
}

const MIN_CONFIDENCE  = 0.65;
const MAX_OVERROUND   = 0.18;  // reject if implied probs sum > 1.18 (too much juice)
const MIN_OVERROUND   = 0.03;  // reject if sum < 1.03 (looks fabricated)
const MAX_PRICE_DRIFT = 0.06;  // reject if any single price differs >6% across sources

/** Ask Gemini (with Search grounding) for 1X2 odds on a single fixture.
 *  Cascade: Flash → Flash-Lite. Returns null on failure or low confidence. */
export async function fetchOddsViaGemini(
  home: string,
  away: string,
  league: string,
  kickoff: string,
  ctx: LLMCallContext,
): Promise<OddsAcquisitionResult | null> {
  if (!ctx.config.geminiApiKey) return null;

  const ai = new GoogleGenAI({ apiKey: ctx.config.geminiApiKey });
  const date = kickoff.slice(0, 10);

  const prompt = `You are a sports odds research assistant. Find the current 1X2 (Home Win / Draw / Away Win) decimal odds for this football match from at least 2 different bookmakers.

Match: ${home} vs ${away}
League: ${league}
Date: ${date}

Search for odds on sites like bet365, William Hill, Betway, SportyBet, 1xBet, Unibet, or any other bookmaker. Return ONLY a JSON object with this exact shape — no markdown, no explanation:

{
  "home_odds": [<decimal from source 1>, <decimal from source 2>],
  "draw_odds": [<decimal from source 1>, <decimal from source 2>],
  "away_odds": [<decimal from source 1>, <decimal from source 2>],
  "sources": ["<bookmaker name 1>", "<bookmaker name 2>"]
}

If you cannot find odds from at least 2 sources, return: {"error": "insufficient_sources"}`;

  const cascade = [MODELS.GEMINI_FLASH, MODELS.GEMINI_FLASH_LITE];

  for (const modelId of cascade) {
    try {
      const result = await ai.models.generateContent({
        model: modelId,
        contents: prompt,
        config: {
          temperature: 0,
          thinkingConfig: { thinkingBudget: 0 },
          tools: [{ googleSearch: {} }],
        },
      });

      const text = (result.text ?? '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const parsed = JSON.parse(jsonMatch[0]) as {
        error?: string;
        home_odds?: number[];
        draw_odds?: number[];
        away_odds?: number[];
        sources?: string[];
      };

      if (parsed.error) return null;

      const homeOdds = parsed.home_odds;
      const drawOdds = parsed.draw_odds;
      const awayOdds = parsed.away_odds;
      const sources  = parsed.sources ?? [];

      if (!homeOdds?.length || !drawOdds?.length || !awayOdds?.length) continue;
      if (homeOdds.length < 2 || sources.length < 2) return null;

      // Validate all values are plausible decimal odds (1.01–50)
      const allOdds = [...homeOdds, ...drawOdds, ...awayOdds];
      if (allOdds.some(o => typeof o !== 'number' || o < 1.01 || o > 50)) continue;

      // Check price drift across sources — reject if any market drifts >6%
      const maxDrift = (arr: number[]) => (Math.max(...arr) - Math.min(...arr)) / Math.min(...arr);
      if (maxDrift(homeOdds) > MAX_PRICE_DRIFT) continue;
      if (maxDrift(drawOdds) > MAX_PRICE_DRIFT) continue;
      if (maxDrift(awayOdds) > MAX_PRICE_DRIFT) continue;

      // Consensus = mean across sources
      const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const h = mean(homeOdds);
      const d = mean(drawOdds);
      const a = mean(awayOdds);

      // Validate overround
      const impliedSum = 1 / h + 1 / d + 1 / a;
      const overround = impliedSum - 1;
      if (overround < MIN_OVERROUND || overround > MAX_OVERROUND) continue;

      // Confidence: base 0.5 + 0.1 per source beyond 2 + 0.1 for tight drift
      const driftBonus = (maxDrift(homeOdds) + maxDrift(drawOdds) + maxDrift(awayOdds)) / 3 < 0.02 ? 0.1 : 0;
      const confidence = Math.min(0.95, 0.5 + Math.min(0.3, (sources.length - 2) * 0.1) + driftBonus + 0.05 * Math.min(4, sources.length));

      if (confidence < MIN_CONFIDENCE) return null;

      return { home: h, draw: d, away: a, confidence, sources, overround };

    } catch {
      // cascade to next model
    }
  }

  return null;
}
