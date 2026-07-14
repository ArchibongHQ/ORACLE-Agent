"""Tests for sync_cloud_news.py — pure-function coverage only (parse_and_validate,
merge_rows, slug). No real git subprocess calls; git plumbing (fetch/ls-tree/show)
is exercised manually against a live remote, not here.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

try:
    import sync_cloud_news as scn
except ImportError:  # repo root on sys.path instead of tools/
    from tools import sync_cloud_news as scn

try:
    import enrich_news
except ImportError:
    from tools import enrich_news


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _valid_payload(**overrides) -> dict:
    payload = {
        "home": "Real Madrid",
        "away": "Barcelona",
        "injuries": ["Player X — hamstring"],
        "suspensions": [],
        "lineupHints": ["4-3-3 expected"],
        "motivationFlags": [],
        "travelFlags": [],
        "sources": ["https://example.com/report"],
        "confidence": 0.8,
        "model": "perplexity-sonar-pro",
        "observedAt": _iso(datetime.now(tz=timezone.utc) - timedelta(hours=1)),
    }
    payload.update(overrides)
    return payload


class TestParseAndValidateAccepts:
    def test_valid_payload_produces_a_lake_row(self):
        row = scn.parse_and_validate(_valid_payload(), "2026-07-11")
        assert row is not None
        assert row["dt"] == "2026-07-11"
        assert row["team_slug"] == "real_madrid"
        assert row["source"] == "cloud_news"
        assert row["summary"].startswith("inj:1 sus:0 lineup:1")
        assert "Player X" in row["summary"]
        assert row["scraped_at"] == _valid_payload()["observedAt"] or isinstance(row["scraped_at"], str)

    def test_raw_json_contains_only_the_news_intel_subset(self):
        row = scn.parse_and_validate(_valid_payload(), "2026-07-11")
        import json
        raw = json.loads(row["raw_json"])
        assert set(raw.keys()) == {
            "injuries", "suspensions", "lineupHints", "motivationFlags",
            "travelFlags", "sources", "confidence", "model", "observedAt",
        }

    def test_summary_falls_back_to_lineup_hint_when_no_injuries(self):
        row = scn.parse_and_validate(
            _valid_payload(injuries=[], lineupHints=["Starting keeper confirmed"]), "2026-07-11"
        )
        assert row is not None
        assert "Starting keeper confirmed" in row["summary"]

    def test_summary_capped_at_1000_chars(self):
        long_item = "x" * 2000
        row = scn.parse_and_validate(_valid_payload(injuries=[long_item]), "2026-07-11")
        assert row is not None
        assert len(row["summary"]) <= 1000


class TestParseAndValidateRejects:
    def test_rejects_stale_observed_at(self):
        stale = _iso(datetime.now(tz=timezone.utc) - timedelta(hours=25))
        row = scn.parse_and_validate(_valid_payload(observedAt=stale), "2026-07-11")
        assert row is None

    def test_rejects_future_observed_at(self):
        future = _iso(datetime.now(tz=timezone.utc) + timedelta(hours=2))
        row = scn.parse_and_validate(_valid_payload(observedAt=future), "2026-07-11")
        assert row is None

    def test_accepts_observed_at_just_within_24h(self):
        recent = _iso(datetime.now(tz=timezone.utc) - timedelta(hours=23, minutes=59))
        row = scn.parse_and_validate(_valid_payload(observedAt=recent), "2026-07-11")
        assert row is not None

    def test_rejects_missing_home(self):
        payload = _valid_payload()
        del payload["home"]
        assert scn.parse_and_validate(payload, "2026-07-11") is None

    def test_rejects_blank_home(self):
        assert scn.parse_and_validate(_valid_payload(home="   "), "2026-07-11") is None

    def test_rejects_confidence_out_of_range_high(self):
        assert scn.parse_and_validate(_valid_payload(confidence=1.5), "2026-07-11") is None

    def test_rejects_confidence_out_of_range_low(self):
        assert scn.parse_and_validate(_valid_payload(confidence=-0.1), "2026-07-11") is None

    def test_rejects_non_numeric_confidence(self):
        assert scn.parse_and_validate(_valid_payload(confidence="high"), "2026-07-11") is None

    def test_rejects_boolean_confidence(self):
        assert scn.parse_and_validate(_valid_payload(confidence=True), "2026-07-11") is None

    def test_rejects_missing_array_field(self):
        payload = _valid_payload()
        del payload["injuries"]
        assert scn.parse_and_validate(payload, "2026-07-11") is None

    def test_rejects_array_field_with_non_string_items(self):
        assert scn.parse_and_validate(_valid_payload(injuries=[1, 2]), "2026-07-11") is None

    def test_rejects_missing_model(self):
        payload = _valid_payload()
        del payload["model"]
        assert scn.parse_and_validate(payload, "2026-07-11") is None

    def test_rejects_unparsable_observed_at(self):
        assert scn.parse_and_validate(_valid_payload(observedAt="not-a-date"), "2026-07-11") is None

    def test_rejects_non_dict_payload(self):
        assert scn.parse_and_validate([], "2026-07-11") is None  # type: ignore[arg-type]


class TestMergeRows:
    def test_drops_prior_cloud_news_rows_and_appends_new(self):
        existing = [
            {"team_slug": "a", "source": "cloud_news", "summary": "old"},
            {"team_slug": "b", "source": "rss_news", "summary": "keep me"},
        ]
        cloud = [{"team_slug": "a", "source": "cloud_news", "summary": "new"}]
        merged = scn.merge_rows(existing, cloud)
        assert {"team_slug": "b", "source": "rss_news", "summary": "keep me"} in merged
        assert {"team_slug": "a", "source": "cloud_news", "summary": "new"} in merged
        assert {"team_slug": "a", "source": "cloud_news", "summary": "old"} not in merged
        assert len(merged) == 2

    def test_keeps_perplexity_and_google_ai_rows_untouched(self):
        existing = [
            {"team_slug": "a", "source": "perplexity", "summary": "p"},
            {"team_slug": "a", "source": "google_ai", "summary": "g"},
        ]
        merged = scn.merge_rows(existing, [])
        assert merged == existing

    def test_empty_existing_and_empty_cloud_is_empty(self):
        assert scn.merge_rows([], []) == []

    def test_appends_cloud_rows_when_no_prior_cloud_news(self):
        existing = [{"team_slug": "a", "source": "rss_news", "summary": "r"}]
        cloud = [{"team_slug": "b", "source": "cloud_news", "summary": "c"}]
        merged = scn.merge_rows(existing, cloud)
        assert len(merged) == 2


class TestSlugParity:
    @pytest.mark.parametrize("team", [
        "Real Madrid",
        "Barcelona",
        "Bayern München",
        "Paris Saint-Germain",
        "Boca Juniors",
        "1. FC Köln",
        "Śląsk Wrocław",
        "Botafogo (RJ)",
        "AS Saint-Étienne",
    ])
    def test_matches_enrich_news_slug(self, team):
        assert scn.slug(team) == enrich_news.slug(team)
