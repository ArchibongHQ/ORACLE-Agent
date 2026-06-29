/** Full-market discovery funnel orchestration — wires stages 1-2 (mechanical
 *  filter → LLM screen, goalsPreFilter.ts + goalsScreen.ts) into FixtureJob[]
 *  ready for stage 3 (the existing deterministic engine, runAnalysis with full
 *  market scope — all 1000+ SportyBet markets, goals prioritized). Stage 4
 *  (Opus arbiter) and stage 5 (top-N cut via selectGoalsAccumulator) are
 *  unchanged existing mechanisms — this file's job ends at producing the
 *  FixtureJob[] stage 3 consumes.
 *
 *  Independent of the main all-markets daily pipeline (fetchTodaysFixtures/
 *  selectFixtures) — those route through the Odds-API/Gemini-fallback cascade
 *  and a maxFixturesPerRun cap built for a different purpose (LLM-tier routing
 *  on a single shared analysis pass). This pipeline scans the FULL daily
 *  SportyBet pool (potentially 1000+ fixtures) for goals-market opportunity
 *  specifically, independent of whatever the main batch chose to analyze. */
import type { FixtureJob, SoftContextItem } from "@oracle/engine";
import type { LLMCallContext } from "@oracle/llm";
import { DEFAULT_PRE_FILTER_POOL_SIZE, preFilterGoalsCandidates } from "./goalsPreFilter.js";
import { mergeScreenedCandidates, screenGoalsCandidates } from "./goalsScreen.js";
import type { SportyBetEvent, SportyBetEventDetail } from "./selectFixtures.js";
import { flattenSidecarOdds } from "./sidecarOdds.js";
import { buildMotivation, buildStatsOverride, buildStatsSoftContext } from "./sportyBetStats.js";
import { buildTravel } from "./travel.js";

/** Converts one SportyBet sidecar event into a FixtureJob, reusing the exact
 *  same odds-flatten + stats-override + soft-context wiring the main daily
 *  pipeline uses for sidecar-sourced fixtures (see fetchFixtureByName,
 *  fixtures.ts:1167-1197). Returns null when the event lacks 1x2 odds (the
 *  same gate fetchFixtureByName applies) — a fixture with no odds at all
 *  can't be EV-scanned regardless of how promising its stats look. */
export function sportyEventToFixtureJob(event: SportyBetEvent): FixtureJob | null {
  const detail: SportyBetEventDetail | undefined = event.detail;
  if (!detail?.odds?.["1x2"]) return null;
  const flat = flattenSidecarOdds(detail);
  if (!flat.home || !flat.away) return null;

  const league = event.league ?? "Unknown";
  const statsOverride = buildStatsOverride(detail, league);
  const statsContext = buildStatsSoftContext(detail);
  // Mirror the main pipeline's full wiring (fixtures.ts injectSidecarOdds): travel +
  // standings-motivation telemetry/soft-context AND the raw stats passthrough the Opus
  // arbiter reads at STEP 0. Previously the funnel set neither, so goals-acca legs
  // reached the arbiter with no raw-stats block — fixed for parity across paths.
  const travel = buildTravel(event.home, event.away, {
    neutralVenue: league === "FIFA World Cup",
  });
  const motivation = buildMotivation(detail);
  const extraSoft: SoftContextItem[] = [];
  if (travel.soft) extraSoft.push(travel.soft);
  if (motivation.soft) extraSoft.push(motivation.soft);
  const mergedSoft = [...statsContext, ...extraSoft];

  return {
    home: event.home,
    away: event.away,
    league,
    kickoff: event.kickoff_utc ?? new Date().toISOString(),
    state: {
      telemetry: {
        ...travel.telemetry,
        ...motivation.telemetry,
        ...statsOverride,
        ...(mergedSoft.length ? { softContext: mergedSoft } : {}),
        ...(detail.stats
          ? { rawStatsBlock: detail.stats as unknown as Record<string, unknown> }
          : {}),
        // Every fixture that survives the funnel (mechanical filter + Sonnet
        // screen) earns full LLM-tier treatment — unlike the main batch's
        // maxFixturesPerRun cap, this pool is already small and pre-screened.
        llmEligible: true,
      },
      pipeline: {
        fetched: {
          odds: flat,
          sportyBetStats: detail.stats,
          sportyBetOdds: detail.odds,
          sportyBetStatsCoverage: detail.statscoverage,
        },
      },
    },
  };
}

export interface GoalsFunnelOptions {
  preFilterPoolSize?: number;
  screenBatchSize?: number;
  /** When absent, the Sonnet screening stage is skipped entirely (fails open
   *  to the mechanical pre-filter's own ranking) — same as a missing API key. */
  llmCtx?: LLMCallContext;
}

export interface GoalsFunnelResult {
  jobs: FixtureJob[];
  /** Total raw SportyBet events considered before any filtering. */
  totalFixtures: number;
  /** Fixtures that survived stage 1 (mechanical pre-filter). */
  preFilteredCount: number;
  /** Fixtures with valid odds that became FixtureJobs (some pre-filtered
   *  candidates may still lack odds and get dropped at conversion). */
  convertedCount: number;
}

/** Runs stages 1-2 of the goals-discovery funnel over the full raw SportyBet
 *  daily event list, returning ranked FixtureJob[] ready for stage 3
 *  (runAnalysis with enableGoalsOnlyMode). Ranking order is preserved end to
 *  end — callers that want a bounded LLM-tier pool can simply slice the
 *  returned jobs array, same convention as selectFixtures' llmEligible cap. */
export async function runGoalsFunnel(
  events: SportyBetEvent[],
  opts: GoalsFunnelOptions = {}
): Promise<GoalsFunnelResult> {
  const preFiltered = preFilterGoalsCandidates(
    events,
    opts.preFilterPoolSize ?? DEFAULT_PRE_FILTER_POOL_SIZE
  );

  let ranked = preFiltered;
  if (opts.llmCtx) {
    const screenResults = await screenGoalsCandidates(
      preFiltered,
      opts.llmCtx,
      opts.screenBatchSize
    );
    ranked = mergeScreenedCandidates(preFiltered, screenResults);
  }

  const jobs: FixtureJob[] = [];
  for (const candidate of ranked) {
    const job = sportyEventToFixtureJob(candidate.event);
    if (job) jobs.push(job);
  }

  return {
    jobs,
    totalFixtures: events.length,
    preFilteredCount: preFiltered.length,
    convertedCount: jobs.length,
  };
}
