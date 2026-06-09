"""
walkforward_backtest.py — Walk-forward quant-core backtest harness (PRD §8.4).

Loads AnalysisRecord + ResolutionRecord pairs from the GBrain ledger, splits them
into train/test windows by date, evaluates a candidate config delta against the
baseline, and runs the §8.3 significance accept-gate (bootstrap CI on RPS delta).

No model parameter is ever auto-applied — the report is advisory; a human reviews
and applies any accepted change.

Usage:
    python tools/walkforward_backtest.py
    python tools/walkforward_backtest.py --train-end 2026-04-01 --test-end 2026-06-01
    python tools/walkforward_backtest.py --config-delta '{"useBivariatePoisson": true}'
    python tools/walkforward_backtest.py --min-n 50 --effect-size-floor 0.003
    python tools/walkforward_backtest.py --dry-run     # report split sizes only
    python tools/walkforward_backtest.py --store-dir .tmp/oracle-store

Significance gate (PRD §8.3):
    Accept if: n >= minN  AND  |delta| >= effectSizeFloor  AND  CI_upper < 0
    (for RPS: lower is better, so improvement = negative delta)
"""

import argparse
import json
import math
import os
import random
import sys
from datetime import datetime, timezone
from pathlib import Path


# ── Storage helpers (reads MemoryAdapter JSON files) ─────────────────────────

def _load_json(store_dir: Path, key: str):
    path = store_dir / f"{key.replace(':', '_')}.json"
    if not path.exists():
        return []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def load_records(store_dir: Path):
    """Returns (analysis_records, resolution_records) as lists of dicts."""
    analysis   = _load_json(store_dir, "oracle_v2026_analysis")
    resolution = _load_json(store_dir, "oracle_v2026_resolution")
    return analysis, resolution


# ── RPS computation ───────────────────────────────────────────────────────────

def rps(probs: dict, outcome: str) -> float:
    """Ranked Probability Score — lower is better (PRD §2.3 primary metric)."""
    outcomes = ["home", "draw", "away"]
    p = [probs.get(o, 0.0) for o in outcomes]
    actual = [1.0 if o == outcome else 0.0 for o in outcomes]
    cum_p = [sum(p[:i+1]) for i in range(len(p))]
    cum_a = [sum(actual[:i+1]) for i in range(len(actual))]
    return sum((cp - ca) ** 2 for cp, ca in zip(cum_p, cum_a)) / (len(outcomes) - 1)


# ── Significance accept-gate (§8.3) ──────────────────────────────────────────

def significance_accept_gate(
    baseline: list,
    candidate: list,
    min_n: int = 30,
    effect_size_floor: float = 0.002,
    alpha: float = 0.95,
    n_bootstrap: int = 1000,
) -> dict:
    """
    Bootstrap CI on the delta (candidate - baseline).
    Accepts if: n >= min_n AND |delta| >= floor AND CI_upper < 0.
    For RPS: negative delta = improvement.
    """
    n = min(len(baseline), len(candidate))
    if n < min_n:
        return {
            "accept": False, "delta": None, "ci_lower": None, "ci_upper": None,
            "n": n, "effect_size": None,
            "reason": f"INSUFFICIENT_SAMPLES (n={n} < min_n={min_n})",
        }

    delta = sum(c - b for b, c in zip(baseline, candidate)) / n
    effect_size = abs(delta)

    if effect_size < effect_size_floor:
        return {
            "accept": False, "delta": delta, "ci_lower": None, "ci_upper": None,
            "n": n, "effect_size": effect_size,
            "reason": f"BELOW_EFFECT_SIZE_FLOOR (|d|={effect_size:.5f} < floor={effect_size_floor})",
        }

    diffs = [c - b for b, c in zip(baseline, candidate)]
    boot_deltas = sorted(
        sum(random.choices(diffs, k=n)) / n
        for _ in range(n_bootstrap)
    )
    tail = (1 - alpha) / 2
    ci_lower = boot_deltas[int(n_bootstrap * tail)]
    ci_upper = boot_deltas[min(int(n_bootstrap * (1 - tail)), n_bootstrap - 1)]

    accept = ci_upper < 0
    if accept:
        reason = f"ACCEPTED: d={delta:.5f}, 95% CI=[{ci_lower:.5f}, {ci_upper:.5f}], n={n}"
    else:
        reason = (
            f"REJECTED: CI upper {ci_upper:.5f} >= 0 "
            f"— delta not reliably negative at {alpha*100:.0f}% confidence"
        )

    return {
        "accept": accept,
        "delta": round(delta, 6),
        "ci_lower": round(ci_lower, 6),
        "ci_upper": round(ci_upper, 6),
        "n": n,
        "effect_size": round(effect_size, 6),
        "reason": reason,
    }


# ── Pair analysis + resolution records ───────────────────────────────────────

def pair_records(analysis_records: list, resolution_records: list, train_end: str, test_end: str):
    """
    Returns (train_pairs, test_pairs) where each pair is (analysis, resolution).
    Only includes pairs where both records exist and have valid probabilities + outcome.
    """
    res_by_fixture = {r["fixtureId"]: r for r in resolution_records if "fixtureId" in r}
    train, test = [], []
    for a in analysis_records:
        fid = a.get("fixtureId")
        if not fid or fid not in res_by_fixture:
            continue
        r = res_by_fixture[fid]
        outcome = r.get("result", {}).get("outcome") or r.get("actualResult")
        if not a.get("probabilities") or not outcome:
            continue
        kickoff = a.get("kickoff", "")[:10]
        pair = (a, r)
        if kickoff < train_end:
            train.append(pair)
        elif kickoff <= test_end:
            test.append(pair)
    return train, test


# ── Baseline RPS (current model) ─────────────────────────────────────────────

