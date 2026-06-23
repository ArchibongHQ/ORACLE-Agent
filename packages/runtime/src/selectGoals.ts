/** Goals-only accumulator selection — the second daily pipeline.
 *
 *  Layered on top of the full engine output: the engine already computes every
 *  goals market (Over 0.5/1.5/2.5/3.5, Team Total Over 0.5/1.5) with model
 *  probability (`mp`), implied prob (`ip`), and `rankingScore`. This module
 *  filters those down to the three allowed goals markets, applies a tiered data
 *  gate (strict for Over 2.5, lenient for Over 1.5 / Team Over 0.5), picks the
 *  single safest qualifying leg per fixture, and ranks legs into an accumulator
 *  capped at a target leg count (the cap is a ceiling, never a fill target).
 *
 *  Pure functions, unit-testable, no I/O beyond reading already-loaded data.
 */
import { copulaJointProbability, type PortfolioLeg } from "@oracle/engine";
import type { BatchJobResult, EVMarket } from "@oracle/engine";
import type { SportyBetEventDetail } from "./selectFixtures.js";
import { findSidecarDetail } from "./selectFixtures.js";

/** The only market labels (EVMarket.label) allowed in the goals accumulator.
 *  "Team Over 0.5" in the spec maps to the two team-total labels the engine emits. */
export const GOALS_MARKETS: ReadonlySet<string> = new Set([
  "Over 1.5",
  "Over 2.5",
  "Home Total Over 0.5",
  "Away Total Over 0.5",
]);

/** Cup / friendly / derby / low-signal exclusions. Cup ties and friendlies carry
 *  rotation risk; derbies are tactically tight and goals-suppressed. */
const _EXCLUDE_RE =
  /cup|copa|coupe|pokal|trophy|shield|supercup|friendly|test\s*match|derby|derbi|clasico|clásico/i;

/** Default per-leg thresholds — the single source of truth, also consumed by
 *  buildConfig() in env.ts so an .env-less run and a coded default never drift. */
export const DEFAULT_GOALS_MIN_CONFIDENCE = 0.72;
/** Implied-probability floor. Default 0 — disabled. A high implied prob means the
 *  market already agrees the leg is likely (short odds = no value), so gating on it
 *  filters *for* the bookmaker's confidence, which is backwards for an edge-seeking
 *  accumulator. Selection instead requires a positive model edge (mp > ip). Kept as
 *  an opt-in knob (set GOALS_MIN_IMPLIED) for callers who want a hard price floor. */
export const DEFAULT_GOALS_MIN_IMPLIED = 0;
export const DEFAULT_GOALS_TARGET_LEGS = 39;

export interface GoalsSelectOptions {
  /** Model-probability (`mp`) floor per leg. Default 0.72. */
  minConfidence?: number;
  /** Implied-probability (`ip` = 1/odds) floor per leg. Default 0.70. */
  minImplied?: number;
  /** Max legs in the accumulator — a CEILING, not a fill target. Default 39. */
  target?: number;
  /** Sidecar detail lookup by sidecarKey(home, away) — supplies the data gate. */
  detailByKey?: Map<string, SportyBetEventDetail>;
}

export interface GoalsLeg {
  home: string;
  away: string;
  league: string;
  kickoff: string;
  /** EVMarket.cat — e.g. "Goals O/U" or "Team Total". */
  market: string;
  /** EVMarket.label — one of GOALS_MARKETS. */
  side: string;
  odds: number;
  /** Model probability (safest-leg ranking key). */
  mp: number;
  /** Implied probability (1/odds). */
  ip: number;
}

export interface GoalsSelectionResult {
  legs: GoalsLeg[];
  /** Short-slip selection: top 4–8 legs by mp (honest win-probability slip). */
  shortSlipLegs: GoalsLeg[];
  target: number;
  analysed: number;
  /** Fixtures with ≥1 qualifying leg before the target cap was applied. */
  qualified: number;
  counts: { over15: number; over25: number; teamOver05: number };
  /** Correlation-adjusted joint probability for the full slip (Gaussian-copula
   *  cross-fixture correlation — see @oracle/engine's copulaJointProbability). */
  combinedProb: number;
  /** Combined decimal odds for the full slip (product of leg odds). */
  combinedOdds: number;
  /** Same for the short-slip (4–8 legs). */
  shortSlipCombinedProb: number;
  shortSlipCombinedOdds: number;
}

