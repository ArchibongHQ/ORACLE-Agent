/** [WS3-B, Wave 3] Legacy-vs-v3 market parity harness — NOT a unit test itself
 *  (no vitest imports here, same convention as backtestLowScoringThresholds.ts
 *  in this directory; see ../pricerParity.test.ts for the thin runner that
 *  actually asserts the coverage property under `pnpm test`).
 *
 *  What this replays and why there's no real historical slate JSON: the plan
 *  asks to "replay stored slates" the way the France-v-Morocco regression test
 *  replays a captured incident. No committed historical full-markets-catalogue
 *  JSON snapshot exists anywhere in this repo to replay, though — `.tmp/` (the
 *  only place real scraped `allMarkets` payloads ever land) is disposable and
 *  gitignored per this repo's own convention (see CLAUDE.md's File Structure
 *  section), so nothing there is available on a fresh clone or in CI. The 7
 *  slates below are therefore SYNTHETIC-but-realistic: built from real
 *  SportyBet catalog ids/names/outcome shapes (packages/engine/src/markets/
 *  catalog.generated.ts, tools/build_market_catalog.py's committed output),
 *  covering 7 distinct real-world fixture profiles (standard top-flight,
 *  half-markets-heavy, corners/cards/shots, the confirmed compound-scoreline
 *  gap, a fresh/uncatalogued-market slate, a thin low-liquidity slate, and an
 *  exotics-heavy slate). This is reported honestly as 7 synthetic slates, not
 *  claimed as real historical data.
 *
 *  Method: for every (market, outcome) pair across all 7 slates, determine
 *  (a) whether the LEGACY pricer (execution/index.ts's scanMarkets structural
 *  family coverage + scanAllMarketsFallback's priceAllMarketOutcome shape
 *  matchers — read-only reference, mirrored here since that file is owned by
 *  a parallel Wave-3 workstream and not importable/editable this wave) would
 *  produce a priced candidate for it, and (b) whether v3 actually prices it
 *  (routeMarket routes it AND analyzeFixtureMarketsV3 produces a real
 *  assessment — routing alone isn't enough, see the id-46 case in
 *  marketsV3/unpriced.ts's header). Any (a)-true/(b)-false pair must be
 *  registered in marketsV3/unpriced.ts's UNPRICED_BY_DESIGN with a reason, or
 *  it's an unaudited parity gap and the coverage assertion fails. */

import {
  type AllMarketEntry,
  analyzeFixtureMarketsV3,
  isMarketIdRegistered,
  isSkipRegistered,
  noGridModelSubKey,
  routeMarket,
  type V3AllMarketsInput,
} from "../../src/index.js";
import { familyOf } from "../../src/markets/index.js";

// ── Synthetic slates ─────────────────────────────────────────────────────────
// Real catalog ids/names/outcome shapes throughout (cross-checked against
// packages/engine/src/markets/catalog.generated.ts as of 2026-07-10).

export interface PricerParitySlate {
  name: string;
  league: string;
  allMarkets: AllMarketEntry[];
}

const o = (id: string, desc: string, odds: string) => ({ id, desc, odds });

const SLATE_1_STANDARD: AllMarketEntry[] = [
  {
    id: "1",
    name: "1X2",
    outcomes: [o("1", "Home", "1.90"), o("2", "Draw", "3.60"), o("3", "Away", "4.20")],
  },
  {
    id: "10",
    name: "Double Chance",
    outcomes: [
      o("1", "Home or Draw", "1.25"),
      o("2", "Home or Away", "1.10"),
      o("3", "Draw or Away", "2.10"),
    ],
  },
  { id: "11", name: "Draw No Bet", outcomes: [o("1", "Home", "1.55"), o("2", "Away", "2.35")] },
  {
    id: "16",
    name: "Handicap",
    specifier: "hcp=-0.5",
    outcomes: [o("1", "Home (-0.5)", "1.95"), o("2", "Away (+0.5)", "1.85")],
  },
  {
    id: "18",
    name: "Over/Under",
    specifier: "total=2.5",
    outcomes: [o("1", "Over 2.5", "1.85"), o("2", "Under 2.5", "1.95")],
  },
  {
    id: "19",
    name: "Home O/U",
    specifier: "total=1.5",
    outcomes: [o("1", "Over 1.5", "2.20"), o("2", "Under 1.5", "1.65")],
  },
  { id: "21", name: "Exact Goals", specifier: "variant=match", outcomes: [o("1", "6+", "8.00")] },
  { id: "26", name: "Odd/Even", outcomes: [o("1", "Odd", "1.90"), o("2", "Even", "1.90")] },
  { id: "29", name: "GG/NG", outcomes: [o("1", "Yes", "1.80"), o("2", "No", "2.00")] },
  {
    id: "41",
    name: "Correct score [x:y]",
    specifier: "score=2:1",
    outcomes: [o("1", "2:1", "9.00")],
  },
  {
    id: "35",
    name: "1X2 & GG/NG",
    outcomes: [o("1", "Home & yes", "3.20")],
  },
];

