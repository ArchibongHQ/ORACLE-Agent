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
import type {
  ScoringConcedingProfile,
  SportyBetEventDetail,
  SportyBetXgEntry,
} from "./selectFixtures.js";

/** Season matches required before a goals/xG average is trusted enough to
 *  override the engine's xH/xA outright — below this, season averages are
 *  1-3 match noise that would corrupt the Poisson model worse than the
 *  existing league-average/LLM-estimate fallback. Exported so
 *  apps/worker/src/goalsV3Pipeline.ts's buildGoalsV3Input can gate its own
 *  scoringConceding venue-split preference on the identical threshold. */
export const MIN_PLAYED_FOR_OVERRIDE = 4;

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

/** Recency-blend a season-average scored rate: prefer the real recentGoals
 *  last-5 signal (60/40 recent/season blend), fall back to a form-string-
 *  synthesized RecentMatch[] run through applyTemporalDecay, or return the
 *  season average unchanged when neither recency signal exists. Used by the
 *  v3 scoredPer90H/A raw λ inputs below and by buildGoalsV3Input (apps/worker),
 *  which previously ran §3.1 goalsV3/marketsV3 lambdas on undecayed season
 *  averages. NOT wired into the legacy xH/xA override below — that block
 *  synthesizes its RecentMatch[] from the raw season goals average
 *  specifically (not whatever xG-blended value xH/xA may already hold), a
 *  subtly different base than this helper's single `seasonAvg` param assumes;
 *  left as its own inline implementation rather than force-fit to avoid a
 *  silent behavior change. */
export function blendRecencyScored(
  seasonAvg: number | null | undefined,
  recentAvg: number | null | undefined,
  formLast5: string | null | undefined
): number | null {
  if (!finite(seasonAvg)) return seasonAvg ?? null;
  const RECENT_W = 0.6;
  if (finite(recentAvg)) return recentAvg * RECENT_W + seasonAvg * (1 - RECENT_W);
  const form = formToRecentMatches(formLast5, seasonAvg);
  return form ? applyTemporalDecay(form, seasonAvg) : seasonAvg;
}

export interface StatsOverride {
  xH?: number;
  xA?: number;
  /** "estimated" when the xGA half of the pair is a league-mean fill
   *  (build_xg_table.py xgaSrc tag) — engines apply the softer estimated-xG
   *  penalty instead of treating the pair as fully empirical. */
  xgMode?: "empirical" | "estimated";
  xg_confidence?: "high" | "medium";
  oppGA_H?: number;
  oppGA_A?: number;
  restH?: number;
  restA?: number;
  // ── all-markets-analysis-prompt-v3 typed market-specific stats (previously
  // rawStatsBlock prose only — §0.3 market-specific tier + §3.5/§3.6/§3.9
  // engine inputs). Per-side venue splits where the source provides them.
  /** Season BTTS rate (0..1), venue split (scoringConceding). */
  bttsPctH?: number;
  bttsPctA?: number;
  /** Season clean-sheet rate (0..1), venue split (scoringConceding). */
  csPctH?: number;
  csPctA?: number;
  /** Season failed-to-score rate (0..1), venue split (scoringConceding). */
  ftsPctH?: number;
  ftsPctA?: number;
  /** Recent-form sample size (match count, recentGoals last-5 window) behind
   *  the empirical rates above — feeds the engine's sample-scaled blend (§3.5
   *  PR-3): a team with only 1-2 recent matches earns less blend weight than
   *  one with a full 5-match window. */
  formNH?: number;
  formNA?: number;
  /** First-half share of the team's goals (0..1) = goals_1h_avg / scored_avg,
   *  clamped to [0.2, 0.8] — feeds the §3.6 half engine's ρ. */
  fhShareH?: number;
  fhShareA?: number;
  /** Corners for/against per game — recent-5 (lastxextended) preferred, season
   *  aggregate (uniqueteamstats corners_avg, for-only) as fallback. §3.9. */
  cornersForH?: number;
  cornersForA?: number;
  cornersAgainstH?: number;
  cornersAgainstA?: number;
  /** Total cards per game (yellow + red), venue split (teamdisciplinary). §3.9. */
  cardsAvgH?: number;
  cardsAvgA?: number;
  /** PR-22: shots-on-target per game, season aggregate (possessionValue). */
  sotForH?: number;
  sotForA?: number;
  /** Season O/U hit-rates (0..1), both venues (stats_season_overunder) — §2
   *  prioritisation + §1.2 heightened trend checks; ou25 also feeds the v4
   *  all-markets totals engine's per-line marketStatMissing flag (PR-4). */
  ouO15H?: number;
  ouO15A?: number;
  ouO25H?: number;
  ouO25A?: number;
  ouO35H?: number;
  ouO35A?: number;
  // ── §3.1 raw multiplicative-λ inputs (ungated by MIN_PLAYED_FOR_OVERRIDE —
  // v3 runs its own shrinkage from these, separate from xH/xA above).
  scoredPer90H?: number;
  concededPer90H?: number;
  scoredPer90A?: number;
  concededPer90A?: number;
  xgfH?: number;
  xgaH?: number;
  xgfA?: number;
  xgaA?: number;
  nHome?: number;
  nAway?: number;
  /** Match-day squad availability multiplier (tools/fetch_squad_availability.py
   *  §8.2, PR-6) — feeds V3LambdaInput.home/awayAvailabilityMult in BOTH v3
   *  pipelines (goals-only via buildGoalsV3Input reads the sidecar directly;
   *  all-markets via batch/index.ts's buildV3Input reads this telemetry
   *  field). Ungated by MIN_PLAYED_FOR_OVERRIDE like the raw λ inputs above —
   *  availability is orthogonal to season sample size. */
  homeAvailabilityMult?: number;
  awayAvailabilityMult?: number;
}

