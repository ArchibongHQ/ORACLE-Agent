"""Tests for run_live_xg_refresh (PR-7, §8.3): the standalone off-peak FotMob
xG refresh reads the SportyBet sidecar already on disk for its team list
instead of re-scraping (fetch_fotmob_xg.py's rolling team-xG prior only
benefits a team's NEXT scrape regardless of which day's fixtures supplied the
name — see the function's own docstring). These tests verify the sidecar-read
+ _maybe_fetch_live_xg handoff in isolation — no real Playwright/subprocess
calls.
"""
import json

try:
    import acquire_daily as ad
except ImportError:  # repo root on sys.path instead of tools/
    from tools import acquire_daily as ad


def _stub_maybe_fetch_live_xg(monkeypatch, captured):
    def fake(events, quiet=False):
        captured["events"] = events
        captured["quiet"] = quiet
    monkeypatch.setattr(ad, "_maybe_fetch_live_xg", fake)


def test_reads_events_from_the_sidecar_and_forwards_them(tmp_path, monkeypatch):
    sidecar = tmp_path / "sportybet_today.json"
    sidecar.write_text(
        json.dumps({"date": "2026-07-07", "events": [{"home": "Arsenal", "away": "Chelsea"}]}),
        encoding="utf-8",
    )
    monkeypatch.setattr(ad.sf, "SPORTYBET_SIDECAR", sidecar)
    captured: dict = {}
    _stub_maybe_fetch_live_xg(monkeypatch, captured)

    ad.run_live_xg_refresh(quiet=True)

    assert captured["events"] == [{"home": "Arsenal", "away": "Chelsea"}]
    assert captured["quiet"] is True


def test_missing_sidecar_degrades_to_an_empty_events_list(tmp_path, monkeypatch):
    monkeypatch.setattr(ad.sf, "SPORTYBET_SIDECAR", tmp_path / "nope.json")
    captured: dict = {}
    _stub_maybe_fetch_live_xg(monkeypatch, captured)

    ad.run_live_xg_refresh(quiet=True)

    assert captured["events"] == []


def test_corrupt_sidecar_degrades_to_an_empty_events_list(tmp_path, monkeypatch):
    sidecar = tmp_path / "sportybet_today.json"
    sidecar.write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(ad.sf, "SPORTYBET_SIDECAR", sidecar)
    captured: dict = {}
    _stub_maybe_fetch_live_xg(monkeypatch, captured)

    ad.run_live_xg_refresh(quiet=True)

    assert captured["events"] == []


def test_non_list_events_field_degrades_to_empty(tmp_path, monkeypatch):
    sidecar = tmp_path / "sportybet_today.json"
    sidecar.write_text(json.dumps({"date": "2026-07-07", "events": "not-a-list"}), encoding="utf-8")
    monkeypatch.setattr(ad.sf, "SPORTYBET_SIDECAR", sidecar)
    captured: dict = {}
    _stub_maybe_fetch_live_xg(monkeypatch, captured)

    ad.run_live_xg_refresh(quiet=True)

    assert captured["events"] == []
