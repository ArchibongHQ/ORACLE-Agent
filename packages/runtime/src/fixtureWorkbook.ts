/** Daily fixture data as structured spreadsheets (.xlsx) — the deliverable that
 *  replaces the HTML daily-fixture report. Two separate files per day (Telegram
 *  delivery cap: <2MB per file — see TELEGRAM_FILE_BUDGET_BYTES):
 *
 *   - "Fixtures" file: one row per fixture, EVERY scraped/derived field as a
 *     column (home/away split into _H / _A columns). Always tiny (~0.1MB).
 *   - "Markets" file(s): one row per (fixture × market × outcome) — the
 *     line-by-line "all markets + odds" requirement. This is ~90% of the bytes
 *     (~100k rows on a real slate); when a single file would blow the budget it
 *     is split at FIXTURE boundaries into -part{i}of{n} files, each under
 *     budget. Built via ExcelJS's regular in-memory Workbook API (not the
 *     streaming WorkbookWriter) so the render helpers stay pure functions their
 *     own tests read back in-memory; parts are serialized one at a time to keep
 *     a single workbook in memory.
 *
 *  Reuses the exact data-loading + field-shaping helpers the HTML report used
 *  (loadSportyBetIndex / loadLineupSummaries / buildNewsByTeam / buildMotivation /
 *  buildTravel / dataCompleteness / lookupMarket / PRICEABLE_FAMILIES) so the two
 *  outputs can never drift in what data they consider "captured". */
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lookupMarket, PRICEABLE_FAMILIES } from "@oracle/engine";
import ExcelJS from "exceljs";
import { type DailyNewsRow, loadDailyNews, teamSlug } from "./dailyStore.js";
import { scoreCompleteness } from "./goalsV3/completeness.js";
import { classifyEligibility } from "./goalsV3/eligibility.js";
import { scorePredictabilityV3 } from "./goalsV3/predictability.js";
import { findLineupSummary, type LineupSummary, loadLineupSummaries } from "./lineups.js";
import { loadSportyBetIndex, type SportyBetEvent } from "./selectFixtures.js";
import { dataCompleteness } from "./selectGoals.js";
import { buildMotivation } from "./sportyBetStats.js";
import { buildTravel } from "./travel.js";

/** Joined "2-0; 2-2; 3-1" string from the un-discarded H2H match-by-match detail. */
function h2hResultsLine(
  matches: Array<{ home_goals?: number; away_goals?: number }> | null | undefined
): string {
  if (!matches?.length) return "";
  return matches
    .filter((m) => typeof m.home_goals === "number" && typeof m.away_goals === "number")
    .map((m) => `${m.home_goals}-${m.away_goals}`)
    .join("; ");
}

/** Column spec for the Fixtures sheet. `get` pulls the value off an event;
 *  undefined/null becomes a blank cell. Kept declarative so adding a newly-captured
 *  field is a one-line addition, not a rewrite. */
interface FixtureColumn {
  header: string;
  width?: number;
  get: (ctx: FixtureRowCtx) => string | number | null | undefined;
}

interface FixtureRowCtx {
  event: SportyBetEvent;
  lineup: LineupSummary | undefined;
  homeNews: DailyNewsRow[];
  awayNews: DailyNewsRow[];
}

function newsSummaryLine(rows: DailyNewsRow[]): string {
  return rows.map((n) => `${n.source}: ${n.summary}`).join(" | ");
}

/** Neutralizes CSV/XLSX formula injection (CWE-1236): every text column here is
 *  sourced from scraped/external data (team names, RSS/news summaries, lineup
 *  names, market labels) — a value starting with one of these characters is
 *  auto-evaluated as a formula by Excel/LibreOffice/Sheets on open. Prefixing
 *  with a single quote forces text interpretation in every major spreadsheet app. */
function sanitizeCell<T>(v: T): T {
  if (typeof v !== "string" || v.length === 0) return v;
  return (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v) as unknown as T;
}

