/** CalibrationEngine — ported from ORACLE_v2026_8_0.jsx §5, lines 1377-1572.
 *  Rewrite #1: _safeStorage → StoragePort. MathEngine imported for safeNum/clamp/rps. */
import type { StoragePort } from "@oracle/storage";
import { STORAGE_KEYS, withKeyLock } from "@oracle/storage";
import type { MarketFamily } from "../markets/index.js";
import { clamp, estimateDynamicRho, rankedProbabilityScore, safeNum } from "../math/index.js";
import type { ClvSourceQuality, LiquidityTag } from "../types.js";

export interface CalibrationMetrics {
  brier: number;
  recentBrier: number;
  rps: number | null;
  recentRPS: number | null;
  logLoss: number | null;
  ece: number | null;
  clv: number;
  roi: number;
  calibFactor: number;
  leagueData: Record<string, unknown>;
  /** [Wave 2, WS2-A] Per-(league,family)-segment calibFactor — two-level
   *  hierarchical shrinkage: a segment's own {wins,pSum} (post-epoch bets only,
   *  see BetRecord.epoch) shrinks toward the league's already-shrunk factor
   *  (leagueData._leagueCalibFactors, itself shrunk toward the global
   *  `calibFactor` above) — segment leans on league which leans on global.
   *  `accepted` gates whether a caller may trust this segment's own factor —
   *  false when the segment has fewer than SIGNIFICANCE_MIN_N resolved bets;
   *  `makeCalibFactorResolver` falls back to league/global when false. Keyed
   *  by `segmentKey(league, family)`. */
  segmentCalibFactors: Record<
    string,
    { calibFactor: number; shrinkage: number; n: number; accepted: boolean }
  >;
  /** [Wave 3, WS3-D] CLV headline — per-(league,family)-segment mean sharp-reference
   *  CLV (BetRecord.sharpClv; see that field's doc comment for why it's distinct
   *  from the older global `clv` above), keyed by the same `segmentKey(league,
   *  family)` as `segmentCalibFactors`, over the SAME post-epoch population
   *  (`epoch >= epochStart`) so the two aggregates describe the same underlying bet
   *  set. `coverage` is the fraction of that segment's resolved, post-epoch bets
   *  that actually carry a `sharpClv` value (not undefined/null) — WS2-C's own
   *  un-zero-weight criterion for S02–S05 is "≥95% coverage over 7 consecutive
   *  slates," so this is the metric that criterion reads. `clv` is the mean over
   *  only the covered bets (null when coverage is 0 — never divide by zero, never
   *  silently report 0 as if it were a real zero-CLV result). `n` is the segment's
   *  total resolved post-epoch bet count (covered + uncovered), matching
   *  `segmentCalibFactors[key].n` — so a caller can always recover
   *  `covered = round(n * coverage)`. */
  segmentClv: Record<string, { clv: number | null; n: number; coverage: number }>;
  /** §8.3 hierarchical bbnParams: each entry carries shrinkage weight and sample count
   *  so callers know how much data backs the estimate. */
  bbnParams: Record<string, { homeAvg: number; awayAvg: number; shrinkage: number; n: number }>;
  driftAlert: boolean;
  resolvedCount: number;
  winRate: number;
  totalPnl: number;
  totalStaked: number;
  dynamicRhoParams: Record<string, number>;
  clvDecayCalibration: Record<string, unknown>;
  ruinProb: number;
  ahAccuracy: Record<string, Record<string, number>>;
  zipCoeffs: null;
}

export interface BetRecord {
  id?: string;
  status?: "pending" | "resolved";
  home?: string;
  away?: string;
  league?: string;
  /** Model's raw/uncalibrated win probability at pick time. NOTE: this field IS
   *  `raw_p` for this ledger — `mp` has always been the pre-calibration model
   *  probability settlement/Brier/log-loss compute against (see `calculate()`'s
   *  `wins/pSum` and `((b.mp ?? 0) - a) ** 2` uses below). A separate `raw_p`
   *  field would be a pure duplicate; don't add one. */
  mp?: number;
  odds?: number;
  stakeAmt?: number;
  /** [Wave 2, WS2-A] Probability actually used for staking after calibration
   *  (post per-segment/per-league/global adjustment via
   *  `makeCalibFactorResolver`). Distinct from `mp` (the pre-calibration
   *  model probability) — optional/advisory, not yet read by `calculate()`. */
  calib_p?: number;
  /** [Wave 2, WS2-A] `segmentKey(league, family)` computed at settlement time
   *  (calibrationFeed.ts's toBetRecord) — lets `calculate()` accumulate
   *  per-segment {n, wins, pSum} without recomputing the key from
   *  league+family on every read. */
  segmentKey?: string;
  /** [Wave 2, WS2-A] ISO date (YYYY-MM-DD) the pick was DECIDED (not resolved)
   *  — stamped from the source AnalysisRecord's `analysedAt`. Segment
   *  accumulation only counts bets with `epoch >= epochStart` (calculate()'s
   *  param); pre-epoch records reflect the OLD pre-P0-2/P0-3 pricing and would
   *  poison segment factors if mixed in. See OracleConfig.calibrationEpochStart. */
  epoch?: string;
  outcome?: string | null;
  clv?: number | null;
  qScore?: number;
  homeGoals?: number;
  awayGoals?: number;
  closingOdds?: number;
  expHomeG?: number;
  expAwayG?: number;
  fp?: Record<string, number>;
  marketType?: string;
  /** Canonical market family (settlePick's dispatch key) — lets the read side
   *  break metrics/skip-rate out per family, surfacing whether the ledger is
   *  a representative sample or silently biased toward 1x2-derivable
   *  families (calibrationFeed.ts only settles a subset; see its docstring). */
  family?: MarketFamily;
  predictedClv?: number;
  loggedAt?: string;
  resolvedAt?: string;
  liquidityTag?: LiquidityTag;
  clvSourceQuality?: ClvSourceQuality;
  /** [Wave 3, WS3-D] Sharp-reference CLV — `computeSharpReferenceClv(sharpFairAtPick,
   *  sharpFairAtClose)` (runtime/resolveFixtures.ts), i.e. `EnrichedResolutionRecord
   *  .realisedSharpClv` (1/close − 1/pick implied-probability delta; positive =
   *  favorable line move), NOT the same signal as the `clv` field above (that one is
   *  the older odds/closingOdds-ratio CLV, PR-8b-era, computed from the T-30m
   *  snapshot rather than the Wave-2 sharp-reference feed — the two coexist by
   *  design, see EnrichedResolutionRecord's own doc comment). Optional/additive:
   *  populated only once the settlement call site (runtime/calibrationFeed.ts's
   *  toBetRecord) threads `EnrichedResolutionRecord.realisedSharpClv` through — that
   *  wiring is a separate file, outside this workstream's ownership this wave, so
   *  this stays undefined on every existing/未-wired record until that lands. Null
   *  (as opposed to undefined) means "the sharp feed was checked for this pick and
   *  had no CLV to report" (missing pick/close endpoint); undefined means "this
   *  record predates the wiring or the feed was never consulted." `segmentClv`
   *  below distinguishes the two only via `coverage` (undefined and null both count
   *  as "no CLV data" for coverage purposes — the distinction matters for future
   *  debugging, not for this aggregate). */
  sharpClv?: number | null;
}

