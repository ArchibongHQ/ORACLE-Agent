"""Tests for the PR-25 live match-day weather tier: fetch_weather.py's
fetch_forecast()/city_for_team() (Open-Meteo Forecast API, disk-cached), and
scrape_fixtures.py's _load_weather_table()/_weather_for() that build today's
per-fixture weather block from them. No real network I/O — urllib.request.
urlopen is monkeypatched throughout; fetch_weather's own city_for_team/
fetch_forecast are monkeypatched (via the real module object, since
_load_weather_table does a lazy `import fetch_weather as fw`) rather than
re-hitting Open-Meteo.
"""
import json

try:
    import fetch_weather as fw
except ImportError:  # repo root on sys.path instead of tools/
    from tools import fetch_weather as fw

try:
    import scrape_fixtures as sf
except ImportError:  # repo root on sys.path instead of tools/
    from tools import scrape_fixtures as sf


# ── fetch_forecast ───────────────────────────────────────────────────────────

class _FakeResponse:
    def __init__(self, payload: dict):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_fetch_forecast_cache_hit_skips_network(tmp_path, monkeypatch):
    monkeypatch.setattr(fw, "CACHE_DIR", tmp_path)
    cache_path = tmp_path / "fc_51.51_-0.11_2026-07-10.json"
    cache_path.write_text(json.dumps({"temp_c": 18.0, "precip_mm": 0.0, "wind_kph": 10.0}), encoding="utf-8")

    def _boom(*a, **k):
        raise AssertionError("urlopen should not be called on a cache hit")

    monkeypatch.setattr(fw.urllib.request, "urlopen", _boom)
    result = fw.fetch_forecast(51.51, -0.11, "2026-07-10", throttle=0)
    assert result == {"temp_c": 18.0, "precip_mm": 0.0, "wind_kph": 10.0}


def test_fetch_forecast_negative_cache_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(fw, "CACHE_DIR", tmp_path)
    cache_path = tmp_path / "fc_51.51_-0.11_2026-07-10.json"
    cache_path.write_text(json.dumps({"_miss": True}), encoding="utf-8")

    def _boom(*a, **k):
        raise AssertionError("urlopen should not be called on a negative-cache hit")

    monkeypatch.setattr(fw.urllib.request, "urlopen", _boom)
    assert fw.fetch_forecast(51.51, -0.11, "2026-07-10", throttle=0) is None


def test_fetch_forecast_parses_successful_response(tmp_path, monkeypatch):
    monkeypatch.setattr(fw, "CACHE_DIR", tmp_path)
    payload = {
        "daily": {
            "temperature_2m_mean": [12.3],
            "precipitation_sum": [6.7],
            "wind_speed_10m_max": [55.2],
        }
    }
    monkeypatch.setattr(fw.urllib.request, "urlopen", lambda *a, **k: _FakeResponse(payload))
    result = fw.fetch_forecast(51.51, -0.11, "2026-07-10", throttle=0)
    assert result == {"temp_c": 12.3, "precip_mm": 6.7, "wind_kph": 55.2}
    cached = json.loads((tmp_path / "fc_51.51_-0.11_2026-07-10.json").read_text(encoding="utf-8"))
    assert cached == result


def test_fetch_forecast_missing_precip_wind_default_to_zero(tmp_path, monkeypatch):
    monkeypatch.setattr(fw, "CACHE_DIR", tmp_path)
    payload = {"daily": {"temperature_2m_mean": [9.0], "precipitation_sum": [None], "wind_speed_10m_max": []}}
    monkeypatch.setattr(fw.urllib.request, "urlopen", lambda *a, **k: _FakeResponse(payload))
    result = fw.fetch_forecast(51.51, -0.11, "2026-07-10", throttle=0)
    assert result == {"temp_c": 9.0, "precip_mm": 0.0, "wind_kph": 0.0}


def test_fetch_forecast_no_data_writes_negative_cache_and_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(fw, "CACHE_DIR", tmp_path)
    payload = {"daily": {"temperature_2m_mean": [], "precipitation_sum": [], "wind_speed_10m_max": []}}
    monkeypatch.setattr(fw.urllib.request, "urlopen", lambda *a, **k: _FakeResponse(payload))
    assert fw.fetch_forecast(51.51, -0.11, "2026-07-10", throttle=0) is None
    cached = json.loads((tmp_path / "fc_51.51_-0.11_2026-07-10.json").read_text(encoding="utf-8"))
    assert cached == {"_miss": True}


