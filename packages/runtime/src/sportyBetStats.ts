/** SportyBet sidecar stats → engine telemetry override + LLM soft context.
 *
 *  Runtime-side wiring for stats the sidecar already scrapes (form, standings,
 *  goals, xG, H2H, over/under, congestion) but the engine and LLM never
 *  consumed (audited 2026-06-20 — see oracle_pending_plans memory). Two outputs:
 *
 *    1. buildStatsOverride — a data-quality-gated HARD override of the engine's
 *       xH/xA (Alpha-model xG input) plus the strength-of-schedule and
 *       fatigue-decay inputs the engine already has slots for but the runtime
 *       never populated (oppGA_H/A, restH/A). No engine code changes — these
 *       are existing RunState.telemetry fields execution/index.ts already reads.
 *    2. buildStatsSoftContext — renders the full stats block as advisory
 *       SoftContextItem[] for the LLM decision prompt (kind: "stats").
 *
 *  Pure functions — no I/O. Called from fixtures.ts at injection time, where
 *  the sidecar detail is already in memory (no extra fetch). */

import { applyTemporalDecay, type RecentMatch, type SoftContextItem } from "@oracle/engine";
import type { SportyBetEventDetail } from "./selectFixtures.js";

/** Season matches required before a goals/xG average is trusted enough to
 *  override the engine's xH/xA outright — below this, season averages are
 *  1-3 match noise that would corrupt the Poisson model worse than the
 *  existing league-average/LLM-estimate fallback. */
const MIN_PLAYED_FOR_OVERRIDE = 4;

/** Sample threshold for full lambda trust. Between MIN_PLAYED_FOR_OVERRIDE and
 *  this, the raw lambda is shrunk toward the league prior using a linear
 *  credibility weight: w = n / SHRINK_THRESHOLD (e.g. 0.625 at n=5). */
const SHRINK_THRESHOLD = 8;

/** League-specific prior expected goals (home / away) used for credibility
 *  shrinkage when a team has played fewer than SHRINK_THRESHOLD matches.
 *  Sources: FBref 2022-2026 seasonal averages cross-checked ≥2 sources.
 *  Tier A leagues (GOALS_RICH_LEAGUES) carry higher averages — their priors
 *  must be set individually so shrinkage lands near their true mean, not the
 *  generic 1.5/1.2 Default which would under-shrink high-scoring leagues. */
