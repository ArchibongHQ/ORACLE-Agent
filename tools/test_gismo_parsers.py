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
    from scrape_fixtures import (
        _parse_disciplinary,
        _parse_form,
        _parse_goals,
        _parse_h2h,
        _parse_overunder,
        _parse_rest_congestion,
        _parse_squad_averages,
        _parse_standings,
        _parse_venue,
    )
except ImportError:  # repo root on sys.path instead of tools/
    from tools.scrape_fixtures import (
        _parse_disciplinary,
        _parse_form,
        _parse_goals,
        _parse_h2h,
        _parse_overunder,
        _parse_rest_congestion,
        _parse_squad_averages,
        _parse_standings,
        _parse_venue,
    )


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

    def test_streak_is_leading_run_of_identical_results(self):
        out = _parse_form(self.DATA)
        # home last5 "WLLWL" — most recent is a single W → streak +1
        assert out["home"]["streak"] == 1
        # away last5 "WWWLL" — most recent 3 are wins → streak +3
        assert out["away"]["streak"] == 3

    def test_streak_is_zero_on_a_draw(self):
        data = {
            "teams": {
                "home": {"team": {"name": "X"}, "form": [{"type": "D"}, {"type": "W"}]},
                "away": {"team": {"name": "Y"}, "form": []},
            }
        }
        out = _parse_form(data)
        assert out["home"]["streak"] == 0

    def test_streak_is_negative_for_a_loss_run(self):
        data = {
            "teams": {
                "home": {"team": {"name": "X"}, "form": [{"type": "L"}, {"type": "L"}, {"type": "W"}]},
                "away": {"team": {"name": "Y"}, "form": []},
            }
        }
        out = _parse_form(data)
        assert out["home"]["streak"] == -2

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

    def test_extracts_wdl_and_diff_when_present(self):
        # Live-verified 2026-07-20: winTotal/drawTotal/lossTotal/goalDiffTotal
        # sit in the same row already read for pos/points/played/gf/ga.
        data = {
            "tables": [
                {
                    "tablerows": [
                        {
                            "team": {"_id": HOME_ID}, "pos": 21, "pointsTotal": 26, "total": 19,
                            "goalsForTotal": 31, "goalsAgainstTotal": 35,
                            "winTotal": 6, "drawTotal": 4, "lossTotal": 9, "goalDiffTotal": -4,
                        }
                    ]
                }
            ]
        }
        out = _parse_standings(data, HOME_ID, AWAY_ID)
        assert out["home"]["w"] == 6
        assert out["home"]["d"] == 4
        assert out["home"]["l"] == 9
        assert out["home"]["diff"] == -4
        # w + d + l reconciles to played, matching this row's own numbers.
        assert out["home"]["w"] + out["home"]["d"] + out["home"]["l"] == out["home"]["played"]

    def test_omits_wdl_keys_entirely_when_source_lacks_them(self):
        # Never fabricate: a row missing winTotal/etc. must not report w/d/l/diff
        # as None — the keys should be absent, matching _parse_disciplinary's
        # "omit rather than null" convention.
        out = _parse_standings(self.DATA, HOME_ID, AWAY_ID)
        assert "w" not in out["home"]
        assert "d" not in out["home"]
        assert "l" not in out["home"]
        assert "diff" not in out["home"]


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

    @staticmethod
    def _summary(out):
        # The aggregate contract the engine scorer + report line depend on. `matches`
        # is additive per-meeting detail (verified live 2026-06-29) asserted separately
        # — assert the summary subset here, not whole-dict equality.
        return {k: out[k] for k in ("total", "home_wins", "away_wins", "draws")}

    def test_counts_by_winner_object(self):
        out = _parse_h2h(self.DATA)
        assert self._summary(out) == {"total": 3, "home_wins": 1, "away_wins": 1, "draws": 1}

    def test_emits_match_by_match_detail(self):
        # The per-match scoreline/winner behind the counters (e.g. "2-0; 1-1; 0-3").
        out = _parse_h2h(self.DATA)
        assert len(out["matches"]) == 3
        assert out["matches"][0]["home_goals"] == 2
        assert out["matches"][0]["away_goals"] == 0
        assert out["matches"][0]["winner"] == "home"

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
        assert self._summary(out) == {"total": 2, "home_wins": 1, "away_wins": 0, "draws": 0}

    def test_null_winner_equal_score_counts_as_draw(self):
        # Real live shape (verified 2026-06-25, Liverpool vs Man Utd): draws come
        # back as winner:null with equal home/away goals, NOT the literal "draw"
        # string. These must be inferred from the scoreline, not dropped.
        data = {
            "matches": [
                {"result": {"home": 2, "away": 2, "winner": None}},  # draw
                {"result": {"home": 0, "away": 0, "winner": None}},  # draw
                {"result": {"home": 3, "away": 1, "winner": "home"}},
                {"result": {"home": 1, "away": 2, "winner": None}},  # non-equal null → not a draw
            ]
        }
        out = _parse_h2h(data)
        assert self._summary(out) == {"total": 4, "home_wins": 1, "away_wins": 0, "draws": 2}
        # the inferred draws also surface tagged "draw" in the per-match detail
        assert [m["winner"] for m in out["matches"]] == ["draw", "draw", "home", None]

    def test_total_reconciles_to_counted_window(self):
        # `total` must equal the size of the counted window (<=10), so
        # home_wins + away_wins + draws always reconciles for the report line.
        data = {"matches": [{"result": {"home": 1, "away": 0, "winner": "home"}}] * 15}
        out = _parse_h2h(data)
        assert out["total"] == 10
        assert out["home_wins"] + out["away_wins"] + out["draws"] == out["total"]


