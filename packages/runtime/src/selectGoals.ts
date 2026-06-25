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
import {
  copulaJointProbability,
  type PortfolioLeg,
  pairwiseCrossFixtureCorrelation,
  selectPortfolioCombos,
} from "@oracle/engine";
import type { SportyBetEventDetail } from "./selectFixtures.js";
import { findSidecarDetail, sidecarKey } from "./selectFixtures.js";

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

/** International tournaments + goals-rich domestic cups — checked BEFORE _EXCLUDE_RE.
 *  The bare "cup"/"copa" substrings in _EXCLUDE_RE target domestic knockout ties
 *  (rotation risk, tight knockout mentality) but also match:
 *    • "World Cup"/"Asian Cup"/etc — no rotation risk (full-strength squads)
 *    • "Copa Chile"/"Copa Venezuela" — explicitly added to GOALS_RICH_LEAGUES for
 *      their historically high goal counts in early rounds (3.5+ gpg); excluding
 *      them via the copa substring would contradict the Tier A designation.
 *  The "euro" alternative requires "european championship" or a year so a bare
 *  /euro/i doesn't also match "Euro Friendly Cup" / "EuroLeague Youth Friendly". */
const _INTL_TOURNAMENT_RE =
  /world\s*cup|euro(?:pean\s*championship)|uefa\s*euro\s*20\d{2}|euro\s*20\d{2}|copa\s*am[ée]rica|copa\s*chile|copa\s*venezuela|nations\s*league|africa(?:n)?\s*cup\s*of\s*nations|afcon|asian\s*cup|gold\s*cup|concacaf/i;

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

/** Minimum model-over-market edge (mp − ip) required for a leg to enter any slip.
 *  Tightens the existing mp > ip requirement: a 3% edge is not a bet worth placing
 *  in an accumulator context where compounding errors cost more than the small edge
 *  recovers. 5% is a well-established minimum for positive-expectation sports betting
 *  (Shin 1991; Stöckl et al. 2014). */
export const MIN_GOALS_EDGE = 0.05;

export interface GoalsSelectOptions {
  /** Model-probability (`mp`) floor per leg. Default 0.72. */
  minConfidence?: number;
  /** Implied-probability (`ip` = 1/odds) floor per leg. Default 0.70. */
  minImplied?: number;
  /** Max legs in the accumulator — a CEILING, not a fill target. Default 39. */
  target?: number;
  /** Sidecar detail lookup by sidecarKey(home, away) — supplies the data gate. */
  detailByKey?: Map<string, SportyBetEventDetail>;
  /** SportyBet/Sportradar event ID keyed by sidecarKey(home, away). Injected by
   *  the worker so the booking agent can navigate directly to the fixture detail
   *  page without scanning the paginated listing DOM. */
  eventIdByKey?: Map<string, string>;
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
  /** Model edge: mp − ip. Always ≥ MIN_GOALS_EDGE for admitted legs. */
  edge: number;
  /** SportyBet / Sportradar event ID (e.g. "sr:match:66456926") — used by the
   *  booking agent to navigate directly to the fixture detail page, bypassing
   *  the listing-page scroll that only shows fixtures visible in the DOM. */
  eventId?: string;
}