const GOALS_SHRINK_PRIORS: Record<string, { homeAvg: number; awayAvg: number }> = {
  // ── Europe top flights ──────────────────────────────────────────────────
  "Premier League": { homeAvg: 1.55, awayAvg: 1.18 },
  "La Liga": { homeAvg: 1.52, awayAvg: 1.14 },
  Bundesliga: { homeAvg: 1.82, awayAvg: 1.37 },
  "Serie A": { homeAvg: 1.55, awayAvg: 1.18 },
  "Ligue 1": { homeAvg: 1.53, awayAvg: 1.2 },
  Eredivisie: { homeAvg: 1.8, awayAvg: 1.32 },
  Eliteserien: { homeAvg: 1.72, awayAvg: 1.37 },
  "Swiss Super League": { homeAvg: 1.68, awayAvg: 1.34 },
  "Danish Superliga": { homeAvg: 1.58, awayAvg: 1.34 },
  MLS: { homeAvg: 1.6, awayAvg: 1.28 },
  "Primeira Liga": { homeAvg: 1.5, awayAvg: 1.1 },
  "Süper Lig": { homeAvg: 1.55, awayAvg: 1.18 },
  // ── Europe lower divisions (Tier A) ────────────────────────────────────
  "2. Bundesliga": { homeAvg: 1.72, awayAvg: 1.33 },
  "Eerste Divisie": { homeAvg: 1.85, awayAvg: 1.3 },
  "OBOS-ligaen": { homeAvg: 1.65, awayAvg: 1.35 },
  "Swedish Division 1": { homeAvg: 1.65, awayAvg: 1.35 },
  "Swedish Division 2": { homeAvg: 1.7, awayAvg: 1.3 },
  "Danish 1. Division": { homeAvg: 1.6, awayAvg: 1.35 },
  "Regionalliga Bayern": { homeAvg: 1.8, awayAvg: 1.4 },
  "Regionalliga Nord": { homeAvg: 1.75, awayAvg: 1.4 },
  "Regionalliga Nordost": { homeAvg: 1.75, awayAvg: 1.4 },
  "Regionalliga Südwest": { homeAvg: 1.75, awayAvg: 1.4 },
  "Regionalliga West": { homeAvg: 1.78, awayAvg: 1.42 },
  // ── Nordic / Baltic / Caucasus (Tier A) ────────────────────────────────
  Veikkausliiga: { homeAvg: 1.65, awayAvg: 1.25 },
  "Erovnuli Liga": { homeAvg: 1.75, awayAvg: 1.25 },
  "Kyrgyz Premier League": { homeAvg: 1.85, awayAvg: 1.35 },
  // ── Asia / Oceania (Tier A) ────────────────────────────────────────────
  "NPL Queensland": { homeAvg: 1.8, awayAvg: 1.4 },
  "NPL New South Wales": { homeAvg: 1.75, awayAvg: 1.4 },
  "NPL Victoria": { homeAvg: 1.75, awayAvg: 1.35 },
  "Singapore Premier League": { homeAvg: 1.6, awayAvg: 1.3 },
  "Malaysia Super League": { homeAvg: 1.55, awayAvg: 1.25 },
  "Qatar Stars League": { homeAvg: 1.55, awayAvg: 1.3 },
  // ── Africa (Tier A) ────────────────────────────────────────────────────
  "Tanzania Premier League": { homeAvg: 1.55, awayAvg: 1.1 },
  "Syrian Premier League": { homeAvg: 1.6, awayAvg: 1.15 },
  // ── Americas (Tier A) ──────────────────────────────────────────────────
  "Bolivia Primera Division": { homeAvg: 1.8, awayAvg: 1.5 },
  "USL League Two": { homeAvg: 1.7, awayAvg: 1.4 },
  "Copa Chile": { homeAvg: 1.9, awayAvg: 1.6 },
  "Copa Venezuela": { homeAvg: 1.85, awayAvg: 1.65 },
  // ── Domestic cups / early rounds (Tier A) ─────────────────────────────
  "Faroe Islands Cup": { homeAvg: 2.1, awayAvg: 1.5 },
  "Lithuanian Cup": { homeAvg: 2.0, awayAvg: 1.4 },
  "Estonian Cup": { homeAvg: 2.0, awayAvg: 1.4 },
  // ── South American top flights (strong home edge, lower scoring) ────────
  "Brazilian Serie A": { homeAvg: 1.5, awayAvg: 1.0 },
  "Brazilian Serie B": { homeAvg: 1.45, awayAvg: 0.95 },
  "Argentine Primera Division": { homeAvg: 1.4, awayAvg: 0.9 },
  // ── International tournaments (neutral venue → home≈away, lower scoring) ──
  "FIFA World Cup": { homeAvg: 1.3, awayAvg: 1.3 },
  // ── Other existing goals-rich leagues ─────────────────────────────────
  "Chinese Super League": { homeAvg: 1.6, awayAvg: 1.2 },
  "Scottish Premiership": { homeAvg: 1.62, awayAvg: 1.3 },
  "Austrian Bundesliga": { homeAvg: 1.7, awayAvg: 1.35 },
  Default: { homeAvg: 1.5, awayAvg: 1.2 },
};

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const finiteOrZero = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Convert a sidecar form string (e.g. "WWDLW") + season avg_scored into synthetic
 *  RecentMatch[] for applyTemporalDecay. No per-match goal counts exist in the sidecar;
 *  we approximate: wins ≈ avg × 1.25, draws ≈ avg × 0.85, losses ≈ avg × 0.65.
 *  Returns null when the form string or base average is absent. */