export interface CalibrationRecord {
  fixtureId: string;
  rps: number;
  clv: number | null;
  clvSourceQuality?: ClvSourceQuality;
  liquidityTag: LiquidityTag;
  drawCalibrationGap?: number;
  schemaVersion?: number;
}

const LEAGUE_PARAMS: Record<
  string,
  {
    homeAvg: number;
    awayAvg: number;
    baseRho: number;
    kFactor: number;
    avgGA: number;
    drawRate: number;
  }
> = {
  "Premier League": {
    baseRho: -0.13,
    homeAvg: 1.48,
    awayAvg: 1.22,
    kFactor: 15,
    avgGA: 1.35,
    drawRate: 0.245,
  },
  "La Liga": {
    baseRho: -0.16,
    homeAvg: 1.52,
    awayAvg: 1.18,
    kFactor: 12,
    avgGA: 1.28,
    drawRate: 0.28,
  },
  "Serie A": {
    baseRho: -0.18,
    homeAvg: 1.42,
    awayAvg: 1.1,
    kFactor: 12,
    avgGA: 1.25,
    drawRate: 0.295,
  },
  Bundesliga: {
    baseRho: -0.14,
    homeAvg: 1.62,
    awayAvg: 1.35,
    kFactor: 10,
    avgGA: 1.45,
    drawRate: 0.22,
  },
  "Ligue 1": {
    baseRho: -0.15,
    homeAvg: 1.44,
    awayAvg: 1.15,
    kFactor: 10,
    avgGA: 1.3,
    drawRate: 0.26,
  },
  "Champions League": {
    baseRho: -0.1,
    homeAvg: 1.55,
    awayAvg: 1.25,
    kFactor: 18,
    avgGA: 1.4,
    drawRate: 0.235,
  },
  "Europa League": {
    baseRho: -0.12,
    homeAvg: 1.5,
    awayAvg: 1.2,
    kFactor: 15,
    avgGA: 1.35,
    drawRate: 0.24,
  },
  Eredivisie: {
    baseRho: -0.12,
    homeAvg: 1.72,
    awayAvg: 1.38,
    kFactor: 10,
    avgGA: 1.52,
    drawRate: 0.21,
  },
  Championship: {
    baseRho: -0.13,
    homeAvg: 1.5,
    awayAvg: 1.2,
    kFactor: 8,
    avgGA: 1.35,
    drawRate: 0.265,
  },
  Default: { baseRho: -0.13, homeAvg: 1.45, awayAvg: 1.15, kFactor: 8, avgGA: 1.3, drawRate: 0.25 },
};

// §8.3 Hierarchical calibration — Tier 1 = highest data reliability, Tier 3 = thin markets.
// Unknown leagues default to Tier 2 (medium-confidence prior).
const LEAGUE_TIER: Record<string, 1 | 2 | 3> = {
  "Premier League": 1,
  Bundesliga: 1,
  "Champions League": 1,
  "Europa League": 1,
  Eredivisie: 1,
  "La Liga": 2,
  "Serie A": 2,
  "Ligue 1": 2,
  Championship: 3,
};

type Tier = 1 | 2 | 3;

function _buildTierPrior(tier: Tier): { homeAvg: number; awayAvg: number } {
  const entries = Object.entries(LEAGUE_TIER)
    .filter(([, t]) => t === tier)
    .map(([l]) => LEAGUE_PARAMS[l])
    .filter((p): p is NonNullable<typeof p> => p !== undefined);
  if (entries.length === 0) return LEAGUE_PARAMS.Default!;
  return {
    homeAvg: entries.reduce((s, p) => s + p.homeAvg, 0) / entries.length,
    awayAvg: entries.reduce((s, p) => s + p.awayAvg, 0) / entries.length,
  };
}

const TIER_PRIOR: Record<Tier, { homeAvg: number; awayAvg: number }> = {
  1: _buildTierPrior(1),
  2: _buildTierPrior(2),
  3: _buildTierPrior(3),
};

// Pooling constant for calibFactor shrinkage (tuned via walk-forward per §8.4; never auto-optimized)
const K_CALIB_FACTOR = 20;
// [Wave 2, WS2-A] Segment (league×family) shrinkage reuses the same pooling
// constant as league-level shrinkage — no evidence yet that segment-level
// pooling needs different tuning, and diverging without data would just be a
// second hand-picked number to justify. Revisit only with a walk-forward result.
const K_SEGMENT = K_CALIB_FACTOR;

/** Minimum resolved-bet sample size below which a candidate/segment is never
 *  trusted — shared floor for `significanceAcceptGate`'s default `minN` and
 *  the per-segment calibFactor accept gate below. [PR-16 audit item] Never
 *  lowered for a core-param change. */
export const SIGNIFICANCE_MIN_N = 300;

