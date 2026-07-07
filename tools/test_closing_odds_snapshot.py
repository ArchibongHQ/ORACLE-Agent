"""Tests for closing_odds_snapshot.py (PR-8a) — the T-30m odds-only
re-snapshot entry point. Mocks _sb_get; never hits the network."""

import sys

try:
    import closing_odds_snapshot as cos
except ImportError:  # repo root on sys.path instead of tools/
    from tools import closing_odds_snapshot as cos


def _fake_event_payload(home_odds=1.85, draw_odds=3.4, away_odds=4.5):
    return {
        "data": {
            "markets": [
                {
                    "id": "1",
                    "name": "1X2",
                    "outcomes": [
                        {"id": "1", "desc": "Home", "odds": str(home_odds)},
                        {"id": "2", "desc": "Draw", "odds": str(draw_odds)},
                        {"id": "3", "desc": "Away", "odds": str(away_odds)},
                    ],
                }
            ]
        }
    }


def test_fetch_closing_odds_returns_odds_keyed_by_event_id(monkeypatch):
    monkeypatch.setattr(cos, "_sb_get", lambda url: _fake_event_payload())
    monkeypatch.setattr(cos, "time", type("T", (), {"sleep": staticmethod(lambda s: None)}))

    result = cos.fetch_closing_odds(["sr:match:111"])

    assert "sr:match:111" in result
    assert result["sr:match:111"]["1x2"] == {"home": "1.85", "draw": "3.4", "away": "4.5"}


def test_a_failing_event_id_is_skipped_not_fatal(monkeypatch):
    def fake_sb_get(url):
        if "222" in url:
            return None
        return _fake_event_payload()

    monkeypatch.setattr(cos, "_sb_get", fake_sb_get)
    monkeypatch.setattr(cos, "time", type("T", (), {"sleep": staticmethod(lambda s: None)}))

    result = cos.fetch_closing_odds(["sr:match:111", "sr:match:222", "sr:match:333"])

    assert "sr:match:111" in result
    assert "sr:match:222" not in result
    assert "sr:match:333" in result


def test_output_only_contains_whitelisted_fields(monkeypatch):
    def fake_parse_odds(markets_data):
        # Simulate _parse_odds' real full shape, including fields NOT in the whitelist.
        return {
            "1x2": {"home": "1.85", "draw": "3.4", "away": "4.5"},
            "ou15": {"over": "1.3", "under": "3.1"},
            "ou25": None,
            "ou35": None,
            "tt_home_05": {"over": "1.1", "under": "6.0"},
            "tt_away_05": None,
            "btts": None,
            "dc": None,
            "dnb": None,
            "ah": None,
        }

    monkeypatch.setattr(cos, "_sb_get", lambda url: _fake_event_payload())
    monkeypatch.setattr(cos, "_parse_odds", fake_parse_odds)
    monkeypatch.setattr(cos, "time", type("T", (), {"sleep": staticmethod(lambda s: None)}))

    result = cos.fetch_closing_odds(["sr:match:111"])

    assert set(result["sr:match:111"].keys()) == set(cos._SNAPSHOT_FIELDS)
    assert "tt_home_05" not in result["sr:match:111"]


def test_empty_event_ids_returns_empty_dict():
    assert cos.fetch_closing_odds([]) == {}


def test_cli_prints_one_json_line_to_stdout(monkeypatch, capsys):
    monkeypatch.setattr(cos, "_sb_get", lambda url: _fake_event_payload())
    monkeypatch.setattr(cos, "time", type("T", (), {"sleep": staticmethod(lambda s: None)}))
    monkeypatch.setattr(sys, "argv", ["closing_odds_snapshot.py", "sr:match:111"])

    cos.main()

    out = capsys.readouterr().out.strip()
    lines = out.splitlines()
    assert len(lines) == 1
    import json

    parsed = json.loads(lines[0])
    assert "sr:match:111" in parsed
