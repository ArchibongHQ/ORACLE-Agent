/** Kimi K2.6 swarm worker (Moonshot AI, OpenAI-compatible API).
 *  Used as a cheap, capable sub-agent for the per-fixture decision swarm (Level-2).
 *  Each call is ONE independent analyst voting on the best pick from the eligible set.
 *
 *  Verified June 2026: model `kimi-k2.6`, base https://api.moonshot.ai/v1,
 *  OpenAI-compatible chat/completions; $0.60/$2.50 per 1M tokens; best HLE-Full tool-use (54.0).
 *  Never throws — returns null on any failure so the swarm degrades gracefully. */

import { callOpenRouter } from "./callOpenRouter.js";
import { MODELS } from "./cascade.js";

const ENDPOINT = "https://api.moonshot.ai/v1/chat/completions";

/** Shared swarm-worker system prompt — one independent analyst voting on the best pick. */
const VOTE_SYSTEM = `You are one independent betting analyst in a panel. Read the fixture analysis and eligible bets, then vote for the single best pick (or NO_BET). Return ONLY valid JSON, no markdown:
{"pick":"<exact market label or NO_BET>","confidence":0.0,"rationale":"<one sentence>"}`;

/** One swarm worker's structured vote on a fixture. */
export interface KimiVote {
  pick: string; // market label the worker would back, or "NO_BET"
  confidence: number; // 0–1 self-reported confidence
  rationale: string;
  model: string;
}

/** Parse a swarm-worker JSON vote into a KimiVote. Returns null on any failure. */
function parseVote(text: string | null, model: string): KimiVote | null {
  if (!text) return null;
  try {
    const cleaned = text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return null;

    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const pick = String(obj.pick ?? "").trim();
    if (!pick) return null;

    return {
      pick,
      confidence: Math.max(0, Math.min(1, Number(obj.confidence ?? 0.5))),
      rationale: String(obj.rationale ?? ""),
      model,
    };
  } catch {
    return null;
  }
}

/** callKimiVote — single swarm-worker pick. `prompt` should contain the full
 *  fixture context + eligible bets (the caller builds it). Returns null on failure. */
export async function callKimiVote(
  prompt: string,
  apiKey: string,
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<KimiVote | null> {
  if (!apiKey) return null;

  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODELS.KIMI_SWARM,
        messages: [
          { role: "system", content: VOTE_SYSTEM },
          { role: "user", content: prompt },
        ],
        temperature: opts.temperature ?? 0.4, // slight diversity across workers
        max_tokens: opts.maxTokens ?? 512,
      }),
    });
    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parseVote(data.choices?.[0]?.message?.content ?? null, MODELS.KIMI_SWARM);
  } catch {
    return null;
  }
}

/** callOpenRouterVote — single swarm-worker pick via an OpenRouter model.
 *  Same prompt + parsing as callKimiVote, but `model` is the passed OpenRouter model ID.
 *  Never throws; returns null on failure. */
export async function callOpenRouterVote(
  prompt: string,
  model: string,
  apiKey: string,
  opts: { temperature?: number } = {}
): Promise<KimiVote | null> {
  const text = await callOpenRouter(
    [
      { role: "system", content: VOTE_SYSTEM },
      { role: "user", content: prompt },
    ],
    model,
    apiKey,
    { temperature: opts.temperature ?? 0.4, maxTokens: 512 }
  );
  return parseVote(text, model);
}
