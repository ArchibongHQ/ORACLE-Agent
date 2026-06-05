/** Batch runner — Phase 3.
 *  parseFixtureList: text → FixtureJob[]. runBatch: sequential, resilient, progress events. */
import type { OracleConfig, RankingMode, RunState, RunResult, EVMarket, DecisionOutput, DecisionReplay, PickRef, SoftContextItem, AgentError, AgentErrorCode } from '../types.js';
import type { StoragePort } from '@oracle/storage';
import { ExecutionEngine } from '../execution/index.js';
import { buildEligibleBets, decide, validateSelection, logPickDisagreement } from '../decision/index.js';
import type { DecisionContext } from '../decision/index.js';

export interface FixtureJob {
  home: string;
  away: string;
  league: string;
  kickoff: string;   // ISO-8601 or YYYY-MM-DDTHH:mm:ssZ
  state?: RunState;  // optional pre-populated telemetry / odds
}

export interface FixtureJobSuccess {
  status: 'ok';
  analysisId: string;           // deterministic idempotency key
  runId: string;                // parent batch run
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
}

export interface FixtureJobError {
  status: 'error';
  fixtureId: string;
  home: string;
  away: string;
  league: string;
  kickoff: string;
  reason: string;
  errorCode: AgentErrorCode;
}

export type BatchJobResult = FixtureJobSuccess | FixtureJobError;

export interface BatchResult {
  runId: string;
  calibrationSnapshotId: string;
  date: string;             // YYYY-MM-DD
  rankingMode: RankingMode;
  dryRun?: boolean;         // true when BatchOptions.dryRun was set
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
  calibrationSnapshotId?: string;  // defaults to "calib_YYYY-MM-DD"
  marketWhitelist?: string[];
  dryRun?: boolean;                // skip execution; return cost estimate only (§11A)
  maxRetries?: number;             // per-fixture retries on RATE_LIMITED (default 3; 0 = no retries)
  backoffMs?: (attempt: number) => number; // delay per retry attempt; default: exponential 1s/2s/4s ±10%
  onProgress?: (event: { completed: number; total: number; current: string }) => void;
}

/** Parse newline-delimited fixture list.
 *  Accepted formats:
 *    "Home vs Away, League, Kickoff"
 *    "Home vs Away | League | Kickoff"
 *  Lines starting with '#' and blank lines are skipped. */
export function parseFixtureList(input: string): FixtureJob[] {
  const jobs: FixtureJob[] = [];
  for (const raw of input.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const sep = line.includes('|') ? '|' : ',';
    const parts = line.split(sep).map(p => p.trim());
    if (parts.length < 1) continue;

    const vsMatch = (parts[0] ?? '').match(/^(.+?)\s+vs\.?\s+(.+)$/i);
    if (!vsMatch) continue;

    const home = vsMatch[1]!.trim();
    const away = vsMatch[2]!.trim();
    if (!home || !away) continue;

    jobs.push({
      home,
      away,
      league: parts[1] ?? 'Default',
      kickoff: parts[2] ?? new Date().toISOString(),
    });
  }
  return jobs;
}

// Conservative per-call cost for claude-opus-4-8 (~1K input + 200 output tokens)
const LLM_COST_ESTIMATE_USD_PER_CALL = 0.05;

function classifyError(msg: string): AgentErrorCode {
  if (/429|rate.?limit/i.test(msg)) return 'RATE_LIMITED';
  if (/no.?data|not.?found|no fixture/i.test(msg)) return 'NO_DATA';
  if (/odds/i.test(msg)) return 'ODDS_UNAVAILABLE';
  if (/ambiguous/i.test(msg)) return 'AMBIGUOUS_FIXTURE';
  return 'INTERNAL';
}

function makeFixtureId(home: string, away: string, kickoff: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  return `${slug(home)}_vs_${slug(away)}_${kickoff.replace(/\D/g, '').slice(0, 12)}`;
}

function makeRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Deterministic per-analysis ID — enables safe upserts (PRD §11A.3). */
function makeAnalysisId(fixtureId: string, rankingMode: string, calibrationSnapshotId: string): string {
  return `${fixtureId}:${rankingMode}:${calibrationSnapshotId}`;
}

/** Retries fn up to maxRetries times on RATE_LIMITED errors with exponential backoff. */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  backoffMs: (attempt: number) => number,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (classifyError(msg) !== 'RATE_LIMITED' || attempt >= maxRetries) throw err;
      await new Promise<void>(r => setTimeout(r, backoffMs(attempt)));
      attempt++;
    }
  }
}

/** Run a batch of fixture jobs sequentially.
 *  One job failing never aborts the batch — it produces { status: 'error' } instead. */
