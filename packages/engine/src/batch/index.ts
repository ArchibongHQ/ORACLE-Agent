/** Batch runner — Phase 3.
 *  parseFixtureList: text → FixtureJob[]. runBatch: sequential, resilient, progress events. */

import type { StoragePort } from "@oracle/storage";
import type { DecisionContext } from "../decision/index.js";
import {
  buildEligibleBets,
  decide,
  logPickDisagreement,
  validateSelection,
} from "../decision/index.js";
import type { MarketExecutorRiskParams } from "../decision/marketExecutor.js";
import { ExecutionEngine } from "../execution/index.js";
import { devigThreeWay } from "../markets/index.js";
import {
  analyzeFixtureMarketsV3,
  type V3AllMarketsInput,
} from "../marketsV3/analyzeFixtureMarkets.js";
import type {
  AgentError,
  AgentErrorCode,
  AllMarketEntry,
  DecisionOutput,
  DecisionReplay,
  DecisionShadow,
  EVMarket,
  OracleConfig,
  RankingMode,
  RunResult,
  RunState,
  SoftContextItem,
} from "../types.js";
import { computeMarketExecutorConcurrency } from "./marketExecutorConcurrency.js";

/** Build v3's per-fixture input from RunState.telemetry (populated by the
 *  runtime layer's buildStatsOverride — see sportyBetStats.ts) + the raw
 *  allMarkets catalogue already extracted for the Q4 executor. Returns null
 *  when there's nothing to analyze (no catalogue) — the caller fails open to
 *  the legacy eligible list in that case, same as every other soft-fail path
 *  in this pipeline. */
function buildV3Input(
  job: { home: string; away: string; league: string; kickoff: string },
  state: RunState,
  allMarkets: AllMarketEntry[] | undefined
): V3AllMarketsInput | null {
  if (!allMarkets?.length) return null;
  const t = state.telemetry ?? {};

  const devigged1x2 =
    t.hOdds && t.dOdds && t.aOdds
      ? (() => {
          const d = devigThreeWay(t.hOdds, t.dOdds, t.aOdds);
          return d ? { pHome: d[0], pDraw: d[1], pAway: d[2] } : null;
        })()
      : null;

  const h2hBlock = (t.rawStatsBlock as { h2h?: { total?: number } } | undefined)?.h2h;
  const hasLineups = (t.softContext ?? []).some((s) => s.kind === "lineup");

  return {
    fixtureId: `${job.home}::${job.away}::${job.kickoff}`,
    runId: "batch",
    home: job.home,
    away: job.away,
    league: job.league,
    kickoff: job.kickoff,
    lambdaInput: {
      league: job.league,
      homeScoredPer90: t.scoredPer90H ?? null,
      homeConcededPer90: t.concededPer90H ?? null,
      awayScoredPer90: t.scoredPer90A ?? null,
      awayConcededPer90: t.concededPer90A ?? null,
      nHome: t.nHome ?? null,
      nAway: t.nAway ?? null,
      homeXg: t.xgfH != null ? { xgf: t.xgfH, xga: t.xgaH } : null,
      awayXg: t.xgfA != null ? { xgf: t.xgfA, xga: t.xgaA } : null,
    },
    devigged1x2,
    allMarkets,
    fhShareH: t.fhShareH,
    fhShareA: t.fhShareA,
    empirical: {
      bttsPctH: t.bttsPctH,
      bttsPctA: t.bttsPctA,
      csPctH: t.csPctH,
      csPctA: t.csPctA,
      ftsPctH: t.ftsPctH,
      ftsPctA: t.ftsPctA,
    },
    penaltyFlags: {
      xgMissing: t.xgMode == null,
      xgEstimated: t.xgMode === "estimated",
      h2hMissing: !((h2hBlock?.total ?? 0) > 0),
      lineupsUnconfirmed: !hasLineups,
      restEstimated: t.restH == null || t.restA == null,
      smallSample: (t.nHome ?? 99) < 5 || (t.nAway ?? 99) < 5,
    },
  };
}

import { AtomicCostTracker, runPool } from "./pool.js";

export interface FixtureJob {
  home: string;
  away: string;
  league: string;
  kickoff: string; // ISO-8601 or YYYY-MM-DDTHH:mm:ssZ
  state?: RunState; // optional pre-populated telemetry / odds
}

