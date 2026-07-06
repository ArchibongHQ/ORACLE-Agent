/** Canonical analyse + persist + manifest path, shared by worker cron, CLI, and web.
 *  Extracted from apps/worker/src/index.ts runDailyBatch() so every access surface uses
 *  one identical engine path. Does NOT fetch fixtures and does NOT close storage —
 *  the caller owns the fixture source and the adapter lifecycle. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AnalysisRecord,
  BatchOptions,
  BatchResult,
  CalibrationMetrics,
  DecisionShadow,
  FixtureJob,
  FixtureOutcome,
  GoalsCrossCheckFn,
  OracleConfig,
  PickRef,
  RunManifest,
} from "@oracle/engine";
import { ANALYSIS_SCHEMA_VERSION, RUN_MANIFEST_SCHEMA_VERSION, runBatch } from "@oracle/engine";
import type { StoragePort } from "@oracle/storage";
import { STORAGE_KEYS } from "@oracle/storage";
import {
  appendResolvedToLedger,
  formatCalibrationMetrics,
  loadLedgerState,
  type SettlementFamilyBreakdown,
} from "./calibrationFeed.js";
import { findFixtureEnrichmentHtml, loadFixtureEnrichmentContext } from "./dailyFixtureReport.js";
import { renderReport, writeReport } from "./report.js";
import type { ResolveResult } from "./resolveFixtures.js";
import { resolveRecords, resolveUnmatchedViaWebSearch } from "./resolveFixtures.js";

/** Cap the persisted run-manifest history. The local PGlite store rewrites this
 *  whole array on every run; without a cap it grows unbounded and eventually
 *  corrupts the WASM heap. 90 ≈ a quarter of daily+goals runs — ample for
 *  recent-history queries while keeping the blob small. */
const MAX_MANIFEST_HISTORY = 90;

/** CLV-eligible leagues (Tier-1 with Pinnacle coverage). */
export const CLV_ELIGIBLE_LEAGUES = new Set([
  "Premier League",
  "La Liga",
  "Bundesliga",
  "Serie A",
  "Ligue 1",
  "Champions League",
  "Europa League",
  "FIFA World Cup",
]);

export interface AnalyzeOptions {
  /** Manifest trigger label (default 'manual'). */
  trigger?: RunManifest["trigger"];
  /** Persist analysis records + manifest to storage and disk (default true). */
  persist?: boolean;
  /** Write the HTML report to .tmp/reports/ on disk (default true). */
  writeReportToDisk?: boolean;
  /** Batch options forwarded to runBatch (rankingMode, marketWhitelist, onProgress, …). */
  batchOptions?: BatchOptions;
  /** When true, the HTML report includes a per-fixture enrichment dropdown
   *  (xG provenance, travel, motivation, completeness, lineups, news) sourced
   *  from dailyFixtureReport.ts — same fields the Telegram daily report shows.
   *  Off by default (worker/CLI reports are unaffected); apps/web's /analyze
   *  route opts in so the web UI gets enrichment parity. */
  includeFixtureEnrichment?: boolean;
}

export interface AnalyzeResult {
  batch: BatchResult;
  records: AnalysisRecord[];
  manifest: RunManifest;
  reportHtml: string;
  reportPath: string | null;
}

async function writeManifest(manifest: RunManifest, outDir = ".tmp/manifests"): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `manifest-${manifest.runId}.json`);
  await writeFile(outPath, JSON.stringify(manifest, null, 2), "utf8");
  return outPath;
}

function slugifyFixture(home: string, away: string): string {
  const s = (n: string) =>
    n
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
  return `${s(home)}_vs_${s(away)}`;
}

/** Writes GLM-5.2 shadow-decision comparisons to disk for manual review — never
 *  read back into the pipeline. One file per fixture per run, under
 *  .tmp/decision_shadow/. Best-effort: a write failure must not abort the run. */
