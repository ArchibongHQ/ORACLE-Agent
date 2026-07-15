"""daily_store.py — date-partitioned Parquet lake for ORACLE's daily acquisition.

The lake is the latency seam: the 00:00 acquisition job writes fixtures + odds +
stats + news here once, and the TS analysis/worker path reads it (fast, via DuckDB)
instead of re-scraping live per batch.

Layout (Hive-style date partitions):
    .tmp/oracle-daily/
        fixtures/ dt=YYYY-MM-DD/part.parquet
        odds/     dt=YYYY-MM-DD/part.parquet
        stats/    dt=YYYY-MM-DD/part.parquet
        news/     dt=YYYY-MM-DD/part.parquet

Design notes:
  * Every row carries a `scraped_at` UTC stamp (point-in-time / auditability).
  * Variable-shape bodies (stat subtabs, news payloads) are stored as JSON *strings*
    so the Parquet schema is stable day-to-day. DuckDB unions partitions by column
    name; a drifting schema would break `read_parquet` over the partition glob.
  * Writes are atomic (temp file -> os.replace) so a concurrent reader never sees a
    partial part file.
  * This module is dependency-light (pyarrow only) and importable by acquire_daily.py
    and enrich_news.py. It is also runnable as a CLI (--purge / --selftest).

Usage:
    python tools/daily_store.py --selftest        # write synthetic + read back
    python tools/daily_store.py --purge            # run the 24h retention sweep
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Optional

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
LAKE_ROOT = ROOT / ".tmp" / "oracle-daily"
ARCHIVE_ROOT = LAKE_ROOT / "_archive"

# Explicit per-table schemas keep the Parquet column set stable across days.
SCHEMAS: dict[str, pa.Schema] = {
    "fixtures": pa.schema([
        ("dt", pa.string()),
        ("event_id", pa.string()),
        ("home", pa.string()),
        ("away", pa.string()),
        ("league", pa.string()),
        # Sportradar tournament ID (e.g. "sr:tournament:17"), when the source
        # provided one — empty string when absent (older partitions, or a
        # source without one). Added 2026-07-06 (P0-2 league-collision fix);
        # each partition's own dt= file is read in full, never globbed across
        # dates, so this is a safe additive column (see dailyStore.ts).
        ("league_id", pa.string()),
        ("kickoff_utc", pa.string()),
        ("market_count", pa.int64()),
        ("scraped_at", pa.string()),
    ]),
    "odds": pa.schema([
        ("dt", pa.string()),
        ("event_id", pa.string()),
        ("market", pa.string()),
        ("side", pa.string()),
        ("price", pa.float64()),
        ("overround", pa.float64()),
        ("scraped_at", pa.string()),
    ]),
    "stats": pa.schema([
        ("dt", pa.string()),
        ("event_id", pa.string()),
        ("subtab", pa.string()),
        ("payload_json", pa.string()),
        ("scraped_at", pa.string()),
    ]),
    "news": pa.schema([
        ("dt", pa.string()),
        ("team_slug", pa.string()),
        ("source", pa.string()),
        ("summary", pa.string()),
        ("raw_json", pa.string()),
        ("scraped_at", pa.string()),
    ]),
}


def utc_now_stamp() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_today() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")


def partition_dir(table: str, date_str: str, root: Path = LAKE_ROOT) -> Path:
    return root / table / f"dt={date_str}"


def partition_file(table: str, date_str: str, root: Path = LAKE_ROOT) -> Path:
    return partition_dir(table, date_str, root) / "part.parquet"


# Guard against the SportyBet near-midnight "today"-page collapse: the evening
# "back-online" re-acquire can scrape a near-empty fixtures list when the day is
# ending, and write_table()'s unconditional replace would clobber the morning's
# healthy partition with it. Only fires when the existing partition is non-trivial
# (>= _FIXTURES_MIN_HEALTHY_ROWS) and the incoming write would shrink it below
# _FIXTURES_COLLAPSE_FRACTION of its current size — a genuinely smaller-but-real
# slate (e.g. new >= 50% of the old count) still writes through.
_FIXTURES_MIN_HEALTHY_ROWS = 10
_FIXTURES_COLLAPSE_FRACTION = 0.5


def _existing_row_count(table: str, date_str: str) -> int:
    """Row count of an already-written partition, via Parquet metadata (no full
    read). Returns 0 when the partition doesn't exist yet or can't be read."""
    f = partition_file(table, date_str)
    if not f.exists():
        return 0
    try:
        return pq.ParquetFile(f).metadata.num_rows
    except Exception:
        return 0


def _coerce_rows(table: str, rows: list[dict[str, Any]]) -> pa.Table:
    """Build a pyarrow Table from row dicts against the table's explicit schema.

    Missing keys become null; extra keys are ignored. This makes the writer
    tolerant of partially-enriched rows without breaking the stable schema.
    """
    schema = SCHEMAS[table]
    columns: dict[str, list[Any]] = {field.name: [] for field in schema}
    for row in rows:
        for field in schema:
            columns[field.name].append(row.get(field.name))
    arrays = [pa.array(columns[field.name], type=field.type) for field in schema]
    return pa.Table.from_arrays(arrays, schema=schema)


def write_table(table: str, date_str: str, rows: list[dict[str, Any]]) -> Path:
    """Atomically write `rows` to the table's partition for `date_str`.

    Writing an empty list still produces a valid empty partition (readers fail
    open on a missing partition, but an explicit empty file records "we ran").

    Fixtures-only guard: refuses to replace an existing healthy "fixtures"
    partition with a near-empty one (see _FIXTURES_MIN_HEALTHY_ROWS /
    _FIXTURES_COLLAPSE_FRACTION above) — logs a warning and keeps the old
    partition instead of writing. Every other table (odds/stats/news) and
    every non-collapsing fixtures write still goes through unconditionally.
    """
    if table not in SCHEMAS:
        raise ValueError(f"unknown table: {table}")
    if table == "fixtures":
        existing_count = _existing_row_count(table, date_str)
        new_count = len(rows)
        if (existing_count >= _FIXTURES_MIN_HEALTHY_ROWS
                and new_count < existing_count * _FIXTURES_COLLAPSE_FRACTION):
            print(
                f"[daily_store] refusing fixtures write for dt={date_str}: "
                f"new={new_count} rows would replace existing={existing_count} rows "
                f"(< {_FIXTURES_COLLAPSE_FRACTION:.0%} threshold) — keeping old partition",
                file=sys.stderr,
            )
            return partition_file(table, date_str)
    pa_table = _coerce_rows(table, rows)
    out_dir = partition_dir(table, date_str)
    out_dir.mkdir(parents=True, exist_ok=True)
    final = out_dir / "part.parquet"
    tmp = out_dir / "part.parquet.tmp"
    pq.write_table(pa_table, tmp, compression="snappy")
    os.replace(tmp, final)
    return final


def read_table(table: str, date_str: str) -> list[dict[str, Any]]:
    """Read a partition back as row dicts. Returns [] on a missing partition.

    Reads the single part file directly (ParquetFile), not via the dataset API,
    so the `dt=` directory name is NOT re-inferred as a Hive partition column —
    `dt` is already a real column in the file, and double-binding it raises a
    type-merge error.
    """
    f = partition_file(table, date_str)
    if not f.exists():
        return []
    return pq.ParquetFile(f).read().to_pylist()


def list_partition_dates(table: str, root: Path = LAKE_ROOT) -> list[str]:
    base = root / table
    if not base.exists():
        return []
    out: list[str] = []
    for child in base.iterdir():
        if child.is_dir() and child.name.startswith("dt="):
            out.append(child.name[len("dt="):])
    return sorted(out)


def purge_old(retain_days: int = 1, compress: Optional[bool] = None) -> dict[str, int]:
    """Delete partitions older than `retain_days` days (keeps today + retain_days back).

    If compress is True (or env ORACLE_DAILY_COMPRESS=1), re-write the partition to
    `_archive/` with zstd before deleting. Returns {deleted, archived} counts.
    """
    if compress is None:
        compress = os.environ.get("ORACLE_DAILY_COMPRESS", "") == "1"
    today = datetime.now(tz=timezone.utc).date()
    cutoff = today - timedelta(days=retain_days)
    deleted = 0
    archived = 0
    for table in SCHEMAS:
        for date_str in list_partition_dates(table):
            try:
                d = datetime.strptime(date_str, "%Y-%m-%d").date()
            except ValueError:
                continue
            if d >= cutoff:
                continue
            src_dir = partition_dir(table, date_str)
            if compress:
                try:
                    pa_table = pq.ParquetFile(src_dir / "part.parquet").read()
                    arc_dir = partition_dir(table, date_str, root=ARCHIVE_ROOT)
                    arc_dir.mkdir(parents=True, exist_ok=True)
                    pq.write_table(pa_table, arc_dir / "part.parquet", compression="zstd")
                    archived += 1
                except Exception as exc:  # archiving is best-effort, never blocks purge
                    print(f"[daily_store] archive failed {table}/{date_str}: {exc}", file=sys.stderr)
            shutil.rmtree(src_dir, ignore_errors=True)
            deleted += 1
    return {"deleted": deleted, "archived": archived}


def _selftest() -> int:
    date_str = "1999-01-01"  # synthetic, never collides with a real partition
    stamp = utc_now_stamp()
    write_table("fixtures", date_str, [
        {"dt": date_str, "event_id": "sr:match:1", "home": "A", "away": "B",
         "league": "Test League", "league_id": "sr:tournament:1",
         "kickoff_utc": "1999-01-01T20:00:00Z",
         "market_count": 42, "scraped_at": stamp},
    ])
    write_table("odds", date_str, [
        {"dt": date_str, "event_id": "sr:match:1", "market": "1x2", "side": "home",
         "price": 1.85, "overround": 1.06, "scraped_at": stamp},
        {"dt": date_str, "event_id": "sr:match:1", "market": "ou25", "side": "over",
         "price": 2.10, "overround": None, "scraped_at": stamp},
    ])
    write_table("stats", date_str, [
        {"dt": date_str, "event_id": "sr:match:1", "subtab": "h2h",
         "payload_json": '{"meetings":5}', "scraped_at": stamp},
    ])
    write_table("news", date_str, [
        {"dt": date_str, "team_slug": "a", "source": "google_ai",
         "summary": "no injuries", "raw_json": "{}", "scraped_at": stamp},
    ])
    fx = read_table("fixtures", date_str)
    od = read_table("odds", date_str)
    st = read_table("stats", date_str)
    nw = read_table("news", date_str)
    ok = (len(fx) == 1 and fx[0]["market_count"] == 42 and
          fx[0]["league_id"] == "sr:tournament:1" and
          len(od) == 2 and od[1]["overround"] is None and
          len(st) == 1 and st[0]["subtab"] == "h2h" and
          len(nw) == 1 and nw[0]["source"] == "google_ai")
    # cleanup synthetic partitions
    for table in SCHEMAS:
        shutil.rmtree(partition_dir(table, date_str), ignore_errors=True)
    print(f"[daily_store] selftest {'PASS' if ok else 'FAIL'}: "
          f"fixtures={len(fx)} odds={len(od)} stats={len(st)} news={len(nw)}")
    return 0 if ok else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="ORACLE daily Parquet lake helper")
    parser.add_argument("--purge", action="store_true", help="Run the 24h retention sweep")
    parser.add_argument("--retain-days", type=int, default=1,
                        help="Days to retain (today + N back); default 1")
    parser.add_argument("--selftest", action="store_true", help="Write+read synthetic data")
    args = parser.parse_args()

    if args.selftest:
        sys.exit(_selftest())
    if args.purge:
        result = purge_old(retain_days=args.retain_days)
        print(f"[daily_store] purge deleted:{result['deleted']} archived:{result['archived']}")
        return
    parser.print_help()


if __name__ == "__main__":
    main()
