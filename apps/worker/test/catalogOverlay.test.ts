/** PR-21: unit tests for the catalog-overlay loader. Extracted into its own
 *  dependency-free module (catalogOverlay.ts, mirroring xgCoverageNote.ts's
 *  convention) with the file path as an explicit parameter, so this is
 *  testable with tmp paths without importing the rest of index.ts. Each test
 *  uses ids unique to itself — @oracle/engine's CATALOG_OVERLAY is
 *  module-level state that persists across tests in this file, and
 *  extendCatalog()'s test-only reset is deliberately NOT part of the
 *  package's public barrel (no reason to expose test plumbing outside
 *  @oracle/engine's own test suite), so unique ids are the isolation
 *  mechanism here instead. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupMarket } from "@oracle/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCatalogOverlay } from "../src/catalogOverlay.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oracle-catalog-overlay-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(id: string) {
  return {
    id,
    name: `New Market ${id}`,
    group: "Main",
    family: "goals_ou",
    outcomes: ["Over 2.5", "Under 2.5"],
    specifierShapes: ["total=<num>"],
    fixturesSeen: 2,
  };
}

describe("loadCatalogOverlay", () => {
  it("returns 0 and never throws when the overlay file doesn't exist", () => {
    expect(loadCatalogOverlay(join(dir, "nope.json"))).toBe(0);
  });

  it("returns 0 and never throws on unparseable JSON", () => {
    const path = join(dir, "overlay.json");
    writeFileSync(path, "{not json", "utf8");
    expect(loadCatalogOverlay(path)).toBe(0);
  });

  it("returns 0 and never throws when the file is valid JSON but not an array", () => {
    const path = join(dir, "overlay.json");
    writeFileSync(path, JSON.stringify({ oops: true }), "utf8");
    expect(loadCatalogOverlay(path)).toBe(0);
  });

  it("loads valid entries and they become resolvable via @oracle/engine's lookupMarket", () => {
    const path = join(dir, "overlay.json");
    writeFileSync(path, JSON.stringify([entry("777101"), entry("777102")]), "utf8");

    const added = loadCatalogOverlay(path);

    expect(added).toBe(2);
    expect(lookupMarket("777101")?.name).toBe("New Market 777101");
    expect(lookupMarket("777102")?.name).toBe("New Market 777102");
  });

  it("re-loading the same overlay file twice is idempotent (second load adds 0 more)", () => {
    const path = join(dir, "overlay.json");
    writeFileSync(path, JSON.stringify([entry("777201")]), "utf8");

    loadCatalogOverlay(path);
    const secondAdded = loadCatalogOverlay(path);

    expect(secondAdded).toBe(0);
    expect(lookupMarket("777201")?.name).toBe("New Market 777201");
  });

  it("stores a malformed entry (missing non-id/non-family fields) rather than crashing — extendCatalog only guards id/family", () => {
    const path = join(dir, "overlay.json");
    // Real-world shape: id + family present (extendCatalog's only checks),
    // everything else missing/wrong-typed — this is what a hand-edited or
    // partially-written overlay file could look like.
    writeFileSync(path, JSON.stringify([{ id: "777301", family: "goals_ou", name: 42 }]), "utf8");

    expect(() => loadCatalogOverlay(path)).not.toThrow();
    const added = loadCatalogOverlay(path);
    expect(added).toBe(0); // already added by the call above — idempotent, not a crash
    expect(lookupMarket("777301")).toBeDefined();
  });
});
