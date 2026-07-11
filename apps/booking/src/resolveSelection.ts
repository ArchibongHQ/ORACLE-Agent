/** Pure matcher: resolves ORACLE's mapped market/outcome target against a real
 *  SportyBet event's market list. Isolated from index.ts's fetch/POST flow so
 *  the matching rules — the actual fix for the wrong-market-bind incident —
 *  are independently testable and never bypassed by a loose fallback.
 *
 *  Root cause this replaces: the old inline matcher normalised away decimal
 *  points then matched bidirectionally with String.includes(), so "Over 1.5"
 *  ("over 15" after normalising) matched the outcome "Over 1" ("over 1" is a
 *  substring of "over 15"), and a bare "Total" market header matched into
 *  "Home Team Total" the same way (`"home team total".includes("total")`).
 *  This module fixes both: `normalise` here KEEPS the decimal point, header/
 *  outcome comparison is exact-equality (or a strictly one-directional,
 *  word-boundary-anchored prefix) — never substring-in-either-direction —
 *  the line is verified against the market's specifier (or, when the
 *  specifier carries no line, an exact numeric token in the outcome text)
 *  separately from the outcome's direction, and every surviving candidate is
 *  collected before deciding: a single survivor is matched, none is
 *  unmatched, and MORE THAN ONE distinct survivor is "ambiguous" rather than
 *  "first loose match wins". A final odds sanity check catches anything that
 *  still slipped through. A leg that fails any gate is unmatched, with a
 *  reason, never guessed — more unmatched legs is the accepted trade-off. */

import type { MarketMapping } from "./marketMap.js";

export interface SportyBetOutcome {
  id: string;
  desc?: string | null;
  odds?: string | null;
}

export interface SportyBetMarket {
  id: string;
  name?: string | null;
  desc?: string | null;
  specifier?: string | null;
  outcomes?: SportyBetOutcome[];
}

export interface SportyBetEventData {
  eventId: string;
  gameId: string | number;
  sportId?: string;
  estimateStartTime?: number;
  markets?: SportyBetMarket[];
}

/** What resolveSelection needs beyond the raw event data: the mapped target
 *  (market/outcome/line/family, from marketMap's mapMarket) plus the odds the
 *  engine itself priced the pick at, for the final sanity guard. */
export interface MappedPickTarget {
  mapping: MarketMapping;
  odds: number;
}

export interface ResolvedSelection {
  marketId: string;
  specifier: string;
  outcomeId: string;
  odds: number;
  label: string;
}

export type UnmatchedReason =
  | "no_market_header"
  | "no_outcome"
  | "ambiguous"
  | "odds_mismatch"
  | "suspended";

export interface Unmatched {
  reason: UnmatchedReason;
}

export type SelectionResolution =
  | { matched: true; selection: ResolvedSelection }
  | { matched: false; unmatched: Unmatched };

/** Relative tolerance for the final odds sanity guard — a resolved
 *  selection whose odds differ from the engine's own priced odds by more
 *  than this fraction is treated as a wrong-market bind, not live-price
 *  drift. */
export const ODDS_MISMATCH_TOLERANCE = 0.25;

/** Normalise for exact-equality comparison: lowercase, turn punctuation into
 *  spaces, collapse whitespace — but KEEP the decimal point, so "Over 1.5"
 *  never collapses onto "Over 1" or "Over 15" the way the old matcher's
 *  digit-stripping normalise() did (marketMap.ts's normalise() is a
 *  different function, for a different purpose — its decimal-stripping is
 *  intentional there; do not conflate the two). */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse a SportyBet specifier string ("total=1.5", "hcp=0:1|foo=bar") into a
 *  key -> value map. Same "|"-joined "key=value" grammar documented in
 *  packages/engine/src/marketsV3/feedDictionary.ts's parseSpecifier. */
function parseSpecifier(spec: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!spec) return out;
  for (const part of spec.split("|")) {
    const eq = part.indexOf("=");
    if (eq > 0) out.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  return out;
}

/** Strip a trailing signed/unsigned decimal line off a selection string, e.g.
 *  "Over 1.5" -> "Over", "Home -0.5" -> "Home". mapMarket's hand-rolled
 *  branches always append the line as the LAST token, so an end-anchored
 *  strip is exact here, not a guess. */
function stripTrailingLine(selection: string): string {
  return selection.replace(/\s*[+-]?\d+(?:\.\d+)?\s*$/, "").trim();
}

/** Specifier keys the SportyBet grammar uses to carry a market's line/range
 *  (see feedDictionary.ts's documented grammar). Used both to read a
 *  candidate's line and, for a line-free pick, to reject a candidate whose
 *  specifier carries one anyway (e.g. a plain "1X2" pick must never bind a
 *  "1X2" market that turns out to be a minute-window variant). */
const LINE_SPEC_KEYS = ["total", "hcp", "goalnr", "from", "to", "score"];

function specifierHasLine(spec: Map<string, string>): boolean {
  return LINE_SPEC_KEYS.some((k) => spec.has(k));
}

