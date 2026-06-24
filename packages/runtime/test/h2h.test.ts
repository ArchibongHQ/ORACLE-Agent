import { describe, expect, it } from "vitest";
import { buildRecentScorelines, type FDMatch } from "../src/h2h.js";

function match(
  homeTeam: string,
  awayTeam: string,
  ftHome: number,
  ftAway: number,
  utcDate?: string
): FDMatch {
  const winner = ftHome > ftAway ? "HOME_TEAM" : ftAway > ftHome ? "AWAY_TEAM" : "DRAW";
  return {
    id: 1,
    homeTeam: { name: homeTeam },
    awayTeam: { name: awayTeam },
    score: { winner, fullTime: { home: ftHome, away: ftAway } },
    utcDate,
  };
}

describe("buildRecentScorelines", () => {
  it("normalizes scorelines to the current fixture's home/away perspective when the historical match had the same home side", () => {
    const matches = [match("Arsenal", "Chelsea", 2, 1, "2025-03-02")];
    const result = buildRecentScorelines(matches, "Arsenal");
    expect(result).toEqual(["2-1 (2025-03-02)"]);
  });

  it("flips scorelines when the historical match had the OPPOSITE home side (reverse fixture)", () => {
    // Chelsea hosted Arsenal and won 3-0 — from Arsenal-as-home perspective, that's 0-3.
    const matches = [match("Chelsea", "Arsenal", 3, 0, "2024-11-10")];
    const result = buildRecentScorelines(matches, "Arsenal");
    expect(result).toEqual(["0-3 (2024-11-10)"]);
  });

  it("sorts most recent first", () => {
    const matches = [
      match("Arsenal", "Chelsea", 1, 1, "2023-01-01"),
      match("Arsenal", "Chelsea", 2, 0, "2025-06-01"),
      match("Arsenal", "Chelsea", 0, 0, "2024-03-15"),
    ];
    const result = buildRecentScorelines(matches, "Arsenal");
    expect(result).toEqual(["2-0 (2025-06-01)", "0-0 (2024-03-15)", "1-1 (2023-01-01)"]);
  });

  it("omits the date suffix when utcDate is absent", () => {
    const matches = [match("Arsenal", "Chelsea", 2, 1)];
    const result = buildRecentScorelines(matches, "Arsenal");
    expect(result).toEqual(["2-1"]);
  });

  it("returns [] for an empty match list", () => {
    expect(buildRecentScorelines([], "Arsenal")).toEqual([]);
  });

  it("handles draws correctly from both perspectives", () => {
    const matches = [match("Chelsea", "Arsenal", 1, 1, "2025-01-01")];
    const result = buildRecentScorelines(matches, "Arsenal");
    expect(result).toEqual(["1-1 (2025-01-01)"]);
  });
});
