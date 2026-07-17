/** [PR-9, worker god-file split] The 09:30 WAT acquisition family, extracted
 *  from index.ts's "thin cron shell": scrape -> Parquet lake write -> news
 *  enrichment -> fixture report (acquireDailyJob/sendDailyFixtureReport),
 *  plus the off-peak FotMob refresh (02:00 WAT) and the T-30m closing-odds
 *  sweep (every 5 min) that both piggyback on the same SportyBet sidecar
 *  this family produces, and the weekly Kaggle dataset refresh. index.ts
 *  wires these into cron.schedule(...) and the --run-* one-shot flags. */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClosingOddsSnapshot } from "@oracle/engine";
import { sendTelegramDocument, sendTelegramText } from "@oracle/notify";
import {
  fetchSharpFairPrice,
  findSportyBetEventId,
  generateAndWriteFixtureWorkbook,
  LEAGUE_TO_SPORT,
  loadSportyBetIndex,
  SHARP_ODDS_STORAGE_KEY,
  type SharpOddsRecord,
  sharpOddsRecordId,
} from "@oracle/runtime";
import { MemoryAdapter, STORAGE_KEYS } from "@oracle/storage";
import { awaitAcquireOrTimeout, trackAcquireJob } from "./acquireChain.js";
import {
  type SharpSweepCandidate,
  type SweepCandidate,
  selectDueFixtures,
  selectDueSharpFixtures,
} from "./closingOddsSweep.js";
import {
  config,
  env,
  MARKET_CATALOG_OVERLAY_PATH,
  PYTHON_BIN,
  ROOT,
  STORE_PATH,
} from "./workerContext.js";
import {
  readFixtureReportState,
  runPythonScript,
  watDateString,
  watYesterdayString,
  writeHeartbeat,
} from "./workerUtils.js";
import { formatXgCoverageNote } from "./xgCoverageNote.js";

/** PR-26: the acquisition-artifact freshness/yield line (tools/lib/
 *  artifact_health.py) — surfaces exactly the failure class that made the
 *  FotMob-tier-yields-0 and 6-week-stale-availability-CSV incidents this
 *  audit train fixed invisible in the first place: the acquisition code ran,
 *  exited 0, and nothing downstream noticed the output was empty or old.
 *  Pure local file reads on the Python side (no network calls), so this is
 *  fast and safe to call inline; best-effort like every other Python
 *  subprocess call in this file — a failure here must never block the
 *  fixture report it's annotating. */
export async function getDataHealthLine(): Promise<string | null> {
  const { err, stdout, stderr } = await runPythonScript(
    PYTHON_BIN,
    join(ROOT, "tools", "acquire_daily.py"),
    ["--health"],
    { cwd: ROOT }
  );
  // Forward stderr unconditionally, same as every other Python-subprocess
  // call site in this file — a warning printed on an otherwise-successful
  // --health run (e.g. an unreadable artifact) must still surface somewhere.
  if (stderr) process.stderr.write(stderr);
  if (err) {
    process.stderr.write(`[fixture-report] data-health check failed: ${err.message}\n`);
    return null;
  }
  const line = stdout.trim();
  return line.length > 0 ? line : null;
}

// ── Daily acquisition (Parquet lake) ─────────────────────────────────────────
// tools/acquire_daily.py wraps the same SportyBet/Gismo scrape as
// scrapeFixtures() in goalsAccumulator.ts, additionally writing the
// date-partitioned Parquet lake (.tmp/oracle-daily/) that
// packages/runtime/src/dailyStore.ts reads — the latency seam: a fresh lake
// lets fetchTodaysFixtures skip the live odds chain. It still writes the
// legacy JSON sidecar, so deleting the lake degrades back to today's exact
// existing behavior.

// Shared in-flight guard: acquireDailyJob (09:30 WAT cron + back-online trigger)
// and runDailyBatch's gap-fill call both invoke acquireDaily() independently,
// gated by the same isLakeFreshForToday() check — if the 09:30 WAT run is still
// in progress (or just failed) when the hourly/09:35 WAT triggers fire, they'd
// otherwise spawn a second acquire_daily.py concurrently, the exact
// concurrent-write corruption mode (sportybet_today.json / Parquet
// partitions) this lake was built to avoid. A second caller awaits the
// in-flight run's result instead of starting its own.
let _acquireDailyInFlight: Promise<number> | null = null;

