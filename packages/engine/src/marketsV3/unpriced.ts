/** [WS3-B, Wave 3] Market parity port (stage 2) — the `UNPRICED_BY_DESIGN`
 *  registry.
 *
 *  Context: the legacy pricer (`ExecutionEngine.scanMarkets` +
 *  `scanAllMarketsFallback`, `execution/index.ts`) and v3
 *  (`analyzeFixtureMarketsV3` / `routeMarket` / `routeCoverage`,
 *  `feedDictionary.ts`) are two independently-evolved pricing generations.
 *  Wave 4 plans to delete the legacy pricer entirely (`scanMarkets`/
 *  `scanAllMarketsFallback`, gated behind `ORACLE_LEGACY_PRICER`) — the plan's
 *  own risk register blocks that deletion on this exact registry existing,
 *  being clean, and being backed by a coverage assertion
 *  (`engine/test/analysis/pricerParity.ts`) replayed against real slates.
 *
 *  Every market shape the legacy pricer can produce an EVMarket for must
 *  either be v3-priced too, or be listed here with a rationale. This is NOT a
 *  blanket "v3 skips it" list — v3's own skip-reason taxonomy
 *  (`feedDictionary.ts`'s `V3Skip["reason"]`) already documents plenty of
 *  PRINCIPLED skips (player props, plain 1X2, non-goal metrics, altered-
 *  settlement variants) that legacy never prices either — those aren't parity
 *  gaps and don't need a registry row of their own beyond the wholesale
 *  `skip:<reason>` entries below. What this registry exists to catch is the
 *  much narrower, much more important set: a market shape legacy DOES turn
 *  into a real EVMarket that v3 either skips or silently fails to price.
 *
 *  Audited against the actual source (execution/index.ts's `scanMarkets`
 *  ~L667-1187 and `scanAllMarketsFallback`'s `priceAllMarketOutcome`
 *  ~L529-634, read-only — that file is owned by a parallel Wave-3 workstream
 *  this session, not edited here) as of 2026-07-10. Re-audit whenever either
 *  pricer's shape coverage changes; a stale registry is worse than none. */

import type { MarketFamily } from "../markets/index.js";
import type { V3Skip } from "./feedDictionary.js";

export interface UnpricedByDesignEntry {
  /** Stable key: `skip:<V3Skip reason>` applies to EVERY market v3 skips for
   *  that reason (wholesale — used only when the reason is skip-worthy
   *  regardless of which specific market triggered it). `id:<catalogId>`
   *  applies to one specific SportyBet market id that v3 ROUTES (not a skip)
   *  but cannot actually price for its real outcome shape — routeCoverage's
   *  routed/skipped tally would otherwise miss this class of gap entirely,
   *  since routing succeeded even though pricing silently returns null for
   *  every real-world outcome desc. */
  key: string;
  label: string;
  /** Why neither pricer (or only legacy, with a bug) prices this — must state
   *  which side(s) actually cover it today, not just "v3 doesn't." */
  rationale: string;
}

