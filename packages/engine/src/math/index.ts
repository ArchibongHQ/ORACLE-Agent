// MathEngine — pure, deterministic scoreline math. PORT FROM: ORACLE_v2026_8_0.jsx lines 353–1322.
// This is ORACLE's crown jewel and must NEVER be auto-optimized (PRD §8.4).
//
// PORT STATUS: distribution + correlation core (lines 353–456) ported verbatim and type-annotated.
// buildMatrix onward remain stubs with source line refs pending the next read tranche.
// Object-literal refs (this.clamp / MathEngine.x) are rewired to module-level functions; all logic,
// constants, clamps, and the BUG-* fixes are preserved exactly as in source.

import type { Matrix, Regime } from "../types.js";

export const MAX_GOALS = 14; // line 354 — covers high-lambda Bundesliga games
export const MOS = 0.05; // line 355

export interface ZipCoeffs {
  b0: number;
  b1: number;
  b2: number;
}
export interface GoalData {
  n: number;
  hG: number;
  aG: number;
  zeroZero?: number;
  oneZero?: number;
  zeroOne?: number;
  oneOne?: number;
}
export interface Weather {
  wind_mph?: number;
  rain_mm?: number;
}
export interface Referee {
  cards_per_game?: number;
}
/** λ-adjustment result. Carries both `lH/lA` and legacy `lambdaH/lambdaA` aliases (source compat). */
export interface LambdaAdjust {
  lH: number;
  lA: number;
  lambdaH: number;
  lambdaA: number;
  penalized: boolean;
}
export interface TravelAdjust {
  lA: number;
  lambdaA: number;
  penalized: boolean;
}
export type QEVFn = (pWin: number, pHalf: number, pLoss: number, o: number) => number;
/** Asian-handicap sub-book: dynamic keys (scalars + component objects) plus the settlement-EV helper.
 *  Values are intentionally permissive — these mirror the source's dynamically-shaped AH keys. */
export interface AhBook {
  qEV: QEVFn;
  [key: string]: number | Record<string, number | string> | QEVFn;
}
export interface MarketBook {
  hw: number;
  dr: number;
  aw: number;
  btts: number;
  noBtts: number;
  ou: Record<string, number>;
  ah: AhBook;
  dnb_h: number;
  dnb_a: number;
  dc_1x: number;
  dc_x2: number;
  teamH: Record<string, number>;
  teamA: Record<string, number>;
  asian2: { over: number; under: number };
}
export interface SyntheticScript {
  title: string;
  legs: string[];
  prob: number;
  estBookie: number;
  edge: number;
}
export interface VarianceResult {
  varFlag: boolean;
  varMultiplier: number;
  stdDevEst: number;
  ciBound: number;
}
/** Diagnostics returned by detectLowScoringRegime (feeds the draw engine + AH pivot, PRD §4).
 *  regime is 'LOW_SCORING' or 'STANDARD' for this engine; Regime union kept for motion-regime callers. */
export interface RegimeReport {
  regime: Regime | "LOW_SCORING" | "STANDARD";
  p00: number;
  lowScoreMass: number;
  pUnder25: number;
  expTotal: number;
  maxSide: number;
  dominantSide: "home" | "away" | null;
  pHome: number;
  pDraw: number;
  pAway: number;
}
export interface AhCandidate {
  line: number;
  side: "home" | "away";
  pWin: number;
  pPush: number;
  pLoss: number;
  settleProb: number;
  accuracy?: number;
  score?: number;
}
export interface AhPivotResult {
  pivotApplied: boolean;
  recommendation: string;
  side: "home" | "away";
  line: number;
  settleProb: number;
  accuracy: number;
  score: number;
  rationale: string;
  allCandidates: AhCandidate[];
}
export interface VigRemoval {
  home: number;
  draw: number;
  away: number;
  k: number;
}
/** Line-movement read from lstmMarketDecoderProxy. */
export interface MarketSignal {
  velocity: number;
  rlm: boolean;
  steam: boolean;
  sharpCompression: boolean;
}
/** clvProjection result (PRD §2.3/§8.3 — CLV is the liquid-market gate). */
export interface ClvProjection {
  projected: number;
  survivalProb: number;
  edgeRetentionFraction: number;
  decayFactor: number;
  edgeStrengthFactor?: number;
}
export interface RecentMatch {
  xg?: number;
  goalsScored?: number;
  matchdayOffset?: number;
}
export interface EloPoint {
  rating: number;
  matchday?: number;
}
export interface LambdaConsistency {
  inconsistent: boolean;
  divergence: number;
  poissonEstimate?: number;
}
export type ScenarioEvent = { type?: string } | string;
export interface RerunBase {
  bayesian_lH?: number;
  bayesian_lA?: number;
  dynamicRho?: number;
  evMarkets?: Array<{ stake?: number }>;
}
export interface RerunResult {
  eventApplied: string;
  lambdaH: { before: number; after: number; delta: number };
  lambdaA: { before: number; after: number; delta: number };
  newMarkets: MarketBook;
  deltaScore: number;
  deltaKelly: number;
  newLambdaH: number;
  newLambdaA: number;
  interpretation: string;
}
export type Outcome = "home" | "draw" | "away";
export type Forecast = Partial<Record<Outcome, number>>;
export interface RpsRecord {
  forecast?: Forecast;
  outcome?: string | Forecast;
}
export interface KlResult {
  kl: number;
  js: number;
  hardSignal: boolean;
  strength: string;
  bitsAdv: number;
  maxDivOutcome: string;
  flag: string | null;
}
export interface EfficiencyResult {
  normProbs: { home: number; draw: number; away: number };
  eff: number;
  flb: string;
  flag: string | null;
}
export interface VarianceRegime {
  regime: string;
  factor: number;
  autocorr: number;
  l3WinRate?: number;
  l8WinRate?: number;
  accel?: number;
}
export interface LeeRecovery {
  multiplier: number;
  recoveryProb: number;
  constrained: boolean;
  flag?: string | null;
}

// ---------- ported: helpers + distributions (lines 357–456) ----------

/** clamp — line 357. (null/undefined branch dropped: unreachable under TS number typing.) */
export const clamp = (v: number, min: number, max: number): number => {
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
};

/** safeNum — line 362 (parseFloat semantics preserved). */
export const safeNum = (val: unknown, fallback = 0): number => {
  if (val === null || val === undefined) return fallback;
  const parsed = parseFloat(val as string);
  return Number.isNaN(parsed) ? fallback : parsed;
};

/** getConfidenceBand — line 368. */
export const getConfidenceBand = (p: number): "A" | "B" | "C" | "D" | "E" => {
  if (p >= 0.75) return "A";
  if (p >= 0.6) return "B";
  if (p >= 0.4) return "C";
  if (p >= 0.2) return "D";
  return "E";
};

/** poissonPMF — line 376. Log-space for stability; lambda floored at 0.01. */
export const poissonPMF = (k: number, lambda: number): number => {
  const lam = Math.max(0.01, lambda);
  let logP = k * Math.log(lam) - lam;
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
};

/** zipPMF — line 385. Zero-Inflated Poisson (π = structural-zero weight). */
export const zipPMF = (k: number, lambda: number, pi = 0.08): number => {
  const pois = poissonPMF(k, lambda);
  if (k === 0) return pi + (1 - pi) * pois;
  return (1 - pi) * pois;
};

/** calibratedZipPi — line 398. Two-feature logistic π(λH,λA); Baio-Blangiardo prior fallback. */
export function calibratedZipPi(lH: number, lA: number, coeffs?: ZipCoeffs | null): number {
  const total = (lH || 0) + (lA || 0);
  const diff = Math.abs((lH || 0) - (lA || 0));
  if (coeffs && typeof coeffs.b0 === "number") {
    const z = coeffs.b0 + coeffs.b1 * total + coeffs.b2 * diff;
    return clamp(1 / (1 + Math.exp(-z)), 0.03, 0.22);
  }
  return clamp(1 / (1 + Math.exp(-(-2.8 + 4.2 * total))), 0.03, 0.18);
}

