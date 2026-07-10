/** [Wave-2 W2-S stub, owner WS2-C] Sharp-reference odds feed (P1-4). Odds API
 *  primary + Playwright/Google-AI-Mode fallback; devig via markets/devig.ts;
 *  persists {pick_odds, sharp_fair_at_pick, sharp_fair_at_close} per pick so
 *  CLV becomes a headline ledger metric. Un-zero-weight criterion for
 *  ConvergenceScorer's S02-S05 (OracleConfig.sharpFeedVerified): ≥95% pick
 *  coverage over 7 consecutive slates — checked and flipped manually, never
 *  auto-enabled.
 *
 *  Inert stub — WS2-C fleshes this out. Exported shapes exist so other
 *  Wave-2 workstreams can typecheck against the eventual real contract. */

/** One pick's sharp-reference odds snapshot. `sharp_fair_at_close` is
 *  populated later (post-kickoff, by the closing-odds sweep) — undefined
 *  until then. */
export interface SharpOddsRecord {
  fixtureKey: string;
  market: string;
  side: string;
  pick_odds: number;
  sharp_fair_at_pick: number | null;
  sharp_fair_at_close: number | null;
  /** Where sharp_fair_at_pick/close came from — "odds_api" | "ai_mode_fallback" | "unavailable". */
  source: string;
  capturedAt: string;
}

/** Fetch + devig the sharp-reference fair price for one market at pick time.
 *  Fail-open: returns null (never throws) when no sharp source is available. */
export async function fetchSharpFairPrice(
  _fixtureKey: string,
  _market: string,
  _side: string
): Promise<{ fair: number; source: string } | null> {
  return null;
}
