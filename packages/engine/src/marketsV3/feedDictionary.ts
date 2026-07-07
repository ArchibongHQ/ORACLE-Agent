/** all-markets-analysis-prompt-v3 §0.2 — the feed dictionary.
 *
 *  Maps one raw SportyBet AllMarketEntry (market name + family + EXACT
 *  specifier) to the v3 engine that can price it, or to an explicit skip with
 *  a reason. Rule 0: anything unmapped is skipped, never guessed; a probability
 *  is only ever computed by an engine that derives it from the score grid or a
 *  dedicated module.
 *
 *  Specifier grammar observed in the committed market catalog
 *  (markets/catalog.generated.ts):
 *    total=<num> · minsnr=<num>|total=<num> · minute=<num>|total=<num> ·
 *    hcp=<num> · hcp=<h>:<a> · score=<h>:<a> · variant=<val> ·
 *    goalnr=<num> · from=<num>|to=<num>
 *
 *  Pure classification, no I/O. */

import { familyOf, type MarketFamily } from "../markets/index.js";
import type { AllMarketEntry } from "../types.js";

export type V3Engine =
  | "totals"
  | "result"
  | "shape"
  | "half"
  | "time"
  | "exotics"
  | "corners"
  | "cards"
  | "shots";

export interface V3Route {
  engine: V3Engine;
  family: MarketFamily;
  /** Which half a half-engine market prices (absent = market spans both, e.g.
   *  win-both-halves / highest scoring half). */
  half?: 1 | 2;
  /** Parsed `total=` line. */
  total?: number;
  /** Parsed `minsnr=`/`minute=` cutoff for the time engine. */
  minute?: number;
  /** Parsed numeric Asian handicap line (`hcp=<num>`). */
  hcpNum?: number;
  /** Parsed European handicap head start (`hcp=<h>:<a>`). */
  hcpScore?: [number, number];
  /** Parsed `from=` minimum goals for multigoals (exotics engine). */
  from?: number;
  /** Parsed `to=` maximum goals for multigoals (exotics engine). */
  to?: number;
  /** PR-22: which corners/cards sub-shape to price. Absent = the original
   *  match-total O/U path (unchanged pre-PR-22 behavior). */
  variant?: "1x2" | "handicap" | "range" | "odd-even" | "team-total";
  /** PR-22: team-scoped corners/cards side (team-total O/U, team range). */
  side?: "home" | "away";
}

export interface V3Skip {
  skip: true;
  /** Stable reason id for coverage telemetry. */
  reason:
    | "player-market"
    | "plain-1x2"
    | "non-goal-metric"
    | "corners-dormant"
    | "cards-dormant"
    | "settlement-variant"
    | "no-grid-model"
    | "uncatalogued"
    | "bad-specifier"
    | "shots-dormant";
}

export type V3Routing = V3Route | V3Skip;

export function isSkip(r: V3Routing): r is V3Skip {
  return (r as V3Skip).skip === true;
}

/** Exact specifier parse — `total=3.5`, `minsnr=10|total=1.5`, `hcp=0:1`… */
export function parseSpecifier(spec: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!spec) return out;
  for (const part of spec.split("|")) {
    const eq = part.indexOf("=");
    if (eq > 0) out.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  return out;
}

