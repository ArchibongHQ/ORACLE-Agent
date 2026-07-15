/** T0 — News / team intelligence layer.
 *  Complements Gemini acquisition: Gemini grounding finds ODDS; this layer finds NEWS —
 *  injury confirmations, suspensions, lineup leaks, motivation + travel flags, with citations.
 *
 *  Three acquisition paths, merged by `fetchNewsEnsemble`:
 *    1. Perplexity Sonar (OpenAI-compatible) — when PERPLEXITY_API_KEY is set.
 *    2. Google "AI Mode" scrape (Playwright, keyless) → reshaped via Gemini Flash.
 *    3. Google "AI Mode" scrape (Playwright, keyless) → reshaped via Claude Haiku —
 *       activated when claudeKey is present and geminiKey is absent; same scrape, different
 *       reshape model. This makes the tier fully functional with CLAUDE_API_KEY alone.
 *
 *  Every path returns null on failure — NEVER throws. Missing API key is NEVER a blocker:
 *  the Playwright scrape is keyless; only the reshape step needs a key, and Claude satisfies
 *  that requirement on its own. */

import { GoogleGenAI } from "@google/genai";
import { scrapeGoogleAiMode } from "@oracle/research";
import { callClaudeCode, isLocalRuntime } from "./callClaudeCode.js";
import { MODELS } from "./cascade.js";

export interface NewsIntelResult {
  injuries: string[]; // confirmed absences
  suspensions: string[]; // confirmed bans
  lineupHints: string[]; // pre-match confirmed starters / formation
  motivationFlags: string[]; // trophy chase, relegation pressure, cup hangover
  travelFlags: string[]; // back-to-back away legs, long travel
  sources: string[]; // citation URLs
  confidence: number; // 0–1; low = no relevant news found
  model: string; // provider/model that produced this result
  observedAt: string; // ISO timestamp of acquisition (recency anchor)
}

const ENDPOINT = "https://api.perplexity.ai/chat/completions";
const MIN_CONFIDENCE = 0.4;

const SYSTEM = `You are a football pre-match intelligence researcher. Search current sources for team news within 48 hours of kickoff. Report ONLY confirmed, sourced facts — never speculate. Return ONLY valid JSON, no markdown.`;

function buildPrompt(home: string, away: string, league: string, kickoff: string): string {
  const date = kickoff.slice(0, 10);
  return `Find confirmed pre-match team news for: ${home} vs ${away} (${league}, ${date}).
Report only facts confirmed by reputable sources within 48h of the match.
Return ONLY this JSON shape:
{
  "injuries": ["<player> (<team>) — <status>"],
  "suspensions": ["<player> (<team>) — suspended"],
  "lineupHints": ["<confirmed starter or formation note>"],
  "motivationFlags": ["<trophy chase / relegation battle / dead rubber / cup hangover>"],
  "travelFlags": ["<long travel or congested fixtures note>"],
  "confidence": 0.0
}
confidence: 0.0 if no relevant news found, up to 1.0 if multiple confirmed reports. Empty arrays are fine.`;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 12) : [];
}

/** Redact substrings shaped like secrets (bearer tokens, API keys, JWTs) before
 *  logging. This file is the one place in the pipeline that logs raw
 *  Playwright-scraped web content and third-party API error text verbatim —
 *  neither is under this codebase's control, so both must be scrubbed before
 *  reaching a log line. Mirrors callClaudeCode.ts's _redact (kept file-local
 *  — that helper is private to its own module). */
function _redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]{10,}/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]");
}

/** Prepare a diagnostic string for a log line: redact secret-shaped
 *  substrings, strip control characters and Unicode line-breaking code
 *  points (a scraped web page or an LLM reshape response is untrusted input
 *  that could otherwise smuggle in fake `[callNewsIntel]`-prefixed lines),
 *  then truncate. Mirrors callClaudeCode.ts's _sanitizeForLog. */
