/** PR-25 item 2 — referee cards-rate as a shadow diagnostic for the cards
 *  markets (real-time research, 2026-07-09 — see the Oxford Academic JRSS-A
 *  "Yellow Fever" Conway-Maxwell-Poisson copula paper on referee effects,
 *  plus Dean Markwick's independent stan_glmer analysis): top referees issue
 *  ~23% more cards than average, bottom ~19% fewer — a real, replicated
 *  effect, distinct from (and NOT to be confused with) the referee's much
 *  weaker/contested effect on match OUTCOME/goal-expectancy, which this
 *  module does not touch.
 *
 *  SHADOW MODE ONLY, matching every other new signal this audit introduced
 *  (skewShrink.ts, finishingRegression.ts): this module never touches the
 *  live cards Poisson mean (engines/cards.ts's V3CardsMeans), pricing, or a
 *  real pick. It compares the current model's total-cards mean against an
 *  INDEPENDENT projection derived purely from the assigned referee's own
 *  lake-computed shrunk cards rate (tools/compute_referee_cards.py),
 *  reporting how far apart the two estimates are — a diagnostic, not a
 *  filter. Promote to an actual lambda/mean adjustment only once ledger
 *  evidence backs it.
 *
 *  Units: refereeCardsRate is a plain COUNT (yellow + red, weight 1 each) —
 *  the SAME unit as V3CardsMeans.total (cardsAvgH + cardsAvgA), deliberately
 *  NOT points-weighted (see compute_referee_cards.py's header for why a
 *  points-weighted rate would be a unit mismatch here). Callers pass
 *  V3CardsMeans.total (or cardsAvgH+cardsAvgA directly) as modelCardsMean.
 *
 *  Coverage caveat: refereeCardsRate is EPL-only (tools/fetch_referee_
 *  assignments.py scrapes premierleague.com exclusively — see that module's
 *  header for the other-leagues extension path), absent for every other
 *  league and for any week the appointment scraper wasn't run. A fixture
 *  with no referee coverage simply isn't evaluated — expected, not a bug.
 *
 *  Pure math, no I/O. */

/** Divergence threshold below which the two estimates are treated as
 *  "close enough" to skip reporting — the research range for referee cards
 *  effects is roughly ±20-23% at the extremes, so 15% flags meaningfully
 *  strict/lenient referees without drowning the daily report in near-1.0x
 *  noise from average officials. */
export const REFEREE_CARDS_SHADOW_THRESHOLD_DEFAULT = 0.15;

export interface RefereeCardsShadowInput {
  /** The live cards model's total-cards mean for this fixture
   *  (V3CardsMeans.total, i.e. cardsAvgH + cardsAvgA) — null/undefined when
   *  the cards module is dormant (cardsMeans() returns null, engines/
   *  cards.ts). */
  modelCardsMean?: number | null;
  /** The assigned referee's shrunk cards-per-game rate (StatsOverride.
   *  refereeCardsRate) — null/undefined when no referee was assigned/scraped
   *  for this fixture (the common case outside the EPL). */
  refereeCardsRate?: number | null;
}

export interface RefereeCardsShadowResult {
  modelCardsMean: number;
  refereeCardsRate: number;
  /** refereeCardsRate / modelCardsMean — 1.0 = the referee's own rate
   *  exactly matches what the model already projects, >1 the referee runs
   *  stricter than the model's team-driven mean implies, <1 more lenient. */
  ratio: number;
  deviationPct: number;
  direction: "stricter" | "lenient";
}

/** Shadow-evaluate a single fixture's model cards mean against its assigned
 *  referee's independent cards-rate estimate. Returns null when either input
 *  is missing/non-finite/non-positive (no cards coverage, or no referee
 *  coverage — both common) or the divergence is below `thresholdPct` — an
 *  empty/null result is the common, valid outcome for the vast majority of
 *  fixtures (any non-EPL league, any week without a scrape, or a referee
 *  whose rate happens to track the model closely). */
export function shadowRefereeCards(
  input: RefereeCardsShadowInput,
  thresholdPct: number = REFEREE_CARDS_SHADOW_THRESHOLD_DEFAULT
): RefereeCardsShadowResult | null {
  const { modelCardsMean, refereeCardsRate } = input;
  if (
    typeof modelCardsMean !== "number" ||
    !Number.isFinite(modelCardsMean) ||
    modelCardsMean <= 0
  ) {
    return null;
  }
  if (
    typeof refereeCardsRate !== "number" ||
    !Number.isFinite(refereeCardsRate) ||
    refereeCardsRate <= 0
  ) {
    return null;
  }
  const ratio = refereeCardsRate / modelCardsMean;
  const deviationPct = Math.abs(ratio - 1);
  if (deviationPct < thresholdPct) return null;
  return {
    modelCardsMean,
    refereeCardsRate,
    ratio,
    deviationPct,
    direction: ratio > 1 ? "stricter" : "lenient",
  };
}

/** Report line for the daily Telegram/log summary, alongside
 *  formatSkewShrinkShadow/formatFinishingRegressionShadow. Null when there's
 *  nothing to report (shadowRefereeCards already returned null). */
export function formatRefereeCardsShadow(
  fixtureLabel: string,
  refereeName: string | undefined,
  result: RefereeCardsShadowResult | null
): string | null {
  if (!result) return null;
  const pct = Math.round(result.deviationPct * 100);
  const who = refereeName ?? "referee";
  return (
    `${fixtureLabel}: referee cards shadow (${who}, ±${Math.round(REFEREE_CARDS_SHADOW_THRESHOLD_DEFAULT * 100)}% threshold, not applied) — ` +
    `${result.direction} by ${pct}% (${result.refereeCardsRate.toFixed(2)} referee rate vs ${result.modelCardsMean.toFixed(2)} model mean)`
  );
}
