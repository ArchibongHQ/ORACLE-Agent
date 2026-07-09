"""Tests for the referee assignment + cards-rate merge added to
scrape_fixtures.py (PR-25 item 2): _load_referee_assignments_table/
_load_referee_cards_table/_referee_for look up a fixture's assigned referee
(tools/fetch_referee_assignments.py's premierleague.com scrape) and their
lake-computed shrunk cards rate (tools/compute_referee_cards.py), merging a
`referee` block into the sidecar exactly like the existing xg/availability/
weather subtabs — fail-open (None) on any lookup miss, never fatal.
"""

from __future__ import annotations

import json

try:
    from scrape_fixtures import (
        _load_referee_assignments_table,
        _load_referee_cards_table,
        _referee_for,
    )
except ImportError:  # repo root on sys.path instead of tools/
    from tools.scrape_fixtures import (
        _load_referee_assignments_table,
        _load_referee_cards_table,
        _referee_for,
    )


class TestLoadRefereeAssignmentsTable:
    def test_missing_file_returns_empty_dict(self, tmp_path, monkeypatch):
        import scrape_fixtures as sf

        monkeypatch.setattr(sf, "_REFEREE_ASSIGNMENTS_PATH", tmp_path / "nope.json")
        assert sf._load_referee_assignments_table() == {}

    def test_loads_and_keys_by_normalised_team_pair(self, tmp_path, monkeypatch):
        import scrape_fixtures as sf

        path = tmp_path / "referee_assignments.json"
        path.write_text(json.dumps({
            "assignments": [
                {"home": "Brighton", "away": "Man Utd", "referee": "Sam Barrott", "dateRaw": "Sun 24 May"},
                {"home": "Spurs", "away": "Everton", "referee": "Anthony Taylor", "dateRaw": "Sun 24 May"},
            ]
        }), encoding="utf-8")
        monkeypatch.setattr(sf, "_REFEREE_ASSIGNMENTS_PATH", path)
        table = _load_referee_assignments_table()
        assert table[(sf.normalise("Brighton"), sf.normalise("Man Utd"))] == "Sam Barrott"
        assert table[(sf.normalise("Spurs"), sf.normalise("Everton"))] == "Anthony Taylor"

    def test_skips_malformed_entries(self, tmp_path, monkeypatch):
        import scrape_fixtures as sf

        path = tmp_path / "referee_assignments.json"
        path.write_text(json.dumps({
            "assignments": [
                {"home": "Brighton", "away": None, "referee": "Sam Barrott"},
                {"home": "", "away": "Everton", "referee": "Anthony Taylor"},
                {"home": "Spurs", "away": "Everton", "referee": ""},
            ]
        }), encoding="utf-8")
        monkeypatch.setattr(sf, "_REFEREE_ASSIGNMENTS_PATH", path)
        assert _load_referee_assignments_table() == {}

    def test_corrupt_json_returns_empty_dict(self, tmp_path, monkeypatch):
        import scrape_fixtures as sf

        path = tmp_path / "referee_assignments.json"
        path.write_text("{not valid json", encoding="utf-8")
        monkeypatch.setattr(sf, "_REFEREE_ASSIGNMENTS_PATH", path)
        assert _load_referee_assignments_table() == {}


class TestLoadRefereeCardsTable:
    def test_missing_file_returns_empty_tuple(self, tmp_path, monkeypatch):
        import scrape_fixtures as sf

        monkeypatch.setattr(sf, "_REFEREE_CARDS_PATH", tmp_path / "nope.json")
        by_key, league_means = _load_referee_cards_table()
        assert by_key == {} and league_means == {}

    def test_loads_by_key_and_league_means(self, tmp_path, monkeypatch):
        import scrape_fixtures as sf

        path = tmp_path / "referee_cards.json"
        path.write_text(json.dumps({
            "leagueMeans": {"Premier League": 3.73},
            "byKey": {
                "Premier League|s.barrott": {
                    "league": "Premier League", "referee": "S Barrott",
                    "n": 40, "rawRate": 3.9, "shrunkRate": 3.87,
                }
            },
        }), encoding="utf-8")
        monkeypatch.setattr(sf, "_REFEREE_CARDS_PATH", path)
        by_key, league_means = _load_referee_cards_table()
        assert league_means["Premier League"] == 3.73
        assert by_key["Premier League|s.barrott"]["shrunkRate"] == 3.87


class TestRefereeFor:
    def test_returns_none_when_no_assignment(self):
        assert _referee_for({}, {}, {}, "Brighton", "Man Utd", "Premier League") is None

    def test_empirical_rate_when_referee_found_in_cards_table(self):
        import scrape_fixtures as sf

        assignments = {(sf.normalise("Brighton"), sf.normalise("Man Utd")): "Sam Barrott"}
        cards_by_key = {
            "Premier League|s.barrott": {"shrunkRate": 3.87, "rawRate": 3.9, "n": 40}
        }
        out = _referee_for(assignments, cards_by_key, {"Premier League": 3.73},
                            "Brighton", "Man Utd", "Premier League")
        assert out == {"name": "Sam Barrott", "cardsRate": 3.87, "cardsRateSrc": "empirical"}

    def test_league_mean_fallback_when_referee_not_in_cards_table(self):
        import scrape_fixtures as sf

        assignments = {(sf.normalise("Brighton"), sf.normalise("Man Utd")): "New Official"}
        out = _referee_for(assignments, {}, {"Premier League": 3.73},
                            "Brighton", "Man Utd", "Premier League")
        assert out == {"name": "New Official", "cardsRate": 3.73, "cardsRateSrc": "league_mean_fallback"}

    def test_null_rate_when_league_wholly_absent_from_lake(self):
        import scrape_fixtures as sf

        assignments = {(sf.normalise("Brighton"), sf.normalise("Man Utd")): "Sam Barrott"}
        out = _referee_for(assignments, {}, {}, "Brighton", "Man Utd", "Premier League")
        assert out == {"name": "Sam Barrott", "cardsRate": None, "cardsRateSrc": None}

    def test_uses_first_initial_surname_key_to_bridge_name_formats(self):
        # Regression guard for the abbreviated-vs-full-name gotcha documented
        # in compute_referee_cards.py: the lake stores "S Barrott", the PL
        # scrape surfaces "Sam Barrott" — _referee_for must bridge them.
        import scrape_fixtures as sf

        assignments = {(sf.normalise("Brighton"), sf.normalise("Man Utd")): "Sam Barrott"}
        cards_by_key = {"Premier League|s.barrott": {"shrunkRate": 4.1}}
        out = _referee_for(assignments, cards_by_key, {}, "Brighton", "Man Utd", "Premier League")
        assert out["cardsRateSrc"] == "empirical"
        assert out["cardsRate"] == 4.1
