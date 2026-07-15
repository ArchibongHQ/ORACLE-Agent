/** Kimi K2.6 swarm worker (Moonshot AI, OpenAI-compatible API).
 *  Used as a cheap, capable sub-agent for the per-fixture decision swarm (Level-2).
 *  Each call is ONE independent analyst voting on the best pick from the eligible set.
 *
 *  Verified June 2026: model `kimi-k2.6`, base https://api.moonshot.ai/v1,
 *  OpenAI-compatible chat/completions; $0.60/$2.50 per 1M tokens; best HLE-Full tool-use (54.0).
 *  Never throws — returns null on any failure so the swarm degrades gracefully. */

import { callClaudeCode } from "./callClaudeCode.js";
import { callOpenRouter } from "./callOpenRouter.js";
import { MODELS } from "./cascade.js";

const ENDPOINT = "https://api.moonshot.ai/v1/chat/completions";

/** Per-call timeout. Without this, a hung Moonshot connection blocks the swarm's
 *  Promise.allSettled indefinitely (other voters resolve, this one never does). */
const REQUEST_TIMEOUT_MS = 20_000;

/** Shared swarm-worker system prompt — one independent analyst voting on the best pick. */
const VOTE_SYSTEM = `You are one independent betting analyst in a panel. Read the fixture analysis and eligible bets, then vote for the single best pick (or NO_EDGE if no pick is justified). Return ONLY valid JSON, no markdown:
{"pick":"<exact market label or NO_EDGE>","confidence":0.0,"rationale":"<one sentence>"}`;

/** One swarm worker's structured vote on a fixture. */
export interface KimiVote {
  pick: string; // market label the worker would back, or "NO_EDGE"
  confidence: number; // 0–1 self-reported confidence
  rationale: string;
  model: string;
}

/** Redact substrings shaped like secrets (bearer tokens, API keys, JWTs) before
 *  logging — a swarm-worker response/exception is not under this codebase's
 *  control and could echo back an Authorization header or key fragment.
 *  Mirrors callClaudeCode.ts's _redact (kept file-local — that helper is
 *  private to its own module). */
function _redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]{10,}/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]");
}

/** Prepare a diagnostic string for a log line: redact secret-shaped substrings,
 *  strip control/line-break characters, then truncate. Mirrors
 *  callClaudeCode.ts's _sanitizeForLog. */
function _sanitizeForLog(s: string, max = 300): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping C0 control chars from untrusted upstream output before logging
  const stripped = _redact(s.trim()).replace(/[\x00-\x1f\x7f\u2028\u2029\u0085]+/g, " ");
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
}

/** Log one diagnostic line for a callKimi failure branch, then return null —
 *  every failure path funnels through here, same convention as
 *  callClaudeCode.ts's _fail. */
function _fail(reason: string): null {
  process.stderr.write(`[callKimi] ${reason}\n`);
  return null;
}

/** Parse a swarm-worker JSON vote into a KimiVote. Returns null on any failure. */
function parseVote(text: string | null, model: string): KimiVote | null {
  if (!text) return _fail(`no text to parse (model=${model})`);
  try {
    const cleaned = text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return _fail(`no JSON object found in vote (model=${model})`);
    }

    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const pick = String(obj.pick ?? "").trim();
    if (!pick) return _fail(`empty pick field (model=${model})`);

    return {
      pick,
      confidence: Math.max(0, Math.min(1, Number(obj.confidence ?? 0.5))),
      rationale: String(obj.rationale ?? ""),
      model,
    };
  } catch (err) {
    return _fail(
      `JSON.parse threw (model=${model}): ${_sanitizeForLog(err instanceof Error ? err.message : String(err))}`
    );
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) return _fail(`HTTP ${resp.status} (model=${MODELS.KIMI_SWARM})`);

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parseVote(data.choices?.[0]?.message?.content ?? null, MODELS.KIMI_SWARM);
  } catch (err) {
    return _fail(
      `request failed (model=${MODELS.KIMI_SWARM}): ${_sanitizeForLog(err instanceof Error ? err.message : String(err))}`
    );
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

/** callClaudeCodeVote — single swarm-worker pick via the local Claude Code CLI
 *  (tier-0). Same vote parsing as callKimiVote/callOpenRouterVote, recorded as
 *  model "claude-code-local". No temperature control — the CLI samples at its
 *  account default — so callers should use this for at most one worker slot,
 *  not the whole panel, to keep the swarm's cross-worker diversity intact. */
export async function callClaudeCodeVote(prompt: string): Promise<KimiVote | null> {
  const text = await callClaudeCode(`${VOTE_SYSTEM}\n\n${prompt}`);
  return parseVote(text, "claude-code-local");
}
