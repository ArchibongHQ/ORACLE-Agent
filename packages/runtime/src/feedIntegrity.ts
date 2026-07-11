/** [refactor P1-3] Feed-integrity stage — v5 Rule 0.14, implemented as
 *  deterministic code. Three checks, run before eligibility:
 *    (a) SRL-twin block comparison — a real fixture whose Markets-tab block is
 *        ≥90% odds-identical to its SRL twin's is CONTAMINATED (restricted to
 *        fixtures-sheet headline markets);
 *    (b) fixtures-vs-markets headline 1X2 cross-check beyond rounding tolerance;
 *    (c) duplicate-block scan across distinct fixtures.
 *  Contamination is one of the few remaining integrity-class HARD rejects
 *  (P0-3). Live incident this guards against: 2026-07-09 France v Morocco —
 *  a real World Cup fixture's 736-row markets block was byte-identical to its
 *  SRL twin's while the headline 1X2s disagreed.
 *
 *  fixtureKey CONTRACT: callers (slateGate.ts) key blocksByFixture /
 *  headlineByFixture as `${home}|${away}` — raw team names (NOT alias-
 *  resolved, so a literal " SRL" suffix survives for the twin-pairing scan
 *  below), pipe-separated, no kickoff component (same "no kickoff" convention
 *  selectFixtures.ts's sidecarKey() already uses for cross-source matching).
 *
 *  Pure math over already-scraped slate data, no I/O. */

import { isSrlTeamName, stripSrlSuffix } from "./srlPatterns.js";

export type FeedIntegrityVerdict = "clean" | "contaminated" | "flagged";

export interface FixtureIntegrityResult {
  /** Stable fixture key (home|away|kickoff) the verdict applies to. */
  fixtureKey: string;
  verdict: FeedIntegrityVerdict;
  /** Which check fired: srl_twin | headline_mismatch | duplicate_block. */
  reason?: "srl_twin" | "headline_mismatch" | "duplicate_block";
  /** Human-readable evidence line for the rationale/report. */
  detail?: string;
  /** When contaminated: Rule 0.14a envisions the fixture still being
   *  priceable on fixtures-sheet headline markets only. NOT implemented —
   *  no consumer restricts pricing to headline markets on this flag; a
   *  contaminated fixture is discarded outright by slateGate.ts's "on" mode
   *  instead. Kept for when that rescue path is actually built. */
  headlineOnly?: boolean;
}

export interface SlateIntegrityReport {
  results: FixtureIntegrityResult[];
  contaminatedCount: number;
  flaggedCount: number;
}

/** Minimal odds-block shape the checks compare — one entry per market outcome. */
export interface MarketsBlockEntry {
  market: string;
  specifier?: string | null;
  outcome: string;
  odds: number;
}

/** Below this shared-entry count, an SRL-twin or duplicate-block match is not
 *  meaningful evidence — a 2-3 market overlap (e.g. both fixtures happen to
 *  offer 1X2 + one O/U line) is coincidence, not contamination. The France v
 *  Morocco incident had 736 shared rows; 20 is a conservative floor well
 *  below any real accidental-overlap scenario for a full markets catalogue. */
export const MIN_MEANINGFUL_PAIRED_ENTRIES = 20;

/** ≥90% odds identity across the paired markets ⇒ contaminated (v5 Rule 0.14a). */
export const SRL_TWIN_IDENTITY_RATIO = 0.9;

/** Relative tolerance for the fixtures-sheet vs markets-tab 1X2 cross-check —
 *  absorbs book rounding to 2dp without absorbing a genuinely different price. */
export const HEADLINE_TOLERANCE = 0.02;

function entryKey(e: MarketsBlockEntry): string {
  return `${e.market}|${e.specifier ?? ""}|${e.outcome}`;
}

/** Odds are decimal prices typically quoted to 2dp; compare at 3dp to absorb
 *  float round-trip noise (string→Number parsing) without masking a real
 *  price difference. */
function oddsEqual(a: number, b: number): boolean {
  return Math.round(a * 1000) === Math.round(b * 1000);
}

