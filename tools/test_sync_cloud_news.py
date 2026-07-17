"""Tests for sync_cloud_news.py — pure-function coverage (parse_and_validate,
merge_rows, slug) plus, as of the 2026-07-16 silent-failure-logging fix,
reason-threading coverage for sync_news/sync_xg/main with git_ls_tree/
git_show/git_fetch monkeypatched out (no real subprocess/network calls) —
git plumbing ITSELF (the subprocess.run wrapping) is still only exercised
manually against a live remote, not here.
"""
from __future__ import annotations

import sys
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


class TestSyncNewsReasonThreading:
    """[2026-07-16 silent-failure-logging fix] sync_news now returns
    (count, reason) instead of a bare count — reason is the concrete text
    that used to only reach a separately-buffered stderr _log() call (which
    production evidence showed could go missing entirely: a real
    'news:0 xg:0' summary line with zero matching _log reason lines anywhere
    in the retained worker logs). These tests exercise sync_news directly
    with git_ls_tree monkeypatched out — no real subprocess/network call."""

    def test_returns_the_git_ls_tree_failure_reason_when_directory_lookup_fails(self, monkeypatch):
        monkeypatch.setattr(scn, "git_ls_tree", lambda remote, branch, path: (None, "git ls-tree failed: fatal: bad revision"))
        count, reason = scn.sync_news("origin", "data", "2026-07-16", quiet=True)
        assert count == 0
        assert reason == "git ls-tree failed: fatal: bad revision"

    def test_returns_a_no_files_reason_when_directory_is_empty(self, monkeypatch):
        monkeypatch.setattr(scn, "git_ls_tree", lambda remote, branch, path: ([], ""))
        count, reason = scn.sync_news("origin", "data", "2026-07-16", quiet=True)
        assert count == 0
        assert reason == "no news_intel files for 2026-07-16"

    def test_summary_only_file_is_excluded_and_still_reports_the_no_files_reason(self, monkeypatch):
        # Mirrors the real 2026-07-16 production case: the cloud routine
        # wrote only _summary.json (slateSize: 0) — sync_news must not count
        # that as a real news file.
        monkeypatch.setattr(
            scn, "git_ls_tree",
            lambda remote, branch, path: (["data/news_intel/2026-07-16/_summary.json"], ""),
        )
        count, reason = scn.sync_news("origin", "data", "2026-07-16", quiet=True)
        assert count == 0
        assert reason == "no news_intel files for 2026-07-16"

    def test_returns_a_reason_when_files_exist_but_none_validate(self, monkeypatch):
        monkeypatch.setattr(
            scn, "git_ls_tree",
            lambda remote, branch, path: (["data/news_intel/2026-07-16/a_vs_b.json"], ""),
        )
        monkeypatch.setattr(scn, "git_show", lambda remote, branch, path: "{}")
        monkeypatch.setattr(scn, "parse_and_validate", lambda payload, date_str: None)
        count, reason = scn.sync_news("origin", "data", "2026-07-16", quiet=True)
        assert count == 0
        assert reason == "1 file(s) found for 2026-07-16 but none validated"

    def test_partial_failure_still_reports_a_reason_alongside_the_merged_count(self, monkeypatch):
        # [review finding, 2026-07-16] a partial failure (one file merges,
        # another fails) used to read as clean success (reason=None) — the
        # exact silent-gap class this fix exists to close.
        monkeypatch.setattr(
            scn, "git_ls_tree",
            lambda remote, branch, path: (
                ["data/news_intel/2026-07-16/a_vs_b.json", "data/news_intel/2026-07-16/c_vs_d.json"],
                "",
            ),
        )
        monkeypatch.setattr(
            scn, "git_show",
            lambda remote, branch, path: "{}" if "a_vs_b" in path else None,
        )
        monkeypatch.setattr(
            scn, "parse_and_validate",
            lambda payload, date_str: {
                "dt": date_str, "team_slug": "a", "source": "cloud_news",
                "summary": "s", "raw_json": "{}", "scraped_at": "2026-07-16T00:00:00Z",
            },
        )
        monkeypatch.setattr(scn.ds, "read_table", lambda table, date_str: [])
        written = {}
        monkeypatch.setattr(scn.ds, "write_table", lambda table, date_str, rows: written.update(rows=rows))
        count, reason = scn.sync_news("origin", "data", "2026-07-16", quiet=True)
        assert count == 1
        assert reason == "1/2 file(s) skipped (git show/JSON/validation failures)"
        assert written["rows"] == [{
            "dt": "2026-07-16", "team_slug": "a", "source": "cloud_news",
            "summary": "s", "raw_json": "{}", "scraped_at": "2026-07-16T00:00:00Z",
        }]


