/** all-markets-analysis-prompt-v3 Phase 7/8 — slate-level portfolio outputs
 *  and batch status reporting.
 *
 *  Operates on a SLATE (many fixtures), each already reduced to its single
 *  best surviving selection per §4.3 ("only the fixture's single best
 *  surviving selection... advances to the portfolio") — that per-fixture
 *  reduction is the caller's job (pick the "done" assessment with the
 *  highest adjustedEdge out of one fixture's V3AllMarketsResult.assessments);
 *  this module is purely the cross-fixture ranking/bucketing/reporting logic.
 *
 *  Pure, synchronous, no I/O. */

import { CLASS_ORDER, type V3MarketClass } from "./classes.js";
import type { V3Confidence } from "./evGate.js";

/** The subset of V3MarketOutcomeAssessment the output builders actually read.
 *  Narrower than the full assessment so callers that only carry a compact
 *  per-fixture projection through BatchResult (the daily batch, which can't
 *  cheaply retain every raw assessment for a whole day's fixtures) don't need
 *  to reconstruct fields (family/marketId/outcomeId) nothing here uses. */
export interface V3OutputCandidate {
  marketName: string;
  desc: string;
  cls: V3MarketClass;
  mp: number;
  odds: number;
  q: number;
  rawEdge: number;
  penaltyPts: number;
  adjustedEdge: number;
  adjEvPct: number;
  confidence: V3Confidence | null;
}

export interface V3SlateFixture {
  fixtureId: string;
  home: string;
  away: string;
  league: string;
  /** ISO-8601 kickoff — used for the §7 tie-break (earlier kickoff wins). */
  kickoff: string;
  /** This fixture's single best surviving selection (§4.3), or null when
   *  nothing cleared the gate for this fixture — a valid, common outcome. */
  best: V3OutputCandidate | null;
}

/** [Phase 2, two-tier slate] Delivery-shaped projection of a candidate —
 *  extends V3OutputCandidate (the pure ranking-row shape) with the fields
 *  the DELIVERED slate needs that pure ranking never did: which fixture it
 *  belongs to (unlike V3OutputCandidate, which stays fixture-agnostic for
 *  the batch's compact per-fixture carry, this type is already
 *  fixture-attributed at construction — batch/index.ts has `job.home`/
 *  `away`/`league`/`kickoff` on hand right where it builds these), which
 *  real market family it books under, its actual Kelly stake (sourced from
 *  the canonical staker, v3AssessmentsToEvMarkets — never re-derived here),
 *  why a watchlist row didn't qualify, its trap-flag warning line, and
 *  whether its pricing basis was venue-split or the §2.5.4 overall-basis
 *  fallback ("°"-labeled). Never used to gate anything — the ev>0 floor and
 *  the capped/noise invariants are enforced upstream, before a candidate is
 *  eligible to become either a V3OutputCandidate or a V3DeliveryCandidate. */
export interface V3DeliveryCandidate extends V3OutputCandidate {
  fixtureId: string;
  home: string;
  away: string;
  league: string;
  /** ISO-8601 kickoff — used for the §7 tie-break (earlier kickoff wins),
   *  same field compareRows/compareDeliveryRows already read off V3OutputRow. */
  kickoff: string;
  family: string;
  /** Real Kelly stake (%), sourced from v3AssessmentsToEvMarkets — the
   *  canonical staker. Never 0.0% by construction (fixes the Wave-4-era
   *  0.0%-Kelly delivery bug for the pattern-aware two-tier pool). */
  stakePct: number;
  /** Present ONLY on Tier② (watchlist) rows — human-readable reason this
   *  candidate didn't clear the gate (e.g. "class_edge", "ev_floor",
   *  "capped", "noise"). Absent on every Tier① (qualified) row. */
  shortfall?: string;
  /** Mandatory per-pick trap warning (v6.2 §5.9) — "no contradicting signal
   *  detected" when no trap fired, per the plan's design decision 5 (field
   *  stays mandatory even when there's nothing to warn about). */
  trapWarning: string;
  /** "venue" (default, no label) or "overall°" (§2.5.4 fallback — per-90
   *  rates exist but the venue split doesn't; tightened thresholds, no
   *  confidence uplift). Wired fully in Phase 3; Phase 2 always emits
   *  "venue" until that lands (byte-identical placeholder, not a lie —
   *  today's pattern engine only ever runs on venue-split data, since
   *  buildFixturePatternInput still null-returns on a missing split). */
  basisLabel: "venue" | "overall°";
  /** [patterns-engine Wave 2] The detector's 0-1 fixture pattern strength,
   *  carried through from V3AllMarketsAssessment.patternStrength when this
   *  candidate was pattern-backed — feeds compareDeliveryRows' pattern-first
   *  tie-break below. Absent (not 0) when the candidate wasn't pattern-backed
   *  at all, distinguishing "no pattern" from "pattern with zero strength". */
  patternStrength?: number;
}

