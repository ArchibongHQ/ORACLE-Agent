/** Shared daily punt-state file: .tmp/punt/<date>.json.
 *  Two named slips per day — SLIP_LABELS[0] = "39 Billion - Universe",
 *  SLIP_LABELS[1] = "9z 40 ACCA". The worker writes a prompted-at timestamp for
 *  each slip at 10:00 WAT and re-prompts at 12:00/13:00 WAT only while that
 *  slip's fulfilled === false. Matching is order-based: a code reply has no
 *  slip identifier of its own, so the bot/web/CLI call markFulfilled() and it
 *  closes out whichever slip is still pending, in slip order (first reply of
 *  the day -> slip 0, second -> slip 1). Best-effort — failures never throw. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SLIP_LABELS = ["39 Billion - Universe", "9z 40 ACCA"] as const;

export interface PuntSlipState {
  promptedAt: string | null;
  fulfilled: boolean;
  lastCode?: string;
  lastResultAt?: string;
}

export interface PuntDayState {
  date: string;
  slips: PuntSlipState[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function stateFile(root: string, date: string): string {
  return join(root, ".tmp", "punt", `${date}.json`);
}

function emptySlip(): PuntSlipState {
  return { promptedAt: null, fulfilled: false };
}

export function readPuntState(root: string, date = today()): PuntDayState {
  const file = stateFile(root, date);
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PuntDayState>;
      if (Array.isArray(parsed.slips) && parsed.slips.length === SLIP_LABELS.length) {
        return { date, slips: parsed.slips };
      }
    }
  } catch {
    /* fall through to default */
  }
  return { date, slips: SLIP_LABELS.map(() => emptySlip()) };
}

function writePuntState(root: string, state: PuntDayState): void {
  try {
    mkdirSync(join(root, ".tmp", "punt"), { recursive: true });
    writeFileSync(stateFile(root, state.date), JSON.stringify(state), "utf8");
  } catch {
    /* best-effort */
  }
}

/** Record that today's prompt for a given slip was sent. Idempotent on date+slip. */
export function markPrompted(root: string, slipIndex: number, date = today()): PuntDayState {
  const state = readPuntState(root, date);
  const slip = state.slips[slipIndex];
  if (slip && !slip.promptedAt) slip.promptedAt = new Date().toISOString();
  writePuntState(root, state);
  return state;
}

/** Closes out whichever slip is still pending today, in slip order (first
 *  code reply of the day fulfills slip 0, second fulfills slip 1). Returns the
 *  slip index that was fulfilled, or null if every slip for today is already
 *  fulfilled (extra code replies beyond the two expected slips are ignored). */
export function markFulfilled(root: string, code: string, date = today()): number | null {
  const state = readPuntState(root, date);
  const idx = state.slips.findIndex((s) => !s.fulfilled);
  if (idx === -1) return null;
  const slip = state.slips[idx]!;
  slip.fulfilled = true;
  slip.lastCode = code;
  slip.lastResultAt = new Date().toISOString();
  writePuntState(root, state);
  return idx;
}

/** True when a retry prompt should still fire for the given slip (prompted
 *  today but no code yet). */
export function shouldReprompt(root: string, slipIndex: number, date = today()): boolean {
  const slip = readPuntState(root, date).slips[slipIndex];
  return slip ? !slip.fulfilled : false;
}
