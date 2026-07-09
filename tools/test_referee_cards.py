"""Tests for compute_referee_cards.py — lake-computed referee cards-rate (PR-25 item 2)."""

from __future__ import annotations

import csv
from pathlib import Path

import compute_referee_cards as crc
import pytest


def _write_csv(path: Path, rows: list[tuple[str, str, str, str, str]]) -> None:
    """Write a minimal football-data.co.uk-shaped CSV (BOM header, Referee +
    HY/AY/HR/AR). Each row is (referee, hy, ay, hr, ar)."""
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Div", "Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG",
                          "Referee", "HY", "AY", "HR", "AR"])
        for ref, hy, ay, hr, ar in rows:
            writer.writerow(["E0", "01/01/2025", "H", "A", "1", "1", ref, hy, ay, hr, ar])


# ── normalise_referee ────────────────────────────────────────────────────────

def test_normalise_referee_initial_surname_collapse() -> None:
    assert crc.normalise_referee("R Jones") == "r.jones"
    assert crc.normalise_referee("Rob Jones") == "r.jones"


def test_normalise_referee_strips_pictured_annotation() -> None:
    assert crc.normalise_referee("Michael Oliver (pictured)") == "m.oliver"
    assert crc.normalise_referee("M Oliver") == "m.oliver"


def test_normalise_referee_single_token_lowercased() -> None:
    assert crc.normalise_referee("Unknown") == "unknown"


def test_normalise_referee_collapses_extra_whitespace() -> None:
    assert crc.normalise_referee("Anthony   Taylor") == "a.taylor"


# ── _read_season_referee_cards ──────────────────────────────────────────────

def test_read_season_referee_cards_basic(tmp_path: Path) -> None:
    p = tmp_path / "2425_E0.csv"
    _write_csv(p, [
        ("A Taylor", "2", "1", "0", "0"),
        ("A Taylor", "1", "1", "0", "0"),
        ("M Oliver", "3", "2", "1", "0"),
    ])
    totals = crc._read_season_referee_cards(p)
    assert totals["A Taylor"] == (5.0, 2)
    assert totals["M Oliver"] == (6.0, 1)  # 3+2+1+0


def test_read_season_referee_cards_skips_blank_referee(tmp_path: Path) -> None:
    p = tmp_path / "2425_E0.csv"
    _write_csv(p, [("", "1", "1", "0", "0"), ("A Taylor", "2", "2", "0", "0")])
    totals = crc._read_season_referee_cards(p)
    assert set(totals.keys()) == {"A Taylor"}


def test_read_season_referee_cards_skips_nonnumeric_cards(tmp_path: Path) -> None:
    p = tmp_path / "2425_E0.csv"
    _write_csv(p, [("A Taylor", "x", "1", "0", "0"), ("A Taylor", "2", "2", "0", "0")])
    totals = crc._read_season_referee_cards(p)
    assert totals["A Taylor"] == (4.0, 1)


def test_read_season_referee_cards_missing_red_defaults_zero(tmp_path: Path) -> None:
    p = tmp_path / "2425_E0.csv"
    _write_csv(p, [("A Taylor", "2", "1", "", "")])
    totals = crc._read_season_referee_cards(p)
    assert totals["A Taylor"] == (3.0, 1)


# ── compute_referee_cards ────────────────────────────────────────────────────

def test_compute_referee_cards_basic_rate_and_league_mean(tmp_path: Path) -> None:
    # Two referees, one thick sample one thin, over one season.
    rows = [("A Taylor", "2", "1", "0", "0")] * 20 + [("R Jones", "4", "4", "0", "0")] * 3
    _write_csv(tmp_path / "2425_E0.csv", rows)
    by_key, league_means, seasons = crc.compute_referee_cards(tmp_path, seasons=5, k=10.0)
    assert seasons == ["2425"]
    assert "Premier League" in league_means
    a_taylor = by_key["Premier League|a.taylor"]
    assert a_taylor["n"] == 20
    assert a_taylor["rawRate"] == pytest.approx(3.0)


def test_compute_referee_cards_thin_sample_shrinks_toward_league_mean(tmp_path: Path) -> None:
    # A thick-sample referee at 3.0/game sets a league mean near 3.0; a
    # 3-game referee at 8.0/game should land far below their own raw rate.
    rows = [("A Taylor", "2", "1", "0", "0")] * 30 + [("R Jones", "4", "4", "0", "0")] * 3
    _write_csv(tmp_path / "2425_E0.csv", rows)
    by_key, league_means, _ = crc.compute_referee_cards(tmp_path, seasons=5, k=10.0)
    r_jones = by_key["Premier League|r.jones"]
    assert r_jones["rawRate"] == pytest.approx(8.0)
    # n=3, k=10 -> weight 3/13 ~ 0.23 toward own rate, rest toward league mean.
    assert r_jones["shrunkRate"] < r_jones["rawRate"]
    assert r_jones["shrunkRate"] < 5.0  # heavily regressed, nowhere near 8.0


