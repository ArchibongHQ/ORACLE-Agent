/** Reads tools/daily_store.py's Parquet lake (.tmp/oracle-daily/) — the 00:00
 *  acquisition snapshot — so the analysis/worker path can skip the live
 *  SportyBet/Gismo scrape + odds chain on a fresh lake. This is the latency
 *  seam: every export here returns null on a missing/stale/corrupt partition
 *  or a native-DuckDB-load failure, and every caller (fixtures.ts,
 *  selectFixtures.ts, oddsProviders.ts, newsIntel.ts) falls through to its
 *  existing JSON-sidecar/live path unchanged on null. Deleting the lake is
 *  byte-identical to today's behavior.
 *
 *  loadDailyFixtures returns the exact SportyBetIndex shape loadSportyBetIndex
 *  builds from the legacy JSON sidecar (selectFixtures.ts) so Step 5 call
 *  sites can swap with minimal churn. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeSqlLiteral, queryParquetRows } from "@oracle/storage";
import {
  type SportyBetEventDetail,
  type SportyBetIndex,
  type SportyBetOdds,
  type SportyBetStats,
  sidecarKey,
} from "./selectFixtures.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");
export const DAILY_LAKE_ROOT = join(ROOT, ".tmp", "oracle-daily");

function partitionPath(table: string, dt: string): string {
  return join(DAILY_LAKE_ROOT, table, `dt=${dt}`, "part.parquet");
}

// Row interfaces deliberately omit `dt` — live-verified 2026-06-21:
// DuckDB's getRowObjectsJS() coerces the stored `dt` VARCHAR column into an
// ISO timestamp string (e.g. "1999-02-01T00:00:00.000Z"), not the plain
// "YYYY-MM-DD" pyarrow wrote. Harmless here since every query already filters
// to one `dt=` partition by file path, so nothing reads the column back — but
// don't add a `dt` field to these interfaces expecting the raw string.
interface FixtureRow {
  event_id: string;
  home: string;
  away: string;
  league: string | null;
  league_id: string | null;
  kickoff_utc: string | null;
  market_count: number | bigint | null;
}

interface OddsRow {
  event_id: string;
  market: string;
  side: string;
  price: number | null;
  overround: number | null;
}

interface StatsRow {
  event_id: string;
  subtab: string;
  payload_json: string;
}

function groupBy<T, K>(rows: T[], keyOf: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = keyOf(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/** Un-flatten the odds table's tidy/long rows back into the nested
 *  SportyBetOdds shape flattenSidecarOdds/scanMarkets expect. The Asian
 *  Handicap line travels in the `overround` column at write time
 *  (tools/acquire_daily.py _flatten_odds) — every other market's overround is
 *  always null since the source odds block never carried a `line` key. */
function unflattenOdds(rows: OddsRow[]): SportyBetOdds | null {
  if (!rows.length) return null;
  const out: Record<string, Record<string, number | null>> = {};
  for (const r of rows) {
    if (r.price === null) continue;
    if (!out[r.market]) out[r.market] = {};
    const bucket = out[r.market];
    bucket[r.side] = r.price;
    if (r.market === "ah" && r.overround !== null) bucket.line = r.overround;
  }
  return out as unknown as SportyBetOdds;
}

/** Un-flatten the stats table's per-subtab rows back into the nested
 *  SportyBetStats shape, pulling `statscoverage` out as its own field (it
 *  lives alongside stats in SportyBetEventDetail, not inside it) — mirrors
 *  loadSportyBetIndex's JSON-sidecar parsing in selectFixtures.ts. */
function unflattenStats(rows: StatsRow[]): {
  stats: SportyBetStats | null;
  statscoverage: Record<string, unknown> | null;
} {
  const stats: Record<string, unknown> = {};
  let statscoverage: Record<string, unknown> | null = null;
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.payload_json);
    } catch {
      continue;
    }
    if (r.subtab === "statscoverage") statscoverage = parsed as Record<string, unknown>;
    else stats[r.subtab] = parsed;
  }
  return { stats: Object.keys(stats).length ? (stats as SportyBetStats) : null, statscoverage };
}

