/** routeFixture (B7) — deterministic model routing by convergence tier. */
import { describe, expect, it } from "vitest";
import { MODELS } from "../src/cascade.js";
import { routeFixture } from "../src/routeBatch.js";

describe("routeFixture", () => {
  it("APEX → full path (Opus + CVL + briefing) with 7 swarm workers", () => {
    expect(routeFixture("APEX")).toEqual({
      tier: "APEX",
      useOpus: true,
      useCVL: true,
      useBriefing: true,
      acquisitionModel: MODELS.GEMINI_FLASH,
      swarmWorkers: 7,
    });
  });

  it("PRIME → full path with 5 swarm workers", () => {
    const route = routeFixture("PRIME");
    expect(route.useOpus).toBe(true);
    expect(route.useCVL).toBe(true);
    expect(route.useBriefing).toBe(true);
    expect(route.swarmWorkers).toBe(5);
  });

  it("VIABLE → standard path, 3 workers, no optional layers", () => {
    expect(routeFixture("VIABLE")).toEqual({
      tier: "VIABLE",
      useOpus: false,
      useCVL: false,
      useBriefing: false,
      acquisitionModel: MODELS.GEMINI_FLASH,
      swarmWorkers: 3,
    });
  });

  it("MARGINAL and NOISE → Flash-Lite acquisition only, 0 workers", () => {
    for (const tier of ["MARGINAL", "NOISE"] as const) {
      expect(routeFixture(tier)).toEqual({
        tier,
        useOpus: false,
        useCVL: false,
        useBriefing: false,
        acquisitionModel: MODELS.GEMINI_FLASH_LITE,
        swarmWorkers: 0,
      });
    }
  });

  it("unknown tier defaults to VIABLE", () => {
    expect(routeFixture("garbage").tier).toBe("VIABLE");
    expect(routeFixture("").swarmWorkers).toBe(3);
  });
});