/** Resolve the credibility-shrinkage prior for a league.
 *
 *  Order: (1) the researched GOALS_SHRINK_PRIORS table; (2) a STANDINGS-DERIVED
 *  prior computed from the fixture's own season table (gf/played, ga/played) —
 *  this is what lets a league absent from the table (e.g. the Faroe Islands top
 *  flight from the audit) still shrink toward its REAL mean instead of the generic
 *  1.5/1.2 Default; (3) the Default constant as a last resort.
 *
 *  The standings-derived figure uses each team's own gf/ga rate averaged — a
 *  coarse league proxy, but a real one drawn from this season's actual scoring,
 *  which beats a hardcoded guess for any uncovered league. */
export function leaguePrior(
  league: string | undefined,
  detail?: SportyBetEventDetail | undefined
): { homeAvg: number; awayAvg: number } {
  const table = GOALS_SHRINK_PRIORS[league ?? ""];
  if (table) return table;

  const st = detail?.stats?.standings;
  const rate = (gf: unknown, ga: unknown, played: unknown): [number, number] | null => {
    if (!finite(gf) || !finite(ga) || !finite(played) || played < 1) return null;
    return [gf / played, ga / played];
  };
  const h = rate(st?.home?.gf, st?.home?.ga, st?.home?.played);
  const a = rate(st?.away?.gf, st?.away?.ga, st?.away?.played);
  if (h && a) {
    // Average each side's scored & conceded rate into a league home/away prior.
    const homeAvg = (h[0] + a[1]) / 2; // home scoring ≈ (home GF rate + away GA rate)/2
    const awayAvg = (a[0] + h[1]) / 2;
    if (finite(homeAvg) && finite(awayAvg)) {
      // Clamp to a sane football range so a tiny/aberrant table can't poison the prior.
      return {
        homeAvg: Math.min(3.5, Math.max(0.5, homeAvg)),
        awayAvg: Math.min(3.5, Math.max(0.4, awayAvg)),
      };
    }
  }
  return GOALS_SHRINK_PRIORS.Default!;
}

/** Bounded multiplicative nudge to the season-average xH/xA from over/under hit-
 *  rates + BTTS rate — two strong, already-scraped goal signals the engine math
 *  never consumed (they reached only the LLM as prose). Clamped to [0.9, 1.1]x so
 *  it sharpens the lambda without ever overpowering the xG/goals base it modulates.
 *
 *  Signal: a team whose matches go Over 2.5 far more than the ~50% league norm is
 *  systematically involved in higher-scoring games than its raw scored-average
 *  alone implies (it concedes too); the O2.5 rate captures that joint tendency.
 *  BTTS rate corroborates. We map the blended signal linearly onto [0.9, 1.1].
 *  Returns 1.0 (no-op) when neither signal is present. */
