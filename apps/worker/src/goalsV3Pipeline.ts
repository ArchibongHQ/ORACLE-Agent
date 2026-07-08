/** [PR-9, worker god-file split] goals-market-analysis-prompt-v3 pipeline,
 *  extracted from index.ts's "thin cron shell": deterministic replacement for
 *  the legacy funnel (mechanical filter -> Sonnet screen -> runAnalysis
 *  ensemble -> per-fixture arbiter) — v3's phases run as pure TypeScript
 *  (eligibility, weighted completeness, multiplicative-Poisson lambdas +
 *  match-shape correction, the §4 edge gate) with LLM usage cut to ONE
 *  slate-level arbiter call reviewing the assembled selection. Gated by
 *  ORACLE_GOALS_V3; false leaves goalsAccumulator.ts's runGoalsBatch legacy
 *  path byte-identical.
 *
 *  Shares its notify/booking tail (sendGoalsSlip/finalizeGoalsSelection) with
 *  the legacy funnel, so this file imports finalizeGoalsSelection back from
 *  goalsAccumulator.ts — a deliberate two-file cycle (both files are only
 *  called via async function bodies, never at module-init time, so the
 *  circular import resolves fine at runtime/compile time); see this worker's
 *  PR-9 split notes for why the shared tail couldn't be host in either file
 *  alone without duplicating it. */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  analyzeGoalsFixtureV3,
  type BatchJobResult,
  formatSanityFlags,
  type GoalsCrossCheckFn,
  goalsSlateSanityChecks,
  type PortfolioLeg,
  type RunManifest,
  type V3AnalyzeInput,
  type V3FixtureOdds,
  type V3FixtureResult,
  v3NbDispersion,
} from "@oracle/engine";
import { sendTelegramDocument } from "@oracle/notify";
import {
  applyCrossBatchVeto,
  applySlateVerdicts,
  blendRecencyScored,
  classifyEligibility,
  crossBatchVetoKeys,
  crossCheckGoalsPick,
  deriveLineHitRates,
  enrichWithH2H,
  enrichWithLineups,
  enrichWithNewsIntel,
  findSidecarDetail,
  generateAndWriteGoalsWorkbook,
  heightenedTrendsAligned,
  loadLedgerState,
  MIN_PLAYED_FOR_OVERRIDE,
  reviewGoalsSlate,
  type SportyBetEvent,
  type SportyBetEventDetail,
  type SportyBetIndex,
  scoreCompleteness,
  scorePredictabilityV3,
  selectGoalsAccumulator,
  sidecarKey,
  sportyEventToFixtureJob,
} from "@oracle/runtime";
import { MemoryAdapter, STORAGE_KEYS } from "@oracle/storage";
import { finalizeGoalsSelection } from "./goalsAccumulator.js";
import { config, env, goalsV3Config, ROOT, STORE_PATH } from "./workerContext.js";
import { watDateString } from "./workerUtils.js";

// ── goals-market-analysis-prompt-v3 pipeline ────────────────────────────────
// Deterministic replacement for the legacy funnel (mechanical filter -> Sonnet
// screen -> runAnalysis ensemble -> per-fixture arbiter): v3's phases run as
// pure TypeScript (eligibility, weighted completeness, multiplicative-Poisson
// lambdas + match-shape correction, the §4 edge gate) with LLM usage cut to
// ONE slate-level arbiter call reviewing the assembled selection. Gated by
// ORACLE_GOALS_V3; false leaves runGoalsBatch's legacy path byte-identical.

/** Extract the goals-relevant decimal odds from a sidecar detail into the
 *  shape analyzeGoalsFixtureV3 prices. Missing markets simply stay null —
 *  the engine's devigOU already treats a null odds field as "not priceable". */
function buildV3Odds(detail: SportyBetEventDetail | undefined): V3FixtureOdds {
  const o = detail?.odds;
  return {
    over15: o?.ou15?.over ?? null,
    under15: o?.ou15?.under ?? null,
    over25: o?.ou25?.over ?? null,
    under25: o?.ou25?.under ?? null,
    homeTotalOver05: o?.tt_home_05?.over ?? null,
    awayTotalOver05: o?.tt_away_05?.over ?? null,
    bttsYes: o?.btts?.yes ?? null,
    bttsNo: o?.btts?.no ?? null,
    home1x2: o?.["1x2"]?.home ?? null,
    draw1x2: o?.["1x2"]?.draw ?? null,
    away1x2: o?.["1x2"]?.away ?? null,
  };
}

