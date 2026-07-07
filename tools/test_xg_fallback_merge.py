"""Tests for the PR-19 Google-AI-Mode xG fallback tier: the residual-team
computation + gating in acquire_daily.py, and the fill-only-if-absent merge
into build_xg_table.py's team_xg_table.json. No real Playwright/subprocess
calls — subprocess.run is monkeypatched throughout, and the merge tests call
build_xg_table.main() directly against a monkeypatched build_table() so no
real Understat/FotMob network I/O happens either.
"""
import json

try:
    import acquire_daily as ad
except ImportError:  # repo root on sys.path instead of tools/
    from tools import acquire_daily as ad

try:
    import build_xg_table as bxt
except ImportError:  # repo root on sys.path instead of tools/
    from tools import build_xg_table as bxt


# ── _fotmob_xg_has_teams ─────────────────────────────────────────────────────

def test_fotmob_xg_has_teams_true_when_populated(tmp_path):
    (tmp_path / ".tmp" / "xg").mkdir(parents=True)
    (tmp_path / ".tmp" / "xg" / "fotmob_xg.json").write_text(
        json.dumps({"arsenal": {"xgf": 1.8}}), encoding="utf-8"
    )
    assert ad._fotmob_xg_has_teams(tmp_path / "tools") is True


def test_fotmob_xg_has_teams_false_when_empty_object(tmp_path):
    (tmp_path / ".tmp" / "xg").mkdir(parents=True)
    (tmp_path / ".tmp" / "xg" / "fotmob_xg.json").write_text("{}", encoding="utf-8")
    assert ad._fotmob_xg_has_teams(tmp_path / "tools") is False


def test_fotmob_xg_has_teams_false_when_missing(tmp_path):
    assert ad._fotmob_xg_has_teams(tmp_path / "tools") is False


def test_fotmob_xg_has_teams_false_when_corrupt(tmp_path):
    (tmp_path / ".tmp" / "xg").mkdir(parents=True)
    (tmp_path / ".tmp" / "xg" / "fotmob_xg.json").write_text("{not json", encoding="utf-8")
    assert ad._fotmob_xg_has_teams(tmp_path / "tools") is False


# ── _residual_teams_for_fallback ─────────────────────────────────────────────

def _write_table(tmp_path, covered: dict) -> None:
    (tmp_path / ".tmp" / "xg").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".tmp" / "xg" / "team_xg_table.json").write_text(
        json.dumps(covered), encoding="utf-8"
    )


def test_residual_excludes_already_covered_teams(tmp_path):
    _write_table(tmp_path, {"arsenal": {"xgf": 1.8}})
    residual = ad._residual_teams_for_fallback(["Arsenal", "Some Obscure FC"], tmp_path / "tools")
    assert residual == ["Some Obscure FC"]


def test_residual_excludes_srl_and_virtual_teams(tmp_path):
    _write_table(tmp_path, {})
    residual = ad._residual_teams_for_fallback(
        ["Simulated Reality League Turin", "FC eSoccer United", "Virtual Kickers", "Real FC"],
        tmp_path / "tools",
    )
    assert residual == ["Real FC"]


def test_residual_keeps_genuinely_uncovered_non_srl_teams(tmp_path):
    _write_table(tmp_path, {})
    residual = ad._residual_teams_for_fallback(["Team A", "Team B"], tmp_path / "tools")
    assert residual == ["Team A", "Team B"]


def test_residual_degrades_to_all_teams_when_table_missing(tmp_path):
    residual = ad._residual_teams_for_fallback(["Team A"], tmp_path / "tools")
    assert residual == ["Team A"]


# ── _maybe_fetch_xg_fallback gating + capping (subprocess.run monkeypatched) ─

def test_flag_off_skips_fallback_entirely(tmp_path, monkeypatch):
    monkeypatch.setenv("ORACLE_FETCH_XG_FALLBACK", "off")
    calls = []
    monkeypatch.setattr(ad.subprocess, "run", lambda *a, **k: calls.append(a))
    ad._maybe_fetch_xg_fallback(["Team A"], tmp_path / "tools", quiet=True)
    assert calls == []


def test_no_residual_teams_skips_subprocess(tmp_path, monkeypatch):
    monkeypatch.delenv("ORACLE_FETCH_XG_FALLBACK", raising=False)
    _write_table(tmp_path, {"team a": {"xgf": 1.0}})
    calls = []
    monkeypatch.setattr(ad.subprocess, "run", lambda *a, **k: calls.append(a))
    ad._maybe_fetch_xg_fallback(["Team A"], tmp_path / "tools", quiet=True)
    assert calls == []