export interface V3OutputRow {
  fixtureId: string;
  home: string;
  away: string;
  league: string;
  kickoff: string;
  marketName: string;
  desc: string;
  cls: V3MarketClass;
  mp: number;
  odds: number;
  q: number;
  rawEdge: number;
  penaltyPts: number;
  adjustedEdge: number;
  adjEvPct: number;
  confidence: V3Confidence | null;
}

function toRow(fixture: V3SlateFixture, a: V3OutputCandidate): V3OutputRow {
  return {
    fixtureId: fixture.fixtureId,
    home: fixture.home,
    away: fixture.away,
    league: fixture.league,
    kickoff: fixture.kickoff,
    marketName: a.marketName,
    desc: a.desc,
    cls: a.cls,
    mp: a.mp,
    odds: a.odds,
    q: a.q,
    rawEdge: a.rawEdge,
    penaltyPts: a.penaltyPts,
    adjustedEdge: a.adjustedEdge,
    adjEvPct: a.adjEvPct,
    confidence: a.confidence,
  };
}

/** §7 tie-break: equal Adjusted Edge → lower-variance class wins (S>M>L>X) →
 *  higher Model P → earlier kickoff. */
function compareRows(a: V3OutputRow, b: V3OutputRow): number {
  if (b.adjustedEdge !== a.adjustedEdge) return b.adjustedEdge - a.adjustedEdge;
  const classDelta = CLASS_ORDER[a.cls] - CLASS_ORDER[b.cls];
  if (classDelta !== 0) return classDelta;
  if (b.mp !== a.mp) return b.mp - a.mp;
  return new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime();
}

/** Reduce a slate to its ranked, gate-surviving pool — the shared source
 *  every Output A/C/D below reads from (spec's "gate-surviving pool"). One
 *  row per fixture, sorted best-first by the §7 tie-break. */
export function buildGateSurvivingPool(fixtures: V3SlateFixture[]): V3OutputRow[] {
  const rows = fixtures
    .filter((f): f is V3SlateFixture & { best: V3OutputCandidate } => f.best !== null)
    .map((f) => toRow(f, f.best));
  return rows.sort(compareRows);
}

/** [Phase 2, two-tier slate] Pattern-first tie-break, owner-directed
 *  2026-07-18: within a tier, pattern-backed rows sort FIRST (by
 *  patternStrength descending, then adjustedEdge), non-pattern rows follow,
 *  ranked by the existing §7 tie-break. EV/edge machinery stays a guide —
 *  never an override of a pattern-backed pick — but never a floor override
 *  either: this function is ONLY ever called on candidates that already
 *  cleared the ev>0 floor and the capped/noise invariants upstream; it has
 *  no way to admit or reject a candidate, only to order ones already
 *  admitted. */
export function compareDeliveryRows<T extends V3OutputRow & { patternStrength?: number }>(
  a: T,
  b: T
): number {
  const aBacked = (a.patternStrength ?? 0) > 0;
  const bBacked = (b.patternStrength ?? 0) > 0;
  if (aBacked !== bBacked) return aBacked ? -1 : 1;
  if (aBacked && bBacked && b.patternStrength !== a.patternStrength) {
    return (b.patternStrength ?? 0) - (a.patternStrength ?? 0);
  }
  return compareRows(a, b);
}

export const OUTPUT_A_MAX = 39;

/** Output A — the headline Top-39 table, max 1 per fixture (enforced by the
 *  pool reduction itself), ranked by Adjusted Edge, capped at 39 rows. */
export function buildOutputA(pool: V3OutputRow[]): V3OutputRow[] {
  return pool.slice(0, OUTPUT_A_MAX);
}

export const MINI_ACCA_MIN_LEGS = 2;
export const MINI_ACCA_MAX_LEGS = 4;
export const MINI_ACCA_HAIRCUT = 0.85;
export const BEST_SINGLES_MAX = 3;

export interface V3OutputB {
  miniAcca: V3OutputRow[];
  /** Combined P ≈ (Π P_model) × 0.85, per spec §7. 0 when miniAcca is empty. */
  miniAccaCombinedP: number;
  bestSingles: V3OutputRow[];
}

/** Output B — mini-ACCA (2-4 legs from Output A, different fixtures
 *  guaranteed by the pool's 1-per-fixture rule, different leagues/kickoff
 *  windows where possible, Class S/M preferred) + best singles (up to 3). */