function _sanitizeForLog(s: string, max = 300): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping C0 control chars from untrusted scraped/upstream content before logging
  const stripped = _redact(s.trim()).replace(/[\x00-\x1f\x7f\u2028\u2029\u0085]+/g, " ");
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
}

/** Log one diagnostic line for a callNewsIntel failure branch, then return
 *  null — every acquisition-path failure funnels through here, same
 *  convention as callClaudeCode.ts's _fail. "No work to do" preconditions
 *  (missing key, wrong runtime, no providers configured) and low-confidence
 *  "no relevant news found" outcomes are deliberately NOT routed through
 *  this — those are expected non-failure outcomes per this file's own
 *  contract (see MIN_CONFIDENCE doc), not a rung that tried and failed. */
function _fail(reason: string): null {
  process.stderr.write(`[callNewsIntel] ${reason}\n`);
  return null;
}

interface SonarResponse {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
}

async function callSonar(
  model: string,
  apiKey: string,
  prompt: string
): Promise<{ content: string; citations: string[] } | null> {
  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
      temperature: 0,
    }),
  });
  if (!resp.ok) return _fail(`sonar HTTP ${resp.status} (model=${model})`);
  const data = (await resp.json()) as SonarResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) return _fail(`sonar empty response content (model=${model})`);
  return { content, citations: Array.isArray(data.citations) ? data.citations : [] };
}

/** fetchNewsIntelligence — T0 entry point. Non-fatal; returns null on any failure. */
export async function fetchNewsIntelligence(
  home: string,
  away: string,
  league: string,
  kickoff: string,
  apiKey: string
): Promise<NewsIntelResult | null> {
  if (!apiKey) return null;

  const prompt = buildPrompt(home, away, league, kickoff);
  const models = ["sonar-pro", "sonar"];

  for (const model of models) {
    try {
      const result = await callSonar(model, apiKey, prompt);
      if (!result) continue;

      const cleaned = result.content
        .replace(/```(?:json)?\s*/gi, "")
        .replace(/```\s*/g, "")
        .trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1 || end === -1) {
        _fail(`no JSON object found in sonar content (model=${model})`);
        continue;
      }

      const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      const confidence = Math.max(0, Math.min(1, Number(obj.confidence ?? 0)));
      if (confidence < MIN_CONFIDENCE) return null;

      return {
        injuries: asStringArray(obj.injuries),
        suspensions: asStringArray(obj.suspensions),
        lineupHints: asStringArray(obj.lineupHints),
        motivationFlags: asStringArray(obj.motivationFlags),
        travelFlags: asStringArray(obj.travelFlags),
        sources: result.citations.slice(0, 10),
        confidence,
        model: `perplexity-${model}`,
        observedAt: new Date().toISOString(),
      };
    } catch (err) {
      _fail(
        `sonar cascade (model=${model}): ${_sanitizeForLog(err instanceof Error ? err.message : String(err))}`
      );
      // cascade to next model
    }
  }

  _fail("perplexity sonar cascade exhausted (sonar-pro, sonar)");
  return null;
}

const GEMINI_RESHAPE_SYSTEM = `You are a football pre-match intelligence extractor. You are given raw search-result prose about a match. Extract ONLY confirmed, sourced facts into the requested JSON. Never speculate. Return ONLY valid JSON, no markdown.`;

/** fetchNewsViaGoogleAiMode — keyless scrape + reshape via Gemini Flash.
 *  Scrapes Google "AI Mode" (Playwright, no API key needed) then reshapes the
 *  prose into the exact NewsIntelResult JSON via Gemini. Non-fatal → null. */