export function goalRateNudge(
  detail: SportyBetEventDetail | undefined,
  side: "home" | "away"
): number {
  const stats = detail?.stats;
  const ou = stats?.overunder?.[side]?.over25_pct;
  const btts = stats?.scoringConceding?.[side]?.btts_rate;
  const signals: number[] = [];
  // over25_pct and btts_rate are 0..1 rates; centre on 0.5 (≈ league-neutral) and
  // scale the deviation. A team at O2.5=0.75 → +0.25 dev → strong upward nudge.
  if (finiteOrZero(ou)) signals.push(ou - 0.5);
  if (finiteOrZero(btts)) signals.push(btts - 0.5);
  if (signals.length === 0) return 1.0;
  const dev = signals.reduce((s, v) => s + v, 0) / signals.length;
  // 0.4 gain → a full ±0.5 deviation maps to ±0.20, then clamp to ±0.10.
  const raw = 1 + dev * 0.4;
  return Math.min(1.1, Math.max(0.9, raw));
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

  // Each scoringConceding side gates on its own venue-split match count —
  // shared with the §0.3 market-specific tier further down, hoisted here so
  // the §3.1 lambda inputs below can use it too.
  const scOk = (p: ScoringConcedingProfile | null | undefined) =>
    (p?.matches ?? 0) >= MIN_PLAYED_FOR_OVERRIDE;

  // ── all-markets-analysis-prompt-v3 §3.1 raw lambda inputs — ungated by
  // MIN_PLAYED_FOR_OVERRIDE (v3 runs its OWN multiplicative+shrinkage from
  // these, independent of the legacy xH/xA override above). Populated
  // whenever the underlying gismo field exists, regardless of sample size.
  //
  // [PR-14] Prefer the scoringConceding venue split (home team's own
  // home-scored/home-conceded rate, away team's own away-scored/away-conceded
  // rate — stats_season_teamscoringconceding, the same source already used
  // for the SoS opponent-conceded figure below) over the venue-agnostic
  // season goals.avg_scored/avg_conceded — a strictly better prior when its
  // own sample is thick enough, same pattern v3TeamXg already applies for xG
  // (venueXgf/venueXga over the season aggregate). Gated on the SAME
  // MIN_PLAYED_FOR_OVERRIDE threshold as scOk below, so a thin venue-split
  // sample falls back to the season aggregate rather than trusting 1-3
  // matches. This does NOT change v3Hfa/v3VenueSplitUsed — that flag is a
  // separate, still-manual global override (see effectiveConfig.ts's WARN);
  // this only improves the season-aggregate INPUT quality feeding lambda.
  const homeScoringOk = scOk(stats.scoringConceding?.home);
  const awayScoringOk = scOk(stats.scoringConceding?.away);
  const gScoredH = homeScoringOk
    ? (stats.scoringConceding?.home?.scored_avg ?? stats.goals?.home?.avg_scored)
    : stats.goals?.home?.avg_scored;
  const gConcededH = homeScoringOk
    ? (stats.scoringConceding?.home?.conceded_avg ?? stats.goals?.home?.avg_conceded)
    : stats.goals?.home?.avg_conceded;
  const gScoredA = awayScoringOk
    ? (stats.scoringConceding?.away?.scored_avg ?? stats.goals?.away?.avg_scored)
    : stats.goals?.away?.avg_scored;
  const gConcededA = awayScoringOk
    ? (stats.scoringConceding?.away?.conceded_avg ?? stats.goals?.away?.avg_conceded)
    : stats.goals?.away?.avg_conceded;
  // Recency-blend the scored side only (mirrors the xH/xA decay below, which
  // has never applied to these v3-specific fields — goalsV3/marketsV3 lambdas
  // ran on flat season averages with zero recency weighting until now).
  // Conceded rates stay season-flat, matching the existing xH/xA convention.
  const scoredH = blendRecencyScored(
    gScoredH,
    stats.recentGoals?.home?.scored_avg,
    stats.form?.home?.last5
  );
  const scoredA = blendRecencyScored(
    gScoredA,
    stats.recentGoals?.away?.scored_avg,
    stats.form?.away?.last5
  );
  if (scoredH !== null) override.scoredPer90H = scoredH;
  if (finite(gConcededH)) override.concededPer90H = gConcededH;
  if (scoredA !== null) override.scoredPer90A = scoredA;
  if (finite(gConcededA)) override.concededPer90A = gConcededA;
  if (finite(stats.xg?.home?.xgf)) override.xgfH = stats.xg?.home?.xgf;
  if (finite(stats.xg?.home?.xga)) override.xgaH = stats.xg?.home?.xga;
  if (finite(stats.xg?.away?.xgf)) override.xgfA = stats.xg?.away?.xgf;
  if (finite(stats.xg?.away?.xga)) override.xgaA = stats.xg?.away?.xga;
  if (homePlayed > 0) override.nHome = homePlayed;
  if (awayPlayed > 0) override.nAway = awayPlayed;
  // Match-day squad availability (§8.2, PR-6) — feeds V3LambdaInput's λ
  // multiplier in the all-markets v3 pipeline (batch/index.ts's buildV3Input
  // reads this telemetry field); the goals-only pipeline reads the sidecar
  // directly in buildGoalsV3Input instead of going through this override.
  const availH = stats.availability?.home?.idx;
  const availA = stats.availability?.away?.idx;
  if (finiteOrZero(availH)) override.homeAvailabilityMult = availH;
  if (finiteOrZero(availA)) override.awayAvailabilityMult = availA;
  // §3.5 empirical-blend sample size (PR-3) — recentGoals is a last-5 window,
  // so its own match count is the right "how much to trust this rate" signal,
  // independent of the season-long enoughSample gate below.
  const formNH = stats.recentGoals?.home?.n;
  const formNA = stats.recentGoals?.away?.n;
  if (finite(formNH)) override.formNH = formNH;
  if (finite(formNA)) override.formNA = formNA;

  if (enoughSample) {
    // Venue-conditioned xG (the team's own home/away split, build_xg_table.py)
    // is a strictly better prior than the season aggregate when its sample is
    // thick enough — same MIN_PLAYED gate as the override itself (v3 §0.1
    // "xG/xGA home & away splits" gap-closure).
    const pickXg = (entry: SportyBetXgEntry | null | undefined) => {
      const useVenue = finite(entry?.venueXgf) && (entry?.venueN ?? 0) >= MIN_PLAYED_FOR_OVERRIDE;
      return {
        xgf: useVenue ? entry?.venueXgf : entry?.xgf,
        xga: useVenue && finite(entry?.venueXga) ? entry?.venueXga : entry?.xga,
      };
    };
    const xgH = pickXg(stats.xg?.home);
    const xgA = pickXg(stats.xg?.away);
    // Two independent reasons an xG pair must not claim empirical/high
    // confidence: (a) league-mean-estimated xGA (build_xg_table.py xga_src
    // tag) fills a real gap, or (b) either side is google_ai-sourced (PR-19
    // fallback tier, LLM prose extraction — a whole-pair low-confidence tier,
    // not just an xGA-specific fill). Mirrors goalsV3/completeness.ts's
    // xgEstimated check so the goals and all-markets pipelines never disagree
    // on one xG pair's confidence.
    const xgConfidenceDowngrade =
      stats.xg?.home?.xgaSrc === "estimated" ||
      stats.xg?.away?.xgaSrc === "estimated" ||
      stats.xg?.home?.src === "google_ai" ||
      stats.xg?.away?.src === "google_ai";
    const goalsHome = stats.goals?.home?.avg_scored;
    const goalsAway = stats.goals?.away?.avg_scored;
    // Full xG (xGF + xGA both sides) → highest confidence, unless the xGA half
    // is a league-mean estimate (then medium + "estimated" mode → softer §4.2
    // penalty downstream instead of the harsher no-xG one).
    if (finite(xgH.xgf) && finite(xgA.xgf) && finite(xgH.xga) && finite(xgA.xga)) {
      override.xH = xgH.xgf;
      override.xA = xgA.xgf;
      override.xgMode = xgConfidenceDowngrade ? "estimated" : "empirical";
      override.xg_confidence = xgConfidenceDowngrade ? "medium" : "high";
      // xGF-only (pre-fill FBref tables — no team-conceded figure) → still
      // preferred over raw goals-avg since xG is more predictive, but capped at
      // medium confidence to acknowledge the season-mean granularity.
    } else if (finite(xgH.xgf) && finite(xgA.xgf)) {
      override.xH = xgH.xgf;
      override.xA = xgA.xgf;
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
        const prior = leaguePrior(league, detail);
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

      // Goal-rate nudge — fold the over/under + BTTS hit-rates (already scraped,
      // previously LLM-prose-only) into the lambda as a bounded [0.9,1.1]x factor.
      // Applied last so it modulates the fully-built season+recency xH/xA without
      // overpowering it. Same enoughSample gate as everything above.
      override.xH = override.xH * goalRateNudge(detail, "home");
      override.xA = override.xA * goalRateNudge(detail, "away");
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

  // ── all-markets v3 typed market-specific stats (§0.3 market-specific tier).
  // Each family gates on its own sample: scoringConceding rates on the
  // profile's own venue match count (scOk, hoisted above), season aggregates
  // on enoughSample, recent-5 corners on their built-in ≥1-match floor.
  const fhShare = (p: ScoringConcedingProfile | null | undefined): number | undefined => {
    const fh = p?.goals_1h_avg;
    const total = p?.scored_avg;
    if (!finite(fh) || !finite(total)) return undefined;
    return Math.min(0.8, Math.max(0.2, fh / total));
  };
  const applyScoring = (
    p: ScoringConcedingProfile | null | undefined,
    set: {
      btts: "bttsPctH" | "bttsPctA";
      cs: "csPctH" | "csPctA";
      fts: "ftsPctH" | "ftsPctA";
      fh: "fhShareH" | "fhShareA";
    }
  ) => {
    if (!scOk(p)) return;
    const btts = p?.btts_rate;
    const cs = p?.clean_sheet_rate;
    const fts = p?.failed_to_score_rate;
    if (finiteOrZero(btts)) override[set.btts] = btts;
    if (finiteOrZero(cs)) override[set.cs] = cs;
    if (finiteOrZero(fts)) override[set.fts] = fts;
    const fh = fhShare(p);
    if (fh !== undefined) override[set.fh] = fh;
  };
  applyScoring(stats.scoringConceding?.home, {
    btts: "bttsPctH",
    cs: "csPctH",
    fts: "ftsPctH",
    fh: "fhShareH",
  });
  applyScoring(stats.scoringConceding?.away, {
    btts: "bttsPctA",
    cs: "csPctA",
    fts: "ftsPctA",
    fh: "fhShareA",
  });

  // Corners: recent-5 (lastxextended) preferred; season corners_avg (for-only)
  // as fallback under the same season-sample gate as other aggregates.
  const cornersForH =
    stats.recentCorners?.home ??
    (enoughSample ? stats.possessionValue?.home?.corners_avg : undefined);
  const cornersForA =
    stats.recentCorners?.away ??
    (enoughSample ? stats.possessionValue?.away?.corners_avg : undefined);
  const cornersAgH = stats.recentCornersAgainst?.home;
  const cornersAgA = stats.recentCornersAgainst?.away;
  if (finite(cornersForH)) override.cornersForH = cornersForH;
  if (finite(cornersForA)) override.cornersForA = cornersForA;
  if (finite(cornersAgH)) override.cornersAgainstH = cornersAgH;
  if (finite(cornersAgA)) override.cornersAgainstA = cornersAgA;

  if (enoughSample) {
    const cards = (d: { yellow_avg?: number; red_avg?: number } | null | undefined) => {
      const yellow = d?.yellow_avg;
      if (!finite(yellow)) return undefined;
      const red = d?.red_avg;
      return yellow + (finiteOrZero(red) ? red : 0);
    };
    const cardsH = cards(stats.disciplinary?.home);
    const cardsA = cards(stats.disciplinary?.away);
    if (cardsH !== undefined) override.cardsAvgH = cardsH;
    if (cardsA !== undefined) override.cardsAvgA = cardsA;

    // PR-22: shots-on-target — season aggregate only (no recent-form source
    // exists for this stat, unlike corners), same gate as cards/O-U hit-rates.
    const sotH = stats.possessionValue?.home?.shots_on_target_avg;
    const sotA = stats.possessionValue?.away?.shots_on_target_avg;
    if (finite(sotH)) override.sotForH = sotH;
    if (finite(sotA)) override.sotForA = sotA;

    const o15H = stats.overunder?.home?.over15_pct;
    const o15A = stats.overunder?.away?.over15_pct;
    if (finiteOrZero(o15H)) override.ouO15H = o15H;
    if (finiteOrZero(o15A)) override.ouO15A = o15A;

    const o25H = stats.overunder?.home?.over25_pct;
    const o25A = stats.overunder?.away?.over25_pct;
    if (finiteOrZero(o25H)) override.ouO25H = o25H;
    if (finiteOrZero(o25A)) override.ouO25A = o25A;

    const o35H = stats.overunder?.home?.over35_pct;
    const o35A = stats.overunder?.away?.over35_pct;
    if (finiteOrZero(o35H)) override.ouO35H = o35H;
    if (finiteOrZero(o35A)) override.ouO35A = o35A;
  }

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
    // Append the actual scorelines (un-discarded match-by-match detail) so the LLM
    // sees the goal trend, not just the win/draw tally — the audit's specific gap.
    const results = (h2h.matches ?? [])
      .filter((m) => typeof m.home_goals === "number" && typeof m.away_goals === "number")
      .slice(0, 5)
      .map((m) => `${m.home_goals}-${m.away_goals}`)
      .join(", ");
    const resultsSuffix = results ? ` — recent results ${results}` : "";
    lines.push(
      `H2H (last ${h2h.total} meetings) — home wins ${h2h.home_wins ?? 0}, away wins ${h2h.away_wins ?? 0}, draws ${h2h.draws ?? 0}${resultsSuffix}`
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