/** §3.1 sample size behind the season averages — standings.played is the
 *  season sample; recentGoals.n (last-5 window) is the fallback when a lower
 *  division only exposes a rolling window. */
function v3SampleSize(
  detail: SportyBetEventDetail | undefined,
  side: "home" | "away"
): number | null {
  const played = detail?.stats?.standings?.[side]?.played;
  if (typeof played === "number" && played > 0) return played;
  const n = detail?.stats?.recentGoals?.[side]?.n;
  return typeof n === "number" && n > 0 ? n : null;
}

function v3FixtureId(home: string, away: string, kickoff: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
  return `${slug(home)}_vs_${slug(away)}_${kickoff.replace(/\D/g, "").slice(0, 12)}`;
}

/** Prefer the venue-conditioned xG split (tools/build_xg_table.py) over the
 *  season aggregate when present — a strictly better prior per the type's own
 *  docstring (SportyBetXgEntry.venueXgf/venueXga). */
function v3TeamXg(
  entry:
    | { xgf?: number; xga?: number | null; venueXgf?: number | null; venueXga?: number | null }
    | null
    | undefined
): { xgf?: number | null; xga?: number | null } | null {
  if (!entry) return null;
  return {
    xgf: entry.venueXgf ?? entry.xgf ?? null,
    xga: entry.venueXga ?? entry.xga ?? null,
  };
}

/** [PR-14] Prefer the scoringConceding venue split (home team's own
 *  home-scored/home-conceded rate, away team's own away-scored/away-conceded
 *  rate — stats_season_teamscoringconceding) over the venue-agnostic season
 *  goals.avg_scored/avg_conceded, gated on the same MIN_PLAYED_FOR_OVERRIDE
 *  sample threshold sportyBetStats.ts's buildStatsOverride uses for the
 *  identical preference on the main all-markets path — mirrors v3TeamXg's
 *  "venue over season aggregate" preference for xG just above. This path
 *  builds its lambda input straight from the sidecar detail (not via
 *  buildStatsOverride), so it needs the same gate applied inline. */
function preferVenueScoring(
  profile: { matches?: number; scored_avg?: number; conceded_avg?: number } | null | undefined,
  fallbackScored: number | undefined,
  fallbackConceded: number | undefined
): { scored: number | undefined; conceded: number | undefined } {
  const ok = (profile?.matches ?? 0) >= MIN_PLAYED_FOR_OVERRIDE;
  return {
    scored: ok ? (profile?.scored_avg ?? fallbackScored) : fallbackScored,
    conceded: ok ? (profile?.conceded_avg ?? fallbackConceded) : fallbackConceded,
  };
}

/** Assemble the goals-only v3 engine's per-fixture input from a sidecar detail.
 *  Shared by the goals-v3 batch AND the daily all-markets R10 cross-check hook
 *  (PR-6), so the cross-check re-prices each candidate against the byte-
 *  identical input the goals engine would have used on its own. `gating`
 *  carries the completeness-scorer outputs the caller already computed. */
