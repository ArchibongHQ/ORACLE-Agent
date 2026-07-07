/** [PR-9, worker god-file split] The 09:30 WAT acquisition family, extracted
 *  from index.ts's "thin cron shell": scrape -> Parquet lake write -> news
 *  enrichment -> fixture report (acquireDailyJob/sendDailyFixtureReport),
 *  plus the off-peak FotMob refresh (02:00 WAT) and the T-30m closing-odds
 *  sweep (every 5 min) that both piggyback on the same SportyBet sidecar
 *  this family produces, and the weekly Kaggle dataset refresh. index.ts
 *  wires these into cron.schedule(...) and the --run-* one-shot flags. */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClosingOddsSnapshot } from "@oracle/engine";
import { sendTelegramDocument, sendTelegramText } from "@oracle/notify";
import {
  findSportyBetEventId,
  generateAndWriteFixtureWorkbook,
  loadSportyBetIndex,
} from "@oracle/runtime";
import { MemoryAdapter, STORAGE_KEYS } from "@oracle/storage";
import { awaitAcquireOrTimeout, trackAcquireJob } from "./acquireChain.js";
import { type SweepCandidate, selectDueFixtures } from "./closingOddsSweep.js";
import { config, env, PYTHON_BIN, ROOT, STORE_PATH } from "./workerContext.js";
import {
  readFixtureReportState,
  watDateString,
  watYesterdayString,
  writeHeartbeat,
} from "./workerUtils.js";
import { formatXgCoverageNote } from "./xgCoverageNote.js";

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
  const run = new Promise<number>((resolve) => {
    execFile(python, [script], { cwd: ROOT }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) process.stderr.write(`acquire_daily error: ${err.message}\n`);
      const m = stdout.match(/acquired:(\d+)/);
      resolve(m ? parseInt(m[1], 10) : 0);
    });
  }).finally(() => {
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
  return new Promise((resolve) => {
    execFile(python, [script], { cwd: ROOT }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) process.stderr.write(`enrich_news error: ${err.message}\n`);
      resolve();
    });
  });
}

/** Full 09:30 WAT acquisition job: scrape -> lake write -> news enrichment ->
 *  heartbeat. Only stamps lastAcquire when fixtures were actually acquired, so
 *  a failed run leaves the lake-staleness check above free to keep retrying
 *  rather than masking the failure with a fresh timestamp.
 *
 *  [audit fix, P0-4] Tracked via trackAcquireJob so the 09:35/09:40 cron slots
 *  (and the daily-batch back-online trigger) can await its actual completion
 *  instead of firing on a fixed wall-clock offset — see acquireChain.ts. */
