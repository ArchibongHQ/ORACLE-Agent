/** [PR-9, worker god-file split] The goals-only accumulator pipeline,
 *  extracted from index.ts's "thin cron shell". As of 2026-06-24 (enhanced
 *  2026-06-25): fully independent of the main all-markets daily batch — its
 *  own SportyBet index read, its own discovery funnel (mechanical pre-filter
 *  -> Sonnet screen, over the FULL daily fixture pool, not the main batch's
 *  top-N), its own runAnalysis pass in goals-only-markets mode.
 *
 *  [2026-07-10, wave-1 worker merge] selectGoalsAccumulator still computes
 *  FIVE internal views (top picks / 39-leg lottery / mini-ACCA / Output B /
 *  Output C — see selectGoals.ts), but finalizeGoalsSelection no longer sends
 *  five separate Telegram slips for them. This funnel's discovery pool is
 *  genuinely independent of the daily batch's own v5 Phase-7 Outputs A-D
 *  (buildMarketsV3SlateOutputs in slateOutputs.ts only ever sees fixtures the
 *  daily batch itself analyzed, never this funnel's full-SportyBet-pool scan
 *  — see runGoalsBatch's docstring below), so its content is NOT redundant
 *  with the unified daily message and still needs its own delivery. It's now
 *  ONE consolidated "goals supplement" send instead of five: the lottery legs
 *  (the fullest surviving pool) as the message body, with mini-ACCA/Output B/
 *  Output C folded in as an informational appendix note (they're near-total
 *  subsets of the same pool, not disjoint content — see selectGoals.ts). The
 *  full breakdown (all five views) is still persisted via writeGoalsArtifact
 *  for apps/web's /goals route.
 *
 *  sendGoalsSlip/finalizeGoalsSelection are the shared notify/booking tail
 *  for BOTH this file's legacy runGoalsBatch funnel AND goalsV3Pipeline.ts's
 *  runGoalsBatchV3 — exported here and imported back into goalsV3Pipeline.ts
 *  (which this file also imports runGoalsBatchV3 from, for the ORACLE_GOALS_V3
 *  dispatch below). That two-file mutual import is intentional; see
 *  goalsV3Pipeline.ts's header comment for why it's safe. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BatchResult, RunManifest } from "@oracle/engine";
import {
  type ActionablePick,
  type BatchSummary,
  buildAnalysisModelNote,
  buildNotifiers,
  GOALS_V3_RG_NOTE,
  notifyAll,
} from "@oracle/notify";
import {
  enrichWithH2H,
  enrichWithLineups,
  enrichWithNewsIntelReport,
  type GoalsSelectionResult,
  loadSportyBetIndex,
  ORACLE_PRIORITY_LEAGUES,
  runAnalysis,
  runGoalsFunnel,
  selectGoalsAccumulator,
  sidecarKey,
  writeGoalsArtifact,
} from "@oracle/runtime";
import { MemoryAdapter } from "@oracle/storage";
import { runGoalsBatchV3 } from "./goalsV3Pipeline.js";
import {
  ANALYSIS_CHUNK_SIZE,
  config,
  env,
  goalsV3Config,
  PYTHON_BIN,
  ROOT,
  STORE_PATH,
} from "./workerContext.js";
import { mergeBatchChunks, runPythonScript, watDateString, writeHeartbeat } from "./workerUtils.js";

// ── News-intel yield telemetry ──────────────────────────────────────────────
/** Renders the news-intel coverage line for a goals slip from the real
 *  enrichWithNewsIntelReport yield (attempted = MAX_JOBS-capped eligible pool,
 *  enriched = fixtures whose softContext was actually merged, failed = empty/
 *  errored lookups). Exported so goalsV3Pipeline.ts (the v3 path) renders the
 *  identical format rather than duplicating it. A NewsIntelYield is structurally
 *  assignable to this param, so callers pass the yield object directly. */
export function buildNewsIntelNote(y: {
  attempted: number;
  enriched: number;
  failed?: number;
  disabledReason?: string;
}): string {
  if (y.disabledReason) return `📰 news intel: ${y.disabledReason}`;
  const tail = y.failed && y.failed > 0 ? ` (${y.failed} failed)` : "";
  return `📰 news intel: ${y.enriched}/${y.attempted} enriched${tail}`;
}

