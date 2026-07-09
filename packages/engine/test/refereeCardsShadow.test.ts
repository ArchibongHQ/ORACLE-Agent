import { describe, expect, it } from "vitest";
import {
  formatRefereeCardsShadow,
  REFEREE_CARDS_SHADOW_THRESHOLD_DEFAULT,
  type RefereeCardsShadowInput,
  shadowRefereeCards,
} from "../src/marketsV3/refereeCardsShadow.js";

describe("shadowRefereeCards", () => {
  it("returns null when modelCardsMean is missing", () => {
    expect(shadowRefereeCards({ refereeCardsRate: 4.0 })).toBeNull();
  });

  it("returns null when refereeCardsRate is missing", () => {
    expect(shadowRefereeCards({ modelCardsMean: 4.0 })).toBeNull();
  });

  it("returns null when modelCardsMean is non-positive", () => {
    expect(shadowRefereeCards({ modelCardsMean: 0, refereeCardsRate: 4.0 })).toBeNull();
    expect(shadowRefereeCards({ modelCardsMean: -1, refereeCardsRate: 4.0 })).toBeNull();
  });

  it("returns null when refereeCardsRate is non-positive", () => {
    expect(shadowRefereeCards({ modelCardsMean: 4.0, refereeCardsRate: 0 })).toBeNull();
  });

  it("returns null when neither value is finite", () => {
    expect(
      shadowRefereeCards({ modelCardsMean: Number.NaN, refereeCardsRate: Number.POSITIVE_INFINITY })
    ).toBeNull();
  });

  it("returns null when the divergence is below the default threshold", () => {
    // 4.0 vs 4.3 -> ratio 1.075, deviation 7.5%, below 15% default.
    const result = shadowRefereeCards({ modelCardsMean: 4.0, refereeCardsRate: 4.3 });
    expect(result).toBeNull();
  });

  it("flags a stricter-than-model referee above the threshold", () => {
    // 4.0 model vs 5.0 referee -> ratio 1.25, deviation 25% >= 15%.
    const result = shadowRefereeCards({ modelCardsMean: 4.0, refereeCardsRate: 5.0 });
    expect(result).not.toBeNull();
    expect(result?.direction).toBe("stricter");
    expect(result?.ratio).toBeCloseTo(1.25, 5);
    expect(result?.deviationPct).toBeCloseTo(0.25, 5);
  });

  it("flags a more-lenient-than-model referee above the threshold", () => {
    // 4.0 model vs 3.0 referee -> ratio 0.75, deviation 25% >= 15%.
    const result = shadowRefereeCards({ modelCardsMean: 4.0, refereeCardsRate: 3.0 });
    expect(result).not.toBeNull();
    expect(result?.direction).toBe("lenient");
    expect(result?.deviationPct).toBeCloseTo(0.25, 5);
  });

  it("respects a custom threshold parameter", () => {
    const input: RefereeCardsShadowInput = { modelCardsMean: 4.0, refereeCardsRate: 4.3 };
    // 7.5% deviation clears a lowered 5% threshold.
    expect(shadowRefereeCards(input, 0.05)).not.toBeNull();
    // ...but not the default 15%.
    expect(shadowRefereeCards(input, REFEREE_CARDS_SHADOW_THRESHOLD_DEFAULT)).toBeNull();
  });

  it("clears the threshold once deviation is at/just above it (>=, not >)", () => {
    // 4.0 vs 4.61 -> ratio 1.1525, deviation ~15.25%, just clearing the 15% default.
    const result = shadowRefereeCards({ modelCardsMean: 4.0, refereeCardsRate: 4.61 });
    expect(result).not.toBeNull();
  });
});

describe("formatRefereeCardsShadow", () => {
  it("returns null when the shadow result is null", () => {
    expect(formatRefereeCardsShadow("Arsenal vs Chelsea", "Anthony Taylor", null)).toBeNull();
  });

  it("renders a report line naming the referee and the divergence", () => {
    const result = shadowRefereeCards({ modelCardsMean: 4.0, refereeCardsRate: 5.0 });
    const line = formatRefereeCardsShadow("Arsenal vs Chelsea", "Anthony Taylor", result);
    expect(line).toContain("Arsenal vs Chelsea");
    expect(line).toContain("Anthony Taylor");
    expect(line).toContain("stricter");
    expect(line).toContain("25%");
    expect(line).toContain("not applied");
  });

  it("falls back to a generic label when the referee name is unknown", () => {
    const result = shadowRefereeCards({ modelCardsMean: 4.0, refereeCardsRate: 5.0 });
    const line = formatRefereeCardsShadow("Arsenal vs Chelsea", undefined, result);
    expect(line).toContain("referee");
  });
});