# Real shape verified live 2026-06-20 against stats_season_overunder/101177 (WC 2026):
# `stats` is keyed by the team's "uniqueteam" id (team.uid), NOT the "team" doctype
# `_id` that match_info/stats_season_tables/stats_season_goals/stats_season_fixtures
# all key by — Czechia: _id=9509, uid=4714 on the same match_info team object.
HOME_UID = 4714  # Czechia
AWAY_UID = 4736  # South Africa


class TestParseOverunder:
    DATA = {
        "stats": {
            str(HOME_UID): {
                "team": {"_id": HOME_UID, "name": "Czechia"},
                "total": {"ft": {
                    "0.5": {"over": 2, "under": 0},
                    "1.5": {"over": 2, "under": 0},
                    "2.5": {"over": 1, "under": 1},
                    "3.5": {"over": 0, "under": 2},
                }},
            },
            str(AWAY_UID): {
                "team": {"_id": AWAY_UID, "name": "South Africa"},
                "total": {"ft": {
                    "1.5": {"over": 0, "under": 0},  # zero matches recorded — omitted, not 0%
                    "2.5": {"over": 0, "under": 2},
                }},
            },
        }
    }

    def test_derives_pct_from_over_under_counts(self):
        out = _parse_overunder(self.DATA, HOME_UID, AWAY_UID)
        assert out["home"] == {"over15_pct": 1.0, "over25_pct": 0.5, "over35_pct": 0.0}
        # away 1.5 line has 0+0 matches → omitted; 2.5 line has 0/2 → 0.0
        assert out["away"] == {"over25_pct": 0.0}

    def test_none_on_empty(self):
        assert _parse_overunder(None, HOME_UID, AWAY_UID) is None

    def test_none_when_uid_not_found(self):
        assert _parse_overunder(self.DATA, 999, 888) is None

    def test_id_keyed_lookup_misses_uid_keyed_data(self):
        # Regression guard: passing the "team" doctype _id (9509/17949) instead of
        # uid must NOT silently match — this was the live schema-mismatch bug.
        assert _parse_overunder(self.DATA, 9509, 17949) is None

    def test_extracts_ht_lines_from_p1_when_present(self):
        # Live-verified 2026-07-20: `total.p1` (first-half) sits alongside
        # `total.ft`, same {over,under} shape.
        data = {
            "stats": {
                str(HOME_UID): {
                    "team": {"_id": HOME_UID, "name": "Czechia"},
                    "total": {
                        "ft": {"1.5": {"over": 2, "under": 0}},
                        "p1": {
                            "0.5": {"over": 13, "under": 3},
                            "1.5": {"over": 5, "under": 11},
                        },
                    },
                }
            }
        }
        out = _parse_overunder(data, HOME_UID, AWAY_UID)
        assert out["home"]["over15_pct"] == 1.0
        assert out["home"]["ht_over05_pct"] == round(13 / 16, 3)
        assert out["home"]["ht_over15_pct"] == round(5 / 16, 3)

    def test_no_p1_block_contributes_no_ht_keys(self):
        # self.DATA has no `p1` — must not fabricate ht_over*_pct keys.
        out = _parse_overunder(self.DATA, HOME_UID, AWAY_UID)
        assert "ht_over05_pct" not in out["home"]
        assert "ht_over15_pct" not in out["home"]


