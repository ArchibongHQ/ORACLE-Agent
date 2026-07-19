"""Tests for fetch_live_injuries.py — live per-fixture injuries/suspensions
via API-Football's /injuries endpoint.

fetch_lineups.py (the closest analog this tool is modeled on) has no test
file of its own, so this stays a light smoke test over the pure parsing
functions (parse_injuries/summarise_injuries), matching the level of
coverage the rest of this fetcher family has today — not full end-to-end
network mocking.
"""

from __future__ import annotations

import fetch_live_injuries as fli


# ── parse_injuries ───────────────────────────────────────────────────────

def test_parse_injuries_splits_home_and_away() -> None:
    raw = {
        "response": [
            {
                "player": {"id": 1, "name": "Bukayo Saka"},
                "team": {"id": 42, "name": "Arsenal"},
                "type": "Missing Fixture",
                "reason": "Hamstring Injury",
            },
            {
                "player": {"id": 2, "name": "Reece James"},
                "team": {"id": 49, "name": "Chelsea"},
                "type": "Questionable",
                "reason": "Knee Injury",
            },
        ]
    }
    home, away = fli.parse_injuries(raw, "Arsenal", "Chelsea")
    assert home == [{"name": "Bukayo Saka", "type": "Missing Fixture", "reason": "Hamstring Injury"}]
    assert away == [{"name": "Reece James", "type": "Questionable", "reason": "Knee Injury"}]


def test_parse_injuries_empty_response_returns_empty_lists() -> None:
    home, away = fli.parse_injuries({"response": []}, "Arsenal", "Chelsea")
    assert home == []
    assert away == []


def test_parse_injuries_missing_response_key_returns_empty_lists() -> None:
    home, away = fli.parse_injuries({}, "Arsenal", "Chelsea")
    assert home == []
    assert away == []


def test_parse_injuries_skips_entry_with_no_player_name() -> None:
    raw = {"response": [{"player": {}, "team": {"name": "Arsenal"}, "type": "x", "reason": "y"}]}
    home, away = fli.parse_injuries(raw, "Arsenal", "Chelsea")
    assert home == []
    assert away == []


def test_parse_injuries_skips_entry_matching_neither_team() -> None:
    raw = {
        "response": [
            {
                "player": {"name": "Unknown Player"},
                "team": {"name": "Some Other Club"},
                "type": "x",
                "reason": "y",
            }
        ]
    }
    home, away = fli.parse_injuries(raw, "Arsenal", "Chelsea")
    assert home == []
    assert away == []


# ── summarise_injuries ───────────────────────────────────────────────────

def test_summarise_injuries_counts_and_meta() -> None:
    home_list = [{"name": "Saka", "type": "Missing Fixture", "reason": "Hamstring"}]
    away_list = []
    meta = {"fixture_id": 123, "home": "Arsenal", "away": "Chelsea", "date": "2026-07-19T15:00:00+00:00"}
    summary = fli.summarise_injuries(home_list, away_list, meta)
    assert summary["fixture_id"] == 123
    assert summary["home"] == "Arsenal"
    assert summary["away"] == "Chelsea"
    assert summary["home_injuries"] == home_list
    assert summary["away_injuries"] == []
    assert summary["home_count"] == 1
    assert summary["away_count"] == 0