export async function runBatch(
  jobs: FixtureJob[],
  deps: { storage: StoragePort; config: OracleConfig },
  options: BatchOptions = {},
): Promise<BatchResult> {
  const { onProgress, marketWhitelist, rankingMode = 'CONFIDENCE_WEIGHTED' } = options;
  const maxRetries = options.maxRetries ?? 3;
  const backoffMs = options.backoffMs ?? ((attempt: number) => {
    const base = Math.pow(2, attempt) * 1000;
    return base * (1 + (Math.random() * 0.2 - 0.1));
  });
  const runId = makeRunId();
  const calibrationSnapshotId = options.calibrationSnapshotId ?? `calib_${new Date().toISOString().slice(0, 10)}`;
  const config: OracleConfig = { ...deps.config, rankingMode };
  const ceilingUsd = config.costCeilingUsd?.perRun ?? null;

  // §11A dry-run: no API calls; returns a cost estimate based on job count
  if (options.dryRun) {
    const dryJobs: BatchJobResult[] = jobs.map(job => ({
      status: 'error' as const,
      fixtureId: makeFixtureId(job.home, job.away, job.kickoff),
      home: job.home,
      away: job.away,
      league: job.league,
      kickoff: job.kickoff,
      reason: 'DRY_RUN — estimate only',
      errorCode: 'DRY_RUN' as AgentErrorCode,
    }));
    return {
      runId, calibrationSnapshotId,
      date: new Date().toISOString().slice(0, 10),
      rankingMode, dryRun: true,
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

  const results: BatchJobResult[] = [];
  const agentErrors: AgentError[] = [];
  let estimatedCostUsd = 0;
  let costHalted = false;
  const total = jobs.length;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!;
    const fixtureId = makeFixtureId(job.home, job.away, job.kickoff);

    onProgress?.({ completed: i, total, current: `${job.home} vs ${job.away}` });

    try {
      const jobResult = await withRetry(async (): Promise<FixtureJobSuccess> => {
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
        const wl = marketWhitelist.map(s => s.toLowerCase());
        evMarkets = evMarkets.filter(m =>
          wl.some(w => m.cat.toLowerCase().includes(w) || m.label.toLowerCase().includes(w)),
        );
      }

      const filteredResult: RunResult = { ...runResult, evMarkets };
      const eligible = buildEligibleBets(evMarkets);

      // Build context for LLM decision layer
      const convResult = runResult['convergence'] as Record<string, unknown> | undefined;
      const mlResult   = runResult['mlFilter']    as Record<string, unknown> | undefined;
      const debateRes  = runResult['debate']       as Record<string, unknown> | undefined;
      const regimeRes  = runResult['lowScoreRegime'] as Record<string, unknown> | undefined;

      const decisionCtx: DecisionContext = {
        fixture:              { home: job.home, away: job.away, league: job.league, kickoff: job.kickoff },
        fp:                   runResult.fp,
        lambdaH:              (runResult.bayesian_lH as number | undefined) ?? 0,
        lambdaA:              (runResult.bayesian_lA as number | undefined) ?? 0,
        expectedScoreline:    String(runResult.expectedScoreline ?? '?'),
        regime:               String(regimeRes?.regime ?? 'STANDARD'),
        convergenceTier:      String(convResult?.tier ?? 'UNKNOWN'),
        convergenceScore:     Number(convResult?.score ?? 0),
        mlAllowed:            mlResult?.mlAllowed !== false,
        drawRisk:             String(mlResult?.drawRisk ?? 'MEDIUM'),
        betTrigger:           String(debateRes?.betTrigger ?? 'YELLOW'),
        portfolioCorrelation: runResult.portfolioCorrelation,
        softContext:          state.telemetry?.softContext as SoftContextItem[] | undefined,
      };

      // B7: route based on convergence tier
      let briefingText: string | undefined;
      try {
        const { routeFixture } = await import('@oracle/llm');
        const route = routeFixture(String(convResult?.['tier'] ?? 'VIABLE'));

        // B1: optional briefing layer for APEX/PRIME fixtures
        if (route.useBriefing && config.enableBriefing && (config.claudeApiKey || config.geminiApiKey)) {
          try {
            const { callBriefing } = await import('@oracle/llm');
            const briefingPrompt = `Provide a brief pre-match analysis for ${job.home} vs ${job.away} (${job.league}).
Convergence tier: ${route.tier}. Top eligible bet: ${eligible[0]?.label ?? 'none'} @ ${eligible[0]?.odds ?? 'N/A'}.
Keep it under 200 words. Identify the single most important risk factor.`;
            const llmCtx = { config: { claudeApiKey: config.claudeApiKey, geminiApiKey: config.geminiApiKey, bankroll: config.bankroll }, requestedAt: new Date().toISOString() };
            const briefing = await callBriefing(briefingPrompt, llmCtx);
            briefingText = briefing.text;
            if (briefing.flags.length) {
              decisionCtx.softContext = [
                ...(decisionCtx.softContext ?? []),
                ...briefing.flags.map(f => ({ kind: 'news' as const, text: `[BRIEFING_FLAG] ${f}`, source: 'callBriefing', observedAt: new Date().toISOString() })),
              ];
            }
          } catch { /* non-fatal */ }
        }
      } catch { /* non-fatal — llm module unavailable */ }

      const { decision: rawDecision, replay: decisionReplay } = await decide(eligible, decisionCtx, config);
      const mlFilter     = { mlAllowed: decisionCtx.mlAllowed, drawRisk: decisionCtx.drawRisk };
      const decision     = validateSelection(rawDecision, eligible, mlFilter);

      // B2: optional CVL adversarial verification
      let cvlStamp: string | undefined;
      try {
        const { routeFixture } = await import('@oracle/llm');
        const route = routeFixture(String(convResult?.['tier'] ?? 'VIABLE'));
        if (route.useCVL && config.enableCVL && config.claudeApiKey && rawDecision.primaryPick !== 'NO_BET') {
          const { callVerification } = await import('@oracle/llm');
          const cvlPrompt = `Primary pick: ${JSON.stringify(rawDecision.primaryPick)}. Rationale: ${rawDecision.rationale}. EV markets: ${JSON.stringify(eligible.slice(0, 3))}`;
          const llmCtx = { config: { claudeApiKey: config.claudeApiKey, geminiApiKey: config.geminiApiKey, bankroll: config.bankroll }, requestedAt: new Date().toISOString() };
          const cvl = await callVerification(cvlPrompt, llmCtx);
          cvlStamp = cvl.stamp;
          if (cvl.status === 'VETO') {
            decision.primaryPick = 'NO_BET';
            decision.rationale = `CVL VETO: ${cvl.rationale}`;
          }
        }
      } catch { /* non-fatal */ }

      // Log when LLM disagrees with deterministic top (SkillOpt training signal)
      await logPickDisagreement(deps.storage, rawDecision, eligible[0] ?? null, { ...job, fixtureId });
      void cvlStamp; // referenced for future telemetry
      void briefingText; // referenced for future report rendering

      const primaryPick =
        decision.primaryPick !== 'NO_BET'
          ? (eligible.find(m => m.market === (decision.primaryPick as PickRef).market) ?? null)
          : null;

      const analysisId = makeAnalysisId(fixtureId, rankingMode, calibrationSnapshotId);
      return {
        status: 'ok' as const,
        analysisId, runId, fixtureId,
        home: job.home, away: job.away, league: job.league, kickoff: job.kickoff,
        result: filteredResult, decision, decisionReplay, eligibleBets: eligible, primaryPick,
      };
      }, maxRetries, backoffMs);

      results.push(jobResult);

      // Cost ceiling enforcement (PRD §11A.4) — only LLM calls contribute to cost
      if (jobResult.decisionReplay !== null) {
        estimatedCostUsd += LLM_COST_ESTIMATE_USD_PER_CALL;
        if (ceilingUsd !== null && estimatedCostUsd >= ceilingUsd) {
          agentErrors.push({
            code: 'COST_CEILING_HIT',
            message: `Per-run cost ceiling $${ceilingUsd.toFixed(2)} reached — batch halted after ${results.filter(r => r.status === 'ok').length} fixture(s)`,
            retriable: false,
          });
          costHalted = true;
          break;
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const code = classifyError(reason);
      agentErrors.push({ code, fixtureId, message: reason, retriable: code === 'RATE_LIMITED' });
      results.push({
        status: 'error',
        fixtureId,
        home: job.home,
        away: job.away,
        league: job.league,
        kickoff: job.kickoff,
        reason,
        errorCode: code,
      });
    }
  }

  onProgress?.({ completed: total, total, current: '' });

  const successful = results.filter((r): r is FixtureJobSuccess => r.status === 'ok');
  const actionable = successful.filter(r => r.decision.primaryPick !== 'NO_BET');
  const totalStakePct = actionable.reduce((sum, r) => {
    const pick = r.decision.primaryPick;
    if (pick === 'NO_BET') return sum;
    return sum + ((pick as PickRef).stake ?? 0) * 100;
  }, 0);

  return {
    runId,
    calibrationSnapshotId,
    date: new Date().toISOString().slice(0, 10),
    rankingMode,
    jobs: results,
    completedCount: successful.length,
    errorCount: results.filter(r => r.status === 'error').length,
    actionableCount: actionable.length,
    totalRecommendedStakePct: parseFloat(totalStakePct.toFixed(2)),
    cost: { estimatedUsd: estimatedCostUsd, ceilingUsd, halted: costHalted },
    errors: agentErrors,
  };
}
