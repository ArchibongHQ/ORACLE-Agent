/** PR-7 — calibration feedback loop write side.
 *
 *  Revives the dead `oracle_v2026_ledger`: after a day's fixtures resolve, settle
 *  each fixture's deterministic top pick against the final score and append the
 *  outcome to the calibration ledger. That ledger is what the engine's dormant
 *  `calibFactor` + isotonic 1x2 calibration read back (execution/index.ts:1709/1813),
 *  so without this write side those code paths were permanently no-ops.
 *
 *  Settlement is deterministic and family-scoped — only families we can settle
 *  purely from the final 1x2 score (match result / double chance / DNB / goals O/U /
 *  BTTS / team totals / correct score) are recorded. Corners, cards, Asian
 *  handicaps, half-scoped markets, and exotics are skipped+counted:
 *    - corners/cards need counts ResolutionRecord doesn't capture at all.
 *    - half-scoped markets need the half-time score, which ResolutionRecord
 *      doesn't carry either.
 *    - asian_handicap (audit fix, investigated but NOT closed): the price
 *      math is purely a function of (homeGoals, awayGoals) too — same as the
 *      settled families — but the handicap LINE isn't reliably recoverable
 *      at settlement time. engines/result.ts's parseAsianDesc reads the line
 *      from the outcome desc text ("Home (-0.5)") when present, but falls
 *      back to route.hcpNum — the market SPECIFIER — for bare "home"/"away"
 *      descs (feedDictionary.ts:231-238), and hcpNum is never persisted onto
 *      EVMarket/BetRecord. Settling only the desc-recoverable subset would
 *      silently bias the ledger toward whichever fraction of SportyBet's AH
 *      descs happen to embed the line — worse than a visible, honest skip.
 *      Closing this for real needs hcpNum/hcpScore threaded onto the stored
 *      pick at analysis time, a separate change to a size-capped hot path.
 *  `appendResolvedToLedger`'s per-family skip/settle breakdown (not just an
 *  aggregate count) makes this an explicit, auditable subset rather than a
 *  silent one — see its docstring. */
import type {
  AnalysisRecord,
  BetRecord,
  CalibrationMetrics,
  EVMarket,
  ResolutionRecord,
} from "@oracle/engine";
import { CalibrationEngine, dcCovers, dirOfDesc, lineOfDesc, sideOfDesc } from "@oracle/engine";
import type { StoragePort } from "@oracle/storage";
import { STORAGE_KEYS, withKeyLock } from "@oracle/storage";

/** Default cap on the persisted ledger (ORACLE_LEDGER_MAX). The local PGlite store
 *  rewrites the whole array on every append; an unbounded ledger eventually corrupts
 *  the WASM heap — same rationale as MAX_MANIFEST_HISTORY in analyze.ts. */
export const DEFAULT_LEDGER_MAX = 2000;

type SettleOutcome = "win" | "loss" | "push";

/** The clean, single-outcome desc to settle from. Every EVMarket producer
 *  (execution/index.ts's per-family scanMarkets BLOCKs, its "AllMarkets Scan"
 *  catch-all, and marketsV3/analyzeFixtureMarkets.ts) sets `side` to the bare
 *  outcome text (e.g. "Draw or Away"); only `label` can be a composited
 *  display string (execution/index.ts's AllMarkets Scan path builds
 *  `${marketName} — ${outcome.desc}`, and the market catalog has entries like
 *  "Double Chance - 1UP" whose digits would otherwise contaminate parsing —
 *  see descParse.ts). Prefer `side`; fall back to `label` when absent. */
function settleDesc(pick: EVMarket): string {
  return (pick.side ?? pick.label ?? "").toLowerCase();
}

/** Deterministically settle one pick against the final score. Returns null when
 *  the family/desc can't be settled from the 1x2 score alone (caller skips+logs). */