const FIXTURE_COLUMNS: FixtureColumn[] = [
  { header: "Home", width: 22, get: ({ event }) => event.home },
  { header: "Away", width: 22, get: ({ event }) => event.away },
  { header: "League", width: 22, get: ({ event }) => event.league ?? "" },
  {
    header: "Kickoff (UTC)",
    width: 18,
    get: ({ event }) => (event.kickoff_utc ?? "").slice(0, 16).replace("T", " "),
  },
  { header: "Market count", width: 12, get: ({ event }) => event.marketCount },
  {
    header: "Event ID",
    width: 18,
    get: ({ event }) => event.eventId ?? event.detail?.eventId ?? "",
  },
  // ── Odds (typed) ──────────────────────────────────────────────────────────
  { header: "1X2 H", get: ({ event }) => event.detail?.odds?.["1x2"]?.home ?? null },
  { header: "1X2 D", get: ({ event }) => event.detail?.odds?.["1x2"]?.draw ?? null },
  { header: "1X2 A", get: ({ event }) => event.detail?.odds?.["1x2"]?.away ?? null },
  { header: "O1.5", get: ({ event }) => event.detail?.odds?.ou15?.over ?? null },
  { header: "U1.5", get: ({ event }) => event.detail?.odds?.ou15?.under ?? null },
  { header: "O2.5", get: ({ event }) => event.detail?.odds?.ou25?.over ?? null },
  { header: "U2.5", get: ({ event }) => event.detail?.odds?.ou25?.under ?? null },
  { header: "O3.5", get: ({ event }) => event.detail?.odds?.ou35?.over ?? null },
  { header: "U3.5", get: ({ event }) => event.detail?.odds?.ou35?.under ?? null },
  { header: "BTTS Y", get: ({ event }) => event.detail?.odds?.btts?.yes ?? null },
  { header: "BTTS N", get: ({ event }) => event.detail?.odds?.btts?.no ?? null },
  { header: "DNB H", get: ({ event }) => event.detail?.odds?.dnb?.home ?? null },
  { header: "DNB A", get: ({ event }) => event.detail?.odds?.dnb?.away ?? null },
  // ── Form ──────────────────────────────────────────────────────────────────
  { header: "Form_H", get: ({ event }) => event.detail?.stats?.form?.home?.last5 ?? "" },
  { header: "Form_A", get: ({ event }) => event.detail?.stats?.form?.away?.last5 ?? "" },
  { header: "Streak_H", get: ({ event }) => event.detail?.stats?.form?.home?.streak ?? null },
  { header: "Streak_A", get: ({ event }) => event.detail?.stats?.form?.away?.streak ?? null },
  // ── Standings ─────────────────────────────────────────────────────────────
  { header: "Pos_H", get: ({ event }) => event.detail?.stats?.standings?.home?.pos ?? null },
  { header: "Pos_A", get: ({ event }) => event.detail?.stats?.standings?.away?.pos ?? null },
  { header: "Pts_H", get: ({ event }) => event.detail?.stats?.standings?.home?.points ?? null },
  { header: "Pts_A", get: ({ event }) => event.detail?.stats?.standings?.away?.points ?? null },
  { header: "Played_H", get: ({ event }) => event.detail?.stats?.standings?.home?.played ?? null },
  { header: "Played_A", get: ({ event }) => event.detail?.stats?.standings?.away?.played ?? null },
  { header: "GF_H", get: ({ event }) => event.detail?.stats?.standings?.home?.gf ?? null },
  { header: "GF_A", get: ({ event }) => event.detail?.stats?.standings?.away?.gf ?? null },
  { header: "GA_H", get: ({ event }) => event.detail?.stats?.standings?.home?.ga ?? null },
  { header: "GA_A", get: ({ event }) => event.detail?.stats?.standings?.away?.ga ?? null },
  // ── Season goals avg ──────────────────────────────────────────────────────
  {
    header: "SeasonGF_H",
    get: ({ event }) => event.detail?.stats?.goals?.home?.avg_scored ?? null,
  },
  {
    header: "SeasonGF_A",
    get: ({ event }) => event.detail?.stats?.goals?.away?.avg_scored ?? null,
  },
  {
    header: "SeasonGA_H",
    get: ({ event }) => event.detail?.stats?.goals?.home?.avg_conceded ?? null,
  },
  {
    header: "SeasonGA_A",
    get: ({ event }) => event.detail?.stats?.goals?.away?.avg_conceded ?? null,
  },
  // ── H2H ───────────────────────────────────────────────────────────────────
  { header: "H2H total", get: ({ event }) => event.detail?.stats?.h2h?.total ?? null },
  { header: "H2H homeWins", get: ({ event }) => event.detail?.stats?.h2h?.home_wins ?? null },
  { header: "H2H awayWins", get: ({ event }) => event.detail?.stats?.h2h?.away_wins ?? null },
  { header: "H2H draws", get: ({ event }) => event.detail?.stats?.h2h?.draws ?? null },
  {
    header: "H2H results",
    width: 28,
    get: ({ event }) => h2hResultsLine(event.detail?.stats?.h2h?.matches),
  },
  // ── xG ────────────────────────────────────────────────────────────────────
  { header: "xGF_H", get: ({ event }) => event.detail?.stats?.xg?.home?.xgf ?? null },
  { header: "xGF_A", get: ({ event }) => event.detail?.stats?.xg?.away?.xgf ?? null },
  { header: "xGA_H", get: ({ event }) => event.detail?.stats?.xg?.home?.xga ?? null },
  { header: "xGA_A", get: ({ event }) => event.detail?.stats?.xg?.away?.xga ?? null },
  {
    header: "xG src",
    get: ({ event }) =>
      event.detail?.stats?.xg?.home?.src ?? event.detail?.stats?.xg?.away?.src ?? "",
  },
  // Venue-split xG (tools/build_xg_table.py) — the home team's xG conditioned on
  // ITS home matches only, the away team's on ITS away matches only, rather than
  // the season-aggregate xgf/xga above. Absent until a team has ≥1 venue-tagged
  // match in Understat's per-match record (Phase E gap-closure).
  { header: "xGF_H (venue)", get: ({ event }) => event.detail?.stats?.xg?.home?.venueXgf ?? null },
  { header: "xGA_H (venue)", get: ({ event }) => event.detail?.stats?.xg?.home?.venueXga ?? null },
  { header: "xGF_A (venue)", get: ({ event }) => event.detail?.stats?.xg?.away?.venueXgf ?? null },
  { header: "xGA_A (venue)", get: ({ event }) => event.detail?.stats?.xg?.away?.venueXga ?? null },
  {
    header: "xG estimated?",
    get: ({ event }) => {
      const srcs = [event.detail?.stats?.xg?.home?.src, event.detail?.stats?.xg?.away?.src];
      return srcs.some((s) => s === "google_ai") ? "yes" : "";
    },
  },
  // ── O/U hit-rate ──────────────────────────────────────────────────────────
  {
    header: "O1.5%_H",
    get: ({ event }) => event.detail?.stats?.overunder?.home?.over15_pct ?? null,
  },
  {
    header: "O1.5%_A",
    get: ({ event }) => event.detail?.stats?.overunder?.away?.over15_pct ?? null,
  },
  {
    header: "O2.5%_H",
    get: ({ event }) => event.detail?.stats?.overunder?.home?.over25_pct ?? null,
  },
  {
    header: "O2.5%_A",
    get: ({ event }) => event.detail?.stats?.overunder?.away?.over25_pct ?? null,
  },
  {
    header: "O3.5%_H",
    get: ({ event }) => event.detail?.stats?.overunder?.home?.over35_pct ?? null,
  },
  {
    header: "O3.5%_A",
    get: ({ event }) => event.detail?.stats?.overunder?.away?.over35_pct ?? null,
  },
  // ── Congestion ────────────────────────────────────────────────────────────
  {
    header: "Rest_H",
    get: ({ event }) => event.detail?.stats?.congestion?.home?.rest_days ?? null,
  },
  {
    header: "Rest_A",
    get: ({ event }) => event.detail?.stats?.congestion?.away?.rest_days ?? null,
  },
  {
    header: "Next_H",
    get: ({ event }) => event.detail?.stats?.congestion?.home?.next_days ?? null,
  },
  {
    header: "Next_A",
    get: ({ event }) => event.detail?.stats?.congestion?.away?.next_days ?? null,
  },
  // ── Possession / shots / corners ──────────────────────────────────────────
  {
    header: "SoT_H",
    get: ({ event }) => event.detail?.stats?.possessionValue?.home?.shots_on_target_avg ?? null,
  },
  {
    header: "SoT_A",
    get: ({ event }) => event.detail?.stats?.possessionValue?.away?.shots_on_target_avg ?? null,
  },
  {
    header: "Corners_H",
    get: ({ event }) => event.detail?.stats?.possessionValue?.home?.corners_avg ?? null,
  },
  {
    header: "Corners_A",
    get: ({ event }) => event.detail?.stats?.possessionValue?.away?.corners_avg ?? null,
  },
  {
    header: "Poss%_H",
    get: ({ event }) => event.detail?.stats?.possessionValue?.home?.possession_pct_avg ?? null,
  },
  {
    header: "Poss%_A",
    get: ({ event }) => event.detail?.stats?.possessionValue?.away?.possession_pct_avg ?? null,
  },
  {
    header: "RecentCorners_H",
    get: ({ event }) => event.detail?.stats?.recentCorners?.home ?? null,
  },
  {
    header: "RecentCorners_A",
    get: ({ event }) => event.detail?.stats?.recentCorners?.away ?? null,
  },
  // ── Recent goals (last 5) ─────────────────────────────────────────────────
  {
    header: "RecentGF_H",
    get: ({ event }) => event.detail?.stats?.recentGoals?.home?.scored_avg ?? null,
  },
  {
    header: "RecentGF_A",
    get: ({ event }) => event.detail?.stats?.recentGoals?.away?.scored_avg ?? null,
  },
  {
    header: "RecentGA_H",
    get: ({ event }) => event.detail?.stats?.recentGoals?.home?.conceded_avg ?? null,
  },
  {
    header: "RecentGA_A",
    get: ({ event }) => event.detail?.stats?.recentGoals?.away?.conceded_avg ?? null,
  },
  // ── Scoring/Conceding (venue split) ───────────────────────────────────────
  {
    header: "BTTS%_H",
    get: ({ event }) => event.detail?.stats?.scoringConceding?.home?.btts_rate ?? null,
  },
  {
    header: "BTTS%_A",
    get: ({ event }) => event.detail?.stats?.scoringConceding?.away?.btts_rate ?? null,
  },
  {
    header: "FTS%_H",
    get: ({ event }) => event.detail?.stats?.scoringConceding?.home?.failed_to_score_rate ?? null,
  },
  {
    header: "FTS%_A",
    get: ({ event }) => event.detail?.stats?.scoringConceding?.away?.failed_to_score_rate ?? null,
  },
  {
    header: "CS%_H",
    get: ({ event }) => event.detail?.stats?.scoringConceding?.home?.clean_sheet_rate ?? null,
  },
  {
    header: "CS%_A",
    get: ({ event }) => event.detail?.stats?.scoringConceding?.away?.clean_sheet_rate ?? null,
  },
  {
    header: "HTscoring%_H",
    get: ({ event }) => event.detail?.stats?.scoringConceding?.home?.scoring_1h_rate ?? null,
  },
  {
    header: "HTscoring%_A",
    get: ({ event }) => event.detail?.stats?.scoringConceding?.away?.scoring_1h_rate ?? null,
  },
  {
    header: "1Hgoals_H",
    get: ({ event }) => event.detail?.stats?.scoringConceding?.home?.goals_1h_avg ?? null,
  },
  {
    header: "1Hgoals_A",
    get: ({ event }) => event.detail?.stats?.scoringConceding?.away?.goals_1h_avg ?? null,
  },
  // ── Discipline ────────────────────────────────────────────────────────────
  {
    header: "Yellow_H",
    get: ({ event }) => event.detail?.stats?.disciplinary?.home?.yellow_avg ?? null,
  },
  {
    header: "Yellow_A",
    get: ({ event }) => event.detail?.stats?.disciplinary?.away?.yellow_avg ?? null,
  },
  { header: "Red_H", get: ({ event }) => event.detail?.stats?.disciplinary?.home?.red_avg ?? null },
  { header: "Red_A", get: ({ event }) => event.detail?.stats?.disciplinary?.away?.red_avg ?? null },
  {
    header: "Fouls_H",
    get: ({ event }) => event.detail?.stats?.disciplinary?.home?.fouls_avg ?? null,
  },
  {
    header: "Fouls_A",
    get: ({ event }) => event.detail?.stats?.disciplinary?.away?.fouls_avg ?? null,
  },
  // ── Position trend ────────────────────────────────────────────────────────
  {
    header: "PosTrend_H",
    get: ({ event }) => event.detail?.stats?.positionHistory?.home?.trend ?? null,
  },
  {
    header: "PosTrend_A",
    get: ({ event }) => event.detail?.stats?.positionHistory?.away?.trend ?? null,
  },
  // ── Lead scorer ───────────────────────────────────────────────────────────
  {
    header: "TopScorer_H",
    width: 18,
    get: ({ event }) => event.detail?.stats?.topGoals?.home?.top_scorer_name ?? "",
  },
  {
    header: "TopScorerGoals_H",
    get: ({ event }) => event.detail?.stats?.topGoals?.home?.top_scorer_goals ?? null,
  },
  {
    header: "TopScorer_A",
    width: 18,
    get: ({ event }) => event.detail?.stats?.topGoals?.away?.top_scorer_name ?? "",
  },
  {
    header: "TopScorerGoals_A",
    get: ({ event }) => event.detail?.stats?.topGoals?.away?.top_scorer_goals ?? null,
  },
  // ── Derived (motivation / travel / completeness) ──────────────────────────
  {
    header: "Motivation",
    width: 30,
    get: ({ event }) => buildMotivation(event.detail).soft?.text ?? "",
  },
  {
    header: "Travel",
    width: 26,
    get: ({ event }) =>
      buildTravel(event.home, event.away, {
        neutralVenue: event.league === "FIFA World Cup",
      }).soft?.text ?? "",
  },
  { header: "Data completeness", get: ({ event }) => dataCompleteness(event.detail) },
  // ── goals-market-analysis-prompt-v3 (pre-enrichment; report-time snapshot) ──
  {
    header: "v3 Completeness",
    get: ({ event }) => scoreCompleteness(event.detail).score,
  },
  {
    header: "v3 Mandatory Missing",
    width: 24,
    get: ({ event }) => scoreCompleteness(event.detail).mandatoryMissing.join(", "),
  },
  {
    header: "v3 Eligibility",
    width: 14,
    get: ({ event }) => classifyEligibility(event).status,
  },
  {
    header: "v3 Eligibility reason",
    width: 26,
    get: ({ event }) => classifyEligibility(event).reasons.join("; "),
  },
  {
    header: "v3 Predictability",
    get: ({ event }) => scorePredictabilityV3(event),
  },
  // ── Lineups ───────────────────────────────────────────────────────────────
  {
    header: "Lineup_H",
    width: 30,
    get: ({ lineup }) =>
      lineup?.home_formation || lineup?.home_starting_xi?.length
        ? `${lineup.home_xi_confirmed ? "Confirmed" : "Expected"} ${lineup.home_formation ?? ""} ${(lineup.home_starting_xi ?? []).join(", ")}`.trim()
        : "",
  },
  {
    header: "Lineup_A",
    width: 30,
    get: ({ lineup }) =>
      lineup?.away_formation || lineup?.away_starting_xi?.length
        ? `${lineup.away_xi_confirmed ? "Confirmed" : "Expected"} ${lineup.away_formation ?? ""} ${(lineup.away_starting_xi ?? []).join(", ")}`.trim()
        : "",
  },
  // ── News ──────────────────────────────────────────────────────────────────
  { header: "News_H", width: 40, get: ({ homeNews }) => newsSummaryLine(homeNews) },
  { header: "News_A", width: 40, get: ({ awayNews }) => newsSummaryLine(awayNews) },
  // ── Funfacts ──────────────────────────────────────────────────────────────
  {
    header: "Funfacts",
    width: 40,
    get: ({ event }) => (event.detail?.stats?.commentary ?? []).join(" | "),
  },
];

