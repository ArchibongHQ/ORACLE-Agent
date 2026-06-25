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

import type { SoftContextItem } from "@oracle/engine";
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
 *  Sources: FBref 2022-2026 seasonal averages cross-checked ≥2 sources. */
const GOALS_SHRINK_PRIORS: Record<string, { homeAvg: number; awayAvg: number }> = {
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
  Default: { homeAvg: 1.5, awayAvg: 1.2 },
};

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const finiteOrZero = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

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
    const goalsHome = stats.goals?.home?.avg_scored;
    const goalsAway = stats.goals?.away?.avg_scored;
    if (finite(xgHome) && finite(xgAway)) {
      override.xH = xgHome;
      override.xA = xgAway;
      override.xgMode = "empirical";
      override.xg_confidence = "high";
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

    // SoS adjustment inputs — adjustXGForSoS clamps its own factor to [0.5, 2.0]x,
    // so feeding real opponent-defense data here is safe even at the edges.
    const awayConceded = stats.goals?.away?.avg_conceded;
    const homeConceded = stats.goals?.home?.avg_conceded;
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
