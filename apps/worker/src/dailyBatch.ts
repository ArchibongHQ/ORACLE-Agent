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
  V3DeliveryCandidate,
} from "@oracle/engine";
import { makeFixtureId } from "@oracle/engine";
import type { ActionablePick } from "@oracle/notify";
import { buildNotifiers, notifyAll, summarizeBatch } from "@oracle/notify";
import {
  buildMarketsV3GateConfig,
  buildMarketsV3SlateOutputs,
  buildTwoTierSlate,
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
import { getStaleBuildNote } from "./buildFreshness.js";
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

// ── Phase 2, two-tier slate: V3DeliveryCandidate → ActionablePick ──────────
// The engine layer stays notify-agnostic (packages/engine has no @oracle/notify
// dependency — see engine's CLAUDE.md gotcha), so this conversion lives here,
// the one place that already has BOTH types in scope. confidence is ALWAYS
// modelProb (candidate.mp) — never an LLM's self-reported number — per the
// plan's explicit "confidence = modelProb ALWAYS" requirement for unified-slate
// delivery. eventId is resolved the same way the pre-Phase-2 summarizeBatch
// path already did (findSidecarDetail against the shared sportyIndex).
// Exported for direct unit testing — runDailyBatch's own dependency chain
// (scraping/LLM/external APIs) has no existing test harness, so this pure
// conversion is tested in isolation rather than via a full runDailyBatch mock.
export function deliveryCandidateToPick(
  c: V3DeliveryCandidate,
  tier: "qualified" | "watchlist",
  resolveEventId: (home: string, away: string) => string | undefined
): ActionablePick {
  const eventId = resolveEventId(c.home, c.away);
  return {
    home: c.home,
    away: c.away,
    league: c.league,
    kickoff: c.kickoff,
    market: c.marketName,
    side: c.desc,
    odds: c.odds,
    stakePct: c.stakePct,
    confidence: c.mp,
    tier,
    ...(tier === "qualified" ? { trapWarning: c.trapWarning } : { shortfall: c.shortfall }),
    ...(eventId ? { eventId } : {}),
  };
}

// [Phase 2, two-tier slate] Sidecar-unmapped-fixture fallback (design
// decision 1: single-engine purity — a fixture the unified engine never
// produced ANY candidate for, on either tier, falls back to its legacy
// per-fixture pick, watchlist-only, never presented as a Tier① recommendation).
// Exported for direct unit testing — same rationale as deliveryCandidateToPick
// above. Both the tier1/tier2 candidates AND the legacy picks must be keyed by
// the SAME makeFixtureId(home, away, kickoff) slug for this comparison to work;
// a prior draft compared candidates' real fixtureId slugs against a raw
// `${home}::${away}::${kickoff}` string built from the legacy picks — the two
// formats can never match, silently misclassifying EVERY legacy pick as
// "unmapped" and duplicating it into the watchlist even when the same fixture
// already had a real Tier① pick (caught by /gstack-review's testing +
// maintainability specialists before this branch shipped). */
export function findUnmappedLegacyPicks<T extends { home: string; away: string; kickoff: string }>(
  legacyPicks: T[],
  tieredCandidates: Array<{ fixtureId: string }>
): T[] {
  const mappedFixtureIds = new Set(tieredCandidates.map((c) => c.fixtureId));
  return legacyPicks.filter((p) => !mappedFixtureIds.has(makeFixtureId(p.home, p.away, p.kickoff)));
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
  let sportyIndex = await loadSportyBetIndex(watDateString());
  logMemoryUsage("daily-batch:sportyIndex-loaded");
  // [reliability P1] isLakeFreshForToday() can say "fresh" (heartbeat looks
  // recent) while the sidecar index itself is still unusable — a stale/corrupt
  // JSON sidecar despite a fresh heartbeat, or a race the heartbeat doesn't
  // catch. Left alone, that silently fails the v3 gate open on every fixture
  // for the whole batch with no attempt to recover. One-shot re-scrape +
  // re-load (same acquireDaily gap-fill used above), only when the gate is
  // actually going to be used — no point re-scraping if the gate is off.
  if (
    (!sportyIndex || sportyIndex.detailByKey.size === 0) &&
    config.enableMarketsV3 === "on" &&
    config.marketsV3Gate !== false
  ) {
    process.stdout.write(
      "[markets-v3] sidecar index empty despite fresh lake — re-running acquisition once\n"
    );
    await acquireDaily();
    sportyIndex = await loadSportyBetIndex(watDateString());
    if (!sportyIndex || sportyIndex.detailByKey.size === 0) {
      process.stderr.write(
        "[markets-v3] sidecar re-load attempt still empty — proceeding to fail-open gate\n"
      );
    }
  }
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

  // Build-freshness watchdog (apps/worker/src/buildFreshness.ts) — set once at
  // process startup (index.ts), surfaced here so a stale-dist deploy shows up
  // on the actual Telegram summary, not just in the startup log a human has to
  // go looking for.
  const staleBuildNote = getStaleBuildNote();
  if (staleBuildNote) summary.staleBuildNote = staleBuildNote;

  // [Phase 2, two-tier slate] Hoisted so the heartbeat write below can attach
  // a deliveredSlate projection (RunManifest precedent, buildManifestDeliveredSlate)
  // regardless of which branch below populated it — undefined stays undefined
  // (legacy mode, v3 off) rather than needing a second condition duplicated here.
  let deliveredSlateCounts: { tier1: number; tier2: number } | undefined;

  // ── PR-5b: v3 slate outputs A–D + sanity (fail-open to the legacy trim) ──
  if (config.enableMarketsV3 === "on" && config.marketsV3Outputs !== false) {
    const successJobs = batch.jobs.filter((j): j is FixtureJobSuccess => j.status === "ok");
    // [patterns-engine Wave 2] Only v3Patterns "on" fills the live pool from
    // fallback (non-gate-surviving +EV) candidates — "shadow"/"off" leave the
    // pool exactly as today; shadow's fallback still rides in v3BestFallback
    // for ledger review, it just never reaches this live Output-A pool.
    const v3Outputs = buildMarketsV3SlateOutputs(successJobs, {
      fillToTarget: config.v3Patterns === "on",
    });
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

    // [Phase 2, two-tier slate] Single selection path: delivered slate = the
    // cross-fixture pattern-aware pool, default "on". config.unifiedSlate
    // defaults "on" at the env.ts layer — "legacy" is the byte-identical
    // escape hatch (curateActionableByV3Outputs' dead >39 branch below,
    // unchanged) that restores summarizeBatch's per-fixture-decision output.
    if (config.unifiedSlate !== "legacy") {
      const resolveEventId = (home: string, away: string) =>
        sportyIndex ? findSidecarDetail(sportyIndex.detailByKey, home, away)?.eventId : undefined;
      const { tier1, tier2 } = buildTwoTierSlate(successJobs, { target: 39 });
      // Sidecar-unmapped fixtures (v3 didn't run, or nothing on either tier
      // for this fixture) fall back to their legacy per-fixture pick,
      // watchlist-only — design decision 1 (single-engine purity: an
      // unmapped fixture's legacy pick was never gated by the unified
      // engine's ev>0/pattern machinery, so it can never be presented as a
      // Tier① recommendation, only surfaced for visibility). See
      // findUnmappedLegacyPicks's own header for the key-format gotcha this
      // extraction exists to prevent regressing.
      const unmappedLegacyPicks = findUnmappedLegacyPicks(summary.actionable, [...tier1, ...tier2]);
      summary.actionable = tier1.map((c) =>
        deliveryCandidateToPick(c, "qualified", resolveEventId)
      );
      summary.actionableCount = summary.actionable.length;
      summary.watchlist = [
        ...tier2.map((c) => deliveryCandidateToPick(c, "watchlist", resolveEventId)),
        ...unmappedLegacyPicks.map((p) => ({
          ...p,
          tier: "watchlist" as const,
          shortfall: "not priced by unified engine",
        })),
      ];
      process.stdout.write(
        `[slate] tier1:${tier1.length} tier2:${tier2.length} delivered:${summary.actionable.length + summary.watchlist.length}\n`
      );
      deliveredSlateCounts = { tier1: tier1.length, tier2: tier2.length };
    } else if (summary.actionable.length > 39) {
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

  // [Phase 2, two-tier slate] Booking books Tier① ONLY — bookAccumulator
  // receives summary.actionable, never summary.watchlist (booking has no
  // access to it at all — this parameter IS the whole contract). In unified
  // mode summary.actionable is exactly Tier①, so this line already satisfies
  // the plan's "booking books Tier① only" requirement structurally, not via
  // an extra filter. Do not change this call to pass watchlist rows.
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
    // [Phase 2, two-tier slate] Telemetry only — the RunManifest.deliveredSlate
    // TYPE + buildManifestDeliveredSlate builder exist (packages/engine/types.ts,
    // runtime's slateOutputs.ts) for a future session to wire once dailyBatch.ts
    // (a multi-chunk loop with no single whole-slate RunManifest object today —
    // runAnalysis only builds one PER CHUNK) gains its own whole-slate manifest.
    // Undefined (key omitted) when v3/unified-slate didn't run this batch.
    ...(deliveredSlateCounts ? { deliveredSlate: deliveredSlateCounts } : {}),
  });

  return batch;
}
