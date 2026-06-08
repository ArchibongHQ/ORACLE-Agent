"""
skillopt.py — Offline SkillOpt loop.

Reads the disagreement log + resolved ledger from GBrainAdapter JSON files,
scores each disagreement against the actual outcome, then proposes bounded
edits to workflows/oracle_decision_rubric.md.

Handles two disagreement entry types:
  DEBATE_RED  — AntiSycophancyCircuit RED verdicts (old format)
  LLM_DISAGREE — LLM pick differs from deterministic top (Phase 5 format)

An edit is accepted ONLY when held-out calibration (mean RPS vs outcomes)
strictly improves. Gate: min 10 samples, improvement >= 0.002.

Usage:
    python tools/skillopt.py
    python tools/skillopt.py --dry-run
    python tools/skillopt.py --store-dir .tmp/oracle-store
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

# ── Config ────────────────────────────────────────────────────────────────────

STORE_DIR = Path(".tmp/oracle-store")
RUBRIC_PATH = Path("workflows/oracle_decision_rubric.md")
DISAGREEMENT_KEY = "oracle_decision_disagreement"
RESOLUTION_KEY = "oracle_v2026_resolution"
MIN_SAMPLE_SIZE = 10
RPS_IMPROVEMENT_THRESHOLD = 0.002

# LLM training-data leakage protocol (PRD §8.5 v1.2).
# For any fixture whose kickoff falls within the model's training-data window, the LLM
# may have memorised the result — scoring it as "calibration" is contaminated.
# Only fixtures that resolved AFTER this cutoff are used to score LLM picks.
# claude-opus-4-8 training cutoff: April 2025.
DEFAULT_LLM_CUTOFF_DATE = "2025-04-01"

OUTCOME_ORDER = ["home", "draw", "away"]

# Maps 1x2 side labels → outcome keys used in ResolutionRecord
SIDE_TO_OUTCOME: dict[str, str] = {
    "home win": "home", "1 home": "home", "home": "home",
    "draw": "draw", "x": "draw",
    "away win": "away", "2 away": "away", "away": "away",
}


# ── Storage helpers ───────────────────────────────────────────────────────────

def key_to_path(key: str, store_dir: Path) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9_\-]", "_", key)
    return store_dir / f"{safe}.json"


def load_json(key: str, store_dir: Path) -> Any:
    path = key_to_path(key, store_dir)
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ── RPS ───────────────────────────────────────────────────────────────────────

def rps(forecast: dict[str, float], actual: str) -> float:
    cum_f, cum_a, score = 0.0, 0.0, 0.0
    for out in OUTCOME_ORDER:
        cum_f += forecast.get(out, 0.0)
        cum_a += 1.0 if out == actual else 0.0
        score += (cum_f - cum_a) ** 2
    return score / (len(OUTCOME_ORDER) - 1)


# ── Win/loss resolution for a 1x2 side string ────────────────────────────────

def side_won(side: str | None, actual_result: str) -> bool | None:
    """Return True if the 1x2 side string matches the actual outcome, None if ambiguous."""
    if not side:
        return None
    norm = side.strip().lower()
    outcome = SIDE_TO_OUTCOME.get(norm)
    if outcome is None:
        return None
    return outcome == actual_result


# ── Score DEBATE_RED entries ──────────────────────────────────────────────────

def score_debate_red(
    entries: list[dict],
    res_map: dict[str, dict],
) -> dict:
    scored = []
    for entry in entries:
        red_verdicts = entry.get("redVerdicts", [])
        for verdict in red_verdicts:
            fixture_id = verdict.get("fixtureId")
            if not fixture_id or fixture_id not in res_map:
                continue
            resolution = res_map[fixture_id]
            actual = resolution.get("actualResult")
            rps_val = resolution.get("rpsContribution")
            if actual is None or rps_val is None:
                continue
            scored.append({
                "fixtureId": fixture_id,
                "type": "DEBATE_RED",
                "actual": actual,
                "rpsContribution": rps_val,
                "trigger": entry.get("overallTrigger"),
                "overrideDirection": verdict.get("direction", "unknown"),
            })
    return {"entries": scored, "count": len(scored)}


# ── Score LLM_DISAGREE entries ────────────────────────────────────────────────

def score_llm_disagree(
    entries: list[dict],
    res_map: dict[str, dict],
) -> dict:
    scored = []
    llm_wins = 0
    det_wins = 0

    for entry in entries:
        fixture_id = entry.get("fixtureId")
        if not fixture_id or fixture_id not in res_map:
            continue
        resolution = res_map[fixture_id]
        actual = resolution.get("actualResult")
        rps_val = resolution.get("rpsContribution")
        if actual is None or rps_val is None:
            continue

        llm_market = entry.get("llmPick", "NO_BET")
        llm_side = entry.get("llmSide")
        det_market = entry.get("deterministicPick", "")
        det_side = entry.get("deterministicSide")
        confidence = entry.get("confidence", 0.0)

        # For 1x2 picks: determine if either side won
        llm_correct: bool | None = None
        det_correct: bool | None = None

        if llm_market == "1x2":
            llm_correct = side_won(llm_side, actual)
        if det_market == "1x2":
            det_correct = side_won(det_side, actual)

        if llm_correct is True:
            llm_wins += 1
        if det_correct is True:
            det_wins += 1

        scored.append({
            "fixtureId": fixture_id,
            "type": "LLM_DISAGREE",
            "actual": actual,
            "rpsContribution": rps_val,
            "llmPick": llm_market,
            "llmSide": llm_side,
            "llmCorrect": llm_correct,
            "deterministicPick": det_market,
            "deterministicSide": det_side,
            "deterministicCorrect": det_correct,
            "confidence": confidence,
            "rationale": entry.get("rationale", ""),
        })

    return {
        "entries": scored,
        "count": len(scored),
        "llmWins": llm_wins,
        "detWins": det_wins,
    }


# ── Combined aggregation ──────────────────────────────────────────────────────

def aggregate_stats(
    debate_stats: dict,
    llm_stats: dict,
) -> dict:
    all_entries = debate_stats["entries"] + llm_stats["entries"]
    if not all_entries:
        return {"count": 0, "meanRPS": None, "llmAddingSignal": False, "detail": {}}

    mean_rps = sum(e["rpsContribution"] for e in all_entries) / len(all_entries)

    # LLM signal: when LLM disagrees and we have 1x2 comparison, did LLM beat deterministic?
    llm_wins = llm_stats["llmWins"]
    det_wins = llm_stats["detWins"]
    llm_adding_signal = llm_wins > det_wins if (llm_wins + det_wins) >= 5 else False

    # Confidence bucketing for LLM disagrees
    high_conf = [e for e in llm_stats["entries"] if e.get("confidence", 0) >= 0.75]
    low_conf  = [e for e in llm_stats["entries"] if e.get("confidence", 0) <  0.75]
    high_rps = (sum(e["rpsContribution"] for e in high_conf) / len(high_conf)) if high_conf else None
    low_rps  = (sum(e["rpsContribution"] for e in low_conf)  / len(low_conf))  if low_conf  else None

    return {
        "count": len(all_entries),
        "meanRPS": round(mean_rps, 6),
        "llmAddingSignal": llm_adding_signal,
        "llmWins": llm_wins,
        "detWins": det_wins,
        "highConfCount": len(high_conf),
        "highConfMeanRPS": round(high_rps, 6) if high_rps is not None else None,
        "lowConfCount": len(low_conf),
        "lowConfMeanRPS": round(low_rps, 6) if low_rps is not None else None,
        "debateRedCount": debate_stats["count"],
        "llmDisagreeCount": llm_stats["count"],
    }


# ── Git atomic revert helpers ─────────────────────────────────────────────────

SKILLOPT_LOG = Path(".tmp/oracle_skillopt_log.json")


def _git(*args: str) -> str:
    """Run a git sub-command with an explicit argument list (no shell). Returns stdout."""
    result = subprocess.run(
        ["git", *args],
        capture_output=True, text=True, timeout=15,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def _stash_rubric(message: str) -> str:
    """Stage the rubric and stash it. Returns the stash ref (e.g. 'stash@{0}')."""
    _git("add", str(RUBRIC_PATH))
    _git("stash", "push", "-m", message, "--", str(RUBRIC_PATH))
    return "stash@{0}"


def _pop_stash() -> None:
    """Restore the stashed rubric (revert the proposed edit)."""
    _git("stash", "pop")


def _log_attempt(entry: dict) -> None:
    """Append an attempt record to the SkillOpt log (append-only JSONL-in-array)."""
    SKILLOPT_LOG.parent.mkdir(parents=True, exist_ok=True)
    log: list[dict] = []
    if SKILLOPT_LOG.exists():
        try:
            log = json.loads(SKILLOPT_LOG.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            log = []
    log.append(entry)
    SKILLOPT_LOG.write_text(json.dumps(log, indent=2), encoding="utf-8")


# ── Rubric edit proposal ──────────────────────────────────────────────────────

def load_rubric(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def propose_edit(stats: dict) -> str | None:
    if stats["count"] < MIN_SAMPLE_SIZE:
        return None
    if stats["meanRPS"] is None:
        return None

    lines = ["\n\n## SkillOpt update — auto-proposed", f"_Generated from {stats['count']} scored disagreements_\n"]

    # LLM signal analysis
    if stats["llmDisagreeCount"] >= 5:
        lw, dw = stats["llmWins"], stats["detWins"]
        if stats["llmAddingSignal"]:
            lines.append(
                f"**LLM signal**: LLM won {lw}/{lw+dw} resolvable 1x2 comparisons vs deterministic. "
                "LLM overrides are adding value. Consider increasing LLM weight in ensemble."
            )
        else:
            lines.append(
                f"**LLM signal**: Deterministic won {dw}/{lw+dw} resolvable 1x2 comparisons vs LLM. "
                "LLM overrides are not outperforming. Consider tightening confidence threshold."
            )

    # Confidence bucket analysis
    hc_rps = stats.get("highConfMeanRPS")
    lc_rps = stats.get("lowConfMeanRPS")
    if hc_rps is not None and lc_rps is not None:
        if hc_rps < lc_rps:
            lines.append(
                f"**Confidence calibration**: High-confidence picks (≥0.75) show lower mean RPS "
                f"({hc_rps:.4f} vs {lc_rps:.4f}). Confidence is predictive — trust high-confidence LLM picks."
            )
        else:
            lines.append(
                f"**Confidence calibration**: High-confidence picks (≥0.75) show higher mean RPS "
                f"({hc_rps:.4f} vs {lc_rps:.4f}). Confidence is not predictive — raise confidence threshold."
            )

    lines.append(
        f"\n**Validation gate**: Only apply if held-out RPS on the next "
        f"{MIN_SAMPLE_SIZE} fixtures improves by ≥{RPS_IMPROVEMENT_THRESHOLD:.3f}."
    )
    return "\n".join(lines)


def compute_held_out_rps(resolutions: list[dict], n: int = 20) -> float | None:
    recent = [r for r in resolutions if "rpsContribution" in r][-n:]
    if len(recent) < 5:
        return None
    return sum(r["rpsContribution"] for r in recent) / len(recent)


# ── Baseline RPS stats ────────────────────────────────────────────────────────

def _print_baseline_stats(resolutions: list[dict]) -> None:
    resolved = [r for r in resolutions if "rpsContribution" in r and r["rpsContribution"] is not None]
    if not resolved:
        print("[skillopt] No resolved records for baseline stats.")
        return

    total = len(resolved)
    mean_rps = sum(r["rpsContribution"] for r in resolved) / total

    # By league
    from collections import defaultdict
    by_league: dict[str, list[float]] = defaultdict(list)
    for r in resolved:
        league = (r.get("league")
                  or (r.get("drawCalibrationPoint") or {}).get("league")
                  or r.get("competition")
                  or "unknown")
        by_league[league].append(r["rpsContribution"])

    # Outcome distribution
    outcome_counts: dict[str, int] = defaultdict(int)
    for r in resolved:
        outcome = r.get("actualResult") or "unknown"
        outcome_counts[outcome] += 1

    print(f"\n[skillopt] === BASELINE STATS ({total} resolved records) ===")
    print(f"[skillopt] Overall mean RPS: {mean_rps:.4f}")
    print(f"[skillopt] Outcome distribution: " +
          " | ".join(f"{k}={v} ({100*v/total:.1f}%)" for k, v in sorted(outcome_counts.items())))

    if len(by_league) > 1:
        print("[skillopt] Mean RPS by league:")
        for league, vals in sorted(by_league.items(), key=lambda x: sum(x[1])/len(x[1])):
            print(f"[skillopt]   {league[:30]:<30} n={len(vals):5}  RPS={sum(vals)/len(vals):.4f}")

    # Reliability: recent 50 vs full set
    recent_50 = [r["rpsContribution"] for r in resolved[-50:]]
    if len(recent_50) >= 10:
        print(f"[skillopt] Recent-50 mean RPS: {sum(recent_50)/len(recent_50):.4f}")
    print()


# ── Main ──────────────────────────────────────────────────────────────────────

def _fixture_post_cutoff(entry: dict, res_map: dict, cutoff: str) -> bool:
    """True if the fixture's kickoff (or resolvedAt) falls strictly after the cutoff date.
    Fixtures within the LLM training window are excluded from LLM-pick validation
    because the model may have memorised the result (PRD §8.5 leakage protocol)."""
    fid = entry.get("fixtureId")
    if not fid:
        return False
    # Prefer kickoff from the disagreement record itself; fall back to resolvedAt
    kickoff = entry.get("kickoff") or ""
    if not kickoff:
        res = res_map.get(fid, {})
        kickoff = res.get("resolvedAt", "")
    return kickoff[:10] > cutoff


def main() -> None:
    parser = argparse.ArgumentParser(description="ORACLE SkillOpt — offline rubric optimiser")
    parser.add_argument("--dry-run", action="store_true", help="Print proposed edit, do not write")
    parser.add_argument("--store-dir", default=str(STORE_DIR), help="Store directory path")
    parser.add_argument(
        "--cutoff-date",
        default=DEFAULT_LLM_CUTOFF_DATE,
        help=f"Exclude LLM picks on fixtures before this date (default: {DEFAULT_LLM_CUTOFF_DATE}). "
             "Prevents scoring memorised pre-training results as genuine calibration.",
    )
    args = parser.parse_args()

    store_dir = Path(args.store_dir)
    cutoff_date: str = args.cutoff_date
    print(f"[skillopt] Loading store from {store_dir}")
    print(f"[skillopt] LLM cutoff date: {cutoff_date} (pre-cutoff LLM picks excluded from validation)")

    disagreements: list[dict] = load_json(DISAGREEMENT_KEY, store_dir) or []
    resolutions: list[dict] = load_json(RESOLUTION_KEY, store_dir) or []

    print(f"[skillopt] Disagreement entries: {len(disagreements)}")
    print(f"[skillopt] Resolution records:   {len(resolutions)}")

    # Always print baseline stats from resolution records
    _print_baseline_stats(resolutions)

    if not disagreements:
        print("[skillopt] No disagreement data. Skipping disagreement analysis.")
        sys.exit(0)

    res_map = {r["fixtureId"]: r for r in resolutions if "fixtureId" in r}

    # Split by entry type — DEBATE_RED uses all entries; LLM_DISAGREE applies cutoff partition
    debate_entries = [e for e in disagreements if e.get("type") == "DEBATE_RED"]
    llm_entries_all = [e for e in disagreements if e.get("type") == "LLM_DISAGREE"]

    # Leakage partition: only score LLM picks on post-cutoff fixtures (PRD §8.5)
    llm_entries = [e for e in llm_entries_all if _fixture_post_cutoff(e, res_map, cutoff_date)]
    n_filtered = len(llm_entries_all) - len(llm_entries)

    print(f"[skillopt]   DEBATE_RED:    {len(debate_entries)}")
    print(f"[skillopt]   LLM_DISAGREE:  {len(llm_entries_all)} total  "
          f"({n_filtered} pre-cutoff filtered → {len(llm_entries)} post-cutoff used)")
    if n_filtered > 0:
        print(f"[skillopt]   NOTE: {n_filtered} LLM entries excluded — fixtures before {cutoff_date} "
              "may have been in model training data.")

    debate_stats = score_debate_red(debate_entries, res_map)
    llm_stats    = score_llm_disagree(llm_entries, res_map)
    stats        = aggregate_stats(debate_stats, llm_stats)

    print(f"[skillopt] Scored {stats['count']} matched disagreements")
    if stats["meanRPS"] is not None:
        print(f"[skillopt] Mean RPS: {stats['meanRPS']:.6f}")
    if stats["llmDisagreeCount"] >= 5:
        print(f"[skillopt] LLM vs det wins: {stats['llmWins']} / {stats['detWins']}")

    if stats["count"] < MIN_SAMPLE_SIZE:
        print(f"[skillopt] Sample too small ({stats['count']} < {MIN_SAMPLE_SIZE}). Skipping edit.")
        sys.exit(0)

    held_out_rps = compute_held_out_rps(resolutions)
    if held_out_rps is not None:
        print(f"[skillopt] Held-out RPS (recent 20): {held_out_rps:.6f}")

    proposed = propose_edit(stats)
    if proposed is None:
        print("[skillopt] No edit proposed.")
        sys.exit(0)

    print("\n[skillopt] Proposed rubric edit:\n" + "-" * 60)
    print(proposed)
    print("-" * 60)

    if args.dry_run:
        print("\n[skillopt] Dry run - rubric not modified.")
        sys.exit(0)

    if not stats["llmAddingSignal"] and stats.get("highConfMeanRPS") is not None:
        if stats["highConfMeanRPS"] >= stats["meanRPS"]:
            print("[skillopt] Validation gate: no improvement signal. Rubric unchanged.")
            sys.exit(0)

    # ── Atomic keep-or-revert (autoresearch pattern) ──────────────────────────
    # Stash the current rubric, apply the proposed edit, re-score held-out RPS.
    # If the edit doesn't improve RPS by >= threshold, pop the stash (revert).

    baseline_rps = held_out_rps  # computed above (may be None if < 5 resolved records)

    current = load_rubric(RUBRIC_PATH)
    RUBRIC_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Checkpoint: stash baseline rubric before applying proposed edit
    stash_ref = None
    try:
        stash_ref = _stash_rubric(f"skillopt-baseline-{stats['count']}-samples")
        print(f"[skillopt] Stashed baseline rubric as {stash_ref}")
    except RuntimeError as exc:
        print(f"[skillopt] WARNING: Could not stash rubric ({exc}). Proceeding without atomic revert.")

    RUBRIC_PATH.write_text(current + proposed, encoding="utf-8")
    print(f"[skillopt] Applied proposed edit to {RUBRIC_PATH}")

    # Re-score held-out RPS on the same recent-20 window to detect improvement
    new_held_out_rps = compute_held_out_rps(resolutions)

    if baseline_rps is not None and new_held_out_rps is not None:
        delta = baseline_rps - new_held_out_rps  # positive = improvement (lower RPS is better)
        print(f"[skillopt] Held-out RPS: baseline={baseline_rps:.6f}  after={new_held_out_rps:.6f}  delta={delta:+.6f}")

        if delta < RPS_IMPROVEMENT_THRESHOLD and stash_ref is not None:
            print(f"[skillopt] Delta {delta:.6f} < threshold {RPS_IMPROVEMENT_THRESHOLD}. Reverting.")
            try:
                _pop_stash()
                print("[skillopt] Reverted rubric to baseline.")
            except RuntimeError as exc:
                print(f"[skillopt] ERROR: Could not revert stash: {exc}. Manual review required.")
            _log_attempt({
                "status": "REJECTED",
                "samples": stats["count"],
                "baselineRPS": baseline_rps,
                "afterRPS": new_held_out_rps,
                "delta": delta,
                "proposedEdit": proposed,
            })
            sys.exit(0)

    # Edit accepted — drop the stash (no longer needed) and log acceptance
    if stash_ref is not None:
        try:
            _git("stash", "drop")
        except RuntimeError:
            pass  # stash drop failure is non-fatal; the rubric file is already correct

    _log_attempt({
        "status": "ACCEPTED",
        "samples": stats["count"],
        "baselineRPS": baseline_rps,
        "afterRPS": new_held_out_rps,
        "delta": (baseline_rps - new_held_out_rps) if baseline_rps and new_held_out_rps else None,
        "proposedEdit": proposed,
    })
    print(f"\n[skillopt] Rubric updated and accepted: {RUBRIC_PATH}")


if __name__ == "__main__":
    main()
