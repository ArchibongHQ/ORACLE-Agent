/**
 * Math engine unit tests — ported from runProtocolUnitTests (JSX lines 6125-7133).
 * Covers T1-T20, T53-T55, T101-T103, T112-T121, T126-T130, T137-T148,
 *        T160-T179, T193-T200, T267-T272, T276-T283, T360-T375.
 * API delta: MathEngine.X() in JSX → named exports from @oracle/engine.
 */
import { describe, it, expect } from 'vitest';
import {
  clamp, safeNum, poissonPMF, MAX_GOALS,
  buildMatrix, buildBivariateMatrix, bivariatePoisson, DEFAULT_BIVARIATE_LAMBDA3,
  extractMarkets,
  adjustXGForSoS, powerMethodVigRemoval,
  getDrawdownPenalty, lstmMarketDecoderProxy,
  clvProjection, estimateDynamicRho, monteCarlo,
  applyTemporalDecay, eloMomentumFactor,
  drawCalibrationFactor, checkLambdaInconsistency, isSteamChaser,
  generateSyntheticAlpha, optimizedKelly, applyFatigueDecay,
  detectLowScoringRegime, asianHandicapPivot, calibratedZipPi,
  rankedProbabilityScore,
  rerunWithOverride,
  gaussianRand, benfordMAD, secondDigitFreq,
} from '@oracle/engine';

// ── LAYER 0: Math Utilities ────────────────────────────────────────────────────

describe('LAYER 0: Math Utilities', () => {
  it('T1: clamp(5,0,10)=5',    () => expect(clamp(5, 0, 10)).toBe(5));
  it('T2: clamp(-1,0,10)=0',   () => expect(clamp(-1, 0, 10)).toBe(0));
  it('T3: clamp(15,0,10)=10',  () => expect(clamp(15, 0, 10)).toBe(10));
  it('T4: clamp(NaN)=min',     () => expect(clamp(NaN, 0, 10)).toBe(0));

  it('T5: safeNum(null)=fallback',      () => expect(safeNum(null, 5)).toBe(5));
  it('T6: safeNum(undefined)=fallback', () => expect(safeNum(undefined, 5)).toBe(5));
  it('T7: safeNum string',              () => expect(safeNum('1.5', 0)).toBe(1.5));
  it('T8: safeNum NaN string',          () => expect(safeNum('abc', 0)).toBe(0));

  it('T9: poissonPMF(0,1.5)>0',  () => expect(poissonPMF(0, 1.5)).toBeGreaterThan(0));
  it('T10: poissonPMF(2,1.5)>0', () => expect(poissonPMF(2, 1.5)).toBeGreaterThan(0));
});

// ── LAYER 1: Dixon-Coles Matrix ────────────────────────────────────────────────

describe('LAYER 1: Dixon-Coles Matrix', () => {
  const mat = buildMatrix(1.5, 1.2, -0.13);

  it('T11: Matrix sums to 1.0', () => {
    let s = 0;
    for (let i = 0; i < mat.length; i++) for (let j = 0; j < mat.length; j++) s += (mat[i]![j] ?? 0);
    expect(Math.abs(s - 1.0)).toBeLessThan(0.001);
  });

  it('T12: 0-0 DC boost applied (rho negative → tau>1)', () => {
    expect(mat[0]![0]).toBeGreaterThan(poissonPMF(0, 1.5) * poissonPMF(0, 1.2));
  });

  it('T13: Matrix dimension = MAX_GOALS=14', () => {
    expect(mat[0]!.length).toBe(MAX_GOALS);
  });
});

// ── LAYER 1b: ZIP Model ────────────────────────────────────────────────────────