function formToRecentMatches(
  last5: string | null | undefined,
  avgScored: number | null | undefined
): RecentMatch[] | null {
  if (!last5 || !finite(avgScored)) return null;
  const MULTIPLIER: Record<string, number> = { W: 1.25, D: 0.85, L: 0.65 };
  const matches: RecentMatch[] = [];
  for (const ch of last5.toUpperCase().split("")) {
    const mult = MULTIPLIER[ch];
    if (mult !== undefined) matches.push({ goalsScored: avgScored * mult });
  }
  return matches.length >= 3 ? matches : null;
}

export interface StatsOverride {
  xH?: number;
  xA?: number;
  xgMode?: "empirical";
  xg_confidence?: "high" | "medium";
  oppGA_H?: number;
  oppGA_A?: number;
  restH?: number;
  restA?: number;
}

/** Data-quality-gated hard override of the engine's xH/xA + SoS/fatigue inputs.
 *  Each input is gated independently: the xH/xA + SoS override requires a thick
 *  enough season sample (never overrides with garbage), while restH/restA are
 *  exact calendar deltas and apply whenever known. Returns null only when NONE
 *  of these could be derived — callers fall through to the engine's existing
 *  estimate/fallback behaviour in that case.
 *
 *  When a team has ≥MIN_PLAYED_FOR_OVERRIDE but < SHRINK_THRESHOLD matches, the
 *  raw lambda is shrunk toward a league prior via linear credibility weighting
 *  (w = n / SHRINK_THRESHOLD) to dampen early-season noise. */