// ── Fixture scraper ───────────────────────────────────────────────────────────

function scrapeFixtures(): Promise<number> {
  const python = PYTHON_BIN;
  const script = join(ROOT, "tools", "scrape_fixtures.py");
  return runPythonScript(python, script, [], { cwd: ROOT, retryOnNetworkError: true }).then(
    ({ err, stdout, stderr }) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) process.stderr.write(`scrape_fixtures error: ${err.message}\n`);
      // Parse sportybet count from playwright summary line, e.g. "sportybet:12"
      const m = stdout.match(/sportybet:(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    }
  );
}

// ── SportyBet streak tracker ──────────────────────────────────────────────────

const STREAK_FILE = join(ROOT, ".tmp", "sportybet_streak.json");
const WORKFLOW_DOC = join(ROOT, "workflows", "scrape_fixtures.md");
const STREAK_THRESHOLD = 2;

function readStreak(): number {
  try {
    if (!existsSync(STREAK_FILE)) return 0;
    const data = JSON.parse(readFileSync(STREAK_FILE, "utf8")) as { streak?: number };
    return typeof data.streak === "number" ? data.streak : 0;
  } catch {
    return 0;
  }
}

function writeStreak(streak: number): void {
  try {
    writeFileSync(STREAK_FILE, JSON.stringify({ streak }), "utf8");
  } catch (_err) {}
}

function promoteSportyBetStatus(): void {
  try {
    const doc = readFileSync(WORKFLOW_DOC, "utf8");
    // Only rewrite if still marked Partial — idempotent
    if (!doc.includes("⚠️ Partial | WAT (UTC+1)")) return;
    const updated = doc.replace("⚠️ Partial | WAT (UTC+1)", "✅ Working | WAT (UTC+1)");
    writeFileSync(WORKFLOW_DOC, updated, "utf8");
  } catch (_err) {}
}

function checkSportyBetStreak(sportyBetCount: number): void {
  // Skip once already promoted
  try {
    const doc = readFileSync(WORKFLOW_DOC, "utf8");
    if (doc.includes("✅ Working | WAT (UTC+1)")) return;
  } catch {
    return;
  }

  const streak = sportyBetCount > 0 ? readStreak() + 1 : 0;
  writeStreak(streak);

  if (streak >= STREAK_THRESHOLD) {
    promoteSportyBetStatus();
    writeStreak(0); // reset — no further tracking needed
  }
}

// ── Goals-only accumulator ─────────────────────────────────────────────────────
// As of 2026-06-24 (enhanced 2026-06-25): fully independent pipeline — its own
// SportyBet index read, its own discovery funnel (mechanical pre-filter ->
// Sonnet screen, over the FULL daily fixture pool, not the main batch's top-N),
// its own runAnalysis pass in goals-only-markets mode. selectGoalsAccumulator
// still computes five internal views; as of the 2026-07-10 wave-1 merge only
// ONE consolidated Telegram send goes out for them (see finalizeGoalsSelection).

/** Single consolidated send (was five separate slips — see this file's header
 *  comment). Framed as the v5-prompt's Output-2 goals view's supplement: the
 *  daily batch's own Output A/B (all-markets/goals-markets top-39) only ever
 *  see fixtures the daily batch analyzed, never this funnel's full-pool scan. */
const GOALS_SUPPLEMENT_TAG = "GOALS — v5 Output-2 supplement (full-pool funnel)";

/** Builds an LLMCallContext for the Sonnet screening stage (goalsFunnel.ts) —
 *  same shape every other Claude-calling call site in this worker builds inline. */
function buildLlmCtx() {
  return {
    config: {
      claudeApiKey: config.claudeApiKey,
      geminiApiKey: config.geminiApiKey,
      bankroll: config.bankroll,
    },
    requestedAt: new Date().toISOString(),
  };
}

/** One slip → notify/booking cycle: booking-gate + notify + error-handling in
 *  one path. As of the 2026-07-10 wave-1 merge, finalizeGoalsSelection below
 *  calls this exactly once per day (was up to five calls — top picks, 39-leg
 *  lottery, mini-ACCA, Output B, Output C, each independently notified AND
 *  independently booking-gated). Kept as its own exported function — same
 *  shape it's always had — rather than inlined into finalizeGoalsSelection. */