export interface FixtureWorkbookDeps {
  lineups: LineupSummary[];
  newsByTeam: Map<string, DailyNewsRow[]>;
}

/** Build the Fixtures-only workbook (one row per fixture, every captured field).
 *  Pure — the caller writes/serializes. */
export function renderFixturesWorkbook(
  events: SportyBetEvent[],
  date: string,
  deps: FixtureWorkbookDeps
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ORACLE";
  wb.created = new Date();
  // Stamp the slate date into the workbook + sheet title so an exported file is
  // self-identifying once detached from its filename.
  wb.title = `ORACLE Daily Fixtures — ${date}`;

  const fx = wb.addWorksheet("Fixtures", { views: [{ state: "frozen", ySplit: 1 }] });
  fx.columns = FIXTURE_COLUMNS.map((c) => ({ header: c.header, width: c.width ?? 12 }));
  fx.getRow(1).font = { bold: true };

  for (const event of events) {
    const lineup = findLineupSummary(deps.lineups, event.home, event.away);
    const homeNews = deps.newsByTeam.get(teamSlug(event.home)) ?? [];
    const awayNews = deps.newsByTeam.get(teamSlug(event.away)) ?? [];
    const ctx: FixtureRowCtx = { event, lineup, homeNews, awayNews };
    fx.addRow(FIXTURE_COLUMNS.map((c) => sanitizeCell(c.get(ctx) ?? null)));
  }

  fx.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: FIXTURE_COLUMNS.length } };
  return wb;
}