export const UNPRICED_BY_DESIGN: readonly UnpricedByDesignEntry[] = [
  {
    key: "skip:plain-1x2",
    label: "Plain full-time 1X2 (Home/Draw/Away)",
    rationale:
      "Neither pricer treats plain 1X2 as an EV candidate — v3's §3.4 insurance mandate " +
      "excludes it unconditionally (feedDictionary.ts's `case \"match_result\"`), and legacy's " +
      "scanMarkets() has no check() call for the match_result family either (verified: no " +
      "'match_result'/1X2 block exists in its BLOCK 1-12 list). Not a parity gap — both " +
      "pricers have always excluded this market by design.",
  },
  {
    key: "skip:player-market",
    label: "Player props (goalscorer, cards, etc.)",
    rationale:
      "No goal-count-matrix signal exists for an individual player's involvement. Legacy's " +
      "priceAllMarketOutcome has zero player-name-aware logic (its shape matchers are all " +
      "score/total/handicap-based) — neither pricer models this family.",
  },
  {
    key: "skip:non-goal-metric",
    label: "Fouls / offsides / corners-adjacent counting stats / throw-ins / free kicks",
    rationale:
      "Not derivable from a full-time goals scoreline grid. priceAllMarketOutcome's shape " +
      "matchers (correct-score, odd/even, win-to-nil, clean-sheet, team/match total O/U, AH) " +
      "have no branch for any of these metrics either — neither pricer prices them.",
  },
  {
    key: "skip:settlement-variant",
    label: "1-up/2-up early payout, winning method, overtime/extra-time variants",
    rationale:
      "The printed outcome's true settlement probability isn't the grid cell probability of " +
      "the nominal result (early-payout markets pay out on a mid-match state, not the final " +
      "score). Legacy has no altered-settlement awareness in priceAllMarketOutcome either — " +
      "it would silently misprice these if routed, so neither pricer treats them as safe.",
  },
  {
    key: "skip:bad-specifier",
    label: "Malformed/incomplete specifier (e.g. a minute-window O/U with no total= line)",
    rationale:
      "A parsing failure on the specific entry, not a missing model — the market's FAMILY is " +
      "priceable, this particular row's data just didn't parse. Not comparable to a legacy " +
      "gap since legacy's own line-extraction (`specLc.match(/total=([\\d.]+)/) ?? " +
      "descLc.match(/([\\d.]+)/)`) would fail identically on the same malformed input.",
  },
  {
    key: "skip:corners-dormant",
    label: "Xth-corner-order, half-scoped corners O/U, points-weighted corners specials",
    rationale:
      "engines/corners.ts (§3.9) models match-total O/U, handicap, range, odd-even and " +
      "team-total corners — real shapes beyond that (which corner number falls in which " +
      "range, 1st/2nd-half-scoped corners, anything points-weighted) have no NB/Poisson " +
      "corners model yet in v3. Legacy's priceAllMarketOutcome has NO corners logic " +
      "whatsoever (confirmed: no 'corner' branch anywhere in that function) — so this is a " +
      "shape neither pricer prices today, not a v3-only regression.",
  },
  {
    key: "skip:cards-dormant",
    label: "Sending-off-specific, points-weighted booking totals, half-scoped cards O/U",
    rationale:
      "Same reasoning as corners-dormant above, mirrored for engines/cards.ts's coverage " +
      "(match/team-total O/U, handicap, range) — legacy's priceAllMarketOutcome has no cards " +
      "logic at all, so neither pricer prices these shapes today.",
  },
  {
    key: "skip:shots-dormant",
    label: "Shots-on-target 1X2/handicap, plain (non-target) shots markets",
    rationale:
      "engines/shots.ts only models match/team-total shots-on-target O/U (PR-22). Legacy's " +
      "priceAllMarketOutcome has no shots logic of any kind — neither pricer prices these.",
  },
  {
    key: "skip:no-grid-model:half-handicap",
    label: "Half-scoped Asian/European handicap (1st/2nd-half AH)",
    rationale:
      "v3 deliberately declines (feedDictionary.ts: `if (isHalf) return { skip: true, " +
      'reason: "no-grid-model" }` for asian_handicap/handicap) rather than mis-scope a ' +
      "full-time-calibrated push model onto a half grid. Legacy's scanMarkets has no half-AH " +
      "block either (BLOCK 4 is FT-only, gated `!enableGoalsOnlyMode`, no half variant); its " +
      "scanAllMarketsFallback fallback WOULD attempt this via priceAllMarketOutcome's " +
      "AH-any-line branch since that function only excludes half-named UNCATALOGUED ids, not " +
      "catalogued ones — meaning if this market were ever routed there, legacy would silently " +
      "price it against the FULL-match matrix, a real mispricing bug, not a model. v3's " +
      "decline is the correct behavior; nothing to port.",
  },
  {
    key: "skip:no-grid-model:half-correct-score",
    label: 'Half-scoped correct score (e.g. "1st Half Correct Score")',
    rationale:
      "Same shape of gap as half-handicap above: v3 declines rather than price a half " +
      "scoreline off the full-time grid; legacy's priceAllMarketOutcome's scoreMatch regex " +
      "would match the desc text regardless of the market being half-scoped and misprice it " +
      "against `finalMat` (full-time). Declining is correct; not a port candidate.",
  },
  {
    key: "skip:no-grid-model:half-combo",
    label: 'Half-scoped combo markets (e.g. "1st Half 1X2 & O/U")',
    rationale:
      "v3's combo engine (exotics.ts's priceCombo) is FT-grid-only by construction (joint " +
      "cell sums over ctx.statsGrid). Legacy's BLOCK 12 combos are also all FT-scoped " +
      "(markets.hw/dr/aw × markets.btts/ou — no half variants exist there). Neither pricer " +
      "has ever modeled a half-scoped combo.",
  },
  {
    key: "skip:no-grid-model:specials-exotic",
    label: "'specials'/'exotic' catch-all families",
    rationale:
      "Structural catch-all for markets with no principled per-outcome model (the survivors " +
      "of every other classifier above). Legacy has no generic handler for these either — " +
      "priceAllMarketOutcome returns null for anything outside its seven named shapes.",
  },
  {
    key: "id:46",
    label: 'Halftime/fulltime correct score ("0:0 0:0"-style compound scoreline, group Half)',
    rationale:
      "ROUTED (not skipped) to the exotics engine under family ht_ft, but priceHtFt " +
      "(engines/exotics.ts) only parses the 'home/draw/away / home/draw/away' RESULT-pair " +
      'shape used by catalog id 47 ("Halftime/Fulltime") — id 46\'s real outcome descs are ' +
      'compound scorelines ("0:0 0:0", "2:1 4+", ...), which never match that regex, so ' +
      "every outcome silently prices to null and produces zero assessments. routeCoverage's " +
      "routed/skipped tally does not surface this (it counts routing, not pricing success) — " +
      "recorded here so the parity harness's coverage assertion can still catch it. Legacy " +
      "does not price this shape either: priceAllMarketOutcome's correct-score regex " +
      "(`^(\\d+)\\s*[-:]\\s*(\\d+)$`) only matches a SINGLE score pair, not this market's " +
      "two-scoreline compound desc. Genuinely unpriced by both pricers today — not a " +
      "regression, but flagged so a future engines/exotics.ts change doesn't silently start " +
      "mispricing it instead of leaving it declined.",
  },
  {
    key: "id:818",
    label: "Halftime/Fulltime & Total (combo variant of id 46/47, group Combo)",
    rationale:
      "Same compound-scoreline parsing gap as id 46 (this market's HT/FT leg has the same " +
      "shape), plus a third goals-total leg that v3's priceCombo (exotics.ts) does not " +
      "recognize at all (its combo grammar is result×O/U, result×BTTS, O/U×BTTS only — never " +
      "three-way, never HT/FT-based). Legacy's BLOCK 12 combos are also result/O/U/BTTS-only " +
      "in the same three two-way shapes — neither pricer models a three-leg or HT/FT-based " +
      "combo. Genuinely unpriced by both today.",
  },
];