export function buildStatsOverride(
  detail: SportyBetEventDetail | undefined,
  league?: string
): StatsOverride | null {
  const stats = detail?.stats;
  if (!stats) return null;

  const override: StatsOverride = {};

  const homePlayed = stats.standings?.home?.played ?? 0;
  const awayPlayed = stats.standings?.away?.played ?? 0;
  const enoughSample =
    homePlayed >= MIN_PLAYED_FOR_OVERRIDE && awayPlayed >= MIN_PLAYED_FOR_OVERRIDE;

  if (enoughSample) {
    const xgHome = stats.xg?.home?.xgf;
    const xgAway = stats.xg?.away?.xgf;
    const xgaHome = stats.xg?.home?.xga;
    const xgaAway = stats.xg?.away?.xga;
    const goalsHome = stats.goals?.home?.avg_scored;
    const goalsAway = stats.goals?.away?.avg_scored;
    // Full xG (xGF + true xGA, i.e. Understat per-match) → highest confidence.
    if (finite(xgHome) && finite(xgAway) && finite(xgaHome) && finite(xgaAway)) {
      override.xH = xgHome;
      override.xA = xgAway;
      override.xgMode = "empirical";
      override.xg_confidence = "high";
      // xGF-only (FBref season aggregate — no team-conceded figure) → still
      // preferred over raw goals-avg since xG is more predictive, but capped at
      // medium confidence to acknowledge the season-mean granularity.
    } else if (finite(xgHome) && finite(xgAway)) {
      override.xH = xgHome;
      override.xA = xgAway;
      override.xgMode = "empirical";
      override.xg_confidence = "medium";
    } else if (finite(goalsHome) && finite(goalsAway)) {
      override.xH = goalsHome;
      override.xA = goalsAway;
      override.xgMode = "empirical";
      override.xg_confidence = "medium";
    }

    // Credibility shrinkage toward league prior when sample is thin (n < SHRINK_THRESHOLD).
    // Applies only when xH/xA were successfully derived above and both teams played < threshold.
    if (override.xH !== undefined && override.xA !== undefined) {
      const nEff = Math.min(homePlayed, awayPlayed);
      if (nEff < SHRINK_THRESHOLD) {
        const w = nEff / SHRINK_THRESHOLD;
        const prior = GOALS_SHRINK_PRIORS[league ?? ""] ?? GOALS_SHRINK_PRIORS.Default!;
        override.xH = override.xH * w + prior.homeAvg * (1 - w);
        override.xA = override.xA * w + prior.awayAvg * (1 - w);
        // Downgrade confidence since shrinkage acknowledges the thin sample.
        if (override.xg_confidence === "high") override.xg_confidence = "medium";
      }
    }

    // Temporal decay — blend recent-form trajectory into the season-average xH/xA.
    // Preferred path: stats.recentGoals (last-5 scored averages, wired session 18)
    // is a REAL recency signal, so blend it in directly at a 60/40 recent/season
    // weight (matching applyTemporalDecay's blend ratio). Fallback path: when
    // recentGoals is absent, synthesise RecentMatch[] from the form string +
    // avg_scored and run applyTemporalDecay as before. Only when xH/xA were set.
    if (override.xH !== undefined && override.xA !== undefined) {
      const rgHome = stats.recentGoals?.home?.scored_avg;
      const rgAway = stats.recentGoals?.away?.scored_avg;
      const RECENT_W = 0.6;
      if (finite(rgHome)) {
        override.xH = rgHome * RECENT_W + override.xH * (1 - RECENT_W);
      } else {
        const homeForm = formToRecentMatches(
          stats.form?.home?.last5,
          stats.goals?.home?.avg_scored
        );
        if (homeForm) override.xH = applyTemporalDecay(homeForm, override.xH);
      }
      if (finite(rgAway)) {
        override.xA = rgAway * RECENT_W + override.xA * (1 - RECENT_W);
      } else {
        const awayForm = formToRecentMatches(
          stats.form?.away?.last5,
          stats.goals?.away?.avg_scored
        );
        if (awayForm) override.xA = applyTemporalDecay(awayForm, override.xA);
      }
    }

    // SoS adjustment inputs — adjustXGForSoS clamps its own factor to [0.5, 2.0]x,
    // so feeding real opponent-defense data here is safe even at the edges. Prefer
    // the scoringConceding venue-split conceded average (wired session 18 — home
    // team's home-conceded, away team's away-conceded; the sharpest defensive
    // figure) over the venue-agnostic season goals.avg_conceded.
    const awayConceded =
      stats.scoringConceding?.away?.conceded_avg ?? stats.goals?.away?.avg_conceded;
    const homeConceded =
      stats.scoringConceding?.home?.conceded_avg ?? stats.goals?.home?.avg_conceded;
    if (finite(awayConceded)) override.oppGA_A = awayConceded;
    if (finite(homeConceded)) override.oppGA_H = homeConceded;
  }

  // Rest days are exact calendar deltas, not statistical averages — no sample
  // gate needed. Fills the engine's existing fatigue-decay input (restH/restA),
  // which the runtime has never populated in production (always defaulted to 7).
  const homeRest = stats.congestion?.home?.rest_days;
  const awayRest = stats.congestion?.away?.rest_days;
  if (finiteOrZero(homeRest)) override.restH = homeRest;
  if (finiteOrZero(awayRest)) override.restA = awayRest;

  return Object.keys(override).length > 0 ? override : null;
}

/** Dead-rubber / motivation detection from standings.
 *
 *  No API exposes "must-win" directly (the source documents call this a manual
 *  judgement). We approximate conservatively: when BOTH teams sit safely
 *  mid-table late in the season — outside the top-5 (no title/continental push)
 *  and outside the bottom-5 (no relegation fear) — stakes are low and goal
 *  output tends to drift. We never hard-discard on this (ORACLE rule: data is
 *  never a blocker); we emit a mild motivationScore (0.8, vs the 1.0 neutral)
 *  plus an advisory item so the Claude arbiter can weigh it. Returns null when
 *  standings are too thin to judge — the engine then keeps its 1.0 default.
 *
 *  The motivationScore lands in RunState.telemetry.motivationScore, which
 *  execution/index.ts already reads (0.5=low … 1.2=high stakes). */
