/** Pre-analysis fixture selection — routes LLM quota without dropping fixtures.
 *
 *  All SportyBet-listed fixtures kicking off today are returned; the score is
 *  used only to mark the top-N as llmEligible (paid LLM tiers).  The cap no
 *  longer gates inclusion — it is a routing threshold only.
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

/** Odds block from factsCenter/event (sidecar v2). All fields optional — a
 *  failed per-fixture fetch leaves the odds block null. */
export interface SportyBetOdds {
  "1x2"?: { home?: number | null; draw?: number | null; away?: number | null } | null;
  ou25?: { over?: number | null; under?: number | null } | null;
  ou15?: { over?: number | null; under?: number | null } | null;
  ou35?: { over?: number | null; under?: number | null } | null;
  /** Home team-total Over/Under 0.5 (SportyBet market id 19). */
  tt_home_05?: { over?: number | null; under?: number | null } | null;
  /** Away team-total Over/Under 0.5 (SportyBet market id 20). */
  tt_away_05?: { over?: number | null; under?: number | null } | null;
  btts?: { yes?: number | null; no?: number | null } | null;
  dc?: { "1x"?: number | null; "12"?: number | null; x2?: number | null } | null;
  dnb?: { home?: number | null; away?: number | null } | null;
  ah?: { home?: number | null; away?: number | null; line?: number | null } | null;
}

/** Stats block from Sportradar gismo (sidecar v2). All sub-fields optional. */
export interface SportyBetStats {
  form?: {
    home?: {
      name?: string;
      last5?: string;
      w?: number;
      d?: number;
      l?: number;
      /** Leading run of identical results, signed (+win streak / -loss streak / 0 on a draw). */
      streak?: number;
    } | null;
    away?: {
      name?: string;
      last5?: string;
      w?: number;
      d?: number;
      l?: number;
      streak?: number;
    } | null;
  } | null;
  standings?: {
    home?: { pos?: number; points?: number; played?: number; gf?: number; ga?: number } | null;
    away?: { pos?: number; points?: number; played?: number; gf?: number; ga?: number } | null;
  } | null;
  goals?: {
    home?: { avg_scored?: number; avg_conceded?: number } | null;
    away?: { avg_scored?: number; avg_conceded?: number } | null;
  } | null;
  h2h?: { total?: number; home_wins?: number; away_wins?: number; draws?: number } | null;
  /** Understat rolling xG prior — populated for top-5 European leagues only. */
  xg?: {
    home?: { xgf?: number; xga?: number } | null;
    away?: { xgf?: number; xga?: number } | null;
  } | null;
  /** Season over-line hit rate per team (stats_season_overunder), both venues combined. */
  overunder?: {
    home?: { over15_pct?: number; over25_pct?: number; over35_pct?: number } | null;
    away?: { over15_pct?: number; over25_pct?: number; over35_pct?: number } | null;
  } | null;
  /** Rest/fixture-load context derived from stats_season_fixtures, relative to this kickoff. */
  congestion?: {
    home?: { rest_days?: number; next_days?: number } | null;
    away?: { rest_days?: number; next_days?: number } | null;
  } | null;
  /** Pre-match textual facts (Sportradar match_funfacts) — closest verified gismo
   *  equivalent to a "commentary" tab. Advisory/LLM context only — no engine
   *  consumption point yet. */
  commentary?: string[] | null;
}

export interface SportyBetEventDetail {
  eventId: string;
  odds: SportyBetOdds | null;
  stats: SportyBetStats | null;
  statscoverage: Record<string, unknown> | null;
}

interface SportyBetEvent {
  home: string;
  away: string;
  marketCount: number;
  league?: string;
  kickoff_utc?: string;
  detail?: SportyBetEventDetail;
}

export interface SportyBetIndex {
  date: string;
  byKey: Map<string, number>; // sidecarKey(home, away) → marketCount
  detailByKey: Map<string, SportyBetEventDetail>; // sidecarKey → enriched detail
  events: SportyBetEvent[]; // kept for namesMatch fallback scans
}

/** Canonical index key — the contract between loadSportyBetIndex and selectFixtures. */
export function sidecarKey(home: string, away: string): string {
  return `${resolveAlias(home)}|${resolveAlias(away)}`;
}