type Side = "home" | "away";

/** Per-team average goals scored. Prefer an explicit goals.avg_scored; when the
 *  scraper only provides league-table standings (gf/played) — the common case for
 *  lower divisions — derive scored = gf / played. Returns null when neither exists. */
function avgScored(detail: SportyBetEventDetail | undefined, side: Side): number | null {
  const direct = detail?.stats?.goals?.[side]?.avg_scored;
  if (typeof direct === "number" && direct > 0) return direct;
  const st = detail?.stats?.standings?.[side];
  if (st && typeof st.gf === "number" && typeof st.played === "number" && st.played > 0) {
    return st.gf / st.played;
  }
  return null;
}

/** Per-team average goals conceded. Prefer goals.avg_conceded; otherwise derive
 *  ga / played from standings. Returns null when neither exists. */
function avgConceded(detail: SportyBetEventDetail | undefined, side: Side): number | null {
  const direct = detail?.stats?.goals?.[side]?.avg_conceded;
  if (typeof direct === "number" && direct >= 0) return direct;
  const st = detail?.stats?.standings?.[side];
  if (st && typeof st.ga === "number" && typeof st.played === "number" && st.played > 0) {
    return st.ga / st.played;
  }
  return null;
}

/** True when at least one team has a usable scoring signal (explicit goals
 *  average or standings-derived gf/played) — the lenient-tier minimum. */
function hasAnyGoalsSignal(detail: SportyBetEventDetail | undefined): boolean {
  const h = avgScored(detail, "home");
  const a = avgScored(detail, "away");
  return (h !== null && h > 0) || (a !== null && a > 0);
}

/** A team has a usable defensive figure when a conceded average exists (explicit
 *  or standings-derived) OR the league table simply carries a goals-against count. */
function hasDefenceFigure(detail: SportyBetEventDetail | undefined, side: Side): boolean {
  if (avgConceded(detail, side) !== null) return true;
  const ga = detail?.stats?.standings?.[side]?.ga;
  return typeof ga === "number" && ga >= 0;
}

/** True when BOTH teams have a scoring average AND a conceded/defensive figure —
 *  the strict-tier requirement for Over 2.5 (needs goals from both sides). */
function hasBothTeamsGoalsAndDefence(detail: SportyBetEventDetail | undefined): boolean {
  const homeScored = avgScored(detail, "home");
  const awayScored = avgScored(detail, "away");
  if (homeScored === null || homeScored <= 0 || awayScored === null || awayScored <= 0) {
    return false;
  }
  return hasDefenceFigure(detail, "home") && hasDefenceFigure(detail, "away");
}

/** Tiered data gate. Returns true when the fixture's data supports `market`.
 *  - Always rejects cup/friendly/derby/low-signal leagues.
 *  - Over 2.5: strict — both teams need last-5 goals + a defensive figure.
 *  - Over 1.5 / Team Over 0.5: lenient — any single-team goals signal suffices.
 */
export function goalsDataGate(
  detail: SportyBetEventDetail | undefined,
  league: string,
  market: string
): boolean {
  if (!GOALS_MARKETS.has(market)) return false;
  if (_EXCLUDE_RE.test(league)) return false;
  if (market === "Over 2.5") return hasBothTeamsGoalsAndDefence(detail);
  // Over 1.5 / Home Total Over 0.5 / Away Total Over 0.5 — lenient tier.
  return hasAnyGoalsSignal(detail);
}

/** From a successful batch job, return the single safest qualifying goals leg
 *  (highest `mp` among the allowed markets that pass the data gate and clear the
 *  confidence + implied-prob bars). Returns null if none qualify or job errored. */
