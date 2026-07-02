/** all-markets-analysis-prompt-v3 §0.3/§0.4 — completeness-input telemetry.
 *
 *  The v3 weighted completeness gate (goalsV3/completeness.ts scoreCompleteness,
 *  reused by the all-markets pipeline) discards any fixture missing a mandatory
 *  input or scoring < 70. That gate is only as good as its inputs: if an
 *  acquisition regression silently empties a field (a gismo schema change, a
 *  stale xG table, a scraper crash), the gate would discard the whole slate and
 *  the batch would look "quiet" instead of broken.
 *
 *  This module measures per-field population rates across a slate BEFORE any
 *  gating, so the worker can log exactly which inputs are thin and the Phase 8
 *  summary can report data quality with numbers instead of vibes. Pure,
 *  synchronous, no I/O. */

import type { SportyBetEvent } from "../selectFixtures.js";

/** The 9 weighted gate inputs (§0.4) plus the market-specific tier fields
 *  (§0.3) the P2 engines consume. Keys are stable log/report identifiers. */
export const V3_TRACKED_FIELDS = [
  // Weighted-gate inputs (mandatory block first)
  "odds",
  "form",
  "scored",
  "conceded",
  "hitRate",
  "xg",
  "h2h",
  "rest",
  // Market-specific tier (family-ineligible when absent, never a discard)
  "bttsPct",
  "csPct",
  "ftsPct",
  "firstHalfShare",
  "cornersFor",
  "cornersAgainst",
  "cards",
  "allMarketsFeed",
] as const;

export type V3TrackedField = (typeof V3_TRACKED_FIELDS)[number];

export interface V3FieldPopulation {
  /** Fixtures inspected. */
  total: number;
  /** Per-field count of fixtures where the input is present on BOTH sides
   *  (single-sided data can't feed a two-team model). */
  counts: Record<V3TrackedField, number>;
  /** counts / total, rounded to 3 dp; 0 when total is 0. */
  rates: Record<V3TrackedField, number>;
}

const bothSides = (h: unknown, a: unknown): boolean => h != null && a != null;

/** Inspect one event for each tracked field (both sides required). Mirrors the
 *  exact field paths scoreCompleteness reads so a rate of 0 here always means
 *  the gate input is genuinely dark, not a path mismatch. */
export function inspectEvent(event: SportyBetEvent): Record<V3TrackedField, boolean> {
  const detail = event.detail;
  const stats = detail?.stats;
  const sc = stats?.scoringConceding;
  return {
    odds: detail?.odds?.ou25?.over != null,
    form:
      bothSides(stats?.form?.home?.last5, stats?.form?.away?.last5) ||
      bothSides(stats?.recentGoals?.home?.scored_avg, stats?.recentGoals?.away?.scored_avg),
    scored: bothSides(
      stats?.goals?.home?.avg_scored ?? sc?.home?.scored_avg,
      stats?.goals?.away?.avg_scored ?? sc?.away?.scored_avg
    ),
    conceded: bothSides(
      stats?.goals?.home?.avg_conceded ?? sc?.home?.conceded_avg,
      stats?.goals?.away?.avg_conceded ?? sc?.away?.conceded_avg
    ),
    hitRate: bothSides(stats?.overunder?.home?.over25_pct, stats?.overunder?.away?.over25_pct),
    xg: bothSides(stats?.xg?.home?.xgf, stats?.xg?.away?.xgf),
    h2h: (stats?.h2h?.total ?? 0) > 0 || (stats?.h2h?.matches?.length ?? 0) > 0,
    rest: bothSides(stats?.congestion?.home?.rest_days, stats?.congestion?.away?.rest_days),
    bttsPct: bothSides(sc?.home?.btts_rate, sc?.away?.btts_rate),
    csPct: bothSides(sc?.home?.clean_sheet_rate, sc?.away?.clean_sheet_rate),
    ftsPct: bothSides(sc?.home?.failed_to_score_rate, sc?.away?.failed_to_score_rate),
    firstHalfShare: bothSides(sc?.home?.goals_1h_avg, sc?.away?.goals_1h_avg),
    cornersFor: bothSides(
      stats?.recentCorners?.home ?? stats?.possessionValue?.home?.corners_avg,
      stats?.recentCorners?.away ?? stats?.possessionValue?.away?.corners_avg
    ),
    cornersAgainst: bothSides(stats?.recentCornersAgainst?.home, stats?.recentCornersAgainst?.away),
    cards: bothSides(stats?.disciplinary?.home?.yellow_avg, stats?.disciplinary?.away?.yellow_avg),
    allMarketsFeed: (detail?.odds?.allMarkets?.length ?? 0) > 0,
  };
}

/** Population rates for a whole slate. */
export function summarizeFieldPopulation(events: SportyBetEvent[]): V3FieldPopulation {
  const counts = Object.fromEntries(V3_TRACKED_FIELDS.map((f) => [f, 0])) as Record<
    V3TrackedField,
    number
  >;
  for (const event of events) {
    const present = inspectEvent(event);
    for (const field of V3_TRACKED_FIELDS) {
      if (present[field]) counts[field] += 1;
    }
  }
  const rates = Object.fromEntries(
    V3_TRACKED_FIELDS.map((f) => [
      f,
      events.length ? Math.round((counts[f] / events.length) * 1000) / 1000 : 0,
    ])
  ) as Record<V3TrackedField, number>;
  return { total: events.length, counts, rates };
}

/** One-line log rendering for the worker (`[markets-v3] field population: …`).
 *  Flags any weighted-gate input under `warnBelow` (default 50%) so a dark
 *  field is impossible to miss in the batch log. */
export function formatPopulationLog(pop: V3FieldPopulation, warnBelow = 0.5): string {
  const parts = V3_TRACKED_FIELDS.map((f) => {
    const pct = Math.round(pop.rates[f] * 100);
    const gateField = ["odds", "form", "scored", "conceded", "hitRate"].includes(f);
    const warn = gateField && pop.rates[f] < warnBelow ? "!" : "";
    return `${f}=${pct}%${warn}`;
  });
  return `fields(${pop.total} fixtures): ${parts.join(" ")}`;
}