// Exported: runDailyBatch's gap-fill scrape (dailyBatch.ts) shares this exact
// in-flight guard with acquireDailyJob below — see the comment above.
export function acquireDaily(): Promise<number> {
  if (_acquireDailyInFlight) return _acquireDailyInFlight;
  const python = PYTHON_BIN;
  const script = join(ROOT, "tools", "acquire_daily.py");
  // [2026-07-16, silent-failure-logging fix] Explicit longer timeoutMs — this
  // is one of the two "real network-scrape entry points" runPythonScript's
  // own docstring calls out as different from the lower-stakes best-effort
  // tools the new 15-minute DEFAULT_PYTHON_TIMEOUT_MS was calibrated against
  // (today's real run: ~9min end-to-end). 25 minutes stays comfortably above
  // the outer ACQUIRE_CHAIN_TIMEOUT_MS (20min, index.ts) that callers already
  // use to stop *waiting* on this job without killing it — so a legitimately
  // slow-but-alive scrape on a bad day still gets to finish rather than being
  // killed just because it's slower than the tools this default was tuned for.
  const run = runPythonScript(python, script, [], {
    cwd: ROOT,
    retryOnNetworkError: true,
    timeoutMs: 25 * 60 * 1000,
  })
    .then(({ err, stdout, stderr }) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) process.stderr.write(`acquire_daily error: ${err.message}\n`);
      const m = stdout.match(/acquired:(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    })
    .finally(() => {
      _acquireDailyInFlight = null;
    });
  _acquireDailyInFlight = run;
  return run;
}

// News enrichment runs as the second acquisition step (after fixtures land) —
// best-effort, never blocks. This is the ONLY place live news scraping happens:
// enrich_news.py populates the lake/file cache for ALL scraped fixtures here, so
// downstream analysis (the goals pipeline runs cacheOnly) reads pre-enriched data
// and never launches per-fixture live scraping mid-analysis.
function runNewsEnrichment(): Promise<void> {
  if (!config.enableNewsIntel) return Promise.resolve();
  const python = PYTHON_BIN;
  const script = join(ROOT, "tools", "enrich_news.py");
  return runPythonScript(python, script, [], { cwd: ROOT }).then(({ err, stdout, stderr }) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (err) process.stderr.write(`enrich_news error: ${err.message}\n`);
  });
}

// Cloud-routine news/xG sync runs AFTER news enrichment, never before or
// alongside it: enrich_news.py's daily_store.write_table REPLACES the news
// partition wholesale, so if it ran second it would wipe the cloud_news rows
// this step merges in. tools/sync_cloud_news.py must therefore always be the
// last writer of the day for the news partition. Best-effort like every
// other Python subprocess here — a failure never blocks the acquisition run.
function runCloudNewsSync(): Promise<void> {
  if (!config.cloudNewsSync) return Promise.resolve();
  const python = PYTHON_BIN;
  const script = join(ROOT, "tools", "sync_cloud_news.py");
  return runPythonScript(python, script, [], { cwd: ROOT }).then(({ err, stdout, stderr }) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (err) process.stderr.write(`sync_cloud_news error: ${err.message}\n`);
  });
}

/** Full 09:30 WAT acquisition job: scrape -> lake write -> news enrichment ->
 *  cloud news/xG sync -> heartbeat. Only stamps lastAcquire when fixtures
 *  were actually acquired, so a failed run leaves the lake-staleness check
 *  above free to keep retrying rather than masking the failure with a fresh
 *  timestamp.
 *
 *  [audit fix, P0-4] Tracked via trackAcquireJob so the 09:35/09:40 cron slots
 *  (and the daily-batch back-online trigger) can await its actual completion
 *  instead of firing on a fixed wall-clock offset — see acquireChain.ts. */
export function acquireDailyJob(): Promise<void> {
  return trackAcquireJob(
    (async () => {
      const count = await acquireDaily();
      await runNewsEnrichment();
      // Must run after runNewsEnrichment — see runCloudNewsSync's comment
      // above (write_table partition-replace semantics).
      await runCloudNewsSync();
      if (count > 0) {
        writeHeartbeat("lastAcquire", { date: watDateString(), fixtures: count });
      }
    })()
  );
}

/** [audit fix, P0-4] Wait for acquireDailyJob (up to ACQUIRE_CHAIN_TIMEOUT_MS)
 *  before starting the caller's own heavy work — logs and proceeds anyway if
 *  the bound is hit (the "fallback cron" requirement). */
export function awaitAcquireDailyJobOrTimeout(timeoutMs: number): Promise<void> {
  return awaitAcquireOrTimeout(timeoutMs, () => {
    process.stdout.write(
      `[worker] acquire-daily still running after ${Math.round(timeoutMs / 60000)}min — proceeding anyway\n`
    );
  });
}

