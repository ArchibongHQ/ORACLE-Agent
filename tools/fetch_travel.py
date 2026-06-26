#!/usr/bin/env python3
"""fetch_travel.py — build a normalised team → {lat, lon, altitude} lookup from
tools/lib/stadiums.csv for the travel-friction + altitude engine features.

The engine already consumes RunState.telemetry.travelKm / altitudeM
(packages/engine/src/execution/index.ts applyTravelFriction) but the runtime
never populated them from a deterministic source. This emits the static venue
table the TS side (packages/runtime/src/travel.ts) uses to compute the away
team's haversine travel distance at fixture-injection time.

Keys are normalised via tools/lib/team_names.py so SportyBet display strings
join the same way every other ORACLE source does.

Output: .tmp/travel/venues.json
  { "<normalised team>": { "lat": float, "lon": float, "altitude": float } }

Fail-open: if the CSV is missing/empty, writes an empty table and exits 0.

Usage:
    python tools/fetch_travel.py
    python tools/fetch_travel.py --dry-run
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

try:
    from lib.team_names import normalise_team
except ImportError:  # repo root on sys.path instead of tools/
    from tools.lib.team_names import normalise_team

CSV_PATH = Path("tools/lib/stadiums.csv")
OUTPUT_PATH = Path(".tmp/travel/venues.json")


def build_table() -> dict[str, dict]:
    if not CSV_PATH.exists():
        return {}
    table: dict[str, dict] = {}
    try:
        with CSV_PATH.open(encoding="utf-8") as fh:
            # Skip leading comment lines so DictReader sees the real header.
            lines = [ln for ln in fh if not ln.lstrip().startswith("#")]
        reader = csv.DictReader(lines)
        for r in reader:
            key = normalise_team(r.get("team") or "")
            if not key:
                continue
            try:
                table[key] = {
                    "lat": float(r["lat"]),
                    "lon": float(r["lon"]),
                    "altitude": float(r.get("altitude") or "0"),
                }
            except (KeyError, ValueError, TypeError):
                continue
    except OSError as exc:
        print(f"[travel] WARN: cannot read {CSV_PATH}: {exc}", file=sys.stderr)
        return {}
    return table


def main() -> None:
    parser = argparse.ArgumentParser(description="Build team→venue coordinate table for travel features")
    parser.add_argument("--dry-run", action="store_true", help="print count without writing")
    args = parser.parse_args()

    table = build_table()
    if not table:
        print("[travel] no stadium rows found — writing empty table (fail-open)")

    if args.dry_run:
        print(f"[travel] {len(table)} venues (dry-run, not written)")
        return

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUTPUT_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(table, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(OUTPUT_PATH)
    print(f"[travel] {len(table)} venues -> {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
