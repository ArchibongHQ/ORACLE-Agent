/** Canonical market index tests — verifies the generated catalog is internally
 *  consistent and that the family lookups/priceability helpers behave. */

import { afterEach, describe, expect, it } from "vitest";
import type { MarketCatalogEntry } from "../src/markets/index.js";
import {
  _resetCatalogOverlayForTests,
  extendCatalog,
  familyOf,
  isPriceable,
  lookupMarket,
  MARKET_BY_ID,
  MARKET_CATALOG,
  PRICEABLE_FAMILIES,
} from "../src/markets/index.js";

describe("market catalog", () => {
  it("has a non-trivial number of catalogued market types", () => {
    expect(MARKET_CATALOG.length).toBeGreaterThan(100);
  });

  it("has unique ids — the by-id index covers every entry", () => {
    const ids = new Set(MARKET_CATALOG.map((e) => e.id));
    expect(ids.size).toBe(MARKET_CATALOG.length);
    expect(MARKET_BY_ID.size).toBe(MARKET_CATALOG.length);
  });

  it("classifies the core priceable markets correctly", () => {
    expect(familyOf("18")).toBe("goals_ou"); // Over/Under
    expect(familyOf("19")).toBe("team_total"); // Home O/U
    expect(familyOf("29")).toBe("btts"); // GG/NG
    expect(familyOf("45")).toBe("correct_score");
    expect(isPriceable("18")).toBe(true);
    expect(isPriceable("29")).toBe(true);
  });

  it("prices combo / half markets and leaves specials / unknown unpriceable", () => {
    expect(familyOf("37")).toBe("combo"); // 1X2 & Over/Under
    expect(isPriceable("37")).toBe(true); // combo now priced (v1 independence)
    expect(familyOf("68")).toBe("half"); // 1st Half - Over/Under
    expect(isPriceable("68")).toBe(true); // half now priced (scaled-Poisson FH)
    expect(isPriceable("999999")).toBe(false); // not in catalog
    expect(lookupMarket("999999")).toBeUndefined();
  });

  it("every entry's family is a member of the family union and priceable set is a subset", () => {
    for (const e of MARKET_CATALOG) {
      expect(typeof e.family).toBe("string");
      expect(e.id).toBeTruthy();
    }
    // every priceable family must actually appear in the catalog at least once
    const families = new Set(MARKET_CATALOG.map((e) => e.family));
    for (const fam of PRICEABLE_FAMILIES) {
      expect(families.has(fam)).toBe(true);
    }
  });
});

function overlayEntry(overrides: Partial<MarketCatalogEntry> = {}): MarketCatalogEntry {
  return {
    id: "999999",
    name: "Some New Special",
    group: "Main",
    family: "goals_ou",
    outcomes: ["Over 2.5", "Under 2.5"],
    specifierShapes: ["total=<num>"],
    fixturesSeen: 3,
    ...overrides,
  };
}

describe("extendCatalog (PR-21)", () => {
  afterEach(() => {
    _resetCatalogOverlayForTests();
  });

  it("fills a genuinely uncatalogued id, making it resolvable via lookupMarket/familyOf/isPriceable", () => {
    expect(lookupMarket("999999")).toBeUndefined();

    const added = extendCatalog([overlayEntry()]);

    expect(added).toBe(1);
    expect(lookupMarket("999999")?.name).toBe("Some New Special");
    expect(familyOf("999999")).toBe("goals_ou");
    expect(isPriceable("999999")).toBe(true);
  });

  it("never shadows an id already in the committed MARKET_CATALOG", () => {
    const committedId = MARKET_CATALOG[0]?.id;
    expect(committedId).toBeTruthy();
    const committedEntry = lookupMarket(committedId as string);

    const added = extendCatalog([
      overlayEntry({ id: committedId, name: "BOGUS OVERRIDE", family: "exotic" }),
    ]);

    expect(added).toBe(0);
    expect(lookupMarket(committedId as string)).toEqual(committedEntry);
  });

  it("skips entries with a blank id or an unrecognised family, without throwing", () => {
    const added = extendCatalog([
      overlayEntry({ id: "", name: "no id" }),
      overlayEntry({ id: "888888", family: "not_a_real_family" as MarketCatalogEntry["family"] }),
    ]);

    expect(added).toBe(0);
    expect(lookupMarket("888888")).toBeUndefined();
  });

  it("is idempotent — re-adding the same overlay id twice only counts once", () => {
    extendCatalog([overlayEntry()]);
    const secondAdded = extendCatalog([overlayEntry()]);

    expect(secondAdded).toBe(0);
    expect(lookupMarket("999999")?.name).toBe("Some New Special");
  });
});