async function writeDecisionShadows(
  jobs: FixtureOutcome[],
  shadows: Map<string, { real: PickRef; shadow: DecisionShadow }>,
  outDir = ".tmp/decision_shadow"
): Promise<void> {
  if (shadows.size === 0) return;
  await mkdir(outDir, { recursive: true });
  for (const job of jobs) {
    const entry = shadows.get(job.fixtureId);
    if (!entry) continue;
    const outPath = join(outDir, `${slugifyFixture(job.home, job.away)}.json`);
    await writeFile(
      outPath,
      JSON.stringify(
        {
          fixtureId: job.fixtureId,
          home: job.home,
          away: job.away,
          league: job.league,
          kickoff: job.kickoff,
          realPick: entry.real,
          shadowModel: entry.shadow.model,
          shadowPick: entry.shadow.pick.primaryPick,
          agree: entry.shadow.agree,
          writtenAt: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

/** Run the full analysis pipeline over a set of fixture jobs. */
export async function runAnalysis(
  jobs: FixtureJob[],
  deps: { storage: StoragePort; config: OracleConfig; goalsCrossCheck?: GoalsCrossCheckFn },
  opts: AnalyzeOptions = {}
): Promise<AnalyzeResult> {
  const { storage, config } = deps;
  const trigger = opts.trigger ?? "manual";
  const persist = opts.persist ?? true;
  const writeToDisk = opts.writeReportToDisk ?? true;

  // PR-7 read side: load the calibration ledger once per run. In "on" mode stamp
  // each job's state.ledger so the engine's calibFactor + isotonic 1x2 calibration
  // (execution/index.ts:1709/1813) activate live; in "shadow" mode only log the
  // would-be metrics without applying (no behaviour change); "off" skips entirely.
  // Fail-open: loadLedgerState returns null on any read/parse error → calibFactor 1.0.
  const calibMode = config.calibrationLedger ?? "shadow";
  if (calibMode !== "off") {
    const ledgerState = await loadLedgerState(storage);
    if (ledgerState && ledgerState.metrics.resolvedCount > 0) {
      const summary = formatCalibrationMetrics(ledgerState.metrics);
      if (calibMode === "on") {
        for (const job of jobs) {
          job.state = {
            ...(job.state ?? {}),
            ledger: ledgerState as unknown as NonNullable<FixtureJob["state"]>["ledger"],
          };
        }
        process.stdout.write(`[calibration] ledger active — ${summary}\n`);
      } else {
        process.stdout.write(`[calibration] shadow (not applied) — ${summary}\n`);
      }
    }
  }

  const startedAt = new Date().toISOString();
  const batch = await runBatch(
    jobs,
    { storage, config, goalsCrossCheck: deps.goalsCrossCheck },
    opts.batchOptions ?? {}
  );

  // Build analysis records from successful jobs
  const records: AnalysisRecord[] = batch.jobs.flatMap((j) => {
    if (j.status !== "ok") return [];
    const r = j.result;
    return [
      {
        analysisId: j.analysisId,
        runId: j.runId,
        schemaVersion: ANALYSIS_SCHEMA_VERSION,
        calibrationSnapshotId: batch.calibrationSnapshotId,
        fixtureId: j.fixtureId,
        home: j.home,
        away: j.away,
        league: j.league,
        kickoff: j.kickoff,
        lambdaH: (r.bayesian_lH as number | undefined) ?? 0,
        lambdaA: (r.bayesian_lA as number | undefined) ?? 0,
        probabilities: { home: r.fp.home, draw: r.fp.draw, away: r.fp.away },
        regime: String(
          (r.lowScoreRegime as Record<string, unknown> | undefined)?.regime ?? "STANDARD"
        ),
        rankingMode: batch.rankingMode,
        evMarkets: r.evMarkets,
        llmPick: j.decision,
        deterministicTopPick: j.primaryPick,
        decisionReplay: j.decisionReplay,
        frozenOddsAtAnalysis:
          ((r.fetched as Record<string, unknown> | undefined)?.odds as
            | Record<string, unknown>
            | undefined) ??
          (r.fetched as Record<string, unknown> | undefined) ??
          null,
        liquidityTag: CLV_ELIGIBLE_LEAGUES.has(j.league) ? "CLV_ELIGIBLE" : "CALIBRATION_ONLY",
        analysedAt: new Date().toISOString(),
      } satisfies AnalysisRecord,
    ];
  });

  if (persist && records.length > 0) {
    // Persistence is best-effort: a storage failure (e.g. a corrupted local
    // PGlite store) must never abort the run before selection + notify happen.
    try {
      await storage.upsertBulk(
        STORAGE_KEYS.analysisRecords,
        records as unknown as Record<string, unknown>[],
        "analysisId"
      );
    } catch (err) {
      process.stderr.write(
        `[analyze] WARN: analysisRecords persist failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
  }

  // Report
  let enrichmentByFixture: Map<string, string> | undefined;
  if (opts.includeFixtureEnrichment) {
    try {
      const ctx = await loadFixtureEnrichmentContext(batch.date);
      if (ctx) {
        enrichmentByFixture = new Map();
        for (const j of batch.jobs) {
          if (j.status !== "ok") continue;
          const fixtureHtml = findFixtureEnrichmentHtml(j.home, j.away, ctx);
          if (fixtureHtml) enrichmentByFixture.set(`${j.home}|${j.away}`, fixtureHtml);
        }
      }
    } catch {
      // Missing/unreadable SportyBet index for this date — cards render without enrichment.
    }
  }
  const reportHtml = renderReport(batch, enrichmentByFixture);
  let reportPath: string | null = null;
  if (writeToDisk) reportPath = await writeReport(batch);

  // RunManifest (PRD §11A)
  const finishedAt = new Date().toISOString();
  const fixtures: FixtureOutcome[] = batch.jobs.map((j) => {
    if (j.status === "error") {
      return {
        fixtureId: j.fixtureId,
        home: j.home,
        away: j.away,
        league: j.league,
        kickoff: j.kickoff,
        status: "error",
        pick: null,
        grade: null,
        confidence: null,
        errorCode: j.errorCode,
        errorMessage: j.reason,
        stakePct: null,
      } satisfies FixtureOutcome;
    }
    const pick = j.decision.primaryPick;
    const grade = j.decision.grade;
    return {
      fixtureId: j.fixtureId,
      home: j.home,
      away: j.away,
      league: j.league,
      kickoff: j.kickoff,
      status: "ok",
      pick,
      grade,
      confidence: j.decision.confidence,
      errorCode: null,
      errorMessage: null,
      stakePct: grade !== "NO_EDGE" && grade !== "MISSING_DATA" ? (pick.stake ?? 0) * 100 : null,
    } satisfies FixtureOutcome;
  });

  const manifest: RunManifest = {
    runId: batch.runId,
    schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    startedAt,
    finishedAt,
    mode: batch.rankingMode,
    trigger,
    calibrationSnapshotId: batch.calibrationSnapshotId,
    fixtures,
    totals: {
      analysed: batch.completedCount,
      actionable: batch.actionableCount,
      errors: batch.errorCount,
      totalRecommendedStakePct: batch.totalRecommendedStakePct,
    },
    cost: batch.cost,
    errors: batch.errors,
  };

  if (persist) {
    // Best-effort: never let a storage abort kill the run before it returns to
    // the caller (which still has to select + notify). Also cap the manifest
    // history so the local store can't grow unbounded into WASM-heap corruption.
    try {
      const existing = (await storage.get<RunManifest[]>(STORAGE_KEYS.runManifests)) ?? [];
      const capped = [...existing, manifest].slice(-MAX_MANIFEST_HISTORY);
      await storage.set(STORAGE_KEYS.runManifests, capped);
    } catch (err) {
      process.stderr.write(
        `[analyze] WARN: runManifests persist failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
    // The on-disk manifest JSON is the canonical record; keep it even if the
    // DB write above failed.
    try {
      await writeManifest(manifest);
    } catch (err) {
      process.stderr.write(
        `[analyze] WARN: manifest file write failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
    // GLM-5.2 shadow comparisons — observability only, never read back into the
    // pipeline. See oracle_pending_plans (2026-06-18, GLM-5.2 decision-layer research).
    try {
      const shadows = new Map<string, { real: PickRef; shadow: DecisionShadow }>();
      for (const j of batch.jobs) {
        if (j.status === "ok" && j.decisionShadow) {
          shadows.set(j.fixtureId, { real: j.decision.primaryPick, shadow: j.decisionShadow });
        }
      }
      await writeDecisionShadows(fixtures, shadows);
    } catch (err) {
      process.stderr.write(
        `[analyze] WARN: decision shadow write failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
  }

  return { batch, records, manifest, reportHtml, reportPath };
}

// ── Resolution path (CLI `resolve`, worker 14:00) ─────────────────────────────

export interface ResolveDayResult extends ResolveResult {
  date: string;
  candidates: number;
  /** PR-7: number of resolved picks settled into the calibration ledger this run
   *  (undefined when calibrationMode="off" or nothing resolved). */
  ledgerAppended?: number;
  /** PR-7: post-append calibration metrics for the resolve report / Telegram. */
  calibrationMetrics?: CalibrationMetrics;
  /** [audit fix] Per-family settle/skip breakdown from this run's
   *  appendResolvedToLedger call — surfaces a ledger that's silently biased
   *  toward 1x2-derivable families instead of hiding it behind ledgerAppended's
   *  one aggregate number. */
  ledgerByFamily?: SettlementFamilyBreakdown;
}

/** Resolve all analysis records whose kickoff falls on `date` (YYYY-MM-DD).
 *  Reads records from storage, fetches results, writes ResolutionRecord[] back.
 *  Tries API-Football first (broad league coverage, narrow date window), falls back
 *  to football-data.org (narrow league coverage, any date) — see resolveFixtures.ts.
 *  When geminiApiKey is provided, runs B5 postmortem synthesis on losses (batched). */
export async function resolveDay(
  storage: StoragePort,
  keys: {
    footballDataApiKey?: string;
    oddsApiKey?: string;
    geminiApiKey?: string;
    apiFootballKey?: string;
  },
  date: string,
  webSearchFallback: { enabled?: boolean; minConsensus?: number } = {},
  calibration: { mode?: "off" | "shadow" | "on"; maxLedger?: number } = {}
): Promise<ResolveDayResult> {
  const allRecords = (await storage.get<AnalysisRecord[]>(STORAGE_KEYS.analysisRecords)) ?? [];
  const dayRecords = allRecords.filter((r) => r.kickoff.startsWith(date));

  if (!dayRecords.length) {
    return { date, candidates: 0, resolved: [], unmatched: [] };
  }

  // API sources first (structured, fixture-ID-exact). No early-exit when both keys
  // are absent — CLAUDE.md §6 no-data-blocker: the web-search consensus fallback
  // below always runs on whatever resolveRecords couldn't (or, with no keys, didn't
  // even try to) resolve.
  const apiResult =
    keys.footballDataApiKey || keys.apiFootballKey
      ? await resolveRecords(
          dayRecords,
          keys.footballDataApiKey,
          keys.oddsApiKey,
          keys.apiFootballKey
        )
      : { resolved: [], unmatched: dayRecords.map((r) => r.fixtureId) };

  let resolved = apiResult.resolved;
  let unmatched = apiResult.unmatched;

  // Web-search consensus fallback for whatever the API chain couldn't match —
  // minor leagues outside both free tiers' coverage, API outages, etc.
  if (webSearchFallback.enabled !== false && unmatched.length > 0) {
    const runId =
      resolved[0]?.runId ?? `resolve_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const webResult = await resolveUnmatchedViaWebSearch(
      dayRecords,
      unmatched,
      runId,
      webSearchFallback.minConsensus ?? 2
    );
    resolved = [...resolved, ...webResult.resolved];
    unmatched = webResult.unmatched;
  }

  if (resolved.length) {
    await storage.bulkWrite(STORAGE_KEYS.resolutionRecords, resolved);
  }

  // PR-7 write side: settle each resolved pick into the calibration ledger. Active
  // in shadow+on (only explicit "off" disables the write). Non-fatal — a ledger
  // failure must never abort the resolve run.
  let ledgerAppended: number | undefined;
  let calibrationMetrics: CalibrationMetrics | undefined;
  let ledgerByFamily: SettlementFamilyBreakdown | undefined;
  const calibMode = calibration.mode ?? "shadow";
  if (calibMode !== "off" && resolved.length) {
    try {
      const r = await appendResolvedToLedger(storage, resolved, dayRecords, {
        maxLedger: calibration.maxLedger,
      });
      ledgerAppended = r.appended;
      calibrationMetrics = r.metrics;
      ledgerByFamily = r.byFamily;
    } catch (err) {
      process.stderr.write(
        `[calibration] WARN: ledger append failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
  }

  // B5: postmortem synthesis for losses (advisory, non-fatal)
  if (keys.geminiApiKey && resolved.length) {
    try {
      const { synthesizePostmortems } = await import("@oracle/llm");
      const losses = resolved
        .filter((r) => r.actualResult !== undefined)
        .map((r) => {
          const src = dayRecords.find((d) => d.fixtureId === r.fixtureId);
          const picked = src?.deterministicTopPick?.label ?? "unknown";
          const won =
            r.actualResult ===
            (picked.toLowerCase().includes("away")
              ? "away"
              : picked.toLowerCase().includes("draw")
                ? "draw"
                : "home");
          return won
            ? null
            : {
                fixtureId: r.fixtureId,
                homeTeam: src?.home ?? r.fixtureId,
                awayTeam: src?.away ?? "",
                marketPicked: picked,
                rootCause: "SSSVO_IGNORED" as const,
                signalsThatFired: [],
                signalsThatShouldHaveFired: [],
              };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (losses.length) {
        const ctx = {
          config: { claudeApiKey: "", geminiApiKey: keys.geminiApiKey, bankroll: 0 },
          requestedAt: new Date().toISOString(),
        };
        const synthResults = await synthesizePostmortems(losses, ctx);
        for (const r of synthResults) {
          if (r.synthesizedRule) {
          }
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  return {
    date,
    candidates: dayRecords.length,
    resolved,
    unmatched,
    ledgerAppended,
    calibrationMetrics,
    ledgerByFamily,
  };
}