export function buildOutputB(outputA: V3OutputRow[]): V3OutputB {
  const preferred = outputA.filter((r) => r.cls === "S" || r.cls === "M");
  const candidatePool = preferred.length >= MINI_ACCA_MIN_LEGS ? preferred : outputA;

  const legs: V3OutputRow[] = [];
  const usedLeagues = new Set<string>();
  for (const row of candidatePool) {
    if (legs.length >= MINI_ACCA_MAX_LEGS) break;
    if (usedLeagues.has(row.league)) continue; // prefer league diversity first pass
    legs.push(row);
    usedLeagues.add(row.league);
  }
  // Backfill (allowing repeat leagues) if diversity-first left us short of the
  // minimum — a thin slate shouldn't produce an empty mini-ACCA.
  if (legs.length < MINI_ACCA_MIN_LEGS) {
    for (const row of candidatePool) {
      if (legs.length >= MINI_ACCA_MIN_LEGS) break;
      if (!legs.includes(row)) legs.push(row);
    }
  }

  const miniAccaCombinedP = legs.length
    ? legs.reduce((p, r) => p * r.mp, 1) * MINI_ACCA_HAIRCUT
    : 0;

  return {
    miniAcca: legs.length >= MINI_ACCA_MIN_LEGS ? legs : [],
    miniAccaCombinedP: legs.length >= MINI_ACCA_MIN_LEGS ? miniAccaCombinedP : 0,
    bestSingles: outputA.slice(0, BEST_SINGLES_MAX),
  };
}

export const OUTPUT_C_MAX = 5;
export const OUTPUT_C_MIN_ODDS = 4.0;

/** Output C — top 5 picks with odds ≥ 4.00 from the full gate-surviving
 *  pool (not just Output A) — may be empty. */
export function buildOutputC(pool: V3OutputRow[]): V3OutputRow[] {
  return pool.filter((r) => r.odds >= OUTPUT_C_MIN_ODDS).slice(0, OUTPUT_C_MAX);
}

export const OUTPUT_D_MAX = 3;
export const OUTPUT_D_MIN_ODDS = 2.5;

/** Output D — top 3 picks with 2.50 ≤ odds < 4.00 from the full pool — may
 *  be empty. */
export function buildOutputD(pool: V3OutputRow[]): V3OutputRow[] {
  return pool
    .filter((r) => r.odds >= OUTPUT_D_MIN_ODDS && r.odds < OUTPUT_C_MIN_ODDS)
    .slice(0, OUTPUT_D_MAX);
}

// ── Phase 8 — status & final summary ────────────────────────────────────────

export interface V3ChunkStatus {
  chunkIndex: number;
  done: number;
  discard: number;
  insufficient: number;
  remaining: number;
}

/** `Chunk [N]: Done X | Discard Y | Insufficient Z | Remaining R` — spec §8 verbatim. */
export function formatChunkStatus(s: V3ChunkStatus): string {
  return `Chunk [${s.chunkIndex}]: Done ${s.done} | Discard ${s.discard} | Insufficient ${s.insufficient} | Remaining ${s.remaining}`;
}

export type V3ClassMix = Record<V3MarketClass, number>;

export function computeClassMix(pool: V3OutputRow[]): V3ClassMix {
  const mix: V3ClassMix = { S: 0, M: 0, L: 0, X: 0 };
  for (const row of pool) mix[row.cls] += 1;
  return mix;
}

export interface V3FinalSummaryInput {
  totalFixtures: number;
  qualifyingCount: number;
  classMix: V3ClassMix;
  highestEdgePick: V3OutputRow | null;
  cappedCount: number;
  /** e.g. ["corners: no stats in feed", "cards: no stats in feed"]. */
  dormantModules: string[];
  dataQualityNote: string;
}

/** §6 responsible-gambling note, stated once in the final summary. */
export const RESPONSIBLE_GAMBLING_NOTE =
  "These are probability estimates, not predictions; even genuine edges lose often over a single slate; stake only what you can afford to lose; keep ≤1% units; this is a candidate list to review, not instructions.";

/** Multi-line §8 final summary. A no-bet slate (qualifyingCount=0) is a
 *  VALID outcome, stated plainly rather than the bar being lowered to fill it. */
export function formatFinalSummary(input: V3FinalSummaryInput): string {
  const lines = [
    `Fixtures analyzed: ${input.totalFixtures} · Qualifying: ${input.qualifyingCount}` +
      (input.qualifyingCount === 0 ? " (no-bet slate — a valid outcome, not a failure)" : ""),
    `Class mix — S:${input.classMix.S} M:${input.classMix.M} L:${input.classMix.L} X:${input.classMix.X}`,
    input.highestEdgePick
      ? `Highest edge: ${input.highestEdgePick.home} vs ${input.highestEdgePick.away} — ${input.highestEdgePick.desc} (${(input.highestEdgePick.adjustedEdge * 100).toFixed(1)}pts, class ${input.highestEdgePick.cls})`
      : "Highest edge: none",
    `Capped selections (logged, never bet): ${input.cappedCount}`,
    `Dormant modules: ${input.dormantModules.length ? input.dormantModules.join(", ") : "none"}`,
    `Data quality: ${input.dataQualityNote}`,
    RESPONSIBLE_GAMBLING_NOTE,
  ];
  return lines.join("\n");
}
