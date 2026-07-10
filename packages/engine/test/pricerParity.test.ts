/** [WS3-B, Wave 3] Thin runner for the legacy-vs-v3 market parity harness —
 *  see test/analysis/pricerParity.ts for the actual replay/diff logic and its
 *  header for why the 7 slates are synthetic-but-realistic rather than real
 *  historical data (none is committed to this repo; see that file's header).
 *
 *  This IS a pass/fail gate (unlike the Q5 low-scoring backtest's thin
 *  runner): the coverage property — every market the legacy pricer would
 *  price is either v3-priced or explicitly registered in
 *  marketsV3/unpriced.ts's UNPRICED_BY_DESIGN — is exactly the safety gate
 *  the plan's risk register requires before Wave 4 may delete
 *  scanMarkets/scanAllMarketsFallback. A red result here means either a real
 *  parity regression, or a genuinely new gap that needs a registry row with a
 *  reason — never silence it by weakening the assertion. */
import { describe, expect, it } from "vitest";
import { formatParityReport, runParityAudit, SLATES } from "./analysis/pricerParity.js";

describe("pricer parity (WS3-B) — legacy vs v3 market coverage", () => {
  it("replays >= 7 representative slates", () => {
    expect(SLATES.length).toBeGreaterThanOrEqual(7);
  });

  it("every legacy-priceable market is either v3-priced or registered in UNPRICED_BY_DESIGN", () => {
    const report = runParityAudit();
    // biome-ignore lint: intentional console output — this IS the deliverable
    // (the parity ledger Wave 4's scanMarkets-deletion gate reads).
    console.log(`\n${formatParityReport(report)}\n`);
    expect(report.totalOutcomes).toBeGreaterThan(0);
    expect(report.gaps).toEqual([]);
  });
});