const SLATE_2_HALF_HEAVY: AllMarketEntry[] = [
  {
    id: "1",
    name: "1X2",
    outcomes: [o("1", "Home", "1.70"), o("2", "Draw", "3.80"), o("3", "Away", "5.00")],
  },
  {
    id: "47",
    name: "Halftime/Fulltime",
    outcomes: [o("1", "Home/Home", "2.60"), o("5", "Draw/Draw", "6.00")],
  },
  {
    id: "48",
    name: "Home To Win Both Halves",
    outcomes: [o("1", "Yes", "4.50"), o("2", "No", "1.18")],
  },
  {
    id: "50",
    name: "Home To Win Either Half",
    outcomes: [o("1", "Yes", "1.45"), o("2", "No", "2.70")],
  },
  {
    id: "51",
    name: "Away To Win Either Half",
    outcomes: [o("1", "Yes", "3.40"), o("2", "No", "1.30")],
  },
  {
    id: "52",
    name: "Highest Scoring Half",
    outcomes: [o("1", "1st half", "2.30"), o("2", "2nd half", "1.95"), o("3", "Equal", "3.50")],
  },
  {
    id: "18",
    name: "1st Half Over/Under",
    specifier: "total=0.5",
    outcomes: [o("1", "Over 0.5", "1.55"), o("2", "Under 0.5", "2.35")],
  },
  {
    id: "10",
    name: "1st Half Double Chance",
    outcomes: [o("1", "Home or Draw", "1.05"), o("2", "Draw or Away", "1.90")],
  },
];

const SLATE_3_CORNERS_CARDS_SHOTS: AllMarketEntry[] = [
  {
    id: "1",
    name: "1X2",
    outcomes: [o("1", "Home", "2.05"), o("2", "Draw", "3.30"), o("3", "Away", "3.50")],
  },
  {
    id: "166",
    name: "Total Corners Over/Under",
    specifier: "total=9.5",
    outcomes: [o("1", "Over 9.5", "1.90"), o("2", "Under 9.5", "1.90")],
  },
  {
    // Real catalog id (catalog.generated.ts) — signed-decimal specifier/desc,
    // the only format priceCornersLikeHandicap (engines/corners.ts) actually
    // parses; verified against marketsV3CornersCards.test.ts's own pricing
    // coverage. An earlier "900999"/hcp=0:2 colon-notation draft of this
    // entry was a fabricated id with no precedent anywhere in the catalog or
    // this codebase's pricing tests (which only ever exercise signed-decimal
    // descs for this variant) — replaced rather than guessed at, per this
    // harness's own "decline over silent mispricing" convention.
    id: "165",
    name: "Corner Handicap",
    specifier: "hcp=1.5",
    outcomes: [o("1", "Home (+1.5)", "1.90"), o("2", "Away (-1.5)", "1.90")],
  },
  {
    id: "139",
    name: "Total Cards Over/Under",
    specifier: "total=5.5",
    outcomes: [o("1", "Over 5.5", "1.95"), o("2", "Under 5.5", "1.85")],
  },
  {
    id: "900393",
    name: "Shots on Target Over/Under",
    specifier: "total=8.5",
    outcomes: [o("1", "Over 8.5", "1.90"), o("2", "Under 8.5", "1.90")],
  },
  {
    id: "900998",
    name: "1st Half Corners Over/Under",
    specifier: "total=4.5",
    outcomes: [o("1", "Over 4.5", "1.90"), o("2", "Under 4.5", "1.90")],
  },
];

