"""Tests for compute_league_baselines.py — lake-computed league baselines (P0-2)."""

from __future__ import annotations

import csv
from pathlib import Path

import compute_league_baselines as clb
import pytest


def _write_csv(path: Path, rows: list[tuple[str, str]]) -> None:
    """Write a minimal football-data.co.uk-shaped CSV (BOM header, FTHG/FTAG)."""
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Div", "Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG"])
        for fthg, ftag in rows:
            writer.writerow(["E0", "01/01/2025", "H", "A", fthg, ftag])


def test_read_season_home_away_split(tmp_path: Path) -> None:
    p = tmp_path / "2425_E0.csv"
    _write_csv(p, [("2", "1"), ("0", "0"), ("3", "2")])  # home 5, away 3 over 3
    home, away, matches = clb._read_season(p)
    assert matches == 3
    assert home == 5 / 3
    assert away == 3 / 3


def test_season_gpg_basic(tmp_path: Path) -> None:
    p = tmp_path / "2425_E0.csv"
    _write_csv(p, [("2", "1"), ("0", "0"), ("3", "2")])  # 3,0,5 goals over 3 games
    gpg, matches = clb.season_gpg(p)
    assert matches == 3
    assert gpg == pytest.approx((3 + 0 + 5) / 3)


def test_season_gpg_skips_blank_and_nonnumeric(tmp_path: Path) -> None:
    p = tmp_path / "2425_E0.csv"
    _write_csv(p, [("2", "1"), ("", ""), ("x", "1"), ("1", "1")])
    gpg, matches = clb.season_gpg(p)
    assert matches == 2  # blank and non-numeric rows dropped
    assert gpg == pytest.approx((3 + 2) / 2)


def test_recency_weighting(tmp_path: Path) -> None:
    # Two seasons: older averages 2.0 gpg, newer 4.0 gpg. With linear recency
    # weights [1 (old), 2 (new)] the mean should lean toward the newer season:
    # (2.0*1 + 4.0*2) / 3 = 3.333.
    _write_csv(tmp_path / "2324_E0.csv", [("1", "1"), ("1", "1")])  # 2.0 gpg
    _write_csv(tmp_path / "2425_E0.csv", [("2", "2"), ("2", "2")])  # 4.0 gpg
    by_name, _hfa, detail, seasons = clb.compute_baselines(tmp_path, seasons=5)
    assert by_name["Premier League"] == round((2.0 * 1 + 4.0 * 2) / 3, 3)
    assert seasons == ["2324", "2425"]
    assert set(detail["Premier League"].keys()) == {"2324", "2425"}


def test_seasons_window_caps_to_most_recent(tmp_path: Path) -> None:
    # Three seasons present, window=2 -> only the two most recent are used.
    _write_csv(tmp_path / "2223_E0.csv", [("0", "0")])
    _write_csv(tmp_path / "2324_E0.csv", [("1", "1")])
    _write_csv(tmp_path / "2425_E0.csv", [("3", "3")])
    by_name, _hfa, detail, seasons = clb.compute_baselines(tmp_path, seasons=2)
    assert seasons == ["2324", "2425"]
    assert "2223" not in detail["Premier League"]
    # weighted mean of 2.0 (2324, w1) and 6.0 (2425, w2) = (2+12)/3 = 4.667
    assert by_name["Premier League"] == round((2.0 * 1 + 6.0 * 2) / 3, 3)


def test_unknown_fdco_code_ignored(tmp_path: Path) -> None:
    _write_csv(tmp_path / "2425_E0.csv", [("1", "1")])
    _write_csv(tmp_path / "2425_XX9.csv", [("5", "5")])  # not in FDCO_TO_NAME
    by_name, _hfa, _detail, _seasons = clb.compute_baselines(tmp_path, seasons=5)
    assert set(by_name.keys()) == {"Premier League"}


def test_missing_dir_returns_empty(tmp_path: Path) -> None:
    by_name, hfa, detail, seasons = clb.compute_baselines(tmp_path / "nope", seasons=5)
    assert by_name == {} and hfa == {} and detail == {} and seasons == []


def test_hfa_fit_from_home_away_ratio(tmp_path: Path) -> None:
    # Home teams score 2.0/game, away 1.0/game -> ratio 2.0 -> HFA = sqrt(2)=1.414,
    # clamped to HFA_MAX (1.30).
    _write_csv(tmp_path / "2425_E0.csv", [("2", "1"), ("2", "1")])
    _, hfa, _, _ = clb.compute_baselines(tmp_path, seasons=5)
    assert hfa["Premier League"] == clb.HFA_MAX  # 1.414 clamped to 1.30


def test_hfa_symmetric_when_no_home_edge(tmp_path: Path) -> None:
    # Equal home/away scoring -> ratio 1.0 -> HFA = 1.0 (no home edge).
    _write_csv(tmp_path / "2425_E0.csv", [("1", "1"), ("2", "2")])
    _, hfa, _, _ = clb.compute_baselines(tmp_path, seasons=5)
    assert hfa["Premier League"] == 1.0


def test_hfa_realistic_mid_range(tmp_path: Path) -> None:
    # Home 1.6, away 1.2 -> ratio 1.333 -> sqrt = 1.1547 -> rounds to 1.155,
    # inside the [1.0, 1.30] band (not clamped).
    _write_csv(tmp_path / "2425_E0.csv", [("16", "12")] * 10)  # 1.6 vs 1.2 avg
    _, hfa, _, _ = clb.compute_baselines(tmp_path, seasons=5)
    assert hfa["Premier League"] == round((1.6 / 1.2) ** 0.5, 3)


def test_fdco_and_season_parsers() -> None:
    assert clb._season_from_filename("2425_E0.csv") == "2425"
    assert clb._fdco_from_filename("2425_SC0.csv") == "SC0"
    assert clb._fdco_from_filename("2425_E0.csv") == "E0"