/** dixonColesTau — line 411. Low-score dependence correction (sign convention per BUG-C01). */
export const dixonColesTau = (
  x: number,
  y: number,
  lH: number,
  lA: number,
  rho: number
): number => {
  if (rho === 0) return 1.0;
  if (x === 0 && y === 0) return Math.max(0.1, Math.min(3.0, 1 - lH * lA * rho));
  if (x === 0 && y === 1) return Math.max(0.1, Math.min(3.0, 1 + lH * rho));
  if (x === 1 && y === 0) return Math.max(0.1, Math.min(3.0, 1 + lA * rho));
  if (x === 1 && y === 1) return Math.max(0.1, Math.min(3.0, 1 - rho));
  return 1.0;
};

/** estimateDynamicRho — line 423. Bracketed bisection on dL/drho (BLOCK B9 fix). */
export const estimateDynamicRho = (
  goalData: GoalData | null | undefined,
  baseRho: number
): number => {
  if (!goalData || goalData.n < 30) return baseRho; // B1-01: min sample 30
  const n = goalData.n;
  const lH = Math.max(0.01, goalData.hG / n);
  const lA = Math.max(0.01, goalData.aG / n);
  const obs00 = Math.max(0.001, (goalData.zeroZero || 0) / n);
  const obs10 = Math.max(0.001, (goalData.oneZero || 0) / n);
  const obs01 = Math.max(0.001, (goalData.zeroOne || 0) / n);
  const obs11 = Math.max(0.001, (goalData.oneOne || 0) / n);
  const dL = (r: number): number => {
    const tau00 = Math.max(1e-9, 1 - lH * lA * r);
    const tau10 = Math.max(1e-9, 1 + lA * r);
    const tau01 = Math.max(1e-9, 1 + lH * r);
    const tau11 = Math.max(1e-9, 1 - r);
    return (-lH * lA * obs00) / tau00 + (lA * obs10) / tau10 + (lH * obs01) / tau01 - obs11 / tau11;
  };
  let lo = -0.3,
    hi = 0.02;
  const fLoInit = dL(lo),
    fHi = dL(hi);
  let fLo = fLoInit;
  if (fLo * fHi > 0) return clamp(baseRho, -0.3, 0.02);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2,
      fMid = dL(mid);
    if (Math.abs(fMid) < 1e-7 || hi - lo < 1e-6) return mid;
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return clamp((lo + hi) / 2, -0.3, 0.02);
};

// ---------- pending port (read next tranche): lines 460–1322 ----------

/** sarmanovTau — marginal-preserving alternative to DC tau, gated per-league. PENDING PORT. */
/** sarmanovTau — line 1308. Marginal-preserving Sarmanov tau for high-λ/overdispersed leagues
 *  (BLOCK B8, Michels et al. 2023). order=0 → Dixon–Coles; omega supplied via `rho` when order>0. */
export function sarmanovTau(
  x: number,
  y: number,
  lH: number,
  lA: number,
  rho: number,
  order = 0
): number {
  if (order === 0) return dixonColesTau(x, y, lH, lA, rho);
  const omega = rho;
  if (!omega) return 1.0;
  const Llam = (lam: number) => Math.exp(lam * (Math.exp(-1) - 1));
  const phi = (k: number, lam: number) => Math.exp(-k) - Llam(lam);
  return clamp(1 + omega * phi(x, lH) * phi(y, lA), 0.05, 3.0);
}

/** buildMatrix — line 460. Full scoreline matrix (Poisson/DC, optional ZIP, conditional 0-0/1-1 boost).
 *  `sarmanovOrder` replaces the global ORACLE_CONFIG.SARMANOV_ORDER (line 477); default 0 → DC path. */
export function buildMatrix(
  lH: number,
  lA: number,
  rho: number,
  useZIP = false,
  zipPi = 0.08,
  sarmanovOrder = 0
): Matrix {
  const mat: number[][] = [];
  let sum = 0;
  const totalXG = lH + lA;
  // BUG-007 FIX: zipBoost only when totalXG < 1.5 AND DC rho is weak.
  const dcStrength = Math.abs(rho) * lH * lA;
  const zipBoost00 = totalXG < 1.5 && dcStrength < 0.05 ? 1.08 : 1.0;
  const zipBoost11 = totalXG < 1.5 && dcStrength < 0.05 ? 1.03 : 1.0;

  for (let i = 0; i < MAX_GOALS; i++) {
    const pmfH = useZIP ? zipPMF(i, lH, zipPi) : poissonPMF(i, lH);
    if (pmfH < 1e-7) {
      mat[i] = new Array(MAX_GOALS).fill(0);
      continue;
    }
    mat[i] = [];
    for (let j = 0; j < MAX_GOALS; j++) {
      const pmfA = useZIP ? zipPMF(j, lA, zipPi) : poissonPMF(j, lA);
      if (pmfA < 1e-7) {
        mat[i][j] = 0;
        continue;
      }
      const tau =
        sarmanovOrder > 0
          ? sarmanovTau(i, j, lH, lA, rho, sarmanovOrder)
          : dixonColesTau(i, j, lH, lA, rho);
      let v = pmfH * pmfA * tau;
      if (i === 0 && j === 0) v *= zipBoost00;
      if (i === 1 && j === 1) v *= zipBoost11;
      mat[i][j] = v;
      sum += v;
    }
  }
  if (sum > 0)
    for (let i = 0; i < MAX_GOALS; i++)
      for (let j = 0; j < MAX_GOALS; j++) mat[i][j] = (mat[i][j] || 0) / sum;
  return mat;
}

/** applyEnvironmentalPenalties — line 490. */
export const applyEnvironmentalPenalties = (
  lH: number,
  lA: number,
  weather?: Weather | null,
  ref?: Referee | null
): LambdaAdjust => {
  let mH = 1,
    mA = 1;
  if ((weather?.wind_mph ?? 0) > 18.5) {
    mH *= 0.92;
    mA *= 0.92;
  }
  if ((weather?.rain_mm ?? 0) > 5.0) {
    mH *= 0.94;
    mA *= 0.94;
  }
  if ((ref?.cards_per_game ?? 0) > 4.5) {
    mH *= 0.97;
    mA *= 0.97;
  }
  return {
    lH: lH * mH,
    lA: lA * mA,
    lambdaH: lH * mH,
    lambdaA: lA * mA,
    penalized: mH < 1 || mA < 1,
  };
};

/** applyFatigueDecay — line 502. Asymmetric: short rest penalised steeply, long rest bonus capped (B1-05). */
export const applyFatigueDecay = (
  restH: number,
  restA: number,
  lH: number,
  lA: number
): LambdaAdjust => {
  let mH = 1,
    mA = 1;
  const d = restH - restA;
  if (restH <= 3 && d <= -2) mH = Math.exp(-0.07 * Math.abs(d));
  else if (restA <= 3 && d >= 2) mA = Math.exp(-0.07 * d);
  else if (restH <= 4 && d <= -3) mH = Math.exp(-0.07 * Math.abs(d));
  else if (restA <= 4 && d >= 3) mA = Math.exp(-0.07 * d);
  if (restH > 7 && restA <= 4) mH = Math.min(1.05, mH * 1.03);
  if (restA > 7 && restH <= 4) mA = Math.min(1.05, mA * 1.03);
  return {
    lH: lH * mH,
    lA: lA * mA,
    lambdaH: lH * mH,
    lambdaA: lA * mA,
    penalized: mH < 1 || mA < 1,
  };
};

