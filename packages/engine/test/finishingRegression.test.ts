import { describe, expect, it } from "vitest";
import {
  FINISHING_REGRESSION_THRESHOLD_DEFAULT,
  formatFinishingRegressionShadow,
  shadowFinishingRegression,
} from "../src/marketsV3/finishingRegression.js";

describe("shadowFinishingRegression", () => {
  it("returns no candidates when neither side has npxG coverage", () => {
    const result = shadowFinishingRegression({
      homeScoredPer90: 1.8,
      awayScoredPer90: 1.2,
    });
    expect(result.candidates).toEqual([]);
  });

  it("returns no candidates when npxgf is present but actual scoring rate is missing", () => {
    const result = shadowFinishingRegression({ homeNpxgf: 1.5 });
    expect(result.candidates).toEqual([]);
  });

  it("returns no candidates when npxgf is non-positive", () => {
    const result = shadowFinishingRegression({ homeNpxgf: 0, homeScoredPer90: 1.5 });
    expect(result.candidates).toEqual([]);
  });

  it("flags overperformance past the threshold", () => {
    // 2.0 actual vs 1.0 npxG = 100% over, well past the 25% default threshold.
    const result = shadowFinishingRegression({ homeNpxgf: 1.0, homeScoredPer90: 2.0 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      side: "home",
      npxgf: 1.0,
      actualScoredPer90: 2.0,
      ratio: 2.0,
      direction: "overperforming",
    });
  });

  it("flags underperformance past the threshold", () => {
    // 0.5 actual vs 1.0 npxG = 50% under.
    const result = shadowFinishingRegression({ awayNpxgf: 1.0, awayScoredPer90: 0.5 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      side: "away",
      direction: "underperforming",
    });
  });

  it("does not flag a deviation under the threshold", () => {
    // 1.1 actual vs 1.0 npxG = 10% over, under the 25% default.
    const result = shadowFinishingRegression({ homeNpxgf: 1.0, homeScoredPer90: 1.1 });
    expect(result.candidates).toEqual([]);
  });

  it("evaluates home and away independently", () => {
    const result = shadowFinishingRegression({
      homeNpxgf: 1.0,
      homeScoredPer90: 2.0, // over
      awayNpxgf: 1.0,
      awayScoredPer90: 0.5, // under
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.side).sort()).toEqual(["away", "home"]);
  });

  it("respects a custom threshold", () => {
    // 1.1 actual vs 1.0 npxG = 10% over — flagged only when threshold < 0.10.
    const atDefault = shadowFinishingRegression(
      { homeNpxgf: 1.0, homeScoredPer90: 1.1 },
      FINISHING_REGRESSION_THRESHOLD_DEFAULT
    );
    expect(atDefault.candidates).toEqual([]);
    const tighter = shadowFinishingRegression({ homeNpxgf: 1.0, homeScoredPer90: 1.1 }, 0.05);
    expect(tighter.candidates).toHaveLength(1);
  });
});

describe("formatFinishingRegressionShadow", () => {
  it("returns null when there are no candidates", () => {
    const result = shadowFinishingRegression({});
    expect(formatFinishingRegressionShadow("Arsenal vs Chelsea", result)).toBeNull();
  });

  it("formats a single-side divergence", () => {
    const result = shadowFinishingRegression({ homeNpxgf: 1.0, homeScoredPer90: 2.0 });
    const line = formatFinishingRegressionShadow("Arsenal vs Chelsea", result);
    expect(line).toContain("Arsenal vs Chelsea");
    expect(line).toContain("home overperforming npxG");
    expect(line).toContain("not applied");
  });

  it("formats both sides when both diverge", () => {
    const result = shadowFinishingRegression({
      homeNpxgf: 1.0,
      homeScoredPer90: 2.0,
      awayNpxgf: 1.0,
      awayScoredPer90: 0.5,
    });
    const line = formatFinishingRegressionShadow("Arsenal vs Chelsea", result);
    expect(line).toContain("home overperforming");
    expect(line).toContain("away underperforming");
  });
});
