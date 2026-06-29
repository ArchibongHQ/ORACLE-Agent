"""Tests for swarm_dispatch.browser_workload_health_gate — the pre-run machine
health check that protects the local Windows box from a GPU-driver crash when a
Playwright browser swarm would launch on a low-memory machine."""
import sys

try:
    import swarm_dispatch as s
except ImportError:  # repo root on sys.path instead of tools/
    from tools import swarm_dispatch as s


def test_gate_passes_on_vps(monkeypatch):
    # ORACLE_IS_VPS=true → _is_local_windows() is False → gate always allows.
    monkeypatch.setenv("ORACLE_IS_VPS", "true")
    ok, reason = s.browser_workload_health_gate()
    assert ok is True
    assert "VPS" in reason or "non-Windows" in reason or "unrestricted" in reason


def test_gate_passes_on_non_windows(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    ok, _ = s.browser_workload_health_gate()
    assert ok is True


def test_gate_blocks_local_windows_when_memory_low(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("ORACLE_IS_VPS", raising=False)
    monkeypatch.setattr(s, "_available_memory_mb", lambda: 800.0)
    ok, reason = s.browser_workload_health_gate()
    assert ok is False
    assert "low free memory" in reason


def test_gate_allows_local_windows_when_memory_healthy(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("ORACLE_IS_VPS", raising=False)
    monkeypatch.setattr(s, "_available_memory_mb", lambda: 8000.0)
    ok, reason = s.browser_workload_health_gate()
    assert ok is True
    assert "healthy" in reason


def test_gate_fails_open_when_memory_unmeasurable(monkeypatch):
    # Can't measure → allow (the browser-swarm cap of 4 is still in force).
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("ORACLE_IS_VPS", raising=False)
    monkeypatch.setattr(s, "_available_memory_mb", lambda: None)
    ok, reason = s.browser_workload_health_gate()
    assert ok is True
    assert "unmeasurable" in reason