export function settlePick(
  pick: EVMarket,
  homeGoals: number,
  awayGoals: number
): SettleOutcome | null {
  const desc = settleDesc(pick);
  const total = homeGoals + awayGoals;
  const actual: "home" | "draw" | "away" =
    homeGoals > awayGoals ? "home" : homeGoals < awayGoals ? "away" : "draw";

  switch (pick.family) {
    case "match_result": {
      if (desc.includes("draw") || desc.trim() === "x") return actual === "draw" ? "win" : "loss";
      const side = sideOfDesc(desc);
      return side ? (actual === side ? "win" : "loss") : null;
    }
    case "double_chance": {
      const covers = dcCovers(desc);
      return covers ? (covers.has(actual) ? "win" : "loss") : null;
    }
    case "dnb": {
      const side = sideOfDesc(desc);
      if (!side) return null;
      if (actual === "draw") return "push";
      return actual === side ? "win" : "loss";
    }
    case "goals_ou": {
      const dir = dirOfDesc(desc);
      const line = lineOfDesc(desc);
      if (!dir || line === null) return null;
      if (total === line) return "push";
      const over = total > line;
      return dir === "over" ? (over ? "win" : "loss") : over ? "loss" : "win";
    }
    case "team_total": {
      const side = sideOfDesc(desc);
      const dir = dirOfDesc(desc);
      const line = lineOfDesc(desc);
      if (!side || !dir || line === null) return null;
      const g = side === "home" ? homeGoals : awayGoals;
      if (g === line) return "push";
      const over = g > line;
      return dir === "over" ? (over ? "win" : "loss") : over ? "loss" : "win";
    }
    case "btts": {
      const yes = /\b(yes|gg)\b/.test(desc);
      const no = /\b(no|ng)\b/.test(desc);
      if (!yes && !no) return null;
      const both = homeGoals > 0 && awayGoals > 0;
      return (yes ? both : !both) ? "win" : "loss";
    }
    case "correct_score": {
      // Same regex as engines/exotics.ts's priceCorrectScore — the only desc
      // shape that ever reaches a live pick (no "any other score" catch-all
      // is priced), so no other format needs handling here.
      const m = desc.match(/^(\d+)\s*[-:]\s*(\d+)$/);
      if (!m) return null;
      const h = Number.parseInt(m[1]!, 10);
      const a = Number.parseInt(m[2]!, 10);
      return h === homeGoals && a === awayGoals ? "win" : "loss";
    }
    default:
      // corners / cards / asian_handicap / half / exotics — not settleable
      // from the final 1x2 score this round; see the file header for why
      // each specific family stays unsettled (data gap vs. line-recoverability
      // gap are different reasons, not one blanket "no data" bucket).
      return null;
  }
}

/** Build a resolved BetRecord from an analysis record + its resolution, or null
 *  when the pick's family can't be settled. `id = analysisId` makes re-resolving
 *  the same fixture idempotent (upsert, never duplicate). */
function toBetRecord(rec: AnalysisRecord, res: ResolutionRecord): BetRecord | null {
  const pick = rec.deterministicTopPick;
  if (!pick) return null;
  const outcome = settlePick(pick, res.homeGoals, res.awayGoals);
  if (!outcome) return null;
  const clv = res.realisedCLV ?? null;
  return {
    id: rec.analysisId,
    status: "resolved",
    home: rec.home,
    away: rec.away,
    league: rec.league,
    mp: pick.mp,
    odds: pick.odds,
    outcome,
    homeGoals: res.homeGoals,
    awayGoals: res.awayGoals,
    closingOdds: clv != null && pick.odds ? pick.odds / (1 + clv) : undefined,
    clv,
    fp: {
      home: rec.probabilities.home,
      draw: rec.probabilities.draw,
      away: rec.probabilities.away,
    },
    marketType: pick.cat,
    family: pick.family,
    resolvedAt: res.resolvedAt,
    loggedAt: rec.analysedAt,
  };
}

/** Per-family settle/skip counts from one appendResolvedToLedger call — makes
 *  a ledger that's silently settling only a biased subset of families visible
 *  (e.g. "half: 0 settled, 12 skipped" every single day) instead of looking
 *  identical to a healthy ledger behind one aggregate `skipped` number. */
export type SettlementFamilyBreakdown = Record<string, { settled: number; skipped: number }>;

/** Settle each resolved fixture's top pick and upsert into the calibration ledger
 *  under ONE key lock (read → dedupe-by-id → prune → write). Never per-pick
 *  round-trips. Returns the appended/skipped counts (+ per-family breakdown)
 *  and the post-write metrics. */