/** applyTravelFriction — line 517. */
export const applyTravelFriction = (
  travelKm: number,
  altitudeM: number,
  lA: number
): TravelAdjust => {
  let modA = 1.0;
  if (travelKm > 1000) modA *= 0.97;
  if (altitudeM > 2000) modA *= 0.85;
  return { lA: lA * modA, lambdaA: lA * modA, penalized: modA < 1.0 };
};

/** adjustXGForSoS — line 525. Strength-of-schedule xG adjustment. */
export const adjustXGForSoS = (rawXG: number, oppGA: number, avgGA: number): number => {
  const factor = avgGA / Math.max(0.5, oppGA || avgGA);
  return rawXG * clamp(factor, 0.5, 2.0);
};
/** extractMarkets — line 530. Derives 1X2, O/U, BTTS, DNB, Asian handicap (incl. quarter-ball
 *  settlement components per BLOCK B6), team totals, and Asian-2 from the scoreline matrix. */
export const extractMarkets = (mat: Matrix): MarketBook => {
  let hw = 0,
    dr = 0,
    aw = 0,
    btts = 0;
  const N = mat.length || 14;
  const totals = new Array(N * 2).fill(0);
  for (let i = 0; i < N; i++) {
    if (!mat[i]) continue;
    for (let j = 0; j < N; j++) {
      const p = mat[i][j] || 0;
      if (i > j) hw += p;
      else if (i === j) dr += p;
      else aw += p;
      if (i > 0 && j > 0) btts += p;
      if (i + j < totals.length) totals[i + j] += p;
    }
  }
  const ou: Record<string, number> = {};
  [0.5, 1.5, 2.5, 3.5, 4.5].forEach((t) => {
    let over = 0;
    for (let g = Math.ceil(t); g < totals.length; g++) over += totals[g];
    ou[`over_${t}`] = over;
    ou[`under_${t}`] = 1 - over;
  });
  const dnbH = hw + aw > 0 ? hw / (hw + aw) : 0.5;
  const dnbA = hw + aw > 0 ? aw / (hw + aw) : 0.5;

  // BLOCK B6: quarter-ball lines expose {pWin,pHalf,pLoss} components; EV via ah.qEV downstream.
  const ah: AhBook = {
    qEV: (pWin, pHalf, pLoss, o) => pWin * (o - 1) + pHalf * 0.5 * (o - 1) - pLoss,
  };
  [-2.5, -2.0, -1.5, -1.0, -0.5, -0.25, 0.25, 0.5, 1.0, 1.5, 2.0, 2.5].forEach((line) => {
    let hW = 0,
      aW = 0,
      push = 0;
    for (let i = 0; i < N; i++) {
      if (!mat[i]) continue;
      for (let j = 0; j < N; j++) {
        const p = mat[i][j] || 0,
          margin = i - j + line;
        if (Math.abs(margin) < 0.01) push += p;
        else if (margin > 0) hW += p;
        else aW += p;
      }
    }
    if (line === -0.25) {
      let hWin = 0,
        drP = 0,
        aWin = 0;
      for (let i = 0; i < N; i++) {
        if (!mat[i]) continue;
        for (let j = 0; j < N; j++) {
          const p = mat[i][j] || 0;
          if (i > j) hWin += p;
          else if (i === j) drP += p;
          else aWin += p;
        }
      }
      ah.hm025_c = {
        pWin: hWin,
        pHalfWin: 0,
        pHalfLoss: drP,
        pLoss: aWin,
        side: "home",
        line: -0.25,
      };
      ah.hm025 = hWin;
      ah.ap025 = aWin + drP;
      ah.ap025_c = {
        pWin: aWin,
        pHalfWin: drP,
        pHalfLoss: 0,
        pLoss: hWin,
        side: "away",
        line: 0.25,
      };
    } else if (line === 0.25) {
      let hWin = 0,
        drP = 0,
        aWin = 0;
      for (let i = 0; i < N; i++) {
        if (!mat[i]) continue;
        for (let j = 0; j < N; j++) {
          const p = mat[i][j] || 0;
          if (i > j) hWin += p;
          else if (i === j) drP += p;
          else aWin += p;
        }
      }
      ah.hp025_c = {
        pWin: hWin,
        pHalfWin: drP,
        pHalfLoss: 0,
        pLoss: aWin,
        side: "home",
        line: 0.25,
      };
      ah.hp025 = hWin + 0.5 * drP;
      ah.am025 = aWin;
      ah.am025_c = {
        pWin: aWin,
        pHalfWin: 0,
        pHalfLoss: drP,
        pLoss: hWin,
        side: "away",
        line: -0.25,
      };
    } else {
      const strAbs = Math.abs(line).toString().replace(".", "");
      const keyH = line < 0 ? `hm${strAbs}` : `hp${strAbs}`;
      const keyA = line < 0 ? `ap${strAbs}` : `am${strAbs}`;
      ah[keyH] = hW + push / 2;
      ah[keyA] = aW + push / 2;
      ah[line.toString()] = { homeWin: hW, push, awayWin: aW };
      ah[(line > 0 ? "+" : "") + line.toString()] = { homeWin: hW, push, awayWin: aW };
    }
  });
  const homeGoalDist = new Array(N).fill(0);
  const awayGoalDist = new Array(N).fill(0);
  for (let i = 0; i < N; i++) {
    if (!mat[i]) continue;
    for (let j = 0; j < N; j++) {
      const p = mat[i][j] || 0;
      homeGoalDist[i] += p;
      awayGoalDist[j] += p;
    }
  }
  const teamH: Record<string, number> = {};
  const teamA: Record<string, number> = {};
  [0.5, 1.5, 2.5].forEach((t) => {
    let hOver = 0,
      aOver = 0;
    for (let g = Math.ceil(t); g < N; g++) {
      hOver += homeGoalDist[g];
      aOver += awayGoalDist[g];
    }
    teamH[`over_${t}`] = hOver;
    teamH[`under_${t}`] = 1 - hOver;
    teamA[`over_${t}`] = aOver;
    teamA[`under_${t}`] = 1 - aOver;
  });

  const asian2Push = totals[2] || 0;
  const asian2Over = totals.slice(3).reduce((s, v) => s + v, 0);
  const asian2Under = 1 - asian2Over - asian2Push;
  const asian2Effective = {
    over: asian2Over + asian2Push * 0.5,
    under: asian2Under + asian2Push * 0.5,
  };

  return {
    hw,
    dr,
    aw,
    btts,
    noBtts: 1 - btts,
    ou,
    ah,
    dnb_h: dnbH,
    dnb_a: dnbA,
    dc_1x: hw + dr,
    dc_x2: aw + dr,
    teamH,
    teamA,
    asian2: asian2Effective,
  };
};

/** generateSyntheticAlpha — line 641. Correlated-parlay "scripts" with per-leg vig (BUG-L03). */
export function generateSyntheticAlpha(mat: Matrix): SyntheticScript[] {
  const scripts: SyntheticScript[] = [];
  const N = mat.length || 14;
  const extract = (name: string, legs: string[], condition: (h: number, a: number) => boolean) => {
    let prob = 0;
    for (let i = 0; i < N; i++) {
      if (!mat[i]) continue;
      for (let j = 0; j < N; j++) if (condition(i, j)) prob += mat[i][j] || 0;
    }
    const legVig = 1 + 0.04 * legs.length;
    const estBookie = prob > 0 ? (1 / Math.max(0.001, prob)) * legVig : 0;
    if (prob > 0.02)
      scripts.push({ title: name, legs, prob, estBookie, edge: prob * estBookie - 1 });
  };
  extract(
    "Script Alpha: Attritional Home Dom.",
    ["Home Win", "Away Clean Sheet", "Under 3.5"],
    (h, a) => h > a && a === 0 && h + a < 3.5
  );
  extract(
    "Script Beta: Chaotic Shootout",
    ["Draw", "Both Teams to Score", "Over 2.5"],
    (h, a) => h === a && h > 0 && h + a > 2.5
  );
  extract(
    "Script Gamma: Clinical Away Ambush",
    ["Away Win", "Home Under 1.5", "No BTTS"],
    (h, a) => h < a && h < 1.5 && (h === 0 || a === 0)
  );
  extract(
    "Script Delta: Stuffy Correlator",
    ["Under 2.5 Goals", "No BTTS"],
    (h, a) => h + a < 2.5 && (h === 0 || a === 0)
  );
  return scripts.sort((a, b) => b.edge - a.edge).slice(0, 4);
}