/** [Wave 2, WS2-A] Deterministic key for a (league, market-family) segment —
 *  shared by `calculate()`'s segment accumulation, `makeCalibFactorResolver`,
 *  and calibrationFeed.ts's settlement stamp (BetRecord.segmentKey). */
export function segmentKey(league: string, family: MarketFamily): string {
  return `${league}::${family}`;
}

export class CalibrationEngine {
  constructor(private _storage: StoragePort) {}

  private async _load(): Promise<BetRecord[]> {
    return (await this._storage.get<BetRecord[]>(STORAGE_KEYS.calibrationLedger)) ?? [];
  }
  private async _save(bets: BetRecord[]): Promise<void> {
    await this._storage.set(STORAGE_KEYS.calibrationLedger, bets);
  }

  private _defaultMetrics(): CalibrationMetrics {
    return {
      brier: 0,
      recentBrier: 0,
      rps: null,
      recentRPS: null,
      logLoss: null,
      ece: null,
      clv: 0,
      roi: 0,
      calibFactor: 1.0,
      leagueData: {},
      segmentCalibFactors: {},
      segmentClv: {},
      bbnParams: {},
      driftAlert: false,
      resolvedCount: 0,
      winRate: 0,
      totalPnl: 0,
      totalStaked: 0,
      dynamicRhoParams: {},
      clvDecayCalibration: {},
      ruinProb: 0,
      ahAccuracy: {},
      zipCoeffs: null,
    } as CalibrationMetrics;
  }

  async addBet(bet: BetRecord): Promise<{ bets: BetRecord[]; metrics: CalibrationMetrics }> {
    // Serialized read-modify-write — safe if ever called under concurrent fixtures.
    return withKeyLock(STORAGE_KEYS.calibrationLedger, async () => {
      const bets = await this._load();
      bets.push({
        ...bet,
        id: Date.now().toString() + Math.random().toString(36).slice(2, 9),
        status: "pending",
        clv: null,
        outcome: null,
        loggedAt: new Date().toISOString(),
      });
      await this._save(bets);
      return { bets, metrics: this.calculate(bets) };
    });
  }

  async resolveBet(
    id: string,
    outcome: string,
    homeG: number,
    awayG: number,
    closeOdds: number
  ): Promise<{ bets: BetRecord[]; metrics: CalibrationMetrics }> {
    const bets = await this._load();
    const bet = bets.find((b) => b.id === id);
    if (!bet) return { bets, metrics: this.calculate(bets) };
    bet.status = "resolved";
    bet.outcome = outcome;
    bet.homeGoals = safeNum(homeG);
    bet.awayGoals = safeNum(awayG);
    bet.closingOdds = safeNum(closeOdds);
    bet.resolvedAt = new Date().toISOString();
    if (bet.closingOdds > 1 && bet.odds) bet.clv = bet.odds / bet.closingOdds - 1;
    const outcomeBinary =
      outcome === "win"
        ? 1
        : outcome === "half-win"
          ? 0.5
          : outcome === "loss"
            ? -1
            : outcome === "half-loss"
              ? -0.5
              : 0;
    const rawClv = bet.closingOdds! > 1 && bet.odds ? bet.odds / bet.closingOdds! - 1 : 0;
    const clvScore = clamp(rawClv, -1, 1);
    bet.qScore = clamp(0.6 * outcomeBinary + 0.4 * clvScore, -1, 1);
    await this._save(bets);
    return { bets, metrics: this.calculate(bets) };
  }

  async deleteBet(id: string): Promise<{ bets: BetRecord[]; metrics: CalibrationMetrics }> {
    const bets = (await this._load()).filter((b) => b.id !== id);
    await this._save(bets);
    return { bets, metrics: this.calculate(bets) };
  }