export async function sendGoalsSlip(
  legs: GoalsSelectionResult["legs"],
  tag: string,
  date: string,
  analysed: number,
  errorCount: number,
  combinedProb: number,
  combinedOdds: number,
  logPrefix: string,
  v3Meta?: { arbiterStatus: "verified" | "unverified"; cappedCount: number; arbiterModel?: string },
  sanityNote?: string,
  // PR-20's marketCoverageNote (all-markets route-coverage telemetry) is
  // intentionally NOT threaded through here — RunManifest.marketCoverage is
  // still computed for goals runs (same shared runAnalysis path), but the
  // stat itself (900+ scraped markets routed/priced/gate-passed) describes
  // the all-markets catalogue goals-only mode deliberately narrows away
  // from, so it isn't a useful reader-facing line on a goals-only slip. No
  // dailyBatch.ts-style Telegram surface is planned for it here.
  newsIntelNote?: string
): Promise<BatchSummary> {
  // v3 legs carry mp = model probability (unchanged) but ActionablePick.edge is
  // what formatSummaryText renders as the edge/tier line — feed it the ADJUSTED
  // edge on the v3 path so the slip shows the §4 gate's edge, not the raw mp−ip.
  const actionable: ActionablePick[] = legs.map((l) => ({
    home: l.home,
    away: l.away,
    league: l.league,
    kickoff: l.kickoff,
    market: l.market,
    side: l.side,
    odds: l.odds,
    stakePct: 0, // accumulator leg — no per-leg Kelly stake
    confidence: l.mp,
    edge: v3Meta ? (l.adjustedEdge ?? l.edge) : l.edge,
    ...(l.eventId ? { eventId: l.eventId } : {}),
  }));

  const modelNote =
    actionable.length > 0
      ? buildAnalysisModelNote(
          legs.map((l) => l.decisionModel),
          v3Meta
            ? { arbiter: { status: v3Meta.arbiterStatus, model: v3Meta.arbiterModel } }
            : undefined
        )
      : undefined;

  const summary: BatchSummary = {
    date: `${date} — ${tag}`,
    analysed,
    actionableCount: actionable.length,
    errors: errorCount,
    actionable,
    ...(actionable.length > 0 ? { combinedProb, combinedOdds } : {}),
    ...(modelNote ? { analysisModelNote: modelNote } : {}),
    ...(v3Meta
      ? {
          arbiterStatus: v3Meta.arbiterStatus,
          ...(v3Meta.cappedCount > 0 ? { cappedCount: v3Meta.cappedCount } : {}),
          rgNote: GOALS_V3_RG_NOTE,
        }
      : {}),
    ...(sanityNote ? { sanityNote } : {}),
    ...(newsIntelNote ? { newsIntelNote } : {}),
  };

  // ── SportyBet booking (off by default; never blocks delivery) ──────────────
  if (env.ENABLE_SPORTYBET_BOOKING === "true" && actionable.length > 0) {
    try {
      const { bookAccumulator } = await import("@oracle/booking");
      const booking = await bookAccumulator(actionable);
      if (booking.code) {
        summary.bookingCode = booking.code;
        summary.bookingLoadUrl = booking.loadUrl ?? undefined;
        summary.bookingUnmatched = booking.unmatched;
        if (booking.loadUrl)
          process.stdout.write(`[${logPrefix}-booking] ${booking.code}: ${booking.loadUrl}\n`);
        if (booking.unmatched.length)
          process.stderr.write(
            `[${logPrefix}-booking] ${booking.unmatched.length} leg(s) unmatched on SportyBet\n`
          );
      } else {
        summary.bookingError = booking.error ?? "no code returned";
      }
    } catch (err) {
      summary.bookingError = err instanceof Error ? err.message : String(err);
    }
  }

  // Notify — even with 0 legs (sends a "no goals slip today" note; never books empty).
  const notifiers = buildNotifiers(env);
  if (notifiers.length) {
    await notifyAll(notifiers, summary);
  }

  return summary;
}