export function buildMotivation(
  detail: SportyBetEventDetail | undefined,
  observedAt: string = new Date().toISOString()
): { telemetry: { motivationScore?: number }; soft?: SoftContextItem } {
  const s = detail?.stats?.standings;
  const hp = s?.home?.pos;
  const ap = s?.away?.pos;
  const hPlayed = s?.home?.played ?? 0;
  const aPlayed = s?.away?.played ?? 0;
  // Need both positions and a season far enough along that "safe mid-table" means
  // something (>=20 games filters out early-season noise where everything's open).
  if (!finite(hp) || !finite(ap) || hPlayed < 20 || aPlayed < 20) return { telemetry: {} };

  const safeMid = (pos: number) => pos > 5 && pos <= 14;
  if (safeMid(hp) && safeMid(ap)) {
    return {
      telemetry: { motivationScore: 0.8 },
      soft: {
        kind: "motivation",
        text: `Possible low-stakes fixture — both teams safely mid-table (home pos ${hp}, away pos ${ap}, ${hPlayed}/${aPlayed} games played). Reduced motivation can suppress goals.`,
        source: "standings-heuristic",
        observedAt,
      },
    };
  }
  return { telemetry: {} };
}

/** Render the sidecar stats block as advisory SoftContextItem[] (kind: "stats")
 *  for the LLM decision prompt. Includes everything the override does NOT cover
 *  (H2H, form, standings position, over/under tendency) so the LLM sees the full
 *  picture even where the deterministic override couldn't apply. */
