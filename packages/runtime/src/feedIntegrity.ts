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
 *  W1-S STUB: contract only — WS1-D supplies the implementation + tests.
 *  Every check fails OPEN (verdict "clean") until implemented, so wiring this
 *  in early can never block a slate.
 *
 *  Pure math over already-scraped slate data, no I/O. */

export type FeedIntegrityVerdict = "clean" | "contaminated" | "flagged";

export interface FixtureIntegrityResult {
  /** Stable fixture key (home|away|kickoff) the verdict applies to. */
  fixtureKey: string;
  verdict: FeedIntegrityVerdict;
  /** Which check fired: srl_twin | headline_mismatch | duplicate_block. */
  reason?: "srl_twin" | "headline_mismatch" | "duplicate_block";
  /** Human-readable evidence line for the rationale/report. */
  detail?: string;
  /** When contaminated: the fixture may still be priced on fixtures-sheet
   *  headline markets only (Rule 0.14a rescue path). */
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

/** (a) SRL-twin check: ≥90% odds identity across shared markets ⇒ contaminated. */
export function detectSrlTwin(
  _realBlock: MarketsBlockEntry[],
  _twinBlock: MarketsBlockEntry[]
): { contaminated: boolean; identityRatio: number } {
  // WS1-D implements. Fail-open stub.
  return { contaminated: false, identityRatio: 0 };
}

/** (b) Headline 1X2 cross-check: fixtures-sheet vs markets-tab beyond rounding. */
export function crossCheckHeadline1x2(
  _fixtureOdds: { home?: number; draw?: number; away?: number },
  _marketsBlock: MarketsBlockEntry[]
): { mismatch: boolean; detail?: string } {
  // WS1-D implements. Fail-open stub.
  return { mismatch: false };
}

/** (c) Duplicate-block scan across distinct fixtures in one slate. */
export function scanDuplicateBlocks(
  _blocksByFixture: Map<string, MarketsBlockEntry[]>
): string[][] {
  // WS1-D implements. Returns groups of fixtureKeys sharing identical blocks.
  return [];
}

/** Slate-level entry point — wired into prefilterMarketsV3Jobs (WS1-D). */
export function runFeedIntegrity(
  _blocksByFixture: Map<string, MarketsBlockEntry[]>,
  _headlineByFixture: Map<string, { home?: number; draw?: number; away?: number }>
): SlateIntegrityReport {
  // WS1-D implements. Fail-open stub.
  return { results: [], contaminatedCount: 0, flaggedCount: 0 };
}

/** Per-fixture entry point — installed at the top of batch processOne by the
 *  batch/index.ts owner (WS2-A) per WS1-D's integration spec. */
export function checkFixtureIntegrity(
  _fixtureKey: string,
  _report: SlateIntegrityReport | null | undefined
): FixtureIntegrityResult | null {
  // WS1-D implements (lookup into the slate report). Fail-open stub.
  return null;
}
