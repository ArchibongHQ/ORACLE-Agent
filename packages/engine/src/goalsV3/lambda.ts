/** goals-market-analysis-prompt-v3 §3.1 — expected goals per side (λ).
 *
 *  Multiplicative attack × defence × league model:
 *      λ_home = (H_scored/90 ÷ L) × (A_conceded/90 ÷ L) × L
 *      λ_away = (A_scored/90 ÷ L) × (H_conceded/90 ÷ L) × L
 *  where L = league average goals per TEAM per game. Falls back to the simple
 *  average ((scored + opp conceded) / 2) when a factor is missing. Small-sample
 *  regression (n < 8): λ_adj = λ_raw × (n/8) + L × (1 − n/8). Optional 50/50
 *  blend with an xG-based λ computed through the same formula (xG is more
 *  stable on small samples — spec §3.1 refinement).
 *
 *  Pure math, no I/O, no runtime imports. */

import { getLeagueParams } from "../execution/index.js";
import { clamp } from "../math/index.js";

/** v3 §3.4 league baselines — goals per GAME (halve for per-team L). Spec table
 *  verbatim; entries the engine's LEAGUE_PARAMS also covers defer to the spec
 *  here because the v3 gate math was calibrated against these totals.
 *
 *  NOTE — this table and `execution/index.ts`'s LEAGUE_PARAMS are two
 *  independently-maintained sources for the same leagues and can (and do,
 *  e.g. Premier League: 2.85 goals/game here vs (1.48+1.22)*2=2.70 there)
 *  disagree — `v3LeaguePerTeamAvg` below prefers THIS table when a league
 *  appears in both. Not unified (LEAGUE_PARAMS also carries baseRho/kFactor/
 *  drawRate for a different subsystem) — if you refresh one, sanity-check the
 *  other hasn't drifted further apart for the same league.
 *
 *  Refreshed 2026-07-06 against live season data (multiple sources
 *  cross-checked; see oracle_full_system_audit_2026_07_06.md P0-2). Values
 *  within ~2% of a real season figure were left as-is (noise); anything
 *  further off was updated. Rows without a verified current-season figure
 *  this pass are left unchanged — don't assume they're current. */
export const V3_LEAGUE_BASELINES: Record<string, number> = {
  // Recent editions: 2014 = 2.7, 2018 = 2.6, 2022 = 2.7 goals/game (48-team
  // format unverified) — 2.75 was the all-time average, skewed by pre-1970
  // tournaments. Serves as the n<8 shrink prior for WC fixtures via `L`.
  "World Cup": 2.65,
  "Premier League": 2.85, // 2024-25 actual ≈2.88, 2023-24 outlier 3.28 — within noise
  Bundesliga: 3.15, // 2024-25 actual ≈3.14-3.22 — within noise
  "La Liga": 2.65, // 2024-25 actual ≈2.62 — within noise
  "Serie A": 2.6, // 2024-25 actual ≈2.56 — within noise
  "Ligue 1": 2.96, // was 2.75; 2024-25 actual ≈2.96 (verified 2026-07-06)
  Eredivisie: 3.2,
  Championship: 2.55,
  "Brazilian Serie B": 2.25, // was 2.4; 2025 actual ≈2.22 (verified 2026-07-06)
  "Brazil Série A": 2.55, // was 2.7; 2025 actual ≈2.52 (verified 2026-07-06)
  "Botola Pro": 2.3,
  "USL League Two": 3.0,
  "USL League One": 2.8,
  "Copa Chile": 2.6,
  "Liga MX": 2.65,
  MLS: 3.0, // was 2.8; 2025 actual ≈3.01 (verified 2026-07-06)
  "A-League": 2.75,
  J1: 2.65,
  "Saudi Pro League": 2.6,
  "South Africa PL": 2.3,
  "Egypt PL": 2.35,
};

/** Default league total (goals per game) when neither the v3 table nor the
 *  engine's LEAGUE_PARAMS knows the league. */
export const V3_DEFAULT_LEAGUE_GPG = 2.6;