class _FakeCompleted:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_residual_list_is_capped_by_max_teams_env(tmp_path, monkeypatch):
    monkeypatch.delenv("ORACLE_FETCH_XG_FALLBACK", raising=False)
    monkeypatch.setenv("ORACLE_XG_FALLBACK_MAX_TEAMS", "2")
    _write_table(tmp_path, {})
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return _FakeCompleted()

    monkeypatch.setattr(ad.subprocess, "run", fake_run)
    teams = [f"Team {i}" for i in range(5)]
    ad._maybe_fetch_xg_fallback(teams, tmp_path / "tools", quiet=True)

    # First call is fetch_xg_fallback.py against the written teams file —
    # assert the file it wrote contains at most 2 teams.
    fallback_call = next(c for c in calls if "fetch_xg_fallback.py" in c[1])
    teams_file = tmp_path / ".tmp" / "xg" / "teams_fallback_today.txt"
    written = teams_file.read_text(encoding="utf-8").splitlines()
    assert len(written) == 2
    assert fallback_call[0] == ad.sys.executable


def test_invalid_max_teams_env_falls_back_to_default(tmp_path, monkeypatch):
    monkeypatch.delenv("ORACLE_FETCH_XG_FALLBACK", raising=False)
    monkeypatch.setenv("ORACLE_XG_FALLBACK_MAX_TEAMS", "not-a-number")
    _write_table(tmp_path, {})
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return _FakeCompleted()

    monkeypatch.setattr(ad.subprocess, "run", fake_run)
    teams = [f"Team {i}" for i in range(30)]
    ad._maybe_fetch_xg_fallback(teams, tmp_path / "tools", quiet=True)

    teams_file = tmp_path / ".tmp" / "xg" / "teams_fallback_today.txt"
    written = teams_file.read_text(encoding="utf-8").splitlines()
    assert len(written) == 25  # falls back to the documented default, not a crash


def test_successful_fallback_reruns_build_xg_table(tmp_path, monkeypatch):
    monkeypatch.delenv("ORACLE_FETCH_XG_FALLBACK", raising=False)
    _write_table(tmp_path, {})
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return _FakeCompleted()

    monkeypatch.setattr(ad.subprocess, "run", fake_run)
    ad._maybe_fetch_xg_fallback(["Team A"], tmp_path / "tools", quiet=True)

    scripts_called = [c[1] for c in calls if len(c) > 1]
    assert any("fetch_xg_fallback.py" in s for s in scripts_called)
    assert any("build_xg_table.py" in s for s in scripts_called)


# ── build_xg_table.py: ai_mode merge tier (fill-only-if-absent, last) ───────

def test_ai_mode_tier_merges_last_and_never_overwrites(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(bxt.sys, "argv", ["build_xg_table.py"])
    xg_dir = tmp_path / ".tmp" / "xg"
    xg_dir.mkdir(parents=True)
    monkeypatch.setattr(bxt, "XG_DIR", xg_dir)
    monkeypatch.setattr(bxt, "OUTPUT_PATH", xg_dir / "team_xg_table.json")
    monkeypatch.setattr(bxt, "FBREF_CSV", tmp_path / "no_fbref.csv")
    # Understat "wins" the collision on "shared fc" — ai_mode must not overwrite it.
    monkeypatch.setattr(bxt, "build_table", lambda window: {"shared fc": {"xgf": 2.0, "src": "understat"}})
    (xg_dir / "fotmob_xg.json").write_text("{}", encoding="utf-8")
    (xg_dir / "sofascore_xg.json").write_text("{}", encoding="utf-8")
    (xg_dir / "ai_mode_xg.json").write_text(
        json.dumps({
            "shared fc": {"xgf": 0.5, "src": "google_ai"},  # must be shadowed
            "ai only fc": {"xgf": 1.1, "src": "google_ai"},  # must be added
        }),
        encoding="utf-8",
    )

    bxt.main()

    written = json.loads((xg_dir / "team_xg_table.json").read_text(encoding="utf-8"))
    assert written["shared fc"]["src"] == "understat"
    assert written["shared fc"]["xgf"] == 2.0
    assert written["ai only fc"]["src"] == "google_ai"
    out = capsys.readouterr().out
    assert "ai-mode-added=1" in out


def test_zero_yield_tiers_are_printed_not_silent(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(bxt.sys, "argv", ["build_xg_table.py"])
    xg_dir = tmp_path / ".tmp" / "xg"
    xg_dir.mkdir(parents=True)
    monkeypatch.setattr(bxt, "XG_DIR", xg_dir)
    monkeypatch.setattr(bxt, "OUTPUT_PATH", xg_dir / "team_xg_table.json")
    monkeypatch.setattr(bxt, "FBREF_CSV", tmp_path / "no_fbref.csv")
    monkeypatch.setattr(bxt, "build_table", lambda window: {"only fc": {"xgf": 1.0, "src": "understat"}})
    (xg_dir / "fotmob_xg.json").write_text("{}", encoding="utf-8")
    (xg_dir / "sofascore_xg.json").write_text("{}", encoding="utf-8")
    (xg_dir / "ai_mode_xg.json").write_text("{}", encoding="utf-8")

    bxt.main()

    out = capsys.readouterr().out
    assert "fotmob-added=0" in out
    assert "sofascore-added=0" in out
    assert "ai-mode-added=0" in out
