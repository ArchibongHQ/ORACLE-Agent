/** CalibrationEngine — ported from ORACLE_v2026_8_0.jsx §5, lines 1377-1572.
 *  Rewrite #1: _safeStorage → StoragePort. MathEngine imported for safeNum/clamp/rps. */
import type { StoragePort } from "@oracle/storage";
import { STORAGE_KEYS, withKeyLock } from "@oracle/storage";
import { clamp, rankedProbabilityScore, safeNum } from "../math/index.js";
import type { ClvSourceQuality, LiquidityTag } from "../types.js";

export interface CalibrationMetrics {
  brier: number;
  recentBrier: number;
  rps: number | null;
  recentRPS: number | null;
  clv: number;
  roi: number;
  calibFactor: number;
  leagueData: Record<string, unknown>;
  /** §8.3 hierarchical bbnParams: each entry carries shrinkage weight and sample count
   *  so callers know how much data backs the estimate. */
  bbnParams: Record<string, { homeAvg: number; awayAvg: number; shrinkage: number; n: number }>;
  driftAlert: boolean;
  resolvedCount: number;
  winRate: number;
  totalPnl: number;
  totalStaked: number;
  dynamicRhoParams: Record<string, unknown>;
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
  mp?: number;
  odds?: number;
  stakeAmt?: number;
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
  predictedClv?: number;
  loggedAt?: string;
  resolvedAt?: string;
  liquidityTag?: LiquidityTag;
  clvSourceQuality?: ClvSourceQuality;
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
      clv: 0,
      roi: 0,
      calibFactor: 1.0,
      leagueData: {},
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

  calculate(bets: BetRecord[]): CalibrationMetrics {
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
      clv: res.length > 0 ? cSum / res.length : 0,
      roi: stk > 0 ? pnl / stk : 0,
      calibFactor,
      resolvedCount: res.length,
      leagueData: { ...lData, _leagueCalibFactors: leagueCalibFactors },
      bbnParams,
      driftAlert:
        overallRPS != null && recentRPS != null
          ? recentRPS > overallRPS + 0.02
          : recentBrier > overallBrier + 0.05,
      winRate: winRateCalc,
      totalPnl: pnl,
      totalStaked: stk,
      dynamicRhoParams: {},
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
  minN?: number; // minimum sample count floor (default 30)
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
  const minN = options.minN ?? 30;
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