class TestParseRestCongestion:
    # Real shape verified live 2026-06-20 against stats_season_fixtures/101177:
    # flat matches[] list, teams.home/away._id (team doctype id), time.uts (unix secs).
    HOME_ID = 9509
    AWAY_ID = 17949
    DATA = {
        "matches": [
            {  # home's previous match, 3 days before kickoff
                "teams": {"home": {"_id": HOME_ID}, "away": {"_id": 111}},
                "time": {"uts": 1_000_000 - 3 * 86400},
            },
            {  # away's previous match, 5 days before kickoff
                "teams": {"home": {"_id": 222}, "away": {"_id": AWAY_ID}},
                "time": {"uts": 1_000_000 - 5 * 86400},
            },
            {  # home's next match, 2 days after kickoff
                "teams": {"home": {"_id": HOME_ID}, "away": {"_id": 333}},
                "time": {"uts": 1_000_000 + 2 * 86400},
            },
            {  # postponed — must not count as home's "previous" match despite the closer date
                "teams": {"home": {"_id": HOME_ID}, "away": {"_id": 444}},
                "time": {"uts": 1_000_000 - 1 * 86400},
                "postponed": True,
            },
        ]
    }

    def test_derives_rest_and_next_days_per_team(self):
        out = _parse_rest_congestion(self.DATA, self.HOME_ID, self.AWAY_ID, 1_000_000)
        assert out["home"] == {"rest_days": 3.0, "next_days": 2.0}
        assert out["away"] == {"rest_days": 5.0}  # no future match in the fixture list

    def test_postponed_matches_are_excluded(self):
        # If postponed weren't excluded, home's rest_days would be 1.0, not 3.0
        out = _parse_rest_congestion(self.DATA, self.HOME_ID, self.AWAY_ID, 1_000_000)
        assert out["home"]["rest_days"] == 3.0

    def test_none_on_empty(self):
        assert _parse_rest_congestion(None, self.HOME_ID, self.AWAY_ID, 1_000_000) is None

    def test_none_when_team_has_no_matches(self):
        assert _parse_rest_congestion({"matches": []}, self.HOME_ID, self.AWAY_ID, 1_000_000) is None

    def test_none_when_team_ids_not_in_data(self):
        # DATA has real matches, but neither queried id (555/666) appears in
        # any of them — distinct from the empty-matches-list case above.
        assert _parse_rest_congestion(self.DATA, 555, 666, 1_000_000) is None


class TestParseDisciplinary:
    DATA = {
        "stats": {
            "yellowcardsaverage": {"home": 4.83, "total": 3.5},
            "redcardsaverage": {"home": 0.0, "total": 0.1},
            "foulsaverage": {"home": 12.1, "total": 11.0},
        }
    }

    def test_extracts_yellow_red_fouls_for_venue(self):
        out = _parse_disciplinary(self.DATA, "home")
        assert out["yellow_avg"] == 4.83
        assert out["red_avg"] == 0.0
        assert out["fouls_avg"] == 12.1

    def test_total_avg_sums_yellow_and_red(self):
        out = _parse_disciplinary(self.DATA, "home")
        assert out["total_avg"] == 4.83

    def test_total_avg_treats_missing_red_as_zero(self):
        # yellow present, red genuinely absent from the source (not 0.0) —
        # total_avg still computes (red treated as 0), matching the docstring's
        # "only fabricate the sum, not the underlying reds" contract.
        data = {"stats": {"yellowcardsaverage": {"home": 3.0}}}
        out = _parse_disciplinary(data, "home")
        assert out["total_avg"] == 3.0
        assert "red_avg" not in out

    def test_no_total_avg_when_yellow_absent(self):
        # A missing yellow makes the whole record unreliable — no fabricated
        # total from red_avg alone.
        data = {"stats": {"redcardsaverage": {"home": 1.0}}}
        out = _parse_disciplinary(data, "home")
        assert "total_avg" not in out

    def test_falls_back_to_total_when_venue_split_absent(self):
        out = _parse_disciplinary(self.DATA, "away")  # no "away" key in any stat
        assert out["yellow_avg"] == 3.5  # falls back to "total"

    def test_none_on_empty(self):
        assert _parse_disciplinary(None, "home") is None


