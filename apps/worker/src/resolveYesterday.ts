/** [PR-9, worker god-file split] Resolve-yesterday (10:00 WAT), extracted
 *  from index.ts's "thin cron shell". index.ts wires resolveYesterdayFixtures
 *  into cron.schedule("0 10 * * *", ...) and the --run-now/--run-resolve
 *  one-shot flags. */

import {
  DEFAULT_LEDGER_MAX,
  formatCalibrationMetrics,
  formatSettlementBreakdown,
  resolveDay,
} from "@oracle/runtime";
import { MemoryAdapter } from "@oracle/storage";
import { config, STORE_PATH } from "./workerContext.js";
import { watYesterdayString, writeHeartbeat } from "./workerUtils.js";

// ── Resolve yesterday (10:00 WAT) ───────────────────────────────────────────

export async function resolveYesterdayFixtures(): Promise<void> {
  // No early-exit on missing keys — CLAUDE.md §6 no-data-blocker: resolveDay's
  // web-search consensus fallback (tools/scrape_match_results.py) always runs on
  // whatever the API chain can't resolve, including when both keys are absent.
  const storage = new MemoryAdapter(STORE_PATH);
  const yesterday = watYesterdayString();

  const { candidates, resolved, unmatched, ledgerAppended, calibrationMetrics, ledgerByFamily } =
    await resolveDay(
      storage,
      {
        footballDataApiKey: config.footballDataApiKey,
        oddsApiKey: config.oddsApiKey,
        geminiApiKey: config.geminiApiKey,
        apiFootballKey: config.apiFootballKey,
      },
      yesterday,
      {
        enabled: config.enableWebSearchResultsFallback,
        minConsensus: config.webResultsMinConsensus,
      },
      {
        mode: config.calibrationLedger,
        maxLedger: Number(process.env.ORACLE_LEDGER_MAX ?? DEFAULT_LEDGER_MAX),
      }
    );

  if (!candidates) {
    process.stdout.write(`[resolve] ${yesterday}: no candidate records\n`);
  } else {
    process.stdout.write(
      `[resolve] ${yesterday}: ${resolved.length}/${candidates} resolved, ${unmatched.length} unmatched\n`
    );
  }

  // PR-7: surface the calibration ledger update + accuracy metrics on the resolve run.
  if (calibrationMetrics) {
    process.stdout.write(
      `[calibration] ${config.calibrationLedger ?? "shadow"}: +${ledgerAppended ?? 0} settled — ${formatCalibrationMetrics(calibrationMetrics)}\n`
    );
  }
  // [audit fix] surface the per-family settle/skip breakdown so a ledger
  // that's silently biased toward 1x2-derivable families is visible in the
  // resolve log, not indistinguishable from a healthy one.
  if (ledgerByFamily) {
    const line = formatSettlementBreakdown(ledgerByFamily);
    if (line) process.stdout.write(`[calibration] ${line}\n`);
  }

  writeHeartbeat("lastResolve", {
    date: yesterday,
    candidates,
    resolved: resolved.length,
    ledgerAppended: ledgerAppended ?? 0,
    calibResolvedCount: calibrationMetrics?.resolvedCount ?? 0,
  });
}
