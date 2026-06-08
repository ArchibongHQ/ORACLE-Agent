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
  FixtureJob,
  FixtureOutcome,
  OracleConfig,
  PickRef,
  RunManifest,
} from "@oracle/engine";
import { ANALYSIS_SCHEMA_VERSION, RUN_MANIFEST_SCHEMA_VERSION, runBatch } from "@oracle/engine";
import type { StoragePort } from "@oracle/storage";
import { STORAGE_KEYS } from "@oracle/storage";
import { renderReport, writeReport } from "./report.js";
import type { ResolveResult } from "./resolveFixtures.js";
import { resolveRecords } from "./resolveFixtures.js";

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

/** Run the full analysis pipeline over a set of fixture jobs. */
export async function runAnalysis(
  jobs: FixtureJob[],
  deps: { storage: StoragePort; config: OracleConfig },
  opts: AnalyzeOptions = {}
): Promise<AnalyzeResult> {
  const { storage, config } = deps;
  const trigger = opts.trigger ?? "manual";
  const persist = opts.persist ?? true;
  const writeToDisk = opts.writeReportToDisk ?? true;

  const startedAt = new Date().toISOString();
  const batch = await runBatch(jobs, { storage, config }, opts.batchOptions ?? {});

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
        frozenOddsAtAnalysis: (r.fetched as Record<string, unknown> | undefined) ?? null,
        liquidityTag: CLV_ELIGIBLE_LEAGUES.has(j.league) ? "CLV_ELIGIBLE" : "CALIBRATION_ONLY",
        analysedAt: new Date().toISOString(),
      } satisfies AnalysisRecord,
    ];
  });

  if (persist && records.length > 0) {
    await storage.upsertBulk(
      STORAGE_KEYS.analysisRecords,
      records as unknown as Record<string, unknown>[],
      "analysisId"
    );
  }

  // Report
  const reportHtml = renderReport(batch);
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
        confidence: null,
        errorCode: j.errorCode,
        errorMessage: j.reason,
        stakePct: null,
      } satisfies FixtureOutcome;
    }
    const pick = j.decision.primaryPick;
    return {
      fixtureId: j.fixtureId,
      home: j.home,
      away: j.away,
      league: j.league,
      kickoff: j.kickoff,
      status: "ok",
      pick,
      confidence: j.decision.confidence,
      errorCode: null,
      errorMessage: null,
      stakePct: pick !== "NO_BET" ? ((pick as PickRef).stake ?? 0) * 100 : null,
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
    const existing = (await storage.get<RunManifest[]>(STORAGE_KEYS.runManifests)) ?? [];
    await storage.set(STORAGE_KEYS.runManifests, [...existing, manifest]);
    await writeManifest(manifest);
  }

  return { batch, records, manifest, reportHtml, reportPath };
}

// ── Resolution path (CLI `resolve`, worker 14:00) ─────────────────────────────

export interface ResolveDayResult extends ResolveResult {
  date: string;
  candidates: number;
}

/** Resolve all analysis records whose kickoff falls on `date` (YYYY-MM-DD).
 *  Reads records from storage, fetches results, writes ResolutionRecord[] back.
 *  When geminiApiKey is provided, runs B5 postmortem synthesis on losses (batched). */
export async function resolveDay(
  storage: StoragePort,
  keys: { footballDataApiKey?: string; oddsApiKey?: string; geminiApiKey?: string },
  date: string
): Promise<ResolveDayResult> {
  if (!keys.footballDataApiKey) {
    return { date, candidates: 0, resolved: [], unmatched: [] };
  }

  const allRecords = (await storage.get<AnalysisRecord[]>(STORAGE_KEYS.analysisRecords)) ?? [];
  const dayRecords = allRecords.filter((r) => r.kickoff.startsWith(date));

  if (!dayRecords.length) {
    return { date, candidates: 0, resolved: [], unmatched: [] };
  }

  const { resolved, unmatched } = await resolveRecords(
    dayRecords,
    keys.footballDataApiKey,
    keys.oddsApiKey
  );
  if (resolved.length) {
    await storage.bulkWrite(STORAGE_KEYS.resolutionRecords, resolved);
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

  return { date, candidates: dayRecords.length, resolved, unmatched };
}