const REGISTRY_BY_KEY: ReadonlySet<string> = new Set(UNPRICED_BY_DESIGN.map((e) => e.key));

/** True when a v3 skip for `reason` (optionally scoped to a specific
 *  sub-category via `subKey`, e.g. "half-handicap") is covered by a
 *  registered, reasoned entry rather than an unexplained gap. */
export function isSkipRegistered(reason: V3Skip["reason"], subKey?: string): boolean {
  if (REGISTRY_BY_KEY.has(`skip:${reason}`)) return true;
  if (subKey && REGISTRY_BY_KEY.has(`skip:${reason}:${subKey}`)) return true;
  return false;
}

/** True when a specific catalog market id is registered as "routed but never
 *  actually priced" (the id:<id> rows above). */
export function isMarketIdRegistered(id: string): boolean {
  return REGISTRY_BY_KEY.has(`id:${id}`);
}

/** Sub-key deriver for the "no-grid-model" reason's three distinct triggers —
 *  reason alone is too coarse (see the three `skip:no-grid-model:*` rows
 *  above), so the parity harness needs to know which specific case an entry
 *  hit to look up the right registry row. Mirrors feedDictionary.ts's
 *  `routeMarket` switch body exactly — keep in sync if that logic changes. */
export function noGridModelSubKey(family: MarketFamily, isHalf: boolean): string | null {
  if ((family === "asian_handicap" || family === "handicap") && isHalf) return "half-handicap";
  if (family === "correct_score" && isHalf) return "half-correct-score";
  if (family === "combo" && isHalf) return "half-combo";
  if (family === "specials" || family === "exotic") return "specials-exotic";
  return null;
}

/** Every registered entry's `key`, for reporting/coverage-summary purposes. */
export function unpricedByDesignKeys(): readonly string[] {
  return UNPRICED_BY_DESIGN.map((e) => e.key);
}
