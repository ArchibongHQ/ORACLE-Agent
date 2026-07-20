/** H2H enrichment — fetches head-to-head stats from football-data.org and merges
 *  them into FixtureJob.state.pipeline.fetched.stats before the engine runs.
 *
 *  Flow per fixture:
 *    1. Check .tmp/h2h/<slug>.json cache (TTL 6h — odds can shift but H2H is stable)
 *    2. Search football-data /matches for the fixture to get a match ID
 *    3. Call /matches/{id}/head2head?limit=10
 *    4. Compute h2hHomeWin, h2hDraw, h2hAwayWin, h2hN, h2hGoalDiff (same names as
 *       gbm/index.ts's GBM_FEAT_COLS)
 *    5. Merge aggregates into fetched.stats (numeric); merge raw recentScorelines
 *       (if any) into telemetry.rawStatsBlock instead — the Opus arbiter's STEP 0
 *       passthrough — since fetched.stats stays purely numeric. Never throws,
 *       always returns jobs unchanged on failure.
 *
 *  Rate limit: football-data free tier = 10 req/min. We batch with 7s inter-request delay.
 *
 *  [2026-07-20 correction — this comment previously claimed two things that were
 *  verified stale this session, do not re-introduce either]:
 *   - "existing safety/GBM consumers" (step 5, above) — checked live:
 *     safety/index.ts has zero references to any h2h* field, and gbm/index.ts's
 *     GbmLiveInputs (the actual live-population interface, distinct from the
 *     full GBM_FEAT_COLS training-schema list) does NOT include h2hHomeWin/
 *     h2hDraw/h2hAwayWin/h2hN/h2hGoalDiff — they zero-fill in
 *     buildGbmFeatureVector() regardless of what this file computes. More
 *     fundamentally, blendGbmIntoFp (the function that would ever USE a GBM
 *     probability) has ZERO call sites anywhere in packages/ — the entire GBM
 *     residual module is dormant pending its own walk-forward significance
 *     gate (see that function's doc comment). This file's output is real and
 *     correctly computed, but currently reaches no live scoring path.
 *   - "the SportyBet/Sportradar gismo H2H path has no match-level detail —
 *     only aggregate counts" — no longer true (may have been true when
 *     originally written): stats_team_versusrecent's `matches[]` carries
 *     per-meeting scorelines/dates/winner (see selectFixtures.ts's
 *     SportyBetStats.h2h.matches and _parse_h2h's docstring in
 *     tools/scrape_fixtures.py, live-verified 2026-06-29 and re-confirmed
 *     2026-07-20). This file remains the only source for fixtures where the
 *     owner wants a name-matched football-data.org scoreline specifically,
 *     but it is no longer the ONLY scoreline source in the codebase.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureJob } from "@oracle/engine";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");
const H2H_DIR = join(ROOT, ".tmp/h2h");
const BASE = "https://api.football-data.org/v4";

const H2H_SHRINK_K = 5; // shrink toward prior when H2H sample is thin
const CACHE_TTL_MS = 6 * 3_600_000; // 6 hours
const REQ_DELAY_MS = 7_000; // ~8 req/min — safely under 10 req/min limit
const MAX_H2H_JOBS = 20; // cap API calls per batch to protect quota

// ── football-data.org league competition codes ────────────────────────────────

const LEAGUE_TO_COMP: Record<string, string> = {
  "Premier League": "PL",
  "La Liga": "PD",
  Bundesliga: "BL1",
  "Serie A": "SA",
  "Ligue 1": "FL1",
  Eredivisie: "DED",
  "Champions League": "CL",
  "Europa League": "EL",
  Championship: "ELC",
  "FIFA World Cup": "WC",
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface H2HCache {
  fetchedAt: string;
  h2hHomeWin: number;
  h2hDraw: number;
  h2hAwayWin: number;
  h2hN: number;
  h2hGoalDiff: number;
  /** Last up-to-10 H2H scorelines, most recent first, from the perspective of
   *  the current fixture's home/away assignment (e.g. "2-1 (2025-03-02)") —
   *  surfaced to the Opus arbiter's raw-stats block (STEP 0). The SportyBet
   *  gismo H2H path has no match-level detail (only aggregate counts), so this
   *  is the only available scoreline source; absent when football-data.org has
   *  no scheduled/found match for this fixture. */
  recentScorelines?: string[];
}