/** Look up a fixture's sidecar detail tolerantly. Tries the exact canonical key
 *  first (fast path); on a miss, scans for a key whose two halves both `namesMatch`
 *  the requested teams. This recovers regional-suffix mismatches the canonical key
 *  can't collapse — e.g. engine "Ferroviaria" vs sidecar "Ferroviaria SP" (Brazilian
 *  state codes are not stripped by normTeam). Returns undefined when no key matches
 *  (the fixture genuinely isn't in the sidecar). */
export function findSidecarDetail(
  detailByKey: Map<string, SportyBetEventDetail> | undefined,
  home: string,
  away: string
): SportyBetEventDetail | undefined {
  if (!detailByKey) return undefined;
  const exact = detailByKey.get(sidecarKey(home, away));
  if (exact) return exact;
  for (const [key, detail] of detailByKey) {
    const sep = key.indexOf("|");
    if (sep < 0) continue;
    const kh = key.slice(0, sep);
    const ka = key.slice(sep + 1);
    if (namesMatch(kh, home) && namesMatch(ka, away)) return detail;
  }
  return undefined;
}

/** Load today's SportyBet-shaped index, lake-first. Tries the Parquet daily
 *  lake (dailyStore.ts) before falling back to the legacy
 *  .tmp/fixtures/sportybet_today.json — a fresh lake skips the JSON parse
 *  entirely (the actual latency win; see the Phase A overhaul plan). Dynamic
 *  import avoids a static circular dependency (dailyStore.ts imports this
 *  file's types/sidecarKey) and means a missing/broken dailyStore module
 *  degrades to the JSON path exactly like any other failure here.
 *  Returns null when neither source has today's data — callers fail open.
 *  The JSON sidecar is scraped web content: each event is shape-validated so
 *  one malformed record degrades to a skip, not a fail-open of the whole
 *  index. */
export async function loadSportyBetIndex(
  today: string,
  path: string = SPORTYBET_SIDECAR_PATH
): Promise<SportyBetIndex | null> {
  try {
    const { loadDailyFixtures } = await import("./dailyStore.js");
    const fromLake = await loadDailyFixtures(today);
    if (fromLake) return fromLake;
  } catch {
    // dailyStore unavailable (native DuckDB load failure, etc.) — fall through to JSON.
  }
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      date?: string;
      events?: Array<Record<string, unknown>>;
    };
    if (raw?.date !== today || !Array.isArray(raw.events)) return null;
    const events: SportyBetEvent[] = [];
    const byKey = new Map<string, number>();
    const detailByKey = new Map<string, SportyBetEventDetail>();
    for (const ev of raw.events) {
      if (!ev || typeof ev.home !== "string" || typeof ev.away !== "string") continue;
      if (!ev.home.trim() || !ev.away.trim()) continue;
      const mc =
        typeof ev.marketCount === "number" && Number.isFinite(ev.marketCount) && ev.marketCount > 0
          ? ev.marketCount
          : 0;
      const key = sidecarKey(ev.home, ev.away);
      // Parse v2 enrichment fields — fail-safe: a malformed block degrades to null
      let detail: SportyBetEventDetail | undefined;
      if (typeof ev.eventId === "string" && ev.eventId) {
        try {
          const baseStats = (ev.stats as SportyBetStats | null) ?? null;
          const xgBlock = ev.xg as
            | {
                home?: { xgf?: number; xga?: number } | null;
                away?: { xgf?: number; xga?: number } | null;
              }
            | null
            | undefined;
          const stats: SportyBetStats | null =
            baseStats != null || xgBlock != null
              ? { ...(baseStats ?? {}), ...(xgBlock != null ? { xg: xgBlock } : {}) }
              : null;
          detail = {
            eventId: ev.eventId,
            odds: (ev.odds as SportyBetOdds | null) ?? null,
            stats,
            statscoverage: (ev.statscoverage as Record<string, unknown> | null) ?? null,
          };
        } catch {
          // malformed detail — keep the event but without enrichment
        }
      }
      const league = typeof ev.league === "string" ? ev.league : undefined;
      const kickoff_utc = typeof ev.kickoff_utc === "string" ? ev.kickoff_utc : undefined;
      events.push({ home: ev.home, away: ev.away, marketCount: mc, league, kickoff_utc, detail });
      byKey.set(key, mc);
      if (detail) detailByKey.set(key, detail);
    }
    return { date: raw.date, byKey, detailByKey, events };
  } catch {
    return null;
  }
}