/** Baselines keyed by canonical league ID (Sportradar tournament ID, e.g.
 *  "sr:tournament:17") instead of the free-text label — closes the
 *  label-collision gap where two unrelated competitions sharing a generic
 *  name (e.g. a lower-tier "Premier League") would otherwise silently share
 *  the wrong baseline. Empty until specific colliding IDs are observed and
 *  verified; `tools/scrape_fixtures.py` captures `tournament.id` end-to-end
 *  through the lake as of 2026-07-06 (P0-2), so entries can be added here as
 *  they're identified without any further plumbing. Takes priority over the
 *  name-keyed table below when a fixture carries a leagueId. */
export const V3_LEAGUE_BASELINES_BY_ID: Record<string, number> = {};

/** League average goals per TEAM per game (the `L` of §3.1). Lookup order:
 *  ID-keyed table (when leagueId is known) → v3 spec name table → engine
 *  LEAGUE_PARAMS (homeAvg + awayAvg is the league's per-game total) → 2.60
 *  default. */
export function v3LeaguePerTeamAvg(
  league: string,
  leagueId?: string | null,
  lakeBaselines?: Record<string, number> | null
): number {
  if (leagueId) {
    const byId = V3_LEAGUE_BASELINES_BY_ID[leagueId];
    if (byId) return byId / 2;
  }
  // Lake-computed baseline (goals/game keyed by league name, from
  // tools/compute_league_baselines.py) when supplied — the audit P0-2 refresh
  // path. Ranks below the manual ID-keyed collision overrides (those are
  // deliberate, name-lookup can't disambiguate a collision) but ABOVE the
  // static spec table, so a stale hardcoded value can't shadow a fresh lake
  // figure; the static table stays the fallback for leagues absent from the
  // lake. Injected via config (ORACLE_V3_LAKE_BASELINES, default off), so
  // undefined ⇒ byte-identical to the prior static-only behavior.
  if (lakeBaselines) {
    const lake = lakeBaselines[league];
    if (typeof lake === "number" && Number.isFinite(lake) && lake > 0) return lake / 2;
  }
  const spec = V3_LEAGUE_BASELINES[league];
  if (spec) return spec / 2;
  const lp = getLeagueParams(league);
  if (lp) return (lp.homeAvg + lp.awayAvg) / 2;
  return V3_DEFAULT_LEAGUE_GPG / 2;
}

/** Resolve the Dixon-Coles rho to price a fixture with: the calibration-
 *  ledger-derived dynamic rho (CalibrationMetrics.dynamicRhoParams, §8.1
 *  NR-MLE) when it's a finite number, else the static per-league baseRho.
 *  Defense-in-depth type-boundary guard — estimateDynamicRho itself already
 *  clamps to [-0.3, 0.02] and falls back to baseRho on any degenerate input,
 *  so no reachable writer produces a bad value today, but dynamicRho crosses
 *  a module boundary (calibration ledger → goalsV3/marketsV3) with no
 *  independent check of its own before this fix. */
export function resolveRho(league: string, dynamicRho?: number | null): number {
  if (typeof dynamicRho === "number" && Number.isFinite(dynamicRho)) return dynamicRho;
  return getLeagueParams(league).baseRho;
}

/** Per-team xG rates (per match, from the rolling xG table). `estimated` marks
 *  AI-Mode-sourced figures (softer penalty than missing, §0.2 fallback tier). */
export interface V3TeamXg {
  /** xG for (created) per match. */
  xgf?: number | null;
  /** xG against (conceded) per match. */
  xga?: number | null;
}