  /** `epochStart` [Wave 2, WS2-A]: ISO date (YYYY-MM-DD) gating per-segment
   *  calibFactor accumulation — bets with no `epoch` stamp, or an `epoch`
   *  before this date, are excluded from `segmentCalibFactors` (they never
   *  poison the global/per-league calcs either, which don't read `epoch` at
   *  all). Defaults to the Wave-1 deploy date ("2026-07-10", same default as
   *  OracleConfig.calibrationEpochStart) but callers should thread the real
   *  configured value through — see calibrationFeed.ts/analyze.ts. */
  calculate(bets: BetRecord[], epochStart = "2026-07-10"): CalibrationMetrics {
    const res = bets.filter((b) => b.status === "resolved");
    if (res.length === 0) return this._defaultMetrics();
    const MIN_CALIB = 10;
    let bSum = 0,
      cSum = 0,
      pnl = 0,
      stk = 0,
      wins = 0,
      pSum = 0;
    const lData: Record<
      string,
      { pnl: number; stk: number; n: number; bSum: number; wins: number; pSum: number }
    > = {};
    const goalData: Record<
      string,
      {
        hG: number;
        aG: number;
        n: number;
        zeroZero: number;
        oneZero: number;
        zeroOne: number;
        oneOne: number;
      }
    > = {};

    res.forEach((b) => {
      const isWin =
        b.outcome === "win"
          ? 1
          : b.outcome === "half-win"
            ? 0.5
            : b.outcome === "loss"
              ? 0
              : b.outcome === "half-loss"
                ? 0
                : 0.5;
      if (b.outcome !== "push") {
        bSum += ((b.mp ?? 0.5) - isWin) ** 2;
        stk += b.stakeAmt ?? 0;
        const odds = b.odds ?? 1,
          sa = b.stakeAmt ?? 0;
        const winAmt =
          b.outcome === "win"
            ? sa * odds - sa
            : b.outcome === "half-win"
              ? (sa / 2) * odds - sa / 2
              : b.outcome === "loss"
                ? -sa
                : b.outcome === "half-loss"
                  ? -(sa / 2)
                  : 0;
        pnl += winAmt;
        pSum += b.mp ?? 0;
        wins += isWin;
      }
      if (b.clv !== null && b.clv !== undefined && !Number.isNaN(b.clv)) cSum += b.clv;
      if (b.league) {
        if (!lData[b.league]) lData[b.league] = { pnl: 0, stk: 0, n: 0, bSum: 0, wins: 0, pSum: 0 };
        const iw = b.outcome === "win" ? 1 : b.outcome === "half-win" ? 0.5 : 0;
        const ld = lData[b.league]!;
        ld.pnl += iw * (b.odds ?? 1) * (b.stakeAmt ?? 0) - (b.stakeAmt ?? 0);
        ld.stk += b.stakeAmt ?? 0;
        ld.n++;
        ld.bSum += ((b.mp ?? 0) - iw) ** 2;
        ld.wins += iw;
        ld.pSum += b.mp ?? 0;
      }
      if (typeof b.homeGoals === "number" && typeof b.awayGoals === "number" && b.league) {
        if (!goalData[b.league])
          goalData[b.league] = {
            hG: 0,
            aG: 0,
            n: 0,
            zeroZero: 0,
            oneZero: 0,
            zeroOne: 0,
            oneOne: 0,
          };
        const gd = goalData[b.league]!;
        gd.hG += b.homeGoals;
        gd.aG += b.awayGoals;
        gd.n++;
        if (b.homeGoals === 0 && b.awayGoals === 0) gd.zeroZero++;
        if (b.homeGoals === 1 && b.awayGoals === 0) gd.oneZero++;
        if (b.homeGoals === 0 && b.awayGoals === 1) gd.zeroOne++;
        if (b.homeGoals === 1 && b.awayGoals === 1) gd.oneOne++;
      }
    });

    const nonPush = res.filter((b) => b.outcome !== "push");
    const recentBrier =
      nonPush.slice(-15).reduce((acc, b) => {
        const a = b.outcome === "win" ? 1 : b.outcome === "half-win" ? 0.5 : 0;
        return acc + ((b.mp ?? 0) - a) ** 2;
      }, 0) / Math.max(1, Math.min(15, nonPush.length));
    const overallBrier = nonPush.length > 0 ? bSum / nonPush.length : 0;

    const rpsBets = res.filter(
      (b) => b.fp && typeof b.homeGoals === "number" && typeof b.awayGoals === "number"
    );
    let rpsSum = 0,
      rpsRecentSum = 0,
      rpsN = 0;
    rpsBets.forEach((b) => {
      const actual =
        b.homeGoals! > b.awayGoals! ? "home" : b.homeGoals! < b.awayGoals! ? "away" : "draw";
      rpsSum += rankedProbabilityScore(b.fp!, actual);
      rpsN++;
    });
    rpsBets.slice(-15).forEach((b) => {
      const actual =
        b.homeGoals! > b.awayGoals! ? "home" : b.homeGoals! < b.awayGoals! ? "away" : "draw";
      rpsRecentSum += rankedProbabilityScore(b.fp!, actual);
    });
    const overallRPS = rpsN > 0 ? rpsSum / rpsN : null;
    const recentRPS = rpsBets.length > 0 ? rpsRecentSum / Math.min(15, rpsBets.length) : null;

    // §8.4+ log-loss and ECE over resolved bets that have mp (predicted win prob) + binary outcome
    const llBets = nonPush.filter(
      (b) => typeof b.mp === "number" && (b.outcome === "win" || b.outcome === "loss")
    );
    const llProbs = llBets.map((b) => b.mp!);
    const llLabels = llBets.map((b) => (b.outcome === "win" ? 1 : 0));
    const overallLogLoss = llBets.length >= 10 ? logLoss(llProbs, llLabels) : null;
    const overallEce = llBets.length >= 10 ? expectedCalibrationError(llProbs, llLabels) : null;

    const calibFactor =
      nonPush.length >= MIN_CALIB
        ? Math.max(0.5, Math.min(1.2, wins / Math.max(0.001, pSum)))
        : 1.0;

    // §8.3 Hierarchical bbnParams: shrink each league's observed rates toward its tier prior.
    // w = n/(n+k) — when n is small, estimate leans on the tier; as n grows it trusts its own data.
    const bbnParams: Record<
      string,
      { homeAvg: number; awayAvg: number; shrinkage: number; n: number }
    > = {};
    // §8.1/NEW-07: per-league dynamic rho via NR-MLE over the same four-cell
    // scoreline frequencies goalData already collects (was computed and
    // discarded every time — the {} literal this replaced never called
    // estimateDynamicRho on real data, so execution/index.ts's
    // `ledger?.metrics?.dynamicRhoParams?.[league]` consumer always read an
    // empty table). estimateDynamicRho falls back to baseRho when n < 30, so
    // thin-data leagues are unaffected. Folded into this same loop rather than
    // a second Object.keys(goalData).forEach — no need to walk the key set twice.
    const dynamicRhoParams: Record<string, number> = {};
    Object.keys(goalData).forEach((lg) => {
      const tier = (LEAGUE_TIER[lg] ?? 2) as Tier;
      const tierP = TIER_PRIOR[tier];
      const k = LEAGUE_PARAMS[lg]?.kFactor ?? 8;
      const d = goalData[lg]!;
      const n = d.n;
      const w = n > 0 ? n / (n + k) : 0;
      const obsH = n > 0 ? d.hG / n : tierP.homeAvg;
      const obsA = n > 0 ? d.aG / n : tierP.awayAvg;
      bbnParams[lg] = {
        homeAvg: parseFloat((obsH * w + tierP.homeAvg * (1 - w)).toFixed(4)),
        awayAvg: parseFloat((obsA * w + tierP.awayAvg * (1 - w)).toFixed(4)),
        shrinkage: parseFloat(w.toFixed(4)),
        n,
      };
      const baseRho = LEAGUE_PARAMS[lg]?.baseRho ?? LEAGUE_PARAMS.Default!.baseRho;
      dynamicRhoParams[lg] = estimateDynamicRho(d, baseRho);
    });

    // Per-league calibFactor with hierarchical shrinkage toward global calibFactor (§8.3).
    const leagueCalibFactors: Record<
      string,
      { calibFactor: number; shrinkage: number; n: number }
    > = {};
    Object.entries(lData).forEach(([lg, ld]) => {
      if (ld.n < 1) return;
      const rawCF = ld.pSum > 0 ? Math.max(0.5, Math.min(1.5, ld.wins / ld.pSum)) : 1.0;
      const w = ld.n / (ld.n + K_CALIB_FACTOR);
      leagueCalibFactors[lg] = {
        calibFactor: parseFloat((rawCF * w + calibFactor * (1 - w)).toFixed(4)),
        shrinkage: parseFloat(w.toFixed(4)),
        n: ld.n,
      };
    });

    // [Wave 2, WS2-A] Per-(league,family)-segment calibFactor — two-level
    // hierarchical shrinkage: segment's own {wins,pSum} shrinks toward the
    // LEAGUE's already-globally-shrunk factor (leagueCalibFactors above, not
    // straight to global) — segment leans on league which leans on global.
    // Only bets stamped with an `epoch` on/after `epochStart` accumulate here;
    // a missing `epoch` is treated as "not provably post-epoch" and excluded
    // (fail-safe — never assume a record is safe to mix in).
    const segData: Record<
      string,
      { wins: number; pSum: number; n: number; league: string; clvSum: number; clvN: number }
    > = {};
    res.forEach((b) => {
      if (b.outcome === "push" || !b.league || !b.family) return;
      if (!b.epoch || b.epoch < epochStart) return;
      const key = segmentKey(b.league, b.family);
      const iw = b.outcome === "win" ? 1 : b.outcome === "half-win" ? 0.5 : 0;
      segData[key] ??= { wins: 0, pSum: 0, n: 0, league: b.league, clvSum: 0, clvN: 0 };
      const sd = segData[key]!;
      sd.wins += iw;
      sd.pSum += b.mp ?? 0;
      sd.n++;
      // [Wave 3, WS3-D] Same post-epoch segment population as the calibFactor
      // accumulation above — sharpClv is undefined/null until
      // calibrationFeed.ts's toBetRecord threads it through (see BetRecord.sharpClv's
      // doc comment); both undefined and null mean "not covered" here.
      if (b.sharpClv !== undefined && b.sharpClv !== null && !Number.isNaN(b.sharpClv)) {
        sd.clvSum += b.sharpClv;
        sd.clvN++;
      }
    });
    const segmentCalibFactors: Record<
      string,
      { calibFactor: number; shrinkage: number; n: number; accepted: boolean }
    > = {};
    Object.entries(segData).forEach(([key, sd]) => {
      const rawSegCF = sd.pSum > 0 ? Math.max(0.5, Math.min(1.5, sd.wins / sd.pSum)) : 1.0;
      const leagueTarget = leagueCalibFactors[sd.league]?.calibFactor ?? calibFactor;
      const w = sd.n / (sd.n + K_SEGMENT);
      // Significance gate: a thin segment must never be trusted, full stop.
      // Gated directly on sample size rather than routed through
      // significanceAcceptGate — that gate's accept criterion (the ENTIRE
      // bootstrap CI on the improvement side, i.e. one-directional) is built
      // to compare two candidate models' scores, not to test whether a single
      // segment's win-rate is distinguishable from its predicted
      // probabilities, which is inherently two-sided (a segment can be
      // significantly OVER- or UNDER-confident, and both matter equally
      // here). SIGNIFICANCE_MIN_N is the exact same 300 floor
      // significanceAcceptGate defaults to — one shared constant, never
      // independently lowered.
      const accepted = sd.n >= SIGNIFICANCE_MIN_N;
      segmentCalibFactors[key] = {
        calibFactor: parseFloat((rawSegCF * w + leagueTarget * (1 - w)).toFixed(4)),
        shrinkage: parseFloat(w.toFixed(4)),
        n: sd.n,
        accepted,
      };
    });

    // [Wave 3, WS3-D] CLV headline — per-segment mean sharp-reference CLV +
    // coverage %, over the exact same segData population as segmentCalibFactors
    // above (see CalibrationMetrics.segmentClv's doc comment). Deliberately no
    // significance gate here (unlike segmentCalibFactors' `accepted`) — CLV
    // coverage/mean is a reporting metric surfaced to a human via the daily
    // report headline, not something a caller stakes real money on directly, so
    // a thin segment's number is still worth showing (with its low `n` visible
    // right alongside it) rather than hidden.
    const segmentClv: Record<string, { clv: number | null; n: number; coverage: number }> = {};
    Object.entries(segData).forEach(([key, sd]) => {
      segmentClv[key] = {
        clv: sd.clvN > 0 ? parseFloat((sd.clvSum / sd.clvN).toFixed(5)) : null,
        n: sd.n,
        coverage: sd.n > 0 ? parseFloat((sd.clvN / sd.n).toFixed(4)) : 0,
      };
    });

    const winRateCalc = nonPush.length > 0 ? wins / nonPush.length : 0.5;
    const avgBetSize = res.length > 0 ? stk / Math.max(1, res.length) : 0;
    const currentBankroll = 1000; // injected externally in production; default for calculation
    let ruinProb = 0;
    if (winRateCalc > 0 && winRateCalc < 1 && avgBetSize > 0 && currentBankroll > 0) {
      const meanEdge = stk > 0 ? pnl / res.length / (stk / res.length) : 0;
      const f = avgBetSize / Math.max(1, currentBankroll);
      const e = Math.max(0, meanEdge);
      const sigma2 = f * f * (winRateCalc * (1 - f) ** 2 + (1 - winRateCalc) * f ** 2);
      const cdeRuin = sigma2 > 0 && f > 0 && e > 0 ? Math.exp((-2 * f * e) / sigma2) : 1.0;
      const classicRatio = (1 - winRateCalc) / winRateCalc;
      const classicRuin = Math.min(1, classicRatio ** (currentBankroll / avgBetSize));
      const blendWeight = Math.min(1, res.length / 30);
      ruinProb = clamp(cdeRuin * blendWeight + classicRuin * (1 - blendWeight), 0, 1);
      if (!Number.isFinite(ruinProb) || Number.isNaN(ruinProb)) ruinProb = 0;
    }

    const ahAccuracyFlat: Record<string, Record<string, number>> = {};
    const ahRaw: Record<string, Record<string, { wins: number; n: number; hitRate: number }>> = {};
    res.forEach((b) => {
      if (!b.marketType || !/\bAH\b|Asian|handicap/i.test(String(b.marketType ?? ""))) return;
      const lg = b.league ?? "_global";
      const mm = String(b.marketType ?? "").match(/([+-]?\d+(?:\.\d+)?)\s*(home|away)/i);
      if (!mm) return;
      const key = `${mm[2]?.toLowerCase()}_${parseFloat(mm[1]!)}`;
      ahRaw[lg] = ahRaw[lg] ?? {};
      const rec = ahRaw[lg]?.[key] ?? { wins: 0, n: 0, hitRate: 0 };
      const score =
        b.outcome === "win"
          ? 1
          : b.outcome === "half-win"
            ? 0.5
            : b.outcome === "half-loss"
              ? 0
              : b.outcome === "loss"
                ? 0
                : null;
      if (score === null) return;
      rec.wins += score;
      rec.n += 1;
      rec.hitRate = rec.wins / rec.n;
      ahRaw[lg]![key] = rec;
    });
    Object.entries(ahRaw).forEach(([lg, keys]) => {
      ahAccuracyFlat[lg] = {};
      Object.entries(keys).forEach(([k, v]) => {
        if (v.n >= 8) ahAccuracyFlat[lg]![k] = v.hitRate;
      });
    });

    return {
      brier: overallBrier,
      recentBrier: recentBrier ?? 0,
      rps: overallRPS,
      recentRPS,
      logLoss: overallLogLoss,
      ece: overallEce,
      clv: res.length > 0 ? cSum / res.length : 0,
      roi: stk > 0 ? pnl / stk : 0,
      calibFactor,
      resolvedCount: res.length,
      leagueData: { ...lData, _leagueCalibFactors: leagueCalibFactors },
      segmentCalibFactors,
      segmentClv,
      bbnParams,
      driftAlert:
        (overallEce != null && overallEce > 0.05) ||
        (overallRPS != null && recentRPS != null
          ? recentRPS > overallRPS + 0.02
          : recentBrier > overallBrier + 0.05),
      winRate: winRateCalc,
      totalPnl: pnl,
      totalStaked: stk,
      dynamicRhoParams,
      clvDecayCalibration: this.backtestCLV(res),
      ruinProb,
      ahAccuracy: ahAccuracyFlat,
      zipCoeffs: null,
    };
  }