// ── Predictability scoring ────────────────────────────────────────────────────

const _CUP_RE = /cup|copa|coupe|pokal|trophy|shield|supercup|friendly|test\s*match/i;

/** Minimum shared meetings before H2H history counts as real signal (1-2 is noise). */
const MIN_H2H_SAMPLE = 3;

/** Returns a 0–100 score reflecting how likely this fixture produces a
 *  low-variance, viable market.  Pure function — no I/O, no side effects.
 *  Falls back gracefully: NaN is never returned. */
export function predictabilityScore(
  detail: SportyBetEventDetail | undefined | null,
  leagueName: string
): number {
  if (!detail) return 30; // neutral — no data

  const stats = detail.stats;
  const odds = detail.odds;
  const cov = detail.statscoverage;

  // ── Soft discard penalties ─────────────────────────────────────────────────
  let penalty = 0;

  // Cup / friendly / trophy — league-name heuristic only (no hardcoded city list)
  if (_CUP_RE.test(leagueName)) penalty += 25;

  // Low-data: statscoverage flags all three as false/absent
  const hasLeagueTable = cov?.leaguetable === true;
  const hasFormTable = cov?.formtable === true;
  const hasH2H = cov?.headtohead === true;
  // H2H only counts toward "has data" once it clears the same sample gate used by
  // the H2H component below — a single past meeting is not real signal.
  const h2hSampleOk = (stats?.h2h?.total ?? 0) >= MIN_H2H_SAMPLE;
  const hasAnyStats = !!(
    stats?.form ||
    stats?.standings ||
    stats?.goals ||
    (stats?.h2h && h2hSampleOk)
  );
  if (!hasAnyStats && !hasLeagueTable && !hasFormTable && !(hasH2H && h2hSampleOk)) penalty += 20;

  // ── Component 1: Favourite strength (0–30) ────────────────────────────────
  // Prefer xG prior; fall back to goals avg; skip when neither is available.
  let favouriteScore = 0;

  const homeXgf = stats?.xg?.home?.xgf ?? stats?.goals?.home?.avg_scored ?? null;
  const homeXga = stats?.xg?.home?.xga ?? stats?.goals?.home?.avg_conceded ?? null;
  const awayXgf = stats?.xg?.away?.xgf ?? stats?.goals?.away?.avg_scored ?? null;
  const awayXga = stats?.xg?.away?.xga ?? stats?.goals?.away?.avg_conceded ?? null;

  if (homeXgf !== null && homeXga !== null && awayXgf !== null && awayXga !== null) {
    const homeNet = homeXgf - homeXga;
    const awayNet = awayXgf - awayXga;
    const diff = Math.abs(homeNet - awayNet);
    // diff ≥ 1.5 → full 30; scaled linearly below that
    favouriteScore = Math.min(30, (diff / 1.5) * 30);
  }

  // ── Component 2: Scoring rate (0–20) ─────────────────────────────────────
  // Combined expected goals per match; above 2.5 goals/game → drives O2.5/BTTS
  let scoringScore = 0;
  const hScored = stats?.xg?.home?.xgf ?? stats?.goals?.home?.avg_scored ?? null;
  const aConceded = stats?.xg?.away?.xga ?? stats?.goals?.away?.avg_conceded ?? null;
  const aScored = stats?.xg?.away?.xgf ?? stats?.goals?.away?.avg_scored ?? null;
  const hConceded = stats?.xg?.home?.xga ?? stats?.goals?.home?.avg_conceded ?? null;

  if (hScored !== null && aConceded !== null && aScored !== null && hConceded !== null) {
    const combined = (hScored + aConceded + aScored + hConceded) / 2;
    // combined ≥ 3.0 → full 20; 1.5 → 0; linear interpolation
    scoringScore = Math.max(0, Math.min(20, ((combined - 1.5) / 1.5) * 20));
  }

  // ── Component 3: Form signal (0–15) ─────────────────────────────────────
  let formScore = 0;
  const hForm = stats?.form?.home;
  const aForm = stats?.form?.away;
  if (hForm && aForm) {
    const hW = hForm.w ?? 0,
      hL = hForm.l ?? 0;
    const aW = aForm.w ?? 0,
      aL = aForm.l ?? 0;
    // One-sided form dominance drives predictability
    const formDiff = Math.abs(hW - hL - (aW - aL));
    formScore = Math.min(15, (formDiff / 4) * 15);
  }

  // ── Component 4: 1X2 gate (0–20) ─────────────────────────────────────────
  // Contribute only when the short price implies ≥70% probability.
  let oneX2Score = 0;
  const home1x2 = odds?.["1x2"]?.home;
  const away1x2 = odds?.["1x2"]?.away;
  const homeDnb = odds?.dnb?.home;
  const awayDnb = odds?.dnb?.away;

  const _impliedProb = (price: number | null | undefined): number =>
    price != null && price > 1 ? 1 / price : 0;

  const homeImplied = _impliedProb(homeDnb ?? home1x2);
  const awayImplied = _impliedProb(awayDnb ?? away1x2);
  const shortImplied = Math.max(homeImplied, awayImplied);
  if (shortImplied >= 0.7) {
    // Scale 0.7→1.0 range to 0–20 points
    oneX2Score = Math.min(20, ((shortImplied - 0.7) / 0.3) * 20);
  }

  // ── Component 5: H2H dominance (0–10) ────────────────────────────────────
  // One-sided head-to-head history adds predictability, but only once there's
  // enough shared history to mean anything — 1-2 past meetings are noise.
  let h2hScore = 0;
  const h2h = stats?.h2h;
  if (h2h && (h2h.total ?? 0) >= MIN_H2H_SAMPLE) {
    const total = h2h.total!;
    const dominance = Math.abs((h2h.home_wins ?? 0) - (h2h.away_wins ?? 0)) / total;
    h2hScore = Math.min(10, dominance * 10);
  }

  // ── Component 6: Standings gap (0–10) ────────────────────────────────────
  // Points-per-game gap (not raw position) so early-season/short tables don't
  // understate the gap and long tables don't overstate it.
  let standingsScore = 0;
  const hStand = stats?.standings?.home;
  const aStand = stats?.standings?.away;
  if (hStand?.played && aStand?.played && hStand.played > 0 && aStand.played > 0) {
    const hPpg = (hStand.points ?? 0) / hStand.played;
    const aPpg = (aStand.points ?? 0) / aStand.played;
    // ppg gap ≥ 1.5 → full 10 (e.g. title-chaser vs relegation-zone side)
    standingsScore = Math.min(10, (Math.abs(hPpg - aPpg) / 1.5) * 10);
  }

  const raw = favouriteScore + scoringScore + formScore + oneX2Score + h2hScore + standingsScore;
  return Math.max(0, Math.min(100, Math.round(raw - penalty)));
}