const SLATE_4_COMPOUND_SCORELINE_GAP: AllMarketEntry[] = [
  {
    id: "1",
    name: "1X2",
    outcomes: [o("1", "Home", "2.40"), o("2", "Draw", "3.20"), o("3", "Away", "2.85")],
  },
  {
    id: "46",
    name: "Halftime/fulltime correct score",
    outcomes: [o("1", "0:0 0:0", "12.00"), o("2", "1:0 2:1", "18.00")],
  },
  {
    id: "818",
    name: "Halftime/Fulltime & Total",
    outcomes: [o("1", "1:0 2:1 & Over 2.5", "35.00")],
  },
];

const SLATE_5_FRESH_UNCATALOGUED: AllMarketEntry[] = [
  {
    id: "1",
    name: "1X2",
    outcomes: [o("1", "Home", "1.60"), o("2", "Draw", "4.00"), o("3", "Away", "5.50")],
  },
  {
    // A genuinely new market id SportyBet added since the last catalog
    // regeneration — odd/even shape, unambiguous regardless of catalog
    // status (mirrors legacy's uncatalogued tolerance; see the WS3-B port
    // in feedDictionary.ts's `!family` branch).
    id: "999101",
    name: "Total Goals Odd/Even",
    outcomes: [o("1", "Odd", "1.90"), o("2", "Even", "1.90")],
  },
  {
    // Same idea for correct-score.
    id: "999102",
    name: "Correct Score",
    outcomes: [o("1", "2-1", "9.50")],
  },
  {
    // A genuinely uncatalogued, non-goal-derivable market — must stay
    // "uncatalogued" (no safe shape to route), same as before this wave.
    id: "999103",
    name: "Special Betting Offer Xyz",
    outcomes: [o("1", "Some Outcome", "3.00")],
  },
];

const SLATE_6_THIN_LOW_LIQUIDITY: AllMarketEntry[] = [
  {
    id: "1",
    name: "1X2",
    outcomes: [o("1", "Home", "2.10"), o("2", "Draw", "3.10"), o("3", "Away", "3.60")],
  },
  {
    id: "18",
    name: "Over/Under",
    specifier: "total=2.5",
    outcomes: [o("1", "Over 2.5", "2.00"), o("2", "Under 2.5", "1.80")],
  },
];

const SLATE_7_EXOTICS_HEAVY: AllMarketEntry[] = [
  {
    id: "1",
    name: "1X2",
    outcomes: [o("1", "Home", "1.85"), o("2", "Draw", "3.50"), o("3", "Away", "4.50")],
  },
  {
    id: "15",
    name: "Winning Margin",
    specifier: "variant=match",
    outcomes: [o("1", "Home by 1", "4.50"), o("7", "Draw", "3.60")],
  },
  {
    id: "30",
    name: "Which Team To Score",
    outcomes: [
      o("1", "None", "12.00"),
      o("2", "Only Home", "3.20"),
      o("3", "Only Away", "5.50"),
      o("4", "Both teams", "1.80"),
    ],
  },
  {
    id: "31",
    name: "Home Team Clean Sheet",
    outcomes: [o("1", "Yes", "3.30"), o("2", "No", "1.32")],
  },
  {
    id: "33",
    name: "Home Team Win To Nil",
    outcomes: [o("1", "Yes", "4.20"), o("2", "No", "1.22")],
  },
  {
    id: "548",
    name: "Multigoals",
    specifier: "from=2|to=4",
    outcomes: [o("1", "2-4", "1.55")],
  },
  { id: "40", name: "Anytime Goalscorer", outcomes: [o("1", "Some Player", "3.00")] },
  { id: "38", name: "Xth Goalscorer", outcomes: [o("1", "No Goal", "2.50")] },
];

