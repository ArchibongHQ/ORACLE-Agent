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
import { loadDailyNews, teamSlug } from "./dailyStore.js";
import { findLineupSummary, type LineupSummary } from "./lineups.js";
import { CSS, esc, pct } from "./report.js";
import type { SportyBetEvent } from "./selectFixtures.js";

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

function renderFixtureRawData(
  event: SportyBetEvent,
  lineup: LineupSummary | undefined,
  homeNews: { source: string; summary: string }[],
  awayNews: { source: string; summary: string }[]
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
      "xG",
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
  ];

  return sections.filter((s) => s.length > 0).join("\n");
}

function renderFixtureBlock(
  event: SportyBetEvent,
  lineup: LineupSummary | undefined,
  homeNews: { source: string; summary: string }[],
  awayNews: { source: string; summary: string }[]
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
`;

export interface DailyFixtureReportDeps {
  lineups: LineupSummary[];
  /** Resolves a team's news rows (source/summary only — raw_json/scrapedAt
   *  omitted from this plain-text report). Caller is responsible for sourcing
   *  rows from loadDailyNews(date, teamSlug(team)) per side. */
  newsByTeam: Map<string, { source: string; summary: string }[]>;
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
 *  teamSlug, in one pass — avoids one loadDailyNews() call per fixture side. */
export async function buildNewsByTeam(
  events: SportyBetEvent[],
  date: string
): Promise<Map<string, { source: string; summary: string }[]>> {
  const slugs = new Set<string>();
  for (const e of events) {
    slugs.add(teamSlug(e.home));
    slugs.add(teamSlug(e.away));
  }
  const byTeam = new Map<string, { source: string; summary: string }[]>();
  for (const slug of slugs) {
    const rows = await loadDailyNews(date, slug);
    if (rows?.length)
      byTeam.set(
        slug,
        rows.map((r) => ({ source: r.source, summary: r.summary }))
      );
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
