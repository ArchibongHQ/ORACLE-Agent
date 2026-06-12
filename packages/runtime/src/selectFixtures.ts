/** Pre-analysis fixture selection — bounds per-run quota/LLM cost.
 *
 *  The scrapers are free, but every fixture entering fetchTodaysFixtures'
 *  gap-fill/enrich paths costs paid API calls. This module gates the pool to
 *  SportyBet-listed fixtures kicking off today, scores them, and caps the
 *  survivors at MAX_FIXTURES_PER_RUN (default 50) BEFORE any per-fixture call.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureJob } from "@oracle/engine";
import { namesMatch, resolveAlias } from "./teamNames.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");
export const SPORTYBET_SIDECAR_PATH = join(ROOT, ".tmp/fixtures/sportybet_today.json");

export const DEFAULT_MAX_FIXTURES_PER_RUN = 50;

// Keep in sync with ESPN_LEAGUE_MAP values in tools/scrape_fixtures.py.
export const ORACLE_PRIORITY_LEAGUES: ReadonlySet<string> = new Set([
  "Premier League",
  "Championship",
  "La Liga",
  "Bundesliga",
  "Serie A",
  "Ligue 1",
  "Eredivisie",
  "Primeira Liga",
  "Belgian Pro League",
  "Scottish Premiership",
  "Champions League",
  "Europa League",
  "Conference League",
  "J League",
  "MLS",
  "FIFA World Cup",
]);

// ── SportyBet sidecar (written by tools/scrape_fixtures.py) ──────────────────

interface SportyBetEvent {
  home: string;
  away: string;
  marketCount: number;
}

export interface SportyBetIndex {
  date: string;
  byKey: Map<string, number>; // sidecarKey(home, away) → marketCount
  events: SportyBetEvent[]; // kept for namesMatch fallback scans
}

/** Canonical index key — the contract between loadSportyBetIndex and selectFixtures. */
export function sidecarKey(home: string, away: string): string {
  return `${resolveAlias(home)}|${resolveAlias(away)}`;
}

/** Load .tmp/fixtures/sportybet_today.json. Returns null when the file is
 *  missing, corrupt, or stale (`date` !== today) — callers fail open.
 *  The sidecar is scraped web content: each event is shape-validated so one
 *  malformed record degrades to a skip, not a fail-open of the whole index. */
export async function loadSportyBetIndex(
  today: string,
  path: string = SPORTYBET_SIDECAR_PATH
): Promise<SportyBetIndex | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      date?: string;
      events?: Array<Record<string, unknown>>;
    };
    if (raw?.date !== today || !Array.isArray(raw.events)) return null;
    const events: SportyBetEvent[] = [];
    const byKey = new Map<string, number>();
    for (const ev of raw.events) {
      if (!ev || typeof ev.home !== "string" || typeof ev.away !== "string") continue;
      if (!ev.home.trim() || !ev.away.trim()) continue;
      const mc =
        typeof ev.marketCount === "number" && Number.isFinite(ev.marketCount) && ev.marketCount > 0
          ? ev.marketCount
          : 0;
      events.push({ home: ev.home, away: ev.away, marketCount: mc });
      byKey.set(sidecarKey(ev.home, ev.away), mc);
    }
    return { date: raw.date, byKey, events };
  } catch {
    return null;
  }
}

// ── Composite scoring ─────────────────────────────────────────────────────────

export interface SelectionCandidate {
  job: FixtureJob;
  hasBulkOdds: boolean; // matched by the free bulk the-odds-api call
}

/** League priority dominates (+50), then bulk odds (+30), kickoff window (0–10),
 *  SportyBet market depth (0–10). Max 100. */
export function scoreFixture(c: SelectionCandidate, marketCount: number, now: Date): number {
  let score = 0;
  if (ORACLE_PRIORITY_LEAGUES.has(c.job.league)) score += 50;
  if (c.hasBulkOdds) score += 30;
  const hoursToKO = (new Date(c.job.kickoff).getTime() - now.getTime()) / 3_600_000;
  if (hoursToKO >= 2) score += 10;
  else if (hoursToKO >= 1) score += 5;
  score += (Math.min(marketCount, 40) / 40) * 10;
  return score;
}

// ── Selection ─────────────────────────────────────────────────────────────────

export interface SelectionStats {
  pool: number;
  today: number;
  sportyBet: number;
  selected: number;
  bulkOdds: number;
  priority: number;
  /** Fixtures with already-paid bulk odds that the SportyBet gate excluded —
   *  name-mismatch visibility (silent loss on the highest-quality path). */
  droppedBulkOdds: number;
  failOpen: boolean;
}

export interface SelectionResult {
  selected: SelectionCandidate[];
  stats: SelectionStats;
}

/** Filter the pool to today's not-yet-started fixtures, gate on SportyBet
 *  membership (fail open when the sidecar is unavailable/empty), score, and
 *  cap. Deterministic ordering: score desc, kickoff asc, home name asc. */
export function selectFixtures(
  pool: SelectionCandidate[],
  opts: { cap: number; sportyBet: SportyBetIndex | null; now?: Date }
): SelectionResult {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  // Date comparison via parsed timestamp (not raw string prefix) so
  // offset-bearing ISO kickoffs are classified by their UTC day
  const todayOnly = pool.filter((c) => {
    const ko = new Date(c.job.kickoff).getTime();
    return (
      Number.isFinite(ko) && ko > now.getTime() && new Date(ko).toISOString().slice(0, 10) === today
    );
  });

  const failOpen = !opts.sportyBet || opts.sportyBet.byKey.size === 0;
  const marketCounts = new Map<SelectionCandidate, number>();
  let gated: SelectionCandidate[];
  if (failOpen) {
    gated = todayOnly;
  } else {
    const idx = opts.sportyBet as SportyBetIndex;
    gated = [];
    for (const c of todayOnly) {
      let marketCount = idx.byKey.get(sidecarKey(c.job.home, c.job.away));
      if (marketCount === undefined) {
        const ev = idx.events.find(
          (e) => namesMatch(e.home, c.job.home) && namesMatch(e.away, c.job.away)
        );
        if (ev) marketCount = ev.marketCount;
      }
      if (marketCount !== undefined) {
        marketCounts.set(c, marketCount);
        gated.push(c);
      }
    }
  }
  const droppedBulkOdds = failOpen
    ? 0
    : todayOnly.filter((c) => c.hasBulkOdds).length - gated.filter((c) => c.hasBulkOdds).length;

  const selected = gated
    .map((c) => ({ c, score: scoreFixture(c, marketCounts.get(c) ?? 0, now) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.c.job.kickoff.localeCompare(b.c.job.kickoff) ||
        a.c.job.home.localeCompare(b.c.job.home)
    )
    .slice(0, Math.max(0, opts.cap))
    .map((s) => s.c);

  return {
    selected,
    stats: {
      pool: pool.length,
      today: todayOnly.length,
      sportyBet: gated.length,
      selected: selected.length,
      bulkOdds: selected.filter((c) => c.hasBulkOdds).length,
      priority: selected.filter((c) => ORACLE_PRIORITY_LEAGUES.has(c.job.league)).length,
      droppedBulkOdds,
      failOpen,
    },
  };
}
