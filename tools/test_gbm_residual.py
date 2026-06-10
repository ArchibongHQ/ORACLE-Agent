"""Tests for pure (no-I/O) helpers in tools/gbm_residual.py (audit M2-3)."""
import math

import numpy as np
import pandas as pd
import pytest

try:
    from gbm_residual import (
        _clubelo_key,
        _devivify,
        _rolling_stats,
        _update_history,
        rps_vector,
    )
except ImportError:  # repo root on sys.path instead of tools/
    from tools.gbm_residual import (
        _clubelo_key,
        _devivify,
        _rolling_stats,
        _update_history,
        rps_vector,
    )


class TestDevivify:
    def test_probabilities_sum_to_one(self):
        h, d, a = _devivify(2.0, 3.5, 3.2)
        assert math.isclose(h + d + a, 1.0, rel_tol=1e-12)

    def test_removes_overround(self):
        # Equal odds with margin -> equal fair probabilities
        h, d, a = _devivify(2.8, 2.8, 2.8)
        assert math.isclose(h, 1 / 3, rel_tol=1e-12)
        assert h == d == a

    def test_favourite_has_highest_probability(self):
        h, d, a = _devivify(1.5, 4.0, 7.0)
        assert h > d > a

    def test_known_values(self):
        # 1/2 + 1/4 + 1/4 = 1.0 (no margin) -> exact implied probs
        h, d, a = _devivify(2.0, 4.0, 4.0)
        assert math.isclose(h, 0.5, rel_tol=1e-12)
        assert math.isclose(d, 0.25, rel_tol=1e-12)
        assert math.isclose(a, 0.25, rel_tol=1e-12)


class TestRollingStats:
    HISTORY = [
        {"gf": 2, "ga": 0, "pts": 3},
        {"gf": 1, "ga": 1, "pts": 1},
        {"gf": 0, "ga": 3, "pts": 0},
        {"gf": 4, "ga": 1, "pts": 3},
    ]

    def test_window_covers_full_history(self):
        feat: dict = {}
        _rolling_stats(self.HISTORY, 5, "home", feat)
        assert feat["homeGF5"] == pytest.approx(7 / 4)
        assert feat["homeGA5"] == pytest.approx(5 / 4)
        assert feat["homePts5"] == pytest.approx(7 / 4)
        assert feat["homeWR5"] == pytest.approx(2 / 4)   # two wins
        assert feat["homeDR5"] == pytest.approx(1 / 4)   # one draw

    def test_window_truncates_to_most_recent(self):
        feat: dict = {}
        _rolling_stats(self.HISTORY, 2, "away", feat)
        # last two matches: (0,3,0) and (4,1,3)
        assert feat["awayGF2"] == pytest.approx(2.0)
        assert feat["awayGA2"] == pytest.approx(2.0)
        assert feat["awayWR2"] == pytest.approx(0.5)

    def test_empty_history_yields_zeroes(self):
        feat: dict = {}
        _rolling_stats([], 5, "home", feat)
        assert feat["homeGF5"] == 0
        assert feat["homeWR5"] == 0


class TestRpsVector:
    def test_perfect_forecast_is_zero(self):
        probs = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
        outcomes = np.array([0, 2])
        assert rps_vector(probs, outcomes) == pytest.approx([0.0, 0.0])

    def test_uniform_forecast_home_win(self):
        probs = np.array([[1 / 3, 1 / 3, 1 / 3]])
        outcomes = np.array([0])
        # cum_p = [1/3, 2/3], cum_a = [1, 1] -> ((2/3)^2 + (1/3)^2)/2 = 5/18
        assert rps_vector(probs, outcomes)[0] == pytest.approx(5 / 18)

    def test_orderedness_penalises_distant_errors_more(self):
        # All mass on away when home won is worse than all mass on draw
        probs = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0]])
        outcomes = np.array([0, 0])
        rps = rps_vector(probs, outcomes)
        assert rps[0] > rps[1]


class TestClubeloKey:
    def test_known_alias(self):
        assert _clubelo_key("Man Utd") == "Man United"
        assert _clubelo_key("Nott'm Forest") == "Nottm Forest"

    def test_case_insensitive_lookup(self):
        assert _clubelo_key("manchester city") == "Man City"

    def test_unknown_passthrough(self):
        assert _clubelo_key("Accrington Stanley") == "Accrington Stanley"


class TestUpdateHistory:
    def test_records_both_teams_with_correct_points(self):
        history: dict = {}
        home_map: dict = {}
        away_map: dict = {}
        row = pd.Series({
            "HomeTeam": "Alpha", "AwayTeam": "Beta",
            "FTHG": 2, "FTAG": 1, "FTR": "H",
        })
        _update_history(history, home_map, away_map, row)
        assert history["Alpha"] == [{"gf": 2, "ga": 1, "pts": 3}]
        assert history["Beta"] == [{"gf": 1, "ga": 2, "pts": 0}]
        assert home_map["Alpha"] == history["Alpha"]
        assert away_map["Beta"] == history["Beta"]
        assert "Beta" not in home_map and "Alpha" not in away_map

    def test_draw_gives_one_point_each(self):
        history: dict = {}
        row = pd.Series({
            "HomeTeam": "Alpha", "AwayTeam": "Beta",
            "FTHG": 0, "FTAG": 0, "FTR": "D",
        })
        _update_history(history, {}, {}, row)
        assert history["Alpha"][0]["pts"] == 1
        assert history["Beta"][0]["pts"] == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