/** Daily raw-fixture-data report (item #5): every SportyBet fixture for the
 *  day + its accompanying odds/stats/lineups/news — independent of engine
 *  selection or the goals funnel. Generated + sent to Telegram as a document
 *  attachment immediately after the 09:30 WAT scrape, before anything else
 *  (goals batch, daily batch) — per owner instruction "trigger immediately
 *  after scrape and before any other thing." Best-effort: a failure here
 *  (missing token, write error) is logged but never blocks the rest of the run. */
// Guards against the lake-stale back-online chain (acquireDailyJob ->
// sendDailyFixtureReport) and the hourly enriched-followup retry firing this
// concurrently — both are fire-and-forget logJob calls with no shared lock,
// so without this they could both pass the marketsEmpty check at once and
// double-send the Telegram document.
let fixtureReportInFlight = false;

export async function sendDailyFixtureReport(): Promise<void> {
  if (fixtureReportInFlight) {
    process.stdout.write("[fixture-report] skip — already running\n");
    return;
  }
  fixtureReportInFlight = true;
  const startedAt = new Date();
  const today = watDateString(startedAt);
  const hasCreds = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  process.stdout.write(`[fixture-report] start ${startedAt.toISOString()} (creds=${hasCreds})\n`);
  try {
    // Spreadsheets (.xlsx) replace the old HTML report — a small Fixtures file
    // (one row per fixture, every captured field) plus per-outcome Markets
    // file(s), split under the Telegram per-file size budget.
    const result = await generateAndWriteFixtureWorkbook(today, join(ROOT, ".tmp/reports"));
    // PR-26: computed once here, unconditionally — a stale/missing artifact
    // is directly relevant diagnostic context for EVERY outcome below (the
    // success caption, the no-fixtures alert, and the markets-not-enriched
    // BLOCKED alert all append it), not just the happy path. One snapshot
    // shared by all of them rather than re-running the check per branch and
    // risking a slightly different result each time.
    const dataHealthLine = await getDataHealthLine();
    if (result) {
      // PR-19: log the xG coverage line unconditionally (even on the
      // marketsEmpty early-return below) — it's a data-availability signal
      // independent of whether markets depth has enriched yet, and it's the
      // one place the historical silent-zero FotMob-tier bug becomes visible
      // in the worker's own logs, not just build_xg_table.py's stdout.
      process.stdout.write(`[fixture-report] ${formatXgCoverageNote(result.xgCoverage)}\n`);
    }
    if (dataHealthLine) process.stdout.write(`[fixture-report] ${dataHealthLine}\n`);
    if (!result) {
      // No-fixtures is a real, reportable state — surface it loudly (was a silent
      // return that made "the report never fired" indistinguishable from a crash).
      process.stderr.write("[fixture-report] WARN no SportyBet fixtures available for today\n");
      // Same placeholder/heartbeat suppression as the marketsEmpty branch below —
      // was firing the Telegram send unconditionally on every cron run (the
      // 3+/day spam bug), with no way for the hourly heartbeat retry to know it
      // had already flagged today as blocked. Keyed by (date, reason) rather
      // than date alone: a same-day transition from "no fixtures" to
      // "fixtures but markets not enriched" is a materially different blocked
      // state and must still get its own one-time notice.
      const noFixturesState = readFixtureReportState();
      const noFixturesFlagged =
        noFixturesState.placeholderDate === today &&
        noFixturesState.placeholderReason === "no-fixtures";
      if (hasCreds && !noFixturesFlagged) {
        await sendTelegramText(
          env.TELEGRAM_BOT_TOKEN as string,
          env.TELEGRAM_CHAT_ID as string,
          `ORACLE — no SportyBet fixtures found for ${today}.${dataHealthLine ? `\n${dataHealthLine}` : ""}`
        );
      }
      if (!noFixturesFlagged) {
        writeHeartbeat("fixtureReportPlaceholder", { date: today, reason: "no-fixtures" });
      }
      return;
    }
    if (result.marketsEmpty) {
      // Markets depth not yet enriched — the report cron raced the scrape's
      // allMarkets pass (the historical cause of header-only "Markets" sheets).
      // Don't silently push a marketless report; flag the block once via
      // Telegram and let the hourly heartbeat retry (readFixtureReportState/
      // checkHeartbeatFreshness above) send the real spreadsheet once enriched.
      process.stderr.write(
        `[fixture-report] WARN allMarkets not yet enriched for ${today} (${result.fixtureCount} fixtures) — skipping push; hourly retry will deliver the full report\n`
      );
      const marketsEmptyState = readFixtureReportState();
      const marketsEmptyFlagged =
        marketsEmptyState.placeholderDate === today &&
        marketsEmptyState.placeholderReason === "markets-empty";
      if (hasCreds && !marketsEmptyFlagged) {
        await sendTelegramText(
          env.TELEGRAM_BOT_TOKEN as string,
          env.TELEGRAM_CHAT_ID as string,
          `ORACLE — ${today} full-lake report BLOCKED: market depth not yet enriched (NO accumulated enriched data). Will auto-send the full spreadsheet once ready.${dataHealthLine ? `\n${dataHealthLine}` : ""}`
        );
      }
      if (!marketsEmptyFlagged) {
        writeHeartbeat("fixtureReportPlaceholder", { date: today, reason: "markets-empty" });
      }
      return;
    }
    // HTML one-pager first (human-friendly: fixtures + collapsible markets), then
    // the xlsx workbooks (the canonical LLM-readable feed). Owner request 2026-07-10.
    const allPaths = [result.htmlPagePath, result.fixturesPath, ...result.marketsPaths];
    for (const p of allPaths) {
      const kb = Math.round(statSync(p).size / 1024);
      process.stdout.write(`[fixture-report] wrote ${p} (${kb}KB)\n`);
    }

    if (hasCreds) {
      const total = allPaths.length;
      const partCount = result.marketsPaths.length;
      // Track actual delivery outcome per file — sendTelegramDocument now reports
      // success/failure instead of silently swallowing it, so the "delivered"
      // log and heartbeat below can be made honest instead of unconditional.
      let succeeded = 0;
      if (
        await sendTelegramDocument(
          env.TELEGRAM_BOT_TOKEN as string,
          env.TELEGRAM_CHAT_ID as string,
          result.htmlPagePath,
          `ORACLE fixtures & markets (open in browser — tap a fixture to expand its markets) — ${today} (${result.fixtureCount} fixtures) [file 1/${total}]\n${formatXgCoverageNote(result.xgCoverage)}${dataHealthLine ? `\n${dataHealthLine}` : ""}`
        )
      ) {
        succeeded++;
      }
      if (
        await sendTelegramDocument(
          env.TELEGRAM_BOT_TOKEN as string,
          env.TELEGRAM_CHAT_ID as string,
          result.fixturesPath,
          `ORACLE daily fixtures (spreadsheet) — ${today} (${result.fixtureCount} fixtures) [file 2/${total}]`
        )
      ) {
        succeeded++;
      }
      for (let i = 0; i < result.marketsPaths.length; i++) {
        if (
          await sendTelegramDocument(
            env.TELEGRAM_BOT_TOKEN as string,
            env.TELEGRAM_CHAT_ID as string,
            result.marketsPaths[i] as string,
            `ORACLE daily markets — ${today} [file ${i + 3}/${total}${partCount > 1 ? `, part ${i + 1} of ${partCount}` : ""}]`
          )
        ) {
          succeeded++;
        }
      }
      if (succeeded === total) {
        process.stdout.write(
          `[fixture-report] delivered ${total} file(s) to Telegram in ${Date.now() - startedAt.getTime()}ms\n`
        );
        writeHeartbeat("fixtureReportDelivered", { date: today });
      } else {
        // Don't stamp fixtureReportDelivered. index.ts's hourly follow-up
        // (checkHeartbeatFreshness) only re-triggers sendDailyFixtureReport
        // when placeholderDate === today && deliveredDate !== today — it does
        // not read `reason`, so reusing the placeholder stamp here (same as
        // the blocked branches above) is what actually wires a delivery
        // failure into that existing hourly retry, instead of leaving the
        // report undelivered for the rest of the day.
        process.stderr.write(
          `[fixture-report] WARN ${total - succeeded}/${total} file(s) failed to deliver to Telegram for ${today}\n`
        );
        writeHeartbeat("fixtureReportPlaceholder", { date: today, reason: "delivery-failed" });
      }
    } else {
      // Was a silent skip — now explicit so an unconfigured box is obvious in logs.
      process.stderr.write(
        `[fixture-report] WARN Telegram creds missing — spreadsheets on disk at ${allPaths.join(", ")}, not delivered\n`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[fixture-report] FAILED — ${msg}\n`);
    // Best-effort failure ping so a delivery failure is visible in the chat, not
    // just buried in service logs.
    if (hasCreds) {
      await sendTelegramText(
        env.TELEGRAM_BOT_TOKEN as string,
        env.TELEGRAM_CHAT_ID as string,
        `ORACLE — daily fixture report FAILED for ${today}: ${msg}`
      ).catch(() => {});
    }
  } finally {
    fixtureReportInFlight = false;
  }
}

// ── Weekly Kaggle dataset refresh (Saturday 03:00 UTC) ────────────────────────

// [2026-07-16, silent-failure-logging fix] Returns the outcome (not just
// void) so runWeeklyKaggleRefresh can tally pass/fail across the whole chain
// instead of a failure only being visible by grepping this one step's own
// log lines — a partial weekly failure (e.g. squad-availability) previously
// had no chain-level signal at all.
function runKaggleTool(
  label: string,
  scriptName: string,
  args: string[] = []
): Promise<{ label: string; ok: boolean }> {
  const python = PYTHON_BIN;
  const script = join(ROOT, "tools", scriptName);
  const start = Date.now();
  process.stdout.write(`[kaggle-refresh] ${label}: starting\n`);
  return runPythonScript(python, script, args, { cwd: ROOT }).then(({ err, stdout, stderr }) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (err) {
      process.stderr.write(
        `[kaggle-refresh] ${label}: FAILED after ${elapsed}s — ${err.message}\n`
      );
      return { label, ok: false };
    }
    process.stdout.write(`[kaggle-refresh] ${label}: done in ${elapsed}s\n`);
    return { label, ok: true };
  });
}

export async function runWeeklyKaggleRefresh(): Promise<void> {
  const credPath =
    process.platform === "win32"
      ? join(process.env.USERPROFILE ?? "", ".kaggle", "kaggle.json")
      : join(process.env.HOME ?? "", ".kaggle", "kaggle.json");
  const hasEnvAuth = Boolean(process.env.KAGGLE_USERNAME) && Boolean(process.env.KAGGLE_KEY);
  if (!existsSync(credPath) && !hasEnvAuth) {
    process.stderr.write(
      `[kaggle-refresh] WARNING: no Kaggle credentials found (checked ${credPath} and KAGGLE_USERNAME/KAGGLE_KEY) — downloads will fail\n`
    );
  }

  process.stdout.write("[kaggle-refresh] === weekly refresh start ===\n");
  const wall = Date.now();
  const results: { label: string; ok: boolean }[] = [];

  results.push(
    await runKaggleTool("odds_timeseries", "fetch_odds_timeseries.py", [
      "--btb-dir",
      ".tmp/kaggle/beat-the-bookie",
      "--ah-dir",
      ".tmp/kaggle/ah-odds",
    ])
  );
  results.push(await runKaggleTool("spi", "fetch_spi.py"));
  results.push(await runKaggleTool("fbref", "fetch_fbref.py"));
  results.push(
    await runKaggleTool("transfermarkt", "fetch_transfermarkt.py", [
      "--player-scores-dir",
      ".tmp/kaggle/player-scores",
    ])
  );
  // PR-25: match-day squad availability (availIdxHome/Away, keyPlayerHome/Away
  // → the Wave-2 availability→λ multipliers) derived from the SAME
  // player-scores snapshot fetch_transfermarkt just refreshed above — MUST run
  // after it, same dependency fetch_squad_availability.py's own docstring
  // documents. Previously only ran from a daily acquire_daily.py call gated
  // behind ORACLE_FETCH_SQUAD_AVAILABILITY=on (default off, so it never ran in
  // production — availability_features.csv sat stale for weeks). The
  // underlying Kaggle dataset only changes weekly anyway, so re-deriving it
  // daily would just be redundant CPU/IO for a byte-identical result between
  // Saturdays — the weekly cadence is the correct one, not just the cheap one.
  // No env flag here, matching every other unconditional fetcher in this list.
  results.push(
    await runKaggleTool("squad-availability", "fetch_squad_availability.py", [
      "--kaggle-dir",
      ".tmp/kaggle/player-scores",
    ])
  );
  results.push(
    await runKaggleTool("xg", "fetch_xg.py", ["--kaggle-ppda-dir", ".tmp/kaggle/xg-ppda"])
  );
  // build_xg_table MUST run AFTER both fetch_fbref (adds xG columns) and fetch_xg
  // (Understat per-match CSVs) — it merges both into the rolling team-xG prior,
  // Understat winning on collisions, FBref extending coverage to WC/Brazil/etc.
  results.push(await runKaggleTool("xg-table", "build_xg_table.py"));
  // Static venue table for the travel-friction + altitude engine features.
  results.push(await runKaggleTool("travel", "fetch_travel.py"));
  // PR-21: catalog freshness — --diff-only means the committed
  // catalog.generated.ts is read for the diff baseline but never overwritten
  // (a real catalog regeneration is still a hand-reviewed, separate step);
  // --json-out writes the newly-observed entries for the runtime overlay
  // (ORACLE_CATALOG_OVERLAY=on, apps/worker/src/catalogOverlay.ts) to pick
  // up next process start. Advisory — always runs, independent of that flag.
  results.push(
    await runKaggleTool("catalog-diff", "build_market_catalog.py", [
      "--in",
      ".tmp/fixtures/sportybet_today.json",
      "--out",
      "packages/engine/src/markets/catalog.generated.ts",
      "--diff-only",
      "--json-out",
      MARKET_CATALOG_OVERLAY_PATH,
    ])
  );

  const total = ((Date.now() - wall) / 1000).toFixed(1);
  const failed = results.filter((r) => !r.ok).map((r) => r.label);
  const okCount = results.length - failed.length;
  const tally =
    failed.length > 0
      ? `${okCount}/${results.length} ok — FAILED: ${failed.join(", ")}`
      : `${okCount}/${results.length} ok`;
  process.stdout.write(`[kaggle-refresh] === weekly refresh complete in ${total}s: ${tally} ===\n`);
}

// ── FotMob live-xG refresh (02:00 WAT, PR-7) ────────────────────────────────

/** Standalone, off-peak trigger for the FotMob live-xG refresh — decoupled
 *  from acquire-daily's 09:30 critical path (see the 02:00 cron registration's
 *  comment for the full BSOD-collision rationale). Shells out to
 *  acquire_daily.py --live-xg-refresh, which reads the on-disk sidecar for
 *  team names rather than re-scraping. Same non-fatal execFile pattern as
 *  runKaggleTool — a failure here must never take down the worker daemon. */
export function runFotmobXgRefresh(): Promise<void> {
  const python = PYTHON_BIN;
  const script = join(ROOT, "tools", "acquire_daily.py");
  const start = Date.now();
  return runPythonScript(python, script, ["--live-xg-refresh"], { cwd: ROOT }).then(
    ({ err, stdout, stderr }) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (err) {
        process.stderr.write(`[fotmob-xg-refresh] FAILED after ${elapsed}s — ${err.message}\n`);
      } else {
        process.stdout.write(`[fotmob-xg-refresh] done in ${elapsed}s\n`);
      }
    }
  );
}

// ── Sharp-reference fair-price capture — sharp_fair_at_pick (P1-4, Wave 2) ──
// fetchSharpFairPrice's capture PRIMITIVE for the moment a pick's price is
// first known. NOT wired into the real decision path from this file — the
// place a pick's price actually first gets recorded is
// packages/engine/src/batch/index.ts (AnalysisRecord creation) via
// apps/worker/src/dailyBatch.ts, both owned by other concurrent Wave-2
// workstreams and explicitly off-limits to WS2-C (see this workstream's task
// brief). This function is the ready-to-call capture primitive those call
// sites should invoke once a pick's {fixtureId, home, away, league, kickoff,
// market, side, pickOdds} is known — callers MUST treat it as fire-and-forget
// (`void captureSharpFairAtPick(pick)`, never an inline blocking await in a
// per-fixture decision loop) since fetchSharpFairPrice's subprocess call can
// take several seconds on the AI-Mode fallback tier. Fail-open: any sharp-
// feed miss still persists a record with sharp_fair_at_pick:null,
// source:"unavailable" — the pick itself is never blocked or delayed by this
// (the caller already logged/priced the pick before invoking this), and a
// persisted "unavailable" record still counts toward pick-coverage
// accounting (sharpFeed.ts's computeSharpFeedCoverage) so a genuine feed
// outage is visible in the ≥95% criterion rather than silently absent.
export interface PickDecidedForSharpCapture {
  fixtureId: string;
  home: string;
  away: string;
  league: string;
  kickoff: string;
  market: string;
  side: string;
  pickOdds: number;
}

export async function captureSharpFairAtPick(pick: PickDecidedForSharpCapture): Promise<void> {
  const storage = new MemoryAdapter(STORE_PATH);
  const now = new Date().toISOString();

  let fair: { fair: number; source: string } | null = null;
  try {
    fair = await fetchSharpFairPrice(pick.fixtureId, pick.market, pick.side, {
      home: pick.home,
      away: pick.away,
      league: pick.league,
      kickoff: pick.kickoff,
      sportKey: LEAGUE_TO_SPORT[pick.league],
      oddsApiKey: config.oddsApiKey,
    });
  } catch {
    fair = null; // belt-and-braces — fetchSharpFairPrice already fails open
  }

  const record: SharpOddsRecord = {
    id: sharpOddsRecordId(pick.fixtureId, pick.market, pick.side),
    fixtureKey: pick.fixtureId,
    market: pick.market,
    side: pick.side,
    pick_odds: pick.pickOdds,
    sharp_fair_at_pick: fair?.fair ?? null,
    sharp_fair_at_close: null,
    source: fair?.source ?? "unavailable",
    capturedAt: now,
  };

  try {
    await storage.upsertBulk(
      SHARP_ODDS_STORAGE_KEY,
      [record as unknown as Record<string, unknown>],
      "id"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[sharp-odds] failed to persist sharp_fair_at_pick for ${pick.fixtureId}: ${msg}\n`
    );
  }
}

// ── T-30m closing-odds sweep (every 5 min, PR-8a) ────────────────────────────
// Persisted-state, periodically-swept design (not an in-memory setTimeout per
// fixture): restart-safe by construction — every tick re-reads AnalysisRecords
// + closingOddsSnapshots from storage and re-derives "who's due" fresh, so a
// Servy-triggered restart mid-window just means the next tick (<=5min later)
// still catches any fixture still inside the 25-35min band. See the
// checkCrashLoopOnStartup comment (index.ts) for why in-memory timers can't be
// trusted on this box (11 restarts observed in ~13min once).

/** Odds-only, no-Playwright per-fixture re-scrape via closing_odds_snapshot.py
 *  — one batched process invocation per tick covering every due fixture, not
 *  one spawn per fixture. Same non-fatal execFile pattern as the other fetch
 *  tiers: a failure degrades to an empty result, never throws. */
function fetchClosingOddsSnapshot(
  eventIds: string[]
): Promise<Record<string, Record<string, unknown>>> {
  if (eventIds.length === 0) return Promise.resolve({});
  const python = PYTHON_BIN;
  const script = join(ROOT, "tools", "closing_odds_snapshot.py");
  return runPythonScript(python, script, eventIds, { cwd: ROOT }).then(
    ({ err, stdout, stderr }) => {
      if (stderr) process.stderr.write(stderr);
      if (err) {
        process.stderr.write(`[closing-odds] snapshot fetch FAILED — ${err.message}\n`);
        return {};
      }
      try {
        return JSON.parse(stdout.trim()) as Record<string, Record<string, unknown>>;
      } catch {
        process.stderr.write("[closing-odds] snapshot fetch: unparseable stdout\n");
        return {};
      }
    }
  );
}

/** sharp_fair_at_close capture (P1-4, Wave 2) — rides the same 25-35min
 *  pre-kickoff tick as the SportyBet odds-only snapshot above, but is fully
 *  independent: its own storage key (SHARP_ODDS_STORAGE_KEY), its own dedup
 *  set, and it never touches closingOddsSnapshots. A fixture only advances
 *  here if it already has a sharp_fair_at_pick record to attach the close
 *  price to (see captureSharpFairAtPick) — nothing to do otherwise. Never
 *  throws: any per-fixture fetchSharpFairPrice miss just leaves that record
 *  without a close price for this tick, retried automatically next tick like
 *  every other step in this sweep. */
async function sweepSharpFairAtClose(
  storage: MemoryAdapter,
  candidates: SharpSweepCandidate[],
  now: Date
): Promise<void> {
  if (candidates.length === 0) return;

  const existing = (await storage.get<SharpOddsRecord[]>(SHARP_ODDS_STORAGE_KEY)) ?? [];
  if (existing.length === 0) return; // nothing captured at pick-time yet — nothing to close out

  const byId = new Map(existing.map((r) => [sharpOddsRecordId(r.fixtureKey, r.market, r.side), r]));
  const alreadyClosed = new Set(
    existing.filter((r) => r.sharp_fair_at_close != null).map((r) => r.fixtureKey)
  );

  const due = selectDueSharpFixtures(candidates, alreadyClosed, now);
  if (due.length === 0) return;

  let captured = 0;
  for (const f of due) {
    const record = byId.get(sharpOddsRecordId(f.fixtureId, f.market, f.side));
    if (!record) continue; // no at-pick capture exists for this exact market/side

    let result: { fair: number; source: string } | null = null;
    try {
      result = await fetchSharpFairPrice(f.fixtureId, f.market, f.side, {
        home: f.home,
        away: f.away,
        league: f.league,
        kickoff: f.kickoff,
        sportKey: f.league ? LEAGUE_TO_SPORT[f.league] : undefined,
        oddsApiKey: config.oddsApiKey,
      });
    } catch {
      result = null; // belt-and-braces — fetchSharpFairPrice already fails open
    }
    if (!result) continue;

    record.sharp_fair_at_close = result.fair;
    record.sharp_fair_at_close_source = result.source;
    record.closeCapturedAt = now.toISOString();
    captured++;
  }

  if (captured > 0) {
    await storage.set(SHARP_ODDS_STORAGE_KEY, existing);
    process.stdout.write(
      `[sharp-odds] captured sharp_fair_at_close for ${captured}/${due.length} due fixture(s)\n`
    );
  }
}

/** One sweep tick: find today's/yesterday's analysed fixtures currently 25-35
 *  min from kickoff that don't already have a snapshot, resolve their
 *  SportyBet eventId via today's sidecar index, batch-fetch odds-only, and
 *  upsert the results keyed by fixtureId. Never throws — every step degrades
 *  to "try again next tick" rather than aborting the cron daemon.
 *
 *  Also runs the independent sharp_fair_at_close sweep (P1-4, Wave 2) —
 *  see sweepSharpFairAtClose above — before the SportyBet-specific steps
 *  below have a chance to early-return, so a fixture with nothing new for
 *  the SportyBet snapshot (already captured, no eventId, etc.) still gets a
 *  sharp-close attempt. */
export async function closingOddsSweepJob(): Promise<void> {
  const storage = new MemoryAdapter(STORE_PATH);
  const today = watDateString();
  const yesterday = watYesterdayString();

  const allRecords =
    (await storage.get<
      Array<{
        fixtureId: string;
        home: string;
        away: string;
        league?: string;
        kickoff: string;
        analysedAt: string;
        deterministicTopPick?: { market?: string; label?: string; odds?: number } | null;
      }>
    >(STORAGE_KEYS.analysisRecords)) ?? [];
  // Coarse candidate narrowing only (today/yesterday tolerant, covers a kickoff
  // just after WAT midnight relative to when the record was analysed the prior
  // WAT day) — the real gate is selectDueFixtures' epoch-instant window check.
  const todaysOrYesterdays = allRecords.filter(
    (r) => r.kickoff.startsWith(today) || r.kickoff.startsWith(yesterday)
  );
  const candidates: SweepCandidate[] = todaysOrYesterdays;
  if (candidates.length === 0) return;

  const sharpCandidates: SharpSweepCandidate[] = todaysOrYesterdays.map((r) => ({
    ...r,
    market: r.deterministicTopPick?.market,
    side: r.deterministicTopPick?.label?.toLowerCase(),
    pickOdds: r.deterministicTopPick?.odds,
  }));
  await sweepSharpFairAtClose(storage, sharpCandidates, new Date());

  const existingSnapshots =
    (await storage.get<ClosingOddsSnapshot[]>(STORAGE_KEYS.closingOddsSnapshots)) ?? [];
  const alreadySnapshotted = new Set(existingSnapshots.map((s) => s.fixtureId));

  const due = selectDueFixtures(candidates, alreadySnapshotted, new Date());
  if (due.length === 0) return;

  const sportyIndex = await loadSportyBetIndex(today);
  if (!sportyIndex) {
    process.stdout.write("[closing-odds] sportybet index unavailable this tick — skipping\n");
    return;
  }

  const withEventId: Array<{ fixtureId: string; eventId: string; kickoff: string }> = [];
  for (const f of due) {
    const eventId = findSportyBetEventId(sportyIndex, f.home, f.away);
    if (eventId) withEventId.push({ fixtureId: f.fixtureId, eventId, kickoff: f.kickoff });
  }
  if (withEventId.length === 0) {
    process.stdout.write(
      `[closing-odds] ${due.length} fixture(s) due, none had a resolvable eventId\n`
    );
    return;
  }

  const results = await fetchClosingOddsSnapshot(withEventId.map((f) => f.eventId));
  const now = new Date().toISOString();
  const snapshots: ClosingOddsSnapshot[] = [];
  for (const f of withEventId) {
    const odds = results[f.eventId];
    if (!odds) continue;
    snapshots.push({
      fixtureId: f.fixtureId,
      eventId: f.eventId,
      kickoff: f.kickoff,
      snapshotAt: now,
      odds: odds as ClosingOddsSnapshot["odds"],
    });
  }
  if (snapshots.length === 0) return;

  await storage.upsertBulk(
    STORAGE_KEYS.closingOddsSnapshots,
    snapshots as unknown as Record<string, unknown>[],
    "fixtureId"
  );
  process.stdout.write(
    `[closing-odds] snapshotted ${snapshots.length}/${due.length} due fixture(s)\n`
  );
}
