/** Daily raw-fixture-data HTML report — a plain listing of every fixture
 *  SportyBet listed for the day plus its accompanying data, independent of
 *  engine selection or the goals-discovery funnel. A fixture the funnel never
 *  shortlists (or the main batch never analyzes) still appears here if
 *  SportyBet listed it for the day — this is NOT an engine-decision artifact
 *  (no picks/grades/lambdas), it carries no engine opinion.
 *
 *  Per owner instruction: "non-fancy text-only" — plain labeled-line blocks
 *  per fixture, not score cards. Reuses report.ts's dark-theme CSS/esc/pct
 *  helpers for visual consistency with the engine-decision report. */
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DailyNewsRow, loadDailyNews, teamSlug } from "./dailyStore.js";
import { findLineupSummary, type LineupSummary, loadLineupSummaries } from "./lineups.js";
import { CSS, esc, pct } from "./report.js";
import { loadSportyBetIndex, type SportyBetEvent } from "./selectFixtures.js";
import { dataCompleteness } from "./selectGoals.js";
import { buildMotivation } from "./sportyBetStats.js";
import { namesMatch } from "./teamNames.js";
import { buildTravel } from "./travel.js";

function line(label: string, value: string | null | undefined): string {
  if (!value) return "";
  return `<div class="raw-line"><span class="raw-label">${esc(label)}</span> ${esc(value)}</div>`;
}

function side(
  label: string,
  home: string | null | undefined,
  away: string | null | undefined
): string {
  if (home == null && away == null) return "";
  return `<div class="raw-line"><span class="raw-label">${esc(label)}</span> ${esc(home ?? "?")} / ${esc(away ?? "?")}</div>`;
}

function renderOdds(event: SportyBetEvent): string {
  const odds = event.detail?.odds;
  if (!odds) return line("Odds", "Not yet available");
  const parts: string[] = [];
  if (odds["1x2"]) {
    parts.push(
      `1X2: H ${odds["1x2"].home ?? "?"} / D ${odds["1x2"].draw ?? "?"} / A ${odds["1x2"].away ?? "?"}`
    );
  }
  if (odds.ou15) parts.push(`O/U 1.5: ${odds.ou15.over ?? "?"} / ${odds.ou15.under ?? "?"}`);
  if (odds.ou25) parts.push(`O/U 2.5: ${odds.ou25.over ?? "?"} / ${odds.ou25.under ?? "?"}`);
  if (odds.ou35) parts.push(`O/U 3.5: ${odds.ou35.over ?? "?"} / ${odds.ou35.under ?? "?"}`);
  if (odds.tt_home_05)
    parts.push(
      `Home Total O/U 0.5: ${odds.tt_home_05.over ?? "?"} / ${odds.tt_home_05.under ?? "?"}`
    );
  if (odds.tt_away_05)
    parts.push(
      `Away Total O/U 0.5: ${odds.tt_away_05.over ?? "?"} / ${odds.tt_away_05.under ?? "?"}`
    );
  if (odds.btts) parts.push(`BTTS: Y ${odds.btts.yes ?? "?"} / N ${odds.btts.no ?? "?"}`);
  if (odds.dc)
    parts.push(
      `Double Chance: 1X ${odds.dc["1x"] ?? "?"} / 12 ${odds.dc["12"] ?? "?"} / X2 ${odds.dc.x2 ?? "?"}`
    );
  if (odds.dnb) parts.push(`DNB: H ${odds.dnb.home ?? "?"} / A ${odds.dnb.away ?? "?"}`);
  if (odds.ah)
    parts.push(`AH (${odds.ah.line ?? "?"}): H ${odds.ah.home ?? "?"} / A ${odds.ah.away ?? "?"}`);
  if (parts.length === 0) return line("Odds", "Not yet available");
  return parts.map((p) => line("Odds", p)).join("\n");
}

/** Every raw SportyBet market this fixture carries (900+ on a liquid fixture) —
 *  collapsed by default so the at-a-glance report stays readable, but nothing
 *  is summarized or dropped: every market/outcome/odds triple is in there. */
function renderAllMarkets(event: SportyBetEvent): string {
  const markets = event.detail?.odds?.allMarkets;
  if (!markets?.length) return "";
  const rows = markets
    .map((m) => {
      const label = esc(m.desc || m.name || m.id);
      const outs = (m.outcomes ?? [])
        .map((o) => `${esc(o.desc ?? o.id)}: ${esc(o.odds ?? "?")}`)
        .join(" | ");
      return `<div class="raw-market-row">${label}${m.specifier ? ` <span class="raw-meta">(${esc(m.specifier)})</span>` : ""} — ${outs}</div>`;
    })
    .join("\n");
  return `<details class="raw-details"><summary>Full markets catalogue (${markets.length})</summary>${rows}</details>`;
}

