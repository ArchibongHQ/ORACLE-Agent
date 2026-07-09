# SOP: Walk-Forward Backtest

## Objective
Evaluate a candidate quant-core change (lambda model, Dixon-Coles τ, Kelly fraction, or
ranking-mode default) against a held-out historical window using strict walk-forward
discipline. No change ships on a point-estimate improvement — it must clear the §8.3
significance accept-gate (bootstrap CI + effect-size floor).

## Tool
`tools/walkforward_backtest.py`

## Required inputs
- Backfilled GBrain ledger (run `workflows/backfill.md` first)
- Candidate change description (passed as `--label "description"`)
- `--train-end YYYY-MM-DD` — cutoff between training and test data
- `--test-end YYYY-MM-DD` — end of the holdout period
- `--metric rps` (default) or `accuracy`

## Walk-forward discipline
The harness enforces strict temporal ordering:
1. Train window: all records with `kickoff < train_end`
2. Test window: records with `train_end ≤ kickoff ≤ test_end`
3. The candidate model is configured from train-window data only; no test data touches parameters
4. At each test date, only data timestamped before that date feeds the engine

## Steps

1. **Load** analysis + resolution records from GBrain
2. **Split** into train/test by date
3. **Compute baseline** RPS on the test window using current model parameters
4. **Apply candidate change** (passed as a JSON config delta: `--config-delta '{"useBivariatePoisson":true}'`)
5. **Compute candidate** RPS on the same test window
6. **Run significance accept-gate** (`significanceAcceptGate(baseline, candidate, { minN: 300, effectSizeFloor: 0.002 })`)
7. **Report**: delta, 95% CI, accept/reject verdict, n, effect size

## Output report (stdout + `.tmp/backtest/YYYYMMDD_<label>.json`)
```json
{
  "label": "bivariate_poisson_lambda3_0.10",
  "trainEnd": "2026-04-01",
  "testEnd": "2026-06-01",
  "n": 312,
  "baselineRPS": 0.2187,
  "candidateRPS": 0.2164,
  "delta": -0.0023,
  "ciLower": -0.0041,
  "ciUpper": -0.0005,
  "effectSize": 0.0023,
  "accept": true,
  "reason": "ACCEPTED: Δ=-0.00230, 95% CI=[-0.00410, -0.00050], n=312"
}
```

## Significance gate parameters (§8.3)
| Parameter | Default | Notes |
|---|---|---|
| `minN` | 300 | [PR-16] Raised from 30 — n=30 is too thin to reliably resolve a delta this small via bootstrap CI without mistaking noise for signal. Hard floor; never lower for a core-param change |
| `effectSizeFloor` | 0.002 | ~1% of the RPS frontier (≈0.21); smaller gains don't justify complexity |
| `alpha` | 0.95 | 95% two-sided CI |
| `nBootstrap` | 1000 | More = slower but tighter CI; 500 sufficient for screening |

## Rules
- **NEVER** auto-apply a passing result — the report is advisory; a human reviews and applies
- **NEVER** tune the pooling constant `k` or min-N floor with the optimizer (§8.4 overfitting rule)
- A REJECTED result is still useful: it means the change isn't reliably better on this window
- Re-test on a fresh window before claiming improvement if the test window has been seen before

## Acceptance criteria
- The harness reproduces the same RPS values (±0.0001) when run twice on the same data
- The CI is correctly computed: running on a known synthetic dataset matches the expected interval
- All output records carry the train/test split dates for reproducibility
