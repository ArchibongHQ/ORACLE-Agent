/** Canonical ORACLE market index — the global standard of every SportyBet market
 *  type the engine may encounter.
 *
 *  SportyBet publishes 900+ raw market entries per liquid fixture; across a day's
 *  slate there are a few hundred DISTINCT market types (by SportyBet market id).
 *  `MARKET_CATALOG` (./catalog.generated.ts) is the committed, generated index of
 *  every one of them — id, modal display name, group, ORACLE family, observed
 *  outcome shapes, and normalised specifier patterns. Regenerate with
 *  `tools/build_market_catalog.py`.
 *
 *  This module is the single source of truth the deterministic engine routes off:
 *  `priceAllMarketOutcome`/`scanAllMarketsFallback` dispatch on `family` and gate
 *  on `PRICEABLE_FAMILIES`, and the LLM market executor tags its prompt with the
 *  family so the model has ORACLE's own classification, not just the raw name. */

import { MARKET_CATALOG } from "./catalog.generated.js";

export { MARKET_CATALOG };

/** Canonical ORACLE market family. Advisory classification of a market id's
 *  intent — kept in sync with FAMILIES in tools/build_market_catalog.py. */
export type MarketFamily =
  | "match_result"
  | "double_chance"
  | "dnb"
  | "goals_ou"
  | "team_total"
  | "btts"
  | "asian_handicap"
  | "handicap"
  | "correct_score"
  | "exact_goals"
  | "odd_even"
  | "clean_sheet"
  | "win_to_nil"
  | "ht_ft"
  | "highest_scoring_half"
  | "half"
  | "multigoals"
  | "winning_margin"
  | "which_team_scores"
  | "combo"
  | "specials"
  | "exotic";

/** One entry of the canonical market index. Mirrors the shape emitted by
 *  tools/build_market_catalog.py — do not change one without the other. */
export interface MarketCatalogEntry {
  /** SportyBet market id, e.g. "18". */
  id: string;
  /** Modal display name observed for this id, e.g. "Over/Under". */
  name: string;
  /** SportyBet market group: "Main" | "Goals" | "Half" | "Combo" | ... */
  group: string;
  /** Canonical ORACLE family classification. */
  family: MarketFamily;
  /** Distinct outcome descriptions observed, in first-seen order. */
  outcomes: string[];
  /** Normalised specifier patterns (values placeheld), [] when unspecified. */
  specifierShapes: string[];
  /** How many fixtures this market appeared in across the source snapshot(s). */
  fixturesSeen: number;
}

/** Families the deterministic pricer (priceAllMarketOutcome) has a goal-matrix
 *  model for today. Single source of truth for "can the engine deterministically
 *  price this market". Everything else is in-catalog but unpriced — visible as a
 *  gap, not silently dropped. Half-scoped markets stay out: the matrix is
 *  full-time only (priceAllMarketOutcome early-returns on half/in-play). */
export const PRICEABLE_FAMILIES: ReadonlySet<MarketFamily> = new Set<MarketFamily>([
  "goals_ou",
  "team_total",
  "asian_handicap",
  "btts",
  "correct_score",
  "win_to_nil",
  "clean_sheet",
  "odd_even",
]);

/** Index of the catalog by SportyBet market id, built once at module load. */
export const MARKET_BY_ID: ReadonlyMap<string, MarketCatalogEntry> = new Map(
  MARKET_CATALOG.map((e) => [e.id, e])
);

/** Look up a market by SportyBet id; undefined when not in the catalog. */
export function lookupMarket(id: string | number): MarketCatalogEntry | undefined {
  return MARKET_BY_ID.get(String(id));
}

/** Canonical family for a market id, or undefined when not catalogued. */
export function familyOf(id: string | number): MarketFamily | undefined {
  return MARKET_BY_ID.get(String(id))?.family;
}

/** True when the engine has a deterministic model for this market's family. */
export function isPriceable(id: string | number): boolean {
  const fam = familyOf(id);
  return fam != null && PRICEABLE_FAMILIES.has(fam);
}