/** matrixVariance — line 669. Analytic outcome variance from the corrected matrix (MC deleted, BLOCK B5). */
export function matrixVariance(lH: number, lA: number, rho: number, _n?: number): VarianceResult {
  const mat = buildMatrix(lH, lA, rho);
  const m = extractMarkets(mat);
  const pH = m.hw,
    pD = m.dr,
    pA = m.aw;
  const stdDevEst = Math.sqrt(Math.max(pH * (1 - pH), pA * (1 - pA), pD * (1 - pD)));
  let varMultiplier = 1.0;
  if (stdDevEst > 0.45) varMultiplier = 0.8;
  if (stdDevEst > 0.48) varMultiplier = 0.5;
  if (stdDevEst > 0.5) varMultiplier = 0.1;
  const ciBound = stdDevEst * 4.0;
  return { varFlag: stdDevEst > 0.48, varMultiplier, stdDevEst, ciBound };
}

/** monteCarlo — line 685. Back-compat alias routed through the exact analytic path. */
export function monteCarlo(lH: number, lA: number, rho: number, n = 10000): VarianceResult {
  return matrixVariance(lH, lA, rho, n);
}
/** detectLowScoringRegime — line 695. Classifies LOW_SCORING from the matrix; feeds the AH pivot. */
export function detectLowScoringRegime(mat: Matrix, lH: number, lA: number): RegimeReport {
  const m = extractMarkets(mat);
  const p00 = mat[0]?.[0] || 0;
  const p10 = mat[1]?.[0] || 0;
  const p01 = mat[0]?.[1] || 0;
  const lowScoreMass = p00 + p10 + p01;
  const pUnder25 =
    m.ou?.["under_2.5"] != null ? m.ou["under_2.5"] : 1 - (m.ou ? m.ou["over_2.5"] : 0);
  const expTotal = (lH || 0) + (lA || 0);
  const maxSide = Math.max(m.hw, m.aw);
  const dominantSide: "home" | "away" | null =
    maxSide >= 0.48 ? (m.hw >= m.aw ? "home" : "away") : null;
  const isLow = expTotal < 2.35 && pUnder25 > 0.58 && lowScoreMass > 0.34 && maxSide < 0.52;
  return {
    regime: isLow ? "LOW_SCORING" : "STANDARD",
    p00,
    lowScoreMass,
    pUnder25,
    expTotal,
    maxSide,
    dominantSide,
    pHome: m.hw,
    pDraw: m.dr,
    pAway: m.aw,
  };
}