export async function appendResolvedToLedger(
  storage: StoragePort,
  resolved: ResolutionRecord[],
  dayRecords: AnalysisRecord[],
  opts: { maxLedger?: number } = {}
): Promise<{
  appended: number;
  skipped: number;
  byFamily: SettlementFamilyBreakdown;
  metrics: CalibrationMetrics;
}> {
  const maxLedger = opts.maxLedger ?? DEFAULT_LEDGER_MAX;
  const byFixture = new Map(dayRecords.map((r) => [r.fixtureId, r]));
  const settled: BetRecord[] = [];
  let skipped = 0;
  const byFamily: SettlementFamilyBreakdown = {};
  const bump = (family: string | undefined, key: "settled" | "skipped") => {
    const fam = family ?? "unknown";
    byFamily[fam] ??= { settled: 0, skipped: 0 };
    byFamily[fam][key]++;
  };
  for (const res of resolved) {
    const rec = byFixture.get(res.fixtureId);
    const bet = rec ? toBetRecord(rec, res) : null;
    if (bet) {
      settled.push(bet);
      bump(bet.family, "settled");
    } else {
      skipped++;
      bump(rec?.deterministicTopPick?.family, "skipped");
    }
  }

  const engine = new CalibrationEngine(storage);
  if (settled.length === 0) {
    const existing = (await storage.get<BetRecord[]>(STORAGE_KEYS.calibrationLedger)) ?? [];
    return { appended: 0, skipped, byFamily, metrics: engine.calculate(existing) };
  }

  const metrics = await withKeyLock(STORAGE_KEYS.calibrationLedger, async () => {
    const existing = (await storage.get<BetRecord[]>(STORAGE_KEYS.calibrationLedger)) ?? [];
    const byId = new Map<string, BetRecord>(existing.map((b) => [b.id ?? "", b]));
    for (const b of settled) byId.set(b.id!, b);
    const merged = Array.from(byId.values()).slice(-maxLedger);
    await storage.set(STORAGE_KEYS.calibrationLedger, merged);
    return engine.calculate(merged);
  });
  return { appended: settled.length, skipped, byFamily, metrics };
}

/** Read side: load the ledger once and compute its metrics. Fail-open — a missing,
 *  corrupt, or non-array ledger returns null so the engine keeps calibFactor=1.0
 *  and the run continues (PR-7 hard constraint). */
export async function loadLedgerState(
  storage: StoragePort
): Promise<{ bets: BetRecord[]; metrics: CalibrationMetrics } | null> {
  try {
    const bets = await storage.get<BetRecord[]>(STORAGE_KEYS.calibrationLedger);
    if (!Array.isArray(bets)) return null;
    return { bets, metrics: new CalibrationEngine(storage).calculate(bets) };
  } catch {
    return null;
  }
}

/** One-line human-readable metrics block for the resolve report / Telegram. */
export function formatCalibrationMetrics(m: CalibrationMetrics): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const num = (x: number | null, dp = 4) => (x != null ? x.toFixed(dp) : "n/a");
  return [
    `n=${m.resolvedCount}`,
    `hit=${pct(m.winRate)}`,
    `Brier=${num(m.brier)}`,
    `ECE=${num(m.ece)}`,
    `logLoss=${num(m.logLoss)}`,
    `CLV=${pct(m.clv)}`,
    `calibFactor=${m.calibFactor.toFixed(3)}`,
  ].join(" · ");
}

/** One-line per-family settle/skip breakdown for the resolve report — makes a
 *  ledger that's silently biased toward 1x2-derivable families visible in the
 *  same place calibration metrics already surface. Omits families with zero
 *  activity; returns null when nothing settled or skipped this run. */
export function formatSettlementBreakdown(byFamily: SettlementFamilyBreakdown): string | null {
  const families = Object.keys(byFamily).sort();
  if (families.length === 0) return null;
  const parts = families.map((f) => {
    const { settled, skipped } = byFamily[f]!;
    return `${f}=${settled}/${settled + skipped}`;
  });
  return `Settlement by family (settled/total): ${parts.join(", ")}`;
}