export function pickSafestGoalsLeg(
  job: BatchJobResult,
  opts: GoalsSelectOptions = {}
): GoalsLeg | null {
  if (job.status !== "ok") return null;
  const minConfidence = opts.minConfidence ?? DEFAULT_GOALS_MIN_CONFIDENCE;
  const minImplied = opts.minImplied ?? DEFAULT_GOALS_MIN_IMPLIED;
  const detail = findSidecarDetail(opts.detailByKey, job.home, job.away);

  const all = job.result.evMarkets ?? [];
  const sGoals = all.filter((m: EVMarket) => GOALS_MARKETS.has(m.label));
  const sVeto = sGoals.filter((m: EVMarket) => !m.veto);
  // Confidence floor + positive model edge (mp > ip). The implied floor is opt-in
  // (default 0) — see DEFAULT_GOALS_MIN_IMPLIED for why a hard price floor is off.
  const sBars = sVeto.filter(
    (m: EVMarket) => m.mp >= minConfidence && m.mp > m.ip && m.ip >= minImplied
  );
  const candidates = sBars.filter((m: EVMarket) => goalsDataGate(detail, job.league, m.label));

  if (process.env.ORACLE_DEBUG_GOALS === "1") {
    process.stderr.write(
      `[debug-goals] ${job.home} v ${job.away} | ev=${all.length} goalsMkt=${sGoals.length} ` +
        `postVeto=${sVeto.length} postBars=${sBars.length} postGate=${candidates.length} ` +
        `detail=${detail ? "Y" : "N"} ` +
        `topMp=${sGoals.length ? Math.max(...sGoals.map((m) => m.mp)).toFixed(2) : "-"}\n`
    );
  }

  if (candidates.length === 0) return null;
  // Safest = highest model probability.
  const best = candidates.reduce((a, b) => (b.mp > a.mp ? b : a));
  return {
    home: job.home,
    away: job.away,
    league: job.league,
    kickoff: job.kickoff,
    market: best.cat,
    side: best.label,
    odds: best.odds,
    mp: best.mp,
    ip: best.ip,
  };
}

/** Maps a GoalsLeg to the engine's cross-fixture-correlation input shape. */
function toPortfolioLeg(leg: GoalsLeg): PortfolioLeg {
  return {
    home: leg.home,
    away: leg.away,
    league: leg.league,
    market: leg.side,
    mp: leg.mp,
    kickoff: leg.kickoff,
  };
}

/** Joint probability via the Gaussian-copula cross-fixture correlation model
 *  (@oracle/engine's copulaJointProbability — same-league + same-kickoff-window
 *  legs get a positive correlation bump over the naive independence product). */
function jointProb(legs: GoalsLeg[]): number {
  return copulaJointProbability(legs.map(toPortfolioLeg));
}

/** Select the goals accumulator: one safest leg per qualifying fixture, ranked
 *  by model confidence descending, capped at `target` legs (a ceiling — fewer
 *  legs when fewer qualify; the threshold is never relaxed to force `target`).
 *
 *  Also surfaces a short-slip (4–8 legs) with honest joint probability so callers
 *  can see the true win probability before stacking 39 legs. */
export function selectGoalsAccumulator(
  jobs: BatchJobResult[],
  opts: GoalsSelectOptions = {}
): GoalsSelectionResult {
  const target = opts.target ?? DEFAULT_GOALS_TARGET_LEGS;
  const SHORT_SLIP_MIN = 4;
  const SHORT_SLIP_MAX = 8;

  const all: GoalsLeg[] = [];
  for (const job of jobs) {
    const leg = pickSafestGoalsLeg(job, opts);
    if (leg) all.push(leg);
  }
  all.sort((a, b) => b.mp - a.mp);

  const legs = all.slice(0, Math.max(0, target));
  const shortSlipLegs = all.slice(
    0,
    Math.min(SHORT_SLIP_MAX, Math.max(SHORT_SLIP_MIN, all.length))
  );

  const counts = { over15: 0, over25: 0, teamOver05: 0 };
  for (const l of legs) {
    if (l.side === "Over 1.5") counts.over15 += 1;
    else if (l.side === "Over 2.5") counts.over25 += 1;
    else counts.teamOver05 += 1;
  }

  const combinedProb = jointProb(legs);
  const combinedOdds = legs.reduce((acc, l) => acc * l.odds, 1);
  const shortSlipCombinedProb = jointProb(shortSlipLegs);
  const shortSlipCombinedOdds = shortSlipLegs.reduce((acc, l) => acc * l.odds, 1);

  return {
    legs,
    shortSlipLegs,
    target,
    analysed: jobs.length,
    qualified: all.length,
    counts,
    combinedProb,
    combinedOdds,
    shortSlipCombinedProb,
    shortSlipCombinedOdds,
  };
}