export interface FixtureJobSuccess {
  status: "ok";
  analysisId: string; // deterministic idempotency key
  runId: string; // parent batch run
  fixtureId: string;
  home: string;
  away: string;
  league: string;
  kickoff: string;
  result: RunResult;
  decision: DecisionOutput;
  decisionReplay: DecisionReplay | null;
  eligibleBets: EVMarket[];
  primaryPick: EVMarket | null;
  /** True for the top-N by composite stats score (selection-time flag, carried
   *  through so callers can restrict a downstream pipeline — e.g. the goals
   *  accumulator — to the same top-N the LLM tier was gated on). Defaults to
   *  true when telemetry.llmEligible is absent (ad-hoc /analyze, single-fixture). */
  llmEligible: boolean;
  // ── Optional LLM-layer telemetry (for report surfacing; all may be absent) ──
  cvlStatus?: "APPROVED" | "OVERRIDE" | "VETO" | "SKIPPED"; // B2 verification verdict
  briefingFlags?: string[]; // B1 briefing flags (e.g. FRAMING_BIAS_DETECTED)
  swarmConsensus?: string; // Level-2 swarm consensus pick label
  swarmDivergence?: number; // 0–1; high = workers disagreed
  decisionShadow?: DecisionShadow; // GLM-5.2 shadow comparison, observability only
  agentVerification?: RunResult["agentVerification"]; // ORACLE_AGENT_VERIFY local-CLI check, observability only
}

export interface FixtureJobError {
  status: "error";
  fixtureId: string;
  home: string;
  away: string;
  league: string;
  kickoff: string;
  reason: string;
  errorCode: AgentErrorCode;
  llmEligible: boolean;
}

export type BatchJobResult = FixtureJobSuccess | FixtureJobError;

export interface BatchResult {
  runId: string;
  calibrationSnapshotId: string;
  date: string; // YYYY-MM-DD
  rankingMode: RankingMode;
  dryRun?: boolean; // true when BatchOptions.dryRun was set
  jobs: BatchJobResult[];
  completedCount: number;
  errorCount: number;
  actionableCount: number;
  totalRecommendedStakePct: number;
  cost: { estimatedUsd: number; ceilingUsd: number | null; halted: boolean };
  errors: AgentError[];
}

export interface BatchOptions {
  rankingMode?: RankingMode;
  calibrationSnapshotId?: string; // defaults to "calib_YYYY-MM-DD"
  marketWhitelist?: string[];
  dryRun?: boolean; // skip execution; return cost estimate only (§11A)
  maxRetries?: number; // per-fixture retries on RATE_LIMITED (default 3; 0 = no retries)
  backoffMs?: (attempt: number) => number; // delay per retry attempt; default: exponential 1s/2s/4s ±10%
  concurrency?: number; // max fixtures processed in parallel (default config.batchConcurrency ?? 8)
  onProgress?: (event: { completed: number; total: number; current: string }) => void;
}

/** Parse newline-delimited fixture list.
 *  Accepted formats:
 *    "Home vs Away, League, Kickoff"
 *    "Home vs Away | League | Kickoff"
 *  Lines starting with '#' and blank lines are skipped. */
export function parseFixtureList(input: string): FixtureJob[] {
  const jobs: FixtureJob[] = [];
  for (const raw of input.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const sep = line.includes("|") ? "|" : ",";
    const parts = line.split(sep).map((p) => p.trim());
    if (parts.length < 1) continue;

    const vsMatch = (parts[0] ?? "").match(/^(.+?)\s+vs\.?\s+(.+)$/i);
    if (!vsMatch) continue;

    const home = vsMatch[1]?.trim();
    const away = vsMatch[2]?.trim();
    if (!home || !away) continue;

    jobs.push({
      home,
      away,
      league: parts[1] ?? "Default",
      kickoff: parts[2] ?? new Date().toISOString(),
    });
  }
  return jobs;
}

// Conservative per-call cost for claude-opus-4-8 (~1K input + 200 output tokens)
const LLM_COST_ESTIMATE_USD_PER_CALL = 0.05;