/** (a) SRL-twin check: ≥90% odds identity across shared markets ⇒ contaminated. */
export function detectSrlTwin(
  realBlock: MarketsBlockEntry[],
  twinBlock: MarketsBlockEntry[]
): { contaminated: boolean; identityRatio: number } {
  const twinByKey = new Map<string, number>();
  for (const e of twinBlock) {
    if (!twinByKey.has(entryKey(e))) twinByKey.set(entryKey(e), e.odds);
  }
  let pairedCount = 0;
  let identicalCount = 0;
  for (const e of realBlock) {
    const twinOdds = twinByKey.get(entryKey(e));
    if (twinOdds === undefined) continue;
    pairedCount += 1;
    if (oddsEqual(e.odds, twinOdds)) identicalCount += 1;
  }
  const identityRatio = pairedCount > 0 ? identicalCount / pairedCount : 0;
  const contaminated =
    pairedCount >= MIN_MEANINGFUL_PAIRED_ENTRIES && identityRatio >= SRL_TWIN_IDENTITY_RATIO;
  return { contaminated, identityRatio };
}

/** Market-label candidates for the 1X2 / match-result market across feed
 *  naming conventions (SportyBet gismo's raw `name`/`desc` fields are not
 *  guaranteed to literally read "1X2" — the slate-side flattener normalizes
 *  gismo market id "1" to the label "1X2", but this check stays tolerant of
 *  callers that don't, matching case-insensitively against the label set the
 *  industry actually uses). */
const HEADLINE_MARKET_RE = [
  /^1x2$/i,
  /match\s*result/i,
  /match\s*winner/i,
  /^3[\s-]?way$/i,
  /full[\s-]*time\s*result/i,
];

const HOME_OUTCOME_RE = /^(1|home)$/i;
const DRAW_OUTCOME_RE = /^(x|draw|tie)$/i;
const AWAY_OUTCOME_RE = /^(2|away)$/i;

function isHeadlineMarketLabel(market: string): boolean {
  return HEADLINE_MARKET_RE.some((re) => re.test(market));
}

/** (b) Headline 1X2 cross-check: fixtures-sheet vs markets-tab beyond rounding. */
export function crossCheckHeadline1x2(
  fixtureOdds: { home?: number; draw?: number; away?: number },
  marketsBlock: MarketsBlockEntry[]
): { mismatch: boolean; detail?: string } {
  let blockHome: number | undefined;
  let blockDraw: number | undefined;
  let blockAway: number | undefined;
  for (const e of marketsBlock) {
    if (!isHeadlineMarketLabel(e.market)) continue;
    if (blockHome === undefined && HOME_OUTCOME_RE.test(e.outcome)) blockHome = e.odds;
    else if (blockDraw === undefined && DRAW_OUTCOME_RE.test(e.outcome)) blockDraw = e.odds;
    else if (blockAway === undefined && AWAY_OUTCOME_RE.test(e.outcome)) blockAway = e.odds;
  }
  // Fail open — nothing to cross-check against (no 1X2 market in the block,
  // or fixtures-sheet headline odds missing).
  if (blockHome === undefined && blockDraw === undefined && blockAway === undefined) {
    return { mismatch: false };
  }

  const legs: Array<[string, number | undefined, number | undefined]> = [
    ["home", fixtureOdds.home, blockHome],
    ["draw", fixtureOdds.draw, blockDraw],
    ["away", fixtureOdds.away, blockAway],
  ];
  const mismatches: string[] = [];
  for (const [label, fx, bk] of legs) {
    if (fx == null || bk == null) continue;
    const rel = Math.abs(fx - bk) / Math.max(Math.abs(fx), 1e-9);
    if (rel > HEADLINE_TOLERANCE) mismatches.push(label);
  }
  if (!mismatches.length) return { mismatch: false };

  const fmt = (n: number | undefined) => (n == null ? "?" : String(n));
  const detail =
    `fixtures-sheet 1X2 (${fmt(fixtureOdds.home)}/${fmt(fixtureOdds.draw)}/${fmt(fixtureOdds.away)}) vs ` +
    `markets-tab 1X2 (${fmt(blockHome)}/${fmt(blockDraw)}/${fmt(blockAway)}) — mismatch on ${mismatches.join(", ")}`;
  return { mismatch: true, detail };
}

/** Canonical fingerprint for a markets block — sorted so entry order doesn't
 *  affect equality (scrapes don't guarantee stable ordering). */
function fingerprintBlock(block: MarketsBlockEntry[]): string {
  return block
    .map((e) => `${e.market}|${e.specifier ?? ""}|${e.outcome}|${e.odds}`)
    .sort()
    .join("\n");
}