/** asianHandicapPivot — line 733. Picks the best AH line for a low-scoring spot (PRD §4 crown jewel). */
export function asianHandicapPivot(
  mat: Matrix,
  regime: RegimeReport,
  leagueAccuracy: Record<string, number> = {}
): AhPivotResult {
  const N = mat.length || 14;
  const ahComponents = (line: number, side: "home" | "away") => {
    let pWin = 0,
      pPush = 0,
      pLoss = 0;
    for (let i = 0; i < N; i++) {
      if (!mat[i]) continue;
      for (let j = 0; j < N; j++) {
        const p = mat[i][j] || 0;
        if (!p) continue;
        const rawMargin = side === "home" ? i - j : j - i;
        const adj = rawMargin + line;
        if (Math.abs(adj - 0.25) < 0.01) {
          pWin += p * 0.5;
          pPush += p * 0.5;
        } else if (Math.abs(adj + 0.25) < 0.01) {
          pLoss += p * 0.5;
          pPush += p * 0.5;
        } else if (adj > 0.01) pWin += p;
        else if (adj < -0.01) pLoss += p;
        else pPush += p;
      }
    }
    const settleProb = pWin + 0.5 * pPush;
    return { line, side, pWin, pPush, pLoss, settleProb };
  };

  let candidates: AhCandidate[];
  if (regime.dominantSide) {
    const fav = regime.dominantSide;
    candidates = [
      ahComponents(0.0, fav),
      ahComponents(-0.25, fav),
      ahComponents(0.25, fav),
      ahComponents(-0.5, fav),
    ];
  } else {
    candidates = [
      ahComponents(0.5, "home"),
      ahComponents(0.25, "home"),
      ahComponents(0.5, "away"),
      ahComponents(0.25, "away"),
      ahComponents(0.0, "home"),
      ahComponents(0.0, "away"),
    ];
  }

  const wp = 0.55,
    wa = 0.35,
    wv = 0.1;
  const scored = candidates
    .map((c) => {
      const key = `${c.side}_${c.line}`;
      const acc = leagueAccuracy[key] != null ? leagueAccuracy[key] : c.settleProb;
      const variance = c.settleProb * (1 - c.settleProb);
      const score = wp * c.settleProb + wa * acc - wv * variance;
      return { ...c, accuracy: acc, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  return {
    pivotApplied: true,
    recommendation: `AH ${best.line >= 0 ? "+" : ""}${best.line} ${best.side}`,
    side: best.side,
    line: best.line,
    settleProb: best.settleProb,
    accuracy: best.accuracy,
    score: best.score,
    rationale: regime.dominantSide
      ? `Dominant ${regime.dominantSide} favourite in low-scoring spot → ${best.line === 0 ? "DNB" : `AH ${best.line}`} protects the push; favourite unlikely to LOSE but may not win by margin.`
      : `Even low-scoring grind → AH ${best.line >= 0 ? "+" : ""}${best.line} ${best.side}: a 0-0 ${best.line >= 0.5 ? "WINS" : "PUSHES"} this line.`,
    allCandidates: scored,
  };
}

/** shinPowerVigRemoval — line 809. Bisection on the Shin/power exponent k s.t. Σ(1/oᵢ)^k = 1 (BLOCK B14). */
export function shinPowerVigRemoval(oddsH: number, oddsD: number, oddsA: number): VigRemoval {
  const impH = 1 / oddsH,
    impD = 1 / oddsD,
    impA = 1 / oddsA;
  if (oddsH <= 1 || oddsD <= 1 || oddsA <= 1) {
    const s = impH + impD + impA;
    return { home: impH / s, draw: impD / s, away: impA / s, k: 1 };
  }
  const rawSum = impH + impD + impA;
  if (rawSum < 1.0) {
    return { home: impH / rawSum, draw: impD / rawSum, away: impA / rawSum, k: 1 };
  } // arb: linear (deliberate)
  let lo = 1.0,
    hi = 10.0,
    k = 1.0;
  for (let i = 0; i < 40; i++) {
    k = (lo + hi) / 2;
    const sum = impH ** k + impD ** k + impA ** k;
    if (Math.abs(sum - 1.0) < 1e-8) break;
    if (sum > 1.0) lo = k;
    else hi = k;
  }
  return {
    home: clamp(impH ** k, 0.001, 0.999),
    draw: clamp(impD ** k, 0.001, 0.999),
    away: clamp(impA ** k, 0.001, 0.999),
    k,
  };
}
// Back-compat aliases (source getters powerMethodVigRemoval / powerVigRemoval, lines 819–820).
export const powerMethodVigRemoval = shinPowerVigRemoval;
export const powerVigRemoval = shinPowerVigRemoval;

// ---------- ported: signals, staking, CLV (lines 827–960) ----------

/** lstmMarketDecoderProxy — line 827. RLM / steam / sharp-compression from odds velocity. */
export const lstmMarketDecoderProxy = (
  _modelProb: number,
  openOdds: number,
  currentOdds: number,
  isPopular: boolean
): MarketSignal => {
  if (!openOdds || !currentOdds || openOdds <= 1 || currentOdds <= 1)
    return { velocity: 0, rlm: false, steam: false, sharpCompression: false };
  const velocity = 1 / currentOdds - 1 / openOdds;
  let rlm = false,
    steam = false,
    sharpCompression = false;
  if (isPopular) {
    if (velocity < -0.015) rlm = true;
    if (velocity > 0.025) steam = true;
  } else {
    if (velocity > 0.015) steam = true;
    if (velocity < -0.025) rlm = true;
  }
  // BUG-A04: directional fast shortening only; S03/S04 mutual exclusion (compression guarded by !rlm).
  if (velocity > 0.03 && !rlm) sharpCompression = true;
  return { velocity, rlm, steam, sharpCompression };
};

/** calculateDHA — line 854. Dynamic home advantage from pi-rating diff. */
export const calculateDHA = (piDiff: number): number => {
  if (piDiff < -0.8) return 0.85;
  if (piDiff > 1.2) return 1.15;
  return 1.0;
};

/** calculateDynamicRho — line 855. */
export const calculateDynamicRho = (lH: number, lA: number, baseRho: number): number =>
  clamp(baseRho * Math.exp(-0.25 * (lH + lA - 2.5)), -0.5, Math.abs(baseRho * 1.5));

/** hurdle — line 856. Minimum-edge hurdle by win probability. */
export const hurdle = (p: number): number => {
  if (p >= 0.75) return 0.03;
  if (p >= 0.6) return 0.04;
  if (p >= 0.4) return 0.06;
  if (p >= 0.2) return 0.09;
  if (p >= 0.1) return 0.12;
  return 0.15;
};

/** adjEV — line 857. EV minus margin-of-safety. */
export const adjEV = (modelP: number, odds: number): number => modelP * odds - 1 - MOS;

/** optimizedKelly — line 867. Canonical Kelly f* = edge/(odds-1), capped at 0.15 (BLOCK B0). */
export const optimizedKelly = (
  edge: number,
  odds: number,
  dqs: number,
  councilPenaltyActive: boolean,
  varMultiplier = 1.0,
  drawdownPenalty = 1.0,
  calibFactor = 1.0,
  base = 0.25,
  modelProb: number | null = null
): number => {
  if (edge <= 0 || odds <= 1) return 0;
  const safeDQS = clamp(dqs, 0.4, 1.0) || 0.85;
  const penaltyMod = councilPenaltyActive ? 0.5 : 1.0;
  const fraction = base * safeDQS * penaltyMod * varMultiplier * drawdownPenalty * calibFactor;
  const mp =
    modelProb !== null ? modelProb : clamp((edge + 1) / Math.max(1.001, odds), 0.001, 0.999);
  const b = odds - 1;
  if (b <= 0) return 0;
  const fStar = (mp * odds - 1) / b;
  if (fStar <= 0) return 0;
  return clamp(fStar * fraction, 0, 0.15);
};

/** CorrelationMatrix — line 881. Phi correlation between two market legs over the matrix. */
export const CorrelationMatrix = {
  cellMatches(i: number, j: number, label: string): boolean {
    if (!label) return false;
    if (label === "Home Win" || label === "Match Winner: Home") return i > j;
    if (label === "Away Win" || label === "Match Winner: Away") return i < j;
    if (label === "Draw" || label === "Match Winner: Draw") return i === j;
    if (label.includes("Over")) {
      const t = parseFloat(label.split(" ")[1] || label.split(" ")[2]);
      return i + j > t;
    }
    if (label.includes("Under")) {
      const t = parseFloat(label.split(" ")[1] || label.split(" ")[2]);
      return i + j < t;
    }
    if (label === "BTTS Yes") return i > 0 && j > 0;
    if (label === "BTTS No") return i === 0 || j === 0;
    if (label.includes("AH Home")) {
      const rawL = label.split(" ")[2] || "0";
      const l = parseFloat(rawL.replace(/\u2212|\u2013/g, "-").replace(/[^\d.-]/g, ""));
      if (Number.isNaN(l)) return false;
      const diff = i - j + l;
      if (diff > 0) return true;
      if (diff === 0) return false;
      if (Math.abs((l * 4) % 1) < 0.01 && diff > -0.5) return false;
      return false;
    }
    if (label.includes("AH Away")) {
      const rawL = label.split(" ")[2] || "0";
      const l = parseFloat(rawL.replace(/\u2212|\u2013/g, "-").replace(/[^\d.-]/g, ""));
      if (Number.isNaN(l)) return false;
      const diff = j - i + l;
      if (diff > 0) return true;
      return false;
    }
    if (label === "1X") return i >= j;
    if (label === "X2") return i <= j;
    return false;
  },
  compute(mat: Matrix, labelA: string, labelB: string): number {
    if (!labelA || !labelB || !mat?.[0]) return 0;
    let pA = 0,
      pB = 0,
      pAB = 0;
    const N = mat.length;
    for (let i = 0; i < N; i++) {
      if (!mat[i]) continue;
      for (let j = 0; j < N; j++) {
        const prob = mat[i][j] || 0,
          mA = this.cellMatches(i, j, labelA),
          mB = this.cellMatches(i, j, labelB);
        if (mA) pA += prob;
        if (mB) pB += prob;
        if (mA && mB) pAB += prob;
      }
    }
    const denom = Math.sqrt(pA * (1 - pA) * pB * (1 - pB));
    if (denom === 0) return 0;
    return (pAB - pA * pB) / denom;
  },
};

/** clvProjection — line 933. Projected edge + true survival probability after time decay (BUG-M09). */
export const clvProjection = (
  edge: number,
  hoursToKO: number,
  marketType: string,
  leagueLiquidity = 1.0
): ClvProjection => {
  if (edge <= 0)
    return { projected: 0, survivalProb: 0.05, edgeRetentionFraction: 0.05, decayFactor: 1.0 };
  const marketDecayRate = marketType === "1x2" ? 0.12 : marketType === "AH" ? 0.08 : 0.05;
  const timeDecay = Math.exp((-marketDecayRate * Math.min(hoursToKO, 48)) / 24);
  const liquidity = clamp(leagueLiquidity, 0.3, 1.5);
  const projectedEdge = (edge * timeDecay) / liquidity;
  const edgeStrengthFactor = clamp(edge / 0.08, 0.1, 2.0);
  const retentionRaw = projectedEdge / Math.max(0.001, edge);
  const edgeRetentionFraction = clamp(
    retentionRaw * (0.6 + 0.4 * Math.min(1.0, edgeStrengthFactor)),
    0.05,
    0.95
  );
  const logit = 6.0 * (edgeRetentionFraction - 0.5);
  const survivalProb = clamp(1 / (1 + Math.exp(-logit)), 0.05, 0.95);
  return {
    projected: projectedEdge,
    survivalProb,
    edgeRetentionFraction,
    decayFactor: timeDecay,
    edgeStrengthFactor,
  };
};

/** getDrawdownPenalty — line 955. 3-tier progressive taper (NEW-11). */
export const getDrawdownPenalty = (drawdown: number): number => {
  if (drawdown >= 0.25) return 0.25;
  if (drawdown >= 0.15) return 0.5;
  if (drawdown >= 0.08) return 0.75;
  return 1.0;
};

// ---------- ported: form/momentum/calibration + scenario rerun (lines 965–1107) ----------

/** applyTemporalDecay — line 965. Exp-weighted recent form, blended 60/40 with season avg. */
export const applyTemporalDecay = (
  recentMatches: RecentMatch[] | null | undefined,
  baseAvg: number,
  halfLife = 10
): number => {
  if (!recentMatches || recentMatches.length < 3) return baseAvg;
  let weightedSum = 0,
    totalWeight = 0;
  recentMatches.forEach((m, idx) => {
    const w = Math.exp((-Math.log(2) * idx) / halfLife);
    const val = (m.xg ?? 0) > 0 ? (m.xg as number) : m.goalsScored || baseAvg;
    weightedSum += val * w;
    totalWeight += w;
  });
  const decayedAvg = totalWeight > 0 ? weightedSum / totalWeight : baseAvg;
  return clamp(decayedAvg * 0.6 + baseAvg * 0.4, 0.1, 4.5);
};

/** eloMomentumFactor — line 987. Regression slope of recent Elo → [0.85,1.15] multiplier (BUG-M03). */
export const eloMomentumFactor = (eloHistory: EloPoint[] | null | undefined): number => {
  if (!eloHistory || eloHistory.length < 2) return 1.0;
  const recent = eloHistory.slice(0, Math.min(5, eloHistory.length)).reverse(); // oldest first
  if (recent.length < 2) return 1.0;
  const n = recent.length;
  const xMean = (n - 1) / 2;
  const yMean = recent.reduce((s, r) => s + r.rating, 0) / n;
  let num = 0,
    den = 0;
  recent.forEach((r, i) => {
    num += (i - xMean) * (r.rating - yMean);
    den += (i - xMean) ** 2;
  });
  const slope = den > 0 ? num / den : 0;
  return clamp(1.0 + slope / 200, 0.85, 1.15);
};

/** drawCalibrationFactor — line 1011. League-draw-rate vs Poisson-draw correction (Constantinou & Fenton 2012). */
export const drawCalibrationFactor = (poissonDrawProb: number, leagueDrawRate = 0.25): number => {
  if (poissonDrawProb <= 0) return 1.0;
  const ratio = leagueDrawRate / Math.max(0.05, poissonDrawProb);
  return clamp(ratio, 0.85, 1.2);
};

/** checkLambdaInconsistency — line 1020. Cross-validates λ vs O/U 2.5 implied; flags >5% divergence. */
export const checkLambdaInconsistency = (
  lH: number,
  lA: number,
  ou25ImpliedProb: number
): LambdaConsistency => {
  if (!ou25ImpliedProb || ou25ImpliedProb <= 0 || ou25ImpliedProb >= 1)
    return { inconsistent: false, divergence: 0 };
  const totalLambda = lH + lA;
  let poissonOver25 = 0;
  for (let g = 3; g <= 12; g++) poissonOver25 += poissonPMF(g, totalLambda);
  const divergence = Math.abs(poissonOver25 - ou25ImpliedProb);
  return { inconsistent: divergence > 0.05, divergence, poissonEstimate: poissonOver25 };
};

/** isSteamChaser — line 1035. Compression fired but edge < 5% ⇒ value already gone. */
export const isSteamChaser = (sharpCompression: boolean, edge: number): boolean =>
  sharpCompression && edge < 0.05;

/** rerunWithOverride — line 1042. Scenario branching: re-price with an injected event (B15). */
export function rerunWithOverride(
  event: ScenarioEvent | null | undefined,
  baseResult: RerunBase | null | undefined
): RerunResult | null {
  if (!baseResult || !event) return null;
  const eventType = (typeof event === "string" ? event : event.type || "").toLowerCase();
  const lH = safeNum(baseResult.bayesian_lH, 1.3);
  const lA = safeNum(baseResult.bayesian_lA, 1.1);

  const adjustments: Record<string, { lH: number; lA: number }> = {
    key_player_out_home: { lH: -0.18, lA: 0.0 },
    key_player_out_away: { lH: 0.0, lA: -0.15 },
    key_player_in_home: { lH: +0.12, lA: 0.0 },
    key_player_in_away: { lH: 0.0, lA: +0.1 },
    weather_change_heavy: { lH: -0.1, lA: -0.1 },
    weather_change_clear: { lH: +0.05, lA: +0.05 },
    rotation_detected_home: { lH: -0.15, lA: 0.0 },
    rotation_detected_away: { lH: 0.0, lA: -0.12 },
    late_odds_move_home: { lH: +0.08, lA: -0.05 },
    late_odds_move_away: { lH: -0.05, lA: +0.08 },
  };

  let adj: { lH: number; lA: number } = { lH: 0, lA: 0 };
  for (const [key, delta] of Object.entries(adjustments)) {
    if (eventType.includes(key.replace(/_/g, " ")) || eventType.includes(key)) {
      adj = delta;
      break;
    }
  }
  if (
    eventType.includes("striker") ||
    eventType.includes("striker out") ||
    eventType.includes("out")
  )
    adj = { lH: adj.lH || -0.15, lA: adj.lA };
  if (eventType.includes("rain") || eventType.includes("heavy rain")) adj = { lH: -0.1, lA: -0.1 };

  const newLH = Math.max(0.1, lH + adj.lH);
  const newLA = Math.max(0.1, lA + adj.lA);
  const rho = baseResult.dynamicRho || -0.13;
  const newMarkets = extractMarkets(buildMatrix(newLH, newLA, rho));

  const oldXG = lH + lA,
    newXG = newLH + newLA,
    xgDelta = newXG - oldXG;
  const deltaScore = Math.round(xgDelta * 3);
  const baseKelly = baseResult.evMarkets?.[0]?.stake || 0;
  const deltaKelly = baseKelly * (1 + xgDelta * 0.2) - baseKelly;

  return {
    eventApplied: eventType,
    lambdaH: { before: lH, after: newLH, delta: adj.lH },
    lambdaA: { before: lA, after: newLA, delta: adj.lA },
    newMarkets,
    deltaScore,
    deltaKelly,
    newLambdaH: newLH,
    newLambdaA: newLA,
    interpretation:
      adj.lH !== 0 || adj.lA !== 0
        ? `λH ${lH.toFixed(2)}→${newLH.toFixed(2)} (${adj.lH >= 0 ? "+" : ""}${adj.lH.toFixed(2)})  λA ${lA.toFixed(2)}→${newLA.toFixed(2)} (${adj.lA >= 0 ? "+" : ""}${adj.lA.toFixed(2)})`
        : `No parametric adjustment for event: "${eventType}"`,
  };
}

// ---------- ported: statistical utilities, RPS, KL, efficiency (lines 1112–1236) ----------

/** gaussianRand — line 1112. Box-Muller normal variate (SensitivityEngine ensemble). */
export function gaussianRand(mu: number, sigma: number): number {
  let u = 0,
    v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mu + sigma * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** benfordMAD — line 1122. First-digit Benford MAD; null if n<50. */
export function benfordMAD(values: number[] | null | undefined): number | null {
  if (!values || values.length < 50) return null;
  const expected = [0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046];
  const counts = new Array(9).fill(0);
  let total = 0;
  for (const v of values) {
    const s = String(Math.abs(v))
      .replace(/^0\.0*/, "")
      .replace(".", "");
    const d = parseInt(s[0], 10);
    if (d >= 1 && d <= 9) {
      counts[d - 1]++;
      total++;
    }
  }
  if (total === 0) return null;
  let mad = 0;
  for (let i = 0; i < 9; i++) mad += Math.abs(counts[i] / total - expected[i]);
  return parseFloat((mad / 9).toFixed(6));
}

/** secondDigitFreq — line 1142. Fraction of values ending in 0/5 (retail rounding bias); null if n<20. */
export function secondDigitFreq(values: number[] | null | undefined): number | null {
  if (!values || values.length < 20) return null;
  let rounded = 0;
  for (const v of values) {
    const s = v.toFixed(2);
    const d2 = parseInt(s[s.length - 1], 10);
    if (d2 === 0 || d2 === 5) rounded++;
  }
  return parseFloat((rounded / values.length).toFixed(4));
}

/** rankedProbabilityScore — line 1164. The football-standard ordinal metric (PRD §2.3 target). Lower is better. */
export function rankedProbabilityScore(
  forecast: Forecast | null | undefined,
  outcome: string | Forecast | null | undefined
): number {
  const order: Outcome[] = ["home", "draw", "away"];
  const raw = order.map((o) => Math.max(0, forecast?.[o] || 0));
  const ps = raw.reduce((a, c) => a + c, 0) || 1;
  const pf = raw.map((v) => v / ps);
  const e =
    typeof outcome === "string"
      ? order.map((o) => (o === outcome ? 1 : 0))
      : order.map((o) => (outcome?.[o] ? 1 : 0));
  let rps = 0,
    cumP = 0,
    cumE = 0;
  for (let i = 0; i < order.length - 1; i++) {
    cumP += pf[i];
    cumE += e[i];
    rps += (cumP - cumE) ** 2;
  }
  return rps / (order.length - 1);
}

/** meanRPS — line 1183. Mean RPS over resolved records (skips unresolved). */
export function meanRPS(records: RpsRecord[] | null | undefined): {
  rps: number | null;
  n: number;
} {
  let sum = 0,
    n = 0;
  for (const r of records || []) {
    if (!r?.forecast || !r.outcome) continue;
    const v = rankedProbabilityScore(r.forecast, r.outcome);
    if (v !== null && Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? { rps: sum / n, n } : { rps: null, n: 0 };
}

/** klDivergence — line 1193. D_KL(model‖market) + Jensen-Shannon; >0.15 = hard mispricing signal. */
export function klDivergence(modelDist: Forecast, marketDist: Forecast): KlResult {
  const eps = 1e-10;
  const outs: Outcome[] = ["home", "draw", "away"];
  let kl = 0,
    js = 0;
  outs.forEach((o) => {
    const p = Math.max(eps, modelDist[o] || 0);
    const q = Math.max(eps, marketDist[o] || 0);
    const m = (p + q) / 2;
    kl += p * Math.log(p / q);
    js += 0.5 * (p * Math.log(p / m) + q * Math.log(q / m));
  });
  const hardSignal = kl > 0.15;
  const strength = kl > 0.2 ? "EXTREME" : kl > 0.15 ? "HARD" : kl > 0.08 ? "MODERATE" : "WEAK";
  const bitsAdv = parseFloat((kl / Math.log(2)).toFixed(4));
  const maxDiv = outs.reduce(
    (mx, o) => {
      const d = Math.abs((modelDist[o] || 0) - (marketDist[o] || 0));
      return d > mx.d ? { o: o as string, d } : mx;
    },
    { o: "", d: 0 }
  );
  return {
    kl: parseFloat(kl.toFixed(6)),
    js: parseFloat(js.toFixed(6)),
    hardSignal,
    strength,
    bitsAdv,
    maxDivOutcome: maxDiv.o,
    flag: hardSignal
      ? `[KL_HARD_SIGNAL] D_KL=${kl.toFixed(4)} (${bitsAdv} bits) — market mispriced on ${maxDiv.o}`
      : kl > 0.08
        ? `[KL_MODERATE] D_KL=${kl.toFixed(4)} — soft divergence`
        : null,
  };
}

/** normalizedEfficiency — line 1224. Market-efficiency test correcting favourite-longshot bias. */
export function normalizedEfficiency(
  oddsH: number,
  oddsD: number,
  oddsA: number,
  mH: number,
  mD: number,
  mA: number
): EfficiencyResult | null {
  if (!oddsH || !oddsD || !oddsA || oddsH <= 1 || oddsD <= 1 || oddsA <= 1) return null;
  const ih = 1 / oddsH,
    id = 1 / oddsD,
    ia = 1 / oddsA,
    s = ih + id + ia;
  const nH = ih / s,
    nD = id / s,
    nA = ia / s;
  const eff = parseFloat(
    (1 - (Math.abs(mH - nH) + Math.abs(mD - nD) + Math.abs(mA - nA)) / 2).toFixed(4)
  );
  const flb =
    Math.max(nH, nA) > 0.6 && Math.min(nH, nA) / Math.max(nH, nA) < 0.4 ? "DETECTED" : "NONE";
  return {
    normProbs: { home: nH, draw: nD, away: nA },
    eff,
    flb,
    flag:
      eff < 0.85
        ? `[MARKET_INEFFICIENCY] Eff=${(eff * 100).toFixed(1)}% — significant edge (FLB:${flb})`
        : eff > 0.95
          ? `[MARKET_EFFICIENT] Eff=${(eff * 100).toFixed(1)}% — thin, proceed with caution`
          : null,
  };
}

// ---------- ported: variance regime + recovery constraints (lines 1242–1290) ----------

/** adaptiveVarianceRegime — line 1242. Momentum/mean-reversion regime from recent returns (Antila 2024). */
export function adaptiveVarianceRegime(recentReturns: number[] | null | undefined): VarianceRegime {
  if (!recentReturns || recentReturns.length < 4)
    return { regime: "INSUFFICIENT_DATA", factor: 1.0, autocorr: 0 };
  const n = recentReturns.length;
  const mean = recentReturns.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 1; i < n; i++) num += (recentReturns[i] - mean) * (recentReturns[i - 1] - mean);
  for (let i = 0; i < n; i++) den += (recentReturns[i] - mean) ** 2;
  const autocorr = den > 0 ? num / den : 0;
  const l3 = recentReturns.slice(-3);
  const l8 = recentReturns.slice(-Math.min(8, n));
  const l3wr = l3.filter((x) => x > 0).length / 3;
  const l8wr = l8.filter((x) => x > 0).length / l8.length;
  const accel = l3wr - l8wr;
  let regime = "NEUTRAL",
    factor = 1.0;
  if (autocorr > 0.35) {
    regime = "MOMENTUM";
    factor = Math.min(1.2, 1 + autocorr * 0.5);
  } else if (autocorr < -0.25) {
    regime = "MEAN_REVERSION";
    factor = Math.max(0.75, 1 + autocorr * 0.4);
  }
  if (Math.abs(accel) > 0.3) {
    regime = accel > 0 ? "ACCELERATING" : "DECELERATING";
    factor *= accel > 0 ? 1.1 : 0.85;
  }
  return {
    regime,
    factor: parseFloat(factor.toFixed(3)),
    autocorr: parseFloat(autocorr.toFixed(3)),
    l3WinRate: l3wr,
    l8WinRate: l8wr,
    accel: parseFloat(accel.toFixed(3)),
  };
}

/** leeRecoveryConstraint — line 1268. Drawdown-recovery guard on Kelly sizing (Lee 2025). */
export function leeRecoveryConstraint(
  drawdown: number,
  betsRemaining = 50,
  _targetRecovery = 1.0
): LeeRecovery {
  if (drawdown <= 0) return { multiplier: 1.0, recoveryProb: 1.0, constrained: false };
  const estimatedEdge = 0.04;
  const recoveryProb = Math.min(
    0.99,
    1 - Math.exp((-2 * betsRemaining * estimatedEdge) / Math.max(0.01, drawdown))
  );
  const multiplier =
    recoveryProb >= 0.7 ? 1.0 : recoveryProb >= 0.5 ? 0.85 : recoveryProb >= 0.3 ? 0.65 : 0.5;
  return {
    multiplier: parseFloat(multiplier.toFixed(3)),
    recoveryProb: parseFloat(recoveryProb.toFixed(3)),
    constrained: multiplier < 1.0,
    flag:
      multiplier < 1.0
        ? `[LEE_RECOVERY_CONSTRAINT] drawdown=${(drawdown * 100).toFixed(1)}%, recovery P=${(recoveryProb * 100).toFixed(0)}% — Kelly ×${multiplier}`
        : null,
  };
}

/** serialDependenceMultiplier — line 1286. Edge multiplier from recent-bet momentum regime. */
export function serialDependenceMultiplier(recentOutcomes: number[] | null | undefined): number {
  if (!recentOutcomes || recentOutcomes.length < 3) return 1.0;
  return adaptiveVarianceRegime(recentOutcomes).factor;
}

// ---------- §8.1 Bivariate Poisson (Karlis & Ntzoufaris 2003) ----------

/** Default correlation parameter λ3 for the bivariate Poisson path (PRD §8.1).
 *  Karlis & Ntzoufaris (2003) found λ3 ≈ 0.10–0.20 for European football.
 *  Tune via walk-forward backtest (§8.4); never auto-optimized. */
export const DEFAULT_BIVARIATE_LAMBDA3 = 0.1;

/** Bivariate Poisson PMF — Karlis & Ntzoufaris (2003) eq. 3.
 *  P(X=x, Y=y | λ1, λ2, λ3) = e^{-(λ1+λ2+λ3)} · Σ_{k=0}^{min(x,y)} λ1^{x-k}/(x-k)! · λ2^{y-k}/(y-k)! · λ3^k/k!
 *  When λ3=0 reduces to independent Poisson. Computed in log-space for numerical stability. */
export function bivariatePoisson(x: number, y: number, l1: number, l2: number, l3: number): number {
  const s1 = Math.max(0.001, l1);
  const s2 = Math.max(0.001, l2);
  const s3 = Math.max(0, l3);
  const lim = Math.min(x, y);
  const logTerms: number[] = [];
  for (let k = 0; k <= lim; k++) {
    if (k > 0 && s3 === 0) break;
    let logTk = (x - k) * Math.log(s1) + (y - k) * Math.log(s2);
    if (k > 0) logTk += k * Math.log(s3);
    for (let i = 2; i <= x - k; i++) logTk -= Math.log(i);
    for (let i = 2; i <= y - k; i++) logTk -= Math.log(i);
    for (let i = 2; i <= k; i++) logTk -= Math.log(i);
    logTerms.push(logTk);
  }
  if (logTerms.length === 0) return 0;
  const maxT = Math.max(...logTerms);
  const sumExp = logTerms.reduce((a, t) => a + Math.exp(t - maxT), 0);
  return Math.exp(-(s1 + s2 + s3) + maxT + Math.log(sumExp));
}

/** buildBivariateMatrix — §8.1 A/B path (behind `useBivariatePoisson` flag in OracleConfig).
 *  lH and lA are marginal goal-rate means; λ3 ≥ 0 is the covariance parameter.
 *  Internally: λ1 = lH − λ3, λ2 = lA − λ3, so marginals remain Poisson(lH) and Poisson(lA).
 *  Models draws natively via the correlation term — no Dixon–Coles rho correction applied. */
export function buildBivariateMatrix(
  lH: number,
  lA: number,
  lambda3 = DEFAULT_BIVARIATE_LAMBDA3
): Matrix {
  const l3 = clamp(lambda3, 0, Math.min(lH, lA) - 0.01);
  const l1 = Math.max(0.001, lH - l3);
  const l2 = Math.max(0.001, lA - l3);
  const mat: number[][] = [];
  let sum = 0;
  for (let i = 0; i < MAX_GOALS; i++) {
    mat[i] = [];
    for (let j = 0; j < MAX_GOALS; j++) {
      const v = bivariatePoisson(i, j, l1, l2, l3);
      mat[i][j] = v;
      sum += v;
    }
  }
  if (sum > 0)
    for (let i = 0; i < MAX_GOALS; i++)
      for (let j = 0; j < MAX_GOALS; j++) mat[i][j] = (mat[i][j] ?? 0) / sum;
  return mat;
}

// ---------- §8.2 Skellam distribution (Wilkens 2026 — AH/supremacy cross-check) ----------

/** Modified Bessel function of the first kind I_n(x) via series expansion in log-space.
 *  I_{-n}(x) = I_n(x) for integer n. Converges in ≤50 terms for football-scale inputs (λ ≤ 5). */
function modifiedBesselI(n: number, x: number): number {
  const absN = Math.abs(n);
  if (x <= 0) return absN === 0 ? 1 : 0;
  const halfX = x / 2;
  let sum = 0;
  for (let m = 0; m <= 50; m++) {
    // term = (x/2)^{2m+|n|} / (m! × (m+|n|)!)
    let logTerm = (2 * m + absN) * Math.log(halfX);
    for (let i = 2; i <= m; i++) logTerm -= Math.log(i);
    for (let i = 2; i <= m + absN; i++) logTerm -= Math.log(i);
    const term = Math.exp(logTerm);
    sum += term;
    if (term < sum * 1e-14 && m >= absN) break;
  }
  return sum;
}

/** Skellam PMF: P(X₁ − X₂ = k) where X₁ ~ Poisson(l1), X₂ ~ Poisson(l2).
 *  Wilkens (2026): "the Skellam distribution naturally models win-draw-loss results."
 *  PRD §8.2 — used as AH/supremacy cross-check, not as a replacement for the matrix path. */
export function skellamPMF(k: number, l1: number, l2: number): number {
  const s1 = Math.max(1e-6, l1);
  const s2 = Math.max(1e-6, l2);
  // e^{-(λ1+λ2)} × (λ1/λ2)^{k/2} × I_{|k|}(2√(λ1λ2))
  return (
    Math.exp(-(s1 + s2) + (k / 2) * Math.log(s1 / s2)) *
    modifiedBesselI(Math.abs(k), 2 * Math.sqrt(s1 * s2))
  );
}

/** Skellam 1X2 probabilities — cross-check for the matrix-derived `fp`.
 *  lH / lA are the final ensemble expected goals (same values fed to buildBivariateMatrix). */
export function skellamProbs(lH: number, lA: number): { home: number; draw: number; away: number } {
  const MAX_DIFF = 8; // P(|diff| > 8) < 0.001 for typical football λ values
  let pHome = 0,
    pDraw = 0,
    pAway = 0;
  for (let k = -MAX_DIFF; k <= MAX_DIFF; k++) {
    const p = skellamPMF(k, lH, lA);
    if (k > 0) pHome += p;
    else if (k === 0) pDraw += p;
    else pAway += p;
  }
  const total = pHome + pDraw + pAway;
  if (total <= 0) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  return { home: pHome / total, draw: pDraw / total, away: pAway / total };
}

/** Skellam P(home − away > line) — cross-check for the AH pivot.
 *  line = −0.5 → P(home wins); line = 0 → P(home wins by ≥ 1).
 *  Use `line = ahLine − 0.5` to check cover probability on a given AH spread. */
export function skellamAHCover(lH: number, lA: number, line: number): number {
  const MAX_DIFF = 8;
  let pCover = 0;
  for (let k = -MAX_DIFF; k <= MAX_DIFF; k++) {
    if (k > line) pCover += skellamPMF(k, lH, lA);
  }
  return Math.min(1, pCover);
}
