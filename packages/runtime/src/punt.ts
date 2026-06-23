/** Punt-analysis core: turn a loaded SportyBet slip into analyzable jobs, then decide,
 *  per leg, whether to keep the punter's pick or replace it with ORACLE's stronger thesis.
 *  Policy (locked): replace pick / keep fixture. Never drop a fixture. Pure functions only —
 *  no Playwright, no I/O beyond fetchFixtureByName (which is cache-first). */

import type { LoadedSlip, RawLeg } from "@oracle/booking";
import type { BatchJobResult, BatchResult, FixtureJob, PickRef } from "@oracle/engine";
import type { ActionablePick } from "@oracle/notify";
import type { StoragePort } from "@oracle/storage";
import { fetchFixtureByName, geminiOddsGapFill } from "./fixtures.js";
import { enrichWithH2H } from "./h2h.js";
import { enrichWithLineups } from "./lineups.js";
import { enrichWithNewsIntel } from "./newsIntel.js";
import type { SportyBetEventDetail } from "./selectFixtures.js";
import { loadSportyBetIndex, sidecarKey } from "./selectFixtures.js";
import { flattenSidecarOdds } from "./sidecarOdds.js";

/** Minimum confidence margin by which ORACLE must beat the punter's implied edge to override
 *  his pick. Tunable in one place. 0.05 = ORACLE needs ≥5 pts more model confidence. */
export const ADJUST_MIN_CONFIDENCE_DELTA = 0.05;

export type LegVerdict =
  | "ADJUSTED" // ORACLE replaced his market/side (stronger thesis)
  | "CONFIRMED" // ORACLE agrees with his market/side
  | "KEPT_LOW_CONVICTION" // ORACLE has no/weaker edge — his pick kept
  | "NO_COVERAGE"; // fixture couldn't be resolved/modelled — his pick kept

export interface PuntLeg {
  raw: RawLeg;
  job: FixtureJob | null; // null ⇒ no coverage ⇒ pass-through
}

export interface CounterLeg {
  raw: RawLeg;
  verdict: LegVerdict;
  /** The selection that goes into the output booking code (his pick, or ORACLE's). */
  pick: ActionablePick;
  /** ORACLE's confidence in the chosen selection (0–1), when known. */
  oracleConfidence: number | null;
  note?: string;
}

// ── SportyBet raw market/outcome → ORACLE market category + side ────────────────
// Inverse of apps/booking/src/marketMap.ts; lets a punter leg become an ActionablePick
// that bookAccumulator can rebook unchanged when we keep his pick.

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.\s+-]/g, "")
    .trim();
}

/** Map a punter's raw SportyBet leg to an ORACLE (market, side) pair. Best-effort. */
export function rawLegToMarketSide(raw: RawLeg): { market: string; side: string | null } {
  const m = normalise(raw.marketDesc);
  const o = normalise(raw.outcomeDesc);

  // Over/Under (Total goals)
  if (m.includes("total") || m.includes("over") || m.includes("under") || /o\/u/.test(m)) {
    const line = o.match(/([\d.]+)/)?.[1] ?? "2.5";
    if (o.includes("over") || o.startsWith("o"))
      return { market: "Goals O/U", side: `Over ${line}` };
    if (o.includes("under") || o.startsWith("u"))
      return { market: "Goals O/U", side: `Under ${line}` };
  }
  // Both Teams To Score
  if (m.includes("both teams") || m.includes("btts") || m.includes("gg/ng")) {
    if (o.includes("yes") || o.includes("gg")) return { market: "BTTS", side: "Yes" };
    if (o.includes("no") || o.includes("ng")) return { market: "BTTS", side: "No" };
  }
  // Double Chance
  if (m.includes("double chance")) {
    if (o.includes("1x") || (o.includes("home") && o.includes("draw")))
      return { market: "Double Chance", side: "1X" };
    if (o.includes("x2") || (o.includes("away") && o.includes("draw")))
      return { market: "Double Chance", side: "X2" };
    if (o.includes("12") || (o.includes("home") && o.includes("away")))
      return { market: "Double Chance", side: "12" };
  }
  // Draw No Bet
  if (m.includes("draw no bet") || m.includes("dnb")) {
    if (o.includes("home") || o === "1") return { market: "Draw No Bet", side: "Home" };
    if (o.includes("away") || o === "2") return { market: "Draw No Bet", side: "Away" };
  }
  // Asian Handicap
  if (m.includes("handicap") || m.includes("asian") || /\bah\b/.test(m)) {
    const line = o.match(/([+-]?[\d.]+)/)?.[1] ?? "0";
    if (o.includes("home") || o.startsWith("1"))
      return { market: "Asian Handicap", side: `Home ${line}` };
    if (o.includes("away") || o.startsWith("2"))
      return { market: "Asian Handicap", side: `Away ${line}` };
  }
  // Default: 1X2 / Match Result
  if (o === "1" || o.includes("home")) return { market: "1X2", side: "Home Win" };
  if (o === "x" || o.includes("draw")) return { market: "1X2", side: "Draw" };
  if (o === "2" || o.includes("away")) return { market: "1X2", side: "Away Win" };
  return { market: raw.marketDesc || "1X2", side: raw.outcomeDesc || null };
}