/** One fixture's block of Markets-sheet rows. Groups are the atomic unit the
 *  size-capped writer partitions on — a fixture's markets never straddle two
 *  part files. */
export interface MarketRowGroup {
  home: string;
  away: string;
  rows: (string | number)[][];
}

/** Pure extraction of the Markets sheet data: one row per
 *  (fixture × market × outcome), same 9 columns as before the file split. */
export function buildMarketRowGroups(events: SportyBetEvent[]): MarketRowGroup[] {
  const groups: MarketRowGroup[] = [];
  for (const event of events) {
    const rows: (string | number)[][] = [];
    for (const m of event.detail?.odds?.allMarkets ?? []) {
      const cat = lookupMarket(m.id);
      const family = cat
        ? PRICEABLE_FAMILIES.has(cat.family)
          ? `${cat.family} *`
          : cat.family
        : "";
      for (const o of m.outcomes ?? []) {
        rows.push(
          [
            event.home,
            event.away,
            m.id,
            m.desc || m.name || m.id,
            family,
            m.group ?? "",
            m.specifier ?? "",
            o.desc ?? o.id,
            o.odds ?? "",
          ].map(sanitizeCell)
        );
      }
    }
    if (rows.length) groups.push({ home: event.home, away: event.away, rows });
  }
  return groups;
}