def test_compute_referee_cards_thick_sample_stays_close_to_own_rate(tmp_path: Path) -> None:
    rows = [("A Taylor", "2", "1", "0", "0")] * 60 + [("R Jones", "5", "5", "0", "0")] * 120
    _write_csv(tmp_path / "2425_E0.csv", rows)
    by_key, _league_means, _ = crc.compute_referee_cards(tmp_path, seasons=5, k=10.0)
    r_jones = by_key["Premier League|r.jones"]
    assert r_jones["rawRate"] == pytest.approx(10.0)
    # n=120, k=10 -> weight 120/130 ~ 0.92 toward own rate.
    assert r_jones["shrunkRate"] == pytest.approx(10.0, abs=1.0)


def test_compute_referee_cards_seasons_window_caps_to_most_recent(tmp_path: Path) -> None:
    _write_csv(tmp_path / "2223_E0.csv", [("A Taylor", "1", "1", "0", "0")] * 10)
    _write_csv(tmp_path / "2324_E0.csv", [("A Taylor", "2", "2", "0", "0")] * 10)
    _write_csv(tmp_path / "2425_E0.csv", [("A Taylor", "3", "3", "0", "0")] * 10)
    _by_key2, _lm2, seasons2 = crc.compute_referee_cards(tmp_path, seasons=2, k=10.0)
    assert seasons2 == ["2324", "2425"]
    by_key, _lm, _ = crc.compute_referee_cards(tmp_path, seasons=2, k=10.0)
    # Only 2324 (4.0/game) + 2425 (6.0/game) in the window -> flat mean 5.0
    assert by_key["Premier League|a.taylor"]["rawRate"] == pytest.approx(5.0)


def test_compute_referee_cards_referee_across_two_leagues_kept_separate(tmp_path: Path) -> None:
    _write_csv(tmp_path / "2425_E0.csv", [("A Taylor", "2", "1", "0", "0")] * 10)
    p2 = tmp_path / "2425_SP1.csv"
    with open(p2, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Div", "Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG",
                          "Referee", "HY", "AY", "HR", "AR"])
        for _ in range(10):
            writer.writerow(["SP1", "01/01/2025", "H", "A", "1", "1", "A Taylor", "5", "5", "0", "0"])
    by_key, league_means, _ = crc.compute_referee_cards(tmp_path, seasons=5, k=10.0)
    assert by_key["Premier League|a.taylor"]["rawRate"] == pytest.approx(3.0)
    assert by_key["La Liga|a.taylor"]["rawRate"] == pytest.approx(10.0)
    assert league_means["Premier League"] != league_means["La Liga"]


def test_compute_referee_cards_missing_dir_returns_empty(tmp_path: Path) -> None:
    by_key, league_means, seasons = crc.compute_referee_cards(tmp_path / "nope", seasons=5)
    assert by_key == {} and league_means == {} and seasons == []


def test_compute_referee_cards_unknown_fdco_ignored(tmp_path: Path) -> None:
    _write_csv(tmp_path / "2425_E0.csv", [("A Taylor", "1", "1", "0", "0")])
    p2 = tmp_path / "2425_XX9.csv"
    with open(p2, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Div", "Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG",
                          "Referee", "HY", "AY", "HR", "AR"])
        writer.writerow(["XX9", "01/01/2025", "H", "A", "1", "1", "Z Unknown", "9", "9", "0", "0"])
    by_key, _league_means, _seasons = crc.compute_referee_cards(tmp_path, seasons=5)
    assert set(e["league"] for e in by_key.values()) == {"Premier League"}


def test_build_report_lists_league_means_and_top_referees(tmp_path: Path) -> None:
    rows = [("A Taylor", "2", "1", "0", "0")] * 20 + [("R Jones", "6", "6", "0", "0")] * 20
    _write_csv(tmp_path / "2425_E0.csv", rows)
    by_key, league_means, _ = crc.compute_referee_cards(tmp_path, seasons=5, k=10.0)
    lines = crc.build_report(by_key, league_means)
    joined = "\n".join(lines)
    assert "Premier League" in joined
    assert "R Jones" in joined  # higher shrunk rate, should appear in top-3