/** Full raw scrape payload per news source — the report's "summary" line above
 *  this is an LLM-condensed digest; this dropdown carries the untouched
 *  rawJson + scrapedAt so nothing the scraper captured is left out of the report. */
function renderNewsRaw(label: string, rows: DailyNewsRow[]): string {
  if (!rows.length) return "";
  const blocks = rows
    .map(
      (r) =>
        `<div class="raw-news-raw"><span class="raw-label">${esc(r.source)}</span> _(scraped ${esc(r.scrapedAt)})_<pre>${esc(r.rawJson)}</pre></div>`
    )
    .join("\n");
  return `<details class="raw-details"><summary>${esc(label)} — raw scrape (${rows.length})</summary>${blocks}</details>`;
}

/** Renders the same enrichment block (xG provenance, travel, motivation,
 *  completeness, lineups, news, full markets) used by the standalone daily
 *  fixture report — exported so apps/web's /analyze report can append it per
 *  fixture (see report.ts renderCard's `enrichment` param) without duplicating
 *  any of the field-shaping logic. */
export function renderFixtureRawData(
  event: SportyBetEvent,
  lineup: LineupSummary | undefined,
  homeNews: DailyNewsRow[],
  awayNews: DailyNewsRow[]
): string {
  const stats = event.detail?.stats;
  const form = stats?.form;
  const standings = stats?.standings;
  const goals = stats?.goals;
  const h2h = stats?.h2h;
  const xg = stats?.xg;
  const overunder = stats?.overunder;
  const congestion = stats?.congestion;
  const pv = stats?.possessionValue;
  const recentCorners = stats?.recentCorners;
  const recentGoals = stats?.recentGoals;
  const scyc = stats?.scoringConceding;
  const disc = stats?.disciplinary;
  const ph = stats?.positionHistory;
  const tg = stats?.topGoals;
  // xG provenance tag — Understat (per-match, true xGA) vs FBref (season aggregate,
  // xGF only). Both home/away carry the same src in practice; read whichever exists.
  const xgSrc = xg?.home?.src ?? xg?.away?.src;
  const xgTag = xgSrc ? ` (${xgSrc})` : "";

  const travel = buildTravel(event.home, event.away, {
    neutralVenue: event.league === "FIFA World Cup",
  });
  const motivation = buildMotivation(event.detail);
  const completeness = dataCompleteness(event.detail);

  const sections = [
    renderOdds(event),
    side(
      "Form (last 5)",
      form?.home?.last5 ? `${form.home.last5} (streak ${form.home.streak ?? "?"})` : null,
      form?.away?.last5 ? `${form.away.last5} (streak ${form.away.streak ?? "?"})` : null
    ),
    side(
      "Standings",
      standings?.home
        ? `pos ${standings.home.pos ?? "?"}, pts ${standings.home.points ?? "?"}, GF/GA ${standings.home.gf ?? "?"}/${standings.home.ga ?? "?"}`
        : null,
      standings?.away
        ? `pos ${standings.away.pos ?? "?"}, pts ${standings.away.points ?? "?"}, GF/GA ${standings.away.gf ?? "?"}/${standings.away.ga ?? "?"}`
        : null
    ),
    side(
      "Season goals avg",
      goals?.home
        ? `scored ${goals.home.avg_scored ?? "?"}, conceded ${goals.home.avg_conceded ?? "?"}`
        : null,
      goals?.away
        ? `scored ${goals.away.avg_scored ?? "?"}, conceded ${goals.away.avg_conceded ?? "?"}`
        : null
    ),
    h2h
      ? line(
          "H2H",
          `last ${h2h.total ?? "?"} meetings — home wins ${h2h.home_wins ?? "?"}, away wins ${h2h.away_wins ?? "?"}, draws ${h2h.draws ?? "?"}`
        )
      : line("H2H", "No history available"),
    side(
      `xG${xgTag}`,
      xg?.home
        ? `xGF ${xg.home.xgf ?? "?"}, xGA ${xg.home.xga ?? "?"}`
        : "N/A — outside xG coverage",
      xg?.away
        ? `xGF ${xg.away.xgf ?? "?"}, xGA ${xg.away.xga ?? "?"}`
        : "N/A — outside xG coverage"
    ),
    side(
      "O/U hit-rate",
      overunder?.home
        ? `O1.5 ${pct(overunder.home.over15_pct ?? 0)}, O2.5 ${pct(overunder.home.over25_pct ?? 0)}, O3.5 ${pct(overunder.home.over35_pct ?? 0)}`
        : null,
      overunder?.away
        ? `O1.5 ${pct(overunder.away.over15_pct ?? 0)}, O2.5 ${pct(overunder.away.over25_pct ?? 0)}, O3.5 ${pct(overunder.away.over35_pct ?? 0)}`
        : null
    ),
    side(
      "Rest/congestion",
      congestion?.home
        ? `rest ${congestion.home.rest_days ?? "?"}d, next in ${congestion.home.next_days ?? "?"}d`
        : null,
      congestion?.away
        ? `rest ${congestion.away.rest_days ?? "?"}d, next in ${congestion.away.next_days ?? "?"}d`
        : null
    ),
    side(
      "Shots/corners/poss.",
      pv?.home
        ? `SoT ${pv.home.shots_on_target_avg ?? "?"}, corners ${pv.home.corners_avg ?? "?"}, poss ${pv.home.possession_pct_avg ?? "?"}%`
        : null,
      pv?.away
        ? `SoT ${pv.away.shots_on_target_avg ?? "?"}, corners ${pv.away.corners_avg ?? "?"}, poss ${pv.away.possession_pct_avg ?? "?"}%`
        : null
    ),
    recentCorners
      ? side(
          "Recent corners (last 5)",
          String(recentCorners.home ?? "?"),
          String(recentCorners.away ?? "?")
        )
      : "",
    recentGoals
      ? side(
          "Recent goals (last 5)",
          recentGoals.home
            ? `scored ${recentGoals.home.scored_avg ?? "?"}, conceded ${recentGoals.home.conceded_avg ?? "?"} (n${recentGoals.home.n ?? "?"})`
            : null,
          recentGoals.away
            ? `scored ${recentGoals.away.scored_avg ?? "?"}, conceded ${recentGoals.away.conceded_avg ?? "?"} (n${recentGoals.away.n ?? "?"})`
            : null
        )
      : "",
    scyc
      ? side(
          "Scoring/Conceding (venue)",
          scyc.home
            ? `GF ${scyc.home.scored_avg ?? "?"}, GA ${scyc.home.conceded_avg ?? "?"}, BTTS ${pct(scyc.home.btts_rate ?? 0)}, FTS ${pct(scyc.home.failed_to_score_rate ?? 0)}, CS ${pct(scyc.home.clean_sheet_rate ?? 0)}, 1H goals ${scyc.home.goals_1h_avg ?? "?"}`
            : null,
          scyc.away
            ? `GF ${scyc.away.scored_avg ?? "?"}, GA ${scyc.away.conceded_avg ?? "?"}, BTTS ${pct(scyc.away.btts_rate ?? 0)}, FTS ${pct(scyc.away.failed_to_score_rate ?? 0)}, CS ${pct(scyc.away.clean_sheet_rate ?? 0)}, 1H goals ${scyc.away.goals_1h_avg ?? "?"}`
            : null
        )
      : "",
    disc
      ? side(
          "Discipline",
          disc.home
            ? `${disc.home.yellow_avg ?? "?"} yel, ${disc.home.red_avg ?? "?"} red, ${disc.home.fouls_avg ?? "?"} fouls`
            : null,
          disc.away
            ? `${disc.away.yellow_avg ?? "?"} yel, ${disc.away.red_avg ?? "?"} red, ${disc.away.fouls_avg ?? "?"} fouls`
            : null
        )
      : "",
    ph
      ? side(
          "Position trend",
          ph.home
            ? `now ${ph.home.current ?? "?"} (best ${ph.home.best ?? "?"}, worst ${ph.home.worst ?? "?"}, trend ${ph.home.trend ?? "?"})`
            : null,
          ph.away
            ? `now ${ph.away.current ?? "?"} (best ${ph.away.best ?? "?"}, worst ${ph.away.worst ?? "?"}, trend ${ph.away.trend ?? "?"})`
            : null
        )
      : "",
    tg
      ? side(
          "Lead scorer",
          tg.home ? `${tg.home.top_scorer_name ?? "?"} (${tg.home.top_scorer_goals ?? "?"})` : null,
          tg.away ? `${tg.away.top_scorer_name ?? "?"} (${tg.away.top_scorer_goals ?? "?"})` : null
        )
      : "",
    travel.soft ? line("Travel", travel.soft.text) : "",
    motivation.soft ? line("Motivation", motivation.soft.text) : "",
    line("Data completeness", pct(completeness)),
    lineup
      ? [
          lineup.home_formation || lineup.home_starting_xi?.length
            ? line(
                "Home lineup",
                `${lineup.home_xi_confirmed ? "Confirmed" : "Expected"} — formation ${lineup.home_formation ?? "?"}${
                  lineup.home_starting_xi?.length
                    ? `, XI: ${lineup.home_starting_xi.join(", ")}`
                    : ""
                }`
              )
            : "",
          lineup.away_formation || lineup.away_starting_xi?.length
            ? line(
                "Away lineup",
                `${lineup.away_xi_confirmed ? "Confirmed" : "Expected"} — formation ${lineup.away_formation ?? "?"}${
                  lineup.away_starting_xi?.length
                    ? `, XI: ${lineup.away_starting_xi.join(", ")}`
                    : ""
                }`
              )
            : "",
        ].join("\n")
      : line("Lineups", "Not yet confirmed"),
    homeNews.length
      ? homeNews.map((n) => line(`Home news (${n.source})`, n.summary)).join("\n")
      : line("Home news", "No news intel"),
    awayNews.length
      ? awayNews.map((n) => line(`Away news (${n.source})`, n.summary)).join("\n")
      : line("Away news", "No news intel"),
    renderNewsRaw("Home news", homeNews),
    renderNewsRaw("Away news", awayNews),
    renderAllMarkets(event),
  ];

  return sections.filter((s) => s.length > 0).join("\n");
}