  backtestCLV(resolvedBets: BetRecord[]): Record<string, unknown> {
    if (!resolvedBets || resolvedBets.length < 5) return {};
    const byMarket: Record<string, { predicted: number[]; actual: number[]; count: number }> = {};
    resolvedBets.forEach((b) => {
      if (b.clv === null || b.clv === undefined || !b.marketType) return;
      const mt = b.marketType;
      if (!byMarket[mt]) byMarket[mt] = { predicted: [], actual: [], count: 0 };
      byMarket[mt]?.predicted.push(b.predictedClv ?? 0);
      byMarket[mt]?.actual.push(b.clv);
      byMarket[mt]!.count++;
    });
    const calibration: Record<string, unknown> = {};
    Object.keys(byMarket).forEach((mt) => {
      const d = byMarket[mt]!;
      if (d.count < 3) return;
      const avgPred = d.predicted.reduce((s, v) => s + v, 0) / d.count;
      const avgActual = d.actual.reduce((s, v) => s + v, 0) / d.count;
      calibration[mt] = {
        correctionFactor: avgPred > 0 ? clamp(avgActual / avgPred, 0.3, 2.0) : 1.0,
        avgPredicted: avgPred,
        avgActual,
        sampleSize: d.count,
      };
    });
    return calibration;
  }

