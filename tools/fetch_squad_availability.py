"""
fetch_squad_availability.py — Match-day squad availability index from the
Transfermarkt player-scores Kaggle dataset (.tmp/kaggle/player-scores/).

ORACLE has squadValueRatio (total squad value) but no match-day-actual
availability. A depleted matchday squad (injuries, rotation, suspensions) is a
stronger short-term signal than static squad value. This tool derives
availability from the *actual* matchday squad (game_lineups) priced at the most
recent market value <= match date.

Top-5 leagues only (GB1/ES1/L1/IT1/FR1 → E0/SP1/D1/I1/F1) — where the split GBM
top-5 model uses xG/PPDA-style features. Club names are emitted as canonical
football-data.co.uk names via TM_CODE_TO_FDCO so they join the backfill directly.

availability_idx = matchday_squad_value / rolling_peak_squad_value
  rolling_peak = the club's highest matchday squad value seen in PRIOR matches
  (expanding max, anti-leakage — current match excluded). 1.0 = at/above peak;
  0.7 = fielding 70% of peak strength. Prototype on D1: mean 0.79, std 0.18,
  28% of matches < 0.70 — real variance.
key_player_present = 1 if the club's single most-valued rostered player (from
  player_valuations current_club_id, valued at match date) is in today's squad.
starting_xi_value = total market value of the starting_lineup.

Output: .tmp/squad-availability/availability_features.csv
  date, club, league, availability_idx, key_player_present, starting_xi_value

GBM features wired via load_squad_availability() + build_features():
  availIdxHome, availIdxAway, keyPlayerHome, keyPlayerAway, availIdxDiff

Usage:
    python tools/fetch_squad_availability.py --kaggle-dir .tmp/kaggle/player-scores
    python tools/fetch_squad_availability.py --kaggle-dir .tmp/kaggle/player-scores --dry-run
"""
from __future__ import annotations

import argparse
import sys
from bisect import bisect_right
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / ".tmp" / "squad-availability"

# Transfermarkt domestic competition_id → fdco div code (top-5 only).
COMP_TO_DIV: dict[str, str] = {
    "GB1": "E0", "ES1": "SP1", "L1": "D1", "IT1": "I1", "FR1": "F1",
}