/** (c) Duplicate-block scan across distinct fixtures in one slate. */
export function scanDuplicateBlocks(blocksByFixture: Map<string, MarketsBlockEntry[]>): string[][] {
  const byFingerprint = new Map<string, string[]>();
  for (const [fixtureKey, block] of blocksByFixture) {
    if (block.length < MIN_MEANINGFUL_PAIRED_ENTRIES) continue;
    const fp = fingerprintBlock(block);
    const keys = byFingerprint.get(fp);
    if (keys) keys.push(fixtureKey);
    else byFingerprint.set(fp, [fixtureKey]);
  }
  const groups: string[][] = [];
  for (const keys of byFingerprint.values()) {
    if (keys.length > 1) groups.push(keys);
  }
  return groups;
}

function splitFixtureKey(key: string): [string, string] | [undefined, undefined] {
  const idx = key.indexOf("|");
  if (idx < 0) return [undefined, undefined];
  return [key.slice(0, idx), key.slice(idx + 1)];
}

/** Slate-level entry point — wired into prefilterMarketsV3Jobs (WS1-D). */
export function runFeedIntegrity(
  blocksByFixture: Map<string, MarketsBlockEntry[]>,
  headlineByFixture: Map<string, { home?: number; draw?: number; away?: number }>
): SlateIntegrityReport {
  const results: FixtureIntegrityResult[] = [];
  const resolved = new Set<string>();

  // (a) SRL-twin pairing: for every fixture key whose home/away carries the
  // SRL marker, strip the suffix and look for a same-slate real fixture at
  // the stripped key. The verdict attaches to the REAL fixture, not the
  // SRL twin (the twin is already discarded upstream by the SRL eligibility
  // filter — see srlPatterns.ts's header — so its own verdict is moot).
  for (const [key, twinBlock] of blocksByFixture) {
    const [home, away] = splitFixtureKey(key);
    if (!home || !away) continue;
    if (!isSrlTeamName(home) && !isSrlTeamName(away)) continue;
    const realKey = `${stripSrlSuffix(home)}|${stripSrlSuffix(away)}`;
    if (realKey === key) continue;
    const realBlock = blocksByFixture.get(realKey);
    if (!realBlock) continue;
    const { contaminated, identityRatio } = detectSrlTwin(realBlock, twinBlock);
    if (!contaminated || resolved.has(realKey)) continue;
    results.push({
      fixtureKey: realKey,
      verdict: "contaminated",
      reason: "srl_twin",
      headlineOnly: true,
      detail:
        `markets block ${Math.round(identityRatio * 100)}% odds-identical to SRL twin ` +
        `"${key}" (${twinBlock.length}-entry block)`,
    });
    resolved.add(realKey);
  }

  // (b) fixtures-sheet vs markets-tab headline 1X2 cross-check. Fixtures
  // already contaminated via (a) don't need a second verdict.
  for (const [key, block] of blocksByFixture) {
    if (resolved.has(key)) continue;
    const headline = headlineByFixture.get(key);
    if (!headline) continue;
    const { mismatch, detail } = crossCheckHeadline1x2(headline, block);
    if (!mismatch) continue;
    results.push({
      fixtureKey: key,
      verdict: "contaminated",
      reason: "headline_mismatch",
      headlineOnly: true,
      detail,
    });
    resolved.add(key);
  }

  // (c) duplicate-block scan across ALL fixtures — flags both members of any
  // group not already contaminated by a stronger check above.
  for (const group of scanDuplicateBlocks(blocksByFixture)) {
    for (const key of group) {
      if (resolved.has(key)) continue;
      const others = group.filter((k) => k !== key).join(", ");
      results.push({
        fixtureKey: key,
        verdict: "flagged",
        reason: "duplicate_block",
        detail: `markets block byte-identical to: ${others}`,
      });
      resolved.add(key);
    }
  }

  return {
    results,
    contaminatedCount: results.filter((r) => r.verdict === "contaminated").length,
    flaggedCount: results.filter((r) => r.verdict === "flagged").length,
  };
}

/** Per-fixture entry point — installed at the top of batch processOne by the
 *  batch/index.ts owner (WS2-A) per WS1-D's integration spec. */
export function checkFixtureIntegrity(
  fixtureKey: string,
  report: SlateIntegrityReport | null | undefined
): FixtureIntegrityResult | null {
  if (!report) return null;
  return report.results.find((r) => r.fixtureKey === fixtureKey) ?? null;
}