  async getBets(): Promise<BetRecord[]> {
    return this._load();
  }
  async getPendingBets(): Promise<BetRecord[]> {
    return (await this._load()).filter((b) => b.status === "pending");
  }
  async getResolvedBets(): Promise<BetRecord[]> {
    return (await this._load()).filter((b) => b.status === "resolved");
  }
  async getMetrics(): Promise<CalibrationMetrics> {
    return this.calculate(await this._load());
  }
}

// ── §8.3/§8.5 Significance accept-gate ───────────────────────────────────────

export interface SignificanceGateResult {
  accept: boolean;
  delta: number; // mean(candidate) − mean(baseline); negative = improvement for RPS
  ciLower: number; // 2.5th-pct bootstrap delta
  ciUpper: number; // 97.5th-pct bootstrap delta
  n: number;
  effectSize: number; // |delta|
  reason: string;
}

export interface SignificanceGateOptions {
  // [PR-16] Raised 30->300 (audit item): n=30 is barely enough for the CLT to
  // apply at all, nowhere near enough to reliably resolve a delta as small as
  // effectSizeFloor=0.002 against RPS's noise floor via bootstrap CI — a
  // "significant" result at n=30 is far more likely to be sampling luck than
  // a real model improvement. Never lower this for a core-param change.
  minN?: number; // minimum sample count floor (default 300)
  effectSizeFloor?: number; // minimum |delta| to accept (default 0.002; RPS frontier ≈ 0.21)
  alpha?: number; // two-sided confidence level (default 0.95)
  nBootstrap?: number; // resamples (default 1000; use 100–200 in tests)
}

/** §8.3/§8.5 significance accept-gate — bootstrap CI on the metric delta.
 *
 *  Input: paired arrays of per-fixture scores (e.g. RPS) for baseline and candidate models.
 *  For RPS, lower is better, so improvement means delta < 0.
 *
 *  Accepts if and only if:
 *    1. n ≥ minN  (sufficient sample)
 *    2. |delta| ≥ effectSizeFloor  (non-trivially small)
 *    3. 97.5th-pct of bootstrap delta < 0  (the entire 95% CI is on the improvement side)
 *
 *  For metrics where higher = better (e.g. accuracy), negate both arrays before calling.
 *  This gate is intentionally conservative — it stops noise from masquerading as signal. */