/** Build a Markets-only workbook from (a slice of) the row groups. */
export function renderMarketsWorkbook(groups: MarketRowGroup[], date: string): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ORACLE";
  wb.created = new Date();
  wb.title = `ORACLE Daily Markets — ${date}`;

  const mk = wb.addWorksheet("Markets", { views: [{ state: "frozen", ySplit: 1 }] });
  mk.columns = [
    { header: "Home", width: 22 },
    { header: "Away", width: 22 },
    { header: "Market ID", width: 12 },
    { header: "Market", width: 30 },
    { header: "Family", width: 20 },
    { header: "Group", width: 16 },
    { header: "Specifier", width: 14 },
    { header: "Outcome", width: 24 },
    { header: "Odds", width: 10 },
  ];
  mk.getRow(1).font = { bold: true };

  for (const g of groups) for (const row of g.rows) mk.addRow(row);
  return wb;
}

/** Telegram delivery budget per file. The user cap is 2MB; keep headroom so a
 *  part sized from a serialization estimate can't land a few KB over. */
export const TELEGRAM_FILE_BUDGET_BYTES = Math.floor(1.8 * 1024 * 1024);

/** Max DEFLATE — the markets data is ~90% of the bytes and pure repeated text,
 *  the CPU cost is a one-shot daily job. */
