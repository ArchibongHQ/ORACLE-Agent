/** Persists the daily goals-ACCA selection (top picks / 39-leg lottery /
 *  mini-ACCA / Output B / Output C) to disk so apps/web can show it — the
 *  pipeline previously only ever sent this to Telegram/email, with no
 *  artifact a web route could read (worker → Telegram/email only, zero web
 *  surface). One file per date, overwritten on each run for that date. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GoalsSelectionResult } from "./selectGoals.js";

export interface GoalsArtifact {
  date: string;
  generatedAt: string;
  selection: GoalsSelectionResult;
}

/** Rejects anything but a strict YYYY-MM-DD date before it reaches a path
 *  join — `date` can originate from a web request (apps/web's /comment
 *  route passes user input through to here unvalidated), so this is the
 *  last line of defense against path traversal via a crafted date string. */
function artifactPath(date: string, outDir: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date for goals artifact: ${date}`);
  }
  return join(outDir, `goals-${date}.json`);
}

/** Writes the selection result for `date`. Best-effort: caller already has
 *  the result delivered via Telegram/email, so a write failure here must
 *  never be treated as the run having failed. */
export async function writeGoalsArtifact(
  selection: GoalsSelectionResult,
  date: string,
  outDir = ".tmp/goals"
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const path = artifactPath(date, outDir);
  const artifact: GoalsArtifact = { date, generatedAt: new Date().toISOString(), selection };
  await writeFile(path, JSON.stringify(artifact, null, 2), "utf8");
  return path;
}

/** Reads back the selection result for `date`. Returns null when no run has
 *  happened yet for that date (file absent) or the file is unreadable —
 *  never throws, since the web route treats this as "nothing to show yet". */
export async function readGoalsArtifact(
  date: string,
  outDir = ".tmp/goals"
): Promise<GoalsArtifact | null> {
  try {
    const raw = await readFile(artifactPath(date, outDir), "utf8");
    return JSON.parse(raw) as GoalsArtifact;
  } catch {
    return null;
  }
}