export interface V3LambdaInput {
  league: string;
  /** Canonical league ID (Sportradar tournament ID), when the source captured
   *  one — see V3_LEAGUE_BASELINES_BY_ID. Optional/backward-compatible: older
   *  lake partitions and non-SportyBet sources (e.g. the ESPN scraper) won't
   *  have one, and fall back to name-based lookup. */
  leagueId?: string | null;
  homeScoredPer90?: number | null;
  homeConcededPer90?: number | null;
  awayScoredPer90?: number | null;
  awayConcededPer90?: number | null;
  /** Matches behind the home/away season averages (shrinkage trigger, n < 8). */
  nHome?: number | null;
  nAway?: number | null;
  /** Venue-appropriate xG rates when available (home team's home split,
   *  away team's away split — falls back to season aggregate upstream). */
  homeXg?: V3TeamXg | null;
  awayXg?: V3TeamXg | null;
  /** Match-day squad availability multiplier (tools/fetch_squad_availability.py
   *  §8.2 — matchday squad value / rolling peak squad value, 1.0 = full
   *  strength), applied to the raw λ before small-sample shrinkage — same
   *  "reduce expected goals for a depleted squad" shape as the legacy engine's
   *  adjH*(1-injPen), but sourced from real Kaggle Transfermarkt data instead
   *  of an LLM guess. Clamped to [0.5, 1.0]; absent/undefined ⇒ 1.0 (no-op). */
  homeAvailabilityMult?: number | null;
  awayAvailabilityMult?: number | null;
}

export interface V3Lambdas {
  lambdaHome: number;
  lambdaAway: number;
  mu: number;
  /** Which §3.1 formula produced the goals-based λ. */
  method: "multiplicative" | "simple-average";
  /** True when small-sample regression (n < 8) moved either λ. */
  shrunk: boolean;
  /** True when the 50/50 xG blend was applied (either side). */
  xgBlended: boolean;
  /** λ v5: which sides actually blended — "home"/"away" = partial blend (the
   *  other side had no usable xG cross-pair; flag xgPartial penalty upstream). */
  xgBlendedSides?: "both" | "home" | "away";
  /** Per-team L used (league goals per team per game). */
  leaguePerTeamAvg: number;
  /** True when HFA (home-field advantage) was applied to λ. */
  hfaApplied?: boolean;
}

const SHRINK_N = 8;
/** λ sanity clamp — a team model outside this range is a data artifact, not a
 *  forecast (0.05 keeps Poisson tails well-defined; 4.5 exceeds any real team). */
const LAMBDA_MIN = 0.05;
const LAMBDA_MAX = 4.5;
/** §8.2 availability multiplier bounds — 1.0 matches fetch_squad_availability.py's
 *  own min(ratio, 1.0) cap; 0.5 floors a data glitch (or a genuinely gutted XI)
 *  from ever zeroing a team's λ outright. */
const AVAILABILITY_MULT_MIN = 0.5;
const AVAILABILITY_MULT_MAX = 1.0;

function isRate(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** One side's multiplicative λ; null when either factor is missing. */
function multiplicativeLambda(
  scoredPer90: number | null | undefined,
  oppConcededPer90: number | null | undefined,
  L: number
): number | null {
  if (!isRate(scoredPer90) || !isRate(oppConcededPer90)) return null;
  return (scoredPer90 / L) * (oppConcededPer90 / L) * L;
}

/** One side's simple-average fallback λ; null when both inputs are missing. */
function simpleAverageLambda(
  scoredPer90: number | null | undefined,
  oppConcededPer90: number | null | undefined
): number | null {
  const s = isRate(scoredPer90) ? scoredPer90 : null;
  const c = isRate(oppConcededPer90) ? oppConcededPer90 : null;
  if (s === null && c === null) return null;
  if (s !== null && c !== null) return (s + c) / 2;
  return s ?? c;
}

/** §3.1 small-sample regression toward the league mean (cap n at 8). */
function shrink(lambda: number, n: number | null | undefined, L: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n >= SHRINK_N) return lambda;
  const w = Math.max(0, n) / SHRINK_N;
  return lambda * w + L * (1 - w);
}

/** Compute v3 lambdas for one fixture. Both sides use the multiplicative model
 *  when all four factors exist; a side missing a factor drops the WHOLE fixture
 *  to the simple-average method (mixing formulas across sides would skew the
 *  split the match-shape step later corrects). Returns null when neither team
 *  has any usable scoring signal — the completeness gate upstream should have
 *  discarded such fixtures already. */
