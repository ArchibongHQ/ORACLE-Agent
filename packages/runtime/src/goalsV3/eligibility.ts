/** goals-market-analysis-prompt-v3 Phase 1 — eligibility filter.
 *
 *  [Wave-4 WS-A3, data-driven fixture gating] League whitelist membership is
 *  NO LONGER a discard gate: an exact-string whitelist was silently dropping
 *  the majority of a real slate (89/99 fixtures on 2026-07-10, including
 *  FIFA World Cup Spain v Belgium under a non-exact league label) — the
 *  sidecar's league-name strings simply don't reliably match a fixed list.
 *  `GOALS_V3_WHITELIST`/`V3_WHITELIST` stay exported for priority/workbook
 *  ordering elsewhere; off-list fixtures now survive with a non-gating
 *  `off_whitelist` annotation instead.
 *
 *  Youth / women / cup finals are not discarded but flagged "heightened":
 *  they need near-perfect data with aligned trends (§1.2 heightened bar,
 *  enforced by the completeness gate downstream). Derbies (non-international)
 *  moved from a hard discard to the same heightened treatment — raises the
 *  data bar, never loosens it.
 *
 *  Friendlies (club OR international) are also no longer discarded: results
 *  are genuinely unmodelable under rotation/defensive-experiment intent, but
 *  goals still flow at a modelable base rate. A friendly survives as
 *  heightened PLUS `marketRestriction: "goals_over_only"` — consumed
 *  downstream (marketsV3/pipeline.ts's `restrictOddsToGoalsOverOnly`,
 *  applied at the slateGate.ts choke point) to strip the fixture's market
 *  table to goals-Over-only families before it can reach pricing.
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
  /** Set only for friendlies: results are unmodelable but goals still flow.
   *  Consumed by the slateGate.ts choke point to strip the fixture's market
   *  table down to goals-Over-only families before pricing. */
  marketRestriction?: "goals_over_only";
}

function fixtureText(event: SportyBetEvent): string {
  return `${event.league ?? ""} ${event.home} ${event.away}`;
}

/** Classify one fixture per v3 Phase 1 (rewritten Wave-4 WS-A3 — see module
 *  docstring for the full rationale). Order matters:
 *    1. SRL/virtual → discard (applies to everything).
 *    2. Friendlies (club OR international) → NOT discarded: heightened +
 *       marketRestriction "goals_over_only" (results unmodelable, goals
 *       still flow).
 *    3. Missing 1X2 or O/U 2.5 odds → discard (Rule 0 mandatory pre-check;
 *       the completeness gate re-verifies against the full table).
 *    4. League whitelist (union) → NO LONGER a discard gate; off-list leagues
 *       get a non-gating `off_whitelist` annotation only.
 *    5. Derby (non-international) → heightened (was discard; §1.2 low-
 *       scoring derby rule now only raises the data bar, never a gate).
 *    6. Youth / women / cup-final → heightened.
 *    7. Late-season mid-table pairing → eligible, flagged dead-rubber-risk
 *       (context for the slate arbiter, not a gate). */
export function classifyEligibility(event: SportyBetEvent): V3Eligibility {
  const league = event.league ?? "";
  const text = fixtureText(event);
  const reasons: string[] = [];

  // 1. SRL / virtual — hard discard, applies to everything.
  if (SRL_RE.test(text)) return { status: "discard", reasons: ["srl_virtual"] };

  // 2. Friendlies (club OR international): survive as "restricted" — the
  //    heightened data bar applies AND the market table is later stripped to
  //    goals-Over-only families (see marketsV3/pipeline.ts's
  //    restrictOddsToGoalsOverOnly, applied at the slateGate.ts choke point).
  let heightened = false;
  let marketRestriction: V3Eligibility["marketRestriction"];
  if (FRIENDLY_RE.test(text)) {
    heightened = true;
    marketRestriction = "goals_over_only";
    reasons.push("friendly");
    // Time-format loophole (non-90-min friendlies skew Overs further, e.g.
    // 2x30/3x20 exhibition formats): no duration/period/format field exists
    // anywhere in SportyBetEvent/SportyBetEventDetail (checked
    // selectFixtures.ts in full — the sidecar only ever captures
    // full-fixture odds/stats, never a match-length signal). Documenting the
    // gap per instructions rather than inventing one — add a
    // `nonstandard_duration` reason here the day such a field exists.
  }

  // 3. Missing 1X2 or O/U 2.5 odds — Rule 0 mandatory pre-check, discard.
  const odds = event.detail?.odds;
  const has1x2 = odds?.["1x2"]?.home != null && odds?.["1x2"]?.away != null;
  const hasOu25 = odds?.ou25?.over != null;
  if (!has1x2 || !hasOu25) {
    return { status: "discard", reasons: ["missing_mandatory_odds"] };
  }

  // 4. League whitelist is no longer a gate — see module docstring (89/99
  //    fixtures wrongly discarded 2026-07-10, incl. FIFA World Cup Spain v
  //    Belgium under a non-exact league label). Off-list leagues survive
  //    with a non-gating annotation; GOALS_V3_WHITELIST stays exported for
  //    priority/workbook ordering elsewhere.
  if (!GOALS_V3_WHITELIST.has(league)) reasons.push("off_whitelist");

  // 5. §1.2 low-scoring derby guard — now heightened, not discard.
  // International tournaments are exempt (same convention as the leg-level
  // gate); goals-rich leagues keep their Tier-A designation even when a
  // fixture name carries derby wording.
  if (
    !INTL_TOURNAMENT_RE.test(league) &&
    !GOALS_RICH_LEAGUES.has(league) &&
    /derby|derbi|clasico|clásico/i.test(text)
  ) {
    heightened = true;
    reasons.push("derby");
  }

  // 6. Youth / women / cup-final → heightened (unchanged).
  if (YOUTH_RE.test(text)) {
    heightened = true;
    reasons.push("youth");
  }
  if (WOMEN_RE.test(text)) {
    heightened = true;
    reasons.push("women");
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

  return {
    status: heightened ? "heightened" : "eligible",
    reasons,
    ...(marketRestriction ? { marketRestriction } : {}),
  };
}
