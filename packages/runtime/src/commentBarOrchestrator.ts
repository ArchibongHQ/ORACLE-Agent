/** Comment-bar orchestration for apps/web's fixture-report upload flow.
 *
 *  A user uploads/identifies a previously-generated daily fixture report (the
 *  kind dailyFixtureReport.ts sends to Telegram) and types a plain-English
 *  instruction in a "comment bar." Per the WAT separation of concerns, the
 *  LLM never executes side effects directly — it only classifies the
 *  instruction into one of a small set of supported, deterministic actions
 *  plus their parameters; this module then runs that action itself. This
 *  keeps the agent in the decision-maker role and the runtime in the
 *  execution role, same as every other LLM call site in this pipeline.
 *
 *  Supported actions today: summarize the day's fixtures, filter the day's
 *  fixtures to one league, or re-run engine analysis for one named fixture.
 *  Anything else is reported back as "unsupported" rather than guessed at —
 *  the action vocabulary is meant to grow deliberately, not by LLM
 *  improvisation. */
import type { OracleConfig } from "@oracle/engine";
import { callClaudeCode, isLocalRuntime } from "@oracle/llm";
import type { StoragePort } from "@oracle/storage";
import { runAnalysis } from "./analyze.js";
import { fetchFixtureByName } from "./fixtures.js";
import { readGoalsArtifact } from "./goalsArtifact.js";
import { loadSportyBetIndex, type SportyBetEvent } from "./selectFixtures.js";

export type CommentBarActionType = "summarize" | "filter_league" | "reanalyze_fixture";

export interface CommentBarAction {
  action: CommentBarActionType | "unsupported";
  league?: string;
  home?: string;
  away?: string;
}

export interface CommentBarResult {
  understood: boolean;
  action: CommentBarActionType | "unsupported";
  resultText: string;
}

const INTERPRET_SYSTEM = `You classify a user's free-text instruction about a daily
football-fixture report into ONE of these actions:
- "summarize": give a plain-English summary of the day's fixtures/picks.
- "filter_league": show only fixtures from one named league. Extract the league name into "league".
- "reanalyze_fixture": re-run analysis for one named fixture. Extract team names into "home" and "away".
- "unsupported": the instruction doesn't map to any of the above.
Return ONLY valid JSON: {"action":"...","league":"...","home":"...","away":"..."}
Omit league/home/away keys that don't apply. Never invent a league or team name
that wasn't stated or clearly implied by the instruction.`;

function parseAction(text: string): CommentBarAction | null {
  try {
    const cleaned = text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const action = obj.action;
    if (
      action !== "summarize" &&
      action !== "filter_league" &&
      action !== "unsupported" &&
      action !== "reanalyze_fixture"
    )
      return null;
    return {
      action,
      league: typeof obj.league === "string" ? obj.league : undefined,
      home: typeof obj.home === "string" ? obj.home : undefined,
      away: typeof obj.away === "string" ? obj.away : undefined,
    };
  } catch {
    return null;
  }
}

/** Classifies the comment-bar instruction via the local Claude Code CLI.
 *  Returns null (not "unsupported") on any transport failure so the caller
 *  can distinguish "Claude Code unavailable" from "instruction not understood." */
async function interpretInstruction(instruction: string): Promise<CommentBarAction | null> {
  if (!isLocalRuntime()) return null;
  const raw = await callClaudeCode(`${INTERPRET_SYSTEM}\n\nInstruction: "${instruction}"`, {
    timeoutMs: 20_000,
  });
  if (!raw) return null;
  return parseAction(raw);
}

function summarizeFixtures(events: SportyBetEvent[]): string {
  if (!events.length) return "No fixtures found for this date.";
  const byLeague = new Map<string, number>();
  for (const e of events) {
    const league = e.league ?? "Unknown league";
    byLeague.set(league, (byLeague.get(league) ?? 0) + 1);
  }
  const lines = Array.from(byLeague.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([league, count]) => `${league}: ${count} fixture(s)`);
  return `${events.length} fixture(s) across ${byLeague.size} league(s).\n${lines.join("\n")}`;
}

function filterByLeague(events: SportyBetEvent[], league: string): string {
  const matches = events.filter((e) => e.league?.toLowerCase() === league.toLowerCase());
  if (!matches.length) return `No fixtures found in "${league}" for this date.`;
  return matches
    .map((e) => `${e.home} vs ${e.away} — ${(e.kickoff_utc ?? "").slice(0, 16).replace("T", " ")}`)
    .join("\n");
}

/** Runs the comment-bar instruction against the day's data for `date`
 *  (YYYY-MM-DD). `deps` is only required for "reanalyze_fixture" — the other
 *  actions only read from disk. Never throws: every failure mode (Claude Code
 *  unavailable, no data for date, unsupported instruction) is reported back
 *  in `resultText` so the web route always has something to render. */
export async function runCommentBarInstruction(
  instruction: string,
  date: string,
  deps?: { storage: StoragePort; config: OracleConfig }
): Promise<CommentBarResult> {
  const parsed = await interpretInstruction(instruction);
  if (!parsed) {
    return {
      understood: false,
      action: "unsupported",
      resultText: isLocalRuntime()
        ? 'Could not interpret that instruction — try rephrasing (e.g. "summarize today\'s fixtures" or "only show Premier League").'
        : "Claude Code is not available on this runtime — comment-bar orchestration requires the local Claude Code CLI.",
    };
  }

  if (parsed.action === "unsupported") {
    return {
      understood: true,
      action: "unsupported",
      resultText:
        "That instruction doesn't map to a supported action yet (summarize, filter by league, or re-analyze a fixture).",
    };
  }

  const index = await loadSportyBetIndex(date);
  const events = index?.events ?? [];

  if (parsed.action === "summarize") {
    const goals = await readGoalsArtifact(date);
    const goalsLine = goals
      ? `\n\nGoals-ACCA: top picks ${goals.selection.shortSlipLegs.length} leg(s), lottery ${goals.selection.legs.length} leg(s).`
      : "";
    return {
      understood: true,
      action: "summarize",
      resultText: `${summarizeFixtures(events)}${goalsLine}`,
    };
  }

  if (parsed.action === "filter_league") {
    if (!parsed.league) {
      return {
        understood: true,
        action: "filter_league",
        resultText: "Instruction implied a league filter but no league name was extracted.",
      };
    }
    return {
      understood: true,
      action: "filter_league",
      resultText: filterByLeague(events, parsed.league),
    };
  }

  // reanalyze_fixture
  if (!parsed.home || !parsed.away) {
    return {
      understood: true,
      action: "reanalyze_fixture",
      resultText: "Instruction implied re-analysis but no fixture (home/away) was extracted.",
    };
  }
  if (!deps) {
    return {
      understood: true,
      action: "reanalyze_fixture",
      resultText: "Re-analysis requires storage/config — not available in this context.",
    };
  }
  const job = await fetchFixtureByName(parsed.home, parsed.away, deps.config.oddsApiKey);
  if (!job) {
    return {
      understood: true,
      action: "reanalyze_fixture",
      resultText: `Could not find live odds for "${parsed.home} vs ${parsed.away}".`,
    };
  }
  const { reportHtml } = await runAnalysis([job], deps, {
    trigger: "manual",
    writeReportToDisk: false,
    includeFixtureEnrichment: true,
  });
  return { understood: true, action: "reanalyze_fixture", resultText: reportHtml };
}
