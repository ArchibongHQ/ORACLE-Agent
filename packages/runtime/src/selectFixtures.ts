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
// Tier B: senior top-flights and data-rich competitions not already in GOALS_RICH_LEAGUES (Tier A).
export const ORACLE_PRIORITY_LEAGUES: ReadonlySet<string> = new Set([
  // ── Europe (top flights) ──────────────────────────────────────────────────
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
  "Urvalsdeild",
  "Eliteserien",
  "Swiss Super League",
  "Danish Superliga",
  // ── Europe (lower divisions) ──────────────────────────────────────────────
  "2. Bundesliga",
  "Eerste Divisie",
  "OBOS-ligaen",
  "Swedish Division 1",
  "Swedish Division 2",
  "Danish 1. Division",
  "Regionalliga Bayern",
  "Regionalliga Nord",
  "Regionalliga Nordost",
  "Regionalliga Südwest",
  "Regionalliga West",
  // ── Asia / Oceania / Middle East ──────────────────────────────────────────
  "NPL Queensland",
  "NPL New South Wales",
  "NPL Victoria",
  "Singapore Premier League",
  "Malaysia Super League",
  "Qatar Stars League",
  // ── The Americas ─────────────────────────────────────────────────────────
  "MLS",
  "USL League Two",
  "Bolivia Primera Division",
  "Liga MX",
  "Brazilian Serie A",
  "Brazilian Serie B",
  "Argentine Primera Division",
  // ── Cups (early rounds / mismatches) ─────────────────────────────────────
  "Faroe Islands Cup",
  "Lithuanian Cup",
  "Estonian Cup",
  // ── Continental / global ──────────────────────────────────────────────────
  "Champions League",
  "Europa League",
  "Conference League",
  "J League",
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
  /** Typed accessors for named half-related exotics (market IDs verified live
   *  2026-06-23 — see tools/scrape_fixtures.py _parse_half_markets docstring). */
  half?: {
    win_either_half?: {
      home?: { yes?: number | null; no?: number | null } | null;
      away?: { yes?: number | null; no?: number | null } | null;
    } | null;
    /** Both Halves Over/Under X.5 — keyed by line (e.g. "1.5"), value is {yes/no}
     *  reframed as {over, under} (yes=over, no=under). */
    both_halves_ou?: Record<string, { over?: number | null; under?: number | null }> | null;
    /** 1st-half match-total Over/Under, keyed by line. */
    ht_ou?: Record<string, { over?: number | null; under?: number | null }> | null;
    /** 2nd-half match-total Over/Under, keyed by line. */
    h2_ou?: Record<string, { over?: number | null; under?: number | null }> | null;
    /** 1st-half team-total Over/Under, keyed by side then line. */
    ht_team_ou?: Record<
      string,
      Record<string, { over?: number | null; under?: number | null }>
    > | null;
    /** 2nd-half team-total Over/Under, keyed by side then line. */
    h2_team_ou?: Record<
      string,
      Record<string, { over?: number | null; under?: number | null }>
    > | null;
  } | null;
  /** Typed accessors for the joint 1X2+BTTS / 1X2+O-U / O-U+BTTS combo markets
   *  (market IDs verified live 2026-06-29 — see tools/scrape_fixtures.py
   *  _parse_combo_markets docstring). */
  combo?: {
    "1x2_btts"?: {
      home_yes?: string | null;
      home_no?: string | null;
      draw_yes?: string | null;
      draw_no?: string | null;
      away_yes?: string | null;
      away_no?: string | null;
    } | null;
    /** 1X2 & Over/Under, keyed by line (e.g. "2.5"). */
    "1x2_ou"?: Record<
      string,
      {
        home_under?: string | null;
        home_over?: string | null;
        draw_under?: string | null;
        draw_over?: string | null;
        away_under?: string | null;
        away_over?: string | null;
      }
    > | null;
    /** Over/Under & BTTS, keyed by line (e.g. "2.5"). */
    ou_btts?: Record<
      string,
      {
        over_yes?: string | null;
        over_no?: string | null;
        under_yes?: string | null;
        under_no?: string | null;
      }
    > | null;
  } | null;
  /** Generic capture of EVERY SportyBet market for this fixture (900+ entries
   *  on a typical live fixture) — see tools/scrape_fixtures.py _parse_all_markets.
   *  Use this for any market not covered by the typed fields above; outcome
   *  `desc` is already a human-readable label straight from the API. */
  allMarkets?: Array<{
    id: string;
    name?: string | null;
    desc?: string | null;
    group?: string | null;
    specifier?: string | null;
    outcomes: Array<{ id: string; desc?: string | null; odds?: string | null }>;
  }> | null;
}

/** One team's xG prior — season aggregate plus the optional venue-conditioned
 *  split (goals-market-analysis-prompt-v3 gap-closure). */
export interface SportyBetXgEntry {
  xgf?: number;
  xga?: number | null;
  src?: string;
  /** "estimated" when xga is a league-mean fill (build_xg_table.py, all-markets
   *  v3 §0.3) rather than a real team-conceded figure — consumers downgrade
   *  confidence on the tag. Absent for real xGA. */
  xgaSrc?: "estimated";
  /** Venue-conditioned xG-for/against (this team's home matches when it's the
   *  home side here, its away matches when it's the away side) — absent until
   *  build_xg_table.py has ≥1 venue-tagged match for the team. venueN is the
   *  match count behind the split so consumers can gate on sample size. */
  venueXgf?: number | null;
  venueXga?: number | null;
  venueN?: number;
  /** Non-penalty xG-for (per-match rate) — FBref-only (PR-25 item 4), absent
   *  for Understat/FotMob/Sofascore/AI-mode records. Distinct signal from
   *  xgf, not a replacement: strips penalty conversions to isolate open-play
   *  scoring threat (a team can carry a high xgf on penalty volume alone). */
  npxgf?: number | null;
  /** Expected-assisted-goals-for (per-match rate) — FBref-only, same coverage
   *  caveat as npxgf. A team-creativity signal (chance quality created via
   *  the final pass), independent of finishing quality. */
  xagf?: number | null;
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
  h2h?: {
    total?: number;
    home_wins?: number;
    away_wins?: number;
    draws?: number;
    /** Most-recent meetings with scoreline + date (stats_team_versusrecent matches[],
     *  ≤10). The per-match detail behind the aggregate counters — feeds the
     *  spreadsheet H2H column and the arbiter's raw-stats block (e.g. "2-0; 2-2; 3-1").
     *  home_team/away_team are that historical match's sides, not the current fixture's. */
    matches?: Array<{
      date?: string | null;
      uts?: number | null;
      home_team?: string | null;
      away_team?: string | null;
      home_goals?: number;
      away_goals?: number;
      winner?: string | null;
    }> | null;
  } | null;
  /** Rolling xG prior. Understat (top-5, per-match, true xGA) preferred; FBref
   *  season-aggregate (World Cup, Brazil, wider leagues — xGF only, xga null)
   *  merged in as a medium-confidence fallback. `src` records the origin.
   *  `venueXgf`/`venueXga` (goals-market-analysis-prompt-v3 gap-closure,
   *  tools/build_xg_table.py) are the SAME team's xG conditioned on playing at
   *  this fixture's venue only (home team's home matches / away team's away
   *  matches) — a strictly better prior than the season aggregate above when
   *  present, absent for teams below Understat's per-match venue coverage. */
  xg?: {
    home?: SportyBetXgEntry | null;
    away?: SportyBetXgEntry | null;
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
  /** Season-aggregate shot volume/corners/possession per team (stats_season_uniqueteamstats).
   *  Possession-value proxy for the feature store — no raw xG field exists anywhere in
   *  SportyBet/Sportradar's gismo API (confirmed live-probed 2026-06-23); shots_on_target_avg
   *  + shots_off_target_avg is the closest available shot-volume proxy for xG. */
  possessionValue?: {
    home?: {
      shots_on_target_avg?: number;
      shots_off_target_avg?: number;
      shots_blocked_avg?: number;
      corners_avg?: number;
      possession_pct_avg?: number;
    } | null;
    away?: {
      shots_on_target_avg?: number;
      shots_off_target_avg?: number;
      shots_blocked_avg?: number;
      corners_avg?: number;
      possession_pct_avg?: number;
    } | null;
  } | null;
  /** Recency-weighted complement to possessionValue.corners_avg: average corners
   *  won across each team's last 5 matches (stats_team_lastxextended). */
  recentCorners?: { home?: number; away?: number } | null;
  /** Opponents' corners in the same last-5 matches (corners against) — the other
   *  half of the v3 §3.9 Negative-Binomial corners model; uniqueteamstats only
   *  carries corners-for. Same lastxextended docs, no extra fetch. */
  recentCornersAgainst?: { home?: number; away?: number } | null;
  /** Recency-weighted complement to goals.avg_scored/avg_conceded: average goals
   *  scored/conceded across each team's last 5 matches (stats_team_lastxextended,
   *  same docs as recentCorners — no extra fetch). The strongest recency signal
   *  for the goals model; feeds the DC time-decay xH/xA adjustment. */
  recentGoals?: {
    home?: { scored_avg?: number; conceded_avg?: number; n?: number } | null;
    away?: { scored_avg?: number; conceded_avg?: number; n?: number } | null;
  } | null;
  /** Season "Scoring & Conceding" profile (stats_season_teamscoringconceding) —
   *  venue-split goal rates, BTTS/failed-to-score rates, half-time scoring. The
   *  richest pre-match goals subtab SportyBet exposes; home team carries its home
   *  split, away team its away split. */
  scoringConceding?: {
    home?: ScoringConcedingProfile | null;
    away?: ScoringConcedingProfile | null;
  } | null;
  /** Disciplinary profile (stats_season_teamdisciplinary) — cards/fouls per team.
   *  Marginal goals signal: card-heavy referees → stoppages; many fouls →
   *  set-pieces. Advisory (LLM soft-context + report), no engine coefficient. */
  disciplinary?: {
    home?: { yellow_avg?: number; red_avg?: number; fouls_avg?: number } | null;
    away?: { yellow_avg?: number; red_avg?: number; fouls_avg?: number } | null;
  } | null;
  /** League-position trend (stats_season_teampositionhistory) — momentum signal.
   *  trend>0 = climbing (lower position number = better). Advisory. */
  positionHistory?: {
    home?: { current?: number; best?: number; worst?: number; trend?: number; n?: number } | null;
    away?: { current?: number; best?: number; worst?: number; trend?: number; n?: number } | null;
  } | null;
  /** Lead-scorer concentration (stats_season_topgoals) — key-player-absence
   *  fragility signal when paired with news intel. Advisory. */
  topGoals?: {
    home?: { top_scorer_goals?: number; top_scorer_name?: string } | null;
    away?: { top_scorer_goals?: number; top_scorer_name?: string } | null;
  } | null;
  /** Match-day squad availability (tools/fetch_squad_availability.py, Kaggle
   *  Transfermarkt backfill) — the team's MOST RECENT known matchday
   *  availability_idx (matchday squad value / rolling peak squad value, 1.0 =
   *  full strength) as a recency proxy for today's expected squad depth; not
   *  literally today's lineup (unknowable pre-kickoff from a historical
   *  dataset). Top-5 domestic leagues only, absent elsewhere. */
  availability?: {
    home?: SportyBetAvailabilityEntry | null;
    away?: SportyBetAvailabilityEntry | null;
  } | null;
  /** [PR-18] Match-day weather forecast at the HOME team's city
   *  (tools/scrape_fixtures.py's _load_weather_table, Open-Meteo Forecast
   *  API via fetch_weather.py's fetch_forecast — NOT the archive/backfill
   *  endpoint, which has no same-day coverage). One block per fixture, not
   *  split by side (weather is a venue property, not a team property).
   *  camelCase + km/h/mm, matching fetch_weather.py's existing backfill
   *  convention (build_features()/gbm_residual.py's tempC/precipMm/windKph)
   *  — NOT @oracle/engine's Weather interface shape (wind_mph/rain_mm),
   *  which is a different unit system; convert at the fixtures.ts boundary
   *  where this gets read into RunState.pipeline.fetched.weather, not here.
   *  Absent for any team outside fetch_weather.py's curated TEAM_CITY map,
   *  or when ORACLE_FETCH_WEATHER=off. */
  weather?: SportyBetWeatherEntry | null;
}

export interface SportyBetAvailabilityEntry {
  /** matchday_squad_value / rolling_peak_squad_value, clamped to [0,1]. */
  idx: number;
  /** 1 = the club's single most-valued rostered player started/was named;
   *  0 = absent; undefined when unknown. */
  keyPlayerPresent?: 0 | 1;
}

/** [PR-18] One fixture's match-day weather forecast — see SportyBetStats.weather. */
export interface SportyBetWeatherEntry {
  tempC?: number;
  precipMm?: number;
  windKph?: number;
  isAdverse?: boolean;
}

export interface ScoringConcedingProfile {
  matches?: number;
  scored_avg?: number;
  conceded_avg?: number;
  btts_rate?: number;
  failed_to_score_rate?: number;
  scoring_1h_rate?: number;
  goals_1h_avg?: number;
  clean_sheet_rate?: number;
}

export interface SportyBetEventDetail {
  eventId: string;
  odds: SportyBetOdds | null;
  stats: SportyBetStats | null;
  statscoverage: Record<string, unknown> | null;
}

export interface SportyBetEvent {
  home: string;
  away: string;
  marketCount: number;
  league?: string;
  /** Sportradar tournament ID (e.g. "sr:tournament:17"), when the source
   *  captured one — disambiguates leagues that share a generic name across
   *  competitions. Absent for older lake partitions and non-SportyBet sources
   *  (e.g. the ESPN scraper). See goalsV3/lambda.ts's V3_LEAGUE_BASELINES_BY_ID. */
  leagueId?: string;
  kickoff_utc?: string;
  detail?: SportyBetEventDetail;
  /** Sportradar/SportyBet event ID (e.g. "sr:match:66456926") — present when the
   *  sidecar scrape includes it. Used by the booking agent for direct URL navigation. */
  eventId?: string;
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

/** Resolve a SportyBet/Sportradar eventId for an already-analysed fixture by
 *  team name (PR-8a) — needed because AnalysisRecord.fixtureId is a
 *  home::away::kickoff slug (makeFixtureId), not the Sportradar match ID the
 *  odds-only closing-snapshot endpoint requires. Tries the canonical
 *  sidecarKey match first, falls back to the alias-aware namesMatch scan for
 *  edge cases sidecarKey's normalisation doesn't cover — same two-tier
 *  strategy as findSidecarDetail above. */
export function findSportyBetEventId(
  index: Pick<SportyBetIndex, "events">,
  home: string,
  away: string
): string | undefined {
  const key = sidecarKey(home, away);
  const exact = index.events.find((e) => sidecarKey(e.home, e.away) === key);
  if (exact?.eventId) return exact.eventId;
  const fuzzy = index.events.find((e) => namesMatch(e.home, home) && namesMatch(e.away, away));
  return fuzzy?.eventId;
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

/** The Parquet lake's odds table is flat (market/side/price rows) and has no
 *  column for the raw allMarkets catalogue (hundreds of arbitrary market/
 *  outcome entries per fixture — see SportyBetOdds.allMarkets), so a
 *  lake-sourced SportyBetIndex always has allMarkets empty even right after a
 *  fresh deep-enrichment scrape. Overlay allMarkets from the JSON sidecar
 *  (which the scraper writes in full) onto the lake's detail objects so
 *  report generation and the all-markets LLM executor still see the full
 *  catalogue once it lands, without giving up the lake's faster typed-odds
 *  path for everything else. Best-effort: any failure leaves the lake index
 *  untouched (sidecar missing/corrupt just means no overlay, not an error). */
async function overlayAllMarketsFromSidecar(
  index: SportyBetIndex,
  today: string,
  path: string
): Promise<SportyBetIndex> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      date?: string;
      events?: Array<{ home?: string; away?: string; odds?: { allMarkets?: unknown } }>;
    };
    if (raw?.date !== today || !Array.isArray(raw.events)) return index;
    const allMarketsByKey = new Map<string, SportyBetOdds["allMarkets"]>();
    for (const ev of raw.events) {
      const am = ev?.odds?.allMarkets;
      if (
        typeof ev?.home === "string" &&
        typeof ev?.away === "string" &&
        Array.isArray(am) &&
        am.length
      ) {
        allMarketsByKey.set(sidecarKey(ev.home, ev.away), am as SportyBetOdds["allMarkets"]);
      }
    }
    if (!allMarketsByKey.size) return index;
    for (const e of index.events) {
      if (!e.detail) continue;
      if (Array.isArray(e.detail.odds?.allMarkets) && e.detail.odds.allMarkets.length) continue;
      const am = allMarketsByKey.get(sidecarKey(e.home, e.away));
      if (!am) continue;
      e.detail = {
        ...e.detail,
        odds: { ...(e.detail.odds ?? {}), allMarkets: am } as SportyBetOdds,
      };
      index.detailByKey.set(sidecarKey(e.home, e.away), e.detail);
    }
    return index;
  } catch {
    return index;
  }
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
    if (fromLake) return await overlayAllMarketsFromSidecar(fromLake, today, path);
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
                home?: SportyBetXgEntry | null;
                away?: SportyBetXgEntry | null;
              }
            | null
            | undefined;
          const availabilityBlock = ev.availability as
            | {
                home?: SportyBetAvailabilityEntry | null;
                away?: SportyBetAvailabilityEntry | null;
              }
            | null
            | undefined;
          const weatherBlock = ev.weather as SportyBetWeatherEntry | null | undefined;
          const stats: SportyBetStats | null =
            baseStats != null ||
            xgBlock != null ||
            availabilityBlock != null ||
            weatherBlock != null
              ? {
                  ...(baseStats ?? {}),
                  ...(xgBlock != null ? { xg: xgBlock } : {}),
                  ...(availabilityBlock != null ? { availability: availabilityBlock } : {}),
                  ...(weatherBlock != null ? { weather: weatherBlock } : {}),
                }
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
      const leagueId = typeof ev.leagueId === "string" && ev.leagueId ? ev.leagueId : undefined;
      const kickoff_utc = typeof ev.kickoff_utc === "string" ? ev.kickoff_utc : undefined;
      const eventId = typeof ev.eventId === "string" && ev.eventId ? ev.eventId : undefined;
      events.push({
        home: ev.home,
        away: ev.away,
        marketCount: mc,
        league,
        leagueId,
        kickoff_utc,
        detail,
        eventId,
      });
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

// ── Data completeness ─────────────────────────────────────────────────────────

/** Returns 0–5: count of key signal fields present on the sidecar detail.
 *  Used as a secondary sort key within each priority tier so data-rich fixtures
 *  are analyzed before data-sparse ones of the same tier. */
function dataCompletenessScore(c: SelectionCandidate): number {
  const d = c.sportyBetDetail;
  if (!d) return 0;
  let n = 0;
  if (d.stats?.form?.home && d.stats.form.away) n++;
  if (d.stats?.goals?.home && d.stats.goals.away) n++;
  if (d.odds?.["1x2"]?.home != null) n++;
  if (d.stats?.xg?.home && d.stats.xg.away) n++;
  if (d.stats?.standings?.home && d.stats.standings.away) n++;
  return n;
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
  // Exclude SRL (simulated reality league) and other virtual/eSports fixtures.
  // They carry no real match data — the engine produces artificially inflated EV
  // on them and they consume LLM quota without delivering actionable intelligence.
  const SRL_PATTERN = /\bSRL\b|simulated\s*reality|virtual\s*(football|soccer|sport)/i;
  gated = gated.filter((c) => !SRL_PATTERN.test(c.job.league));

  const droppedBulkOdds = failOpen
    ? 0
    : todayOnly.filter((c) => c.hasBulkOdds).length - gated.filter((c) => c.hasBulkOdds).length;

  // Score all gated fixtures; top-cap are returned for analysis (cap controls total).
  // Sort order:
  //   1. Hard tier — ORACLE_PRIORITY_LEAGUES first (tier 0) so chunk loops always
  //      analyze top-flight fixtures before lower-priority ones regardless of score.
  //   2. Data completeness within tier — more signal fields → analyzed sooner.
  //   3. Composite predictability score (desc) as tiebreaker within tier+completeness.
  const scoredAll = gated
    .map((c) => ({ c, score: scoreFixture(c, marketCounts.get(c) ?? 0, now) }))
    .sort((a, b) => {
      const tierDiff =
        (ORACLE_PRIORITY_LEAGUES.has(a.c.job.league) ? 0 : 1) -
        (ORACLE_PRIORITY_LEAGUES.has(b.c.job.league) ? 0 : 1);
      if (tierDiff !== 0) return tierDiff;
      const dcDiff = dataCompletenessScore(b.c) - dataCompletenessScore(a.c);
      if (dcDiff !== 0) return dcDiff;
      return (
        b.score - a.score ||
        a.c.job.kickoff.localeCompare(b.c.job.kickoff) ||
        a.c.job.home.localeCompare(b.c.job.home)
      );
    });

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
  // Cap TOTAL returned fixtures to llmCap (not just LLM routing). With the full
  // all-markets LLM executor active and Gate 2 removed, every returned fixture
  // spawns a local Claude call — returning hundreds of fixtures would blow the
  // per-run quota and time budget. The top-llmCap by composite score are the
  // highest-quality fixtures; all are marked llmEligible.
  const selected: SelectionCandidate[] = scored.slice(0, llmCap).map((s) => ({
    ...s.c,
    llmEligible: true,
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