function renderFixtureBlock(
  event: SportyBetEvent,
  lineup: LineupSummary | undefined,
  homeNews: DailyNewsRow[],
  awayNews: DailyNewsRow[]
): string {
  return `
<div class="raw-fixture">
  <div class="raw-fixture-header">${esc(event.home)} vs ${esc(event.away)} <span class="raw-meta">${esc(event.league ?? "Unknown league")} · ${esc((event.kickoff_utc ?? "").slice(0, 16).replace("T", " "))}</span></div>
  ${renderFixtureRawData(event, lineup, homeNews, awayNews)}
</div>`;
}

const RAW_CSS = `
.raw-fixture { background: #1e293b; border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; border: 1px solid #334155; }
.raw-fixture-header { font-size: 0.95rem; font-weight: 700; color: #f1f5f9; margin-bottom: 8px; }
.raw-meta { font-size: 0.72rem; color: #64748b; font-weight: 400; margin-left: 8px; }
.raw-line { font-size: 0.78rem; color: #cbd5e1; margin-bottom: 3px; }
.raw-label { color: #64748b; font-weight: 600; margin-right: 4px; }
.raw-details { margin: 6px 0 3px; font-size: 0.76rem; color: #94a3b8; }
.raw-details summary { cursor: pointer; color: #7dd3fc; font-weight: 600; }
.raw-market-row { padding: 2px 0 2px 14px; border-bottom: 1px solid #1e293b; }
.raw-news-raw pre { white-space: pre-wrap; word-break: break-word; background: #0f172a; padding: 6px; border-radius: 4px; margin: 4px 0 8px; }
`;

