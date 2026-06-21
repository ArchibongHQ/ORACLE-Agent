/** Pure helper: translate a SportyBetEventDetail odds block into the flat key map
 *  that scanMarkets() and the execution engine read (e.g. "over_2.5", "btts_yes").
 *  Called from injectSidecarOdds() (batch), jobFromSidecar() (punt), and
 *  fetchFixtureByName() (single-fixture) so the translation lives in one place. */

import type { SportyBetEventDetail } from "./selectFixtures.js";

const toNum = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n > 1 && n <= 200 ? n : undefined;
};

/** Return a flat { key: odds } record consumable by the engine's scanMarkets().
 *  Only keys with valid numeric odds (> 1) are included — never NaN/null/undefined. */
export function flattenSidecarOdds(detail: SportyBetEventDetail): Record<string, number> {
  const o = detail.odds;
  const flat: Record<string, number> = {};

  // 1x2 — use direct prices when available; fall back to DNB-derived synthetic when null.
  // DNB removes draw so: P(H) ≈ 1/dnb_h, P(A) ≈ 1/dnb_a. Re-norm to full 3-way market.
  const h = toNum(o?.["1x2"]?.home);
  const d = toNum(o?.["1x2"]?.draw);
  const a = toNum(o?.["1x2"]?.away);
  if (h) flat.home = h;
  if (d) flat.draw = d;
  if (a) flat.away = a;

  if (!flat.home || !flat.away) {
    const dnbH = toNum(o?.dnb?.home);
    const dnbA = toNum(o?.dnb?.away);
    if (dnbH && dnbA) {
      // Both sides available: back out a 3-way implied probability and convert to odds
      const pH = 1 / dnbH;
      const pA = 1 / dnbA;
      const pD = Math.max(0, 1 - pH - pA);
      // Re-normalise so probabilities sum to 1 (remove bookmaker vig in DNB)
      const total = pH + pA + pD;
      const synH = total / pH;
      const synA = total / pA;
      const synD = pD > 0.01 ? total / pD : 3.4; // cap draw at 3.4 when negligible
      if (!flat.home) flat.home = Math.round(synH * 100) / 100;
      if (!flat.away) flat.away = Math.round(synA * 100) / 100;
      if (!flat.draw) flat.draw = Math.round(synD * 100) / 100;
    } else if (dnbH && !dnbA) {
      // Only home DNB available — use as proxy for home price; skip away/draw
      if (!flat.home) flat.home = dnbH;
    } else if (dnbA && !dnbH) {
      if (!flat.away) flat.away = dnbA;
    }
  }

  // Over/Under 2.5
  const ou25o = toNum(o?.ou25?.over);
  const ou25u = toNum(o?.ou25?.under);
  if (ou25o) flat["over_2.5"] = ou25o;
  if (ou25u) flat["under_2.5"] = ou25u;

  // Over/Under 1.5
  const ou15o = toNum(o?.ou15?.over);
  const ou15u = toNum(o?.ou15?.under);
  if (ou15o) flat["over_1.5"] = ou15o;
  if (ou15u) flat["under_1.5"] = ou15u;

  // Over/Under 3.5
  const ou35o = toNum(o?.ou35?.over);
  const ou35u = toNum(o?.ou35?.under);
  if (ou35o) flat["over_3.5"] = ou35o;
  if (ou35u) flat["under_3.5"] = ou35u;

  // Team totals Over 0.5 — engine reads home_ou_over_0_5 / away_ou_over_0_5 for the
  // "Home/Away Total Over 0.5" goals-accumulator legs (execution/index.ts BLOCK 3).
  const ttHomeO = toNum(o?.tt_home_05?.over);
  const ttAwayO = toNum(o?.tt_away_05?.over);
  if (ttHomeO) flat.home_ou_over_0_5 = ttHomeO;
  if (ttAwayO) flat.away_ou_over_0_5 = ttAwayO;

  // BTTS
  const bttsY = toNum(o?.btts?.yes);
  const bttsN = toNum(o?.btts?.no);
  if (bttsY) flat.btts_yes = bttsY;
  if (bttsN) flat.btts_no = bttsN;

  // Draw No Bet
  const dnbH = toNum(o?.dnb?.home);
  const dnbA = toNum(o?.dnb?.away);
  if (dnbH) flat.dnb_h = dnbH;
  if (dnbA) flat.dnb_a = dnbA;

  // Double Chance
  const dc1x = toNum(o?.dc?.["1x"]);
  const dcX2 = toNum(o?.dc?.x2);
  const dc12 = toNum(o?.dc?.["12"]);
  if (dc1x) flat.dc_1x = dc1x;
  if (dcX2) flat.dc_x2 = dcX2;
  if (dc12) flat.dc_12 = dc12;

  // Asian Handicap — closest-to-0 line stored as ah_hp05 / ah_ap05 convention
  const ahH = toNum(o?.ah?.home);
  const ahA = toNum(o?.ah?.away);
  const ahLine = o?.ah?.line ?? 0;
  if (ahH && ahA) {
    // Store under the generic keys the engine recognises; also store line-specific keys
    flat.ah_h = ahH;
    flat.ah_a = ahA;
    // Line-specific key (e.g. ah_hp05 for -0.5 home, ah_ap05 for +0.5 away)
    const lineSuffix = String(Math.abs(Number(ahLine))).replace(".", "");
    flat[`ah_hp${lineSuffix}`] = ahH;
    flat[`ah_ap${lineSuffix}`] = ahA;
  }

  return flat;
}
