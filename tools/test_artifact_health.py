"""Tests for tools/lib/artifact_health.py's PR-26 freshness/yield registry.
Exercises _check_one()/format_health_line() directly against tmp_path-backed
ArtifactSpecs rather than the real registry, so nothing here reads or
depends on the actual .tmp/ artifacts on disk.
"""
import json
import os
import time

try:
    from lib import artifact_health as ah
except ImportError:  # repo root on sys.path instead of tools/
    from tools.lib import artifact_health as ah


def _touch(path, content: bytes, age_hours: float = 0.0):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    if age_hours:
        old = time.time() - age_hours * 3600
        os.utime(path, (old, old))


def test_missing_file_reports_missing(tmp_path):
    spec = ah.ArtifactSpec("x", tmp_path / "nope.json", max_age_hours=24)
    result = ah._check_one(spec, time.time())
    assert result.status == "MISSING"


def test_fresh_populated_dict_is_ok(tmp_path):
    path = tmp_path / "x.json"
    _touch(path, json.dumps({"arsenal": 1, "chelsea": 2}).encode())
    spec = ah.ArtifactSpec("x", path, max_age_hours=24, count_fn=ah._json_len)
    result = ah._check_one(spec, time.time())
    assert result.status == "OK"
    assert "2" in result.detail


def test_fresh_populated_list_is_ok(tmp_path):
    path = tmp_path / "overlay.json"
    _touch(path, json.dumps([{"id": "1"}, {"id": "2"}, {"id": "3"}]).encode())
    spec = ah.ArtifactSpec("x", path, max_age_hours=24, count_fn=ah._json_len)
    result = ah._check_one(spec, time.time())
    assert result.status == "OK"
    assert "3" in result.detail


def test_fresh_but_empty_warns_when_zero_not_ok(tmp_path):
    path = tmp_path / "x.json"
    _touch(path, json.dumps({}).encode())
    spec = ah.ArtifactSpec("x", path, max_age_hours=24, count_fn=ah._json_len, zero_ok_if_fresh=False)
    result = ah._check_one(spec, time.time())
    assert result.status == "WARN"
    assert "EMPTY" in result.detail


def test_fresh_but_empty_is_ok_when_zero_expected(tmp_path):
    path = tmp_path / "x.json"
    _touch(path, json.dumps({}).encode())
    spec = ah.ArtifactSpec("x", path, max_age_hours=24, count_fn=ah._json_len, zero_ok_if_fresh=True)
    result = ah._check_one(spec, time.time())
    assert result.status == "OK"


def test_stale_populated_file_warns_regardless_of_count(tmp_path):
    path = tmp_path / "x.json"
    _touch(path, json.dumps({"arsenal": 1}).encode(), age_hours=48)
    spec = ah.ArtifactSpec("x", path, max_age_hours=24, count_fn=ah._json_len)
    result = ah._check_one(spec, time.time())
    assert result.status == "WARN"
    assert "STALE" in result.detail


def test_stale_zero_ok_artifact_still_warns_on_age(tmp_path):
    # zero_ok_if_fresh only excuses an empty COUNT — it must not also excuse
    # staleness, or a permanently-broken tier that always finds 0 items
    # would report OK forever.
    path = tmp_path / "x.json"
    _touch(path, json.dumps({}).encode(), age_hours=48)
    spec = ah.ArtifactSpec("x", path, max_age_hours=24, count_fn=ah._json_len, zero_ok_if_fresh=True)
    result = ah._check_one(spec, time.time())
    assert result.status == "WARN"
    assert "STALE" in result.detail


def test_existence_only_spec_ok_when_fresh_warn_when_stale(tmp_path):
    path = tmp_path / "sidecar.json"
    spec = ah.ArtifactSpec("sidecar", path, max_age_hours=24)

    _touch(path, b"{}")
    assert ah._check_one(spec, time.time()).status == "OK"

    _touch(path, b"{}", age_hours=48)
    assert ah._check_one(spec, time.time()).status == "WARN"


def test_csv_row_count_excludes_header():
    data = b"team,idx\narsenal,0.8\nchelsea,0.6\n"
    assert ah._csv_row_count(data) == 2


def test_csv_row_count_header_only_is_zero():
    assert ah._csv_row_count(b"team,idx\n") == 0


def test_malformed_json_counts_as_zero_not_a_crash(tmp_path):
    path = tmp_path / "x.json"
    _touch(path, b"{not valid json")
    spec = ah.ArtifactSpec("x", path, max_age_hours=24, count_fn=ah._json_len)
    result = ah._check_one(spec, time.time())
    assert result.status == "WARN"
    assert "EMPTY" in result.detail


def test_format_health_line_flags_non_ok_status():
    results = [
        ah.HealthResult("xg-table", "OK", "165 (2.1h old)"),
        ah.HealthResult("fotmob-xg", "WARN", "0 (2.1h old, EMPTY)"),
        ah.HealthResult("sidecar", "MISSING", "never written"),
    ]
    line = ah.format_health_line(results)
    assert line.startswith("data health: ")
    assert "xg-table 165 (2.1h old)," in line
    assert "fotmob-xg 0 (2.1h old, EMPTY), WARN" in line
    assert "sidecar never written, MISSING" in line
    assert line.isascii()  # no Unicode separators — see format_health_line's docstring


def test_unreadable_path_warns_instead_of_crashing(tmp_path):
    # A directory at the artifact's path makes read_bytes() raise OSError
    # (PermissionError on Windows, IsADirectoryError on POSIX — both are
    # OSError subclasses) without ever needing real filesystem permissions.
    path = tmp_path / "x.json"
    path.mkdir()
    spec = ah.ArtifactSpec("x", path, max_age_hours=24, count_fn=ah._json_len)
    result = ah._check_one(spec, time.time())
    assert result.status == "WARN"
    assert "unreadable" in result.detail


def test_registry_paths_match_known_producers():
    # Pins _registry()'s paths against the real producers elsewhere in the
    # repo (apps/worker's MARKET_CATALOG_OVERLAY_PATH, build_xg_table.py,
    # fetch_fotmob_xg.py, fetch_xg_fallback.py, scrape_fixtures.py's
    # SPORTYBET_SIDECAR) so a rename on either side breaks this test instead
    # of silently making that entry report MISSING forever.
    paths = {spec.name: spec.path.relative_to(ah.ROOT).as_posix() for spec in ah._registry()}
    assert paths == {
        "xg-table": ".tmp/xg/team_xg_table.json",
        "fotmob-xg": ".tmp/xg/fotmob_xg.json",
        "ai-mode-xg": ".tmp/xg/ai_mode_xg.json",
        "availability": ".tmp/squad-availability/availability_features.csv",
        "catalog-overlay": ".tmp/market_catalog_overlay.json",
        "sidecar": ".tmp/fixtures/sportybet_today.json",
    }


def test_check_all_covers_the_real_registry_without_crashing():
    # Runs against whatever's actually on disk (likely all MISSING on a
    # clean checkout) — just proves the real registry's specs are valid and
    # check_all() never raises, not that specific artifacts exist.
    results = ah.check_all()
    names = {r.name for r in results}
    assert names == {"xg-table", "fotmob-xg", "ai-mode-xg", "availability", "catalog-overlay", "sidecar"}
    assert all(r.status in ("OK", "WARN", "MISSING") for r in results)