export interface FDMatch {
  id: number;
  homeTeam: { name: string };
  awayTeam: { name: string };
  score: { winner: string | null; fullTime: { home: number | null; away: number | null } };
  utcDate?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slug(home: string, away: string): string {
  const s = (n: string) =>
    n
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
  return `${s(home)}_vs_${s(away)}`;
}

function normTeam(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(fc|afc|sc|cf|ac|as|ssc|sv|bk|if|cd|ud|fk)\b/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function teamsMatch(a: string, b: string): boolean {
  const na = normTeam(a),
    nb = normTeam(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** Last up-to-10 raw H2H scorelines, normalized to the current fixture's
 *  home/away perspective (NOT whichever side happened to play at home in a
 *  given historical meeting), most recent first — e.g. "2-1 (2025-03-02)".
 *  Pure, exported for direct unit testing — the aggregate reduction in
 *  fetchH2HStats discards this same `prior` list after computing
 *  h2hHomeWin/draw/awayWin, so this is the only place it survives. */
export function buildRecentScorelines(matches: FDMatch[], currentHome: string): string[] {
  return matches
    .slice()
    .sort((a, b) => (b.utcDate ?? "").localeCompare(a.utcDate ?? ""))
    .map((m) => {
      const mHomeIsOurHome = teamsMatch(m.homeTeam.name, currentHome);
      const ftHome = m.score.fullTime.home ?? 0;
      const ftAway = m.score.fullTime.away ?? 0;
      const ourHomeGoals = mHomeIsOurHome ? ftHome : ftAway;
      const ourAwayGoals = mHomeIsOurHome ? ftAway : ftHome;
      const date = m.utcDate ? ` (${m.utcDate.slice(0, 10)})` : "";
      return `${ourHomeGoals}-${ourAwayGoals}${date}`;
    });
}

async function fdGet<T>(path: string, apiKey: string): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { "X-Auth-Token": apiKey },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`football-data ${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function readCache(home: string, away: string): Promise<H2HCache | null> {
  try {
    const text = await readFile(join(H2H_DIR, `${slug(home, away)}.json`), "utf8");
    const data = JSON.parse(text) as H2HCache;
    if (Date.now() - new Date(data.fetchedAt).getTime() < CACHE_TTL_MS) return data;
  } catch {
    /* miss */
  }
  return null;
}

async function writeCache(home: string, away: string, data: H2HCache): Promise<void> {
  await mkdir(H2H_DIR, { recursive: true });
  await writeFile(join(H2H_DIR, `${slug(home, away)}.json`), JSON.stringify(data, null, 2), "utf8");
}

// ── Core fetch ────────────────────────────────────────────────────────────────

async function fetchH2HStats(
  home: string,
  away: string,
  league: string,
  kickoff: string,
  apiKey: string
): Promise<H2HCache | null> {
  const compCode = LEAGUE_TO_COMP[league];
  if (!compCode) return null;

  const date = kickoff.slice(0, 10);
  const dateFrom = new Date(new Date(date).getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const dateTo = new Date(new Date(date).getTime() + 7 * 86_400_000).toISOString().slice(0, 10);

  // Step 1: find the match ID
  const matchesData = await fdGet<{ matches: FDMatch[] }>(
    `/competitions/${compCode}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&status=SCHEDULED,TIMED,IN_PLAY,FINISHED`,
    apiKey
  );

  const match = matchesData.matches.find(
    (m) => teamsMatch(m.homeTeam.name, home) && teamsMatch(m.awayTeam.name, away)
  );
  if (!match) return null;

  // Step 2: fetch H2H
  const h2hData = await fdGet<{ matches: FDMatch[]; aggregates?: Record<string, unknown> }>(
    `/matches/${match.id}/head2head?limit=10`,
    apiKey
  );

  const prior = h2hData.matches.filter((m) => m.score.winner !== null);
  const n = prior.length;
  if (n === 0) return null;

  // Compute from the perspective of current home team
  let homeWins = 0,
    draws = 0,
    awayWins = 0;
  let goalDiffSum = 0;

  for (const m of prior) {
    const mHomeIsOurHome = teamsMatch(m.homeTeam.name, home);
    const winner = m.score.winner; // 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW'
    const ftHome = m.score.fullTime.home ?? 0;
    const ftAway = m.score.fullTime.away ?? 0;

    if (winner === "DRAW") {
      draws++;
      goalDiffSum += 0;
    } else if ((winner === "HOME_TEAM") === mHomeIsOurHome) {
      homeWins++;
      goalDiffSum += mHomeIsOurHome ? ftHome - ftAway : ftAway - ftHome;
    } else {
      awayWins++;
      goalDiffSum += mHomeIsOurHome ? ftHome - ftAway : ftAway - ftHome;
    }
  }

  // Shrinkage toward 1/3 prior when sample is thin
  const wOwn = n / (n + H2H_SHRINK_K);
  const wPrior = 1 - wOwn;
  const prior1_3 = 1 / 3;

  const recentScorelines = buildRecentScorelines(prior, home);

  return {
    fetchedAt: new Date().toISOString(),
    h2hHomeWin: wOwn * (homeWins / n) + wPrior * prior1_3,
    h2hDraw: wOwn * (draws / n) + wPrior * prior1_3,
    h2hAwayWin: wOwn * (awayWins / n) + wPrior * prior1_3,
    h2hN: n,
    h2hGoalDiff: n > 0 ? goalDiffSum / n : 0,
    ...(recentScorelines.length ? { recentScorelines } : {}),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Enrich up to MAX_H2H_JOBS fixture jobs with H2H stats.
 *  Jobs for leagues not in LEAGUE_TO_COMP are silently skipped (no API call).
 *  Respects 7s inter-request delay to stay under 10 req/min free tier limit.
 *  Never throws — returns jobs unmodified on any error. */
export async function enrichWithH2H(
  jobs: FixtureJob[],
  apiKey: string | undefined
): Promise<FixtureJob[]> {
  if (!apiKey) return jobs;

  // Only process leagues we have a competition code for, cap at MAX_H2H_JOBS
  const eligible = jobs
    .map((job, idx) => ({ job, idx }))
    .filter(({ job }) => LEAGUE_TO_COMP[job.league] !== undefined)
    .slice(0, MAX_H2H_JOBS);

  if (eligible.length === 0) return jobs;

  const enriched = [...jobs];
  let apiCalls = 0;

  for (const { job, idx } of eligible) {
    try {
      // Try cache first — no API call needed
      let stats = await readCache(job.home, job.away);

      if (!stats) {
        // Rate-limit delay before API call (skip delay on first call)
        if (apiCalls > 0) await new Promise((r) => setTimeout(r, REQ_DELAY_MS));
        stats = await fetchH2HStats(job.home, job.away, job.league, job.kickoff, apiKey);
        apiCalls++;
        if (stats) await writeCache(job.home, job.away, stats);
      }

      if (!stats) continue;

      // Merge aggregates into job.state.pipeline.fetched.stats (numeric — same
      // consumers as before: safety/index.ts's MLSafetyFilter, gbm/index.ts).
      const existingState = enriched[idx]?.state ?? {};
      const existingFetched = (existingState.pipeline?.fetched ?? {}) as Record<string, unknown>;
      const existingStats = (existingFetched.stats ?? {}) as Record<string, number>;
      // Raw scorelines go to telemetry.rawStatsBlock (the arbiter's STEP 0
      // passthrough) instead — fetched.stats stays purely numeric for its
      // existing consumers, never mixed with a string array.
      const existingTel = existingState.telemetry ?? {};
      const existingRawStats = (existingTel.rawStatsBlock ?? {}) as Record<string, unknown>;

      enriched[idx] = {
        ...enriched[idx]!,
        state: {
          ...existingState,
          telemetry: {
            ...existingTel,
            ...(stats.recentScorelines?.length
              ? {
                  rawStatsBlock: {
                    ...existingRawStats,
                    h2hRecentScorelines: stats.recentScorelines,
                  },
                }
              : {}),
          },
          pipeline: {
            ...(existingState.pipeline ?? {}),
            fetched: {
              ...existingFetched,
              stats: {
                ...existingStats,
                h2hHomeWin: stats.h2hHomeWin,
                h2hDraw: stats.h2hDraw,
                h2hAwayWin: stats.h2hAwayWin,
                h2hN: stats.h2hN,
                h2hGoalDiff: stats.h2hGoalDiff,
              },
            },
          },
        },
      };
    } catch (err) {
      const _msg = err instanceof Error ? err.message : String(err);
    }
  }

  const _filled = enriched.filter((j, i) => {
    const orig = jobs[i]!;
    return (
      (j.state?.pipeline?.fetched as Record<string, unknown> | undefined)?.stats !==
      (orig.state?.pipeline?.fetched as Record<string, unknown> | undefined)?.stats
    );
  }).length;

  return enriched;
}