class TestParseSquadAverages:
    # Real shape verified live 2026-07-20 against stats_team_squad/206019
    # (Real Monarchs SLC, MLS Next Pro) — height/weight=0 is Sportradar's null
    # sentinel for an unmeasured player, not a real 0cm/0kg measurement.
    DATA = {
        "players": [
            {"birthdate": {"uts": 1_015_891_200}, "height": 185, "weight": 78},  # ~2002 birth
            {"birthdate": {"uts": 1_069_977_600}, "height": 190, "weight": 84},  # ~2003 birth
            {"birthdate": {"uts": 1_000_000_000}, "height": 0, "weight": 0},  # sentinel — excluded
        ]
    }

    def test_computes_mean_height_and_weight_excluding_zero_sentinel(self):
        out = _parse_squad_averages(self.DATA)
        assert out["avg_height_cm"] == round((185 + 190) / 2, 1)
        assert out["avg_weight_kg"] == round((78 + 84) / 2, 1)

    def test_computes_mean_age_from_birthdate(self):
        out = _parse_squad_averages(self.DATA)
        # All 3 players have a valid birthdate (unlike height/weight, no
        # sentinel observed for this field) — age uses all 3.
        assert isinstance(out["avg_age"], float)
        assert 15 < out["avg_age"] < 40  # sanity bound, not an exact value (uses live "now")

    def test_none_on_empty(self):
        assert _parse_squad_averages(None) is None
        assert _parse_squad_averages({"players": []}) is None

    def test_no_height_weight_keys_when_all_are_zero_sentinel(self):
        # Valid birthdate but sentinel height/weight — out is a real dict
        # (age present) that must simply omit the height/weight keys, not
        # report them as 0.
        data = {"players": [{"birthdate": {"uts": 1_000_000_000}, "height": 0, "weight": 0}]}
        out = _parse_squad_averages(data)
        assert out is not None
        assert "avg_height_cm" not in out
        assert "avg_weight_kg" not in out

    def test_ignores_non_dict_player_entries(self):
        data = {"players": [{"height": 180, "weight": 75}, "garbage", None]}
        out = _parse_squad_averages(data)
        assert out["avg_height_cm"] == 180.0


class TestParseVenue:
    # Real shape verified live 2026-07-21 against match_info/67126642 (Kalmar FF
    # vs Malmo, Allsvenskan) — venue data is embedded in match_info's own
    # `stadium` object, there is NO separate gismo venue query. `capacity` is a
    # STRING in the live response, not an int.
    DATA = {
        "match": {"stadiumid": 2322},
        "stadium": {
            "_doc": "stadium",
            "_id": "2322",
            "name": "Guldfageln Arena",
            "city": "Kalmar",
            "country": "Sweden",
            "capacity": "12500",
            "googlecoords": "56.691230,16.314930",
        },
    }

    def test_extracts_name_city_country_and_coerces_capacity_to_int(self):
        out = _parse_venue(self.DATA)
        assert out["name"] == "Guldfageln Arena"
        assert out["city"] == "Kalmar"
        assert out["country"] == "Sweden"
        assert out["capacity"] == 12500  # string "12500" coerced to int

    def test_none_when_stadium_absent(self):
        # Neutral-ground / venue-unknown fixtures return no stadium object at all
        # (a club friendly returned stadium=None live) — must degrade to None.
        assert _parse_venue({"match": {"stadiumid": 0}}) is None
        assert _parse_venue({"stadium": None}) is None
        assert _parse_venue(None) is None

    def test_omits_empty_string_fields_never_fabricates(self):
        data = {"stadium": {"name": "Some Ground", "city": "", "country": "  "}}
        out = _parse_venue(data)
        assert out == {"name": "Some Ground"}
        assert "city" not in out and "country" not in out

    def test_drops_non_numeric_or_zero_capacity(self):
        assert _parse_venue({"stadium": {"name": "X", "capacity": "n/a"}}) == {"name": "X"}
        assert _parse_venue({"stadium": {"name": "X", "capacity": "0"}}) == {"name": "X"}
        assert _parse_venue({"stadium": {"name": "X", "capacity": True}}) == {"name": "X"}

    def test_capacity_as_native_int_also_accepted(self):
        out = _parse_venue({"stadium": {"name": "X", "capacity": 40000}})
        assert out["capacity"] == 40000
