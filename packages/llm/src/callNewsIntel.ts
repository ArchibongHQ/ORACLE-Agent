/** T0 — News / team intelligence layer (Perplexity Sonar).
 *  Complements Gemini acquisition: Gemini grounding finds ODDS; Sonar finds NEWS —
 *  injury confirmations, suspensions, lineup leaks, motivation + travel flags, with citations.
 *
 *  OpenAI-compatible endpoint (https://api.perplexity.ai/chat/completions).
 *  Primary model: sonar-pro; falls back to sonar on error.
 *  Returns null when no key, low confidence (<0.4), or any failure — NEVER throws.
 *  Verified June 2026: sonar/sonar-pro current; $1/$1 and $3/$15 per 1M tokens. */

export interface NewsIntelResult {
  injuries: string[];          // confirmed absences
  suspensions: string[];       // confirmed bans
  lineupHints: string[];       // pre-match confirmed starters / formation
  motivationFlags: string[];   // trophy chase, relegation pressure, cup hangover
  travelFlags: string[];       // back-to-back away legs, long travel
  sources: string[];           // Perplexity citation URLs
  confidence: number;          // 0–1; low = no relevant news found
  model: string;
}

const ENDPOINT = 'https://api.perplexity.ai/chat/completions';
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

interface SonarResponse {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
}

async function callSonar(
  model: string,
  apiKey: string,
  prompt: string,
): Promise<{ content: string; citations: string[] } | null> {
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
    }),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as SonarResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;
  return { content, citations: Array.isArray(data.citations) ? data.citations : [] };
}

/** fetchNewsIntelligence — T0 entry point. Non-fatal; returns null on any failure. */
export async function fetchNewsIntelligence(
  home: string,
  away: string,
  league: string,
  kickoff: string,
  apiKey: string,
): Promise<NewsIntelResult | null> {
  if (!apiKey) return null;

  const prompt = buildPrompt(home, away, league, kickoff);
  const models = ['sonar-pro', 'sonar'];

  for (const model of models) {
    try {
      const result = await callSonar(model, apiKey, prompt);
      if (!result) continue;

      const cleaned = result.content
        .replace(/```(?:json)?\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start === -1 || end === -1) continue;

      const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      const confidence = Math.max(0, Math.min(1, Number(obj['confidence'] ?? 0)));
      if (confidence < MIN_CONFIDENCE) return null;

      return {
        injuries:        asStringArray(obj['injuries']),
        suspensions:     asStringArray(obj['suspensions']),
        lineupHints:     asStringArray(obj['lineupHints']),
        motivationFlags: asStringArray(obj['motivationFlags']),
        travelFlags:     asStringArray(obj['travelFlags']),
        sources:         result.citations.slice(0, 10),
        confidence,
        model,
      };
    } catch {
      // cascade to next model
    }
  }

  return null;
}
