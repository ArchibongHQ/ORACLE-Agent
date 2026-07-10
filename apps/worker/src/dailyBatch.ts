/** [PR-9, worker god-file split] The 09:35 WAT main all-markets batch,
 *  extracted from index.ts's "thin cron shell". Its internal scrape is
 *  gap-fill-only (reuses acquireDaily's in-flight guard from
 *  dailyAcquisition.ts so a concurrent 09:30 run is awaited, not duplicated),
 *  then runs the priority-ordered chunked LLM analysis and delivers the
 *  actionable slate. index.ts wires runDailyBatch into cron.schedule(...),
 *  the daily-batch back-online trigger, and the --run-now one-shot flag. */

import { join } from "node:path";
import type {
  BatchResult,
  FeedIntegritySignal,
  FixtureJobSuccess,
  RunManifest,
} from "@oracle/engine";
import { buildNotifiers, notifyAll, summarizeBatch } from "@oracle/notify";
import {
  buildMarketsV3GateConfig,
  buildMarketsV3SlateOutputs,
  curateActionableByV3Outputs,
  fetchTodaysFixtures,
  findSidecarDetail,
  formatMarketCoverageNote,
  formatMiniAccaAppendix,
  formatSlateGateLog,
  loadSportyBetIndex,
  ORACLE_PRIORITY_LEAGUES,
  prefilterMarketsV3Jobs,
  rollupCoverage,
  runAnalysis,
} from "@oracle/runtime";
import { MemoryAdapter } from "@oracle/storage";
import { acquireDaily } from "./dailyAcquisition.js";
import { buildGoalsCrossCheckHook } from "./goalsV3Pipeline.js";
import { ANALYSIS_CHUNK_SIZE, config, env, PYTHON_BIN, ROOT, STORE_PATH } from "./workerContext.js";
import {
  isLakeFreshForToday,
  logMemoryUsage,
  mergeBatchChunks,
  runPythonScript,
  watDateString,
  writeHeartbeat,
} from "./workerUtils.js";

// ── Lineup fetcher (API-Football, pre-batch) ─────────────────────────────────
// Best-effort: fetch_lineups.py writes .tmp/oracle-store/oracle_lineups.json,
// which enrichWithLineups (runtime) merges into softContext. Never blocks batch.

function fetchLineups(): Promise<void> {
  if (!config.apiFootballKey) return Promise.resolve();
  const python = PYTHON_BIN;
  const script = join(ROOT, "tools", "fetch_lineups.py");
  return runPythonScript(python, script, [], { cwd: ROOT }).then(({ err, stdout, stderr }) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (err) process.stderr.write(`fetch_lineups error: ${err.message}\n`);
  });
}

// ── Daily batch (09:35 WAT) ─────────────────────────────────────────────────
// mergeBatchChunks lives in ./workerUtils.js — shared with goalsAccumulator.ts's
// legacy runGoalsBatch chunk loop, which merges chunks the same way.

/** Returns the analyzed batch, or null when there were no fixtures to analyze.
 *  The goals pipeline (runGoalsBatch) is fully independent of this batch as of
 *  the 2026-06-24 rewrite — it no longer sources picks from this batch's output. */
