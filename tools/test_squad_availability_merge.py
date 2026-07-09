"""Tests for the squad-availability merge added to scrape_fixtures.py/acquire_daily.py
(PR-6, §8.2): _load_availability_table/_availability_for look up each club's MOST
RECENT known matchday availability_idx from the Kaggle backfill CSV (there's no
"today's" row for a fixture that hasn't been played yet), and acquire_daily.py's
_stats_rows folds the resulting {home, away} block into the Parquet lake exactly
like the existing xg subtab.
"""
import csv

import pytest

try:
    from scrape_fixtures import _availability_for, _load_availability_table
except ImportError:  # repo root on sys.path instead of tools/
    from tools.scrape_fixtures import _availability_for, _load_availability_table

try:
    from acquire_daily import _stats_rows
except ImportError:
    from tools.acquire_daily import _stats_rows


def _write_csv(path, rows):
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=["date", "club", "league", "availability_idx", "key_player_present", "starting_xi_value"]
        )
        writer.writeheader()
        writer.writerows(rows)


class TestLoadAvailabilityTable:
    def test_missing_file_returns_empty_dict(self, tmp_path, monkeypatch):
        import scrape_fixtures as sf

        monkeypatch.setattr(sf, "_AVAILABILITY_TABLE_PATH", tmp_path / "nope.csv")
        assert sf._load_availability_table() == {}

    def test_keeps_only_the_most_recent_row_per_club(self, tmp_path, monkeypatch):
        import scrape_fixtures as sf

        path = tmp_path / "availability_features.csv"
        _write_csv(path, [
            {"date": "2026-01-01", "club": "Arsenal", "league": "E0", "availability_idx": "0.90",
             "key_player_present": "1", "starting_xi_value": "500000000"},
            {"date": "2026-06-15", "club": "Arsenal", "league": "E0", "availability_idx": "0.72",
             "key_player_present": "0", "starting_xi_value": "480000000"},
            {"date": "2026-03-01", "club": "Arsenal", "league": "E0", "availability_idx": "0.85",
             "key_player_present": "1", "starting_xi_value": "490000000"},
        ])
        monkeypatch.setattr(sf, "_AVAILABILITY_TABLE_PATH", path)
        table = sf._load_availability_table()
        key = sf.normalise("Arsenal")
        assert table[key]["date"] == "2026-06-15"
        assert table[key]["idx"] == pytest.approx(0.72)
        assert table[key]["keyPlayerPresent"] == 0

    def test_skips_rows_with_missing_required_fields(self, tmp_path, monkeypatch):
        import scrape_fixtures as sf

        path = tmp_path / "availability_features.csv"
        _write_csv(path, [
            {"date": "", "club": "Arsenal", "league": "E0", "availability_idx": "0.9",
             "key_player_present": "1", "starting_xi_value": "1"},
            {"date": "2026-01-01", "club": "", "league": "E0", "availability_idx": "0.9",
             "key_player_present": "1", "starting_xi_value": "1"},
            {"date": "2026-01-01", "club": "Chelsea", "league": "E0", "availability_idx": "",
             "key_player_present": "1", "starting_xi_value": "1"},
        ])
        monkeypatch.setattr(sf, "_AVAILABILITY_TABLE_PATH", path)
        assert sf._load_availability_table() == {}

    def test_skips_out_of_range_or_non_finite_idx_values(self, tmp_path, monkeypatch):
        import scrape_fixtures as sf

        path = tmp_path / "availability_features.csv"
        _write_csv(path, [
            {"date": "2026-01-01", "club": "Arsenal", "league": "E0", "availability_idx": "1.5",
             "key_player_present": "1", "starting_xi_value": "1"},
            {"date": "2026-01-02", "club": "Chelsea", "league": "E0", "availability_idx": "-0.1",
             "key_player_present": "1", "starting_xi_value": "1"},
            {"date": "2026-01-03", "club": "Fulham", "league": "E0", "availability_idx": "nan",
             "key_player_present": "1", "starting_xi_value": "1"},
            {"date": "2026-01-04", "club": "Everton", "league": "E0", "availability_idx": "inf",
             "key_player_present": "1", "starting_xi_value": "1"},
        ])
        monkeypatch.setattr(sf, "_AVAILABILITY_TABLE_PATH", path)
        assert sf._load_availability_table() == {}

    def test_accepts_boundary_values_zero_and_one(self, tmp_path, monkeypatch):
        import scrape_fixtures as sf

        path = tmp_path / "availability_features.csv"
        _write_csv(path, [
            {"date": "2026-01-01", "club": "Arsenal", "league": "E0", "availability_idx": "0.0",
             "key_player_present": "0", "starting_xi_value": "1"},
            {"date": "2026-01-01", "club": "Chelsea", "league": "E0", "availability_idx": "1.0",
             "key_player_present": "1", "starting_xi_value": "1"},
        ])
        monkeypatch.setattr(sf, "_AVAILABILITY_TABLE_PATH", path)
        table = sf._load_availability_table()
        assert table[sf.normalise("Arsenal")]["idx"] == 0.0
        assert table[sf.normalise("Chelsea")]["idx"] == 1.0


class TestAvailabilityFor:
    def test_returns_none_when_team_not_in_table(self):
        assert _availability_for({}, "Nonexistent FC") is None

    def test_returns_idx_and_key_player_present_when_both_known(self):
        table = {"arsenal": {"date": "2026-06-15", "idx": 0.72, "keyPlayerPresent": 0}}
        out = _availability_for(table, "Arsenal")
        assert out == {"idx": 0.72, "keyPlayerPresent": 0}

    def test_omits_key_player_present_when_unknown(self):
        table = {"arsenal": {"date": "2026-06-15", "idx": 0.72, "keyPlayerPresent": None}}
        out = _availability_for(table, "Arsenal")
        assert out == {"idx": 0.72}


class TestStatsRowsAvailabilitySubtab:
    def test_emits_an_availability_subtab_row_when_present(self):
        rows = _stats_rows(
            "ev1", "2026-07-07", {"form": {"home": {"last5": "WWDLW"}}}, None, None,
            {"home": {"idx": 0.72}, "away": None}, "2026-07-07T00:00:00Z",
        )
        subtabs = {r["subtab"] for r in rows}
        assert "availability" in subtabs

    def test_omits_the_subtab_when_both_sides_are_none(self):
        rows = _stats_rows(
            "ev1", "2026-07-07", None, None, None,
            {"home": None, "away": None}, "2026-07-07T00:00:00Z",
        )
        assert all(r["subtab"] != "availability" for r in rows)

    def test_omits_the_subtab_when_availability_is_none(self):
        rows = _stats_rows("ev1", "2026-07-07", None, None, None, None, "2026-07-07T00:00:00Z")
        assert all(r["subtab"] != "availability" for r in rows)