/** True when the candidate market's specifier resolves to the SAME line the
 *  pick was mapped to. Handles "total=1.5" and plain numeric "hcp=1.5"/
 *  "hcp=-0.5" directly; "hcp=<h>:<a>" (a European handicap head-start score)
 *  is a different shape from mapMarket's single-decimal Asian line and never
 *  matches here — it falls through to the outcome-text check below, which
 *  also won't find a matching numeric token, so it correctly ends up
 *  unmatched rather than guessing. Signed lines (Asian Handicap, e.g.
 *  mapping "-0.5"/"+0.5") are compared by magnitude — SportyBet's own hcp=
 *  sign convention (home-relative vs. side-relative) isn't confirmed live,
 *  and matching on magnitude alone still rejects any cross-LINE bind (0.5 vs
 *  1.5), which is the actual incident this module fixes; it just doesn't
 *  additionally enforce a sign convention that hasn't been verified against
 *  a real fixture yet. */
function specifierLineMatches(spec: Map<string, string>, line: number): boolean {
  const total = spec.get("total");
  if (total !== undefined) {
    const n = Number.parseFloat(total);
    return Number.isFinite(n) && Math.abs(n - line) < 1e-9;
  }
  const hcp = spec.get("hcp");
  if (hcp !== undefined && /^[+-]?\d+(?:\.\d+)?$/.test(hcp)) {
    const n = Number.parseFloat(hcp);
    return Number.isFinite(n) && Math.abs(Math.abs(n) - Math.abs(line)) < 1e-9;
  }
  return false;
}

/** True when the exact line token (e.g. "1.5") appears in the normalised
 *  outcome text as its own number, not as part of a longer digit run — the
 *  fallback for the real-API shape where the line lives in the outcome desc
 *  rather than the market specifier (mirrors execution/index.ts's identical
 *  `specLc.match(total=) ?? descLc.match(...)` fallback pattern). */
function outcomeContainsLineToken(normalisedDesc: string, line: number): boolean {
  const token = Math.abs(line).toString().replace(/\./g, "\\.");
  return new RegExp(`(^|[^0-9.])${token}($|[^0-9.])`).test(normalisedDesc);
}

/** True when `headerNorm` matches `marketNorm` per the anchored rule: exact
 *  normalized equality first, else `headerNorm` extends `marketNorm` with a
 *  further word-boundary-anchored qualifier (`headerNorm` STARTS WITH
 *  `marketNorm` + a space) — never the reverse, and never plain substring-
 *  in-either-direction (the old bug: `"home team total".includes("total")`
 *  let a bare "Total" match-total header pass the "Home Team Total" gate). */
function headerMatches(headerNorm: string, marketNorm: string): boolean {
  if (headerNorm === marketNorm) return true;
  return headerNorm.startsWith(`${marketNorm} `);
}

interface Candidate {
  marketId: string;
  specifier: string;
  outcomeId: string;
  odds: number;
  label: string;
}

/** Resolve one mapped pick target against one event's real market list.
 *  Never throws. Collects every (market, outcome) pair that survives the
 *  header, line, and outcome-direction gates before deciding — a single
 *  survivor is matched, none is unmatched, and more than one distinct
 *  survivor is "ambiguous" rather than picking whichever came first. */
export function resolveSelection(
  eventData: SportyBetEventData,
  target: MappedPickTarget
): SelectionResolution {
  const { mapping, odds: targetOdds } = target;
  const marketNorm = normalise(mapping.sportyMarket);
  const fullSelNorm = normalise(mapping.sportySelection);
  const directionNorm =
    mapping.line !== undefined ? normalise(stripTrailingLine(mapping.sportySelection)) : null;

  const candidates: Candidate[] = [];
  let sawHeader = false;
  let sawSuspended = false;

  for (const mkt of eventData.markets ?? []) {
    const headerNorm = normalise(mkt.name ?? mkt.desc ?? "");
    if (!headerMatches(headerNorm, marketNorm)) continue;
    sawHeader = true;

    const spec = parseSpecifier(mkt.specifier);
    for (const outcome of mkt.outcomes ?? []) {
      const descNorm = normalise(outcome.desc ?? "");
      const directionOk =
        descNorm === fullSelNorm || (directionNorm !== null && descNorm === directionNorm);
      if (!directionOk) continue;

      const lineOk =
        mapping.line === undefined
          ? !specifierHasLine(spec)
          : specifierLineMatches(spec, mapping.line) ||
            outcomeContainsLineToken(descNorm, mapping.line);
      if (!lineOk) continue;

      const oddsNum = Number.parseFloat(outcome.odds ?? "0");
      if (!(oddsNum > 1)) {
        sawSuspended = true;
        continue;
      }

      candidates.push({
        marketId: mkt.id,
        specifier: mkt.specifier ?? "",
        outcomeId: outcome.id,
        odds: oddsNum,
        label: outcome.desc ?? mapping.sportySelection,
      });
    }
  }

  if (!sawHeader) return { matched: false, unmatched: { reason: "no_market_header" } };

  const distinct = new Map<string, Candidate>();
  for (const c of candidates) distinct.set(`${c.marketId}:${c.outcomeId}`, c);

  if (distinct.size === 0) {
    return { matched: false, unmatched: { reason: sawSuspended ? "suspended" : "no_outcome" } };
  }
  if (distinct.size > 1) return { matched: false, unmatched: { reason: "ambiguous" } };

  // distinct.size === 1 here (checked above), so this always has a value —
  // the fallback branch is a type-narrowing safety net, not reachable logic.
  const only = [...distinct.values()][0];
  if (!only) return { matched: false, unmatched: { reason: "no_outcome" } };

  const relDiff = Math.abs(only.odds - targetOdds) / targetOdds;
  if (!(relDiff <= ODDS_MISMATCH_TOLERANCE)) {
    return { matched: false, unmatched: { reason: "odds_mismatch" } };
  }

  return { matched: true, selection: only };
}
