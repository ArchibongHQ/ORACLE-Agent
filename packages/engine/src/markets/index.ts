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

export { devigThreeWay, devigTwoWay } from "./devig.js";
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
  | "corners"
  | "cards"
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

/** Families the deterministic pricer (priceAllMarketOutcome / scanMarkets) has a
 *  goal-matrix model for today. Single source of truth for "can the engine
 *  deterministically price this market". Everything else is in-catalog but
 *  unpriced — visible as a gap, not silently dropped. */
export const PRICEABLE_FAMILIES: ReadonlySet<MarketFamily> = new Set<MarketFamily>([
  "goals_ou",
  "team_total",
  "asian_handicap",
  "btts",
  "correct_score",
  "win_to_nil",
  "clean_sheet",
  "odd_even",
  "half",
  "combo",
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

/** Literal union of every FAMILY_LABEL display value — the real value space of
 *  PickRef.market/EVMarket.market (display labels, not the raw MarketFamily
 *  slugs). Hand-kept in sync with FAMILY_LABEL below; the Record<MarketFamily, _>
 *  annotation on FAMILY_LABEL makes a missing/typo'd entry a compile error. */
export type FamilyLabel =
  | "1X2"
  | "Double Chance"
  | "Draw No Bet"
  | "Goals O/U"
  | "Team Total"
  | "BTTS"
  | "Asian Handicap"
  | "Handicap"
  | "Correct Score"
  | "Exact Goals"
  | "Corners"
  | "Cards"
  | "Odd/Even"
  | "Clean Sheet"
  | "Win to Nil"
  | "HT/FT"
  | "Highest Scoring Half"
  | "Half"
  | "Multigoals"
  | "Winning Margin"
  | "Which Team Scores"
  | "Combo"
  | "Specials"
  | "Exotic";

/** Human-readable display label for each canonical market family.
 *  Use this in all UI/display code instead of the raw family slug. */
export const FAMILY_LABEL: Record<MarketFamily, FamilyLabel> = {
  match_result: "1X2",
  double_chance: "Double Chance",
  dnb: "Draw No Bet",
  goals_ou: "Goals O/U",
  team_total: "Team Total",
  btts: "BTTS",
  asian_handicap: "Asian Handicap",
  handicap: "Handicap",
  correct_score: "Correct Score",
  exact_goals: "Exact Goals",
  corners: "Corners",
  cards: "Cards",
  odd_even: "Odd/Even",
  clean_sheet: "Clean Sheet",
  win_to_nil: "Win to Nil",
  ht_ft: "HT/FT",
  highest_scoring_half: "Highest Scoring Half",
  half: "Half",
  multigoals: "Multigoals",
  winning_margin: "Winning Margin",
  which_team_scores: "Which Team Scores",
  combo: "Combo",
  specials: "Specials",
  exotic: "Exotic",
};