# Transfermarkt club_code → canonical football-data.co.uk team name.
# The bridge between TM legal slugs and fdco short names. Only the clubs that
# have appeared in top-5 since 2014 need entries; unmapped clubs fall back to a
# de-slugged code (which still won't join, but never crashes). This map is the
# intended single source of truth for TM↔fdco normalisation (see OTS name-gap).
TM_CODE_TO_FDCO: dict[str, str] = {
    # ── England (GB1 → E0) ──
    "fc-arsenal": "Arsenal", "aston-villa": "Aston Villa", "afc-bournemouth": "Bournemouth",
    "fc-brentford": "Brentford", "brighton-amp-hove-albion": "Brighton", "fc-burnley": "Burnley",
    "fc-chelsea": "Chelsea", "crystal-palace": "Crystal Palace", "fc-everton": "Everton",
    "fc-fulham": "Fulham", "ipswich-town": "Ipswich", "leeds-united": "Leeds",
    "leicester-city": "Leicester", "fc-liverpool": "Liverpool", "luton-town": "Luton",
    "manchester-city": "Man City", "manchester-united": "Man United", "newcastle-united": "Newcastle",
    "nottingham-forest": "Nott'm Forest", "fc-southampton": "Southampton",
    "tottenham-hotspur": "Tottenham", "fc-watford": "Watford", "west-ham-united": "West Ham",
    "wolverhampton-wanderers": "Wolves", "norwich-city": "Norwich", "sheffield-united": "Sheffield United",
    "afc-sunderland": "Sunderland", "fc-middlesbrough": "Middlesbrough", "huddersfield-town": "Huddersfield",
    "cardiff-city": "Cardiff", "hull-city": "Hull", "stoke-city": "Stoke", "swansea-city": "Swansea",
    "west-bromwich-albion": "West Brom", "queens-park-rangers": "QPR", "wigan-athletic": "Wigan",
    "fc-reading": "Reading",
    # ── Spain (ES1 → SP1) ──
    "real-madrid": "Real Madrid", "fc-barcelona": "Barcelona", "atletico-madrid": "Ath Madrid",
    "fc-sevilla": "Sevilla", "real-betis-sevilla": "Betis", "fc-valencia": "Valencia",
    "fc-villarreal": "Villarreal", "athletic-bilbao": "Ath Bilbao", "real-sociedad-san-sebastian": "Sociedad",
    "celta-vigo": "Celta", "fc-getafe": "Getafe", "ca-osasuna": "Osasuna", "fc-girona": "Girona",
    "rayo-vallecano": "Vallecano", "rcd-mallorca": "Mallorca", "deportivo-alaves": "Alaves",
    "ud-las-palmas": "Las Palmas", "fc-granada": "Granada", "fc-cadiz": "Cadiz",
    "real-valladolid": "Valladolid", "cd-leganes": "Leganes", "espanyol-barcelona": "Espanol",
    "ud-almeria": "Almeria", "ud-levante": "Levante", "sd-eibar": "Eibar", "sd-huesca": "Huesca",
    "fc-elche": "Elche",
    # ── Germany (L1 → D1) ──
    "bayern-munich": "Bayern Munich", "fc-bayern-munchen": "Bayern Munich",
    "borussia-dortmund": "Dortmund", "bayer-04-leverkusen": "Leverkusen", "rasenballsport-leipzig": "RB Leipzig",
    "eintracht-frankfurt": "Ein Frankfurt", "vfl-wolfsburg": "Wolfsburg", "sc-freiburg": "Freiburg",
    "tsg-1899-hoffenheim": "Hoffenheim", "vfb-stuttgart": "Stuttgart", "1-fc-union-berlin": "Union Berlin",
    "sv-werder-bremen": "Werder Bremen", "fc-augsburg": "Augsburg", "1-fsv-mainz-05": "Mainz",
    "borussia-monchengladbach": "M'gladbach", "vfl-bochum": "Bochum", "1-fc-heidenheim-1846": "Heidenheim",
    "fc-st-pauli": "St Pauli", "1-fc-koln": "FC Koln", "sv-darmstadt-98": "Darmstadt",
    "hamburger-sv": "Hamburg", "hertha-bsc": "Hertha", "fc-schalke-04": "Schalke 04",
    "holstein-kiel": "Holstein Kiel",
    # ── Italy (IT1 → I1) ──
    "juventus-turin": "Juventus", "inter-mailand": "Inter", "ac-mailand": "Milan",
    "ssc-neapel": "Napoli", "as-rom": "Roma", "lazio-rom": "Lazio", "atalanta-bergamo": "Atalanta",
    "ac-florenz": "Fiorentina", "fc-bologna": "Bologna", "fc-turin": "Torino", "cfc-genua": "Genoa",
    "udinese-calcio": "Udinese", "us-sassuolo": "Sassuolo", "hellas-verona": "Verona",
    "cagliari-calcio": "Cagliari", "us-lecce": "Lecce", "fc-empoli": "Empoli", "ac-monza": "Monza",
    "parma-calcio-1913": "Parma", "como-1907": "Como", "us-salernitana-1919": "Salernitana",
    "frosinone-calcio": "Frosinone", "fc-venedig": "Venezia", "sampdoria-genua": "Sampdoria",
    # ── France (FR1 → F1) ──
    "fc-paris-saint-germain": "Paris SG", "olympique-marseille": "Marseille", "olympique-lyon": "Lyon",
    "as-monaco": "Monaco", "losc-lille": "Lille", "fc-stade-rennes": "Rennes", "ogc-nizza": "Nice",
    "rc-lens": "Lens", "fc-nantes": "Nantes", "rc-strassburg-alsace": "Strasbourg",
    "montpellier-hsc": "Montpellier", "stade-reims": "Reims", "fc-toulouse": "Toulouse",
    "stade-brest-29": "Brest", "nimes-olympique": "Nimes", "fc-lorient": "Lorient",
    "clermont-foot-63": "Clermont", "fc-metz": "Metz", "aj-auxerre": "Auxerre", "sco-angers": "Angers",
    "ac-le-havre": "Le Havre", "as-saint-etienne": "St Etienne", "fc-girondins-bordeaux": "Bordeaux",
}

BASELINE_WINDOW_DAYS = 365   # valuation window for "rostered near the match"