def test_fetch_forecast_network_error_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(fw, "CACHE_DIR", tmp_path)

    def _raise(*a, **k):
        raise fw.urllib.error.URLError("boom")

    monkeypatch.setattr(fw.urllib.request, "urlopen", _raise)
    assert fw.fetch_forecast(51.51, -0.11, "2026-07-10", throttle=0) is None


def test_fetch_forecast_rejects_malformed_date_without_touching_network_or_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(fw, "CACHE_DIR", tmp_path)

    def _boom(*a, **k):
        raise AssertionError("urlopen should not be called for a malformed date")

    monkeypatch.setattr(fw.urllib.request, "urlopen", _boom)
    for bad_date in ["10/07/2026", "2026-07-10\n", "../../etc/passwd", "2026-07-10/../x", ""]:
        assert fw.fetch_forecast(51.51, -0.11, bad_date, throttle=0) is None
    assert list(tmp_path.iterdir()) == []


# ── city_for_team ─────────────────────────────────────────────────────────────

def test_city_for_team_known():
    assert fw.city_for_team("arsenal") == (51.51, -0.11)


def test_city_for_team_unknown():
    assert fw.city_for_team("some club nobody scrapes") is None


# ── scrape_fixtures._load_weather_table / _weather_for ───────────────────────

def test_load_weather_table_flag_off_returns_empty_without_touching_fetch_weather(monkeypatch):
    monkeypatch.delenv("ORACLE_FETCH_WEATHER", raising=False)

    def _boom(*a, **k):
        raise AssertionError("fetch_weather must not be touched when the flag is off")

    monkeypatch.setattr(fw, "city_for_team", _boom)
    monkeypatch.setattr(fw, "fetch_forecast", _boom)
    events = [{"home": "Arsenal", "kickoff_utc": "2026-07-10T14:00:00Z"}]
    assert sf._load_weather_table(events) == {}


def test_load_weather_table_flag_on_builds_entry(monkeypatch):
    monkeypatch.setenv("ORACLE_FETCH_WEATHER", "on")
    monkeypatch.setattr(fw, "city_for_team", lambda name: (51.51, -0.11))
    monkeypatch.setattr(fw, "fetch_forecast", lambda lat, lon, date_iso, **k: {
        "temp_c": 14.567, "precip_mm": 1.234, "wind_kph": 20.05,
    })
    events = [{"home": "Arsenal", "kickoff_utc": "2026-07-10T14:00:00Z"}]
    table = sf._load_weather_table(events)
    assert table == {
        (sf.normalise("Arsenal"), "2026-07-10"): {
            "tempC": 14.6, "precipMm": 1.23, "windKph": 20.1, "isAdverse": False,
        }
    }


def test_load_weather_table_dedupes_same_city_and_date(monkeypatch):
    monkeypatch.setenv("ORACLE_FETCH_WEATHER", "on")
    monkeypatch.setattr(fw, "city_for_team", lambda name: (51.51, -0.11))
    calls = []

    def _fetch(lat, lon, date_iso, **k):
        calls.append((lat, lon, date_iso))
        return {"temp_c": 10.0, "precip_mm": 0.0, "wind_kph": 5.0}

    monkeypatch.setattr(fw, "fetch_forecast", _fetch)
    events = [
        {"home": "Arsenal", "kickoff_utc": "2026-07-10T14:00:00Z"},
        {"home": "Arsenal", "kickoff_utc": "2026-07-10T19:00:00Z"},
    ]
    sf._load_weather_table(events)
    assert len(calls) == 1


def test_load_weather_table_gives_every_team_sharing_a_city_a_table_entry(monkeypatch):
    # BUG FIX regression: two different home teams resolving to the same
    # (lat, lon) — e.g. Inter/Milan both play at San Siro — must BOTH get a
    # table entry from the one shared fetch, not just whichever is
    # processed first. The old "seen" dedup set skipped the table write
    # entirely on a cache hit, silently dropping the second team's weather.
    monkeypatch.setenv("ORACLE_FETCH_WEATHER", "on")
    monkeypatch.setattr(fw, "city_for_team", lambda name: (45.48, 9.12))
    calls = []

    def _fetch(lat, lon, date_iso, **k):
        calls.append((lat, lon, date_iso))
        return {"temp_c": 20.0, "precip_mm": 0.0, "wind_kph": 10.0}

    monkeypatch.setattr(fw, "fetch_forecast", _fetch)
    events = [
        {"home": "Inter", "kickoff_utc": "2026-07-10T14:00:00Z"},
        {"home": "Milan", "kickoff_utc": "2026-07-10T19:00:00Z"},
    ]
    table = sf._load_weather_table(events)
    assert len(calls) == 1
    assert (sf.normalise("Inter"), "2026-07-10") in table
    assert (sf.normalise("Milan"), "2026-07-10") in table
    assert table[(sf.normalise("Inter"), "2026-07-10")] == table[(sf.normalise("Milan"), "2026-07-10")]