const XLSX_WRITE_OPTS = {
  zip: { compression: "DEFLATE" as const, compressionOptions: { level: 9 } },
};

export interface FixtureReportFiles {
  fixturesPath: string;
  marketsPaths: string[];
}

async function serialize(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer(XLSX_WRITE_OPTS));
}

/** Partition groups into exactly `min(parts, groups.length)` contiguous chunks,
 *  balanced by row count. Each chunk is capped so it never absorbs more groups
 *  than leaves enough remaining groups for the remaining chunks — otherwise a
 *  large group early in the list could swallow later groups into one chunk and
 *  under-shoot the requested part count (critical when parts === groups.length,
 *  the "one fixture per part" case the retry loop relies on to detect a truly
 *  unsplittable oversized fixture). */
function partitionGroups(groups: MarketRowGroup[], parts: number): MarketRowGroup[][] {
  const n = Math.min(parts, groups.length);
  const chunks: MarketRowGroup[][] = [];
  let idx = 0;
  let remainingRows = groups.reduce((sum, g) => sum + g.rows.length, 0);
  for (let c = 0; c < n; c++) {
    const remainingChunks = n - c;
    const maxTakeable = groups.length - idx - (remainingChunks - 1);
    const chunk: MarketRowGroup[] = [];
    let chunkRows = 0;
    while (idx < groups.length) {
      if (chunk.length > 0 && chunk.length >= maxTakeable) break;
      if (chunk.length > 0 && chunkRows >= remainingRows / remainingChunks) break;
      const g = groups[idx] as MarketRowGroup;
      chunk.push(g);
      chunkRows += g.rows.length;
      idx += 1;
    }
    chunks.push(chunk);
    remainingRows -= chunkRows;
  }
  return chunks;
}