// Max v3 candidates handed to the arbiter per fixture (evMarkets is already
// ranked best-first by adjusted edge) — see the enableMarketsV3 wiring in
// processOne. Small enough to keep the arbiter prompt trivial, generous
// enough that a real close-call second-best market is never silently dropped.
const V3_ARBITER_CANDIDATE_LIMIT = 5;

function classifyError(msg: string): AgentErrorCode {
  if (/429|rate.?limit/i.test(msg)) return "RATE_LIMITED";
  if (/no.?data|not.?found|no fixture/i.test(msg)) return "NO_DATA";
  if (/odds/i.test(msg)) return "ODDS_UNAVAILABLE";
  if (/ambiguous/i.test(msg)) return "AMBIGUOUS_FIXTURE";
  return "INTERNAL";
}

function makeFixtureId(home: string, away: string, kickoff: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
  return `${slug(home)}_vs_${slug(away)}_${kickoff.replace(/\D/g, "").slice(0, 12)}`;
}

function makeRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Deterministic per-analysis ID — enables safe upserts (PRD §11A.3). */
function makeAnalysisId(
  fixtureId: string,
  rankingMode: string,
  calibrationSnapshotId: string
): string {
  return `${fixtureId}:${rankingMode}:${calibrationSnapshotId}`;
}

/** Retries fn up to maxRetries times on RATE_LIMITED errors with exponential backoff. */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  backoffMs: (attempt: number) => number
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (classifyError(msg) !== "RATE_LIMITED" || attempt >= maxRetries) throw err;
      await new Promise<void>((r) => setTimeout(r, backoffMs(attempt)));
      attempt++;
    }
  }
}

/** Run a batch of fixture jobs sequentially.
 *  One job failing never aborts the batch — it produces { status: 'error' } instead. */