/** Builds the informational appendix line folded into the single consolidated
 *  send below — mini-ACCA/Output B/Output C are near-total subsets of the
 *  lottery pool (`selection.legs`, the message body), not disjoint content,
 *  so they're reported as counts+combined stats rather than resent as their
 *  own slips. Mirrors slateOutputs.ts's formatMiniAccaAppendix's "always
 *  render a line, even when a tier is empty" convention — never silent. */
function buildGoalsAppendixNote(selection: GoalsSelectionResult): string {
  const parts: string[] = [
    `top picks (EV-max, ${selection.shortSlipLegs.length} legs): ` +
      `${(selection.shortSlipCombinedProb * 100).toFixed(1)}% @ ${selection.shortSlipCombinedOdds.toFixed(2)}`,
  ];
  parts.push(
    selection.miniAccaLegs.length > 0
      ? `mini-ACCA (${selection.miniAccaLegs.length} legs, cross-league): ` +
          `${(selection.miniAccaCombinedProb * 100).toFixed(1)}% @ ${selection.miniAccaCombinedOdds.toFixed(2)} ` +
          `(true EV ${(selection.miniAccaTrueEv * 100).toFixed(1)}%)`
      : "mini-ACCA: skipped (fewer than 2 cross-league legs qualified)"
  );
  parts.push(`high-odds ≥4.00: ${selection.outputBLegs.length} legs`);
  parts.push(`mid-odds 2.50–3.99: ${selection.outputCLegs.length} legs`);
  return `goals supplement — ${parts.join(" · ")}`;
}

/** Shared tail: turn a full goals selection into notify/booking delivery.
 *  [2026-07-10, wave-1 merge] Previously FIVE independent notify/booking
 *  cycles (top picks, 39-leg lottery, mini-ACCA, Output B, Output C), each
 *  its own Telegram message and its own booking-gate check — up to five
 *  separate SportyBet booking attempts per day if ENABLE_SPORTYBET_BOOKING
 *  was on. Now ONE consolidated send: the lottery legs (`selection.legs`,
 *  the fullest surviving pool — the other four views are near-total subsets
 *  of it, see selectGoals.ts) as the message body and the single booking
 *  attempt, with the other four views folded in as an informational
 *  appendix note (buildGoalsAppendixNote) rather than resent. Exactly one
 *  booking path, exactly one Telegram send — see sendGoalsSlip's own
 *  booking-gate block for where that happens. */