export function acquireDailyJob(): Promise<void> {
  return trackAcquireJob(
    (async () => {
      const count = await acquireDaily();
      await runNewsEnrichment();
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
    if (result) {
      // PR-19: log the xG coverage line unconditionally (even on the
      // marketsEmpty early-return below) — it's a data-availability signal
      // independent of whether markets depth has enriched yet, and it's the
      // one place the historical silent-zero FotMob-tier bug becomes visible
      // in the worker's own logs, not just build_xg_table.py's stdout.
      process.stdout.write(`[fixture-report] ${formatXgCoverageNote(result.xgCoverage)}\n`);
    }
    if (!result) {
      // No-fixtures is a real, reportable state — surface it loudly (was a silent
      // return that made "the report never fired" indistinguishable from a crash).
      process.stderr.write("[fixture-report] WARN no SportyBet fixtures available for today\n");
      if (hasCreds) {
        await sendTelegramText(
          env.TELEGRAM_BOT_TOKEN as string,
          env.TELEGRAM_CHAT_ID as string,
          `ORACLE — no SportyBet fixtures found for ${today}.`
        );
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
      const alreadyFlagged = readFixtureReportState().placeholderDate === today;
      if (hasCreds && !alreadyFlagged) {
        await sendTelegramText(
          env.TELEGRAM_BOT_TOKEN as string,
          env.TELEGRAM_CHAT_ID as string,
          `ORACLE — ${today} full-lake report BLOCKED: market depth not yet enriched (NO accumulated enriched data). Will auto-send the full spreadsheet once ready.`
        );
      }
      if (!alreadyFlagged) writeHeartbeat("fixtureReportPlaceholder", { date: today });
      return;
    }
    const allPaths = [result.fixturesPath, ...result.marketsPaths];
    for (const p of allPaths) {
      const kb = Math.round(statSync(p).size / 1024);
      process.stdout.write(`[fixture-report] wrote ${p} (${kb}KB)\n`);
    }

    if (hasCreds) {
      const total = allPaths.length;
      const partCount = result.marketsPaths.length;
      await sendTelegramDocument(
        env.TELEGRAM_BOT_TOKEN as string,
        env.TELEGRAM_CHAT_ID as string,
        result.fixturesPath,
        `ORACLE daily fixtures (spreadsheet) — ${today} (${result.fixtureCount} fixtures) [file 1/${total}]\n${formatXgCoverageNote(result.xgCoverage)}`
      );
      for (let i = 0; i < result.marketsPaths.length; i++) {
        await sendTelegramDocument(
          env.TELEGRAM_BOT_TOKEN as string,
          env.TELEGRAM_CHAT_ID as string,
          result.marketsPaths[i] as string,
          `ORACLE daily markets — ${today} [file ${i + 2}/${total}${partCount > 1 ? `, part ${i + 1} of ${partCount}` : ""}]`
        );
      }
      process.stdout.write(
        `[fixture-report] delivered ${total} file(s) to Telegram in ${Date.now() - startedAt.getTime()}ms\n`
      );
      writeHeartbeat("fixtureReportDelivered", { date: today });
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

function runKaggleTool(label: string, scriptName: string, args: string[] = []): Promise<void> {
  const python = PYTHON_BIN;
  const script = join(ROOT, "tools", scriptName);
  const start = Date.now();
  process.stdout.write(`[kaggle-refresh] ${label}: starting\n`);
  return new Promise((resolve) => {
    execFile(python, [script, ...args], { cwd: ROOT }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (err) {
        process.stderr.write(
          `[kaggle-refresh] ${label}: FAILED after ${elapsed}s — ${err.message}\n`
        );
      } else {
        process.stdout.write(`[kaggle-refresh] ${label}: done in ${elapsed}s\n`);
      }
      resolve(); // always resolve — one failure must not abort the rest
    });
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

  await runKaggleTool("odds_timeseries", "fetch_odds_timeseries.py", [
    "--btb-dir",
    ".tmp/kaggle/beat-the-bookie",
    "--ah-dir",
    ".tmp/kaggle/ah-odds",
  ]);
  await runKaggleTool("spi", "fetch_spi.py");
  await runKaggleTool("fbref", "fetch_fbref.py");
  await runKaggleTool("transfermarkt", "fetch_transfermarkt.py", [
    "--player-scores-dir",
    ".tmp/kaggle/player-scores",
  ]);
  await runKaggleTool("xg", "fetch_xg.py", ["--kaggle-ppda-dir", ".tmp/kaggle/xg-ppda"]);
  // build_xg_table MUST run AFTER both fetch_fbref (adds xG columns) and fetch_xg
  // (Understat per-match CSVs) — it merges both into the rolling team-xG prior,
  // Understat winning on collisions, FBref extending coverage to WC/Brazil/etc.
  await runKaggleTool("xg-table", "build_xg_table.py");
  // Static venue table for the travel-friction + altitude engine features.
  await runKaggleTool("travel", "fetch_travel.py");

  const total = ((Date.now() - wall) / 1000).toFixed(1);
  process.stdout.write(`[kaggle-refresh] === weekly refresh complete in ${total}s ===\n`);
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
  return new Promise((resolve) => {
    execFile(python, [script, "--live-xg-refresh"], { cwd: ROOT }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (err) {
        process.stderr.write(`[fotmob-xg-refresh] FAILED after ${elapsed}s — ${err.message}\n`);
      } else {
        process.stdout.write(`[fotmob-xg-refresh] done in ${elapsed}s\n`);
      }
      resolve(); // best-effort — never rejects, matches every other fetch tier here
    });
  });
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
  return new Promise((resolve) => {
    execFile(python, [script, ...eventIds], { cwd: ROOT }, (err, stdout, stderr) => {
      if (stderr) process.stderr.write(stderr);
      if (err) {
        process.stderr.write(`[closing-odds] snapshot fetch FAILED — ${err.message}\n`);
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as Record<string, Record<string, unknown>>);
      } catch {
        process.stderr.write("[closing-odds] snapshot fetch: unparseable stdout\n");
        resolve({});
      }
    });
  });
}

/** One sweep tick: find today's/yesterday's analysed fixtures currently 25-35
 *  min from kickoff that don't already have a snapshot, resolve their
 *  SportyBet eventId via today's sidecar index, batch-fetch odds-only, and
 *  upsert the results keyed by fixtureId. Never throws — every step degrades
 *  to "try again next tick" rather than aborting the cron daemon. */
export async function closingOddsSweepJob(): Promise<void> {
  const storage = new MemoryAdapter(STORE_PATH);
  const today = watDateString();
  const yesterday = watYesterdayString();

  const allRecords =
    (await storage.get<
      Array<{ fixtureId: string; home: string; away: string; kickoff: string; analysedAt: string }>
    >(STORAGE_KEYS.analysisRecords)) ?? [];
  // Coarse candidate narrowing only (today/yesterday tolerant, covers a kickoff
  // just after WAT midnight relative to when the record was analysed the prior
  // WAT day) — the real gate is selectDueFixtures' epoch-instant window check.
  const candidates: SweepCandidate[] = allRecords.filter(
    (r) => r.kickoff.startsWith(today) || r.kickoff.startsWith(yesterday)
  );
  if (candidates.length === 0) return;

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
