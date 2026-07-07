"""Tests for the PR-21 --diff-only / --json-out flags on
build_market_catalog.py. biome formatting is monkeypatched out (no real
subprocess/pnpm dependency in tests) — only the flag-gating and JSON-emission
logic is under test, not TS formatting.
"""
import json

try:
    import build_market_catalog as bmc
except ImportError:  # repo root on sys.path instead of tools/
    from tools import build_market_catalog as bmc


def _write_snapshot(path, entries):
    path.write_text(
        json.dumps(
            {
                "events": [
                    {
                        "odds": {
                            "allMarkets": [
                                {
                                    "id": eid,
                                    "name": name,
                                    "group": "Main",
                                    "outcomes": [{"desc": "Over 2.5", "odds": "1.9"}],
                                }
                                for eid, name in entries
                            ]
                        }
                    }
                ]
            }
        ),
        encoding="utf-8",
    )


def _run_main(monkeypatch, argv):
    monkeypatch.setattr(bmc, "_biome_format", lambda path: None)
    monkeypatch.setattr(bmc.sys, "argv", ["build_market_catalog.py", *argv])
    return bmc.main()


def test_diff_only_does_not_write_out_path(tmp_path, monkeypatch, capsys):
    snap = tmp_path / "snap.json"
    _write_snapshot(snap, [("18", "Over/Under")])
    out_path = tmp_path / "catalog.generated.ts"

    rc = _run_main(monkeypatch, ["--in", str(snap), "--out", str(out_path), "--diff-only"])

    assert rc == 0
    assert not out_path.exists()
    out = capsys.readouterr().out
    assert "[diff-only]" in out
    assert "NOT written" in out


def test_without_diff_only_writes_ts_as_before(tmp_path, monkeypatch):
    snap = tmp_path / "snap.json"
    _write_snapshot(snap, [("18", "Over/Under")])
    out_path = tmp_path / "catalog.generated.ts"

    rc = _run_main(monkeypatch, ["--in", str(snap), "--out", str(out_path)])

    assert rc == 0
    assert out_path.exists()
    assert "MARKET_CATALOG" in out_path.read_text(encoding="utf-8")


def test_json_out_writes_only_newly_observed_entries(tmp_path, monkeypatch):
    out_path = tmp_path / "catalog.generated.ts"
    # Pre-seed the committed catalog with id "18" already present.
    out_path.write_text(
        'export const MARKET_CATALOG: readonly MarketCatalogEntry[] = [\n'
        '  { id: "18", name: "Over/Under", group: "Main", family: "goals_ou", '
        'outcomes: [], specifierShapes: [], fixturesSeen: 1 },\n'
        "];\n",
        encoding="utf-8",
    )
    snap = tmp_path / "snap.json"
    # New snapshot re-observes id 18 (already catalogued) AND a brand-new id 999.
    _write_snapshot(snap, [("18", "Over/Under"), ("999", "Some New Market")])
    json_out = tmp_path / "overlay.json"

    rc = _run_main(
        monkeypatch,
        ["--in", str(snap), "--out", str(out_path), "--diff-only", "--json-out", str(json_out)],
    )

    assert rc == 0
    written = json.loads(json_out.read_text(encoding="utf-8"))
    assert [e["id"] for e in written] == ["999"]
    assert written[0]["name"] == "Some New Market"


def test_json_out_omitted_when_flag_absent(tmp_path, monkeypatch):
    snap = tmp_path / "snap.json"
    _write_snapshot(snap, [("18", "Over/Under")])
    out_path = tmp_path / "catalog.generated.ts"

    _run_main(monkeypatch, ["--in", str(snap), "--out", str(out_path)])

    assert not (tmp_path / "overlay.json").exists()


def test_json_out_empty_array_when_nothing_new(tmp_path, monkeypatch):
    out_path = tmp_path / "catalog.generated.ts"
    out_path.write_text(
        'export const MARKET_CATALOG: readonly MarketCatalogEntry[] = [\n'
        '  { id: "18", name: "Over/Under", group: "Main", family: "goals_ou", '
        'outcomes: [], specifierShapes: [], fixturesSeen: 1 },\n'
        "];\n",
        encoding="utf-8",
    )
    snap = tmp_path / "snap.json"
    _write_snapshot(snap, [("18", "Over/Under")])  # nothing new vs the committed catalog
    json_out = tmp_path / "overlay.json"

    rc = _run_main(
        monkeypatch,
        ["--in", str(snap), "--out", str(out_path), "--diff-only", "--json-out", str(json_out)],
    )

    assert rc == 0
    assert json.loads(json_out.read_text(encoding="utf-8")) == []
