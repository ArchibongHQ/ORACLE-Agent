/** Universal Under ban (owner rule, locked decision ②: "no Under ever ships").
 *
 *  Prior to this module, the Under strip existed in narrow, family-scoped
 *  places only — every one of them limited to TOTALS_FAMILIES ("goals_ou"/
 *  "team_total"):
 *   - `analyzeFixtureMarketsV3` (marketsV3/analyzeFixtureMarkets.ts) strips
 *     Unders from its own `evMarkets` return.
 *   - `v3AssessmentsToEvMarkets` (safety/pipeline.ts) mirrors that same
 *     filter for the v3 staking path.
 *   - `v3Best` derivation (batch/index.ts) applies the identical inline
 *     filter a third time.
 *  None of the three covers "combo" (e.g. execution/index.ts's `Home &
 *  Under 2.5`, `Under 2.5 & BTTS No`) or "half" (`SH Under 1.5`) markets,
 *  which the LEGACY `ExecutionEngine.scanMarkets()`/`scanAllMarketsFallback()`
 *  price and can push into `evs`/`eligible` with zero strip anywhere in that
 *  file — the exact leak that put 5 delivered Unders on a real Telegram
 *  slate (2026-07-18 incident). Nor does any of them cover the all-markets
 *  LLM executor tier (`decision/marketExecutor.ts`), which lets an LLM pick
 *  ANY outcome from the raw catalogue with no family restriction at all.
 *
 *  This module is the single, family-agnostic, text-based primitive every
 *  one of those call sites now shares — it never branches on `family`, so
 *  it structurally cannot miss a new market family that happens to have an
 *  Under leg; it reads the same outcome text a human reading the delivered
 *  slate would. Applied at THREE points, because the codebase has three
 *  independent places a candidate can become the delivered pick without
 *  passing through a shared function call:
 *   1. `buildEligibleBets` (decision/index.ts) — the legacy/default choke
 *      point every non-v3-replaced `eligible` list flows through.
 *   2. The v3 `eligible` reassignment (batch/index.ts, `enableMarketsV3 ===
 *      "on"` branch) — REPLACES `eligible` after (1) already ran, so needed
 *      its own application, not just a wider TOTALS_FAMILIES set upstream.
 *   3. `validateAndBuild` (decision/marketExecutor.ts) — the LLM-executor
 *      splice point, which never passes through `buildEligibleBets` at all.
 *
 *  Word- AND number-anchored (`\bunder\s*-?\d`), not a bare `\bunder\b`
 *  substring search and deliberately NOT reusing `dirOfDesc`
 *  (marketsV3/descParse.ts) here: real totals-direction Unders are always
 *  followed by a numeric line ("Under 2.5", "Home & Under 2.5", "SH Under
 *  1.5", even "Under 19.5" corner/card lines) — anchoring on that number is
 *  BOTH safer and no narrower than a plain word-boundary check, since no
 *  real market in the catalogue ever emits a bare "Under" with no line
 *  attached (verified against markets/catalog.generated.ts). `dirOfDesc`'s
 *  own `\bover\b`/`\bunder\b` pair (correct for ITS purpose — comparing an
 *  Over/Under pair's direction on already-known totals-shaped strings) would
 *  still flag a hypothetical narrative phrase like "Manchester United Under
 *  Pressure" as long as no "over" token is also present (adversarial review
 *  finding, 2026-07-19) — a real risk category worth eliminating outright
 *  given real-money stakes, not just arguing "no such string exists today."
 *  `dirOfDesc` itself is intentionally left unchanged — it's used elsewhere
 *  for legitimate line-direction comparisons where its current semantics
 *  are correct; this module solves the same problem more narrowly instead
 *  of widening that shared function's blast radius. */

import type { EVMarket } from "../types.js";

const UNDER_WITH_LINE = /\bunder\s*-?\d/i;

/** True when a raw outcome-description string contains a standalone "Under"
 *  attached to a numeric line — covers plain totals ("Under 2.5"), combo
 *  legs ("Home & Under 2.5", "Under 2.5 & BTTS No"), half markets ("SH
 *  Under 1.5"), and anything else a raw-catalogue scan might surface,
 *  regardless of market family. The shared primitive every shape-specific
 *  helper below reduces to, so the check itself lives in exactly one place. */
export function isUnderDesc(text: string | undefined | null): boolean {
  if (!text) return false;
  return UNDER_WITH_LINE.test(text);
}

/** True when this EVMarket candidate's side/label text is an Under. */
export function hasUnderComponent(m: EVMarket): boolean {
  return isUnderDesc(m.side ?? m.label);
}

/** Strip every Under-containing candidate from an EVMarket list. Returns a
 *  NEW array (never mutates the input) so callers that also hold a
 *  reference to the original `evMarkets` (e.g. for `assessments`/audit
 *  transparency, matching the v3 path's existing "strip from the return
 *  value only, leave the underlying assessments visible" convention) are
 *  unaffected. */
export function stripUnderComponents(markets: EVMarket[]): EVMarket[] {
  return markets.filter((m) => !hasUnderComponent(m));
}