def _slug_to_words(code: str) -> str:
    return code.replace("-", " ").strip()


def latest_value_at(val_by_player: dict[int, tuple], player_id: int, asof: pd.Timestamp) -> float | None:
    """Most recent market value for a player with valuation date <= asof. None if none."""
    entry = val_by_player.get(player_id)
    if not entry:
        return None
    dates, vals = entry
    i = bisect_right(dates, asof) - 1
    return vals[i] if i >= 0 else None


def build_value_index(valuations_path: Path) -> tuple[dict[int, tuple], dict[int, list[tuple]]]:
    """
    val_by_player: player_id -> (dates[], values[]) ascending — for bisect lookups.
    roster_by_club: club_id -> [(date, player_id), ...] ascending — reconstruct the
      full roster (and its top player) as of a match date.
    """
    vdf = pd.read_csv(
        valuations_path,
        usecols=["player_id", "date", "market_value_in_eur", "current_club_id"],
    )
    vdf["date"] = pd.to_datetime(vdf["date"], errors="coerce")
    vdf = vdf.dropna(subset=["date", "market_value_in_eur", "current_club_id"])
    vdf = vdf.sort_values(["player_id", "date"])
    val_by_player: dict[int, tuple] = {}
    for pid, grp in vdf.groupby("player_id"):
        val_by_player[int(pid)] = (list(grp["date"]), list(grp["market_value_in_eur"].astype(float)))

    roster_by_club: dict[int, list[tuple]] = {}
    cvdf = vdf.sort_values(["current_club_id", "date"])
    for cid, grp in cvdf.groupby("current_club_id"):
        roster_by_club[int(cid)] = list(zip(grp["date"], grp["player_id"].astype(int)))
    print(f"[avail] Valuation index: {len(val_by_player)} players, "
          f"{len(roster_by_club)} clubs, {len(vdf)} data points")
    return val_by_player, roster_by_club


def top_rostered_player(
    roster_by_club: dict[int, list[tuple]],
    val_by_player: dict[int, tuple],
    club_id: int,
    asof: pd.Timestamp,
) -> int | None:
    """The club's single most-valued player rostered within the window before asof."""
    rows = roster_by_club.get(club_id)
    if not rows:
        return None
    cutoff = asof - pd.Timedelta(days=BASELINE_WINDOW_DAYS)
    candidate_ids: set[int] = set()
    for d, pid in rows:
        if d > asof:
            break
        if d >= cutoff:
            candidate_ids.add(pid)
    best_pid, best_val = None, -1.0
    for pid in candidate_ids:
        v = latest_value_at(val_by_player, pid, asof)
        if v is not None and v > best_val:
            best_val, best_pid = v, pid
    return best_pid


