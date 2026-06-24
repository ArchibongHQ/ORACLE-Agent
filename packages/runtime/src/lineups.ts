/** API-Football confirmed-lineup enrichment.
 *
 *  Runtime pre-batch step (mirrors newsIntel.ts): reads the lineup summaries that
 *  tools/fetch_lineups.py writes to .tmp/oracle-store/oracle_lineups.json and merges
 *  them into job.state.telemetry.softContext BEFORE the engine runs. Pure file read —
 *  no API calls from TypeScript; the Python tool owns the API-Football quota.
 *
 *  Matching is alias-aware via teamNames.ts. Stale summaries (fixture date more than
 *  36h from now) are ignored so yesterday's lineups never leak into today's batch.
 *  Never throws — returns jobs unchanged on any failure.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureJob, SoftContextItem } from "@oracle/engine";
import { namesMatch } from "./teamNames.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");
const DEFAULT_STORE_PATH = join(ROOT, ".tmp/oracle-store/oracle_lineups.json");

const MAX_AGE_MS = 36 * 3_600_000; // ignore summaries whose fixture date is >36h away
const XI_NAMES_SHOWN = 11;

/** Shape written by tools/fetch_lineups.py (summarise_lineup). */
export interface LineupSummary {
  fixture_id?: number | string;
  home?: string;
  away?: string;
  date?: string;
  home_formation?: string;
  away_formation?: string;
  home_xi_confirmed?: boolean;
  away_xi_confirmed?: boolean;
  home_starting_xi?: string[];
  away_starting_xi?: string[];
}

function isFresh(summary: LineupSummary): boolean {
  if (!summary.date) return true; // manual --fixture-id runs carry no date
  const ts = Date.parse(summary.date);
  if (Number.isNaN(ts)) return true;
  return Math.abs(ts - Date.now()) <= MAX_AGE_MS;
}

function sideToText(
  team: string,
  side: "Home" | "Away",
  formation: string | undefined,
  confirmed: boolean | undefined,
  xi: string[] | undefined
): string | null {
  const names = (xi ?? []).filter(Boolean);
  if (!names.length && !formation) return null;
  const parts = [`${side} ${team}:`];
  if (formation) parts.push(`formation ${formation}`);
  if (names.length)
    parts.push(
      `${confirmed ? "confirmed" : "expected"} XI — ${names.slice(0, XI_NAMES_SHOWN).join(", ")}`
    );
  return parts.join(" ");
}

function toSoftContext(summary: LineupSummary): SoftContextItem[] {
  const observedAt = new Date().toISOString();
  const texts = [
    sideToText(
      summary.home ?? "",
      "Home",
      summary.home_formation,
      summary.home_xi_confirmed,
      summary.home_starting_xi
    ),
    sideToText(
      summary.away ?? "",
      "Away",
      summary.away_formation,
      summary.away_xi_confirmed,
      summary.away_starting_xi
    ),
  ];
  return texts
    .filter((t): t is string => t !== null)
    .map((text) => ({ kind: "lineup" as const, text, source: "api-football-lineups", observedAt }));
}

/** Raw fresh-summary read, name-keyed lookup convenience for callers that don't
 *  have a FixtureJob to enrich (e.g. dailyFixtureReport.ts, which builds its
 *  report straight from SportyBetEvent[]). Returns [] on any read/parse failure
 *  or when the store file doesn't exist yet — never throws. */
export async function loadLineupSummaries(
  storePath: string = DEFAULT_STORE_PATH
): Promise<LineupSummary[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(storePath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return (parsed as LineupSummary[]).filter((s) => s.home && s.away && isFresh(s));
  } catch {
    return [];
  }
}

/** Finds the freshest lineup summary for a given fixture by alias-aware name
 *  match — same matching convention enrichWithLineups uses for FixtureJob[]. */
export function findLineupSummary(
  summaries: LineupSummary[],
  home: string,
  away: string
): LineupSummary | undefined {
  return summaries.find((s) => namesMatch(home, s.home!) && namesMatch(away, s.away!));
}

/** Merge API-Football lineup summaries into job.state.telemetry.softContext.
 *  File-read only; missing/invalid store file is a silent no-op. Never throws. */
export async function enrichWithLineups(
  jobs: FixtureJob[],
  storePath: string = DEFAULT_STORE_PATH
): Promise<FixtureJob[]> {
  let summaries: LineupSummary[];
  try {
    const parsed: unknown = JSON.parse(await readFile(storePath, "utf8"));
    if (!Array.isArray(parsed)) return jobs;
    summaries = parsed as LineupSummary[];
  } catch {
    return jobs; // no lineup store yet — fetch_lineups.py hasn't run
  }

  const fresh = summaries.filter((s) => s.home && s.away && isFresh(s));
  if (!fresh.length) return jobs;

  return jobs.map((job) => {
    const match = fresh.find((s) => namesMatch(job.home, s.home!) && namesMatch(job.away, s.away!));
    if (!match) return job;

    const items = toSoftContext(match);
    if (!items.length) return job;

    const existingState = job.state ?? {};
    const existingTel = existingState.telemetry ?? {};
    const existingSoft = (existingTel.softContext as SoftContextItem[] | undefined) ?? [];

    return {
      ...job,
      state: {
        ...existingState,
        telemetry: {
          ...existingTel,
          softContext: [...existingSoft, ...items],
        },
      },
    };
  });
}
