/** PR-5a — slate-level all-markets pre-filter over sidecar-mapped fixtures.
 *
 *  Runs gateMarketsV3Fixture (eligibility + weighted completeness, reused
 *  verbatim from pipeline.ts) over every daily-batch job that maps to a
 *  SportyBet sidecar detail, BEFORE the chunk loop — dropping fixtures v3
 *  would discard anyway saves their entire engine+LLM analysis cost.
 *
 *  Fail-open contract (missing data is never a blocker):
 *  - job with no sidecar mapping ⇒ kept, untouched (the gate can't evaluate it)
 *  - any thrown error ⇒ the ORIGINAL job list is returned, summary null
 *  - every mapped fixture discarded AND nothing unmapped ⇒ caller should fail
 *    open to the ungated slate (an all-drop is more likely an upstream league-
 *    name/schema regression than a genuinely empty slate — see
 *    completenessInputs.ts for the same fear, instrumented)
 *
 *  Survivors are stamped `telemetry.v3Heightened` from their §1.2 eligibility
 *  class, completing the all-markets heightened wiring deferred in PR-3
 *  (buildV3Input consumes the stamp per fixture).
 *
 *  [refactor P1-3] Also runs the v5 Rule 0.14 feed-integrity stage
 *  (feedIntegrity.ts) over the same sidecar-mapped fixtures, slate-wide, once
 *  per call, BEFORE the per-job gating loop — the SRL-twin pairing check
 *  needs every mapped fixture's block visible (including twins the
 *  eligibility gate would otherwise discard as "srl_virtual" before the
 *  real fixture's twin comparison ever ran). Controlled by
 *  `opts.feedIntegrity` ("off" | "shadow" | "on", default "on" — mirrors
 *  OracleConfig.feedIntegrity's default in packages/engine/src/types.ts; the
 *  dailyBatch caller may pass `opts.feedIntegrity = config.feedIntegrity`
 *  explicitly but doesn't have to). "on": a contaminated fixture is
 *  discarded outright (no headline-only rescue path is implemented — see
 *  `FixtureIntegrityResult.headlineOnly`'s doc comment in feedIntegrity.ts)
 *  rather than being evaluated against a markets block that may be garbage;
 *  "shadow": the gate runs as normal, the report is computed and returned
 *  for logging only; "off": the stage doesn't run at all. The computed
 *  report is returned on `SlateGateOutcome.integrityReport` — look a
 *  specific fixture's verdict up via `checkFixtureIntegrity(fixtureKey,
 *  outcome.integrityReport)`. Pure, synchronous, no I/O. */

import type { FixtureJob } from "@oracle/engine";
import {
  checkFixtureIntegrity,
  type MarketsBlockEntry,
  runFeedIntegrity,
  type SlateIntegrityReport,
} from "../feedIntegrity.js";
import {
  findSidecarDetail,
  type SportyBetEventDetail,
  type SportyBetOdds,
} from "../selectFixtures.js";
import {
  gateMarketsV3Fixture,
  type MarketsV3GateConfig,
  restrictOddsToGoalsOverOnly,
  type V3EnrichmentState,
} from "./pipeline.js";

export interface SlateGateSummary {
  /** Sidecar-mapped fixtures the gate actually evaluated. */
  total: number;
  passed: number;
  discardCounts: Record<string, number>;
  /** Fixtures with no sidecar mapping — always kept, never evaluated. */
  unmapped: number;
}

export interface SlateGateOutcome {
  jobs: FixtureJob[];
  /** null ⇒ gate did not run (no sidecar index, or error fail-open) — `jobs`
   *  is the input list untouched. */
  summary: SlateGateSummary | null;
  /** [refactor P1-3] v5 Rule 0.14 feed-integrity report for this slate. null
   *  when the stage didn't run (`feedIntegrity: "off"`, no sidecar index, or
   *  no fixture carried an allMarkets block to check). Look a specific
   *  fixture's verdict up with `checkFixtureIntegrity(fixtureKey, report)`. */
  integrityReport?: SlateIntegrityReport | null;
}

/** Mirror of the goals path's enrichment derivation (worker completeness gate):
 *  H2H presence from the fetched stats block, lineups from softContext. */
function deriveEnrichment(job: FixtureJob, completenessV4?: boolean): V3EnrichmentState {
  const fetched = job.state?.pipeline?.fetched as { stats?: { h2hN?: number } } | undefined;
  const softContext = job.state?.telemetry?.softContext ?? [];
  return {
    h2hEnriched: typeof fetched?.stats?.h2hN === "number",
    lineupsAvailable: softContext.some((item) => item.kind === "lineup"),
    completenessV4,
  };
}

