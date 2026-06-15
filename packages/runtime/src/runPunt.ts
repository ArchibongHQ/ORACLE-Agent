/** runPuntAnalysis — single entry point for the "Universe slip" counter-booking pipeline.
 *  loadBookingCode → loadedSlipToJobs → runAnalysis → counterSlip → bookAccumulator(adjusted).
 *  Called by the Telegram bot, the web /punt route, and the CLI. Never throws — error in-band. */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBookingCode } from "@oracle/booking";
import type { BatchResult, OracleConfig } from "@oracle/engine";
import type { ActionablePick } from "@oracle/notify";
import type { StoragePort } from "@oracle/storage";
import { runAnalysis } from "./analyze.js";
import type { CounterLeg } from "./punt.js";
import { counterSlip, loadedSlipToJobs } from "./punt.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");
const SIDECAR_PATH = join(ROOT, ".tmp/fixtures/sportybet_today.json");

/** Spawn scrape_fixtures.py if the SportyBet sidecar is missing or stale. Fire-and-wait,
 *  fail-open: a scrape error never aborts the punt analysis.
 * @internal exported for testing only */
export async function refreshSidecarIfStale(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (existsSync(SIDECAR_PATH)) {
      const raw = JSON.parse(readFileSync(SIDECAR_PATH, "utf8")) as { date?: string };
      if (raw?.date === today) return; // fresh — nothing to do
    }
  } catch {
    // corrupt file — fall through to re-scrape
  }
  try {
    await new Promise<void>((resolve) => {
      const child = spawn("python", [join(ROOT, "tools/scrape_fixtures.py"), "--quiet"], {
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        // On local Windows, child.kill() leaves chrome.exe orphaned (separate process tree).
        // Use taskkill /F /T to kill the whole tree. On VPS/Linux, SIGTERM cascades normally.
        if (process.platform === "win32" && process.env["ORACLE_IS_VPS"] !== "true" && child.pid) {
          import("node:child_process").then(({ execFileSync }) => {
            try { execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)]); } catch { /* ignore */ }
          }).catch(() => child.kill());
        } else {
          child.kill();
        }
        resolve();
      }, 90_000);
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch {
    // scrape failure is non-fatal
  }
}

/** Minimal empty BatchResult for the no-covered-fixtures path. */
function emptyBatch(): BatchResult {
  return {
    runId: "punt-empty",
    calibrationSnapshotId: "",
    date: new Date().toISOString().slice(0, 10),
    rankingMode: "MAX_EV",
    jobs: [],
    completedCount: 0,
    errorCount: 0,
    actionableCount: 0,
    totalRecommendedStakePct: 0,
    cost: { estimatedUsd: 0, ceilingUsd: null, halted: false },
    errors: [],
  };
}

export interface PuntResult {
  sourceCode: string;
  oracleCode: string | null;
  oracleLoadUrl: string | null;
  totalOdds: number;
  legs: CounterLeg[];
  adjustedCount: number;
  confirmedCount: number;
  keptCount: number;
  noCoverageCount: number;
  error?: string;
}

/** Run the full punt-analysis chain for one booking code. */
export async function runPuntAnalysis(
  code: string,
  deps: { storage: StoragePort; config: OracleConfig }
): Promise<PuntResult> {
  const { storage, config } = deps;
  const base: PuntResult = {
    sourceCode: code,
    oracleCode: null,
    oracleLoadUrl: null,
    totalOdds: 0,
    legs: [],
    adjustedCount: 0,
    confirmedCount: 0,
    keptCount: 0,
    noCoverageCount: 0,
  };

  // 1. Load the punter's slip from the booking code.
  const slip = await loadBookingCode(code);
  if (slip.error || !slip.legs.length) {
    return { ...base, error: slip.error ?? "no legs in booking code" };
  }

  // 1.5. Ensure the SportyBet sidecar is fresh before resolving legs.
  //      Runs scrape_fixtures.py synchronously if the sidecar is missing or dated
  //      to a prior day. Failure is non-fatal — coverage just degrades gracefully.
  await refreshSidecarIfStale();

  // 2. Resolve each leg to an analyzable job (cache-first).
  const puntLegs = await loadedSlipToJobs(slip, {
    oddsApiKey: config.oddsApiKey,
    geminiApiKey: config.geminiApiKey,
    footballDataApiKey: config.footballDataApiKey,
    perplexityApiKey: config.perplexityApiKey,
    storage: config.enableNewsIntel ? storage : undefined,
  });
  const jobs = puntLegs.map((l) => l.job).filter((j): j is NonNullable<typeof j> => j !== null);

  // 3. Analyze the covered fixtures. counterSlip only reads batch.jobs, so an empty
  //    job set yields an empty batch and every leg falls through to KEPT/NO_COVERAGE.
  const batch: BatchResult = jobs.length
    ? (await runAnalysis(jobs, { storage, config }, { trigger: "manual", persist: true })).batch
    : emptyBatch();

  // 4. Per-leg counter-decision (keep fixture; swap pick where ORACLE is stronger).
  const legs = counterSlip(puntLegs, batch);

  const counts = legs.reduce(
    (acc, l) => {
      if (l.verdict === "ADJUSTED") acc.adjustedCount++;
      else if (l.verdict === "CONFIRMED") acc.confirmedCount++;
      else if (l.verdict === "KEPT_LOW_CONVICTION") acc.keptCount++;
      else acc.noCoverageCount++;
      return acc;
    },
    { adjustedCount: 0, confirmedCount: 0, keptCount: 0, noCoverageCount: 0 }
  );

  // 5. Rebook the final selections as a new SportyBet accumulator (anonymous, no stake).
  const picks: ActionablePick[] = legs.map((l) => l.pick);
  const { bookAccumulator } = await import("@oracle/booking");
  const booking = await bookAccumulator(picks);

  return {
    sourceCode: code,
    oracleCode: booking.code,
    oracleLoadUrl: booking.loadUrl,
    totalOdds: booking.totalOdds,
    legs,
    ...counts,
    ...(booking.error ? { error: `booking: ${booking.error}` } : {}),
  };
}

/** Compact text rendering of a punt result for chat channels (Telegram/Web). */
export function formatPuntResult(r: PuntResult): string {
  const lines: string[] = [];
  lines.push(`*ORACLE Punt Analysis* — source \`${r.sourceCode}\``);
  lines.push(
    `${r.legs.length} legs · ${r.adjustedCount} adjusted · ${r.confirmedCount} confirmed · ${r.keptCount} kept · ${r.noCoverageCount} no-coverage`
  );
  if (r.error) lines.push(`⚠️ ${r.error}`);
  lines.push("");
  for (const l of r.legs) {
    const tag = { ADJUSTED: "🔁", CONFIRMED: "✅", KEPT_LOW_CONVICTION: "➖", NO_COVERAGE: "❔" }[
      l.verdict
    ];
    const side = l.pick.side ? ` (${l.pick.side})` : "";
    const conf = l.oracleConfidence != null ? ` · ${(l.oracleConfidence * 100).toFixed(0)}%` : "";
    lines.push(
      `${tag} ${l.raw.home} vs ${l.raw.away} — ${l.pick.market}${side} @ ${l.pick.odds}${conf}`
    );
  }
  if (r.oracleCode) {
    lines.push("");
    lines.push(`🎟 ORACLE Booking Code: *${r.oracleCode}*  (total odds ${r.totalOdds})`);
    if (r.oracleLoadUrl) lines.push(`Load: ${r.oracleLoadUrl}`);
  }
  return lines.join("\n");
}