export function computeV3Lambdas(
  input: V3LambdaInput,
  opts: {
    xgBlend?: boolean;
    venueSplitUsed?: boolean;
    hfa?: number;
    lambdaV5?: boolean;
    lakeBaselines?: Record<string, number> | null;
  } = {}
): V3Lambdas | null {
  const L = v3LeaguePerTeamAvg(input.league, input.leagueId, opts.lakeBaselines);

  let method: V3Lambdas["method"] = "multiplicative";
  let rawH = multiplicativeLambda(input.homeScoredPer90, input.awayConcededPer90, L);
  let rawA = multiplicativeLambda(input.awayScoredPer90, input.homeConcededPer90, L);
  if (rawH === null || rawA === null) {
    method = "simple-average";
    rawH = simpleAverageLambda(input.homeScoredPer90, input.awayConcededPer90);
    rawA = simpleAverageLambda(input.awayScoredPer90, input.homeConcededPer90);
  }
  if (rawH === null || rawA === null) return null;

  // §8.2: match-day squad availability — applied before shrinkage so a
  // depleted squad's reduced λ still regresses toward the league mean under
  // small-sample noise exactly like any other raw λ.
  if (isRate(input.homeAvailabilityMult))
    rawH *= clamp(input.homeAvailabilityMult, AVAILABILITY_MULT_MIN, AVAILABILITY_MULT_MAX);
  if (isRate(input.awayAvailabilityMult))
    rawA *= clamp(input.awayAvailabilityMult, AVAILABILITY_MULT_MIN, AVAILABILITY_MULT_MAX);

  const shrunkH = shrink(rawH, input.nHome, L);
  const shrunkA = shrink(rawA, input.nAway, L);
  const shrunk = shrunkH !== rawH || shrunkA !== rawA;

  // Optional 50/50 xG blend (§3.1 refinement): xG-based λ through the same
  // multiplicative shape — home creation vs away concession and vice versa.
  // λ v5 (ORACLE_V3_LAMBDA_V5, default on): each side blends independently when
  // its cross-pair (own xgf × opponent xga) exists, instead of discarding all
  // xG unless BOTH sides have full pairs; the xG-λ gets the same small-sample
  // shrinkage as the goals-λ (per-match xG rates come from the same season
  // sample, so n<8 noise applies equally).
  let lH = shrunkH;
  let lA = shrunkA;
  let xgBlended = false;
  let xgBlendedSides: V3Lambdas["xgBlendedSides"];
  if (opts.xgBlend !== false) {
    const v5 = opts.lambdaV5 !== false;
    const xgHRaw = multiplicativeLambda(input.homeXg?.xgf, input.awayXg?.xga, L);
    const xgARaw = multiplicativeLambda(input.awayXg?.xgf, input.homeXg?.xga, L);
    const xgH = v5 && xgHRaw !== null ? shrink(xgHRaw, input.nHome, L) : xgHRaw;
    const xgA = v5 && xgARaw !== null ? shrink(xgARaw, input.nAway, L) : xgARaw;
    const blendH = xgH !== null && (v5 || xgA !== null);
    const blendA = xgA !== null && (v5 || xgH !== null);
    if (blendH) lH = (shrunkH + (xgH as number)) / 2;
    if (blendA) lA = (shrunkA + (xgA as number)) / 2;
    xgBlended = blendH || blendA;
    if (blendH && blendA) xgBlendedSides = "both";
    else if (blendH) xgBlendedSides = "home";
    else if (blendA) xgBlendedSides = "away";
  }

  // Home-field-advantage adjustment (§3.1a v4 delta): apply HFA multiplier only
  // when the input data is team-overall stats, not true venue-split data.
  let hfaApplied = false;
  const hfaMult = opts.hfa && !Number.isNaN(opts.hfa) ? opts.hfa : 1.0;
  if (hfaMult !== 1.0 && opts.venueSplitUsed !== true) {
    lH *= hfaMult;
    lA /= hfaMult;
    hfaApplied = true;
  }

  lH = clamp(lH, LAMBDA_MIN, LAMBDA_MAX);
  lA = clamp(lA, LAMBDA_MIN, LAMBDA_MAX);
  return {
    lambdaHome: lH,
    lambdaAway: lA,
    mu: lH + lA,
    method,
    shrunk,
    xgBlended,
    xgBlendedSides,
    leaguePerTeamAvg: L,
    hfaApplied,
  };
}