function buildGoalsV3Input(
  detail: SportyBetEventDetail | undefined,
  fixture: { home: string; away: string; league: string; leagueId?: string; kickoff: string },
  runId: string,
  gating: {
    penaltyFlags: V3AnalyzeInput["penaltyFlags"];
    completeness: number;
    sources: string[];
    heightened: boolean;
    /** Per-league dynamic rho from the calibration ledger (see runGoalsBatchV3's
     *  dynamicRhoByLeague). Undefined ⇒ analyzeGoalsFixtureV3 falls back to the
     *  static getLeagueParams baseRho — same as before this field existed. Not
     *  threaded through the R10 cross-check hook (buildGoalsCrossCheckHook)
     *  below, a deliberate scope cut mirroring the pre-existing hfa/
     *  venueSplitUsed gap noted on lambdaV5 above. */
    dynamicRho?: number;
  }
): V3AnalyzeInput {
  // [PR-14] Prefer the scoringConceding venue split over the season aggregate
  // for both scored and conceded rates — see preferVenueScoring above.
  const homeScoring = preferVenueScoring(
    detail?.stats?.scoringConceding?.home,
    detail?.stats?.goals?.home?.avg_scored,
    detail?.stats?.goals?.home?.avg_conceded
  );
  const awayScoring = preferVenueScoring(
    detail?.stats?.scoringConceding?.away,
    detail?.stats?.goals?.away?.avg_scored,
    detail?.stats?.goals?.away?.avg_conceded
  );
  return {
    fixtureId: v3FixtureId(fixture.home, fixture.away, fixture.kickoff),
    runId,
    home: fixture.home,
    away: fixture.away,
    league: fixture.league,
    kickoff: fixture.kickoff,
    odds: buildV3Odds(detail),
    lambdaInput: {
      league: fixture.league,
      leagueId: fixture.leagueId,
      // Recency-blended scored rate (recentGoals last-5 preferred, form-string
      // + applyTemporalDecay fallback) — this path builds its lambda input
      // straight from the sidecar detail rather than via buildStatsOverride,
      // so it needs the same blend applied inline. Conceded stays season-flat.
      homeScoredPer90: blendRecencyScored(
        homeScoring.scored,
        detail?.stats?.recentGoals?.home?.scored_avg,
        detail?.stats?.form?.home?.last5
      ),
      homeConcededPer90: homeScoring.conceded ?? null,
      awayScoredPer90: blendRecencyScored(
        awayScoring.scored,
        detail?.stats?.recentGoals?.away?.scored_avg,
        detail?.stats?.form?.away?.last5
      ),
      awayConcededPer90: awayScoring.conceded ?? null,
      nHome: v3SampleSize(detail, "home"),
      nAway: v3SampleSize(detail, "away"),
      homeXg: v3TeamXg(detail?.stats?.xg?.home),
      awayXg: v3TeamXg(detail?.stats?.xg?.away),
      // §8.2 (PR-6): tool-derived squad availability, not an LLM guess (see
      // fetch_squad_availability.py). Undefined ⇒ computeV3Lambdas no-ops (1.0).
      homeAvailabilityMult: detail?.stats?.availability?.home?.idx ?? null,
      awayAvailabilityMult: detail?.stats?.availability?.away?.idx ?? null,
    },
    penaltyFlags: gating.penaltyFlags,
    completeness: gating.completeness,
    sources: gating.sources,
    nbDispersion: config.useNegBinom ? v3NbDispersion(config.nbDispersion) : undefined,
    xgBlend: goalsV3Config.xgBlend,
    edgeCap: goalsV3Config.edgeCap,
    noiseGate: goalsV3Config.noiseGate,
    // NOTE: unlike the main all-markets batch (batch/index.ts's buildV3Input),
    // this goals-only path does not currently pass hfa/venueSplitUsed — a
    // pre-existing gap (goals-only fixtures get no HFA term at all) outside
    // this fix's scope; flagging for a follow-up rather than fixing inline.
    lambdaV5: config.v3LambdaV5,
    // Lake-computed league baselines (audit P0-2) — undefined unless
    // ORACLE_V3_LAKE_BASELINES is on.
    lakeBaselines: config.v3LakeBaselines,
    heightened: gating.heightened,
    lineHitRates: deriveLineHitRates(detail),
    dynamicRho: gating.dynamicRho,
  };
}

/** Build the R10 goals cross-check hook (PR-6) for the daily all-markets batch.
 *  Returns undefined (⇒ cross-check disabled) when the flag is off or no
 *  sidecar index is available. The hook rebuilds each fixture's goals-only
 *  input from its sidecar detail and defers to crossCheckGoalsPick; a fixture
 *  with no sidecar mapping yields null (no independent opinion). Standard
 *  (non-heightened) goals bars are used — the more lenient floor, which
 *  agrees more and over-drops less, matching the plan's "no hard veto" intent. */
export function buildGoalsCrossCheckHook(
  detailByKey: Map<string, SportyBetEventDetail> | undefined
): GoalsCrossCheckFn | undefined {
  if (config.v3GoalsCrossCheck === false || !detailByKey) return undefined;
  return (pick, label, odds, fixture) => {
    const detail = findSidecarDetail(detailByKey, fixture.home, fixture.away);
    if (!detail) return null;
    const lineupsAvailable = false; // daily hook has no per-fixture job.state here
    const completeness = scoreCompleteness(detail, {
      lineupsAvailable,
      completenessV4: config.v3CompletenessV4,
    });
    const goalsInput = buildGoalsV3Input(detail, fixture, "crosscheck", {
      penaltyFlags: completeness.penaltyFlags,
      completeness: completeness.score,
      sources: completeness.sources,
      heightened: false,
    });
    return crossCheckGoalsPick(pick, label, odds, goalsInput);
  };
}