class TestSyncXgReasonThreading:
    def test_returns_the_git_ls_tree_failure_reason_when_directory_lookup_fails(self, monkeypatch):
        monkeypatch.setattr(scn, "git_ls_tree", lambda remote, branch, path: (None, "git fetch timed out or git is unavailable"))
        count, reason = scn.sync_xg("origin", "data", quiet=True)
        assert count == 0
        assert reason == "git fetch timed out or git is unavailable"

    def test_returns_a_reason_when_files_are_listed_but_none_copy(self, monkeypatch):
        monkeypatch.setattr(
            scn, "git_ls_tree",
            lambda remote, branch, path: (["data/xg/team_xg_table.json"], ""),
        )
        monkeypatch.setattr(scn, "git_show", lambda remote, branch, path: None)
        count, reason = scn.sync_xg("origin", "data", quiet=True)
        assert count == 0
        assert reason == "1 file(s) listed but none copied (git show failures)"

    def test_returns_none_reason_on_success(self, monkeypatch, tmp_path):
        monkeypatch.setattr(scn, "XG_OUT_DIR", tmp_path)
        monkeypatch.setattr(
            scn, "git_ls_tree",
            lambda remote, branch, path: (["data/xg/team_xg_table.json"], ""),
        )
        monkeypatch.setattr(scn, "git_show", lambda remote, branch, path: "{}")
        count, reason = scn.sync_xg("origin", "data", quiet=True)
        assert count == 1
        assert reason is None

    def test_partial_failure_still_reports_a_reason_alongside_the_copied_count(self, monkeypatch, tmp_path):
        # [review finding, 2026-07-16] mirrors the sync_news partial-failure
        # fix — one file copies, another fails git_show, and that must not
        # read as clean success.
        monkeypatch.setattr(scn, "XG_OUT_DIR", tmp_path)
        monkeypatch.setattr(
            scn, "git_ls_tree",
            lambda remote, branch, path: (
                ["data/xg/team_xg_table.json", "data/xg/broken.json"], ""
            ),
        )
        monkeypatch.setattr(
            scn, "git_show",
            lambda remote, branch, path: "{}" if "team_xg_table" in path else None,
        )
        count, reason = scn.sync_xg("origin", "data", quiet=True)
        assert count == 1
        assert reason == "1/2 file(s) failed to copy (git show failures)"
        assert (tmp_path / "team_xg_table.json").exists()
        assert not (tmp_path / "broken.json").exists()


class TestMainSummaryLineFoldsReasons:
    """[2026-07-16 silent-failure-logging fix] main() now folds skip/failure
    reasons into the single always-flushed summary print instead of relying
    solely on a separate stderr _log() call."""

    def test_folds_the_git_fetch_failure_reason_into_the_summary_line(self, monkeypatch, capsys):
        monkeypatch.setattr(sys, "argv", ["sync_cloud_news.py", "--date", "2026-07-16"])
        monkeypatch.setattr(scn, "git_fetch", lambda remote, branch: (False, "git fetch timed out or git is unavailable"))
        scn.main()
        out = capsys.readouterr().out
        assert "[sync_cloud_news] news:0 xg:0 — git fetch failed: git fetch timed out or git is unavailable" in out

    def test_folds_both_news_and_xg_reasons_when_both_are_empty(self, monkeypatch, capsys):
        monkeypatch.setattr(sys, "argv", ["sync_cloud_news.py", "--date", "2026-07-16"])
        monkeypatch.setattr(scn, "git_fetch", lambda remote, branch: (True, ""))
        monkeypatch.setattr(
            scn, "sync_news",
            lambda remote, branch, date_str, quiet: (0, "no news_intel files for 2026-07-16"),
        )
        monkeypatch.setattr(
            scn, "sync_xg",
            lambda remote, branch, quiet: (0, "no data/xg/*.json files on branch"),
        )
        scn.main()
        out = capsys.readouterr().out
        assert "news:0 xg:0" in out
        assert "no news_intel files for 2026-07-16" in out
        assert "no data/xg/*.json files on branch" in out

    def test_no_suffix_when_both_succeed(self, monkeypatch, capsys):
        monkeypatch.setattr(sys, "argv", ["sync_cloud_news.py", "--date", "2026-07-16"])
        monkeypatch.setattr(scn, "git_fetch", lambda remote, branch: (True, ""))
        monkeypatch.setattr(scn, "sync_news", lambda remote, branch, date_str, quiet: (3, None))
        monkeypatch.setattr(scn, "sync_xg", lambda remote, branch, quiet: (1, None))
        scn.main()
        out = capsys.readouterr().out.strip()
        assert out == "[sync_cloud_news] news:3 xg:1"


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