/** Write the two-deliverable file set for a slate:
 *
 *   - oracle-fixtures-{date}.xlsx — always a single small file.
 *   - oracle-markets-{date}.xlsx — when it fits the budget, one file; otherwise
 *     split at fixture boundaries into oracle-markets-{date}-part{i}of{n}.xlsx
 *     parts, each under the budget. Parts are serialized one at a time so only
 *     one ExcelJS workbook is ever in memory (7.84GB box, worker OOM history).
 *
 *  Same primary-then-timestamp-suffixed collision pattern as before, with ONE
 *  shared suffix across the whole set so a re-run's files stay grouped. */
export async function writeFixtureReportFiles(
  events: SportyBetEvent[],
  date: string,
  deps: FixtureWorkbookDeps,
  outDir = ".tmp/reports",
  budgetBytes = TELEGRAM_FILE_BUDGET_BYTES
): Promise<FixtureReportFiles> {
  await mkdir(outDir, { recursive: true });
  let suffix = "";
  try {
    await access(join(outDir, `oracle-fixtures-${date}.xlsx`));
    suffix = `-${Date.now()}`;
  } catch {
    // Primary does not exist — claim it
  }

  const fixturesPath = join(outDir, `oracle-fixtures-${date}${suffix}.xlsx`);
  const fxBuf = await serialize(renderFixturesWorkbook(events, date, deps));
  if (fxBuf.length > budgetBytes) {
    process.stderr.write(
      `[fixture-workbook] WARN fixtures file ${fxBuf.length} bytes exceeds the ${budgetBytes}-byte budget (not split — investigate column bloat)\n`
    );
  }
  await writeFile(fixturesPath, fxBuf);

  const groups = buildMarketRowGroups(events);
  if (!groups.length) return { fixturesPath, marketsPaths: [] };

  const single = await serialize(renderMarketsWorkbook(groups, date));
  if (single.length <= budgetBytes) {
    const marketsPath = join(outDir, `oracle-markets-${date}${suffix}.xlsx`);
    await writeFile(marketsPath, single);
    return { fixturesPath, marketsPaths: [marketsPath] };
  }

  // Over budget: re-partition with one more part each attempt until every part
  // fits. Starts at the byte-ratio estimate, which is almost always right.
  let parts = Math.min(groups.length, Math.ceil(single.length / budgetBytes));
  for (;;) {
    const chunks = partitionGroups(groups, parts);
    // Once parts === groups.length there's no more splitting to try, so finish
    // building every chunk's buffer instead of bailing on the first oversized
    // one — otherwise the "ship oversized" fallback below would have to
    // re-serialize everything from scratch.
    const willRetryOnOverflow = parts < groups.length;
    const buffers: Buffer[] = [];
    let allFit = true;
    for (const chunk of chunks) {
      const buf = await serialize(renderMarketsWorkbook(chunk, date));
      buffers.push(buf);
      if (buf.length > budgetBytes) {
        allFit = false;
        if (willRetryOnOverflow) break;
      }
    }
    if (!allFit && willRetryOnOverflow) {
      parts += 1;
      continue;
    }
    if (!allFit) {
      // A single fixture's markets alone exceed the budget — can't split below
      // the fixture boundary; ship oversized rather than drop data.
      process.stderr.write(
        `[fixture-workbook] WARN a markets part exceeds the ${budgetBytes}-byte budget even at one fixture per part — shipping oversized\n`
      );
    }
    const marketsPaths: string[] = [];
    for (let i = 0; i < buffers.length; i++) {
      const p = join(
        outDir,
        `oracle-markets-${date}${suffix}-part${i + 1}of${buffers.length}.xlsx`
      );
      await writeFile(p, buffers[i] as Buffer);
      marketsPaths.push(p);
    }
    return { fixturesPath, marketsPaths };
  }
}

