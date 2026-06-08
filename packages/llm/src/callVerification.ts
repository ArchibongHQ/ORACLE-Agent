/** B2 — Claude Verification Layer (CVL).
 *  Spec: ORACLE_v2026_8_0.jsx lines 5239–5294.
 *  Adversarial review of chosen pick using Claude Sonnet.
 *  Returns { status, stamp, override? } — skipped when no Claude key. */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "./cascade.js";
import type { LLMCallContext } from "./types.js";

export type CvlStatus = "APPROVED" | "OVERRIDE" | "VETO" | "SKIPPED";

export interface CvlResult {
  status: CvlStatus;
  stamp: string; // ISO timestamp
  override?: string; // alternative pick label when status === 'OVERRIDE'
  rationale: string;
  model: string;
}

const CVL_SYSTEM = `You are an adversarial bet-verification agent.
You receive a proposed primary pick from ORACLE. Your job is to find flaws.
Return ONLY valid JSON: {"status":"APPROVED"|"OVERRIDE"|"VETO","rationale":"...","override":"optional alternative pick label"}
VETO: clear flaw (wrong market side, odds discrepancy, negative EV).
OVERRIDE: pick is sound but a clearly superior alternative exists (state it in override field).
APPROVED: pick is sound with no better alternative.`;

function parseCvlResponse(text: string): {
  status: CvlStatus;
  rationale: string;
  override?: string;
} {
  try {
    const cleaned = text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1)
      return { status: "APPROVED", rationale: "parse error — defaulting APPROVED" };
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const status = ["APPROVED", "OVERRIDE", "VETO"].includes(String(obj.status))
      ? (String(obj.status) as CvlStatus)
      : "APPROVED";
    return {
      status,
      rationale: String(obj.rationale ?? ""),
      override: obj.override ? String(obj.override) : undefined,
    };
  } catch {
    return { status: "APPROVED", rationale: "parse error — defaulting APPROVED" };
  }
}

/** callVerification — adversarial Claude Sonnet review of a proposed pick. */
export async function callVerification(prompt: string, ctx: LLMCallContext): Promise<CvlResult> {
  if (!ctx.config.claudeApiKey) {
    return {
      status: "SKIPPED",
      stamp: new Date().toISOString(),
      rationale: "no Claude key",
      model: "none",
    };
  }

  try {
    const client = new Anthropic({ apiKey: ctx.config.claudeApiKey });
    const resp = await client.messages.create({
      model: MODELS.CLAUDE_SONNET,
      max_tokens: 1024,
      temperature: 0,
      system: CVL_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    const parsed = parseCvlResponse(text);
    return { ...parsed, stamp: new Date().toISOString(), model: MODELS.CLAUDE_SONNET };
  } catch (err) {
    return {
      status: "SKIPPED",
      stamp: new Date().toISOString(),
      rationale: `CVL error: ${err instanceof Error ? err.message : String(err)}`,
      model: MODELS.CLAUDE_SONNET,
    };
  }
}
