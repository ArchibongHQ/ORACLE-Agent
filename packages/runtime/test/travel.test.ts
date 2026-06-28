import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs")>();
  return { ...mod, readFileSync: vi.fn() };
});

const { readFileSync } = await import("node:fs");
const { _resetVenueCache, buildTravel } = await import("../src/travel.js");

function setVenues(table: Record<string, { lat: number; lon: number; altitude: number }>): void {
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(table));
  _resetVenueCache();
}

describe("buildTravel", () => {
  it("does not drop a real sea-level venue (altitude === 0)", () => {
    setVenues({
      "home team": { lat: 51.5, lon: -0.1, altitude: 0 },
      "away team": { lat: 48.8, lon: 2.3, altitude: 35 },
    });
    const result = buildTravel("Home Team", "Away Team");
    expect(result.telemetry.altitudeM).toBe(0);
    expect(result.telemetry.travelKm).toBeGreaterThan(0);
  });

  it("reports a non-zero altitude normally", () => {
    setVenues({
      "home team": { lat: 19.4, lon: -99.1, altitude: 2240 },
      "away team": { lat: 48.8, lon: 2.3, altitude: 35 },
    });
    const result = buildTravel("Home Team", "Away Team");
    expect(result.telemetry.altitudeM).toBe(2240);
  });

  it("returns empty telemetry when the home team is missing from the venue table", () => {
    setVenues({ "away team": { lat: 48.8, lon: 2.3, altitude: 35 } });
    const result = buildTravel("Home Team", "Away Team");
    expect(result.telemetry).toEqual({});
    expect(result.soft).toBeUndefined();
  });

  it("omits travelKm for a neutral venue but still reports altitude", () => {
    setVenues({
      "home team": { lat: 25.3, lon: 51.5, altitude: 10 },
      "away team": { lat: 48.8, lon: 2.3, altitude: 35 },
    });
    const result = buildTravel("Home Team", "Away Team", { neutralVenue: true });
    expect(result.telemetry.travelKm).toBeUndefined();
    expect(result.telemetry.altitudeM).toBe(10);
    expect(result.soft?.text).toContain("neutral venue");
  });

  it("returns empty telemetry when readFileSync throws (missing/corrupt cache)", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    _resetVenueCache();
    const result = buildTravel("Anyone", "Anyone Else");
    expect(result.telemetry).toEqual({});
  });
});
