/** [PR-18] toEngineWeather — converts scrape_fixtures.py's weather block
 *  (camelCase, km/h/mm) into @oracle/engine's Weather shape (wind_mph/rain_mm). */
import { describe, expect, it } from "vitest";
import { toEngineWeather } from "../src/fixtures.js";

describe("toEngineWeather", () => {
  it("converts windKph to wind_mph and passes precipMm through as rain_mm", () => {
    // 50 kph is the fetch_weather.py ADVERSE_WIND_KPH threshold.
    const result = toEngineWeather({ tempC: 12, precipMm: 6.2, windKph: 50, isAdverse: true });
    expect(result?.wind_mph).toBeCloseTo(31.07, 1); // 50 * 0.621371
    expect(result?.rain_mm).toBe(6.2);
  });

  it("returns undefined for null/undefined input (team outside TEAM_CITY, fetch failure, or flag off)", () => {
    expect(toEngineWeather(null)).toBeUndefined();
    expect(toEngineWeather(undefined)).toBeUndefined();
  });

  it("returns undefined when both windKph and precipMm are absent", () => {
    expect(toEngineWeather({ tempC: 12, isAdverse: false })).toBeUndefined();
  });

  it("handles a windKph-only or precipMm-only partial block", () => {
    expect(toEngineWeather({ windKph: 10 })).toEqual({ wind_mph: 10 * 0.621371 });
    expect(toEngineWeather({ precipMm: 3 })).toEqual({ rain_mm: 3 });
  });

  it("a converted mph value actually clears applyEnvironmentalPenalties' >18.5mph threshold at the ADVERSE_WIND_KPH boundary", () => {
    // fetch_weather.py's own adverse-wind threshold (50 kph ≈ 31 mph) is well
    // above the engine's 18.5mph penalty threshold — confirms the two systems'
    // thresholds are consistent in direction (fetch_weather's "adverse" flag
    // and the engine's penalty both fire on genuinely windy days, not at
    // cross purposes), and confirms the conversion produces a value the
    // engine's own gate actually reacts to (not silently under threshold).
    const result = toEngineWeather({ windKph: 50 });
    expect(result?.wind_mph).toBeGreaterThan(18.5);
  });
});