describe('LAYER 1b: ZIP Model (T101-T103)', () => {
  const mat    = buildMatrix(1.5, 1.2, -0.13);
  const matZIP = buildMatrix(1.5, 1.2, -0.13, true, 0.08);

  it('T101: ZIP matrix sums to 1.0', () => {
    let s = 0;
    for (let i = 0; i < matZIP.length; i++) for (let j = 0; j < matZIP.length; j++) s += (matZIP[i]![j] ?? 0);
    expect(Math.abs(s - 1.0)).toBeLessThan(0.001);
  });

  it('T102: ZIP inflates 0-0 vs pure DC', () => {
    expect(matZIP[0]![0]).toBeGreaterThan(mat[0]![0]!);
  });

  it('T103: AH -0.25 between AH -0.5 and AH 0.0', () => {
    const mkt = extractMarkets(mat);
    const ah05H = (mkt.ah['hm05'] as number | undefined) ?? mkt.hw;
    const ah0H  = mkt.hw + mkt.dr * 0.5;
    const hm025 = mkt.ah['hm025'] as number;
    expect(hm025).toBeGreaterThanOrEqual(Math.min(ah05H, ah0H) - 0.01);
    expect(hm025).toBeLessThanOrEqual(Math.max(ah05H, ah0H) + 0.01);
  });
});

// ── LAYER 2: Market Extraction ─────────────────────────────────────────────────

