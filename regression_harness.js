// ═══════════════════════════════════════════════════════════════════════════
// ORACLE v2026.6.0 — REGRESSION HARNESS (Phase 0, BLOCKING)
// Establishes baseline metrics on resolved ledger, then gates every TUNE block.
// Run: node regression_harness.js
// ═══════════════════════════════════════════════════════════════════════════

const clamp = (v, lo, hi) => (v == null || Number.isNaN(v)) ? lo : Math.max(lo, Math.min(hi, v));

// ── Stake-path variants ──────────────────────────────────────────────────────
// BASELINE (current engine): wrong Kelly q=1-mp, × softmax blend, × penalty PRODUCT
function kellyBaseline(edge, odds, fraction, mp) {
  if (edge <= 0 || odds <= 1) return 0;
  const q = 1 - mp; if (q <= 0) return 0;
  return clamp((edge / q) * fraction, 0, 0.15);
}
// CANDIDATE (B0): correct Kelly f* = (p*o-1)/(o-1)
function kellyCorrect(edge, odds, fraction, mp) {
  if (edge <= 0 || odds <= 1) return 0;
  const b = odds - 1; if (b <= 0) return 0;
  const fStar = (mp * odds - 1) / b; if (fStar <= 0) return 0;
  return clamp(fStar * fraction, 0, 0.15);
}
function softmaxBlend(stake, ev) {
  const s = Math.round(ev * 80);
  const sm = Math.max(0, 1 / (1 + Math.exp(-s / 8)) - 0.5);
  return clamp(stake * 0.60 + (sm * stake * 2) * 0.40, 0, 0.25);
}
// Penalty stacks
const penaltyProduct = (dd, xg, regime, lee) => dd * xg * regime * lee;          // baseline (V1-E bug)
const penaltyMin     = (dd, xg, regime, lee) => clamp(Math.min(dd, Math.min(1.0, regime), lee) * xg, 0.10, 1.0); // B1 fix

// ── Stake-path configs under test ────────────────────────────────────────────
function stakePath(cfg, bet) {
  const { edge, odds, mp, ev, dd, xg, regime, lee, dqs = 0.85, council = false, varMult = 1.0, calib = 0.9 } = bet;
  const penaltyMod = council ? 0.5 : 1.0;
  const ddFinal = cfg.penalty === 'min' ? penaltyMin(dd, xg, regime, lee) : penaltyProduct(dd, xg, regime, lee);
  const fraction = 0.25 * dqs * penaltyMod * varMult * ddFinal * calib;
  let stake = (cfg.kelly === 'correct' ? kellyCorrect : kellyBaseline)(edge, odds, fraction, mp);
  if (cfg.softmax) stake = softmaxBlend(stake, ev);
  return stake;
}

// ── RegressionHarness ─────────────────────────────────────────────────────────
const RegressionHarness = {
  run: function (bets, cfg, label) {
    let staked = 0, pnl = 0, brierSum = 0, n = 0, equity = 0, peak = 0, maxDD = 0;
    let rpsSum = 0, rpsN = 0;
    const ll = [];
    const rpsScore = (fc, outcome) => {
      const order = ['home','draw','away'];
      const p = order.map(o => Math.max(0, fc?.[o] || 0));
      const ps = p.reduce((a,c)=>a+c,0) || 1; const pf = p.map(v=>v/ps);
      const e = order.map(o => (o === outcome ? 1 : 0));
      let r = 0, cp = 0, ce = 0;
      for (let i=0;i<2;i++){ cp+=pf[i]; ce+=e[i]; r+=(cp-ce)**2; }
      return r/2;
    };
    for (const b of bets) {
      if (b.mp == null || b.outcomeBinary == null) continue;
      n++;
      brierSum += (b.mp - b.outcomeBinary) ** 2;
      ll.push(-(b.outcomeBinary * Math.log(Math.max(1e-9, b.mp)) +
                (1 - b.outcomeBinary) * Math.log(Math.max(1e-9, 1 - b.mp))));
      // RPS if a full 1X2 forecast + result outcome is present on the bet
      if (b.fp && b.result1x2) { rpsSum += rpsScore(b.fp, b.result1x2); rpsN++; }
      const stake = stakePath(cfg, b);
      staked += stake;
      const r = b.outcomeBinary ? stake * (b.odds - 1) : -stake;
      pnl += r; equity += r; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity);
    }
    return {
      label, n,
      roi: staked > 0 ? pnl / staked : 0,
      brier: n > 0 ? brierSum / n : null,
      rps: rpsN > 0 ? rpsSum / rpsN : null,
      logloss: ll.length ? ll.reduce((a, c) => a + c, 0) / ll.length : null,
      maxDrawdown: maxDD, totalStaked: staked, totalPnl: pnl,
      avgStake: n > 0 ? staked / n : 0,
    };
  },
  passes: function (base, cand, gate) {
    const TOL = 0.02;
    switch (gate) {
      case 'ROI_DD':  return cand.roi >= base.roi * (1 - TOL) && cand.maxDrawdown <= base.maxDrawdown * (1 + TOL);
      case 'BRIER':   return cand.brier <= base.brier * (1 + TOL);
      case 'RPS':     return cand.rps != null && base.rps != null && cand.rps <= base.rps * (1 + TOL);
      case 'LOGLOSS': return cand.logloss <= base.logloss * (1 + TOL);
      case 'EV_VETO': return (cand.roi - base.roi) >= -TOL;
      default: return false;
    }
  },
  // C2 — DRAW-CALIBRATION DIAGNOSTIC. The foundational Dixon-Coles result is that
  // independent Poisson UNDER-predicts draws; the τ correction addresses it, but the
  // bias is scoreline-specific and can persist mildly. This compares the model's mean
  // predicted draw probability against the realised draw frequency, per league. A large
  // gap (|pred - realised| > 0.03) means the draw calibration needs attention.
  drawCalibration: function (bets) {
    const byLeague = {};
    for (const b of (bets || [])) {
      if (!b.fp || !b.result1x2) continue;
      const lg = b.league || '_global';
      byLeague[lg] = byLeague[lg] || { predSum: 0, realised: 0, n: 0 };
      byLeague[lg].predSum += (b.fp.draw || 0);
      byLeague[lg].realised += (b.result1x2 === 'draw' ? 1 : 0);
      byLeague[lg].n += 1;
    }
    const report = {};
    for (const [lg, d] of Object.entries(byLeague)) {
      if (d.n < 10) continue;
      const predDraw = d.predSum / d.n, realDraw = d.realised / d.n;
      report[lg] = {
        n: d.n, predictedDrawRate: +predDraw.toFixed(4), realisedDrawRate: +realDraw.toFixed(4),
        gap: +(realDraw - predDraw).toFixed(4),
        miscalibrated: Math.abs(realDraw - predDraw) > 0.03,
      };
    }
    return report;
  }
};

