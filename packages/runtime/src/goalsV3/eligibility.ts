/** goals-market-analysis-prompt-v3 Phase 1 — eligibility filter.
 *
 *  Whitelist membership is necessary, not sufficient: a fixture must be on the
 *  union whitelist (v3 §1.1 + the researched GOALS_RICH_LEAGUES set — locked
 *  plan decision) AND survive the hard discards (§1.2). Youth / women /
 *  friendlies / cup finals are not discarded but flagged "heightened": they
 *  need near-perfect data with aligned trends (§1.2 heightened bar, enforced by
 *  the completeness gate downstream).
 *
 *  Dead rubbers have no reliable deterministic signal at this layer — fixtures
 *  that look like one (both mid-table, late season) are flagged as context for
 *  the slate arbiter, never discarded here.
 *
 *  Pure, synchronous, no I/O. */

import { GOALS_RICH_LEAGUES } from "../goalsPreFilter.js";
import type { SportyBetEvent } from "../selectFixtures.js";
import { INTL_TOURNAMENT_RE } from "../selectGoals.js";
import { SRL_VIRTUAL_RE as SRL_RE } from "../srlPatterns.js";

/** v3 §1.1 whitelist, mapped to this codebase's SportyBet league-name
 *  convention (see ORACLE_PRIORITY_LEAGUES for the naming source of truth).
 *  Entries the sidecar has never observed under these names simply never
 *  match — harmless. Continental CLUB cups (Champions League etc.) are
 *  deliberately absent: v3 §1.1 does not list them (knockout ties are cagey)
 *  and the locked decision keeps the spec's whitelist as the base. */
const V3_WHITELIST: readonly string[] = [
  // Global tournaments
  "FIFA World Cup",
  "UEFA Euro",
  "Copa America",
  "Africa Cup of Nations",
  "Asian Cup",
  // Top flights
  "Premier League",
  "Bundesliga",
  "La Liga",
  "Serie A",
  "Ligue 1",
  "Eredivisie",
  "Primeira Liga",
  "Belgian Pro League",
  "Scottish Premiership",
  "Danish Superliga",
  "Eliteserien",
  "Allsvenskan",
  "Swiss Super League",
  "Urvalsdeild",
  // Second tiers / lower divisions
  "Championship",
  "League One",
  "League Two",
  "2. Bundesliga",
  "Regionalliga Bayern",
  "Regionalliga Nord",
  "Regionalliga Nordost",
  "Regionalliga Südwest",
  "Regionalliga West",
  "Segunda Division",
  "Serie B",
  "Ligue 2",
  "Eerste Divisie",
  "OBOS-ligaen",
  "Superettan",
  "Swedish Division 1",
  "Swedish Division 2",
  "Ykkonen",
  "Danish 1. Division",
  // Americas
  "Brazilian Serie A",
  "Brazilian Serie B",
  "Argentine Primera Division",
  "Liga MX",
  "MLS",
  "USL Championship",
  "USL League One",
  "USL League Two",
  "MLS Next Pro",
  "Chile Primera Division",
  "Colombia Primera A",
  "Bolivia Primera Division",
  "Venezuela Primera Division",
  // Asia / Oceania / Middle East
  "A-League",
  "NPL Queensland",
  "NPL New South Wales",
  "NPL Victoria",
  "J League",
  "J2 League",
  "K League 1",
  "Saudi Pro League",
  "Qatar Stars League",
  "UAE Pro League",
  "Singapore Premier League",
  "Malaysia Super League",
  // Africa
  "South Africa Premier Division",
  "Botola Pro",
  "Egypt Premier League",
  "Tunisia Ligue 1",
  // Domestic cups (early rounds / likely mismatches only)
  "FA Cup",
  "DFB-Pokal",
  "Copa del Rey",
  "Coupe de France",
  "Copa Chile",
  "Copa Venezuela",
  "Faroe Islands Cup",
  "Lithuanian Cup",
  "Estonian Cup",
];

/** Union whitelist: v3 §1.1 + researched goals-rich additions (locked decision). */
export const GOALS_V3_WHITELIST: ReadonlySet<string> = new Set([
  ...V3_WHITELIST,
  ...GOALS_RICH_LEAGUES,
]);