def test_load_weather_table_one_bad_event_does_not_blank_the_rest(monkeypatch):
    # Robustness regression: this loop runs before the ThreadPoolExecutor
    # that isolates per-fixture failures elsewhere in this file, so an
    # unhandled exception here would previously abort weather for the
    # ENTIRE slate, not just the one bad event.
    monkeypatch.setenv("ORACLE_FETCH_WEATHER", "on")
    monkeypatch.setattr(fw, "city_for_team", lambda name: (51.51, -0.11) if name != sf.normalise("Bad FC") else (1.0, 1.0))

    def _fetch(lat, lon, date_iso, **k):
        if lat == 1.0:
            raise RuntimeError("simulated Open-Meteo failure")
        return {"temp_c": 15.0, "precip_mm": 0.0, "wind_kph": 5.0}

    monkeypatch.setattr(fw, "fetch_forecast", _fetch)
    events = [
        {"home": "Bad FC", "kickoff_utc": "2026-07-10T14:00:00Z"},
        {"home": "Arsenal", "kickoff_utc": "2026-07-10T19:00:00Z"},
    ]
    table = sf._load_weather_table(events)
    assert (sf.normalise("Bad FC"), "2026-07-10") not in table
    assert (sf.normalise("Arsenal"), "2026-07-10") in table


def test_load_weather_table_marks_adverse_on_wind_or_precip(monkeypatch):
    monkeypatch.setenv("ORACLE_FETCH_WEATHER", "on")
    monkeypatch.setattr(fw, "city_for_team", lambda name: (51.51, -0.11))
    monkeypatch.setattr(fw, "fetch_forecast", lambda lat, lon, date_iso, **k: {
        "temp_c": 5.0, "precip_mm": 0.0, "wind_kph": 51.0,
    })
    events = [{"home": "Arsenal", "kickoff_utc": "2026-07-10T14:00:00Z"}]
    table = sf._load_weather_table(events)
    assert table[(sf.normalise("Arsenal"), "2026-07-10")]["isAdverse"] is True


def test_load_weather_table_skips_team_outside_coverage(monkeypatch):
    monkeypatch.setenv("ORACLE_FETCH_WEATHER", "on")
    monkeypatch.setattr(fw, "city_for_team", lambda name: None)

    def _boom(*a, **k):
        raise AssertionError("fetch_forecast must not run when city_for_team misses")

    monkeypatch.setattr(fw, "fetch_forecast", _boom)
    events = [{"home": "Some Obscure FC", "kickoff_utc": "2026-07-10T14:00:00Z"}]
    assert sf._load_weather_table(events) == {}


def test_load_weather_table_skips_events_missing_home_or_kickoff(monkeypatch):
    monkeypatch.setenv("ORACLE_FETCH_WEATHER", "on")

    def _boom(*a, **k):
        raise AssertionError("should never reach fetch_weather for an incomplete event")

    monkeypatch.setattr(fw, "city_for_team", _boom)
    monkeypatch.setattr(fw, "fetch_forecast", _boom)
    events = [{"home": "", "kickoff_utc": "2026-07-10T14:00:00Z"}, {"home": "Arsenal", "kickoff_utc": ""}]
    assert sf._load_weather_table(events) == {}


def test_weather_for_hits_and_misses():
    table = {("arsenal", "2026-07-10"): {"tempC": 14.6, "precipMm": 1.2, "windKph": 20.1, "isAdverse": False}}
    assert sf._weather_for(table, "Arsenal", "2026-07-10T14:00:00Z") == table[("arsenal", "2026-07-10")]
    assert sf._weather_for(table, "Arsenal", "2026-07-11T14:00:00Z") is None
    assert sf._weather_for(table, "Chelsea", "2026-07-10T14:00:00Z") is None
    assert sf._weather_for(table, "Arsenal", "") is None
