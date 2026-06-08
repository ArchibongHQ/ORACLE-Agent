/** Shared daily punt-state file: .tmp/punt/<date>.json.
 *  The worker writes { promptedAt, fulfilled:false } at 10:00 and re-prompts at 12:00/13:00
 *  only while fulfilled === false. The bot / web / CLI call markFulfilled() once a code is
 *  processed so the retry prompts stop. Best-effort — failures never throw. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PuntDayState {
  date: string;
  promptedAt: string | null;
  fulfilled: boolean;
  lastCode?: string;
  lastResultAt?: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function stateFile(root: string, date: string): string {
  return join(root, ".tmp", "punt", `${date}.json`);
}

export function readPuntState(root: string, date = today()): PuntDayState {
  const file = stateFile(root, date);
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as PuntDayState;
  } catch {
    /* fall through to default */
  }
  return { date, promptedAt: null, fulfilled: false };
}

function writePuntState(root: string, state: PuntDayState): void {
  try {
    mkdirSync(join(root, ".tmp", "punt"), { recursive: true });
    writeFileSync(stateFile(root, state.date), JSON.stringify(state), "utf8");
  } catch {
    /* best-effort */
  }
}

/** Record that today's prompt was sent. Idempotent on date. */
export function markPrompted(root: string, date = today()): PuntDayState {
  const state = readPuntState(root, date);
  if (!state.promptedAt) state.promptedAt = new Date().toISOString();
  writePuntState(root, state);
  return state;
}

/** Mark today fulfilled so retry prompts stop. */
export function markFulfilled(root: string, code: string, date = today()): void {
  const state = readPuntState(root, date);
  state.fulfilled = true;
  state.lastCode = code;
  state.lastResultAt = new Date().toISOString();
  writePuntState(root, state);
}

/** True when a retry prompt should still fire (prompted today but no code yet). */
export function shouldReprompt(root: string, date = today()): boolean {
  return !readPuntState(root, date).fulfilled;
}