export async function fetchNewsViaGoogleAiMode(
  home: string,
  away: string,
  league: string,
  kickoff: string,
  geminiKey: string
): Promise<NewsIntelResult | null> {
  if (!geminiKey) return null;

  const date = kickoff.slice(0, 10);
  const query = `${home} vs ${away} ${league} ${date} confirmed team news injuries suspensions lineup`;

  const scraped = await scrapeGoogleAiMode(query);
  if (!scraped?.text) return _fail("Google AI-Mode scrape yielded no text");

  const reshapePrompt = `${buildPrompt(home, away, league, kickoff)}

Use ONLY the following researched prose as your source material (do not invent facts beyond it):
"""
${scraped.text}
"""`;

  const ai = new GoogleGenAI({ apiKey: geminiKey });
  const cascade = [MODELS.GEMINI_FLASH, MODELS.GEMINI_FLASH_LITE];

  for (const modelId of cascade) {
    try {
      const result = await ai.models.generateContent({
        model: modelId,
        contents: `${GEMINI_RESHAPE_SYSTEM}\n\n${reshapePrompt}`,
        config: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
      });

      const text = (result.text ?? "").trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        _fail(`Gemini reshape produced no JSON object (model=${modelId})`);
        continue;
      }

      const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const confidence = Math.max(0, Math.min(1, Number(obj.confidence ?? 0)));
      if (confidence < MIN_CONFIDENCE) return null;

      return {
        injuries: asStringArray(obj.injuries),
        suspensions: asStringArray(obj.suspensions),
        lineupHints: asStringArray(obj.lineupHints),
        motivationFlags: asStringArray(obj.motivationFlags),
        travelFlags: asStringArray(obj.travelFlags),
        sources: scraped.sources.slice(0, 10),
        confidence,
        model: `google-ai-mode-${modelId}`,
        observedAt: scraped.observedAt,
      };
    } catch (err) {
      _fail(
        `Gemini reshape cascade (model=${modelId}): ${_sanitizeForLog(err instanceof Error ? err.message : String(err))}`
      );
      // cascade to next model
    }
  }

  _fail("Gemini reshape cascade exhausted (GEMINI_FLASH, GEMINI_FLASH_LITE)");
  return null;
}

/** fetchNewsViaClaudeReshape — local-CLI alternative to the Gemini reshape path.
 *  Same Playwright scrape (keyless), reshape via `claude -p` (the local Claude Code
 *  CLI — same transport as goalsScreen.ts). No API key needed in the function:
 *  the CLI uses the account session the machine is already logged into.
 *  Only runs when the local Claude runtime is available (isLocalRuntime() check). */
export async function fetchNewsViaClaudeReshape(
  home: string,
  away: string,
  league: string,
  kickoff: string
): Promise<NewsIntelResult | null> {
  if (!isLocalRuntime()) return null;

  const date = kickoff.slice(0, 10);
  const query = `${home} vs ${away} ${league} ${date} confirmed team news injuries suspensions lineup`;

  const scraped = await scrapeGoogleAiMode(query);
  if (!scraped?.text) return _fail("Google AI-Mode scrape yielded no text");

  const reshapePrompt = `${GEMINI_RESHAPE_SYSTEM}

${buildPrompt(home, away, league, kickoff)}

Use ONLY the following researched prose as your source material (do not invent facts beyond it):
"""
${scraped.text}
"""`;

  try {
    const text = await callClaudeCode(reshapePrompt, {
      model: MODELS.CLAUDE_HAIKU,
      timeoutMs: 20_000,
    });
    if (!text) return _fail("Claude local-CLI reshape produced no text");

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return _fail("Claude local-CLI reshape produced no JSON object");

    const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const confidence = Math.max(0, Math.min(1, Number(obj.confidence ?? 0)));
    if (confidence < MIN_CONFIDENCE) return null;

    return {
      injuries: asStringArray(obj.injuries),
      suspensions: asStringArray(obj.suspensions),
      lineupHints: asStringArray(obj.lineupHints),
      motivationFlags: asStringArray(obj.motivationFlags),
      travelFlags: asStringArray(obj.travelFlags),
      sources: scraped.sources.slice(0, 10),
      confidence,
      model: "claude-local-reshape",
      observedAt: scraped.observedAt,
    };
  } catch (err) {
    _fail(
      `Claude local-CLI reshape: ${_sanitizeForLog(err instanceof Error ? err.message : String(err))}`
    );
    return null;
  }
}