// ── Synthetic resolved ledger (stand-in for real ledger; deterministic) ───────
// In production this loads from CalibrationEngine.load().filter(resolved).
// Each bet: model prob mp, decimal odds, realized outcome, EV, drawdown context.
function makeLedger(seed = 1, N = 200) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const bets = [];
  for (let i = 0; i < N; i++) {
    const mp = 0.30 + rnd() * 0.45;             // model prob 0.30–0.75
    const trueEdge = (rnd() - 0.45) * 0.18;      // small + or - edge
    const fairOdds = 1 / mp;
    const odds = clamp(fairOdds * (1 + trueEdge), 1.2, 8.0); // odds embed the edge
    const ev = mp * odds - 1;
    // realized outcome ~ Bernoulli(mp) (model is roughly calibrated)
    const outcomeBinary = rnd() < mp ? 1 : 0;
    // drawdown regime drifts
    const dd = clamp(0.05 + 0.3 * Math.sin(i / 25), 0, 0.4);
    bets.push({
      mp, odds, ev, edge: ev, outcomeBinary,
      dd, xg: 0.9, regime: 0.85 + rnd() * 0.2, lee: 0.85 + rnd() * 0.15,
    });
  }
  return bets.filter(b => b.ev > 0); // only +EV bets are staked
}

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTE: baseline vs candidate arms (B0+B1)
// ═══════════════════════════════════════════════════════════════════════════
const ledger = makeLedger(7, 400);
console.log(`\nResolved +EV ledger size: ${ledger.length}\n`);

const baseline = RegressionHarness.run(ledger,
  { kelly: 'baseline', softmax: true, penalty: 'product' }, 'BASELINE (current engine)');

const armA = RegressionHarness.run(ledger,
  { kelly: 'correct', softmax: true, penalty: 'min' }, 'B0+B1 softmax-ON  min-stack');
const armB = RegressionHarness.run(ledger,
  { kelly: 'correct', softmax: false, penalty: 'min' }, 'B0+B1 softmax-OFF min-stack');

const fmt = r => `${r.label.padEnd(34)} | ROI ${(r.roi*100).toFixed(2).padStart(6)}% | DD ${r.maxDrawdown.toFixed(4)} | avgStake ${r.avgStake.toFixed(4)} | Brier ${r.brier.toFixed(4)} | logloss ${r.logloss.toFixed(4)}`;
console.log(fmt(baseline));
console.log(fmt(armA));
console.log(fmt(armB));

console.log('\n── B1 GATE (ROI_DD) ──');
const aPass = RegressionHarness.passes(baseline, armA, 'ROI_DD');
const bPass = RegressionHarness.passes(baseline, armB, 'ROI_DD');
console.log(`armA softmax-ON  passes: ${aPass}`);
console.log(`armB softmax-OFF passes: ${bPass}`);

// Decision logic per PRD §5: ship the passing arm with best ROI_DD; else escalate.
let decision;
const candidates = [armA, armB].filter((r, i) => (i === 0 ? aPass : bPass));
if (candidates.length === 0) {
  decision = 'ESCALATE — no correct-Kelly arm passes vs (buggy) baseline. Human review required.';
} else {
  candidates.sort((x, y) => (y.roi - x.roi) || (x.maxDrawdown - y.maxDrawdown));
  const winner = candidates[0];
  decision = `SHIP: ${winner.label}  (softmax ${winner.label.includes('OFF') ? 'REMOVED' : 'KEPT'})`;
}
console.log(`\nDECISION: ${decision}\n`);

// Brier/logloss are stake-path-independent (same mp), sanity-check they match across arms:
console.log(`Brier identical across arms (stake-independent): ${baseline.brier === armA.brier && armA.brier === armB.brier}`);

module.exports = { RegressionHarness, kellyCorrect, kellyBaseline };
