"""Tests for the fixtures-partition-collapse guard in daily_store.py's
write_table(): SportyBet's "today" page returns near-nothing when scraped
near midnight (the day is ending), so the evening "back-online" re-acquire
was calling write_table("fixtures", date_str, rows) with a near-empty rows
list and Parquet's unconditional replace was silently clobbering the
morning's healthy partition with it. write_table() now refuses that specific
fixtures-collapse case (see _FIXTURES_MIN_HEALTHY_ROWS /
_FIXTURES_COLLAPSE_FRACTION in daily_store.py) while leaving every other
write path (odds/stats/news, and any non-collapsing fixtures write)
untouched.

There is no root override on write_table()/read_table() (see _selftest() in
daily_store.py for the same constraint), so these tests write through the
real Parquet lake under ROOT/.tmp/oracle-daily using a synthetic dt=
partition date that can never collide with real data, and clean it up
before/after each test via an autouse fixture.
"""
import shutil

import pytest

try:
    import daily_store as ds
except ImportError:  # repo root on sys.path instead of tools/
    from tools import daily_store as ds


FIXTURES_DT = "1999-02-01"
ODDS_DT = "1999-02-02"


def _clean(table: str, date_str: str) -> None:
    shutil.rmtree(ds.partition_dir(table, date_str), ignore_errors=True)


@pytest.fixture(autouse=True)
def _clean_synthetic_partitions():
    _clean("fixtures", FIXTURES_DT)
    _clean("odds", ODDS_DT)
    yield
    _clean("fixtures", FIXTURES_DT)
    _clean("odds", ODDS_DT)


def _fixture_rows(n: int, date_str: str = FIXTURES_DT) -> list[dict]:
    stamp = ds.utc_now_stamp()
    return [
        {
            "dt": date_str, "event_id": f"sr:match:{i}", "home": f"Home {i}",
            "away": f"Away {i}", "league": "Test League",
            "league_id": "sr:tournament:1", "kickoff_utc": f"{date_str}T20:00:00Z",
            "market_count": 10, "scraped_at": stamp,
        }
        for i in range(n)
    ]


def _odds_rows(n: int, date_str: str = ODDS_DT) -> list[dict]:
    stamp = ds.utc_now_stamp()
    return [
        {
            "dt": date_str, "event_id": f"sr:match:{i}", "market": "1x2",
            "side": "home", "price": 1.85, "overround": 1.06, "scraped_at": stamp,
        }
        for i in range(n)
    ]


# ── normal writes still succeed ──────────────────────────────────────────────

def test_empty_write_succeeds_when_no_existing_partition():
    ds.write_table("fixtures", FIXTURES_DT, [])
    assert ds.read_table("fixtures", FIXTURES_DT) == []


def test_growing_write_succeeds():
    ds.write_table("fixtures", FIXTURES_DT, _fixture_rows(5))
    ds.write_table("fixtures", FIXTURES_DT, _fixture_rows(8))
    assert len(ds.read_table("fixtures", FIXTURES_DT)) == 8


# ── the collapse guard (core bug fix) ────────────────────────────────────────

def test_near_empty_write_refused_when_replacing_healthy_partition(capsys):
    ds.write_table("fixtures", FIXTURES_DT, _fixture_rows(100))
    result = ds.write_table("fixtures", FIXTURES_DT, _fixture_rows(2))

    # Old partition survives untouched — this is the bug: the evening
    # near-midnight re-acquire must not clobber the morning's good data.
    assert len(ds.read_table("fixtures", FIXTURES_DT)) == 100
    assert result == ds.partition_file("fixtures", FIXTURES_DT)
    err = capsys.readouterr().err
    assert "refusing fixtures write" in err
    assert "dt=1999-02-01" in err


def test_write_at_or_above_collapse_threshold_succeeds():
    # A real (not collapsed) day-over-day drop — still >= 50% of the old
    # count — must write through, not be treated as a scrape failure.
    ds.write_table("fixtures", FIXTURES_DT, _fixture_rows(100))
    ds.write_table("fixtures", FIXTURES_DT, _fixture_rows(60))
    assert len(ds.read_table("fixtures", FIXTURES_DT)) == 60


def test_guard_engages_exactly_at_min_healthy_rows_floor():
    # Existing count sitting exactly at _FIXTURES_MIN_HEALTHY_ROWS (10) must
    # still engage the guard (comparison is >=, not >).
    ds.write_table("fixtures", FIXTURES_DT, _fixture_rows(10))
    ds.write_table("fixtures", FIXTURES_DT, _fixture_rows(4))
    assert len(ds.read_table("fixtures", FIXTURES_DT)) == 10


def test_write_at_exact_fraction_boundary_is_not_refused():
    # new_count exactly at 50% of existing must write through (comparison is
    # strict <, not <=).
    ds.write_table("fixtures", FIXTURES_DT, _fixture_rows(10))
    ds.write_table("fixtures", FIXTURES_DT, _fixture_rows(5))
    assert len(ds.read_table("fixtures", FIXTURES_DT)) == 5


def test_small_existing_partition_is_never_guarded():
    # A genuinely slow league day: the existing partition itself never
    # crossed the "healthy" floor, so the guard must not engage even
    # though the new write is smaller still.
    ds.write_table("fixtures", FIXTURES_DT, _fixture_rows(5))
    ds.write_table("fixtures", FIXTURES_DT, _fixture_rows(1))
    assert len(ds.read_table("fixtures", FIXTURES_DT)) == 1


# ── guard is fixtures-only ───────────────────────────────────────────────────

def test_other_tables_write_unconditionally_even_when_shrinking():
    ds.write_table("odds", ODDS_DT, _odds_rows(100))
    ds.write_table("odds", ODDS_DT, _odds_rows(1))
    assert len(ds.read_table("odds", ODDS_DT)) == 1
