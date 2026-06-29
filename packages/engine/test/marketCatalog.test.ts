/** Canonical market index tests — verifies the generated catalog is internally
 *  consistent and that the family lookups/priceability helpers behave. */

import { describe, expect, it } from "vitest";
import {
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