export interface DailyFixtureReportDeps {
  lineups: LineupSummary[];
  /** Full news rows (source/summary/rawJson/scrapedAt) per team, keyed by
   *  teamSlug. Caller is responsible for sourcing rows from
   *  loadDailyNews(date, teamSlug(team)) per side — see buildNewsByTeam(). */
  newsByTeam: Map<string, DailyNewsRow[]>;
}

/** Builds a plain "every fixture today + its data" HTML report — no picks,
 *  no grades, no engine opinion. Independent of engine selection entirely. */
export function renderDailyFixtureReport(
  events: SportyBetEvent[],
  date: string,
  deps: DailyFixtureReportDeps
): string {
  const blocks = events
    .map((event) => {
      const lineup = findLineupSummary(deps.lineups, event.home, event.away);
      const homeNews = deps.newsByTeam.get(teamSlug(event.home)) ?? [];
      const awayNews = deps.newsByTeam.get(teamSlug(event.away)) ?? [];
      return renderFixtureBlock(event, lineup, homeNews, awayNews);
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ORACLE Daily Fixtures — ${esc(date)}</title>
<style>${CSS}${RAW_CSS}</style>
</head>
<body>
<h1>ORACLE Daily Fixtures — ${esc(date)}</h1>
<div class="summary">
  <div class="stat"><span class="stat-label">Date</span><span class="stat-val">${esc(date)}</span></div>
  <div class="stat"><span class="stat-label">Fixtures</span><span class="stat-val">${events.length}</span></div>
</div>
<div class="cards">
${blocks}
</div>
</body>
</html>`;
}

/** Fetches news rows for every team across the day's fixtures, keyed by
 *  teamSlug, in one pass — avoids one loadDailyNews() call per fixture side.
 *  Keeps the full row (including rawJson/scrapedAt) so the report's raw-scrape
 *  dropdown has everything the scraper captured, not just the digest summary. */
export async function buildNewsByTeam(
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

/** Writes to .tmp/reports/oracle-fixtures-{date}.html — same atomic-write +
 *  collision-suffix pattern as report.ts's writeReport, on a distinct filename
 *  prefix so the two report flavors never collide. */
export async function writeDailyFixtureReport(
  html: string,
  date: string,
  outDir = ".tmp/reports"
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const primary = join(outDir, `oracle-fixtures-${date}.html`);
  let outPath = primary;
  try {
    await access(primary);
    outPath = join(outDir, `oracle-fixtures-${date}-${Date.now()}.html`);
  } catch {
    // Primary does not exist — claim it
  }
  await writeFile(outPath, html, "utf8");
  return outPath;
}

/** One-call generate-and-write for a given date — shared by the worker's cron/
 *  back-online triggers AND the bot's on-demand /fixtures command, so both
 *  paths produce an identical report from identical logic. Returns null when
 *  SportyBet listed no fixtures for that date (nothing to report); never throws. */
export async function generateAndWriteDailyFixtureReport(
  date: string,
  outDir: string
): Promise<{ path: string; fixtureCount: number } | null> {
  const index = await loadSportyBetIndex(date);
  if (!index?.events.length) return null;
  const [lineups, newsByTeam] = await Promise.all([
    loadLineupSummaries(),
    buildNewsByTeam(index.events, date),
  ]);
  const html = renderDailyFixtureReport(index.events, date, { lineups, newsByTeam });
  const path = await writeDailyFixtureReport(html, date, outDir);
  return { path, fixtureCount: index.events.length };
}

export interface FixtureEnrichmentContext {
  events: SportyBetEvent[];
  lineups: LineupSummary[];
  newsByTeam: Map<string, DailyNewsRow[]>;
}

/** Loads everything findFixtureEnrichmentHtml needs for a date ONCE — the
 *  SportyBet index, lineups, and news. Callers enriching many fixtures from
 *  the same date (e.g. analyze.ts's per-batch enrichment) must load this once
 *  and reuse it; loadSportyBetIndex() itself hits disk/DuckDB on every call
 *  with no caching, so calling it per-fixture in a batch would reload the
 *  same day's index N times. Returns null when SportyBet listed no fixtures
 *  for that date (nothing to enrich with). */
export async function loadFixtureEnrichmentContext(
  date: string
): Promise<FixtureEnrichmentContext | null> {
  const index = await loadSportyBetIndex(date);
  if (!index?.events.length) return null;
  const [lineups, newsByTeam] = await Promise.all([
    loadLineupSummaries(),
    buildNewsByTeam(index.events, date),
  ]);
  return { events: index.events, lineups, newsByTeam };
}

/** Looks up one fixture's enrichment HTML (xG provenance, travel, motivation,
 *  completeness, lineups, news, full markets) by team name within an
 *  already-loaded FixtureEnrichmentContext — used by apps/web's /analyze
 *  report to give each engine pick card the same enrichment fields the
 *  Telegram daily report shows. Returns "" when the fixture isn't in the
 *  context's events (no data to show) rather than throwing — never blocks
 *  rendering the pick card itself. */
export function findFixtureEnrichmentHtml(
  home: string,
  away: string,
  ctx: FixtureEnrichmentContext
): string {
  const event = ctx.events.find((e) => namesMatch(home, e.home) && namesMatch(away, e.away));
  if (!event) return "";
  const lineup = findLineupSummary(ctx.lineups, event.home, event.away);
  const homeNews = ctx.newsByTeam.get(teamSlug(event.home)) ?? [];
  const awayNews = ctx.newsByTeam.get(teamSlug(event.away)) ?? [];
  return renderFixtureRawData(event, lineup, homeNews, awayNews);
}
