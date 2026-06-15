"""Tests for the SportyBet gismo stats parsers in scrape_fixtures.py.

Fixtures below are trimmed copies of REAL stats.fn.sportradar.com gismo responses
(Superettan match sr:match:67126172, season 138194; H2H from Barca vs Real). They
guard against the schema-mismatch bugs that silently emptied the sidecar: form was
read as a string (it's a list of {type} objects), standings/goals were keyed by
team id (they're keyed by row order, team id is nested under .team._id), goals used
non-existent avgGoalsFor fields (real fields are scoredsum/concededsum/matches), and
h2h read result as a string (it's an object with a .winner field).
"""

try:
    from scrape_fixtures import _parse_form, _parse_goals, _parse_h2h, _parse_standings
except ImportError:  # repo root on sys.path instead of tools/
    from tools.scrape_fixtures import _parse_form, _parse_goals, _parse_h2h, _parse_standings


HOME_ID = 679779  # GIF Sundsvall
AWAY_ID = 6360  # Osters IF


class TestParseForm:
    DATA = {
        "teams": {
            "home": {
                "team": {"_id": HOME_ID, "name": "Sundsvall"},
                "form": [{"type": "W"}, {"type": "L"}, {"type": "L"}, {"type": "W"}, {"type": "L"},
                         {"type": "L"}, {"type": "L"}],  # newest-first, 7 entries
            },
            "away": {
                "team": {"_id": AWAY_ID, "name": "Osters"},
                "form": [{"type": "W"}, {"type": "W"}, {"type": "W"}, {"type": "L"}, {"type": "L"}],
            },
        }
    }

    def test_extracts_last5_from_object_list(self):
        out = _parse_form(self.DATA)
        assert out["home"]["last5"] == "WLLWL"  # only the most recent 5
        assert out["home"]["w"] == 2 and out["home"]["l"] == 3
        assert out["home"]["name"] == "Sundsvall"
        assert out["away"]["last5"] == "WWWLL"

    def test_none_on_empty(self):
        assert _parse_form(None) is None

    def test_handles_missing_form_list(self):
        out = _parse_form({"teams": {"home": {"team": {"name": "X"}}, "away": {}}})
        assert out["home"]["last5"] == ""
        assert out["home"]["w"] == 0

    def test_counts_draws_and_ignores_non_dict_entries(self):
        data = {
            "teams": {
                "home": {
                    "team": {"name": "X"},
                    # mix a draw and a stray non-dict element (malformed feed)
                    "form": [{"type": "D"}, "garbage", {"type": "W"}, {"type": "D"}],
                },
                "away": {"team": {"name": "Y"}, "form": []},
            }
        }
        out = _parse_form(data)
        assert out["home"]["last5"] == "DWD"  # non-dict skipped, no raise
        assert out["home"]["d"] == 2 and out["home"]["w"] == 1


class TestParseStandings:
    DATA = {
        "tables": [
            {
                "tablerows": [
                    {
                        "team": {"_id": AWAY_ID, "name": "Osters"},
                        "pos": 7, "pointsTotal": 17, "total": 11,
                        "goalsForTotal": 15, "goalsAgainstTotal": 18,
                    },
                    {
                        "team": {"_id": HOME_ID, "name": "Sundsvall"},
                        "pos": 16, "pointsTotal": 9, "total": 11,
                        "goalsForTotal": 9, "goalsAgainstTotal": 20,
                    },
                ]
            }
        ]
    }

    def test_extracts_both_teams_by_nested_id(self):
        out = _parse_standings(self.DATA, HOME_ID, AWAY_ID)
        assert out["home"] == {"pos": 16, "points": 9, "played": 11, "gf": 9, "ga": 20}
        assert out["away"] == {"pos": 7, "points": 17, "played": 11, "gf": 15, "ga": 18}

    def test_none_when_no_rows_match(self):
        assert _parse_standings(self.DATA, 111, 222) is None

    def test_none_on_empty(self):
        assert _parse_standings(None, HOME_ID, AWAY_ID) is None

    def test_null_team_id_row_does_not_match_null_target_ids(self):
        # Regression: when home_id/away_id are None (non-digit feed ids) but a
        # season was still resolved, a malformed row with no team._id must NOT
        # match via `None in (None, None)` and get mislabeled as a real team.
        data = {"tables": [{"tablerows": [{"team": {}, "pos": 1, "pointsTotal": 30}]}]}
        assert _parse_standings(data, None, None) is None


class TestParseGoals:
    # teams keyed by array index, team id nested, raw sums (not averages)
    DATA = {
        "teams": {
            "0": {"team": {"_id": HOME_ID}, "scoredsum": 9, "concededsum": 20, "matches": 11},
            "1": {"team": {"_id": AWAY_ID}, "scoredsum": 15, "concededsum": 18, "matches": 11},
        }
    }

    def test_derives_average_from_sums(self):
        out = _parse_goals(self.DATA, HOME_ID, AWAY_ID)
        assert out["home"]["avg_scored"] == round(9 / 11, 3)
        assert out["home"]["avg_conceded"] == round(20 / 11, 3)
        assert out["away"]["avg_scored"] == round(15 / 11, 3)

    def test_skips_team_with_zero_matches(self):
        data = {"teams": {"0": {"team": {"_id": HOME_ID}, "scoredsum": 0, "matches": 0}}}
        assert _parse_goals(data, HOME_ID, AWAY_ID) is None

    def test_none_on_empty(self):
        assert _parse_goals(None, HOME_ID, AWAY_ID) is None

    def test_string_team_id_is_skipped(self):
        # Documents current behaviour: ids are matched as ints (isinstance check),
        # so a stringified team._id is not matched. Live match_info ids are ints.
        data = {"teams": {"0": {"team": {"_id": str(HOME_ID)}, "scoredsum": 9, "matches": 11}}}
        assert _parse_goals(data, HOME_ID, AWAY_ID) is None


class TestParseH2H:
    DATA = {
        "matches": [
            {"result": {"home": 2, "away": 0, "winner": "home"}},
            {"result": {"home": 1, "away": 1, "winner": "draw"}},
            {"result": {"home": 0, "away": 3, "winner": "away"}},
        ]
    }

    def test_counts_by_winner_object(self):
        out = _parse_h2h(self.DATA)
        assert out == {"total": 3, "home_wins": 1, "away_wins": 1, "draws": 1}

    def test_none_on_empty_matches(self):
        assert _parse_h2h({"matches": []}) is None
        assert _parse_h2h({}) is None

    def test_legacy_string_result_does_not_raise(self):
        # A bare-string result (legacy schema) has no .get() — must be ignored,
        # not crash. Valid winner-object matches still count.
        data = {
            "matches": [
                {"result": "home"},  # legacy string shape
                {"result": {"home": 2, "away": 1, "winner": "home"}},
            ]
        }
        out = _parse_h2h(data)
        assert out == {"total": 2, "home_wins": 1, "away_wins": 0, "draws": 0}
