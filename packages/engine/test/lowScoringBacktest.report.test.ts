/** Q5 — thin runner for the investigative low-scoring threshold backtest.
 *  This is deliberately NOT a pass/fail test on the actual hit-rate numbers
 *  (per the plan: "only change the hardcoded constants on clear evidence,
 *  otherwise document as already well-calibrated and close the item") — it
 *  only asserts the pipeline runs end-to-end and logs the report so `pnpm test`
 *  surfaces it for a human to read. See test/analysis/ for the real logic. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatBacktestReport, runBacktest } from "./analysis/backtestLowScoringThresholds.js";
import { loadJoinedLedger } from "./analysis/loadHistoricalLedger.js";

// MemoryAdapter's default store dir is relative to process.cwd(), which under
// `pnpm --filter @oracle/engine test` is packages/engine/, not the repo root
// where .tmp/oracle-store actually lives — same bug class as the VENUES_PATH
// fix (oracle_v2 hardening). Anchor explicitly so the ledger is actually found.
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");

describe("Q5 low-scoring threshold backtest (investigative — not a pass/fail gate)", () => {
  it("runs the grid backtest against the on-disk ledger and reports the result", async () => {
    const joined = await loadJoinedLedger(join(ROOT, ".tmp/oracle-store"));
    const report = runBacktest(joined);
    // biome-ignore lint: intentional console output — this IS the deliverable.
    console.log(`\n${formatBacktestReport(report)}\n`);
    expect(report.grid.length).toBeGreaterThan(0);
  });
});