export interface GoalsSelectionResult {
  /** Long ("lottery") slip — greedy correlation-aware selection, capped at `target`. */
  legs: GoalsLeg[];
  /** Short ("top picks") slip — EV-maximizing combinatorial search, normally
   *  4–9 legs; flexes past 9 when ≥10 candidates beyond the ceiling clear the
   *  high-confidence bar (see SHORT_SLIP_HIGH_CONFIDENCE_MP/SHORT_SLIP_FLEX_TRIGGER). */
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
  /** Same for the short slip. */
  shortSlipCombinedProb: number;
  shortSlipCombinedOdds: number;
  /** Output B — top 5 legs with decimal odds ≥ 4.00, ranked by edge descending. */
  outputBLegs: GoalsLeg[];
  /** Output C — top 3 legs with 2.50 ≤ odds < 4.00, ranked by edge descending. */
  outputCLegs: GoalsLeg[];
  /** Mini-ACCA — 2–4 highest-edge legs from strictly distinct leagues (no league repeat).
   *  Intended as the lowest-correlation, highest-confidence same-day combo. */
  miniAccaLegs: GoalsLeg[];
  /** Naive joint probability for the mini-ACCA (product of mp values — no copula
   *  correction; mini-ACCA is defined to be low-correlation by construction). */
  miniAccaCombinedProb: number;
  /** Combined decimal odds for the mini-ACCA (product of leg odds). */
  miniAccaCombinedOdds: number;
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
  if (!_INTL_TOURNAMENT_RE.test(league) && _EXCLUDE_RE.test(league)) return false;
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
  // eventId resolution, tolerant in the same way findSidecarDetail is:
  //   1. Prefer the matched detail's own eventId — findSidecarDetail already does
  //      fuzzy name matching (regional suffixes etc.), so when the exact sidecarKey
  //      misses, this still recovers the right event. This is the fix for booking
  //      "no eventId" skips, where engine-normalised names (e.g. "Cuiaba Esporte
  //      Clube MT") didn't exact-match the sidecar key in eventIdByKey.
  //   2. Fall back to the exact-key map (covers the case where detailByKey wasn't
  //      supplied but eventIdByKey was).
  const eventId = detail?.eventId ?? opts.eventIdByKey?.get(sidecarKey(job.home, job.away));

