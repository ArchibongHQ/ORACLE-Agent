"""Tests for PR-25 item 4: npxG (non-penalty xG) / xAG (expected-assisted-goals)
as distinct signals surfaced alongside the existing xgf/xga pair.

- build_xg_table.py's _load_fbref_xg(): reads npxg/xag columns from
  fetch_fbref.py's team_season_stats.csv (already-computed, no new scraping)
  and derives per-match npxgf/xagf rates the same way xgf is derived.
- scrape_fixtures.py's _xg_for(): passes npxgf/xagf through into the sidecar's
  xg block only when present, never defaulting to 0/null.
"""
import csv

try:
    import build_xg_table as bxt
except ImportError:  # repo root on sys.path instead of tools/
    from tools import build_xg_table as bxt

try:
    import scrape_fixtures as sf
except ImportError:  # repo root on sys.path instead of tools/
    from tools import scrape_fixtures as sf


FBREF_FIELDS = [
    "squad", "comp", "fdco_league", "season", "goals", "assists", "shots",
    "shots_on_target", "yellow_cards", "red_cards", "minutes", "player_count",
    "goals_per90", "shots_per90", "sot_per90", "xg", "npxg", "xag",
    "xg_per90", "xag_per90",
]


def _write_fbref_csv(path, rows):
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FBREF_FIELDS)
        writer.writeheader()
        for r in rows:
            writer.writerow({k: r.get(k, "") for k in FBREF_FIELDS})


# ── build_xg_table._load_fbref_xg ────────────────────────────────────────────

def test_load_fbref_xg_includes_npxgf_and_xagf_when_present(tmp_path, monkeypatch):
    csv_path = tmp_path / "team_season_stats.csv"
    _write_fbref_csv(csv_path, [{
        "squad": "Arsenal", "comp": "eng Premier League", "fdco_league": "E0",
        "season": "2425", "minutes": "3420", "xg": "60.0", "npxg": "54.0", "xag": "45.0",
    }])
    monkeypatch.setattr(bxt, "FBREF_CSV", csv_path)

    table = bxt._load_fbref_xg()
    key = bxt.normalise("Arsenal")
    assert key in table
    rec = table[key]
    matches = 3420 / 990.0
    assert rec["xgf"] == round(60.0 / matches, 4)
    assert rec["npxgf"] == round(54.0 / matches, 4)
    assert rec["xagf"] == round(45.0 / matches, 4)


def test_load_fbref_xg_omits_npxgf_xagf_when_absent(tmp_path, monkeypatch):
    csv_path = tmp_path / "team_season_stats.csv"
    _write_fbref_csv(csv_path, [{
        "squad": "Arsenal", "comp": "eng Premier League", "fdco_league": "E0",
        "season": "2425", "minutes": "3420", "xg": "60.0", "npxg": "", "xag": "",
    }])
    monkeypatch.setattr(bxt, "FBREF_CSV", csv_path)

    rec = bxt._load_fbref_xg()[bxt.normalise("Arsenal")]
    assert "npxgf" not in rec
    assert "xagf" not in rec


def test_load_fbref_xg_no_xg_coverage_row_has_no_advanced_fields_either(tmp_path, monkeypatch):
    csv_path = tmp_path / "team_season_stats.csv"
    _write_fbref_csv(csv_path, [{
        "squad": "Some Lower League Team", "comp": "eng League Two", "fdco_league": "",
        "season": "2425", "minutes": "3420", "xg": "", "npxg": "", "xag": "",
    }])
    monkeypatch.setattr(bxt, "FBREF_CSV", csv_path)

    # No xG coverage at all → row skipped entirely, team absent from table.
    assert bxt.normalise("Some Lower League Team") not in bxt._load_fbref_xg()


# ── scrape_fixtures._xg_for ──────────────────────────────────────────────────

def test_xg_for_passes_through_npxgf_and_xagf(monkeypatch):
    table = {
        sf.normalise("Arsenal"): {
            "xgf": 1.8, "xga": None, "src": "fbref", "npxgf": 1.6, "xagf": 1.2,
        }
    }
    out = sf._xg_for(table, "Arsenal")
    assert out["npxgf"] == 1.6
    assert out["xagf"] == 1.2


def test_xg_for_omits_npxgf_xagf_when_absent_from_record(monkeypatch):
    table = {sf.normalise("Arsenal"): {"xgf": 1.8, "xga": 1.1, "src": "understat"}}
    out = sf._xg_for(table, "Arsenal")
    assert "npxgf" not in out
    assert "xagf" not in out
