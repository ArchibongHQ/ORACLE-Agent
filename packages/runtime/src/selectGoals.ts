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
import type { BatchJobResult, EVMarket } from "@oracle/engine";
import type { SportyBetEventDetail } from "./selectFixtures.js";
import { sidecarKey } from "./selectFixtures.js";

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

const DEFAULT_MIN_CONFIDENCE = 0.75;
const DEFAULT_MIN_IMPLIED = 0.7;
const DEFAULT_TARGET_LEGS = 39;

export interface GoalsSelectOptions {
  /** Model-probability (`mp`) floor per leg. Default 0.75. */
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
  target: number;
  analysed: number;
  /** Fixtures with ≥1 qualifying leg before the target cap was applied. */
  qualified: number;
  counts: { over15: number; over25: number; teamOver05: number };
}

/** True when at least one team has parseable last-5 goal data (form last5 or
 *  a non-zero scoring average) — the lenient-tier minimum signal. */
function hasAnyGoalsSignal(detail: SportyBetEventDetail | undefined): boolean {
  const g = detail?.stats?.goals;
  if (!g) return false;
  const h = g.home;
  const a = g.away;
  const hScored = typeof h?.avg_scored === "number" && h.avg_scored > 0;
  const aScored = typeof a?.avg_scored === "number" && a.avg_scored > 0;
  return hScored || aScored;
}

/** True when BOTH teams have a scoring average AND a conceded/defensive figure —
 *  the strict-tier requirement for Over 2.5 (needs goals from both sides). */
function hasBothTeamsGoalsAndDefence(detail: SportyBetEventDetail | undefined): boolean {
  const g = detail?.stats?.goals;
  const s = detail?.stats?.standings;
  if (!g) return false;
  const homeScored = typeof g.home?.avg_scored === "number" && g.home.avg_scored > 0;
  const awayScored = typeof g.away?.avg_scored === "number" && g.away.avg_scored > 0;
  if (!homeScored || !awayScored) return false;
  // Defensive figure: per-team conceded average OR league-table goals-against.
  const homeDef =
    (typeof g.home?.avg_conceded === "number" && g.home.avg_conceded >= 0) ||
    (typeof s?.home?.ga === "number" && s.home.ga >= 0);
  const awayDef =
    (typeof g.away?.avg_conceded === "number" && g.away.avg_conceded >= 0) ||
    (typeof s?.away?.ga === "number" && s.away.ga >= 0);
  return homeDef && awayDef;
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
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const minImplied = opts.minImplied ?? DEFAULT_MIN_IMPLIED;
  const detail = opts.detailByKey?.get(sidecarKey(job.home, job.away));

  const candidates = (job.result.evMarkets ?? [])
    .filter((m: EVMarket) => GOALS_MARKETS.has(m.label))
    .filter((m: EVMarket) => !m.veto)
    .filter((m: EVMarket) => m.mp >= minConfidence && m.ip >= minImplied)
    .filter((m: EVMarket) => goalsDataGate(detail, job.league, m.label));

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

/** Select the goals accumulator: one safest leg per qualifying fixture, ranked
 *  by model confidence descending, capped at `target` legs (a ceiling — fewer
 *  legs when fewer qualify; the threshold is never relaxed to force `target`). */
export function selectGoalsAccumulator(
  jobs: BatchJobResult[],
  opts: GoalsSelectOptions = {}
): GoalsSelectionResult {
  const target = opts.target ?? DEFAULT_TARGET_LEGS;
  const all: GoalsLeg[] = [];
  for (const job of jobs) {
    const leg = pickSafestGoalsLeg(job, opts);
    if (leg) all.push(leg);
  }
  all.sort((a, b) => b.mp - a.mp);
  const legs = all.slice(0, Math.max(0, target));
  const counts = { over15: 0, over25: 0, teamOver05: 0 };
  for (const l of legs) {
    if (l.side === "Over 1.5") counts.over15 += 1;
    else if (l.side === "Over 2.5") counts.over25 += 1;
    else counts.teamOver05 += 1;
  }
  return {
    legs,
    target,
    analysed: jobs.length,
    qualified: all.length,
    counts,
  };
}