/** Best-effort transparency log for §4.4 capped selections (raw edge > cap,
 *  auto-discarded, never bet). A write failure here must never fail the run —
 *  same convention as writeGoalsArtifact. */
async function writeV3CappedLog(
  capped: Array<{
    home: string;
    away: string;
    league: string;
    label: string;
    rawEdge: number;
    rationale: string;
  }>,
  date: string
): Promise<void> {
  if (capped.length === 0) return;
  try {
    const outDir = join(ROOT, ".tmp/goals");
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, `v3-capped-${date}.json`),
      JSON.stringify({ date, generatedAt: new Date().toISOString(), capped }, null, 2),
      "utf8"
    );
  } catch (err) {
    process.stderr.write(
      `[goals-v3] WARN: capped-log write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

/** [PR-13] Loads today's already-completed daily-batch actionable picks as
 *  PortfolioLeg[], for the cross-batch correlation veto (@oracle/runtime's
 *  crossBatchVetoKeys) below. STORAGE_KEYS.runManifests is written by every
 *  runAnalysis call (packages/runtime/src/analyze.ts) — not just the 09:35
 *  WAT daily batch, but also ad-hoc CLI/bot/web/punt "manual"-trigger runs
 *  that share the same array. Filtering to trigger==="scheduled" excludes
 *  those — an ad-hoc single-fixture lookup during the morning window must
 *  not be treated as if it were an already-committed daily-batch pick. Under
 *  ORACLE_GOALS_V3=true (the only mode that calls this) this batch itself
 *  never reaches runAnalysis/writes its own manifest entry (goalsAccumulator.ts
 *  dispatches to runGoalsBatchV3 and returns before its own legacy runAnalysis
 *  call), so there's no risk of this batch's own entry polluting the read.
 *  Fails open to an empty array (no cross-batch check, today's exact
 *  pre-PR-13 behavior) when the daily batch hasn't run yet, its manifest
 *  doesn't parse, or the read itself throws — this is a portfolio-risk safety
 *  net, not a hard dependency, and must never be why the goals batch fails. */
export async function loadTodaysCompletedLegs(
  storage: MemoryAdapter,
  today: string
): Promise<PortfolioLeg[]> {
  try {
    const manifests = (await storage.get<RunManifest[]>(STORAGE_KEYS.runManifests)) ?? [];
    const legs: PortfolioLeg[] = [];
    for (const manifest of manifests) {
      if (manifest.trigger !== "scheduled") continue;
      for (const fixture of manifest.fixtures) {
        if (fixture.status !== "ok" || !fixture.pick || !fixture.kickoff.startsWith(today))
          continue;
        legs.push({
          home: fixture.home,
          away: fixture.away,
          league: fixture.league,
          market: fixture.pick.market,
          mp: fixture.confidence ?? 0,
          kickoff: fixture.kickoff,
        });
      }
    }
    return legs;
  } catch (err) {
    process.stderr.write(
      `[goals-v3] WARN: cross-batch leg load failed (non-fatal, skipping cross-batch check): ${err instanceof Error ? err.message : String(err)}\n`
    );
    return [];
  }
}

/** goals-market-analysis-prompt-v3 end-to-end: eligibility (union whitelist +
 *  hard discards) -> enrichment (H2H/newsIntel cache-only/lineups, reused as-is
 *  from the legacy path) -> weighted completeness gate (<70 discard) ->
 *  predictability ordering -> deterministic per-fixture analysis (v3 lambdas +
 *  Dixon-Coles matrix + match-shape BTTS correction + §4 edge gate, NO
 *  per-fixture LLM) -> selectGoalsAccumulator(v3) -> ONE slate arbiter call ->
 *  the same five Telegram slips the legacy path sends. */
export async function runGoalsBatchV3(
  futureEvents: SportyBetEvent[],
  index: SportyBetIndex,
  trigger: RunManifest["trigger"]
): Promise<void> {
  const date = watDateString();

  // ── Phase 1 — eligibility ─────────────────────────────────────────────────
  const classified = futureEvents.map((event) => ({ event, elig: classifyEligibility(event) }));
  const survivors = classified.filter((c) => c.elig.status !== "discard");
  process.stdout.write(
    `[goals-v3] eligibility: ${futureEvents.length} → ${survivors.length} survive ` +
      `(${futureEvents.length - survivors.length} discarded)\n`
  );
  if (!survivors.length) {
    process.stdout.write("[goals-v3] no eligible fixtures — skipping\n");
    return;
  }

  // Build FixtureJobs for enrichment reuse (H2H/newsIntel/lineups all operate
  // on FixtureJob[] — same functions the legacy path calls, unmodified).
  const preJobs = survivors
    .map(({ event }) => ({ event, job: sportyEventToFixtureJob(event) }))
    .filter(
      (
        x
      ): x is {
        event: SportyBetEvent;
        job: NonNullable<ReturnType<typeof sportyEventToFixtureJob>>;
      } => x.job !== null
    );
  if (!preJobs.length) {
    process.stdout.write("[goals-v3] no fixtures with priceable odds — skipping\n");
    return;
  }

  const storage = new MemoryAdapter(STORE_PATH);
  // §8.1/PR-5: per-league dynamic rho (NEW-07) — same "on"-mode-only gating
  // analyze.ts uses when stamping job.state.ledger for the legacy/marketsV3
  // path; goals-v3 has no RunState/job.state ledger concept of its own, so
  // load the ledger directly once per batch instead.
  const dynamicRhoByLeague =
    config.calibrationLedger === "on"
      ? (await loadLedgerState(storage))?.metrics.dynamicRhoParams
      : undefined;
  const withH2H = await enrichWithH2H(
    preJobs.map((x) => x.job),
    config.footballDataApiKey
  );
  const withNews = config.enableNewsIntel
    ? await enrichWithNewsIntel(withH2H, { storage, cacheOnly: true })
    : withH2H;
  const enrichedJobs = await enrichWithLineups(withNews);

  // ── Phase 0 — weighted completeness gate ─────────────────────────────────
  const eligByKey = new Map(
    classified.map((c) => [sidecarKey(c.event.home, c.event.away), c.elig])
  );
  let completenessDiscards = 0;
  let heightenedDiscards = 0;
  const gated: Array<{
    event: SportyBetEvent;
    job: (typeof preJobs)[number]["job"];
    completeness: ReturnType<typeof scoreCompleteness>;
    /** §1.2 heightened eligibility — per-fixture input to the v4 8pt pass floor. */
    heightened: boolean;
  }> = [];
  for (let i = 0; i < preJobs.length; i++) {
    const { event } = preJobs[i]!;
    const job = enrichedJobs[i]!;
    const detail = event.detail;
    const h2hEnriched =
      typeof (job.state?.pipeline?.fetched as { stats?: { h2hN?: number } } | undefined)?.stats
        ?.h2hN === "number";
    const lineupsAvailable = (job.state?.telemetry?.softContext ?? []).some(
      (item) => item.kind === "lineup"
    );
    const completeness = scoreCompleteness(detail, {
      h2hEnriched,
      lineupsAvailable,
      completenessV4: config.v3CompletenessV4,
    });
    const elig = eligByKey.get(sidecarKey(event.home, event.away));
    const minScore =
      elig?.status === "heightened" ? goalsV3Config.heightenedMin : goalsV3Config.completenessMin;
    const heightenedOk = elig?.status !== "heightened" || heightenedTrendsAligned(detail);
    if (
      completeness.mandatoryMissing.length > 0 ||
      completeness.score < minScore ||
      !heightenedOk
    ) {
      if (elig?.status === "heightened") heightenedDiscards++;
      else completenessDiscards++;
      continue;
    }
    gated.push({ event, job, completeness, heightened: elig?.status === "heightened" });
  }
  process.stdout.write(
    `[goals-v3] completeness: ${preJobs.length} → ${gated.length} survive ` +
      `(${completenessDiscards} below floor, ${heightenedDiscards} heightened-bar failed)\n`
  );
  if (!gated.length) {
    process.stdout.write("[goals-v3] no fixtures cleared the completeness gate — skipping\n");
    return;
  }

  // ── Phase 2 — predictability ordering (cosmetic; lean path analyzes all) ──
  gated.sort(
    (a, b) =>
      scorePredictabilityV3(a.event) - scorePredictabilityV3(b.event) ||
      a.completeness.score - b.completeness.score
  );
  gated.reverse();

  // ── Phases 3–4 — deterministic per-fixture analysis + edge gate ──────────
  const runId = `run_v3_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const jobs: BatchJobResult[] = [];
  const results: V3FixtureResult[] = [];
  const cappedLog: Array<{
    home: string;
    away: string;
    league: string;
    label: string;
    rawEdge: number;
    rationale: string;
  }> = [];
  let analysisErrors = 0;
  for (const { event, job, completeness, heightened } of gated) {
    const detail = event.detail;
    const input = buildGoalsV3Input(detail, job, runId, {
      penaltyFlags: completeness.penaltyFlags,
      completeness: completeness.score,
      sources: completeness.sources,
      // Per-fixture (§1.2 eligibility class), not slate-wide: the gates-v4 flag
      // enables the heightened mechanism, eligibility decides who it applies to.
      heightened: config.v3GatesV4 !== false && heightened,
      dynamicRho: dynamicRhoByLeague?.[job.league],
    });
    const result = analyzeGoalsFixtureV3(input);
    if (!result) {
      analysisErrors++;
      continue;
    }
    jobs.push(result.job);
    results.push(result);
    for (const c of result.capped) {
      cappedLog.push({
        home: job.home,
        away: job.away,
        league: job.league,
        label: c.label,
        rawEdge: c.rawEdge,
        rationale: c.rationale,
      });
    }
  }
  process.stdout.write(
    `[goals-v3] analyzed ${jobs.length}/${gated.length} fixtures (${analysisErrors} errors, ${cappedLog.length} capped selections)\n`
  );
  await writeV3CappedLog(cappedLog, date);

  const goalsSanityLine = formatSanityFlags(
    goalsSlateSanityChecks(results.flatMap((r) => r.assessments))
  );
  process.stdout.write(`[goals-v3] ${goalsSanityLine}\n`);

  // ── Phase 6 — selection ───────────────────────────────────────────────────
  const eventIdByKey = new Map<string, string>();
  for (const ev of index.events) {
    if (ev.eventId) eventIdByKey.set(sidecarKey(ev.home, ev.away), ev.eventId);
  }
  let selection = selectGoalsAccumulator(jobs, {
    minConfidence: config.goalsMinConfidence,
    minImplied: config.goalsMinImplied,
    target: config.goalsTargetLegs,
    detailByKey: index.detailByKey,
    eventIdByKey,
    v3: true,
  });

  // [PR-13] Cross-batch portfolio dedup — veto goals legs too correlated
  // (same league + near-simultaneous kickoff, CROSS_FIXTURE_CORRELATION_REJECT)
  // with a pick the daily all-markets batch already committed to today, before
  // the slate arbiter reviews the (now-deduped) selection.
  const dailyBatchLegs = await loadTodaysCompletedLegs(storage, date);
  const crossBatchVetoes = crossBatchVetoKeys(selection, dailyBatchLegs);
  if (crossBatchVetoes.size > 0) {
    process.stdout.write(
      `[goals-v3] cross-batch veto: ${crossBatchVetoes.size} leg(s) too correlated with an already-committed daily-batch pick\n`
    );
    selection = applyCrossBatchVeto(selection, crossBatchVetoes);
  }

  // ── One slate-level LLM call ──────────────────────────────────────────────
  const verdicts = await reviewGoalsSlate(selection, { timeoutMs: goalsV3Config.arbiterTimeoutMs });
  process.stdout.write(
    `[goals-v3] slate arbiter: ${verdicts.status} — ${verdicts.drops.size} dropped, ${verdicts.flags.size} flagged\n`
  );
  selection = applySlateVerdicts(selection, verdicts);

  // LLM-readable workbook (Analysis/Slips/Capped/META_JSON) — best-effort,
  // never blocks slip delivery. Sent alongside the five Telegram slips.
  try {
    const workbookPath = await generateAndWriteGoalsWorkbook(
      { selection, results, capped: cappedLog, date, arbiterStatus: verdicts.status },
      join(ROOT, ".tmp/reports")
    );
    process.stdout.write(`[goals-v3] wrote ${workbookPath}\n`);
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      await sendTelegramDocument(
        env.TELEGRAM_BOT_TOKEN,
        env.TELEGRAM_CHAT_ID,
        workbookPath,
        `ORACLE goals v3 analysis (spreadsheet) — ${date} (${jobs.length} fixtures analyzed)`
      );
    }
  } catch (err) {
    process.stderr.write(
      `[goals-v3] WARN: workbook write/send failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`
    );
  }

  await finalizeGoalsSelection(selection, date, analysisErrors, trigger, {
    arbiterStatus: verdicts.status,
    cappedCount: cappedLog.length,
    sanityLine: goalsSanityLine,
  });
}