/** Merge two NewsIntelResults: union items, prefer more-recent observedAt, and
 *  boost confidence when both providers independently report the same fact
 *  (ensemble verification). */
function mergeResults(a: NewsIntelResult, b: NewsIntelResult): NewsIntelResult {
  const dedupe = (xs: string[]): string[] =>
    Array.from(new Set(xs.map((s) => s.trim()).filter(Boolean)));
  const agreement = (xs: string[], ys: string[]): number => {
    const ly = ys.map((y) => y.toLowerCase());
    return xs.filter((x) =>
      ly.some((y) => y.includes(x.toLowerCase()) || x.toLowerCase().includes(y))
    ).length;
  };

  const overlaps =
    agreement(a.injuries, b.injuries) +
    agreement(a.suspensions, b.suspensions) +
    agreement(a.lineupHints, b.lineupHints);

  // Base on the stronger result, then boost for cross-provider agreement.
  const base = Math.max(a.confidence, b.confidence);
  const boost = Math.min(0.2, overlaps * 0.05);
  const confidence = Math.min(1, base + boost);

  const newer = a.observedAt >= b.observedAt ? a : b;

  return {
    injuries: dedupe([...a.injuries, ...b.injuries]),
    suspensions: dedupe([...a.suspensions, ...b.suspensions]),
    lineupHints: dedupe([...a.lineupHints, ...b.lineupHints]),
    motivationFlags: dedupe([...a.motivationFlags, ...b.motivationFlags]),
    travelFlags: dedupe([...a.travelFlags, ...b.travelFlags]),
    sources: dedupe([...a.sources, ...b.sources]).slice(0, 14),
    confidence,
    model: "ensemble",
    observedAt: newer.observedAt,
  };
}

/** fetchNewsEnsemble — run available providers in parallel and merge with
 *  recency + agreement weighting.
 *  Priority order: Perplexity (if key) → Google AI-Mode/Gemini (if geminiKey) →
 *  Google AI-Mode/Claude-local (if local runtime available and no geminiKey —
 *  avoids a duplicate Playwright scrape). No Perplexity or Gemini key needed:
 *  the local-CLI path makes the tier functional on the owner's machine alone. */
export async function fetchNewsEnsemble(
  home: string,
  away: string,
  league: string,
  kickoff: string,
  opts: { perplexityKey?: string; geminiKey?: string }
): Promise<NewsIntelResult | null> {
  const tasks: Array<Promise<NewsIntelResult | null>> = [];
  if (opts.perplexityKey)
    tasks.push(fetchNewsIntelligence(home, away, league, kickoff, opts.perplexityKey));
  if (opts.geminiKey)
    tasks.push(fetchNewsViaGoogleAiMode(home, away, league, kickoff, opts.geminiKey));
  // Local-CLI Claude path: only when Gemini key absent (avoids duplicate Playwright scrape).
  if (!opts.geminiKey) tasks.push(fetchNewsViaClaudeReshape(home, away, league, kickoff));
  if (!tasks.length) return null;

  const settled = await Promise.allSettled(tasks);
  for (const s of settled) {
    // Every provider in this ensemble documents itself as "never throws —
    // returns null on failure". A rejection here means that contract was
    // violated, which is exactly the kind of silent, unreconstructable
    // failure this instrumentation exists to catch.
    if (s.status === "rejected") {
      _fail(
        `provider promise rejected (never-throws contract violated): ${_sanitizeForLog(s.reason instanceof Error ? s.reason.message : String(s.reason))}`
      );
    }
  }
  const results = settled
    .filter((s): s is PromiseFulfilledResult<NewsIntelResult | null> => s.status === "fulfilled")
    .map((s) => s.value)
    .filter((r): r is NewsIntelResult => r !== null);

  if (!results.length) return _fail("all configured providers returned no result");
  if (results.length === 1) return results[0] ?? null;

  return results.reduce((acc, r) => mergeResults(acc, r));
}
