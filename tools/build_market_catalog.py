#!/usr/bin/env python3
"""Build the canonical ORACLE market catalog from captured SportyBet snapshots.

ORACLE scrapes the FULL SportyBet market catalogue per fixture into
`odds.allMarkets[]` (see tools/scrape_fixtures.py:_parse_all_markets). A single
liquid fixture carries 900+ raw market entries; across a day's slate there are a
few hundred DISTINCT market types (by SportyBet market `id`). This tool reads one
or more daily snapshots and emits a single, deterministic, type-safe TypeScript
catalog that is the global ORACLE standard of every market the engine may see —
the canonical index the deterministic engine routes off.

Usage:
    python tools/build_market_catalog.py \
        --in .tmp/fixtures/sportybet_today.json \
        --out packages/engine/src/markets/catalog.generated.ts

Pass --in multiple times to union across days (more days = more complete index).
Re-running with the same input is byte-identical (stable numeric-id ordering),
so a no-change re-generation produces a zero-diff. Additions/removals vs the
existing committed catalog are printed so the change is always reviewed.

Stdlib only — same constraint as the rest of tools/.
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path

# ── MarketFamily classification ────────────────────────────────────────────────
# Canonical ORACLE families. Advisory metadata that tells the engine the INTENT
# of a market id; the engine's PRICEABLE_FAMILIES set decides which of these the
# deterministic pricer actually has a model for today. Keep this union in sync
# with MarketFamily in packages/engine/src/markets/index.ts.
FAMILIES = [
    "match_result",  # 1X2 and 1X2 variants (1UP/2UP/Never Down)
    "double_chance",
    "dnb",  # draw no bet / home-no-bet / away-no-bet
    "goals_ou",  # full-match total goals over/under
    "team_total",  # home/away team total over/under
    "btts",  # both teams to score (GG/NG and variants)
    "asian_handicap",
    "handicap",  # 3-way / european handicap (hcp=X:Y)
    "correct_score",
    "exact_goals",  # exact team/match goal count, goal bounds, excluded goals
    "odd_even",
    "clean_sheet",
    "win_to_nil",
    "ht_ft",  # halftime/fulltime
    "highest_scoring_half",
    "half",  # any first/second-half scoped market not in a more specific family
    "multigoals",
    "winning_margin",
    "which_team_scores",
    "combo",  # multi-market combinations (1X2 & O/U, DC & GG/NG, ...)
    "specials",  # corners, bookings, player props, goalscorer, etc.
    "exotic",  # recognised market, no specific family bucket
]


def _classify(name: str, group: str, mid: str) -> str:
    """Map a market to a canonical family by name + group + id heuristics.

    Order matters: most specific patterns first. Purely advisory — a wrong guess
    only mislabels metadata, it never changes pricing math (the engine still
    gates on PRICEABLE_FAMILIES + the half/in-play guards)."""
    n = name.lower()
    g = (group or "").lower()
    is_half = (
        g == "half"
        or "1st half" in n
        or "2nd half" in n
        or "half" in n
        or n.startswith("ht ")
        or "halftime" in n
    )

    # specials first — these never become priceable and shouldn't match the
    # goal-based patterns below by accident (e.g. "corner over/under").
    if any(k in n for k in ("corner", "booking", "card", "player", "scorer", "assist")):
        return "specials"

    # HT/FT and highest-scoring-half are inherently full-match markets even
    # though they reference halves — classify them before the half guard.
    if "halftime" in n and ("fulltime" in n or "/ft" in n or "/full" in n):
        return "ht_ft"
    if "/" in n and "halftime" in n:
        return "ht_ft"
    if "highest scoring half" in n:
        return "highest_scoring_half"

    # Half-scoped markets that would otherwise land in a full-time-priceable
    # family go to `half`: the goal matrix is full-time only, so the engine can't
    # price them and the catalog should say so honestly (priceAllMarketOutcome
    # also early-returns on these). Combos/specials/exotica fall through below.
    if is_half:
        if " & " not in n and not any(
            k in n for k in ("corner", "booking", "card", "player", "scorer", "assist")
        ):
            return "half"

    if "win to nil" in n:
        return "win_to_nil"
    if "clean sheet" in n:
        return "clean_sheet"
    if "odd" in n and "even" in n:
        return "odd_even"
    if "multigoal" in n:
        return "multigoals"
    if "winning margin" in n or ("margin" in n and "win" in n):
        return "winning_margin"
    if "which team" in n:
        return "which_team_scores"
    if "correct score" in n:
        return "correct_score"
    if any(k in n for k in ("goal bounds", "excluded goals", "exact goals")):
        return "exact_goals"

    # combos: a "&" joining two markets, or the Combo group.
    if " & " in n or g == "combo":
        return "combo"

    if "both teams" in n or "gg/ng" in n or "to score in both halves" in n:
        return "btts"
    if "double chance" in n:
        return "double_chance"
    if "no bet" in n:  # Draw No Bet, Home No Bet, Away No Bet
        return "dnb"
    if "handicap" in n or "asian" in n:
        # SportyBet id 16 = Asian (decimal lines), 14/65/66/87/88 = 3-way hcp X:Y.
        return "asian_handicap" if mid in ("16", "88", "66") else "handicap"
    if ("home" in n or "away" in n) and ("o/u" in n or "total" in n or "team" in n):
        return "team_total"
    if "over/under" in n or "o/u" in n or "total" in n:
        return "goals_ou"
    if "1x2" in n or n in ("home", "draw", "away") or "match result" in n:
        return "match_result"

    if is_half:
        return "half"
    return "exotic"


# ── specifier normalisation ────────────────────────────────────────────────────
# Replace the VALUE of each specifier key with a typed placeholder, keep the key,
# so "total=2.5" and "total=3.5" collapse to "total=<num>" but "hcp=0:1" (a 3-way
# handicap) stays distinct from "hcp=-0.5" (an asian line).
_NUM = re.compile(r"^-?\d+(?:\.\d+)?$")
_SCORE = re.compile(r"^-?\d+:\d+$")
_HEX = re.compile(r"^[0-9a-f]{16,}$")


def _norm_specifier(spec: str) -> str:
    parts = []
    for kv in spec.split("|"):
        if "=" not in kv:
            parts.append(kv)
            continue
        k, v = kv.split("=", 1)
        if _SCORE.match(v):
            ph = "<score>"
        elif _NUM.match(v):
            ph = "<num>"
        elif _HEX.match(v):
            ph = "<id>"
        else:
            ph = "<val>"
        parts.append(f"{k}={ph}")
    return "|".join(parts)


# ── catalog build ──────────────────────────────────────────────────────────────
def build_catalog(snapshots: list[dict]) -> list[dict]:
    by_id: dict[str, dict] = {}
    for snap in snapshots:
        for ev in snap.get("events", []) or []:
            odds = ev.get("odds") or {}
            am = odds.get("allMarkets") or []
            seen_in_fixture: set[str] = set()
            for m in am:
                mid = str(m.get("id"))
                rec = by_id.setdefault(
                    mid,
                    {
                        "names": collections.Counter(),
                        "groups": collections.Counter(),
                        "outcomes": {},  # desc -> first-seen order preserved via dict
                        "specs": set(),
                        "fixtures": 0,
                    },
                )
                nm = (m.get("name") or m.get("desc") or "").strip()
                if nm:
                    rec["names"][nm] += 1
                grp = (m.get("group") or "").strip()
                if grp:
                    rec["groups"][grp] += 1
                for o in m.get("outcomes") or []:
                    desc = (o.get("desc") or "").strip()
                    if desc:
                        rec["outcomes"].setdefault(desc, None)
                if m.get("specifier"):
                    rec["specs"].add(_norm_specifier(m["specifier"]))
                if mid not in seen_in_fixture:
                    rec["fixtures"] += 1
                    seen_in_fixture.add(mid)

    catalog = []
    for mid, rec in by_id.items():
        name = rec["names"].most_common(1)[0][0] if rec["names"] else mid
        group = rec["groups"].most_common(1)[0][0] if rec["groups"] else ""
        catalog.append(
            {
                "id": mid,
                "name": name,
                "group": group,
                "family": _classify(name, group, mid),
                "outcomes": list(rec["outcomes"].keys()),
                "specifierShapes": sorted(rec["specs"]),
                "fixturesSeen": rec["fixtures"],
            }
        )

    # deterministic ordering: numeric id ascending (non-numeric ids last, lexically).
    def _key(e: dict):
        try:
            return (0, int(e["id"]), "")
        except ValueError:
            return (1, 0, e["id"])

    catalog.sort(key=_key)
    return catalog


# ── TS emission ────────────────────────────────────────────────────────────────
def _ts_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _ts_arr(items: list[str]) -> str:
    return "[" + ", ".join(_ts_str(i) for i in items) + "]"


def emit_ts(catalog: list[dict]) -> str:
    lines = [
        "// GENERATED FILE — do not hand-edit.",
        "// Regenerate with: python tools/build_market_catalog.py "
        "--in .tmp/fixtures/sportybet_today.json --out "
        "packages/engine/src/markets/catalog.generated.ts",
        "//",
        "// Canonical index of every SportyBet market type ORACLE has observed,"
        " keyed by",
        "// SportyBet market id. The global ORACLE market standard the"
        " deterministic engine",
        "// routes off. `family` is advisory ORACLE classification;"
        " PRICEABLE_FAMILIES in",
        "// ./index.ts decides which families the engine can actually price.",
        "",
        'import type { MarketCatalogEntry } from "./index.js";',
        "",
        "export const MARKET_CATALOG: readonly MarketCatalogEntry[] = [",
    ]
    for e in catalog:
        lines.append(
            "  { "
            f"id: {_ts_str(e['id'])}, "
            f"name: {_ts_str(e['name'])}, "
            f"group: {_ts_str(e['group'])}, "
            f"family: {_ts_str(e['family'])}, "
            f"outcomes: {_ts_arr(e['outcomes'])}, "
            f"specifierShapes: {_ts_arr(e['specifierShapes'])}, "
            f"fixturesSeen: {e['fixturesSeen']} "
            "},"
        )
    lines.append("];")
    lines.append("")
    return "\n".join(lines)


# ── biome formatting (CI parity) ────────────────────────────────────────────────
# The repo's biome ci is stricter than the raw emission (it expands long object
# literals multiline). Run `biome format --write` on the output so the committed
# file matches CI and re-generation stays zero-diff. Biome formatting is itself
# deterministic, so determinism is preserved. No-op (with a warning) when biome
# isn't on PATH — the file is still valid TS, just not pre-formatted.
def _biome_format(path: Path) -> None:
    import shutil
    import subprocess

    repo_root = Path(__file__).resolve().parent.parent
    pnpm = shutil.which("pnpm")
    if not pnpm:
        print("  WARN: pnpm not found — skipping biome format (run "
              "`pnpm exec biome format --write` on the output before committing)")
        return
    try:
        subprocess.run(
            [pnpm, "exec", "biome", "format", "--write", str(path)],
            cwd=repo_root, check=True, capture_output=True, text=True,
        )
    except (subprocess.CalledProcessError, OSError) as e:
        print(f"  WARN: biome format failed ({e}); output is unformatted but valid")


# ── existing-catalog diff (review aid) ──────────────────────────────────────────
def _existing_ids(path: Path) -> set[str]:
    if not path.exists():
        return set()
    text = path.read_text(encoding="utf-8")
    return set(re.findall(r"id:\s*\"([^\"]+)\"", text))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in", dest="inputs", action="append", required=True,
                    help="captured sportybet snapshot JSON (repeatable)")
    ap.add_argument("--out", dest="out", required=True,
                    help="output .ts path (catalog.generated.ts) — read for the diff "
                         "baseline even in --diff-only mode, but not written to")
    ap.add_argument("--diff-only", action="store_true",
                    help="[PR-21] report added/removed ids vs --out without writing it — "
                         "the committed catalog stays hand-reviewed/PR'd, this is read-only")
    ap.add_argument("--json-out", dest="json_out",
                    help="[PR-21] write newly-observed (uncatalogued) entries as a JSON "
                         "array of MarketCatalogEntry-shaped objects, for the runtime "
                         "overlay (packages/engine/src/markets/index.ts's extendCatalog)")
    args = ap.parse_args()

    snapshots = []
    for p in args.inputs:
        path = Path(p)
        if not path.exists():
            print(f"ERROR: input not found: {p}", file=sys.stderr)
            return 2
        snapshots.append(json.loads(path.read_text(encoding="utf-8")))

    catalog = build_catalog(snapshots)
    out_path = Path(args.out)
    prev_ids = _existing_ids(out_path)
    new_ids = {e["id"] for e in catalog}

    if args.diff_only:
        print(f"[diff-only] {len(catalog)} market types observed — {out_path} NOT written")
    else:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(emit_ts(catalog), encoding="utf-8", newline="\n")
        _biome_format(out_path)
        print(f"wrote {len(catalog)} market types -> {out_path}")

    added = sorted(new_ids - prev_ids, key=lambda x: (len(x), x))
    removed = sorted(prev_ids - new_ids, key=lambda x: (len(x), x))
    fam_counts = collections.Counter(e["family"] for e in catalog)

    print(f"  families: {dict(sorted(fam_counts.items()))}")
    if prev_ids:
        print(f"  added vs previous: {len(added)} {added[:20]}")
        print(f"  removed vs previous: {len(removed)} {removed[:20]}")
        if removed:
            print("  NOTE: removed ids are markets absent from this snapshot — "
                  "union more --in days before committing a shrink.")
    else:
        print("  (no previous catalog to diff against)")

    if args.json_out:
        added_set = set(added)
        added_entries = [e for e in catalog if e["id"] in added_set]
        json_path = Path(args.json_out)
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(
            json.dumps(added_entries, indent=2), encoding="utf-8", newline="\n"
        )
        print(f"  wrote {len(added_entries)} newly-observed entries -> {json_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
