"""xg_extract.py — best-effort xG key-walker shared by fetch_fotmob_xg.py and
fetch_sofascore.py's xG extension.

Neither FotMob's nor Sofascore's captured browser-JSON (fetch_fotmob.py /
fetch_sofascore.py — plain response interception, whatever the live page's own
XHRs happen to return) has a verified, stable schema in this codebase: no live
browser session was available to inspect the real payload shape while writing
this. Rather than hardcode a specific key-path that might be wrong (and
therefore silently return a WRONG number under a plausible-looking key — the
CLAUDE.md "never invent, guess" failure mode), this walks the entire captured
JSON tree for keys that PUBLICLY-KNOWN FotMob/Sofascore UI conventions use for
expected-goals figures ("xg", "xG", "expectedGoals", "expected_goals",
"xgFor"/"xgAgainst" and the "For"/"Against" variants), and returns every
numeric hit it finds tagged with its full key-path — so a human can verify
which path is the real team-season aggregate before trusting it in production
(same spirit as the sportybet-stats-probe skill: discover, log provenance,
verify live, THEN wire it in unconditionally).

Fail-open throughout: an unmatched/malformed payload returns an empty list,
never raises, never fabricates a number.
"""
from __future__ import annotations

import re
from typing import Any

# Matches "xg", "xG", "expectedGoals", "expected_goals", "xgFor", "xGAgainst",
# "avgXG", etc. — deliberately permissive; callers inspect `path` before trusting a hit.
_XG_KEY_RE = re.compile(r"(^|_)(x_?g|expected_?goals)(_?(for|against|f|a))?($|_)", re.IGNORECASE)


def find_xg_candidates(obj: Any, path: str = "$") -> list[tuple[str, float]]:
    """Recursively walk `obj` (a parsed JSON tree) for numeric leaves whose key
    looks like an xG figure. Returns [(key_path, value), ...] — every hit, not
    just the first, since the same payload may carry team/player/match-level
    xG under different keys. Depth-bounded implicitly by JSON's own nesting
    (typical API payloads are <20 levels deep; no explicit cap needed here
    since malformed/cyclic JSON can't come out of json.loads)."""
    hits: list[tuple[str, float]] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            child_path = f"{path}.{k}"
            if isinstance(v, (int, float)) and not isinstance(v, bool) and _XG_KEY_RE.search(str(k)):
                hits.append((child_path, float(v)))
            elif isinstance(v, (dict, list)):
                hits.extend(find_xg_candidates(v, child_path))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            hits.extend(find_xg_candidates(v, f"{path}[{i}]"))
    return hits


def best_team_xg(captured: dict[str, Any]) -> "dict[str, float] | None":
    """From a fetch_fotmob_batch/fetch_sofascore_batch team payload (URL → parsed
    JSON), return a single best-guess {"xgf": float, "xga": float|None} —
    picks the FIRST "for"-tagged hit as xgf and the first "against"-tagged hit
    (if any) as xga; returns None when no xG-shaped key was found anywhere in
    the captured payload. This is intentionally the crudest possible reduction
    of find_xg_candidates()'s full hit list — good enough for a same-confidence
    fallback tier behind Understat, not a claim of precision. Verify against
    a live capture (--out a JSON file, eyeball the matched key_path) before
    trusting this at scale; see the module docstring."""
    all_hits: list[tuple[str, float]] = []
    for payload in captured.values():
        all_hits.extend(find_xg_candidates(payload))
    if not all_hits:
        return None
    for_hits = [v for k, v in all_hits if re.search(r"for|_f$", k, re.IGNORECASE) or "against" not in k.lower()]
    against_hits = [v for k, v in all_hits if re.search(r"against|_a$", k, re.IGNORECASE)]
    xgf = for_hits[0] if for_hits else all_hits[0][1]
    xga = against_hits[0] if against_hits else None
    if not (0 <= xgf <= 10):  # sanity bound — a per-match/season xG figure is never outside this
        return None
    return {"xgf": xgf, "xga": xga if xga is not None and 0 <= xga <= 10 else None}