export function significanceAcceptGate(
  baseline: number[],
  candidate: number[],
  options: SignificanceGateOptions = {}
): SignificanceGateResult {
  const minN = options.minN ?? SIGNIFICANCE_MIN_N;
  const effectSizeFloor = options.effectSizeFloor ?? 0.002;
  const alpha = options.alpha ?? 0.95;
  const nBoot = options.nBootstrap ?? 1000;

  const n = Math.min(baseline.length, candidate.length);

  if (n < minN) {
    return {
      accept: false,
      delta: 0,
      ciLower: NaN,
      ciUpper: NaN,
      n,
      effectSize: 0,
      reason: `INSUFFICIENT_SAMPLES (n=${n} < minN=${minN})`,
    };
  }

  let baseSum = 0,
    candSum = 0;
  for (let i = 0; i < n; i++) {
    baseSum += baseline[i]!;
    candSum += candidate[i]!;
  }
  const delta = (candSum - baseSum) / n;
  const effectSize = Math.abs(delta);

  if (effectSize < effectSizeFloor) {
    return {
      accept: false,
      delta,
      ciLower: NaN,
      ciUpper: NaN,
      n,
      effectSize,
      reason: `BELOW_EFFECT_SIZE_FLOOR (|Δ|=${effectSize.toFixed(5)} < floor=${effectSizeFloor})`,
    };
  }

  // Per-observation deltas for resampling
  const diffs = Array.from({ length: n }, (_, i) => candidate[i]! - baseline[i]!);

  const bootDeltas: number[] = new Array(nBoot);
  for (let b = 0; b < nBoot; b++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += diffs[Math.floor(Math.random() * n)]!;
    bootDeltas[b] = sum / n;
  }
  bootDeltas.sort((a, c) => a - c);

  const tail = (1 - alpha) / 2;
  const ciLower = bootDeltas[Math.floor(nBoot * tail)]!;
  const ciUpper = bootDeltas[Math.min(Math.floor(nBoot * (1 - tail)), nBoot - 1)]!;

  // Gate: entire 95% CI must be on the improvement side (ciUpper < 0 for RPS)
  const accept = ciUpper < 0;
  const reason = accept
    ? `ACCEPTED: Δ=${delta.toFixed(5)}, 95% CI=[${ciLower.toFixed(5)}, ${ciUpper.toFixed(5)}], n=${n}`
    : `REJECTED: CI upper ${ciUpper.toFixed(5)} ≥ 0 — delta not reliably negative at ${(alpha * 100).toFixed(0)}% confidence`;

  return { accept, delta, ciLower, ciUpper, n, effectSize, reason };
}

/** [Wave 2, WS2-A] THE public API every calibFactor consumer wires to.
 *  Returns a closure `(league, family) => calibFactor` a caller reads once
 *  per staking decision.
 *
 *  - `config.calibrationLedger !== "segment"` (i.e. "off"/"shadow"/"on"/
 *    unset): returns `metrics.calibFactor` unconditionally — byte-identical
 *    to every pre-Wave-2 call site, which read `ledger?.metrics?.calibFactor
 *    ?? 1.0` directly and never consumed `leagueCalibFactors` at all (verified
 *    via grep across execution/index.ts, marketExecutor.ts, batch/index.ts
 *    before this change — league-level shrinkage was computed but dead code).
 *  - `"segment"`: returns the segment's own factor when
 *    `segmentCalibFactors[segmentKey(league,family)].accepted` is true;
 *    otherwise falls back to the per-league factor
 *    (`leagueData._leagueCalibFactors[league]`, which itself already leans on
 *    global); otherwise falls back to the global `metrics.calibFactor`. */
export function makeCalibFactorResolver(
  metrics: CalibrationMetrics,
  config: { calibrationLedger?: string }
): (league: string, family: MarketFamily) => number {
  const mode = config.calibrationLedger ?? "shadow";
  return (league: string, family: MarketFamily): number => {
    if (mode !== "segment") return metrics.calibFactor;
    const seg = metrics.segmentCalibFactors[segmentKey(league, family)];
    if (seg?.accepted) return seg.calibFactor;
    const leagueFactors = (
      metrics.leagueData as { _leagueCalibFactors?: Record<string, { calibFactor: number }> }
    )._leagueCalibFactors;
    const lg = leagueFactors?.[league];
    if (lg) return lg.calibFactor;
    return metrics.calibFactor;
  };
}

// ── §8.4 Isotonic regression calibration (PAVA) ──────────────────────────────

/** Pool-Adjacent-Violators Algorithm — fits a monotone non-decreasing function
 *  through (predicted, actual) pairs. Returns calibrated values at each predicted input. */
function pava(predicted: number[], actual: number[]): number[] {
  const n = predicted.length;
  // Sort by predicted probability
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => predicted[a]! - predicted[b]!);
  const g: Array<{ sum: number; count: number }> = idx.map((i) => ({
    sum: actual[i]!,
    count: 1,
  }));
  // Merge violating adjacent blocks (isotonic constraint: non-decreasing)
  let i = 0;
  while (i < g.length - 1) {
    if (g[i]!.sum / g[i]!.count > g[i + 1]!.sum / g[i + 1]!.count) {
      g[i]!.sum += g[i + 1]!.sum;
      g[i]!.count += g[i + 1]!.count;
      g.splice(i + 1, 1);
      if (i > 0) i--;
    } else {
      i++;
    }
  }
  // Expand blocks back to per-sample values in original order
  const calibrated = new Array<number>(n);
  let gi = 0,
    remaining = g[0]!.count;
  for (const sortedPos of idx) {
    calibrated[sortedPos] = g[gi]!.sum / g[gi]!.count;
    remaining--;
    if (remaining === 0 && gi < g.length - 1) {
      gi++;
      remaining = g[gi]!.count;
    }
  }
  return calibrated;
}

