/** Daily fixture data as a structured spreadsheet (.xlsx) — the deliverable that
 *  replaces the HTML daily-fixture report. One workbook per day with two sheets:
 *
 *   - "Fixtures": one row per fixture, EVERY scraped/derived field as a column
 *     (home/away split into _H / _A columns). The audit's complaint was that the
 *     HTML report surfaced only a fraction of what the scraper captures; here the
 *     full SportyBetStats surface is laid out column-by-column so nothing is hidden.
 *   - "Markets": one row per (fixture × market × outcome) — the line-by-line "all
 *     markets + odds" requirement. Built via ExcelJS's regular in-memory Workbook
 *     API (not the streaming WorkbookWriter), so renderFixtureWorkbook can stay a
 *     pure function its own tests read back in-memory; revisit if a slate's total
 *     fixture×market×outcome row count starts threatening JS heap limits.
 *
 *  Reuses the exact data-loading + field-shaping helpers the HTML report used
 *  (loadSportyBetIndex / loadLineupSummaries / buildNewsByTeam / buildMotivation /
 *  buildTravel / dataCompleteness / lookupMarket / PRICEABLE_FAMILIES) so the two
 *  outputs can never drift in what data they consider "captured". */
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lookupMarket, PRICEABLE_FAMILIES } from "@oracle/engine";
import ExcelJS from "exceljs";
import { type DailyNewsRow, loadDailyNews, teamSlug } from "./dailyStore.js";
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

/** Build the in-memory workbook. Markets are written into the same workbook via a
 *  second sheet; for very large slates prefer generateAndWriteFixtureWorkbook which
 *  streams to disk. Returns an ExcelJS.Workbook the caller writes/serializes. */
export function renderFixtureWorkbook(
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

  for (const event of events) {
    const lineup = findLineupSummary(deps.lineups, event.home, event.away);
    const homeNews = deps.newsByTeam.get(teamSlug(event.home)) ?? [];
    const awayNews = deps.newsByTeam.get(teamSlug(event.away)) ?? [];
    const ctx: FixtureRowCtx = { event, lineup, homeNews, awayNews };
    fx.addRow(FIXTURE_COLUMNS.map((c) => sanitizeCell(c.get(ctx) ?? null)));

    for (const m of event.detail?.odds?.allMarkets ?? []) {
      const cat = lookupMarket(m.id);
      const family = cat
        ? PRICEABLE_FAMILIES.has(cat.family)
          ? `${cat.family} *`
          : cat.family
        : "";
      for (const o of m.outcomes ?? []) {
        mk.addRow(
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
  }

  fx.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: FIXTURE_COLUMNS.length } };
  return wb;
}

/** Writes the workbook to .tmp/reports/oracle-fixtures-{date}.xlsx — same atomic
 *  primary-then-suffixed collision pattern as writeDailyFixtureReport, on the .xlsx
 *  extension so it never collides with the (now-retired) HTML flavor. */
export async function writeFixtureWorkbook(
  wb: ExcelJS.Workbook,
  date: string,
  outDir = ".tmp/reports"
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const primary = join(outDir, `oracle-fixtures-${date}.xlsx`);
  let outPath = primary;
  try {
    await access(primary);
    outPath = join(outDir, `oracle-fixtures-${date}-${Date.now()}.xlsx`);
  } catch {
    // Primary does not exist — claim it
  }
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

/** One-call generate-and-write for a date — the .xlsx replacement for
 *  generateAndWriteDailyFixtureReport. Returns null when SportyBet listed no
 *  fixtures for the date (nothing to report); never throws. */
export async function generateAndWriteFixtureWorkbook(
  date: string,
  outDir: string
): Promise<{ path: string; fixtureCount: number; marketsEmpty: boolean } | null> {
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
  const wb = renderFixtureWorkbook(index.events, date, { lineups, newsByTeam });
  const path = await writeFixtureWorkbook(wb, date, outDir);
  return { path, fixtureCount: index.events.length, marketsEmpty };
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