export async function runDailyBatch(
  trigger: RunManifest["trigger"] = "scheduled"
): Promise<BatchResult | null> {
  if (isLakeFreshForToday()) {
    process.stdout.write("[batch] daily lake fresh — skipping gap-fill scrape\n");
  } else {
    process.stdout.write("[batch] daily lake missing/stale — running gap-fill acquisition\n");
    await acquireDaily();
  }
  await fetchLineups();
  const storage = new MemoryAdapter(STORE_PATH);

  // News intel runs when enabled; Perplexity key optional (Gemini AI-Mode fallback covers it).
  const newsKey = config.enableNewsIntel ? config.perplexityApiKey : undefined;
  const newsStorage = config.enableNewsIntel ? storage : undefined;
  const { jobs, source: _source } = await fetchTodaysFixtures(
    config.oddsApiKey,
    config.enableWebSearchOddsFallback,
    config.geminiApiKey,
    config.footballDataApiKey,
    newsKey,
    config.sharpApiIoKey,
    config.apiFootballKey,
    config.oddsApiIoKey,
    config.oddsPapiKey,
    config.sportsGameOddsKey,
    config.maxFixturesPerRun,
    newsStorage,
    config.webOddsMinConsensus,
    config.webOddsVarianceThreshold
  );

  if (!jobs.length) {
    return null;
  }

  // ── PR-5a: v3 slate pre-filter (eligibility + completeness, fail-open) ────
  // Drops fixtures the v3 gate would discard anyway BEFORE any engine/LLM
  // spend. Only acts when v3 is live ("on") AND ORACLE_MARKETS_V3_GATE is on;
  // sidecar-unmapped fixtures always pass through, and an all-drop fails open
  // to the ungated slate (more likely an upstream league-name/schema
  // regression than a genuinely empty slate). Survivors carry the per-fixture
  // telemetry.v3Heightened stamp the heightened EV bars key off.
  // The index is loaded here (not at the booking block) so both uses share one read.
  const sportyIndex = await loadSportyBetIndex(watDateString());
  logMemoryUsage("daily-batch:sportyIndex-loaded");
  let gatedJobs = jobs;
  // [Wave 2, WS2-A follow-up] "flagged" (non-contaminated) fixtures survive the
  // slate gate — this map lets batch/index.ts apply a fixture-wide stake
  // downgrade for them via BatchOptions.integrityByFixture, keyed the same
  // `${home}|${away}` way feedIntegrity.ts/slateGate.ts already use. Truly
  // contaminated fixtures never reach here (discarded in prefilterMarketsV3Jobs).
  let integrityByFixture: Record<string, FeedIntegritySignal> | undefined;
  if (config.enableMarketsV3 === "on" && config.marketsV3Gate !== false) {
    const {
      jobs: survivors,
      summary,
      integrityReport,
    } = prefilterMarketsV3Jobs(jobs, sportyIndex?.detailByKey, buildMarketsV3GateConfig(env), {
      completenessV4: config.v3CompletenessV4,
      // [review fix] config.feedIntegrity was never threaded through — this
      // call always fell back to prefilterMarketsV3Jobs's own hardcoded "on"
      // default regardless of ORACLE_FEED_INTEGRITY's actual value. Silently
      // masked since the two defaults happen to match; a real bug the moment
      // anyone sets the env var to "shadow" or "off".
      feedIntegrity: config.feedIntegrity,
    });
    if (summary)
      process.stdout.write(`[markets-v3] ${formatSlateGateLog(summary, integrityReport)}\n`);
    if (integrityReport?.results.length) {
      integrityByFixture = {};
      for (const r of integrityReport.results) {
        integrityByFixture[r.fixtureKey] = {
          verdict: r.verdict,
          reason: r.reason,
          detail: r.detail,
        };
      }
    }
    if (survivors.length > 0) {
      gatedJobs = survivors;
    } else {
      process.stderr.write(
        "[markets-v3] gate dropped every fixture — failing open to the ungated slate\n"
      );
    }
  }

  // Priority-ordered chunk loop: jobs are already sorted by selectFixtures (tier 0
  // priority leagues first, then tier 1, then by data-completeness + score within tier).
  // Analyze in chunks of ANALYSIS_CHUNK_SIZE; stop as soon as 39 actionable picks
  // accumulate — avoids wasting Claude calls on low-priority fixtures when top leagues
  // already deliver enough edges. Safety net (the 39-curation block below) trims any
  // overshoot when a single chunk yields more than 39 actionable.
  const batchChunks: BatchResult[] = [];
  const allRecords: unknown[] = [];
  let finalReportPath: string | undefined;

  // PR-6 R10: cross-check hook (goals-family picks re-verified against the
  // independent goals engine). Built once over the shared sidecar index;
  // undefined when the flag is off or no index loaded (⇒ engine skips it).
  const goalsCrossCheck = buildGoalsCrossCheckHook(sportyIndex?.detailByKey);

  for (let i = 0; i < gatedJobs.length; i += ANALYSIS_CHUNK_SIZE) {
    const chunk = gatedJobs.slice(i, i + ANALYSIS_CHUNK_SIZE);
    const chunkIdx = Math.floor(i / ANALYSIS_CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(gatedJobs.length / ANALYSIS_CHUNK_SIZE);
    process.stdout.write(
      `[batch] chunk ${chunkIdx}/${totalChunks}: fixtures ${i + 1}–${i + chunk.length} of ${gatedJobs.length}\n`
    );
    const analyzedSoFar = batchChunks.reduce((s, c) => s + c.completedCount, 0);
    const {
      batch: chunkBatch,
      records: chunkRecords,
      reportPath: chunkReportPath,
    } = await runAnalysis(
      chunk,
      { storage, config, goalsCrossCheck },
      {
        trigger,
        writeReportToDisk: i === 0, // only first chunk writes the HTML report
        batchOptions: {
          onProgress: ({ completed, current }) => {
            if (current)
              process.stdout.write(
                `[batch] ${analyzedSoFar + completed}/${gatedJobs.length}: ${current}\n`
              );
          },
          integrityByFixture,
        },
      }
    );
    batchChunks.push(chunkBatch);
    allRecords.push(...(chunkRecords as unknown[]));
    if (chunkReportPath) finalReportPath = chunkReportPath;

    const cumulativeActionable = batchChunks.reduce((s, c) => s + c.actionableCount, 0);
    process.stdout.write(
      `[batch] chunk ${chunkIdx} done — ${chunkBatch.completedCount} analyzed, ` +
        `${chunkBatch.actionableCount} actionable this chunk, ${cumulativeActionable} total\n`
    );

    if (cumulativeActionable >= 39) {
      const done = batchChunks.reduce((s, c) => s + c.completedCount, 0);
      process.stdout.write(
        `[batch] 39 actionable reached after ${done}/${gatedJobs.length} fixtures — stopping early\n`
      );
      break;
    }
  }
  logMemoryUsage("daily-batch:chunk-loop-done");

  const batch = mergeBatchChunks(batchChunks);
  const records = allRecords;
  const reportPath = finalReportPath;

  if (records.length > 0) process.stdout.write(`[batch] ${records.length} records persisted\n`);
  if (reportPath) process.stdout.write(`[batch] report: ${reportPath}\n`);
  if (batch.cost.halted)
    process.stderr.write("[batch] WARNING: cost cap halted the batch before completion\n");

  // ── SportyBet booking (off by default; never blocks delivery) ──────────────
  // resolveEventId looks up the sidecar's eventId for each pick — without it
  // every ActionablePick.eventId is undefined and bookAccumulator skips every leg.
  // sportyIndex was loaded once before the pre-filter; reused here.
  const summary = summarizeBatch(batch, undefined, (home, away) =>
    sportyIndex ? findSidecarDetail(sportyIndex.detailByKey, home, away)?.eventId : undefined
  );

  // ── PR-5b: v3 slate outputs A–D + sanity (fail-open to the legacy trim) ──
  if (config.enableMarketsV3 === "on" && config.marketsV3Outputs !== false) {
    const successJobs = batch.jobs.filter((j): j is FixtureJobSuccess => j.status === "ok");
    const v3Outputs = buildMarketsV3SlateOutputs(successJobs);
    process.stdout.write(
      `[markets-v3] ALL-MARKETS OUTPUT A:${v3Outputs.outputA.length} ` +
        `B:${v3Outputs.outputB.miniAcca.length}legs C:${v3Outputs.outputC.length} ` +
        `D:${v3Outputs.outputD.length} — ${v3Outputs.sanityLine}\n`
    );
    if (v3Outputs.skewShrinkLine)
      process.stdout.write(`[markets-v3] ${v3Outputs.skewShrinkLine}\n`);
    // v5-prompt §7.5 mini-ACCA appendix (wave-1, 2026-07-10) — logged and folded
    // into the delivered summary alongside the sanity/skew lines below. Always
    // a string (formatMiniAccaAppendix renders an explicit skip note rather
    // than nothing when fewer than 2 Class S/M legs qualified), so the daily
    // Telegram message always states the appendix's outcome one way or another.
    const miniAccaAppendixLine = formatMiniAccaAppendix(v3Outputs.miniAccaAppendix);
    process.stdout.write(`[markets-v3] ${miniAccaAppendixLine}\n`);
    if (summary.actionable.length > 39) {
      summary.actionable = curateActionableByV3Outputs(summary.actionable, v3Outputs.outputA, 39);
      summary.actionableCount = summary.actionable.length;
    }
    // BatchSummary (packages/notify) has no dedicated mini-ACCA field — reusing
    // the existing free-text sanityNote (already rendered verbatim by
    // formatSummaryText/Html in @oracle/notify) rather than touching that
    // package, which is out of this workstream's edit scope.
    summary.sanityNote = [v3Outputs.sanityLine, v3Outputs.skewShrinkLine, miniAccaAppendixLine]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    // PR-20: slate-wide route-coverage rollup — reports the recoverable skip
    // tail's size, never suppresses picks. ORACLE_MARKETS_COVERAGE=off skips
    // the computation entirely (byte-identical to pre-PR-20 otherwise).
    if (config.marketsCoverageNote !== false) {
      const coverage = rollupCoverage(successJobs);
      if (coverage) {
        const note = formatMarketCoverageNote(coverage);
        process.stdout.write(`[markets-v3] ${note}\n`);
        summary.marketCoverageNote = note;
      }
    }
  } else if (summary.actionable.length > 39) {
    // Legacy trim — BYTE-IDENTICAL to pre-PR-5b. Only path when v3 outputs
    // are off or v3 isn't live ("on") — this is the regression pin.
    const tierOf = (league: string) => (ORACLE_PRIORITY_LEAGUES.has(league) ? 0 : 1);
    summary.actionable = [...summary.actionable]
      .sort((a, b) => tierOf(a.league) - tierOf(b.league) || b.confidence - a.confidence)
      .slice(0, 39);
    summary.actionableCount = summary.actionable.length;
  }

  if (env.ENABLE_SPORTYBET_BOOKING === "true" && summary.actionable.length > 0) {
    try {
      const { bookAccumulator } = await import("@oracle/booking");
      const booking = await bookAccumulator(summary.actionable);
      if (booking.code) {
        summary.bookingCode = booking.code;
        summary.bookingLoadUrl = booking.loadUrl ?? undefined;
        summary.bookingUnmatched = booking.unmatched;
        if (booking.loadUrl)
          process.stdout.write(`[booking] ${booking.code}: ${booking.loadUrl}\n`);
        if (booking.unmatched.length)
          process.stderr.write(
            `[booking] ${booking.unmatched.length} pick(s) unmatched on SportyBet\n`
          );
      } else {
        summary.bookingError = booking.error ?? "no code returned";
      }
    } catch (err) {
      summary.bookingError = err instanceof Error ? err.message : String(err);
    }
  }

  // Push actionable picks (+ booking code if available) to configured channels
  const notifiers = buildNotifiers(env);
  if (notifiers.length) {
    await notifyAll(notifiers, summary);
  }

  writeHeartbeat("lastBatch", {
    trigger,
    fixtures: jobs.length,
    records: records.length,
    halted: batch.cost.halted,
  });

  return batch;
}