export const SLATES: readonly PricerParitySlate[] = [
  { name: "top-flight-standard", league: "Premier League", allMarkets: SLATE_1_STANDARD },
  { name: "half-markets-heavy", league: "La Liga", allMarkets: SLATE_2_HALF_HEAVY },
  { name: "corners-cards-shots", league: "Serie A", allMarkets: SLATE_3_CORNERS_CARDS_SHOTS },
  {
    name: "compound-scoreline-gap",
    league: "Bundesliga",
    allMarkets: SLATE_4_COMPOUND_SCORELINE_GAP,
  },
  { name: "fresh-uncatalogued-market", league: "Ligue 1", allMarkets: SLATE_5_FRESH_UNCATALOGUED },
  {
    name: "thin-low-liquidity",
    league: "__unknown_league__",
    allMarkets: SLATE_6_THIN_LOW_LIQUIDITY,
  },
  { name: "exotics-heavy", league: "Championship", allMarkets: SLATE_7_EXOTICS_HEAVY },
];

// ── Legacy shape mirror ──────────────────────────────────────────────────────
// Reference-duplicate of execution/index.ts's coverage (read-only source, not
// imported — that file is owned by a parallel Wave-3 workstream this session).
// Two components, exactly mirroring the two legacy functions:
//  (A) scanMarkets' structural per-family blocks (BLOCK 1-12, L667-1187).
//  (B) scanAllMarketsFallback's priceAllMarketOutcome shape matchers
//      (L529-634) — correct-score, odd/even, win-to-nil, clean-sheet,
//      team-total O/U (any line), match-total O/U (any line), Asian
//      handicap (any line). Re-audit if either source function's shape
//      coverage changes; a stale mirror is worse than none.

const SCANMARKETS_FAMILIES = new Set([
  "goals_ou",
  "team_total",
  "asian_handicap",
  "btts",
  "dnb",
  "double_chance",
  "combo",
  "half",
]);

function legacyShapeMatch(name: string, desc: string): boolean {
  const nameLc = name.toLowerCase();
  const descLc = desc.toLowerCase().trim();
  if (/^(\d+)\s*[-:]\s*(\d+)$/.test(descLc)) return true; // correct score (single pair only)
  if (nameLc.includes("odd") && nameLc.includes("even")) return true;
  if (nameLc.includes("win to nil")) return true;
  if (nameLc.includes("clean sheet")) return true;
  const line = /total=([\d.]+)/.exec(desc) ?? /([\d.]+)/.exec(descLc);
  if ((nameLc.includes("home") || nameLc.includes("away")) && line) return true;
  if (line && (descLc.startsWith("over") || descLc.startsWith("under"))) return true;
  if (nameLc.includes("handicap") || nameLc.includes("asian")) return true;
  return false;
}

/** True when the LEGACY pricer (either function) would produce a priced
 *  candidate for this outcome — a superset check, not exact-EV-gate parity
 *  (legacy's own hurdle/EV gates are separate from "can it be priced at
 *  all," which is the coverage property this harness cares about). */
export function legacyCanPrice(entry: AllMarketEntry, outcomeDesc: string): boolean {
  const family = familyOf(entry.id);
  const name = entry.name ?? entry.desc ?? "";
  const isHalfNamed = /^(1st|2nd) half|half ?time|^ht\b/i.test(name);
  if (family && SCANMARKETS_FAMILIES.has(family)) {
    // scanMarkets' half blocks (5/6/10/11) only cover FH/SH goals/result/BTTS
    // shapes it explicitly enumerates — a corners/cards/shots half variant
    // isn't among them even though "half" is nominally in the family set.
    if (family === "half" && /corner|card|booking|shot/i.test(name)) return false;
    return true;
  }
  return legacyShapeMatch(name, outcomeDesc) && !isHalfNamed;
}

// ── v3 pricing check ─────────────────────────────────────────────────────────

