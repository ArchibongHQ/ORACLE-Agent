"""
fetch_reverse_lm.py — 1X2 reverse-line-movement features for ORACLE (Phase 3E).

Source (download via kaggle):
  eladsil/football-games-odds  →  .tmp/kaggle/reverse-lm/
    Matches_Odds.csv     — one row per odds SNAPSHOT (date_created timestamp),
                           cols: match_id, date_start, competition_name,
                           date_created, home_team_name, away_team_name,
                           home_team_odd, away_team_odd, tie_odd
    Matches_Results.csv  — one row per match (match_id, date_start, teams, result)

Distinct from the Asian-Handicap line-movement in fetch_odds_timeseries.py: this
is the MONEYLINE (1X2) market. We track how the de-vigged home/draw/away implied
probabilities move from the opening snapshot (earliest date_created) to the
closing snapshot (latest, nearest kick-off), and flag reverse line movement —
when the price drifts AGAINST the side the opening line favoured (a classic
sharp-money signal).

Output:
  .tmp/reverse-lm/reverse_lm_features.csv
    date, home, away, div,
    mlOpenHomeProb   — de-vigged home implied prob at opening
    mlCloseHomeProb  — de-vigged home implied prob at closing
    mlHomeDrift      — close - open home prob (>0 = market moved toward home)
    mlDrawDrift      — close - open draw prob
    mlReverseLM      — 1 if home was the opening favourite (>0.5) yet its prob
                       DROPPED, or opening underdog yet prob ROSE; else 0
    mlSnapshots      — number of snapshots used

Keyed on (date, home, away) — joined in gbm_residual.py via _normalise_team,
the same convention as SPI / OTS / weather features.

Usage:
    python tools/fetch_reverse_lm.py --src-dir .tmp/kaggle/reverse-lm
    python tools/fetch_reverse_lm.py --src-dir .tmp/kaggle/reverse-lm --dry-run
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / ".tmp" / "reverse-lm"

# Kaggle competition_name → football-data.co.uk div code.
# Only leagues that overlap the ORACLE backfill are kept; the rest map to UNK
# and are dropped (this is a global dataset with hundreds of competitions).
COMP_TO_DIV: dict[str, str] = {
    "Eng. Premier League":   "E0",
    "English Championship":  "E1",
    "Spanish Liga Primera":  "SP1",
    "German Bundesliga":     "D1",
    "German Bundesliga 2":   "D2",
    "Italian Serie A":       "I1",
    "French Ligue 1":        "F1",
    "Dutch Eredivisie":      "N1",
    "Belgian First Division A": "B1",
}


def _implied(home: float, draw: float, away: float) -> tuple[float, float, float]:
    """De-vigged 1X2 implied probabilities (normalise reciprocals)."""
    try:
        ih, idr, ia = 1.0 / home, 1.0 / draw, 1.0 / away
    except ZeroDivisionError:
        return float("nan"), float("nan"), float("nan")
    total = ih + idr + ia
    if total <= 0:
        return float("nan"), float("nan"), float("nan")
    return ih / total, idr / total, ia / total


def build_features(src_dir: Path) -> list[dict]:
    odds_path = src_dir / "Matches_Odds.csv"
    if not odds_path.exists():
        print(f"[rlm] {odds_path} not found", file=sys.stderr)
        return []

    odds = pd.read_csv(odds_path, encoding="utf-8")
    odds["div"] = odds["competition_name"].map(COMP_TO_DIV)
    odds = odds.dropna(subset=["div"])
    if odds.empty:
        print("[rlm] no rows in mapped leagues", file=sys.stderr)
        return []
    print(f"[rlm] {len(odds)} snapshots in {odds['div'].nunique()} mapped leagues")

    # snapshot ordering = chronological by when the quote was created
    odds["_created"] = pd.to_datetime(odds["date_created"], format="%m/%d/%Y %H:%M",
                                      errors="coerce")
    odds["_match_date"] = pd.to_datetime(odds["date_start"], format="%m/%d/%Y %H:%M",
                                         errors="coerce")
    odds = odds.dropna(subset=["_created"])
    for c in ("home_team_odd", "away_team_odd", "tie_odd"):
        odds[c] = pd.to_numeric(odds[c], errors="coerce")
    odds = odds[(odds["home_team_odd"] > 1.0) & (odds["away_team_odd"] > 1.0)
                & (odds["tie_odd"] > 1.0)]

    features: list[dict] = []
    for match_id, grp in odds.groupby("match_id"):
        if len(grp) < 2:
            continue
        grp = grp.sort_values("_created")
        opening, closing = grp.iloc[0], grp.iloc[-1]

        oh, _od, _oa = _implied(opening["home_team_odd"], opening["tie_odd"],
                                opening["away_team_odd"])
        ch, cd, _ca = _implied(closing["home_team_odd"], closing["tie_odd"],
                               closing["away_team_odd"])
        if pd.isna(oh) or pd.isna(ch):
            continue

        home_drift = ch - oh
        # Reverse line movement: opening favourite weakened, or opening
        # underdog strengthened — the line moved against the opening lean.
        reverse = int((oh > 0.5 and home_drift < 0) or (oh < 0.5 and home_drift > 0))

        date_str = (opening["_match_date"].strftime("%Y-%m-%d")
                    if pd.notna(opening["_match_date"]) else "")
        features.append({
            "date": date_str,
            "home": str(opening["home_team_name"]),
            "away": str(opening["away_team_name"]),
            "div": opening["div"],
            "mlOpenHomeProb":  round(oh, 4),
            "mlCloseHomeProb": round(ch, 4),
            "mlHomeDrift":     round(home_drift, 4),
            "mlDrawDrift":     round(cd - _od, 4),
            "mlReverseLM":     reverse,
            "mlSnapshots":     len(grp),
        })

    print(f"[rlm] built {len(features)} match rows "
          f"(reverse-LM flagged on {sum(f['mlReverseLM'] for f in features)})")
    return features


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--src-dir", type=Path, default=Path(".tmp/kaggle/reverse-lm"),
                        help="Directory with Matches_Odds.csv + Matches_Results.csv")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse and report without writing")
    args = parser.parse_args()

    feats = build_features(args.src_dir)
    if not feats:
        print("[rlm] no features produced — check --src-dir")
        return

    if args.dry_run:
        print(f"[dry-run] would write {len(feats)} rows")
        print("  sample:", feats[0])
        return

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "reverse_lm_features.csv"
    pd.DataFrame(feats).to_csv(out_path, index=False, encoding="utf-8")
    print(f"[rlm] wrote {len(feats)} rows -> {out_path}")
    print("[rlm] Done. Next: python tools/gbm_residual.py --dry-run to verify "
          "mlHomeDrift / mlReverseLM cols")


if __name__ == "__main__":
    main()