function stampHeightened(job: FixtureJob, heightened: boolean): FixtureJob {
  return {
    ...job,
    state: {
      ...(job.state ?? {}),
      telemetry: { ...(job.state?.telemetry ?? {}), v3Heightened: heightened },
    },
  };
}

/** [Wave-4 WS-A3] Choke point for a friendly's `marketRestriction:
 *  "goals_over_only"` (set by classifyEligibility). Rewrites
 *  `state.pipeline.fetched.sportyBetOdds` — the exact field
 *  packages/engine/src/batch/index.ts reads to build the pricing input
 *  (`state.pipeline?.fetched?.sportyBetOdds.allMarkets`) — via
 *  pipeline.ts's restrictOddsToGoalsOverOnly, so the restricted market table
 *  is what actually reaches pricing, not just what the gate saw. */
function applyMarketRestriction(job: FixtureJob): FixtureJob {
  const fetched = { ...(job.state?.pipeline?.fetched ?? {}) } as Record<string, unknown>;
  const odds = fetched.sportyBetOdds as SportyBetOdds | null | undefined;
  fetched.sportyBetOdds = restrictOddsToGoalsOverOnly(odds);
  return {
    ...job,
    state: {
      ...(job.state ?? {}),
      pipeline: { ...(job.state?.pipeline ?? {}), fetched },
    },
  };
}

/** [refactor P1-3] fixtureKey convention shared with feedIntegrity.ts: raw
 *  (not alias-resolved) `${home}|${away}`, no kickoff component — matters
 *  because the SRL-twin pairing check needs the literal " SRL" team-name
 *  suffix intact to strip. */
function fixtureIntegrityKey(job: Pick<FixtureJob, "home" | "away">): string {
  return `${job.home}|${job.away}`;
}

/** Flatten a sidecar allMarkets catalogue into feedIntegrity.ts's generic
 *  MarketsBlockEntry shape. Market id "1" is gismo's documented 1X2/match-
 *  result market (tools/scrape_fixtures.py `_parse_odds`: "1=1X2 … outcomes
 *  1=home, 2=draw, 3=away") — normalized to a stable "1X2"/"home"/"draw"/
 *  "away" label here so crossCheckHeadline1x2 doesn't have to guess at
 *  gismo's raw (undocumented) `name`/`desc` text for that one market; every
 *  other market keeps its raw desc/name/id as the label (only used for
 *  identity pairing + duplicate fingerprinting, never parsed). */
function toMarketsBlockEntries(
  allMarkets: NonNullable<SportyBetOdds["allMarkets"]>
): MarketsBlockEntry[] {
  const out: MarketsBlockEntry[] = [];
  for (const m of allMarkets) {
    const isHeadline1x2 = m.id === "1";
    const market = isHeadline1x2 ? "1X2" : (m.name ?? m.desc ?? m.id);
    for (const o of m.outcomes ?? []) {
      const odds = o.odds != null ? Number(o.odds) : Number.NaN;
      if (!Number.isFinite(odds)) continue;
      const outcome = isHeadline1x2
        ? (({ "1": "home", "2": "draw", "3": "away" } as Record<string, string>)[o.id] ??
          o.desc ??
          o.id)
        : (o.desc ?? o.id);
      out.push({ market, specifier: m.specifier ?? null, outcome, odds });
    }
  }
  return out;
}