def compute_rps_series(pairs: list) -> list:
    """Computes per-fixture RPS from stored probabilities vs actual outcome."""
    scores = []
    for a, r in pairs:
        probs   = a.get("probabilities", {})
        outcome = r.get("result", {}).get("outcome") or r.get("actualResult") or ""
        if outcome in ("home", "draw", "away") and probs:
            scores.append(rps(probs, outcome))
    return scores


# ── Candidate RPS (apply config delta — currently only flag-based changes) ───

def compute_candidate_rps_series(pairs: list, config_delta: dict) -> list:
    """
    Applies a config delta and re-evaluates RPS.
    For flag-only changes (e.g. useBivariatePoisson), we cannot re-run the TS engine
    from Python, so we report that a live re-run is required for non-trivial deltas.

    For trivial deltas (no model-output-changing flags set), the candidate equals baseline.
    """
    model_flags = {"useBivariatePoisson", "useSkellam", "enableCalibratedZip",
                   "quarantineMarketVelocity", "rankingMode"}
    if any(k in config_delta for k in model_flags):
        print(
            f"[backtest] Config delta {config_delta} changes model output. "
            "Re-run with --rerun-engine to execute the full TS engine per fixture "
            "(requires Node.js; not yet implemented in this Python harness).\n"
            "[backtest] Falling back to stored probabilities — candidate = baseline for this run.",
            file=sys.stderr,
        )
    return compute_rps_series(pairs)


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="ORACLE walk-forward backtest (PRD §8.4)")
    parser.add_argument("--store-dir",          default=".tmp/oracle-store",
                        help="Path to MemoryAdapter store directory")
    parser.add_argument("--train-end",           default=None,
                        help="Cutoff date YYYY-MM-DD (exclusive end of training window)")
    parser.add_argument("--test-end",            default=None,
                        help="End of test window YYYY-MM-DD (inclusive)")
    parser.add_argument("--config-delta",        default="{}", type=json.loads,
                        help="JSON config change to evaluate, e.g. '{\"useBivariatePoisson\": true}'")
    parser.add_argument("--label",              default="candidate",
                        help="Human-readable label for this comparison")
    parser.add_argument("--min-n",              default=30, type=int)
    parser.add_argument("--effect-size-floor",  default=0.002, type=float)
    parser.add_argument("--n-bootstrap",        default=1000, type=int)
    parser.add_argument("--dry-run",            action="store_true",
                        help="Report split sizes and exit without running the gate")
    parser.add_argument("--out-dir",            default=".tmp/backtest",
                        help="Directory for JSON report output")
    args = parser.parse_args()

    store_dir = Path(args.store_dir)
    if not store_dir.exists():
        print(f"[backtest] Store dir {store_dir} not found — run backfill first.", file=sys.stderr)
        sys.exit(1)

    today      = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    train_end  = args.train_end  or today
    test_end   = args.test_end   or today

    print(f"[backtest] Loading records from {store_dir}")
    analysis, resolution = load_records(store_dir)
    print(f"[backtest] {len(analysis)} analysis records, {len(resolution)} resolution records")

    train_pairs, test_pairs = pair_records(analysis, resolution, train_end, test_end)
    print(f"[backtest] Split: {len(train_pairs)} train pairs, {len(test_pairs)} test pairs")

    if args.dry_run:
        print("[backtest] --dry-run: exiting after split report.")
        return

    if len(test_pairs) == 0:
        print("[backtest] No test pairs — check date range or run backfill.", file=sys.stderr)
        sys.exit(1)

    baseline_rps  = compute_rps_series(test_pairs)
    candidate_rps = compute_candidate_rps_series(test_pairs, args.config_delta)

    if not baseline_rps:
        print("[backtest] No valid RPS scores in test window.", file=sys.stderr)
        sys.exit(1)

    baseline_mean  = sum(baseline_rps)  / len(baseline_rps)
    candidate_mean = sum(candidate_rps) / len(candidate_rps)

    gate = significance_accept_gate(
        baseline_rps, candidate_rps,
        min_n=args.min_n,
        effect_size_floor=args.effect_size_floor,
        n_bootstrap=args.n_bootstrap,
    )

    report = {
        "label":          args.label,
        "configDelta":    args.config_delta,
        "trainEnd":       train_end,
        "testEnd":        test_end,
        "trainPairs":     len(train_pairs),
        "n":              gate["n"],
        "baselineRPS":    round(baseline_mean,  6),
        "candidateRPS":   round(candidate_mean, 6),
        **gate,
        "generatedAt":    datetime.now(timezone.utc).isoformat(),
    }

    # Print summary
    print(f"\n{'='*60}")
    print(f"  Walk-Forward Backtest: {args.label}")
    print(f"  Train: up to {train_end}  |  Test: {train_end} -> {test_end}  |  n={gate['n']}")
    print(f"  Baseline RPS:  {baseline_mean:.5f}")
    print(f"  Candidate RPS: {candidate_mean:.5f}")
    print(f"  dRPS:          {gate['delta']}")
    print(f"  95% CI:        [{gate['ci_lower']}, {gate['ci_upper']}]")
    print(f"  Effect size:   {gate['effect_size']}")
    print(f"  Verdict:       {'ACCEPTED' if gate['accept'] else 'REJECTED'}")
    print(f"  {gate['reason']}")
    print(f"{'='*60}\n")

    # Write JSON report
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug    = args.label.replace(" ", "_")[:40]
    outpath = out_dir / f"{today}_{slug}.json"
    with open(outpath, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(f"[backtest] Report -> {outpath}")

    if not gate["accept"]:
        sys.exit(2)  # non-zero exit so CI can detect rejection


if __name__ == "__main__":
    main()