/** Build an ActionablePick from the punter's own raw leg (used when we keep his pick). */
function pickFromRaw(raw: RawLeg, confidence = 0): ActionablePick {
  const { market, side } = rawLegToMarketSide(raw);
  return {
    home: raw.home,
    away: raw.away,
    league: raw.league,
    kickoff: "",
    market,
    side,
    odds: raw.odds,
    stakePct: 0,
    confidence,
  };
}

// ── Leg matching ────────────────────────────────────────────────────────────────

/** Loose team-name match (substring on the longer words), order-independent. */
function nameMatches(a: string, b: string): boolean {
  const wa = normalise(a)
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const wb = normalise(b)
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (!wa.length || !wb.length) return normalise(a) === normalise(b);
  return wa.some((w) => wb.some((x) => x.includes(w) || w.includes(x)));
}

// ── Step 2: raw legs → analyzable jobs ───────────────────────────────────────────

/** Build a minimal FixtureJob from a SportyBet sidecar event when the odds-api
 *  has no coverage for the fixture. Uses flattenSidecarOdds() to translate ALL
 *  sidecar markets (1x2, OU1.5/2.5/3.5, BTTS, DC, DNB, AH) into the flat key
 *  map scanMarkets() reads so EV > 0 candidates exist beyond just 1x2. */
function jobFromSidecar(
  raw: RawLeg,
  detail: SportyBetEventDetail,
  kickoff: string,
  league: string
): FixtureJob {
  const flat = flattenSidecarOdds(detail);
  const hasOdds = flat.home !== undefined && flat.away !== undefined;

  return {
    home: raw.home,
    away: raw.away,
    league,
    kickoff,
    state: {
      pipeline: {
        fetched: {
          ...(hasOdds ? { odds: flat } : {}),
          sportyBetStats: detail.stats,
          sportyBetOdds: detail.odds,
          sportyBetStatsCoverage: detail.statscoverage,
        },
      },
    },
  };
}

/** Resolve each raw leg to a FixtureJob (cache-first via fetchFixtureByName).
 *  Falls back to a sidecar-constructed job when the odds-api has no coverage,
 *  so every leg the punter selected gets analysed — not silently dropped.
 *  Final fallback: Gemini gap-fill for legs still null after sidecar (Fix #7).
 *  Also merges sidecar stats into odds-api jobs so the engine has Stage-2/3
 *  context for every leg it analyses.
 *  job === null only when neither the odds-api, sidecar, nor Gemini covers the fixture. */