  const all = job.result.evMarkets ?? [];
  const sGoals = all.filter((m: EVMarket) => GOALS_MARKETS.has(m.label));
  const sVeto = sGoals.filter((m: EVMarket) => !m.veto);
  // Confidence floor + minimum 5% model edge (mp − ip ≥ MIN_GOALS_EDGE). The
  // implied floor is opt-in (default 0) — see DEFAULT_GOALS_MIN_IMPLIED for why a
  // hard price floor is off. MIN_GOALS_EDGE supersedes the old `mp > ip` check.
  const sBars = sVeto.filter(
    (m: EVMarket) =>
      m.mp >= minConfidence && m.mp - m.ip >= MIN_GOALS_EDGE - 1e-9 && m.ip >= minImplied
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
    edge: best.mp - best.ip,
    ...(eventId ? { eventId } : {}),
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

/** Cross-fixture correlation reject threshold for the long slip.
 *  pairwiseCrossFixtureCorrelation only ever produces one of three values: 0
 *  (different league, no shared kickoff window), SAME_LEAGUE_RHO=0.25 (same
 *  league only), or 0.25+SAME_WINDOW_BONUS=0.35 (same league AND within a 3h
 *  kickoff window — math/index.ts). Same-league coverage on a given matchday is
 *  normal and expected for a goals slip (most leagues play their full round on
 *  1-2 days) — rejecting at the 0.25 tier would gut ordinary slips. The bar sits
 *  between the two tiers so only the tighter same-league+same-kickoff-window
 *  stacking (0.35) gets capped — legs that share both a league AND a near-
 *  simultaneous kickoff carry the most genuinely shared risk (same officiating
 *  climate, same weather front, same matchday narrative). */
export const CROSS_FIXTURE_CORRELATION_REJECT = 0.3;

/** Greedily builds a correlation-aware leg list: walks the mp-ranked candidate
 *  pool and admits each leg unless its correlation with every already-admitted
 *  leg from a DIFFERENT fixture exceeds the reject threshold — never combines
 *  legs from the same fixture (the data gate already enforces one leg per
 *  fixture upstream) and never lets a slip silently overstack one correlated
 *  cluster. A full combinatorial search (selectPortfolioCombos) is infeasible
 *  at this scale (up to 39 legs from a 100+ candidate pool) — greedy admission
 *  is the tractable approximation; the short slip below uses the exact search
 *  instead, since its candidate pool is small enough to afford it. */
function greedyCorrelationAwareSelect(ranked: GoalsLeg[], cap: number): GoalsLeg[] {
  const admitted: GoalsLeg[] = [];
  for (const candidate of ranked) {
    if (admitted.length >= cap) break;
    const candidatePortfolioLeg = toPortfolioLeg(candidate);
    const tooCorrelated = admitted.some(
      (a) =>
        pairwiseCrossFixtureCorrelation(candidatePortfolioLeg, toPortfolioLeg(a)) >
        CROSS_FIXTURE_CORRELATION_REJECT
    );
    if (!tooCorrelated) admitted.push(candidate);
  }
  return admitted;
}

/** Combinatorial-search shortlist size fed to selectPortfolioCombos — its own
 *  docstring caps feasible input at ~15 candidates (combinations explode past
 *  that). Pre-rank by mp and slice before calling it. */
const SHORT_SLIP_SEARCH_POOL = 15;

/** Builds the short slip. When `maxLegs` fits within the combinatorial search's
 *  feasible ceiling (SHORT_SLIP_SEARCH_POOL — selectPortfolioCombos's own
 *  docstring caps feasible input at ~15 candidates, since combinations explode
 *  past that), runs the engine's EV-maximizing exact search over the top
 *  candidates by mp. When flex-sizing (see selectGoalsAccumulator) pushes
 *  maxLegs beyond that ceiling, the exact search is no longer tractable —
 *  falls back to the same greedy correlation-aware admission the long slip
 *  uses, over the (larger) flexed candidate pool. Per owner instruction:
 *  "consideration can be made to add more if 10 or more other fixtures surface
 *  data-backed, fact-checked, high confidence, undeniable goals opportunities" —
 *  the flex path honors that even past the exact-search's feasible size.
 *  Falls back to a plain top-N slice when the exact search finds no positive-EV
 *  combo (e.g. pool too thin) — never returns fewer legs than the data honestly
 *  supports. */
function buildShortSlip(ranked: GoalsLeg[], maxLegs: number): GoalsLeg[] {
  if (maxLegs > SHORT_SLIP_SEARCH_POOL) {
    return greedyCorrelationAwareSelect(ranked, maxLegs);
  }
  const pool = ranked.slice(0, SHORT_SLIP_SEARCH_POOL);
  if (pool.length === 0) return [];
  const minLegs = Math.min(SHORT_SLIP_MIN, pool.length);
  const shortlist = pool.map(toPortfolioLeg);
  const oddsByLeg = pool.map((l) => l.odds);
  const best = selectPortfolioCombos(shortlist, oddsByLeg, minLegs, Math.min(maxLegs, pool.length));
  if (!best || best.ev <= 0) {
    return pool.slice(0, Math.min(maxLegs, Math.max(SHORT_SLIP_MIN, pool.length)));
  }
  const comboKeys = new Set(best.combo.map((l) => `${l.home}|${l.away}`));
  return pool.filter((l) => comboKeys.has(`${l.home}|${l.away}`));
}

/** Greedily picks the highest-edge legs with no league repeat — used for the
 *  mini-ACCA where strict cross-league independence is the primary requirement.
 *  Legs must already be sorted by descending edge before calling this. */
function forceDiverseLeaguesSlice(byEdge: GoalsLeg[], maxLegs: number): GoalsLeg[] {
  const seen = new Set<string>();
  const result: GoalsLeg[] = [];
  for (const leg of byEdge) {
    if (result.length >= maxLegs) break;
    if (!seen.has(leg.league)) {
      seen.add(leg.league);
      result.push(leg);
    }
  }
  return result;
}

const SHORT_SLIP_MIN = 4;
const SHORT_SLIP_MAX = 9;
/** A leg clearing this mp bar counts as "data-backed, fact-checked, high
 *  confidence, undeniable" for short-slip flex-sizing purposes — comfortably
 *  above the general DEFAULT_GOALS_MIN_CONFIDENCE floor (0.72) used for the
 *  long slip, since the short slip is meant to be the higher-bar pick set. */
const SHORT_SLIP_HIGH_CONFIDENCE_MP = 0.82;
/** Minimum count of high-confidence candidates (beyond SHORT_SLIP_MAX) required
 *  before the short slip is allowed to flex upward past its normal ceiling. */
const SHORT_SLIP_FLEX_TRIGGER = 10;

/** Select the goals accumulator: one safest leg per qualifying fixture, then
 *  two correlation-aware slips are cut from the ranked pool —
 *
 *  - Long slip (`legs`): greedy correlation-aware admission, capped at `target`
 *    (default 39, a ceiling never a fill target).
 *  - Short slip (`shortSlipLegs`): EV-maximizing combinatorial search
 *    (selectPortfolioCombos) over the top-ranked candidates, normally 4–9 legs.
 *    Flexes past 9 when ≥10 candidates beyond the normal ceiling clear a high
 *    confidence bar (SHORT_SLIP_HIGH_CONFIDENCE_MP) — per owner instruction,
 *    this is still a separate, smaller, higher-bar slip from the 39-leg one. */
export function selectGoalsAccumulator(
  jobs: BatchJobResult[],
  opts: GoalsSelectOptions = {}
): GoalsSelectionResult {
  const target = opts.target ?? DEFAULT_GOALS_TARGET_LEGS;

  const all: GoalsLeg[] = [];
  for (const job of jobs) {
    const leg = pickSafestGoalsLeg(job, opts);
    if (leg) all.push(leg);
  }
  all.sort((a, b) => b.mp - a.mp);

  const legs = greedyCorrelationAwareSelect(all, Math.max(0, target));

  const highConfidenceCount = all.filter((l) => l.mp >= SHORT_SLIP_HIGH_CONFIDENCE_MP).length;
  // Flex cap is bounded by `target` (the long/lottery slip's own ceiling) —
  // the short ("top picks") slip must never exceed the long slip's size, or
  // the two slips' naming/relative-confidence framing inverts.
  const shortSlipCap =
    highConfidenceCount >= SHORT_SLIP_MAX + SHORT_SLIP_FLEX_TRIGGER
      ? Math.min(highConfidenceCount, Math.max(0, target))
      : SHORT_SLIP_MAX;
  const shortSlipLegs = buildShortSlip(all, shortSlipCap);

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

  // ── Three derived outputs (edge-ranked) ───────────────────────────────────
  // Sort all qualified legs by edge descending (edge = mp − ip, populated above).
  const allByEdge = [...all].sort((a, b) => b.edge - a.edge);

  // Output B: high-value legs (odds ≥ 4.00), top 5 by edge.
  const outputBLegs = allByEdge.filter((l) => l.odds >= 4.0).slice(0, 5);

  // Output C: mid-range legs (2.50 ≤ odds < 4.00), top 3 by edge.
  const outputCLegs = allByEdge.filter((l) => l.odds >= 2.5 && l.odds < 4.0).slice(0, 3);

  // Mini-ACCA: 2–4 highest-edge legs, one per league (strict diversity).
  const miniAccaLegs = forceDiverseLeaguesSlice(allByEdge, 4);
  // Naive joint probability (product of mp) — mini-ACCA is cross-league by
  // construction so copula correction is negligible (rho ≈ 0 between leagues).
  const miniAccaCombinedProb = miniAccaLegs.reduce((acc, l) => acc * l.mp, 1);
  const miniAccaCombinedOdds = miniAccaLegs.reduce((acc, l) => acc * l.odds, 1);

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
    outputBLegs,
    outputCLegs,
    miniAccaLegs,
    miniAccaCombinedProb,
    miniAccaCombinedOdds,
  };
}