export function buildStatsSoftContext(
  detail: SportyBetEventDetail | undefined,
  observedAt: string = new Date().toISOString()
): SoftContextItem[] {
  const stats = detail?.stats;
  if (!stats) return [];

  const lines: string[] = [];
  const source = "sportybet-sidecar";

  const form = stats.form;
  if (form?.home || form?.away) {
    const side = (s: typeof form.home) =>
      s ? `${s.name ?? "?"} last5=${s.last5 ?? "?"} streak=${s.streak ?? 0}` : "n/a";
    lines.push(`Form — Home: ${side(form.home)} | Away: ${side(form.away)}`);
  }

  const standings = stats.standings;
  if (standings?.home || standings?.away) {
    const side = (s: typeof standings.home) =>
      s
        ? `pos=${s.pos ?? "?"} pts=${s.points ?? "?"} (${s.played ?? "?"} played, GF${s.gf ?? "?"}/GA${s.ga ?? "?"})`
        : "n/a";
    lines.push(`Standings — Home: ${side(standings.home)} | Away: ${side(standings.away)}`);
  }

  const goals = stats.goals;
  if (goals?.home || goals?.away) {
    const side = (s: typeof goals.home) =>
      s ? `${s.avg_scored ?? "?"} scored / ${s.avg_conceded ?? "?"} conceded per game` : "n/a";
    lines.push(`Season goals avg — Home: ${side(goals.home)} | Away: ${side(goals.away)}`);
  }

  const h2h = stats.h2h;
  if (h2h && (h2h.total ?? 0) > 0) {
    lines.push(
      `H2H (last ${h2h.total} meetings) — home wins ${h2h.home_wins ?? 0}, away wins ${h2h.away_wins ?? 0}, draws ${h2h.draws ?? 0}`
    );
  }

  const ou = stats.overunder;
  if (ou?.home || ou?.away) {
    const side = (s: typeof ou.home) =>
      s
        ? `O1.5 ${pct(s.over15_pct)} / O2.5 ${pct(s.over25_pct)} / O3.5 ${pct(s.over35_pct)}`
        : "n/a";
    lines.push(`Season over-line rate — Home: ${side(ou.home)} | Away: ${side(ou.away)}`);
  }

  const congestion = stats.congestion;
  if (congestion?.home || congestion?.away) {
    const side = (s: typeof congestion.home) =>
      s ? `${s.rest_days ?? "?"}d rest, next match in ${s.next_days ?? "?"}d` : "n/a";
    lines.push(`Fixture load — Home: ${side(congestion.home)} | Away: ${side(congestion.away)}`);
  }

  const pv = stats.possessionValue;
  if (pv?.home || pv?.away) {
    const side = (s: typeof pv.home) =>
      s
        ? `${s.shots_on_target_avg ?? "?"} SoT / ${s.shots_off_target_avg ?? "?"} off-target / ${s.corners_avg ?? "?"} corners / ${s.possession_pct_avg ?? "?"}% poss per game`
        : "n/a";
    lines.push(`Season shot volume — Home: ${side(pv.home)} | Away: ${side(pv.away)}`);
  }

  const rc = stats.recentCorners;
  if (typeof rc?.home === "number" || typeof rc?.away === "number") {
    lines.push(`Recent corners (last 5) — Home: ${rc?.home ?? "?"} | Away: ${rc?.away ?? "?"}`);
  }

  const rg = stats.recentGoals;
  if (rg?.home || rg?.away) {
    const side = (s: typeof rg.home) =>
      s
        ? `${s.scored_avg ?? "?"} scored / ${s.conceded_avg ?? "?"} conceded (last ${s.n ?? "?"})`
        : "n/a";
    lines.push(`Recent goals form — Home: ${side(rg.home)} | Away: ${side(rg.away)}`);
  }

  const scyc = stats.scoringConceding;
  if (scyc?.home || scyc?.away) {
    const side = (s: typeof scyc.home) =>
      s
        ? `${s.scored_avg ?? "?"} GF / ${s.conceded_avg ?? "?"} GA, BTTS ${pct(s.btts_rate)}, failed-to-score ${pct(s.failed_to_score_rate)}, clean-sheet ${pct(s.clean_sheet_rate)}, 1H goals ${s.goals_1h_avg ?? "?"}`
        : "n/a";
    lines.push(
      `Scoring/conceding (venue split) — Home: ${side(scyc.home)} | Away: ${side(scyc.away)}`
    );
  }

  const disc = stats.disciplinary;
  if (disc?.home || disc?.away) {
    const side = (s: typeof disc.home) =>
      s
        ? `${s.yellow_avg ?? "?"} yel / ${s.red_avg ?? "?"} red / ${s.fouls_avg ?? "?"} fouls per game`
        : "n/a";
    lines.push(`Discipline — Home: ${side(disc.home)} | Away: ${side(disc.away)}`);
  }

  const ph = stats.positionHistory;
  if (ph?.home || ph?.away) {
    const side = (s: typeof ph.home) => {
      if (!s) return "n/a";
      const t = s.trend;
      const trendStr = typeof t === "number" ? (t > 0 ? `+${t}` : `${t}`) : "?";
      return `now ${s.current ?? "?"} (best ${s.best ?? "?"}, worst ${s.worst ?? "?"}, trend ${trendStr})`;
    };
    lines.push(`Position trend — Home: ${side(ph.home)} | Away: ${side(ph.away)}`);
  }

  const tg = stats.topGoals;
  if (tg?.home || tg?.away) {
    const side = (s: typeof tg.home) =>
      s ? `${s.top_scorer_name ?? "?"} ${s.top_scorer_goals ?? "?"} goals` : "n/a";
    lines.push(`Lead scorer — Home: ${side(tg.home)} | Away: ${side(tg.away)}`);
  }

  if (!lines.length) return [];
  return [
    {
      kind: "stats",
      text: lines.join("; "),
      source,
      observedAt,
    },
  ];
}

function pct(v: number | undefined): string {
  return typeof v === "number" ? `${Math.round(v * 100)}%` : "?";
}