export async function loadedSlipToJobs(
  slip: LoadedSlip,
  deps: {
    oddsApiKey: string | undefined;
    geminiApiKey?: string | undefined;
    footballDataApiKey?: string | undefined;
    perplexityApiKey?: string | undefined;
    storage?: StoragePort | undefined;
  }
): Promise<PuntLeg[]> {
  const today = new Date().toISOString().slice(0, 10);
  const sidecar = await loadSportyBetIndex(today);

  const out: PuntLeg[] = [];
  for (const raw of slip.legs) {
    let job: FixtureJob | null = null;
    try {
      job = await fetchFixtureByName(
        raw.home,
        raw.away,
        deps.oddsApiKey,
        raw.league || undefined,
        deps.geminiApiKey
      );
    } catch {
      job = null;
    }

    // When the odds-api missed, fall back to a job built from the sidecar so no
    // fixture is silently dropped — the sidecar has team names, league, kickoff,
    // and Sportradar stats for every event SportyBet lists today.
    if (!job && sidecar) {
      const key = sidecarKey(raw.home, raw.away);
      const detail = sidecar.detailByKey.get(key);
      if (!detail) {
        // Try namesMatch fallback for fuzzy team-name variants
        const ev = sidecar.events.find(
          (e) => nameMatches(e.home, raw.home) && nameMatches(e.away, raw.away)
        );
        if (ev?.detail) {
          job = jobFromSidecar(
            raw,
            ev.detail,
            ev.kickoff_utc ?? `${today}T12:00:00Z`,
            ev.league ?? raw.league ?? "Unknown"
          );
        }
      } else {
        const ev = sidecar.events.find((e) => sidecarKey(e.home, e.away) === key);
        job = jobFromSidecar(
          raw,
          detail,
          ev?.kickoff_utc ?? `${today}T12:00:00Z`,
          ev?.league ?? raw.league ?? "Unknown"
        );
      }
    }

    // Fix #7: Gemini gap-fill for legs still null after odds-api + sidecar.
    // Tries the structured provider chain first (same as batch gap-fill), then
    // Gemini Search prose. Marks the leg resolved so it gets analysed rather than
    // passing through as NO_COVERAGE.
    if (!job && deps.geminiApiKey) {
      try {
        const league = raw.league || "FIFA World Cup";
        const kickoff = `${today}T12:00:00Z`;
        const filled = await geminiOddsGapFill(
          [{ home: raw.home, away: raw.away, league, kickoff }],
          deps.geminiApiKey
        );
        if (filled.length) job = filled[0]!;
      } catch {
        // gap-fill is non-fatal
      }
    }

    // Enrich each resolved job with H2H, news intelligence, and confirmed lineups.
    // NOTE: geminiApiKey is deliberately NOT passed to enrichWithNewsIntel here.
    // The Gemini path triggers a per-leg Google AI-Mode Playwright scrape (~28s
    // each, browsers pile up) which made /punt take 15-30 min on a multi-leg
    // code. A punt is an odds-driven counter-booking sourced from the SportyBet
    // sidecar — it doesn't need per-leg news scraping. Perplexity (a fast API,
    // when its key is set) still enriches; absent that key, newsIntel no-ops.
    if (job) {
      try {
        [job] = await enrichWithH2H([job], deps.footballDataApiKey);
        [job] = await enrichWithNewsIntel([job], {
          perplexityApiKey: deps.perplexityApiKey,
          storage: deps.storage,
        });
        [job] = await enrichWithLineups([job]);
      } catch {
        // enrichment is non-fatal — job falls through with whatever partial state it has
      }
    }

    // Merge sidecar stats into odds-api jobs (sidecar-constructed jobs already
    // carry this in pipeline.fetched from jobFromSidecar).
    if (job && sidecar) {
      const key = sidecarKey(raw.home, raw.away);
      const detail = sidecar.detailByKey.get(key);
      if (detail && !job.state?.pipeline?.fetched?.sportyBetStats) {
        const existing = (job.state?.pipeline?.fetched ?? {}) as Record<string, unknown>;
        job = {
          ...job,
          state: {
            ...job.state,
            pipeline: {
              ...job.state?.pipeline,
              fetched: {
                ...existing,
                sportyBetStats: detail.stats,
                sportyBetOdds: detail.odds,
                sportyBetStatsCoverage: detail.statscoverage,
              },
            },
          },
        };
      }
    }

    out.push({ raw, job });
  }
  return out;
}

// ── Step 3: counter-slip decision ────────────────────────────────────────────────

/** ORACLE's best pick for a given fixture from the batch.
 *  Returns the primaryPick regardless of grade — the engine always emits one
 *  (even NO_EDGE jobs carry a best-market pick). The confidence delta in
 *  counterSlip decides whether to override the punter's selection. */