// ── Composite scoring ─────────────────────────────────────────────────────────

export interface SelectionCandidate {
  job: FixtureJob;
  hasBulkOdds: boolean; // matched by the free bulk the-odds-api call
  /** True for the top-N by composite score — routes to paid LLM tiers. */
  llmEligible: boolean;
  /** Per-fixture odds/stats from the SportyBet sidecar v2 enrichment. */
  sportyBetDetail?: SportyBetEventDetail;
}

/** Predictability-led composite score. Max ~115 (capped implicitly by components).
 *  predictabilityScore dominates (0–60), then bulk odds (+30), kickoff window
 *  (0–10), market depth (0–10), mild priority-league tilt (+15). */
export function scoreFixture(c: SelectionCandidate, marketCount: number, now: Date): number {
  let score = 0;
  // Predictability leads — scaled from 0–100 to 0–60 band
  score += (predictabilityScore(c.sportyBetDetail, c.job.league) / 100) * 60;
  // Mild priority-league tilt (reduced from +50 to keep "irrespective of league")
  if (ORACLE_PRIORITY_LEAGUES.has(c.job.league)) score += 15;
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
  /** All gated fixtures returned (= sportyBet when not fail-open). */
  selected: number;
  bulkOdds: number;
  priority: number;
  /** Fixtures routed to paid LLM tiers (top-N by score). */
  llmRouted: number;
  /** Near-duplicate fixtures collapsed before the LLM cap (same match, name variants). */
  deduped: number;
  /** Total fixtures that will be analyzed (deterministic + LLM). */
  analyzed: number;
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
 *  mark the top-N as llmEligible.  ALL gated fixtures are returned; the cap
 *  is a routing gate only (llmEligible flag), not an inclusion gate.
 *  Ordering: score desc, kickoff asc, home name asc. */
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
  const details = new Map<SelectionCandidate, SportyBetEventDetail | undefined>();
  let gated: SelectionCandidate[];
  if (failOpen) {
    gated = todayOnly;
  } else {
    const idx = opts.sportyBet as SportyBetIndex;
    gated = [];
    for (const c of todayOnly) {
      const key = sidecarKey(c.job.home, c.job.away);
      let marketCount = idx.byKey.get(key);
      let detail = idx.detailByKey.get(key);
      // Fuzzy fallback when the exact key misses EITHER the market count or the
      // enrichment detail. The sidecar keys fixtures under full club names
      // (e.g. "GIF Sundsvall") while the scraped/cached job often carries the
      // short form ("Sundsvall"), so the exact sidecarKey can hit byKey but miss
      // detailByKey (or vice-versa). Without the detail, injectSidecarOdds attaches
      // no odds and the engine grades the fixture NO_EDGE — the OTS name-gap.
      if (marketCount === undefined || detail === undefined) {
        const ev = idx.events.find(
          (e) => namesMatch(e.home, c.job.home) && namesMatch(e.away, c.job.away)
        );
        if (ev) {
          if (marketCount === undefined) marketCount = ev.marketCount;
          if (detail === undefined) detail = ev.detail;
        }
      }
      if (marketCount !== undefined) {
        marketCounts.set(c, marketCount);
        details.set(c, detail);
        gated.push(c);
      }
    }
  }
  const droppedBulkOdds = failOpen
    ? 0
    : todayOnly.filter((c) => c.hasBulkOdds).length - gated.filter((c) => c.hasBulkOdds).length;

  // Score all gated fixtures; top-N (by cap) get llmEligible = true
  const scoredAll = gated
    .map((c) => ({ c, score: scoreFixture(c, marketCounts.get(c) ?? 0, now) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.c.job.kickoff.localeCompare(b.c.job.kickoff) ||
        a.c.job.home.localeCompare(b.c.job.home)
    );

  // Collapse near-duplicate fixtures before the cap. Multiple sources/sweeps emit
  // the same match under name variants the canonical sidecarKey can't merge
  // (e.g. "Ilves vs Jaro" and "Tampereen Ilves vs FF Jaro"). Both would otherwise
  // occupy a slate slot — and, worse, a scarce top-N LLM slot. We keep the first
  // (highest-scoring) variant of each match. Two fixtures are the same when both
  // sides namesMatch and they kick off on the same UTC day (substring-tolerant
  // namesMatch can over-match alone — e.g. "United" vs "Leeds United" — so both
  // sides + same day is the conservative AND gate).
  // Malformed kickoff strings (upstream API schema drift) must not crash the
  // whole batch — fall back to the raw string for day-bucketing on a bad date.
  const dayOf = (kickoff: string): string => {
    const d = new Date(kickoff);
    return Number.isNaN(d.getTime()) ? kickoff : d.toISOString().slice(0, 10);
  };

  const scored: typeof scoredAll = [];
  for (const s of scoredAll) {
    const day = dayOf(s.c.job.kickoff);
    const dup = scored.some(
      (k) =>
        dayOf(k.c.job.kickoff) === day &&
        namesMatch(k.c.job.home, s.c.job.home) &&
        namesMatch(k.c.job.away, s.c.job.away)
    );
    if (!dup) scored.push(s);
  }

  const llmCap = Math.max(0, opts.cap);
  const selected: SelectionCandidate[] = scored.map((s, i) => ({
    ...s.c,
    llmEligible: i < llmCap,
    sportyBetDetail: details.get(s.c),
  }));

  return {
    selected,
    stats: {
      pool: pool.length,
      today: todayOnly.length,
      sportyBet: gated.length,
      selected: selected.length,
      analyzed: selected.length,
      llmRouted: selected.filter((c) => c.llmEligible).length,
      deduped: scoredAll.length - scored.length,
      bulkOdds: selected.filter((c) => c.hasBulkOdds).length,
      priority: selected.filter((c) => ORACLE_PRIORITY_LEAGUES.has(c.job.league)).length,
      droppedBulkOdds,
      failOpen,
    },
  };
}