export async function runBatch(
  jobs: FixtureJob[],
  deps: { storage: StoragePort; config: OracleConfig },
  options: BatchOptions = {}
): Promise<BatchResult> {
  const { onProgress, marketWhitelist, rankingMode = "CONFIDENCE_WEIGHTED" } = options;
  const maxRetries = options.maxRetries ?? 3;
  const backoffMs =
    options.backoffMs ??
    ((attempt: number) => {
      const base = 2 ** attempt * 1000;
      return base * (1 + (Math.random() * 0.2 - 0.1));
    });
  const runId = makeRunId();
  const calibrationSnapshotId =
    options.calibrationSnapshotId ?? `calib_${new Date().toISOString().slice(0, 10)}`;
  const config: OracleConfig = { ...deps.config, rankingMode };
  const ceilingUsd = config.costCeilingUsd?.perRun ?? null;

  // §11A dry-run: no API calls; returns a cost estimate based on job count
  if (options.dryRun) {
    const dryJobs: BatchJobResult[] = jobs.map((job) => ({
      status: "error" as const,
      fixtureId: makeFixtureId(job.home, job.away, job.kickoff),
      home: job.home,
      away: job.away,
      league: job.league,
      kickoff: job.kickoff,
      reason: "DRY_RUN — estimate only",
      errorCode: "DRY_RUN" as AgentErrorCode,
      llmEligible: job.state?.telemetry?.llmEligible !== false,
    }));
    return {
      runId,
      calibrationSnapshotId,
      date: new Date().toISOString().slice(0, 10),
      rankingMode,
      dryRun: true,
      jobs: dryJobs,
      completedCount: 0,
      errorCount: dryJobs.length,
      actionableCount: 0,
      totalRecommendedStakePct: 0,
      cost: {
        estimatedUsd: parseFloat((jobs.length * LLM_COST_ESTIMATE_USD_PER_CALL).toFixed(4)),
        ceilingUsd,
        halted: false,
      },
      errors: [],
    };
  }

  const agentErrors: AgentError[] = [];
  const total = jobs.length;
  // Q4c: the all-markets LLM executor tier is a real per-fixture process spawn,
  // not a cheap API call — when it's on, concurrency follows the owner-specified
  // hardware-aware budget (2-3 local, ~1/fixture on VPS) instead of the normal
  // batchConcurrency default, since that default predates this tier and was
  // sized for cheap network calls, not local CLI spawns.
  const marketExecutorActive = config.enableLlmMarketExecutor === true;
  const concurrency = marketExecutorActive
    ? computeMarketExecutorConcurrency(total, config.isVps)
    : Math.max(1, options.concurrency ?? config.batchConcurrency ?? 8);
  // Per owner instruction: uncapped spend on VPS specifically for this tier —
  // scheduling never halts on the cost ceiling there. Local runs keep the
  // existing ceiling behavior unchanged (concurrency is already low there).
  const uncappedOnVps = marketExecutorActive && config.isVps === true;
  const costTracker = new AtomicCostTracker(LLM_COST_ESTIMATE_USD_PER_CALL, ceilingUsd);
  let completedCounter = 0;

  // Per-fixture work — identical logic to the previous sequential body, now
  // runnable concurrently. Returns a BatchJobResult (never throws).
  async function processOne(job: FixtureJob): Promise<BatchJobResult> {
    const fixtureId = makeFixtureId(job.home, job.away, job.kickoff);
    // Computed once, before the try, so both the success and error paths agree —
    // default true when absent (e.g. ad-hoc /analyze, single-fixture).
    const llmEligible = job.state?.telemetry?.llmEligible !== false;
    try {
      return await withRetry(
        async (): Promise<FixtureJobSuccess> => {
          const state: RunState = {
            ...(job.state ?? {}),
            pipeline: {
              ...(job.state?.pipeline ?? {}),
              fixture: {
                home: job.home,
                away: job.away,
                league: job.league,
                date: job.kickoff,
                ...(job.state?.pipeline?.fixture ?? {}),
              },
            },
          };

          const runResult = await ExecutionEngine.run(state, { storage: deps.storage, config });

          let evMarkets = runResult.evMarkets;
          if (marketWhitelist && marketWhitelist.length > 0) {
            const wl = marketWhitelist.map((s) => s.toLowerCase());
            evMarkets = evMarkets.filter((m) =>
              wl.some((w) => m.cat.toLowerCase().includes(w) || m.label.toLowerCase().includes(w))
            );
          }

          const filteredResult: RunResult = { ...runResult, evMarkets };
          let eligible = buildEligibleBets(evMarkets);

          // Build context for LLM decision layer
          const convResult = runResult.convergence as Record<string, unknown> | undefined;
          const mlResult = runResult.mlFilter as Record<string, unknown> | undefined;
          const debateRes = runResult.debate as Record<string, unknown> | undefined;
          const regimeRes = runResult.lowScoreRegime as Record<string, unknown> | undefined;
          const allMarkets = (
            state.pipeline?.fetched?.sportyBetOdds as { allMarkets?: AllMarketEntry[] } | undefined
          )?.allMarkets;

          const decisionCtx: DecisionContext = {
            fixture: { home: job.home, away: job.away, league: job.league, kickoff: job.kickoff },
            fp: runResult.fp,
            lambdaH: (runResult.bayesian_lH as number | undefined) ?? 0,
            lambdaA: (runResult.bayesian_lA as number | undefined) ?? 0,
            expectedScoreline: String(runResult.expectedScoreline ?? "?"),
            regime: String(regimeRes?.regime ?? "STANDARD"),
            convergenceTier: String(convResult?.tier ?? "UNKNOWN"),
            convergenceScore: Number(convResult?.score ?? 0),
            mlAllowed: mlResult?.mlAllowed !== false,
            drawRisk: String(mlResult?.drawRisk ?? "MEDIUM"),
            betTrigger: String(debateRes?.betTrigger ?? "YELLOW"),
            portfolioCorrelation: runResult.portfolioCorrelation,
            softContext: state.telemetry?.softContext as SoftContextItem[] | undefined,
            rawStatsBlock: state.telemetry?.rawStatsBlock as Record<string, unknown> | undefined,
            allMarkets,
          };

          // all-markets-analysis-prompt-v3 deterministic engine (config.
          // enableMarketsV3). "on": replaces `eligible` with v3's gate-surviving
          // candidates for THIS fixture — fails open to the legacy list on any
          // v3 error/empty-result (missing data is never a blocker). "shadow":
          // v3 runs but its output is discarded, legacy `eligible` is used
          // unchanged (comparison instrumentation only). "off": skipped
          // entirely — zero overhead, byte-identical to pre-v3 behavior.
          //
          // Cap at V3_ARBITER_CANDIDATE_LIMIT (top-ranked first — evMarkets is
          // already sorted best-first by adjusted edge): the arbiter reads
          // whatever lands in `eligible`, and a handful of gate-survivors keeps
          // its prompt a token-cost rounding error next to the Q4 catalogue
          // dump this replaces, without losing any real candidate (spec §7
          // Output A only ever keeps ONE selection per fixture anyway).
          let usedV3 = false;
          if (config.enableMarketsV3 && config.enableMarketsV3 !== "off") {
            const v3Input = buildV3Input(job, state, allMarkets);
            const v3Result = v3Input ? analyzeFixtureMarketsV3(v3Input) : null;
            if (config.enableMarketsV3 === "on" && v3Result?.evMarkets.length) {
              eligible = v3Result.evMarkets.slice(0, V3_ARBITER_CANDIDATE_LIMIT);
              usedV3 = true;
            }
          }
          // Demote the Q4 all-markets LLM catalogue-dump executor when v3
          // supplied this fixture's candidates — v3 IS the deterministic
          // all-markets answer (Rule 0: script math, not LLM probability
          // estimation), so paying for a second full-catalogue LLM pass over
          // the same fixture would be pure waste. Legacy behavior (including
          // an operator-enabled Q4 executor) is untouched when v3 is off,
          // shadow, or produced nothing for this fixture.
          const decideConfig = usedV3 ? { ...config, enableLlmMarketExecutor: false } : config;

          // Risk multipliers the engine already computed for THIS fixture, reused
          // so the all-markets LLM executor tier's Kelly stake (Q4b) is consistent
          // with every other stake the engine produces — not a separate guess.
          const mcResult = runResult.mc as { varMultiplier?: number } | undefined;
          const marketExecutorRisk: MarketExecutorRiskParams = {
            dqs: (runResult.dqs as number | undefined) ?? 0.85,
            councilPenalty: (runResult.councilPenalty as boolean | undefined) ?? false,
            varMultiplier: mcResult?.varMultiplier ?? 1.0,
            drawdownPenalty: (runResult.drawdownPenalty as number | undefined) ?? 1.0,
            calibFactor: (job.state?.ledger?.metrics?.calibFactor as number | undefined) ?? 1.0,
            bankroll: config.bankroll,
          };

          // Two-tier gate: only the top-N fixtures (by composite stats score,
          // flagged llmEligible at selection, computed once above processOne's
          // try block) reach the paid/slow LLM layers (briefing, swarm, decide,
          // CVL). Every other fixture still gets the full deterministic engine
          // analysis but skips all LLM calls.

          // B7: route based on convergence tier
          let briefingText: string | undefined;
          let briefingFlags: string[] | undefined; // captured for report surfacing
          let swarmConsensus: string | undefined; // captured for report surfacing
          let swarmDivergenceVal: number | undefined; // captured for report surfacing
          let swarmDivergence = false; // set true when swarm workers strongly disagree
          try {
            const { routeFixture } = await import("@oracle/llm");
            const route = routeFixture(String(convResult?.tier ?? "VIABLE"));

            // B1: optional briefing layer for APEX/PRIME fixtures
            if (
              llmEligible &&
              route.useBriefing &&
              config.enableBriefing &&
              (config.claudeApiKey || config.geminiApiKey || config.openrouterApiKey)
            ) {
              try {
                const { callBriefing } = await import("@oracle/llm");
                const briefingPrompt = `Provide a brief pre-match analysis for ${job.home} vs ${job.away} (${job.league}).
Convergence tier: ${route.tier}. Top eligible bet: ${eligible[0]?.label ?? "none"} @ ${eligible[0]?.odds ?? "N/A"}.
Keep it under 200 words. Identify the single most important risk factor.`;
                const llmCtx = {
                  config: {
                    claudeApiKey: config.claudeApiKey,
                    geminiApiKey: config.geminiApiKey,
                    openrouterApiKey: config.openrouterApiKey,
                    bankroll: config.bankroll,
                  },
                  requestedAt: new Date().toISOString(),
                };
                const briefing = await callBriefing(briefingPrompt, llmCtx);
                briefingText = briefing.text;
                if (briefing.flags.length) {
                  briefingFlags = briefing.flags;
                  decisionCtx.softContext = [
                    ...(decisionCtx.softContext ?? []),
                    ...briefing.flags.map((f) => ({
                      kind: "news" as const,
                      text: `[BRIEFING_FLAG] ${f}`,
                      source: "callBriefing",
                      observedAt: new Date().toISOString(),
                    })),
                  ];
                }
              } catch {
                /* non-fatal */
              }
            }

            // Level-2 swarm: fan out sub-agent voters for high-conviction fixtures.
            // AUGMENTS the decision only — injects advisory consensus + divergence into
            // softContext. It never sets primaryPick; decide()/validateSelection remain authoritative.
            if (
              llmEligible &&
              route.swarmWorkers > 0 &&
              config.enableSwarm &&
              (config.kimiApiKey || config.openrouterApiKey)
            ) {
              try {
                const { runSwarm, swarmToSoftContext } = await import("../swarm/index.js");
                const swarm = await runSwarm(
                  route.swarmWorkers,
                  { home: job.home, away: job.away, league: job.league, kickoff: job.kickoff },
                  eligible,
                  config,
                  decisionCtx.softContext
                );
                if (swarm) {
                  decisionCtx.softContext = [
                    ...(decisionCtx.softContext ?? []),
                    ...swarmToSoftContext(swarm),
                  ];
                  swarmDivergence = swarm.highDivergence;
                  swarmConsensus = swarm.consensusPick;
                  swarmDivergenceVal = swarm.divergence;
                }
              } catch {
                /* non-fatal */
              }
            }
          } catch {
            /* non-fatal — llm module unavailable */
          }

          const {
            decision: rawDecision,
            replay: decisionReplay,
            shadow: decisionShadow,
            eligibleBets: executedEligible,
          } = await decide(
            eligible,
            decisionCtx,
            decideConfig,
            !llmEligible, // force deterministic for fixtures outside the top-N
            marketExecutorRisk
          );
          // Widened by one synthetic EVMarket only when the Q4 all-markets LLM
          // executor tier supplied the draft — identical to `eligible` otherwise.
          const effectiveEligible = executedEligible ?? eligible;
          const mlFilter = { mlAllowed: decisionCtx.mlAllowed, drawRisk: decisionCtx.drawRisk };
          const decision = validateSelection(rawDecision, effectiveEligible, mlFilter);

          // B2: optional CVL adversarial verification
          let cvlStatus: "APPROVED" | "OVERRIDE" | "VETO" | "SKIPPED" | undefined;
          try {
            const { routeFixture } = await import("@oracle/llm");
            const route = routeFixture(String(convResult?.tier ?? "VIABLE"));
            // Swarm high-divergence escalates to a CVL pass even on lower tiers.
            const cvlTriggered = (route.useCVL || swarmDivergence) && config.enableCVL;
            if (
              llmEligible &&
              cvlTriggered &&
              (config.claudeApiKey || config.openrouterApiKey) &&
              rawDecision.grade !== "NO_EDGE"
            ) {
              const { callVerification } = await import("@oracle/llm");
              const cvlPrompt = `Primary pick: ${JSON.stringify(rawDecision.primaryPick)}. Rationale: ${rawDecision.rationale}. EV markets: ${JSON.stringify(effectiveEligible.slice(0, 3))}`;
              const llmCtx = {
                config: {
                  claudeApiKey: config.claudeApiKey,
                  geminiApiKey: config.geminiApiKey,
                  openrouterApiKey: config.openrouterApiKey,
                  bankroll: config.bankroll,
                },
                requestedAt: new Date().toISOString(),
              };
              const cvl = await callVerification(cvlPrompt, llmCtx);
              cvlStatus = cvl.status;
              if (cvl.status === "VETO") {
                // CVL VETO downgrades grade; primaryPick (best market) stays for reporting
                decision.grade = "LEAN";
                decision.rationale = `CVL VETO: ${cvl.rationale}`;
              }
            }
          } catch {
            /* non-fatal */
          }

          // Log when LLM disagrees with deterministic top (SkillOpt training signal)
          await logPickDisagreement(deps.storage, rawDecision, effectiveEligible[0] ?? null, {
            ...job,
            fixtureId,
          });
          void briefingText; // full briefing text retained for future report body rendering

          const primaryPick =
            effectiveEligible.find((m) => m.market === decision.primaryPick.market) ?? null;

          const analysisId = makeAnalysisId(fixtureId, rankingMode, calibrationSnapshotId);
          return {
            status: "ok" as const,
            analysisId,
            runId,
            fixtureId,
            home: job.home,
            away: job.away,
            league: job.league,
            kickoff: job.kickoff,
            result: filteredResult,
            decision,
            decisionReplay,
            decisionShadow,
            eligibleBets: effectiveEligible,
            primaryPick,
            llmEligible,
            cvlStatus,
            briefingFlags,
            swarmConsensus,
            swarmDivergence: swarmDivergenceVal,
            agentVerification: filteredResult.agentVerification,
          };
        },
        maxRetries,
        backoffMs
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const code = classifyError(reason);
      agentErrors.push({ code, fixtureId, message: reason, retriable: code === "RATE_LIMITED" });
      return {
        status: "error",
        fixtureId,
        home: job.home,
        away: job.away,
        league: job.league,
        kickoff: job.kickoff,
        reason,
        errorCode: code,
        llmEligible,
      };
    }
  }

  // Initial progress event (completed: 0) — preserves the pre-loop semantics
  // callers relied on under the old sequential runner.
  onProgress?.({
    completed: 0,
    total,
    current: jobs[0] ? `${jobs[0].home} vs ${jobs[0].away}` : "",
  });

  // Level-1 swarm: process up to `concurrency` fixtures in parallel.
  // Results preserve input order. Cost ceiling stops scheduling new fixtures
  // (in-flight ones finish); per-key storage locks keep RAG/logs race-free.
  const poolResults = await runPool(jobs, concurrency, processOne, {
    onSettled: (i, r) => {
      // Charge only billable (LLM) decisions toward the ceiling. The GLM-5.2
      // shadow call and the ORACLE_AGENT_VERIFY local-CLI check (when present)
      // are each a second billable request — without this they'd silently
      // spend past costCeilingUsd.perRun unnoticed.
      if (r.status === "ok" && r.decisionReplay !== null) {
        costTracker.charge();
        if (r.decisionShadow) costTracker.charge();
        if (r.agentVerification) costTracker.charge();
      }
      onProgress?.({
        completed: ++completedCounter,
        total,
        current: `${jobs[i]?.home} vs ${jobs[i]?.away}`,
      });
    },
    shouldStop: () => (uncappedOnVps ? false : costTracker.halted),
  });

  // runPool leaves holes for fixtures skipped after a cost-ceiling halt — drop them.
  const results = poolResults.filter((r): r is BatchJobResult => r != null);
  // costTracker.halted can still flip true on uncapped-VPS runs once spend
  // crosses the ceiling (charge() sets it unconditionally) — but shouldStop
  // above never acted on it there, so reporting halted=true would be a false
  // alarm. Force it false in that case to reflect what actually happened.
  const costHalted = uncappedOnVps ? false : costTracker.halted;
  if (costHalted) {
    agentErrors.push({
      code: "COST_CEILING_HIT",
      message: `Per-run cost ceiling $${(ceilingUsd ?? 0).toFixed(2)} reached — stopped scheduling after ${results.filter((r) => r.status === "ok").length} fixture(s)`,
      retriable: false,
    });
  }

  onProgress?.({ completed: total, total, current: "" });

  const successful = results.filter((r): r is FixtureJobSuccess => r.status === "ok");
  const actionable = successful.filter((r) => r.decision.grade !== "NO_EDGE");
  const totalStakePct = actionable.reduce(
    (sum, r) => sum + (r.decision.primaryPick.stake ?? 0) * 100,
    0
  );

  return {
    runId,
    calibrationSnapshotId,
    date: new Date().toISOString().slice(0, 10),
    rankingMode,
    jobs: results,
    completedCount: successful.length,
    errorCount: results.filter((r) => r.status === "error").length,
    actionableCount: actionable.length,
    totalRecommendedStakePct: parseFloat(totalStakePct.toFixed(2)),
    cost: { estimatedUsd: costTracker.spent, ceilingUsd, halted: costHalted },
    errors: agentErrors,
  };
}
