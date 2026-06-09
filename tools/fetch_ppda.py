"""
fetch_ppda.py — Extract PPDA (pressing) features from the slehkyi Kaggle dataset.

Dataset: slehkyi/extended-football-stats-for-european-leagues-xg
  Already downloaded at .tmp/kaggle/xg-ppda/ (Phase 1).
  Key file: understat_per_game.csv — one row per team per match.

PPDA = passes allowed per defensive action (lower = more intense pressing).
OPPDA = opponent's PPDA (how hard the opponent presses you).

Output: .tmp/ppda/ppda_features.csv
  date, home, away, div, ppda_home, ppda_away, oppda_home, oppda_away

GBM features wired via load_ppda() + build_features() in gbm_residual.py:
  ppdaHome, ppdaAway, ppdaDiff
  oppdaHome, oppdaAway

Usage:
    python tools/fetch_ppda.py --kaggle-dir .tmp/kaggle/xg-ppda
    python tools/fetch_ppda.py --kaggle-dir .tmp/kaggle/xg-ppda --dry-run
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / ".tmp" / "ppda"

# slehkyi league names → football-data.co.uk div codes (top-5 only)
SLEHKYI_LEAGUE_MAP: dict[str, str] = {
    "EPL":        "E0",
    "La_liga":    "SP1",
    "Bundesliga": "D1",
    "Serie_A":    "I1",
    "Ligue_1":    "F1",
}

# Slehkyi year column → fdco season code (e.g. 2023 → "2324")
def _year_to_fdco(year: int) -> str:
    return f"{str(year)[2:]}{str(year + 1)[2:]}"


def _normalise(name: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    import re as _re
    s = name.lower()
    s = _re.sub(r"[^a-z0-9\s]", "", s)
    return _re.sub(r"\s+", " ", s).strip()


def _find_col(cols: list[str], candidates: list[str]) -> str | None:
    for c in candidates:
        if c in cols:
            return c
    return None


def load_per_game(per_game_path: Path) -> list[dict]:
    """
    Parse understat_per_game.csv into a list of per-team-per-match dicts.
    Columns of interest: league, year, date, team, h_a, ppda_coef, oppda_coef
    """
    rows = []
    with open(per_game_path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        cols = [c.lower().strip() for c in (reader.fieldnames or [])]

        league_col  = _find_col(cols, ["league"])
        year_col    = _find_col(cols, ["year"])
        date_col    = _find_col(cols, ["date"])
        team_col    = _find_col(cols, ["team"])
        ha_col      = _find_col(cols, ["h_a"])
        ppda_col    = _find_col(cols, ["ppda_coef"])
        oppda_col   = _find_col(cols, ["oppda_coef"])

        for raw in reader:
            def g(col: str | None) -> str:
                return raw.get(col or "", "").strip() if col else ""

            league = g(league_col)
            div = SLEHKYI_LEAGUE_MAP.get(league)
            if not div:
                continue

            date_raw = g(date_col)
            # "2014-08-22 19:30:00" → "2014-08-22"
            date = date_raw[:10] if date_raw else ""
            if not date or len(date) < 10:
                continue

            team = g(team_col)
            ha = g(ha_col)  # "h" or "a"
            try:
                ppda = float(g(ppda_col))
                oppda = float(g(oppda_col))
            except ValueError:
                continue

            try:
                year = int(g(year_col))
                fdco_season = _year_to_fdco(year)
            except ValueError:
                fdco_season = ""

            rows.append({
                "date":        date,
                "team":        team,
                "norm_team":   _normalise(team),
                "h_a":         ha,
                "div":         div,
                "fdco_season": fdco_season,
                "ppda":        ppda,
                "oppda":       oppda,
            })

    print(f"[ppda] Loaded {len(rows)} team-match rows from {per_game_path.name}")
    return rows


def build_match_lookup(rows: list[dict]) -> dict[tuple, dict]:
    """
    Pair home and away team rows for the same match (same date + div).
    Returns {(date, norm_home, norm_away): {ppda_home, ppda_away, oppda_home, oppda_away}}
    """
    # Group by (date, div) → list of team rows
    from collections import defaultdict
    by_slot: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        by_slot[(r["date"], r["div"])].append(r)

    lookup: dict[tuple, dict] = {}
    paired = 0
    skipped = 0

    for (date, div), slot_rows in by_slot.items():
        homes = [r for r in slot_rows if r["h_a"] == "h"]
        aways = [r for r in slot_rows if r["h_a"] == "a"]

        # Multiple matches on the same date in the same league —
        # we can't join without a fixture ID, so we do a best-effort
        # team-name-based pairing if counts match.
        if len(homes) != len(aways):
            skipped += 1
            continue

        for h, a in zip(homes, aways):
            key = (date, h["norm_team"], a["norm_team"])
            lookup[key] = {
                "ppda_home":  h["ppda"],
                "ppda_away":  a["ppda"],
                "oppda_home": h["oppda"],
                "oppda_away": a["oppda"],
                "div":        div,
            }
            paired += 1

    print(f"[ppda] Built {paired} match-level entries ({skipped} date/div slots skipped — count mismatch)")
    return lookup


def write_output(lookup: dict[tuple, dict], out_path: Path, dry_run: bool) -> None:
    rows = []
    for (date, norm_home, norm_away), feat in sorted(lookup.items()):
        rows.append({
            "date":       date,
            "home":       norm_home,
            "away":       norm_away,
            "div":        feat["div"],
            "ppda_home":  f"{feat['ppda_home']:.4f}",
            "ppda_away":  f"{feat['ppda_away']:.4f}",
            "oppda_home": f"{feat['oppda_home']:.4f}",
            "oppda_away": f"{feat['oppda_away']:.4f}",
        })

    if dry_run:
        print(f"[ppda] [dry-run] would write {len(rows)} match rows")
        if rows:
            print(f"  sample: {rows[0]}")
        return

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=["date", "home", "away", "div",
                                                  "ppda_home", "ppda_away",
                                                  "oppda_home", "oppda_away"])
        writer.writeheader()
        writer.writerows(rows)
    print(f"[ppda] Wrote {len(rows)} rows -> {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract PPDA features from slehkyi Kaggle dataset")
    parser.add_argument("--kaggle-dir", default=".tmp/kaggle/xg-ppda",
                        help="Dir containing understat_per_game.csv (default: .tmp/kaggle/xg-ppda)")
    parser.add_argument("--out-dir", default=str(OUT_DIR),
                        help="Output directory (default: .tmp/ppda)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print stats without writing output")
    args = parser.parse_args()

    kaggle_dir = Path(args.kaggle_dir)
    per_game_path = kaggle_dir / "understat_per_game.csv"
    if not per_game_path.exists():
        print(f"[ppda] ERROR: {per_game_path} not found. Download the dataset first:")
        print("  kaggle datasets download -d slehkyi/extended-football-stats-for-european-leagues-xg \\")
        print("    -p .tmp/kaggle/xg-ppda --unzip")
        sys.exit(1)

    out_path = Path(args.out_dir) / "ppda_features.csv"

    rows = load_per_game(per_game_path)
    lookup = build_match_lookup(rows)
    write_output(lookup, out_path, args.dry_run)

    if not args.dry_run:
        print(f"[ppda] Done. Next: python tools/gbm_residual.py --dry-run to verify ppdaHome/Away cols appear")


if __name__ == "__main__":
    main()
