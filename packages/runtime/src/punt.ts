/** Punt-analysis core: turn a loaded SportyBet slip into analyzable jobs, then decide,
 *  per leg, whether to keep the punter's pick or replace it with ORACLE's stronger thesis.
 *  Policy (locked): replace pick / keep fixture. Never drop a fixture. Pure functions only —
 *  no Playwright, no I/O beyond fetchFixtureByName (which is cache-first). */

import type { LoadedSlip, RawLeg } from "@oracle/booking";
import type { BatchJobResult, BatchResult, FixtureJob, PickRef } from "@oracle/engine";
import type { ActionablePick } from "@oracle/notify";
import { fetchFixtureByName } from "./fixtures.js";

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

/** Resolve each raw leg to a FixtureJob (cache-first via fetchFixtureByName).
 *  job === null marks a no-coverage pass-through leg. */
export async function loadedSlipToJobs(
  slip: LoadedSlip,
  deps: { oddsApiKey: string | undefined }
): Promise<PuntLeg[]> {
  const out: PuntLeg[] = [];
  for (const raw of slip.legs) {
    let job: FixtureJob | null = null;
    try {
      job = await fetchFixtureByName(raw.home, raw.away, deps.oddsApiKey, raw.league || undefined);
    } catch {
      job = null;
    }
    out.push({ raw, job });
  }
  return out;
}

// ── Step 3: counter-slip decision ────────────────────────────────────────────────

/** ORACLE's actionable pick for a given fixture, if the batch produced one (not NO_BET). */
function findActionable(
  batch: BatchResult,
  home: string,
  away: string
): { pick: PickRef; confidence: number } | null {
  for (const j of batch.jobs as BatchJobResult[]) {
    if (j.status !== "ok") continue;
    if (!nameMatches(j.home, home) || !nameMatches(j.away, away)) continue;
    const p = j.decision.primaryPick;
    if (p === "NO_BET") return null;
    return { pick: p as PickRef, confidence: j.decision.confidence };
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

    // ORACLE has no actionable edge (NO_BET) — keep his pick.
    if (!oracle) {
      return {
        raw,
        verdict: "KEPT_LOW_CONVICTION",
        pick: pickFromRaw(raw),
        oracleConfidence: null,
        note: "ORACLE returned NO_BET on this fixture",
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
      };
    }

    // ORACLE disagrees: replace only if its confidence clears the punter's implied edge by the margin.
    const hisImplied = impliedConfidence(raw.odds);
    if (oracle.confidence - hisImplied >= ADJUST_MIN_CONFIDENCE_DELTA) {
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

    // ORACLE disagrees but not strongly enough — keep his pick.
    return {
      raw,
      verdict: "KEPT_LOW_CONVICTION",
      pick: pickFromRaw(raw, oracle.confidence),
      oracleConfidence: oracle.confidence,
      note: `ORACLE edge ${(oracle.confidence - hisImplied).toFixed(3)} below ${ADJUST_MIN_CONFIDENCE_DELTA} threshold`,
    };
  });
}