def compute(kaggle_dir: Path) -> list[dict]:
    games_path = kaggle_dir / "games.csv"
    lineups_path = kaggle_dir / "game_lineups.csv"
    valuations_path = kaggle_dir / "player_valuations.csv"
    clubs_path = kaggle_dir / "clubs.csv"
    for p in (games_path, lineups_path, valuations_path, clubs_path):
        if not p.exists():
            print(f"[avail] ERROR: {p} not found")
            sys.exit(1)

    # club_id -> club_code, for the fdco name bridge
    clubs = pd.read_csv(clubs_path, usecols=["club_id", "club_code"])
    code_by_club = {int(r.club_id): str(r.club_code) for r in clubs.itertuples()}

    # Top-5 domestic games only
    games = pd.read_csv(
        games_path,
        usecols=["game_id", "competition_id", "date", "home_club_id", "away_club_id"],
    )
    games = games[games["competition_id"].isin(COMP_TO_DIV)].copy()
    games["date"] = pd.to_datetime(games["date"], errors="coerce")
    games = games.dropna(subset=["date"])
    game_meta = {
        int(r.game_id): {"date": r.date, "div": COMP_TO_DIV[r.competition_id],
                         "club_ids": {int(r.home_club_id), int(r.away_club_id)}}
        for r in games.itertuples()
    }
    print(f"[avail] {len(game_meta)} top-5 games in scope")

    lineups = pd.read_csv(lineups_path, usecols=["game_id", "club_id", "player_id", "type"])
    lineups = lineups[lineups["game_id"].isin(game_meta)].copy()
    print(f"[avail] {len(lineups)} lineup rows in scope")

    val_by_player, roster_by_club = build_value_index(valuations_path)

    # 1st pass: matchday squad value + starting XI value + present ids per (game, club)
    raw: list[dict] = []
    grouped = lineups.groupby(["game_id", "club_id"])
    n_groups = len(grouped)
    processed = 0
    for (game_id, club_id), grp in grouped:
        meta = game_meta.get(int(game_id))
        if not meta or int(club_id) not in meta["club_ids"]:
            continue
        asof = meta["date"]
        present_ids = {int(r.player_id) for r in grp.itertuples()}
        squad_value = 0.0
        starting_value = 0.0
        for r in grp.itertuples():
            v = latest_value_at(val_by_player, int(r.player_id), asof)
            if v is None:
                continue
            squad_value += v
            if r.type == "starting_lineup":
                starting_value += v
        top_pid = top_rostered_player(roster_by_club, val_by_player, int(club_id), asof)
        key_present = (1 if (top_pid is not None and top_pid in present_ids)
                       else (0 if top_pid is not None else ""))
        code = code_by_club.get(int(club_id), "")
        club_fdco = TM_CODE_TO_FDCO.get(code, _slug_to_words(code))
        raw.append({
            "club_id": int(club_id), "date": asof, "div": meta["div"],
            "club": club_fdco, "squad_value": squad_value,
            "starting_xi_value": starting_value, "key_player_present": key_present,
        })
        processed += 1
        if processed % 5000 == 0:
            print(f"[avail] {processed}/{n_groups} (game,club) groups processed")

    # 2nd pass: rolling-peak baseline per club (expanding max of PRIOR matchday values)
    df = pd.DataFrame(raw).sort_values(["club_id", "date"])
    df["peak"] = df.groupby("club_id")["squad_value"].transform(
        lambda s: s.shift().expanding().max()
    )
    df["availability_idx"] = df.apply(
        lambda r: min(r["squad_value"] / r["peak"], 1.0)
        if pd.notna(r["peak"]) and r["peak"] > 0 else float("nan"),
        axis=1,
    )
    out = [
        {
            "date": r.date.strftime("%Y-%m-%d"),
            "club": r.club,
            "league": r.div,
            "availability_idx": r.availability_idx,
            "key_player_present": r.key_player_present,
            "starting_xi_value": r.starting_xi_value,
        }
        for r in df.itertuples()
    ]
    valid = df["availability_idx"].dropna()
    if len(valid):
        print(f"[avail] availability_idx: n={len(valid)} mean={valid.mean():.3f} "
              f"std={valid.std():.3f} <0.7={100*(valid<0.7).mean():.1f}%")
    print(f"[avail] Built {len(out)} (game, club) availability rows")
    return out


def write_output(rows: list[dict], out_path: Path, dry_run: bool) -> None:
    if dry_run:
        print(f"[avail] [dry-run] would write {len(rows)} rows")
        if rows:
            print(f"  sample: {rows[0]}")
        return
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(rows)
    df["availability_idx"] = df["availability_idx"].map(lambda x: f"{x:.4f}" if pd.notna(x) else "")
    df["starting_xi_value"] = df["starting_xi_value"].map(lambda x: f"{x:.0f}")
    df.to_csv(out_path, index=False,
              columns=["date", "club", "league", "availability_idx",
                       "key_player_present", "starting_xi_value"])
    print(f"[avail] Wrote {len(df)} rows -> {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Match-day squad availability from Transfermarkt lineups")
    parser.add_argument("--kaggle-dir", default=".tmp/kaggle/player-scores",
                        help="Dir with games.csv, game_lineups.csv, player_valuations.csv, clubs.csv")
    parser.add_argument("--out-dir", default=str(OUT_DIR), help="Output dir (default: .tmp/squad-availability)")
    parser.add_argument("--dry-run", action="store_true", help="Compute stats; no write")
    args = parser.parse_args()

    rows = compute(Path(args.kaggle_dir))
    write_output(rows, Path(args.out_dir) / "availability_features.csv", args.dry_run)
    if not args.dry_run:
        print("[avail] Done. Next: python tools/gbm_residual.py --dry-run to verify availIdxHome/Away cols")


if __name__ == "__main__":
    main()