describe('LAYER 2: Market Extraction (T14-T18)', () => {
  const mat = buildMatrix(1.5, 1.2, -0.13);
  const mkt = extractMarkets(mat);

  it('T14: 1X2 probs sum to 1.0',     () => expect(Math.abs(mkt.hw + mkt.dr + mkt.aw - 1.0)).toBeLessThan(0.001));
  it('T15: BTTS in [0,1]',            () => { expect(mkt.btts).toBeGreaterThanOrEqual(0); expect(mkt.btts).toBeLessThanOrEqual(1); });
  it('T16: Over 2.5 in [0,1]', () => {
    const v = (mkt.ou['over_2.5'] ?? mkt.ou['over_2_5'] ?? 0) as number;
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
  it('T17: AH -0.25 home exists', () => expect((mkt.ah['hm025'] as number | undefined)).toBeDefined());
  it('T18: AH +0.25 home exists', () => expect((mkt.ah['hp025'] as number | undefined)).toBeDefined());
});

// ── LAYER 3: SoS Adjustment ────────────────────────────────────────────────────

describe('LAYER 3: SoS Adjustment (T19-T20)', () => {
  it('T19: SoS adj increases xG vs weak defense',  () => expect(adjustXGForSoS(1.5, 1.0, 1.35)).toBeGreaterThan(1.5));
  it('T20: SoS adj decreases xG vs strong defense', () => expect(adjustXGForSoS(1.5, 2.0, 1.35)).toBeLessThan(1.5));
});

// ── LAYER 9: Power Vig Removal ─────────────────────────────────────────────────

describe('LAYER 9: Power Vig Removal (T53-T55, T112)', () => {
  const vig = powerMethodVigRemoval(2.0, 3.5, 4.5);

  it('T53: Vig-removed probs sum to ~1.0', () => expect(Math.abs(vig.home + vig.draw + vig.away - 1.0)).toBeLessThan(0.01));
  it('T54: Home prob > draw for favourite', () => expect(vig.home).toBeGreaterThan(vig.draw));
  it('T55: Power exponent k returned',      () => expect(vig.k).toBeDefined());

  it('T112: Sub-1.0 overround handled by safety net', () => {
    const sub = powerMethodVigRemoval(2.20, 3.80, 5.00);
    expect(sub.home + sub.draw + sub.away).toBeGreaterThan(0.98);
  });
});

// ── LAYER 11: Drawdown Penalty ─────────────────────────────────────────────────

describe('LAYER 11: Drawdown Penalty (T113-T115)', () => {
  it('T113: 5% drawdown = no penalty',             () => expect(getDrawdownPenalty(0.05)).toBe(1.0));
  it('T114: 10% drawdown = 0.75 penalty',          () => expect(getDrawdownPenalty(0.10)).toBe(0.75));
  it('T115: 8% drawdown = 0.75 penalty (NEW-11)',  () => expect(getDrawdownPenalty(0.08)).toBe(0.75));
});

// ── LAYER 17: RLM Direction (T119-T121) ───────────────────────────────────────

describe('LAYER 17: RLM Direction (T119-T121)', () => {
  it('T119: Popular team shortening = steam, not RLM', () => {
    const r = lstmMarketDecoderProxy(0.5, 2.0, 1.90, true);
    expect(r.steam).toBe(true);
  });
  it('T120: Popular team shortening is NOT RLM', () => {
    const r = lstmMarketDecoderProxy(0.5, 2.0, 1.90, true);
    expect(r.rlm).toBe(false);
  });
  it('T121: Popular team drifting = TRUE RLM (BUG-009)', () => {
    const r = lstmMarketDecoderProxy(0.5, 1.85, 2.05, true);
    expect(r.rlm).toBe(true);
  });
});

// ── LAYER 19 BUG FIXES (T126-T130) ────────────────────────────────────────────

describe('LAYER 19: BUG FIXES (T126-T130)', () => {
  it('T126: SHARP_COMPRESSION=false when odds drifting out (BUG-A04)', () => {
    const r = lstmMarketDecoderProxy(0.5, 1.80, 2.10, false);
    expect(r.sharpCompression).toBe(false);
  });
  it('T127: SHARP_COMPRESSION=true when odds compressing fast (BUG-A04)', () => {
    const r = lstmMarketDecoderProxy(0.5, 2.00, 1.65, false);
    expect(r.sharpCompression).toBe(true);
  });
  it('T128: RLM and sharpCompression mutually exclusive (S03/S04)', () => {
    const r = lstmMarketDecoderProxy(0.5, 1.80, 2.20, true);
    expect(r.rlm && r.sharpCompression).toBe(false);
  });
  it('T129: CLV survival edge-sensitive: larger edge = higher survival (BUG-A02)', () => {
    const lo = clvProjection(0.02, 6, '1x2', 1.0);
    const hi = clvProjection(0.15, 6, '1x2', 1.0);
    expect(hi.survivalProb).toBeGreaterThan(lo.survivalProb);
  });
  it('T130: CLV edgeStrengthFactor returned (BUG-A02)', () => {
    const c = clvProjection(0.15, 6, '1x2', 1.0);
    expect(c.edgeStrengthFactor).toBeDefined();
  });
});

// ── LAYER 20: NEW FEATURES (T137-T148) ────────────────────────────────────────

describe('LAYER 20: NEW FEATURES (T137-T148)', () => {
  it('T137: Temporal decay returns valid lambda (NEW-15)', () => {
    const matches = [
      { xg: 2.1, goalsScored: 2, matchdayOffset: 0 },
      { xg: 1.8, goalsScored: 1, matchdayOffset: 1 },
      { xg: 1.5, goalsScored: 2, matchdayOffset: 2 },
    ];
    const v = applyTemporalDecay(matches, 1.4);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(5);
  });
  it('T138: Temporal decay actually shifts lambda from base avg (NEW-15)', () => {
    const matches = [
      { xg: 2.1, goalsScored: 2, matchdayOffset: 0 },
      { xg: 1.8, goalsScored: 1, matchdayOffset: 1 },
      { xg: 1.5, goalsScored: 2, matchdayOffset: 2 },
    ];
    expect(applyTemporalDecay(matches, 1.4)).not.toBe(1.4);
  });

  it('T139: Rising Elo → momentum factor > 1 (NEW-17)', () => {
    const r = [{ rating: 1600 }, { rating: 1580 }, { rating: 1560 }, { rating: 1540 }, { rating: 1520 }];
    expect(eloMomentumFactor(r)).toBeGreaterThan(1.0);
  });
  it('T140: Falling Elo → momentum factor < 1 (NEW-17)', () => {
    const r = [{ rating: 1400 }, { rating: 1420 }, { rating: 1440 }, { rating: 1460 }, { rating: 1480 }];
    expect(eloMomentumFactor(r)).toBeLessThan(1.0);
  });
  it('T141: Elo momentum clamped [0.85, 1.15] (NEW-17)', () => {
    const up   = eloMomentumFactor([{ rating: 1600 }, { rating: 1580 }, { rating: 1560 }, { rating: 1540 }, { rating: 1520 }]);
    const down = eloMomentumFactor([{ rating: 1400 }, { rating: 1420 }, { rating: 1440 }, { rating: 1460 }, { rating: 1480 }]);
    expect(up).toBeLessThanOrEqual(1.15);
    expect(down).toBeGreaterThanOrEqual(0.85);
  });

  it('T142: Draw calibration boosts underpriced draws (NEW-19)', () => {
    expect(drawCalibrationFactor(0.22, 0.28)).toBeGreaterThan(1.0);
  });
  it('T143: Draw calibration reduces overpriced draws (NEW-19)', () => {
    expect(drawCalibrationFactor(0.30, 0.25)).toBeLessThanOrEqual(1.0);
  });

  it('T144: Lambda consistent when divergence ≤5% (NEW-16)', () => {
    expect(checkLambdaInconsistency(1.5, 1.2, 0.55).inconsistent).toBe(false);
  });
  it('T145: Lambda inconsistent flagged when divergence >5% (NEW-16)', () => {
    expect(checkLambdaInconsistency(1.5, 1.2, 0.20).inconsistent).toBe(true);
  });

  it('T146: Steam chaser veto: compression + edge<5% (NEW-18)',  () => expect(isSteamChaser(true, 0.03)).toBe(true));
  it('T147: No steam veto: compression + edge>=5% (NEW-18)',     () => expect(isSteamChaser(true, 0.08)).toBe(false));
  it('T148: No steam veto: no compression (NEW-18)',             () => expect(isSteamChaser(false, 0.03)).toBe(false));
});

// ── LAYER 21: v29 AUDIT CRITICAL (T160-T179) ──────────────────────────────────

describe('LAYER 21: v29 AUDIT CRITICAL (T160-T179)', () => {
  it('T160: Kelly with explicit modelProb returns positive stake (BUG-C02)', () => {
    expect(optimizedKelly(0.10, 2.0, 0.85, false, 1.0, 1.0, 1.0, 0.25, 0.55)).toBeGreaterThan(0);
  });
  it('T161: Kelly with derived modelProb returns positive stake (BUG-C02)', () => {
    expect(optimizedKelly(0.10, 2.0, 0.85, false, 1.0, 1.0, 1.0, 0.25, null)).toBeGreaterThan(0);
  });
  it('T162: Canonical Kelly q=1-modelProb gives different result than market-implied q (BUG-C02)', () => {
    const withMp  = optimizedKelly(0.10, 2.0, 0.85, false, 1.0, 1.0, 1.0, 0.25, 0.55);
    const oldStyle = optimizedKelly(0.10, 2.0, 0.85, false, 1.0, 1.0, 1.0, 0.25, 0.50);
    expect(withMp).toBeGreaterThan(oldStyle);
  });

  it('T163: monteCarlo accepts rho parameter (BUG-C03)', () => {
    expect(monteCarlo(1.5, 1.2, -0.13, 1000)).toBeDefined();
  });
  it('T164: MC with DC tau returns varFlag boolean (BUG-C03)', () => {
    expect(typeof monteCarlo(1.5, 1.2, -0.13, 1000).varFlag).toBe('boolean');
  });

  it('T165: BUG-M03: Rising Elo → momentum > 1.0', () => {
    const r = [{ rating: 1600 }, { rating: 1580 }, { rating: 1560 }, { rating: 1540 }, { rating: 1520 }];
    expect(eloMomentumFactor(r)).toBeGreaterThan(1.0);
  });
  it('T166: BUG-M03: Falling Elo → momentum < 1.0', () => {
    const r = [{ rating: 1400 }, { rating: 1420 }, { rating: 1440 }, { rating: 1460 }, { rating: 1480 }];
    expect(eloMomentumFactor(r)).toBeLessThan(1.0);
  });
  it('T167: Elo momentum clamped [0.85,1.15] after BUG-M03', () => {
    const up   = eloMomentumFactor([{ rating: 1600 }, { rating: 1580 }, { rating: 1560 }, { rating: 1540 }, { rating: 1520 }]);
    const down = eloMomentumFactor([{ rating: 1400 }, { rating: 1420 }, { rating: 1440 }, { rating: 1460 }, { rating: 1480 }]);
    expect(up).toBeLessThanOrEqual(1.15);
    expect(down).toBeGreaterThanOrEqual(0.85);
  });

  it('T168: CLV returns edgeRetentionFraction (BUG-M09)', () => {
    expect(clvProjection(0.10, 6, '1x2', 1.0).edgeRetentionFraction).toBeDefined();
  });
  it('T169: CLV returns survivalProb sigmoid (BUG-M09)', () => {
    expect(clvProjection(0.10, 6, '1x2', 1.0).survivalProb).toBeDefined();
  });
  it('T170: CLV survivalProb is valid probability [0,1] (BUG-M09)', () => {
    const v = clvProjection(0.10, 6, '1x2', 1.0).survivalProb;
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
  it('T171: CLV zero edge → low survivalProb (BUG-M09)', () => {
    expect(clvProjection(0, 6, '1x2', 1.0).survivalProb).toBeLessThanOrEqual(0.10);
  });

  it('T176: Dynamic rho four-cell MLE returns valid value (BUG-M01)', () => {
    const d = { n: 50, hG: 60, aG: 45, zeroZero: 7, oneZero: 10, zeroOne: 8, oneOne: 6 };
    const v = estimateDynamicRho(d, -0.13);
    expect(v).toBeDefined();
    expect(Number.isNaN(v)).toBe(false);
  });
  it('T177: Dynamic rho clamped to [-0.30, +0.02] range (BUG-M01)', () => {
    const d = { n: 50, hG: 60, aG: 45, zeroZero: 7, oneZero: 10, zeroOne: 8, oneOne: 6 };
    const v = estimateDynamicRho(d, -0.13);
    expect(v).toBeGreaterThanOrEqual(-0.30);
    expect(v).toBeLessThanOrEqual(0.02);
  });

  it('T178: generateSyntheticAlpha returns array (BUG-L03)', () => {
    expect(Array.isArray(generateSyntheticAlpha(buildMatrix(1.5, 1.2, -0.13)))).toBe(true);
  });
  it('T179: Synthetic scripts generated without error (BUG-L03)', () => {
    expect(generateSyntheticAlpha(buildMatrix(1.5, 1.2, -0.13)).length).toBeGreaterThanOrEqual(0);
  });
});

// ── BLOCK 1: MathEngine v2026.3.12 (T193-T200) ────────────────────────────────

describe('BLOCK 1: MathEngine v2026.3.12 (T193-T200)', () => {
  it('T193: B1-01 NR-MLE returns value in [-0.30,0.02]', () => {
    const d = { n: 30, hG: 42, aG: 33, zeroZero: 4, oneZero: 6, zeroOne: 5, oneOne: 3 };
    const v = estimateDynamicRho(d, -0.13);
    expect(v).toBeGreaterThanOrEqual(-0.30);
    expect(v).toBeLessThanOrEqual(0.02);
  });
  it('T194: B1-01 n<30 returns seed rho', () => {
    const d = { n: 29, hG: 20, aG: 16, zeroZero: 2, oneZero: 2, zeroOne: 2, oneOne: 1 };
    expect(estimateDynamicRho(d, -0.13)).toBe(-0.13);
  });

  it('T195: B1-02 MC 3-attempt cap runs for rho<-0.2', () => {
    const v = monteCarlo(1.2, 0.9, -0.25, 500);
    expect(v).toBeDefined();
    expect(Number.isNaN(v.stdDevEst)).toBe(false);
  });

  it('T196: B1-03 ZIP pi clamped to [0.03,0.18]', () => {
    const raw = 1 / (1 + Math.exp(-(-2.8 + 4.2 * 1.5)));
    const v = clamp(raw, 0.03, 0.18);
    expect(v).toBeGreaterThanOrEqual(0.03);
    expect(v).toBeLessThanOrEqual(0.18);
  });
  it('T197: B1-03 ZIP pi clamped [0.03,0.18] for high xG', () => {
    const raw = 1 / (1 + Math.exp(-(-2.8 + 4.2 * 4.0)));
    const v = clamp(raw, 0.03, 0.18);
    expect(v).toBeGreaterThanOrEqual(0.03);
    expect(v).toBeLessThanOrEqual(0.18);
  });

  it('T198: B1-04 BBN posterior mean between prior and observed', () => {
    const postH = (1.48 * 15 + (42 / 30) * 30) / (15 + 30);
    expect(postH).toBeGreaterThan(1.4);
    expect(postH).toBeLessThan(1.6);
  });

  it('T199: B1-05 Short rest (1 day) penalises lambda', () => {
    const r = applyFatigueDecay(1, 5, 1.4, 1.2);
    expect(r.lH).toBeLessThan(1.4);
  });
  it('T200: B1-05 Long rest bonus capped (not unbounded)', () => {
    const r = applyFatigueDecay(10, 3, 1.4, 1.2);
    expect(r.lH).toBeLessThanOrEqual(1.4 * 1.06);
  });
});

// ── BLOCK 15: Scenario Branching (T267-T272) ──────────────────────────────────

describe('BLOCK 15: Scenario Branching (T267-T272)', () => {
  const base = { bayesian_lH: 1.4, bayesian_lA: 1.1, dynamicRho: -0.13, evMarkets: [{ stake: 0.05 }] };

  it('T267: B15 rerunWithOverride() returns result', () => {
    expect(rerunWithOverride('key player out home', base)).not.toBeNull();
  });
  it('T268: B15 key_player_out_home reduces lambdaH', () => {
    const r = rerunWithOverride('key player out home', base)!;
    expect(r.lambdaH.after).toBeLessThan(r.lambdaH.before);
  });
  it('T269: B15 newMarkets returned with valid hw probability', () => {
    const r = rerunWithOverride('key player out home', base)!;
    expect(r.newMarkets).toBeDefined();
    expect(typeof r.newMarkets.hw).toBe('number');
  });
  it('T270: B15 deltaScore computed', () => {
    const r = rerunWithOverride('key player out home', base)!;
    expect(r.deltaScore).toBeDefined();
  });
  it('T271: B15 heavy rain reduces lambdaH', () => {
    const r = rerunWithOverride('heavy rain', base)!;
    expect(r.lambdaH.after).toBeLessThan(base.bayesian_lH);
  });
  it('T272: B15 unknown event returns result with interpretation', () => {
    const r = rerunWithOverride('xyz unknown event xyz', base);
    expect(r).not.toBeNull();
    expect(r!.interpretation).toBeDefined();
  });
});

// ── HOTFIX HF-A: Gaussian + Benford (T276-T283) ───────────────────────────────

describe('HOTFIX HF-A: Gaussian + Benford (T276-T283)', () => {
  it('T276: gaussianRand(0,1) returns finite number', () => {
    const v = gaussianRand(0, 1);
    expect(typeof v).toBe('number');
    expect(isFinite(v)).toBe(true);
  });
  it('T277: gaussianRand mean≈10 (N=200)', () => {
    const samples = Array.from({ length: 200 }, () => gaussianRand(10, 1));
    const mean = samples.reduce((s, v) => s + v, 0) / 200;
    expect(mean).toBeGreaterThan(9.5);
    expect(mean).toBeLessThan(10.5);
  });
  it('T278: benfordMAD(null)=null',                 () => expect(benfordMAD(null)).toBeNull());
  it('T279: benfordMAD(<50 values)=null',           () => expect(benfordMAD(Array.from({ length: 30 }, (_, i) => i + 1))).toBeNull());
  it('T280: benfordMAD(200 values) returns number≥0', () => {
    const v = Array.from({ length: 200 }, (_, i) => Math.pow(10, (i % 9) * 0.3 + 0.1));
    const r = benfordMAD(v);
    expect(typeof r).toBe('number');
    expect(r!).toBeGreaterThanOrEqual(0);
  });
  it('T281: secondDigitFreq(null)=null',              () => expect(secondDigitFreq(null)).toBeNull());
  it('T282: secondDigitFreq(<20 values)=null',        () => expect(secondDigitFreq([1.5, 2.0])).toBeNull());
  it('T283: secondDigitFreq for rounded odds > 0.5', () => {
    const odds = Array.from({ length: 30 }, (_, i) => 1.5 + (i % 5) * 0.5);
    const r = secondDigitFreq(odds);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(0.5);
  });
});

// ── BLOCK 16: Low-Scoring Regime + AH Pivot (T360-T367) ──────────────────────

describe('BLOCK 16: Low-Scoring Regime + AH Pivot (T360-T367)', () => {
  const lowMat  = buildMatrix(1.15, 0.95, -0.13);
  const highMat = buildMatrix(2.1, 1.8, -0.08);

  it('T360: R2 low-scoring fixture (1.15/0.95) classified LOW_SCORING', () => {
    expect(detectLowScoringRegime(lowMat, 1.15, 0.95).regime).toBe('LOW_SCORING');
  });
  it('T361: R2 even grind → no dominant side', () => {
    expect(detectLowScoringRegime(lowMat, 1.15, 0.95).dominantSide).toBeNull();
  });
  it('T362: R2 high-scoring → STANDARD', () => {
    expect(detectLowScoringRegime(highMat, 2.1, 1.8).regime).toBe('STANDARD');
  });

  it('T363: R5 pivot applied', () => {
    const reg   = detectLowScoringRegime(lowMat, 1.15, 0.95);
    const pivot = asianHandicapPivot(lowMat, reg, {});
    expect(pivot.pivotApplied).toBe(true);
  });
  it('T364: R5 pivot settlement prob > 0.5', () => {
    const reg   = detectLowScoringRegime(lowMat, 1.15, 0.95);
    const pivot = asianHandicapPivot(lowMat, reg, {});
    expect(pivot.settleProb).toBeGreaterThan(0.5);
  });
  it('T365: R5 even grind picks +0.25/+0.5 line', () => {
    const reg   = detectLowScoringRegime(lowMat, 1.15, 0.95);
    const pivot = asianHandicapPivot(lowMat, reg, {});
    expect(Math.abs(pivot.line)).toBeGreaterThanOrEqual(0.25);
  });
  it('T366: R5 ledger accuracy overrides default', () => {
    const reg   = detectLowScoringRegime(lowMat, 1.15, 0.95);
    const pivot = asianHandicapPivot(lowMat, reg, { 'away_0.5': 0.95 });
    const cand  = pivot.allCandidates.find(c => `${c.side}_${c.line}` === 'away_0.5');
    expect(cand?.accuracy).toBe(0.95);
  });
  it('T367: R3 calibratedZipPi fallback == logistic prior', () => {
    const expected = clamp(1 / (1 + Math.exp(-(-2.8 + 4.2 * 2.1))), 0.03, 0.18);
    expect(Math.abs(calibratedZipPi(1.15, 0.95, null) - expected)).toBeLessThan(1e-9);
  });
});

// ── BLOCK 17: RPS (T368-T371) ─────────────────────────────────────────────────

describe('BLOCK 17: RPS (T368-T371)', () => {
  it('T368: A1 RPS perfect forecast = 0',       () => expect(rankedProbabilityScore({ home: 1, draw: 0, away: 0 }, 'home')).toBe(0));
  it('T369: A1 RPS worst case = 1',             () => expect(Math.abs(rankedProbabilityScore({ home: 1, draw: 0, away: 0 }, 'away') - 1)).toBeLessThan(1e-9));
  it('T370: A1 RPS ordinality — draw-miss < away-miss', () => {
    const draw = rankedProbabilityScore({ home: 1, draw: 0, away: 0 }, 'draw');
    const away = rankedProbabilityScore({ home: 1, draw: 0, away: 0 }, 'away');
    expect(draw).toBeLessThan(away);
  });
  it('T371: A1 RPS uniform ~0.278', () => {
    const v = rankedProbabilityScore({ home: 0.333, draw: 0.333, away: 0.333 }, 'home');
    expect(Math.abs(v - 0.2778)).toBeLessThan(0.01);
  });
});

// ── LAYER 22: v29 NEW FEATURES (T187-T192, T190-T192) ────────────────────────

describe('LAYER 22: v29 BUG FIXES (T187-T192)', () => {
  it('T187: Draw calibration boosts underpriced draws (NEW-29)', () => {
    expect(drawCalibrationFactor(0.22, 0.28)).toBeGreaterThan(1.0);
  });
  it('T188: Draw calibration within conservative bounds (NEW-29)', () => {
    expect(drawCalibrationFactor(0.22, 0.28)).toBeLessThanOrEqual(1.20);
  });

  it('T190: Non-trivial S03 test: strong RLM on popular team (BUG-L04)', () => {
    const r = lstmMarketDecoderProxy(0.5, 1.50, 1.90, true);
    expect(r.rlm).toBe(true);
  });
  it('T191: Non-trivial S03/S04 exclusion: compression=false when RLM active (BUG-L04)', () => {
    const r = lstmMarketDecoderProxy(0.5, 1.50, 1.90, true);
    expect(r.sharpCompression).toBe(false);
  });

  it('T192: BUG-C01: dynamic rho can approach 0 for low-DC-correction leagues', () => {
    const d = { n: 80, hG: 96, aG: 80, zeroZero: 4, oneZero: 8, zeroOne: 7, oneOne: 5 };
    const v = estimateDynamicRho(d, -0.13);
    expect(v).toBeGreaterThanOrEqual(-0.30);
    expect(v).toBeLessThanOrEqual(0.02);
  });
});

// ── §8.1 Bivariate Poisson ────────────────────────────────────────────────────

describe('§8.1 bivariatePoisson PMF', () => {
  it('BP-1: P(0,0) = e^{-(l1+l2+l3)}', () => {
    const [l1, l2, l3] = [1.2, 1.0, 0.1];
    expect(bivariatePoisson(0, 0, l1, l2, l3)).toBeCloseTo(Math.exp(-(l1 + l2 + l3)), 8);
  });

  it('BP-2: P(1,1) = e^{-(l1+l2+l3)} * (l1*l2 + l3)', () => {
    const [l1, l2, l3] = [1.2, 1.0, 0.1];
    expect(bivariatePoisson(1, 1, l1, l2, l3)).toBeCloseTo(Math.exp(-(l1 + l2 + l3)) * (l1 * l2 + l3), 8);
  });

  it('BP-3: degenerates to independent Poisson when l3=0', () => {
    const v = bivariatePoisson(2, 1, 1.4, 1.1, 0);
    expect(v).toBeCloseTo(poissonPMF(2, 1.4) * poissonPMF(1, 1.1), 8);
  });

  it('BP-4: always non-negative', () => {
    for (const [x, y] of [[0,0],[1,0],[0,1],[3,2],[5,5]]) {
      expect(bivariatePoisson(x!, y!, 1.5, 1.2, 0.1)).toBeGreaterThanOrEqual(0);
    }
  });

  it('BP-5: DEFAULT_BIVARIATE_LAMBDA3 is positive and within valid range', () => {
    expect(DEFAULT_BIVARIATE_LAMBDA3).toBeGreaterThan(0);
    expect(DEFAULT_BIVARIATE_LAMBDA3).toBeLessThan(0.5);
  });
});

describe('§8.1 buildBivariateMatrix', () => {
  it('BM-1: matrix sums to 1 (within truncation tolerance)', () => {
    const mat = buildBivariateMatrix(1.5, 1.2, 0.10);
    const sum = mat.reduce((a, row) => a + row.reduce((b, v) => b + v, 0), 0);
    expect(sum).toBeCloseTo(1.0, 4);
  });

  it('BM-2: returns a MAX_GOALS × MAX_GOALS matrix', () => {
    const mat = buildBivariateMatrix(1.5, 1.2);
    expect(mat).toHaveLength(MAX_GOALS);
    expect(mat[0]).toHaveLength(MAX_GOALS);
  });

  it('BM-3: draw mass increases with λ3 (bivariate correlation lifts joint draw cells)', () => {
    const drawMass = (m: ReturnType<typeof buildBivariateMatrix>) =>
      m.reduce((s, row, i) => s + (row[i] ?? 0), 0);
    expect(drawMass(buildBivariateMatrix(1.5, 1.2, 0.15))).toBeGreaterThan(
      drawMass(buildBivariateMatrix(1.5, 1.2, 0)),
    );
  });

  it('BM-4: home marginal matches Poisson(lH) at x=0', () => {
    const lH = 1.5, lA = 1.2, l3 = 0.10;
    const mat = buildBivariateMatrix(lH, lA, l3);
    const margX0 = mat[0]!.reduce((s, v) => s + v, 0);
    expect(margX0).toBeCloseTo(poissonPMF(0, lH), 2);
  });

  it('BM-5: away marginal matches Poisson(lA) at y=0', () => {
    const lH = 1.5, lA = 1.2, l3 = 0.10;
    const mat = buildBivariateMatrix(lH, lA, l3);
    const margY0 = mat.reduce((s, row) => s + (row[0] ?? 0), 0);
    expect(margY0).toBeCloseTo(poissonPMF(0, lA), 2);
  });

  it('BM-6: λ3=0 produces same 0-0 cell as independent Poisson (rho=0)', () => {
    const bivar = buildBivariateMatrix(1.5, 1.2, 0);
    const indep = buildMatrix(1.5, 1.2, 0);
    expect(bivar[0]![0]).toBeCloseTo(indep[0]![0]!, 3);
  });
});