function findActionable(
  batch: BatchResult,
  home: string,
  away: string
): { pick: PickRef; confidence: number; grade: string } | null {
  for (const j of batch.jobs as BatchJobResult[]) {
    if (j.status !== "ok") continue;
    if (!nameMatches(j.home, home) || !nameMatches(j.away, away)) continue;
    return {
      pick: j.decision.primaryPick,
      confidence: j.decision.confidence,
      grade: j.decision.grade,
    };
  }
  return null;
}

/** Implied confidence of the punter's pick from his decimal odds (devig-free proxy: 1/odds). */
function impliedConfidence(odds: number): number {
  return odds > 1 ? 1 / odds : 0;
}

/** Decide, per leg, whether to keep the punter's pick or replace it with ORACLE's.
 *  His fixture is ALWAYS kept (policy: replace pick / keep fixture). */
export function counterSlip(legs: PuntLeg[], batch: BatchResult): CounterLeg[] {
  return legs.map((leg): CounterLeg => {
    const { raw } = leg;

    // No coverage — fixture unresolved or unmodelled. Keep his pick.
    if (!leg.job) {
      return {
        raw,
        verdict: "NO_COVERAGE",
        pick: pickFromRaw(raw),
        oracleConfidence: null,
        note: "fixture not resolved on ORACLE coverage",
      };
    }

    const oracle = findActionable(batch, raw.home, raw.away);
    const his = rawLegToMarketSide(raw);

    // Batch ran but this fixture produced no result row (engine error, not NO_EDGE).
    if (!oracle) {
      return {
        raw,
        verdict: "KEPT_LOW_CONVICTION",
        pick: pickFromRaw(raw),
        oracleConfidence: null,
        note: "fixture not found in batch output",
      };
    }

    const sameMarket = normalise(oracle.pick.market) === normalise(his.market);
    const sameSide = normalise(oracle.pick.side ?? "") === normalise(his.side ?? "");

    // ORACLE agrees with his selection — confirm, keep his odds.
    if (sameMarket && sameSide) {
      return {
        raw,
        verdict: "CONFIRMED",
        pick: { ...pickFromRaw(raw, oracle.confidence) },
        oracleConfidence: oracle.confidence,
        note:
          oracle.grade === "NO_EDGE"
            ? "ORACLE best pick matches (no positive EV)"
            : oracle.grade === "MISSING_DATA"
              ? "ORACLE best pick matches (arbiter flagged missing data)"
              : undefined,
      };
    }

    // ORACLE disagrees: replace if its confidence clears the punter's implied edge by the margin,
    // AND the grade is not NO_EDGE/MISSING_DATA (we never force-swap onto a negative-EV or
    // unverified ORACLE pick).
    const hisImplied = impliedConfidence(raw.odds);
    if (
      oracle.grade !== "NO_EDGE" &&
      oracle.grade !== "MISSING_DATA" &&
      oracle.confidence - hisImplied >= ADJUST_MIN_CONFIDENCE_DELTA
    ) {
      const adjusted: ActionablePick = {
        home: raw.home,
        away: raw.away,
        league: raw.league,
        kickoff: "",
        market: oracle.pick.market,
        side: oracle.pick.side ?? null,
        odds: oracle.pick.odds,
        stakePct: (oracle.pick.stake ?? 0) * 100,
        confidence: oracle.confidence,
      };
      return {
        raw,
        verdict: "ADJUSTED",
        pick: adjusted,
        oracleConfidence: oracle.confidence,
        note: `swapped ${his.market}/${his.side ?? "-"} → ${oracle.pick.market}/${oracle.pick.side ?? "-"}`,
      };
    }

    // ORACLE disagrees but not strongly enough, or grade is NO_EDGE — keep his pick.
    return {
      raw,
      verdict: "KEPT_LOW_CONVICTION",
      pick: pickFromRaw(raw, oracle.confidence),
      oracleConfidence: oracle.confidence,
      note:
        oracle.grade === "NO_EDGE"
          ? `ORACLE grade NO_EDGE on this fixture — punter's pick kept`
          : oracle.grade === "MISSING_DATA"
            ? `ORACLE arbiter flagged MISSING_DATA on this fixture — punter's pick kept`
            : `ORACLE edge ${(oracle.confidence - hisImplied).toFixed(3)} below ${ADJUST_MIN_CONFIDENCE_DELTA} threshold`,
    };
  });
}