const BASE_INPUT_TEMPLATE: Omit<V3AllMarketsInput, "allMarkets" | "league" | "lambdaInput"> = {
  fixtureId: "parity",
  runId: "parity",
  home: "Home FC",
  away: "Away FC",
  kickoff: new Date().toISOString(),
  devigged1x2: { pHome: 0.45, pDraw: 0.27, pAway: 0.28 },
  penaltyFlags: {},
  cornersForH: 5.5,
  cornersForA: 4.2,
  cornersAgainstH: 4.0,
  cornersAgainstA: 5.0,
  cardsAvgH: 2.1,
  cardsAvgA: 2.4,
  sotForH: 4.5,
  sotForA: 3.8,
};

function buildInput(slate: PricerParitySlate): V3AllMarketsInput {
  return {
    ...BASE_INPUT_TEMPLATE,
    league: slate.league,
    lambdaInput: {
      league: slate.league,
      homeScoredPer90: 1.6,
      homeConcededPer90: 1.1,
      awayScoredPer90: 1.2,
      awayConcededPer90: 1.4,
      nHome: 10,
      nAway: 10,
    },
    allMarkets: slate.allMarkets,
  };
}

export interface ParityGap {
  slate: string;
  marketId: string;
  marketName: string;
  outcomeDesc: string;
  /** How this gap was found: routing-level skip, or routed-but-never-priced. */
  detail: string;
}

export interface ParityReport {
  slateCount: number;
  totalOutcomes: number;
  gaps: ParityGap[];
}

/** Runs the full audit across every slate — for each (market, outcome),
 *  checks whether legacy can price it and whether v3 actually does (routing
 *  AND real pricing, per analyzeFixtureMarketsV3's assessments). Any
 *  legacy-priceable/v3-unpriced pair not covered by an UNPRICED_BY_DESIGN
 *  registry row is reported as an unaudited gap. */
export function runParityAudit(slates: readonly PricerParitySlate[] = SLATES): ParityReport {
  const gaps: ParityGap[] = [];
  let totalOutcomes = 0;

  for (const slate of slates) {
    const result = analyzeFixtureMarketsV3(buildInput(slate));
    const pricedMarketIds = new Set((result?.assessments ?? []).map((a) => a.marketId));

    for (const entry of slate.allMarkets) {
      const route = routeMarket(entry);
      const family = familyOf(entry.id);
      const isHalfNamed = /^(1st|2nd) half|half ?time|^ht\b/i.test(entry.name ?? entry.desc ?? "");

      for (const outcome of entry.outcomes) {
        totalOutcomes++;
        const desc = outcome.desc ?? "";
        if (!legacyCanPrice(entry, desc)) continue; // legacy wouldn't price this either — no gap to check

        if ("skip" in route && route.skip) {
          if (isMarketIdRegistered(entry.id)) continue;
          const subKey = family ? (noGridModelSubKey(family, isHalfNamed) ?? undefined) : undefined;
          if (isSkipRegistered(route.reason, subKey)) continue;
          gaps.push({
            slate: slate.name,
            marketId: entry.id,
            marketName: entry.name ?? entry.desc ?? entry.id,
            outcomeDesc: desc,
            detail: `v3 skips (reason=${route.reason}) and is unregistered`,
          });
          continue;
        }

        // Routed — but routing isn't pricing. If NO assessment exists for
        // this marketId at all, v3 silently failed to price every outcome
        // (the id-46 class of gap) — that must be id-registered.
        if (!pricedMarketIds.has(entry.id)) {
          if (isMarketIdRegistered(entry.id)) continue;
          gaps.push({
            slate: slate.name,
            marketId: entry.id,
            marketName: entry.name ?? entry.desc ?? entry.id,
            outcomeDesc: desc,
            detail: "v3 routes this market but produced zero assessments for any of its outcomes",
          });
        }
      }
    }
  }

  return { slateCount: slates.length, totalOutcomes, gaps };
}

export function formatParityReport(report: ParityReport): string {
  const lines = [
    `Pricer parity audit — ${report.slateCount} slates, ${report.totalOutcomes} outcomes checked`,
    `Unaudited gaps: ${report.gaps.length}`,
  ];
  for (const g of report.gaps) {
    lines.push(
      `  [${g.slate}] id=${g.marketId} "${g.marketName}" outcome="${g.outcomeDesc}" — ${g.detail}`
    );
  }
  return lines.join("\n");
}