/** §8.4 Post-hoc isotonic calibration of 1x2 probabilities against the resolution ledger.
 *
 *  Fits separate PAVA curves for home/draw/away using resolved bets that have both
 *  `fp` (predicted) and `homeGoals`/`awayGoals` (actual outcome). Renormalises after fit.
 *
 *  Returns the calibrated fp, or the original fp if < minSamples resolved records exist.
 *  Safe to call with an empty or partial ledger — falls back silently.
 *  [PR-16] minSamples raised 30->300 (audit item) — same reasoning as
 *  significanceAcceptGate's minN: 30 resolved bets is too thin a sample to
 *  fit a trustworthy PAVA isotonic curve without overfitting to noise. */
export function isotonicCalibrateFp(
  fp: { home: number; draw: number; away: number },
  resolvedBets: BetRecord[],
  minSamples = 300
): { home: number; draw: number; away: number } {
  const eligible = resolvedBets.filter(
    (b) =>
      b.fp &&
      typeof b.fp.home === "number" &&
      typeof b.fp.draw === "number" &&
      typeof b.fp.away === "number" &&
      typeof b.homeGoals === "number" &&
      typeof b.awayGoals === "number"
  );
  if (eligible.length < minSamples) return fp;

  const predHome = eligible.map((b) => b.fp!.home!);
  const predDraw = eligible.map((b) => b.fp!.draw!);
  const predAway = eligible.map((b) => b.fp!.away!);
  const actHome = eligible.map((b) => (b.homeGoals! > b.awayGoals! ? 1 : 0));
  const actDraw = eligible.map((b) => (b.homeGoals! === b.awayGoals! ? 1 : 0));
  const actAway = eligible.map((b) => (b.homeGoals! < b.awayGoals! ? 1 : 0));

  const calHome = pava(predHome, actHome);
  const calDraw = pava(predDraw, actDraw);
  const calAway = pava(predAway, actAway);

  // Interpolate calibrated value for the incoming fp using nearest-neighbour in predicted space
  function interpolate(pred: number[], cal: number[], query: number): number {
    let best = 0,
      bestDist = Infinity;
    for (let i = 0; i < pred.length; i++) {
      const d = Math.abs(pred[i]! - query);
      if (d < bestDist) {
        bestDist = d;
        best = cal[i]!;
      }
    }
    return best;
  }

  const rawH = interpolate(predHome, calHome, fp.home);
  const rawD = interpolate(predDraw, calDraw, fp.draw);
  const rawA = interpolate(predAway, calAway, fp.away);
  const total = rawH + rawD + rawA;
  if (total <= 0) return fp;
  return { home: rawH / total, draw: rawD / total, away: rawA / total };
}

// ── §8.4+ Platt scaling + ECE + log-loss ─────────────────────────────────────

/** Log-loss (binary cross-entropy) over a set of probability/label pairs.
 *  probs[i] = P(label=1); labels[i] ∈ {0, 1}.
 *  eps clamp prevents log(0). */
export function logLoss(probs: number[], labels: number[], eps = 1e-7): number {
  if (probs.length === 0 || probs.length !== labels.length) return NaN;
  let sum = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = clamp(probs[i]!, eps, 1 - eps);
    sum += -(labels[i]! * Math.log(p) + (1 - labels[i]!) * Math.log(1 - p));
  }
  return sum / probs.length;
}

/** Expected Calibration Error — bucket-based reliability diagram metric.
 *  Splits [0,1] into `bins` equal-width buckets, returns weighted mean
 *  |mean(predicted) − mean(actual)| across occupied buckets.
 *  Lower is better; 0 = perfectly calibrated; > 0.05 triggers the drift alert. */
export function expectedCalibrationError(probs: number[], labels: number[], bins = 10): number {
  if (probs.length === 0 || probs.length !== labels.length) return NaN;
  const n = probs.length;
  const buckets: Array<{ sumP: number; sumL: number; count: number }> = Array.from(
    { length: bins },
    () => ({ sumP: 0, sumL: 0, count: 0 })
  );
  for (let i = 0; i < n; i++) {
    const p = clamp(probs[i]!, 0, 1);
    const b = Math.min(Math.floor(p * bins), bins - 1);
    buckets[b]!.sumP += p;
    buckets[b]!.sumL += labels[i]!;
    buckets[b]!.count++;
  }
  let ece = 0;
  for (const bk of buckets) {
    if (bk.count === 0) continue;
    const avgP = bk.sumP / bk.count;
    const avgL = bk.sumL / bk.count;
    ece += (bk.count / n) * Math.abs(avgP - avgL);
  }
  return ece;
}

export interface PlattParams {
  a: number;
  b: number;
}

/** Platt scaling — fits a logistic sigmoid f(x) = 1/(1+exp(a·x+b)) to
 *  (raw_score, label) pairs via 20 steps of gradient descent (lr=0.01).
 *  Initialises a=−1, b=0 (identity logit). Returns {a, b}.
 *
 *  Usage: calibratedP = 1/(1+exp(a*rawScore + b))
 *
 *  Convergence is fast for typical n<500 football datasets; 20 steps keeps
 *  this synchronous and sub-millisecond. Caller should verify loss decreases. */
export function plattScale(scores: number[], labels: number[], steps = 20, lr = 0.01): PlattParams {
  if (scores.length === 0 || scores.length !== labels.length) return { a: -1, b: 0 };
  let a = -1,
    b = 0;
  const n = scores.length;
  for (let step = 0; step < steps; step++) {
    let dA = 0,
      dB = 0;
    for (let i = 0; i < n; i++) {
      const p = 1 / (1 + Math.exp(a * scores[i]! + b));
      const err = p - labels[i]!;
      dA += err * scores[i]!;
      dB += err;
    }
    a -= (lr * dA) / n;
    b -= (lr * dB) / n;
  }
  return { a, b };
}

/** Apply Platt calibration to a raw score using fitted {a, b}. */
export function applyPlatt(rawScore: number, params: PlattParams): number {
  return clamp(1 / (1 + Math.exp(params.a * rawScore + params.b)), 0, 1);
}