/** One-call generate-and-write for a date — the .xlsx replacement for
 *  generateAndWriteDailyFixtureReport. Returns null when SportyBet listed no
 *  fixtures for the date (nothing to report); never throws. */
export async function generateAndWriteFixtureWorkbook(
  date: string,
  outDir: string
): Promise<{
  fixturesPath: string;
  marketsPaths: string[];
  fixtureCount: number;
  marketsEmpty: boolean;
} | null> {
  const index = await loadSportyBetIndex(date);
  if (!index?.events.length) return null;
  // Coverage guard: the SportyBet scrape file is enriched with per-fixture
  // allMarkets depth over time (the report cron can fire before that pass lands),
  // which produced header-only "Markets" sheets in production. Surface the empty
  // state so the caller can skip the silent auto-push and let a later run ship the
  // enriched version, instead of silently shipping a report with no markets.
  const marketsEmpty = !index.events.some((e) => (e.detail?.odds?.allMarkets?.length ?? 0) > 0);
  const [lineups, newsByTeam] = await Promise.all([
    loadLineupSummaries(),
    buildNewsByTeamForWorkbook(index.events, date),
  ]);
  const files = await writeFixtureReportFiles(index.events, date, { lineups, newsByTeam }, outDir);
  return { ...files, fixtureCount: index.events.length, marketsEmpty };
}

/** Locate an already-written report file set for a date (bot on-disk shortcut).
 *  Prefers the primary (unsuffixed) fixtures file, else the newest suffixed one,
 *  and pairs it with the markets file(s) carrying the same suffix. Returns null
 *  when no fixtures file exists. */
export async function listFixtureReportFiles(
  date: string,
  outDir: string
): Promise<FixtureReportFiles | null> {
  let names: string[];
  try {
    names = await readdir(outDir);
  } catch {
    return null;
  }
  const fixturePattern = new RegExp(`^oracle-fixtures-${date}(-\\d+)?\\.xlsx$`);
  const candidates = names.filter((n) => fixturePattern.test(n)).sort();
  if (!candidates.length) return null;
  const primary = `oracle-fixtures-${date}.xlsx`;
  // Sorted ascending: primary (no suffix) sorts before timestamped ones; prefer
  // it, else take the newest (largest) timestamp.
  const fixturesName = candidates.includes(primary)
    ? primary
    : (candidates[candidates.length - 1] as string);
  const suffix = fixturesName.slice(`oracle-fixtures-${date}`.length, -".xlsx".length);
  const marketsPattern = new RegExp(`^oracle-markets-${date}${suffix}(-part(\\d+)of\\d+)?\\.xlsx$`);
  const marketsPaths = names
    .filter((n) => marketsPattern.test(n))
    .sort((a, b) => {
      const idx = (n: string) => Number(marketsPattern.exec(n)?.[2] ?? 0);
      return idx(a) - idx(b);
    })
    .map((n) => join(outDir, n));
  return { fixturesPath: join(outDir, fixturesName), marketsPaths };
}

/** Same one-pass team→news loader as the HTML report's buildNewsByTeam, kept
 *  local so this module doesn't import from dailyFixtureReport (which would couple
 *  the .xlsx output to the HTML module we're retiring). */
async function buildNewsByTeamForWorkbook(
  events: SportyBetEvent[],
  date: string
): Promise<Map<string, DailyNewsRow[]>> {
  const slugs = new Set<string>();
  for (const e of events) {
    slugs.add(teamSlug(e.home));
    slugs.add(teamSlug(e.away));
  }
  const byTeam = new Map<string, DailyNewsRow[]>();
  for (const slug of slugs) {
    const rows = await loadDailyNews(date, slug);
    if (rows?.length) byTeam.set(slug, rows);
  }
  return byTeam;
}