/** Simulated Reality League / virtual / e-sport football — §1.2 hard discard.
 *  [refactor P1-3] Consolidated into srlPatterns.ts (SRL_VIRTUAL_RE). This is
 *  the strictest gate of the three legacy call sites, so the consolidated
 *  superset (adds a trailing optional football/soccer/sport qualifier that
 *  is a no-op here — see srlPatterns.ts) never changes behavior. */

/** Heightened-bar classes (§1.2): goals modelling unreliable, so these need
 *  near-perfect data with aligned trends instead of a flat discard. */
const YOUTH_RE = /\bu-?\s?(1[6-9]|2[0-3])\b|youth|junior|reserve|\bb[\s-]?team\b|\bii\b/i;
const WOMEN_RE = /\bwom[ae]n'?s?\b|\bfemenin[ao]\b|\bfeminine?\b|frauen|\bladies\b|\(w\)|\bw\.?$/i;
const FRIENDLY_RE = /friendly|friendlies|test\s*match|club\s*friendly/i;
const CUP_FINAL_RE = /\bfinal\b(?!\s*(?:phase|stage|round|s\b))/i;

export type V3EligibilityStatus = "eligible" | "heightened" | "discard";

export interface V3Eligibility {
  status: V3EligibilityStatus;
  /** Machine-readable reasons (discard causes / heightened classes / arbiter flags). */
  reasons: string[];
}

function fixtureText(event: SportyBetEvent): string {
  return `${event.league ?? ""} ${event.home} ${event.away}`;
}

/** Classify one fixture per v3 Phase 1. Order matters:
 *    1. SRL/virtual → discard (applies to everything).
 *    2. League whitelist (union) → discard when absent.
 *    3. Missing 1X2 or O/U 2.5 odds → discard (Rule 0 mandatory pre-check;
 *       the completeness gate re-verifies against the full table).
 *    4. Derby (non-international) → discard (§1.2 low-scoring derby rule).
 *    5. Youth / women / friendly / cup-final → heightened.
 *    6. Late-season mid-table pairing → eligible, flagged dead-rubber-risk
 *       (context for the slate arbiter, not a gate). */
export function classifyEligibility(event: SportyBetEvent): V3Eligibility {
  const league = event.league ?? "";
  const text = fixtureText(event);
  const reasons: string[] = [];

  if (SRL_RE.test(text)) return { status: "discard", reasons: ["srl_virtual"] };
  if (!GOALS_V3_WHITELIST.has(league)) return { status: "discard", reasons: ["not_whitelisted"] };

  const odds = event.detail?.odds;
  const has1x2 = odds?.["1x2"]?.home != null && odds?.["1x2"]?.away != null;
  const hasOu25 = odds?.ou25?.over != null;
  if (!has1x2 || !hasOu25) {
    return { status: "discard", reasons: ["missing_mandatory_odds"] };
  }

  // §1.2 low-scoring derby guard. International tournaments are exempt (same
  // convention as the leg-level gate); goals-rich leagues keep their Tier-A
  // designation even when a fixture name carries derby wording.
  if (
    !INTL_TOURNAMENT_RE.test(league) &&
    !GOALS_RICH_LEAGUES.has(league) &&
    /derby|derbi|clasico|clásico/i.test(text)
  ) {
    return { status: "discard", reasons: ["derby"] };
  }

  let heightened = false;
  if (YOUTH_RE.test(text)) {
    heightened = true;
    reasons.push("youth");
  }
  if (WOMEN_RE.test(text)) {
    heightened = true;
    reasons.push("women");
  }
  if (FRIENDLY_RE.test(text)) {
    heightened = true;
    reasons.push("friendly");
  }
  if (CUP_FINAL_RE.test(league)) {
    heightened = true;
    reasons.push("cup_final");
  }

  // Dead-rubber risk flag (arbiter context only): both sides mid-table with a
  // nearly-complete season — nothing to play for is plausible but unprovable
  // from standings alone.
  const st = event.detail?.stats?.standings;
  const hp = st?.home?.pos;
  const ap = st?.away?.pos;
  const played = Math.max(st?.home?.played ?? 0, st?.away?.played ?? 0);
  if (
    typeof hp === "number" &&
    typeof ap === "number" &&
    played >= 30 &&
    hp >= 8 &&
    hp <= 14 &&
    ap >= 8 &&
    ap <= 14
  ) {
    reasons.push("dead_rubber_risk");
  }

  return { status: heightened ? "heightened" : "eligible", reasons };
}