function toMarketCount(v: number | bigint | null): number {
  if (v === null) return 0;
  const n = typeof v === "bigint" ? Number(v) : v;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function buildDailyIndex(dt: string): Promise<SportyBetIndex | null> {
  const fixtureRows = await queryParquetRows<FixtureRow>(
    `SELECT * FROM read_parquet('${escapeSqlLiteral(partitionPath("fixtures", dt))}')`
  );
  // Missing partition / native-load failure → fail open. An existing-but-empty
  // partition (real query, zero rows) falls through to selectFixtures.ts's own
  // failOpen check (byKey.size === 0) — same as the JSON-sidecar path today.
  if (fixtureRows === null) return null;

  const oddsRows =
    (await queryParquetRows<OddsRow>(
      `SELECT * FROM read_parquet('${escapeSqlLiteral(partitionPath("odds", dt))}')`
    )) ?? [];
  const statsRows =
    (await queryParquetRows<StatsRow>(
      `SELECT * FROM read_parquet('${escapeSqlLiteral(partitionPath("stats", dt))}')`
    )) ?? [];

  const oddsByEvent = groupBy(oddsRows, (r) => r.event_id);
  const statsByEvent = groupBy(statsRows, (r) => r.event_id);

  const events: SportyBetIndex["events"] = [];
  const byKey = new Map<string, number>();
  const detailByKey = new Map<string, SportyBetEventDetail>();

  for (const fx of fixtureRows) {
    if (!fx.home?.trim() || !fx.away?.trim()) continue;
    const marketCount = toMarketCount(fx.market_count);
    const key = sidecarKey(fx.home, fx.away);
    const odds = unflattenOdds(oddsByEvent.get(fx.event_id) ?? []);
    const { stats, statscoverage } = unflattenStats(statsByEvent.get(fx.event_id) ?? []);
    const detail: SportyBetEventDetail = { eventId: fx.event_id, odds, stats, statscoverage };

    events.push({
      home: fx.home,
      away: fx.away,
      marketCount,
      league: fx.league ?? undefined,
      leagueId: fx.league_id || undefined,
      kickoff_utc: fx.kickoff_utc ?? undefined,
      detail,
    });
    byKey.set(key, marketCount);
    detailByKey.set(key, detail);
  }

  return { date: dt, byKey, detailByKey, events };
}

// Memoized per-date — loadDailyOdds/loadDailyFixtures share one query set per
// day instead of re-scanning the lake on every per-fixture odds lookup (the
// existing JSON-sidecar path re-reads its file per call too, but that's a
// cheap local read; re-running 3 DuckDB queries per fixture would not be).
let _cache: { dt: string; promise: Promise<SportyBetIndex | null> } | null = null;

/** Test-only: clear the per-date memoization cache between cases. Mirrors
 *  storage's _resetKeyLocks export convention. */
export function _resetDailyStoreCache(): void {
  _cache = null;
}

function loadDailyIndex(dt: string): Promise<SportyBetIndex | null> {
  if (_cache && _cache.dt === dt) return _cache.promise;
  const promise = buildDailyIndex(dt).then((idx) => {
    // Don't poison the whole day with a null/empty read that raced the morning
    // scrape (e.g. batch start at 08:35 vs. partition write at 10:07) — clear
    // the memo so the next caller re-queries instead of reusing this result
    // for the rest of the process lifetime. Guard on _cache.dt still matching
    // `dt`: a resolve-yesterday (dt=D-1) and daily-batch (dt=D) read can be
    // in flight together, and an unconditional null here would clobber a
    // different, still-valid in-flight/cached entry for the other date.
    if ((!idx || idx.events.length === 0) && _cache?.dt === dt) _cache = null;
    return idx;
  });
  _cache = { dt, promise };
  return promise;
}

/** Load today's SportyBet-shaped index from the Parquet lake. Same shape as
 *  loadSportyBetIndex (selectFixtures.ts) — null on a missing/corrupt
 *  partition or DuckDB load failure; callers fail open to the JSON sidecar. */
export async function loadDailyFixtures(dt: string): Promise<SportyBetIndex | null> {
  return loadDailyIndex(dt);
}

/** Sync existence check for the fixtures partition file — no DuckDB query.
 *  Lets a caller (e.g. the worker's freshness gate) tell "heartbeat says
 *  acquisition ran today" apart from "the partition is actually still on
 *  disk" (a heartbeat survives the lake directory being deleted/moved). */
export function fixturesPartitionExists(dt: string): boolean {
  return existsSync(partitionPath("fixtures", dt));
}

/** Lightweight per-fixture odds lookup for oddsProviders.ts's SportyBet tier —
 *  null when the lake is unavailable for `dt` OR the fixture has no odds rows. */
export async function loadDailyOdds(
  dt: string,
  home: string,
  away: string
): Promise<SportyBetOdds | null> {
  const idx = await loadDailyIndex(dt);
  if (!idx) return null;
  return idx.detailByKey.get(sidecarKey(home, away))?.odds ?? null;
}

export interface DailyNewsRow {
  source: string;
  summary: string;
  rawJson: string;
  scrapedAt: string;
}

/** Load a team's news rows (one per source — "perplexity" / "google_ai") from
 *  the Parquet lake's news table. Null on a missing partition / DuckDB load
 *  failure; [] is a real "no news rows for this team today" result. */
export async function loadDailyNews(dt: string, teamSlug: string): Promise<DailyNewsRow[] | null> {
  const rows = await queryParquetRows<{
    team_slug: string;
    source: string;
    summary: string;
    raw_json: string;
    scraped_at: string;
  }>(
    `SELECT * FROM read_parquet('${escapeSqlLiteral(partitionPath("news", dt))}') ` +
      `WHERE team_slug = '${escapeSqlLiteral(teamSlug)}'`
  );
  if (rows === null) return null;
  return rows.map((r) => ({
    source: r.source,
    summary: r.summary,
    rawJson: r.raw_json,
    scrapedAt: r.scraped_at,
  }));
}

/** Mirrors tools/enrich_news.py's slug() exactly (Unicode-aware alnum test,
 *  same collapse/strip rules) — the news table's team_slug column is computed
 *  Python-side, so this must match it exactly or lookups silently miss (the
 *  same class of bug as the OTS name-gap — see project memory). */
export function teamSlug(team: string): string {
  const lowered = team.toLowerCase().trim();
  let s = "";
  for (const ch of lowered) s += /[\p{L}\p{N}]/u.test(ch) ? ch : "_";
  while (s.includes("__")) s = s.replace(/__/g, "_");
  return s.replace(/^_+|_+$/g, "");
}
