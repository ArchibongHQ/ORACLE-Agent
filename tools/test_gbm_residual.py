"""Tests for pure (no-I/O) helpers in tools/gbm_residual.py (audit M2-3)."""
import math

import numpy as np
import pandas as pd
import pytest

try:
    from gbm_residual import (
        _clubelo_key,
        _devivify,
        _normalise_ref,
        _rolling_stats,
        _update_history,
        build_features,
        rps_vector,
    )
except ImportError:  # repo root on sys.path instead of tools/
    from tools.gbm_residual import (
        _clubelo_key,
        _devivify,
        _normalise_ref,
        _rolling_stats,
        _update_history,
        build_features,
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


class TestNormaliseRef:
    def test_fdco_format_initial_first(self):
        # "M Clattenburg" → "clattenburg m"
        assert _normalise_ref("M Clattenburg") == "clattenburg m"

    def test_matchstats_format_surname_initial_country(self):
        # "Clattenburg M. (Eng)" → strip country, collapse dot → "clattenburg m"
        assert _normalise_ref("Clattenburg M. (Eng)") == "clattenburg m"

    def test_empty_string_returns_empty(self):
        assert _normalise_ref("") == ""

    def test_single_word_no_initial(self):
        # "Smith" has no second token → initial defaults to first char of parts[1] else ""
        result = _normalise_ref("Smith")
        assert result == "smith"


class TestBuildFeaturesAHFdcoFallback:
    """AH open/close line fallback from fdco columns when OTS lookup misses (audit M2-3)."""

    def _minimal_df(self, **extra: object) -> pd.DataFrame:
        base: dict = {
            "HomeTeam": "Alpha",
            "AwayTeam": "Beta",
            "FTHG": 1,
            "FTAG": 0,
            "FTR": "H",
            "PSCH": 2.0,
            "PSCD": 3.5,
            "PSCA": 4.0,
            "_season": "2425",
            "_div": "E0",
            "_league": "Premier League",
        }
        base.update(extra)
        df = pd.DataFrame([base])
        df["_date"] = pd.to_datetime("2025-01-01")
        return df

    def test_ah_open_close_populated_from_fdco_columns(self):
        df = self._minimal_df(AHh=-0.25, AHCh=-0.5)
        feats = build_features(df)  # no odds_ts_lookup
        assert len(feats) == 1
        assert feats.iloc[0]["ahOpenLine"] == pytest.approx(-0.25)
        assert feats.iloc[0]["ahCloseLine"] == pytest.approx(-0.5)
        assert feats.iloc[0]["ahCloseDelta"] == pytest.approx(-0.25)  # -0.5 - (-0.25)

    def test_ah_nan_when_fdco_columns_absent(self):
        df = self._minimal_df()  # no AHh / AHCh columns
        feats = build_features(df)
        assert len(feats) == 1
        assert math.isnan(feats.iloc[0]["ahOpenLine"])
        assert math.isnan(feats.iloc[0]["ahCloseLine"])
        assert math.isnan(feats.iloc[0]["ahCloseDelta"])

    def test_ots_lookup_takes_priority_over_fdco(self):
        df = self._minimal_df(AHh=-0.25, AHCh=-0.5)
        ots_lookup = {("2025-01-01", "alpha", "beta"): {
            "lineMovSlope": 0.01,
            "openToCloseDelta": 0.02,
            "ahOpenLine": -0.75,
            "ahCloseLine": -1.0,
            "ahCloseDelta": -0.25,
        }}
        feats = build_features(df, odds_ts_lookup=ots_lookup)
        assert len(feats) == 1
        # OTS value should win, not fdco fallback
        assert feats.iloc[0]["ahOpenLine"] == pytest.approx(-0.75)
        assert feats.iloc[0]["ahCloseLine"] == pytest.approx(-1.0)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
