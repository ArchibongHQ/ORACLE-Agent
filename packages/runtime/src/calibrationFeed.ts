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
 *  BTTS / team totals) are recorded. Corners, cards, Asian handicaps, correct-score
 *  and exotics are skipped+counted (we don't capture their post-match ground truth,
 *  or they need half-win/half-loss handling out of scope this round). */
import type {
  AnalysisRecord,
  BetRecord,
  CalibrationMetrics,
  EVMarket,
  ResolutionRecord,
} from "@oracle/engine";
import { CalibrationEngine } from "@oracle/engine";
import type { StoragePort } from "@oracle/storage";
import { STORAGE_KEYS, withKeyLock } from "@oracle/storage";

/** Default cap on the persisted ledger (ORACLE_LEDGER_MAX). The local PGlite store
 *  rewrites the whole array on every append; an unbounded ledger eventually corrupts
 *  the WASM heap — same rationale as MAX_MANIFEST_HISTORY in analyze.ts. */
export const DEFAULT_LEDGER_MAX = 2000;

type SettleOutcome = "win" | "loss" | "push";

/** "home" if the desc names the home side and not the away side, "away" for the
 *  mirror, else null (draw / ambiguous). Matches sanity.ts::sideOfResultDesc. */
function sideOfDesc(label: string): "home" | "away" | null {
  const home = label.includes("home");
  const away = label.includes("away");
  if (home && !away) return "home";
  if (away && !home) return "away";
  return null;
}

/** "over"/"under" direction from a totals desc, else null. */
function dirOfDesc(label: string): "over" | "under" | null {
  const over = /\bover\b/.test(label) || label.includes("+");
  const under = /\bunder\b/.test(label);
  if (over && !under) return "over";
  if (under && !over) return "under";
  return null;
}

/** First numeric line in the desc ("over 2.5" → 2.5), else null. */
function lineOfDesc(label: string): number | null {
  const m = label.match(/(\d+(?:\.\d+)?)/);
  return m ? Number.parseFloat(m[1]!) : null;
}

/** Double-chance cover set from the desc. Handles word ("Home/Draw", "Home or
 *  Away") and compact ("1X", "12", "X2") forms. Returns null unless it names
 *  exactly two of {home,draw,away} — anything ambiguous is skipped, not guessed. */
function dcCovers(label: string): Set<"home" | "draw" | "away"> | null {
  // DC descs never carry decimal lines, so bare "1"/"x"/"2" presence is
  // unambiguous alongside the word forms ("Home/Draw", "Home or Away").
  const covers = new Set<"home" | "draw" | "away">();
  if (label.includes("home") || label.includes("1")) covers.add("home");
  if (label.includes("draw") || label.includes("x")) covers.add("draw");
  if (label.includes("away") || label.includes("2")) covers.add("away");
  return covers.size === 2 ? covers : null;
}

/** Deterministically settle one pick against the final score. Returns null when
 *  the family/desc can't be settled from the 1x2 score alone (caller skips+logs). */
export function settlePick(
  pick: EVMarket,
  homeGoals: number,
  awayGoals: number
): SettleOutcome | null {
  const label = (pick.label ?? "").toLowerCase();
  const total = homeGoals + awayGoals;
  const actual: "home" | "draw" | "away" =
    homeGoals > awayGoals ? "home" : homeGoals < awayGoals ? "away" : "draw";

  switch (pick.family) {
    case "match_result": {
      if (label.includes("draw") || label.trim() === "x") return actual === "draw" ? "win" : "loss";
      const side = sideOfDesc(label);
      return side ? (actual === side ? "win" : "loss") : null;
    }
    case "double_chance": {
      const covers = dcCovers(label);
      return covers ? (covers.has(actual) ? "win" : "loss") : null;
    }
    case "dnb": {
      const side = sideOfDesc(label);
      if (!side) return null;
      if (actual === "draw") return "push";
      return actual === side ? "win" : "loss";
    }
    case "goals_ou": {
      const dir = dirOfDesc(label);
      const line = lineOfDesc(label);
      if (!dir || line === null) return null;
      if (total === line) return "push";
      const over = total > line;
      return dir === "over" ? (over ? "win" : "loss") : over ? "loss" : "win";
    }
    case "team_total": {
      const side = sideOfDesc(label);
      const dir = dirOfDesc(label);
      const line = lineOfDesc(label);
      if (!side || !dir || line === null) return null;
      const g = side === "home" ? homeGoals : awayGoals;
      if (g === line) return "push";
      const over = g > line;
      return dir === "over" ? (over ? "win" : "loss") : over ? "loss" : "win";
    }
    case "btts": {
      const yes = /\b(yes|gg)\b/.test(label);
      const no = /\b(no|ng)\b/.test(label);
      if (!yes && !no) return null;
      const both = homeGoals > 0 && awayGoals > 0;
      return (yes ? both : !both) ? "win" : "loss";
    }
    default:
      // corners / cards / asian_handicap / correct_score / exotics — not settleable
      // from the final 1x2 score this round.
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
    resolvedAt: res.resolvedAt,
    loggedAt: rec.analysedAt,
  };
}

/** Settle each resolved fixture's top pick and upsert into the calibration ledger
 *  under ONE key lock (read → dedupe-by-id → prune → write). Never per-pick
 *  round-trips. Returns the appended/skipped counts + the post-write metrics. */
export async function appendResolvedToLedger(
  storage: StoragePort,
  resolved: ResolutionRecord[],
  dayRecords: AnalysisRecord[],
  opts: { maxLedger?: number } = {}
): Promise<{ appended: number; skipped: number; metrics: CalibrationMetrics }> {
  const maxLedger = opts.maxLedger ?? DEFAULT_LEDGER_MAX;
  const byFixture = new Map(dayRecords.map((r) => [r.fixtureId, r]));
  const settled: BetRecord[] = [];
  let skipped = 0;
  for (const res of resolved) {
    const rec = byFixture.get(res.fixtureId);
    const bet = rec ? toBetRecord(rec, res) : null;
    if (bet) settled.push(bet);
    else skipped++;
  }

  const engine = new CalibrationEngine(storage);
  if (settled.length === 0) {
    const existing = (await storage.get<BetRecord[]>(STORAGE_KEYS.calibrationLedger)) ?? [];
    return { appended: 0, skipped, metrics: engine.calculate(existing) };
  }

  const metrics = await withKeyLock(STORAGE_KEYS.calibrationLedger, async () => {
    const existing = (await storage.get<BetRecord[]>(STORAGE_KEYS.calibrationLedger)) ?? [];
    const byId = new Map<string, BetRecord>(existing.map((b) => [b.id ?? "", b]));
    for (const b of settled) byId.set(b.id!, b);
    const merged = Array.from(byId.values()).slice(-maxLedger);
    await storage.set(STORAGE_KEYS.calibrationLedger, merged);
    return engine.calculate(merged);
  });
  return { appended: settled.length, skipped, metrics };
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