const num = (v: string | undefined): number | undefined => {
  if (v == null) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

const score = (v: string | undefined): [number, number] | undefined => {
  const m = v?.match(/^(\d+)\s*:\s*(\d+)$/);
  return m ? [Number.parseInt(m[1] ?? "0", 10), Number.parseInt(m[2] ?? "0", 10)] : undefined;
};

/** Markets measured in something other than goals — never priceable off the
 *  score grid regardless of family tag (e.g. "Fouls Over/Under" is catalogued
 *  under goals_ou). Corners/cards have their own §3.9 conditional modules. */
const CORNERS_RE = /corner/;
const CARDS_RE = /booking|card|sending off|red card|yellow/;
/** PR-22: carved out of OTHER_METRIC_RE below — "shots on target" (not plain
 *  "shots", which stays a non-goal-metric skip) has real season data
 *  (sportyBetStats.ts's possessionValue.{home,away}.shots_on_target_avg) and
 *  its own §3.9-style NB module (engines/shots.ts). Checked BEFORE
 *  OTHER_METRIC_RE, which would otherwise catch it via its own `shot` term. */
const SHOTS_ON_TARGET_RE = /shots? on target/;
const OTHER_METRIC_RE = /foul|offside|shot|throw[- ]in|goal kick|free kick|penalt(y|ies) awarded/;
const PLAYER_RE = /goalscorer|player|scorer/;
/** Early-payout / altered-settlement variants of standard markets — the price
 *  is not comparable to the grid probability of the printed outcome. */
const SETTLEMENT_RE = /\b[12]up\b|to qualify|winning method|overtime|penalt(y|ies)$|extra time/;
const HALF_RE = /^(1st|2nd) half|half ?time(?!\/)|^ht\b/;

/** PR-22 corners/cards sub-shape detectors — checked against the already-
 *  lowercased market name. "range"/"exact" never co-occur across the two
 *  groups in the observed catalog (corners says "range", bookings says
 *  "exact") so one combined pattern is safe for both callers. */
const CC_1X2_RE = /^(corners|bookings) 1x2$/;
const CC_HANDICAP_RE = /handicap/;
const CC_RANGE_RE = /range|exact/;
const CC_ODD_EVEN_RE = /odd\/even/;
const CC_TEAM_SIDE_RE = /^(home|away) team/;

/** Shared corners/cards sub-router — both groups have the identical shape
 *  taxonomy (match 1X2/handicap/range/odd-even/team-total + team-scoped
 *  range/exact + a dormant tail), just different family/engine tags, and
 *  (odd-even) cards has no such market at all. Always returns a route or an
 *  explicit skip — never null; the caller returns whatever this produces
 *  directly. */
function routeCornersLike(
  name: string,
  spec: Map<string, string>,
  engine: "corners" | "cards",
  dormantReason: "corners-dormant" | "cards-dormant"
): V3Routing {
  if (HALF_RE.test(name)) return { skip: true, reason: dormantReason };
  const family = engine; // "corners"/"cards" MarketFamily values match the engine name 1:1.
  if (CC_1X2_RE.test(name)) return { engine, family, variant: "1x2" };
  if (CC_HANDICAP_RE.test(name)) return { engine, family, variant: "handicap" };
  if (engine === "corners" && CC_ODD_EVEN_RE.test(name)) {
    return { engine, family, variant: "odd-even" };
  }
  const side = CC_TEAM_SIDE_RE.test(name) ? (name.startsWith("home") ? "home" : "away") : undefined;
  if (CC_RANGE_RE.test(name)) return { engine, family, variant: "range", side };
  const total = num(spec.get("total"));
  // Team-scoped O/U ("Home Team Total Corners"/"Home Team Total Bookings",
  // catalog ids 900300/900301/900304/900305): the NAME never literally says
  // "over/under" — only the OUTCOMES do ("Over 1.5"/"Under 1.5") — so `side`
  // + a total= specifier is the actual signal, not the name substring the
  // match-total path below checks.
  if (side !== undefined && total !== undefined) {
    return { engine, family, variant: "team-total", side, total };
  }
  // Match-total O/U ("Corners - Over/Under"/"Bookings - Over/Under", ids
  // 166/139) — the pre-PR-22 path, name literally contains "over/under".
  if (name.includes("over/under")) {
    return total !== undefined
      ? { engine, family, total }
      : { skip: true, reason: "bad-specifier" };
  }
  return { skip: true, reason: dormantReason };
}

/** PR-22: "Shots on Target Over/Under" (id 900393, match total, full phrase
 *  "over/under") and its team-scoped variants (ids 900546/900547 "Home/Away
 *  Team Shots on Target O/U" — the ABBREVIATED "O/U", not the full phrase, so
 *  this keys off the structured total= specifier instead of a name-text match
 *  for either spelling). "Shots on Target 1X2" (id 900318, no total=
 *  specifier) has no matching model here (no 1X2/handicap treatment for
 *  shots — see shots.ts's header) and falls through to the dormant skip. */
function routeShotsOnTarget(name: string, spec: Map<string, string>): V3Routing {
  const total = num(spec.get("total"));
  if (total === undefined) return { skip: true, reason: "shots-dormant" };
  const side = CC_TEAM_SIDE_RE.test(name) ? (name.startsWith("home") ? "home" : "away") : undefined;
  return { engine: "shots", family: "shots", side, total };
}

/** Route one market entry. Never throws; unparseable ⇒ skip (Rule 0). */
export function routeMarket(entry: AllMarketEntry): V3Routing {
  const family = familyOf(entry.id);
  const name = (entry.name ?? entry.desc ?? "").toLowerCase().trim();
  const spec = parseSpecifier(entry.specifier);

  // Metric guards run before family routing — they trump the catalogue tag.
  if (PLAYER_RE.test(name)) return { skip: true, reason: "player-market" };
  // Corners/cards: the match-total Over/Under shape (catalog ids 166/139) plus
  // the PR-22 variants below are priceable via the §3.9 NB/Poisson modules —
  // everything else under these groups (Xth corner/booking, points-weighted
  // "Total Booking Points", red-card-specific "Sending Off", all 1st-half
  // variants) has no parseable shape or no matching underlying stat and stays
  // dormant. The catalog tags these "specials" (a forced-X family); assign the
  // dedicated "corners"/"cards" family here so they class by odds band like a
  // normal single-event market instead.
  if (CORNERS_RE.test(name)) return routeCornersLike(name, spec, "corners", "corners-dormant");
  if (CARDS_RE.test(name)) return routeCornersLike(name, spec, "cards", "cards-dormant");
  // Checked before OTHER_METRIC_RE, which would otherwise catch "shots on
  // target" via its own generic `shot` term (see SHOTS_ON_TARGET_RE comment).
  if (SHOTS_ON_TARGET_RE.test(name)) return routeShotsOnTarget(name, spec);
  if (OTHER_METRIC_RE.test(name)) return { skip: true, reason: "non-goal-metric" };
  if (SETTLEMENT_RE.test(name)) return { skip: true, reason: "settlement-variant" };

  if (!family) {
    // Uncatalogued id (market added since last catalog regeneration): only the
    // unambiguous goal-total shape is safe to price; everything else waits for
    // a catalog rebuild.
    const total = num(spec.get("total"));
    if (!HALF_RE.test(name) && name.includes("over/under") && total !== undefined) {
      return { engine: "totals", family: "goals_ou", total };
    }
    return { skip: true, reason: "uncatalogued" };
  }

  const isHalf = HALF_RE.test(name) || family === "half";

  switch (family) {
    case "match_result": {
      // Plain 1X2 is never a candidate (§3.4 insurance mandate); minute-window
      // 1X2 has no grid model.
      return { skip: true, reason: "plain-1x2" };
    }
    case "double_chance":
    case "dnb":
    case "winning_margin":
      return isHalf
        ? { engine: "half", family, half: name.startsWith("2nd") ? 2 : 1 }
        : { engine: "result", family };
    case "asian_handicap":
    case "handicap": {
      const hcpRaw = spec.get("hcp");
      const hcpScore = score(hcpRaw);
      const hcpNum = hcpScore ? undefined : num(hcpRaw);
      if (isHalf) return { skip: true, reason: "no-grid-model" }; // half AH: no half-calibrated push model
      return { engine: "result", family, hcpNum, hcpScore };
    }
    case "goals_ou": {
      const total = num(spec.get("total"));
      const minute = num(spec.get("minsnr")) ?? num(spec.get("minute"));
      if (minute !== undefined) {
        return total !== undefined
          ? { engine: "time", family, minute, total }
          : { skip: true, reason: "bad-specifier" };
      }
      if (isHalf) return { engine: "half", family, half: name.startsWith("2nd") ? 2 : 1, total };
      return total !== undefined
        ? { engine: "totals", family, total }
        : { engine: "totals", family }; // line may live in the outcome desc
    }
    case "multigoals": {
      const from = num(spec.get("from"));
      const to = num(spec.get("to"));
      if (isHalf) return { engine: "half", family, half: name.startsWith("2nd") ? 2 : 1 };
      return { engine: "exotics", family, from, to };
    }
    case "exact_goals":
    case "odd_even":
      if (isHalf) return { engine: "half", family, half: name.startsWith("2nd") ? 2 : 1 };
      return { engine: family === "odd_even" ? "totals" : "exotics", family };
    case "team_total": {
      const total = num(spec.get("total"));
      if (isHalf) return { engine: "half", family, half: name.startsWith("2nd") ? 2 : 1, total };
      return { engine: "shape", family, total };
    }
    case "btts":
      // ids 56/57 ("To Score In Both Halves") span both halves → half engine.
      if (name.includes("both halves") || isHalf) return { engine: "half", family };
      return { engine: "shape", family };
    case "clean_sheet":
    case "win_to_nil":
    case "which_team_scores":
      if (isHalf) return { engine: "half", family };
      return { engine: "shape", family };
    case "half":
      return { engine: "half", family, half: name.startsWith("2nd") ? 2 : 1 };
    case "highest_scoring_half":
      return { engine: "half", family };
    case "correct_score": {
      if (isHalf) return { skip: true, reason: "no-grid-model" };
      return { engine: "exotics", family };
    }
    case "ht_ft":
      return { engine: "exotics", family };
    case "combo": {
      const total = num(spec.get("total"));
      if (isHalf) return { skip: true, reason: "no-grid-model" };
      return { engine: "exotics", family, total };
    }
    case "specials":
    case "exotic":
      return { skip: true, reason: "no-grid-model" };
    default:
      return { skip: true, reason: "no-grid-model" };
  }
}

/** Coverage telemetry over a fixture's whole catalogue — Phase 8 reports the
 *  routed/skip split so unmapped long-tail growth is visible, never silent. */
export interface RouteCoverage {
  total: number;
  routed: number;
  byEngine: Record<V3Engine, number>;
  skipped: Record<V3Skip["reason"], number>;
  /** PR-20: distinct market NAMES behind the recoverable skip tail
   *  (no-grid-model / uncatalogued / bad-specifier) → entry count. Principled
   *  skips (player/settlement/1x2/non-goal-metric/dormant) stay counts-only in
   *  `skipped` — they are excluded by design, not by gap. */
  unrouted?: Record<string, number>;
}

/** Skip reasons whose market names are worth itemising — the recoverable tail. */
const UNROUTED_TAIL_REASONS = new Set<V3Skip["reason"]>([
  "no-grid-model",
  "uncatalogued",
  "bad-specifier",
]);

export function routeCoverage(entries: AllMarketEntry[]): RouteCoverage {
  const byEngine: Record<V3Engine, number> = {
    totals: 0,
    result: 0,
    shape: 0,
    half: 0,
    time: 0,
    exotics: 0,
    corners: 0,
    cards: 0,
    shots: 0,
  };
  const skipped: Record<V3Skip["reason"], number> = {
    "player-market": 0,
    "plain-1x2": 0,
    "non-goal-metric": 0,
    "corners-dormant": 0,
    "cards-dormant": 0,
    "settlement-variant": 0,
    "no-grid-model": 0,
    uncatalogued: 0,
    "bad-specifier": 0,
    "shots-dormant": 0,
  };
  let routed = 0;
  const unrouted: Record<string, number> = {};
  for (const entry of entries) {
    const r = routeMarket(entry);
    if (isSkip(r)) {
      skipped[r.reason] += 1;
      if (UNROUTED_TAIL_REASONS.has(r.reason)) {
        const name = entry.name ?? entry.desc ?? `id:${entry.id}`;
        unrouted[name] = (unrouted[name] ?? 0) + 1;
      }
    } else {
      routed += 1;
      byEngine[r.engine] += 1;
    }
  }
  return { total: entries.length, routed, byEngine, skipped, unrouted };
}