/** Gate a daily-batch job list against the v3 slate pre-filter. */
export function prefilterMarketsV3Jobs(
  jobs: FixtureJob[],
  detailByKey: Map<string, SportyBetEventDetail> | undefined,
  gateConfig: MarketsV3GateConfig,
  opts: { completenessV4?: boolean; feedIntegrity?: "off" | "shadow" | "on" } = {}
): SlateGateOutcome {
  try {
    if (!detailByKey?.size) return { jobs, summary: null };
    const feedIntegrityMode = opts.feedIntegrity ?? "on";

    // Pass 1: resolve every mapped job's sidecar detail once (reused by pass
    // 2 below) and, unless the integrity stage is off, flatten its
    // allMarkets block + fixtures-sheet headline 1X2 into the slate-wide
    // maps runFeedIntegrity needs. Includes fixtures the eligibility gate
    // will separately discard as "srl_virtual" — an SRL twin's own block
    // must be visible here for the REAL fixture's twin-pairing check.
    const detailByJob = new Map<FixtureJob, SportyBetEventDetail>();
    const blocksByFixture = new Map<string, MarketsBlockEntry[]>();
    const headlineByFixture = new Map<string, { home?: number; draw?: number; away?: number }>();
    for (const job of jobs) {
      const detail = findSidecarDetail(detailByKey, job.home, job.away);
      if (!detail) continue;
      detailByJob.set(job, detail);
      if (feedIntegrityMode === "off") continue;
      const key = fixtureIntegrityKey(job);
      const am = detail.odds?.allMarkets;
      if (am?.length) blocksByFixture.set(key, toMarketsBlockEntries(am));
      const t = job.state?.telemetry;
      if (t?.hOdds != null || t?.dOdds != null || t?.aOdds != null) {
        headlineByFixture.set(key, { home: t.hOdds, draw: t.dOdds, away: t.aOdds });
      }
    }
    const integrityReport: SlateIntegrityReport | null =
      feedIntegrityMode !== "off" && blocksByFixture.size
        ? runFeedIntegrity(blocksByFixture, headlineByFixture)
        : null;

    // Pass 2: the existing eligibility + completeness gate, now integrity-aware.
    const kept: FixtureJob[] = [];
    const discardCounts: Record<string, number> = {};
    let unmapped = 0;
    let mapped = 0;
    let passed = 0;
    for (const job of jobs) {
      const detail = detailByJob.get(job);
      if (!detail) {
        unmapped += 1;
        kept.push(job);
        continue;
      }
      mapped += 1;

      // [Wave-4 WS-A3] Belt-and-braces guard: selectFixtures.ts's candidate
      // pool already filters to `kickoff > now` at selection time (see its
      // `ko > now.getTime()` check in scoreFixture's caller), so this should
      // be a no-op on the normal daily-batch path. Kept anyway in case a
      // caller feeds jobs into this gate directly (tests, future call
      // sites) or enough wall-clock time elapses between selection and this
      // gate running for a fixture to cross kickoff.
      if (new Date(job.kickoff).getTime() <= Date.now()) {
        discardCounts.already_kicked_off = (discardCounts.already_kicked_off ?? 0) + 1;
        continue;
      }

      if (feedIntegrityMode === "on") {
        const integrity = checkFixtureIntegrity(fixtureIntegrityKey(job), integrityReport);
        if (integrity?.verdict === "contaminated") {
          // [review fix, pre-PR] No headline-only rescue path is implemented
          // anywhere downstream — `headlineOnly` is set on the verdict but no
          // pricing pipeline reads it. Keeping the job "alive" would just let
          // the same contaminated allMarkets block reach the legacy/LLM
          // tail-sweep instead of the v3 gate: the France v Morocco incident
          // wearing a new hat. Discard outright, matching feedIntegrity.ts's
          // own "integrity-class HARD reject" documentation, until a real
          // headline-only rescue path exists.
          discardCounts.contaminated = (discardCounts.contaminated ?? 0) + 1;
          continue;
        }
      }

      const result = gateMarketsV3Fixture(
        {
          home: job.home,
          away: job.away,
          league: job.league,
          marketCount: detail.odds?.allMarkets?.length ?? 0,
          detail,
        },
        gateConfig,
        deriveEnrichment(job, opts.completenessV4)
      );
      if (!result.passes) {
        if (result.discardReason)
          discardCounts[result.discardReason] = (discardCounts[result.discardReason] ?? 0) + 1;
        continue;
      }
      passed += 1;
      let survivor = stampHeightened(job, result.eligibility.status === "heightened");
      if (result.eligibility.marketRestriction === "goals_over_only") {
        survivor = applyMarketRestriction(survivor);
      }
      kept.push(survivor);
    }
    return {
      jobs: kept,
      summary: { total: mapped, passed, discardCounts, unmapped },
      integrityReport,
    };
  } catch {
    return { jobs, summary: null };
  }
}

/** One-line batch log: `gate: N mapped → M survive (K unmapped pass; reason: n, …)`.
 *  [refactor P1-3] Optional second arg appends the v5 Rule 0.14 feed-integrity
 *  tally (` | feed-integrity: N contaminated, M flagged`) when a report is
 *  passed — omitted entirely when absent, so every pre-existing call site
 *  (and its exact expected output) is unaffected. */
export function formatSlateGateLog(
  summary: SlateGateSummary,
  integrityReport?: SlateIntegrityReport | null
): string {
  const reasons = Object.entries(summary.discardCounts)
    .map(([reason, n]) => `${reason}: ${n}`)
    .join(", ");
  const base =
    `gate: ${summary.total} mapped → ${summary.passed} survive ` +
    `(${summary.unmapped} unmapped pass through${reasons ? `; ${reasons}` : ""})`;
  if (!integrityReport) return base;
  return (
    `${base} | feed-integrity: ${integrityReport.contaminatedCount} contaminated, ` +
    `${integrityReport.flaggedCount} flagged`
  );
}