export async function finalizeGoalsSelection(
  selection: GoalsSelectionResult,
  date: string,
  errorCount: number,
  trigger: RunManifest["trigger"],
  v3Meta?: {
    arbiterStatus: "verified" | "unverified";
    cappedCount: number;
    sanityLine?: string;
    arbiterModel?: string;
  },
  newsIntelNote?: string
): Promise<void> {
  process.stdout.write(
    `[goals] long=${selection.legs.length}/${selection.target} short=${selection.shortSlipLegs.length} ` +
      `miniAcca=${selection.miniAccaLegs.length} outputB=${selection.outputBLegs.length} outputC=${selection.outputCLegs.length} ` +
      `(over15=${selection.counts.over15} over25=${selection.counts.over25} ` +
      `teamover05=${selection.counts.teamOver05}; qualified=${selection.qualified} of ${selection.analysed})\n`
  );

  const appendixNote = buildGoalsAppendixNote(selection);
  const sanityNote = [v3Meta?.sanityLine, appendixNote].filter(Boolean).join("\n");

  const consolidated = await sendGoalsSlip(
    selection.legs,
    GOALS_SUPPLEMENT_TAG,
    date,
    selection.analysed,
    errorCount,
    selection.combinedProb,
    selection.combinedOdds,
    "goals-supplement",
    v3Meta,
    sanityNote,
    newsIntelNote
  );

  writeHeartbeat("lastGoalsBatch", {
    trigger,
    analysed: selection.analysed,
    topPicksLegs: selection.shortSlipLegs.length,
    lotteryLegs: selection.legs.length,
    miniAccaLegs: selection.miniAccaLegs.length,
    outputBLegs: selection.outputBLegs.length,
    outputCLegs: selection.outputCLegs.length,
    target: selection.target,
    consolidatedBooked: Boolean(consolidated.bookingCode),
  });

  // Persist the full selection (all five views) so apps/web's /goals route can
  // still show the complete breakdown — the pipeline was previously worker ->
  // Telegram/email only, zero web surface, and this artifact predates the
  // consolidation above; delivery shrank, the stored data didn't.
  try {
    await writeGoalsArtifact(
      selection,
      date,
      join(ROOT, ".tmp/goals"),
      v3Meta ? { v3: true, ...v3Meta } : undefined
    );
  } catch (err) {
    process.stderr.write(
      `[goals] WARN: artifact write failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  }
}

/** The ONLY goals pipeline (2026-06-24 rewrite): functionally independent of
 *  the main all-markets daily batch — its own SportyBet index read, its own
 *  discovery funnel (mechanical pre-filter -> Sonnet screen, goalsFunnel.ts),
 *  its own runAnalysis pass in goals-only-markets mode, and it does NOT
 *  derive its picks from runDailyBatch's output. Per owner instruction, the
 *  funnel scans the FULL daily SportyBet pool (potentially 1000+ fixtures)
 *  for goals-market opportunity — not whatever subset the main batch happened
 *  to analyze for all markets. Callable standalone via --run-goals-now; as of
 *  the 2026-07-10 wave-1 cron merge, index.ts's unified 09:35 WAT job also
 *  calls this immediately after runDailyBatch (same job, sequential, not two
 *  cron slots) — that ordering is a structural requirement (the goals
 *  cross-batch veto reads runDailyBatch's RunManifests), not a data
 *  dependency on the daily batch's picks.
 *
 *  ORACLE_GOALS_V3=true switches to the deterministic v3 pipeline
 *  (runGoalsBatchV3) immediately after the future-kickoff filter below —
 *  everything from the funnel onward is legacy-only when the flag is off. */
export async function runGoalsBatch(trigger: RunManifest["trigger"] = "manual"): Promise<void> {
  const today = watDateString();
  let index = await loadSportyBetIndex(today);
  if (!index) {
    const sportyBetCount = await scrapeFixtures();
    checkSportyBetStreak(sportyBetCount);
    index = await loadSportyBetIndex(today);
  }
  if (!index?.events.length) {
    process.stdout.write("[goals] no SportyBet fixtures available — skipping\n");
    return;
  }

  // Filter to future kickoffs only — mirrors selectFixtures.ts:546-551.
  // Fixtures that have already started (ko ≤ now) cannot be booked; keeping
  // them pollutes the funnel, wastes LLM quota, and can produce stale slips.
  // Fail-open for events with no kickoff_utc (they appear on SportyBet as
  // "TBD" or intra-day entries without a confirmed time — keep them rather
  // than silently dropping potentially valid fixtures).
  const now = new Date();
  const futureEvents = index.events.filter((ev) => {
    if (!ev.kickoff_utc) return true;
    const ko = new Date(ev.kickoff_utc).getTime();
    return Number.isFinite(ko) && ko > now.getTime();
  });
  process.stdout.write(
    `[goals] funnel: ${index.events.length} raw SportyBet fixtures → ${futureEvents.length} future KOs\n`
  );
  if (!futureEvents.length) {
    process.stdout.write("[goals] no future-kickoff fixtures — skipping\n");
    return;
  }

  if (goalsV3Config.enabled) {
    await runGoalsBatchV3(futureEvents, index, trigger);
    return;
  }

  const funnelResult = await runGoalsFunnel(futureEvents, {
    llmCtx: buildLlmCtx(),
  });
  process.stdout.write(
    `[goals] funnel: preFiltered=${funnelResult.preFilteredCount} converted=${funnelResult.convertedCount}\n`
  );

  if (!funnelResult.jobs.length) {
    process.stdout.write("[goals] funnel produced no analyzable fixtures — skipping\n");
    return;
  }

  const storage = new MemoryAdapter(STORE_PATH);

  // H2H -> news intel (CACHE-ONLY) -> lineups. The goals pipeline consumes news
  // already enriched during the daily-scrape phase (enrich_news.py + the main batch's
  // live acquisition populate the lake / file cache / GBrain). It must NOT launch live
  // per-fixture Playwright/Claude scraping in the middle of its own analysis run —
  // that re-does work the scrape phase already did and serialises a heavy subprocess
  // into the hot path. cacheOnly:true reads lake/file/GBrain only, never the live
  // ensemble. H2H + lineups are local file reads (no live scraping) and stay as-is.
  const withH2H = await enrichWithH2H(funnelResult.jobs, config.footballDataApiKey);
  let withNews = withH2H;
  let newsIntelNote: string;
  if (config.enableNewsIntel) {
    const report = await enrichWithNewsIntelReport(withH2H, { storage, cacheOnly: true });
    withNews = report.jobs;
    newsIntelNote = buildNewsIntelNote(report.yield);
  } else {
    newsIntelNote = buildNewsIntelNote({
      attempted: 0,
      enriched: 0,
      disabledReason: "disabled (ORACLE_ENABLE_NEWS_INTEL=false)",
    });
  }
  const enrichedJobs = await enrichWithLineups(withNews);

  // Hard-tier sort: priority leagues first, then others. The chunk loop below then
  // analyzes from the top of this list and stops as soon as 39 actionable legs are
  // found — mirrors the daily batch approach and avoids analyzing hundreds of
  // lower-priority fixtures when priority leagues provide enough edges.
  const sortedEnrichedJobs = [...enrichedJobs].sort(
    (a, b) =>
      (ORACLE_PRIORITY_LEAGUES.has(a.league) ? 0 : 1) -
      (ORACLE_PRIORITY_LEAGUES.has(b.league) ? 0 : 1)
  );

  const goalsBatchChunks: BatchResult[] = [];
  for (let i = 0; i < sortedEnrichedJobs.length; i += ANALYSIS_CHUNK_SIZE) {
    const chunk = sortedEnrichedJobs.slice(i, i + ANALYSIS_CHUNK_SIZE);
    const chunkIdx = Math.floor(i / ANALYSIS_CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(sortedEnrichedJobs.length / ANALYSIS_CHUNK_SIZE);
    process.stdout.write(
      `[goals] chunk ${chunkIdx}/${totalChunks}: fixtures ${i + 1}–${i + chunk.length} of ${sortedEnrichedJobs.length}\n`
    );
    const analyzedSoFar = goalsBatchChunks.reduce((s, c) => s + c.completedCount, 0);
    const { batch: chunkBatch } = await runAnalysis(
      chunk,
      { storage, config },
      {
        trigger,
        writeReportToDisk: false,
        batchOptions: {
          concurrency: 3,
          onProgress: ({ completed, current }) => {
            if (current)
              process.stdout.write(
                `[goals] ${analyzedSoFar + completed}/${sortedEnrichedJobs.length}: ${current}\n`
              );
          },
        },
      }
    );
    goalsBatchChunks.push(chunkBatch);

    const cumulativeActionable = goalsBatchChunks.reduce((s, c) => s + c.actionableCount, 0);
    process.stdout.write(
      `[goals] chunk ${chunkIdx} done — ${chunkBatch.completedCount} analyzed, ` +
        `${chunkBatch.actionableCount} actionable this chunk, ${cumulativeActionable} total\n`
    );
    if (cumulativeActionable >= 39) {
      const done = goalsBatchChunks.reduce((s, c) => s + c.completedCount, 0);
      process.stdout.write(
        `[goals] 39 actionable reached after ${done}/${sortedEnrichedJobs.length} fixtures — stopping early\n`
      );
      break;
    }
  }

  const batch = mergeBatchChunks(goalsBatchChunks);

  // Build eventId lookup so the booking agent can navigate directly to each
  // fixture's detail page instead of scanning the paginated listing DOM.
  const eventIdByKey = new Map<string, string>();
  for (const ev of index.events) {
    if (ev.eventId) eventIdByKey.set(sidecarKey(ev.home, ev.away), ev.eventId);
  }

  const selection = selectGoalsAccumulator(batch.jobs, {
    minConfidence: config.goalsMinConfidence,
    minImplied: config.goalsMinImplied,
    target: config.goalsTargetLegs,
    detailByKey: index.detailByKey,
    eventIdByKey,
  });

  await finalizeGoalsSelection(
    selection,
    batch.date,
    batch.errorCount,
    trigger,
    undefined,
    newsIntelNote
  );
}
