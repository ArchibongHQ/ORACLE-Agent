/** [owner mod #3, 2026-07-10] Single-page HTML report — fixtures + collapsible
 *  markets. Verifies the page is self-contained (no external assets), mirrors
 *  the spreadsheet's headline columns, and reveals each fixture's markets ladder
 *  under a native <details> dropdown. */
import { describe, expect, it } from "vitest";
import { renderFixturesMarketsPage } from "../src/fixtureWorkbook.js";
import type { SportyBetEvent } from "../src/selectFixtures.js";

function makeEvent(overrides: Partial<SportyBetEvent> = {}): SportyBetEvent {
  return {
    home: "France",
    away: "Morocco",
    league: "World Cup",
    kickoff_utc: "2026-07-10T20:00:00Z",
    marketCount: 3,
    eventId: "evt-1",
    detail: {
      eventId: "evt-1",
      odds: {
        "1x2": { home: 1.79, draw: 3.66, away: 4.56 },
        ou25: { over: 1.9, under: 1.95 },
        btts: { yes: 1.8, no: 2.0 },
        allMarkets: [
          {
            id: "18",
            name: "Over/Under",
            desc: "Over/Under",
            group: "Main",
            specifier: "total=2.5",
            outcomes: [
              { id: "o1", desc: "Over 2.5", odds: 1.9 },
              { id: "o2", desc: "Under 2.5", odds: 1.95 },
            ],
          },
        ],
      },
    },
    ...overrides,
  } as SportyBetEvent;
}

const DEPS = { lineups: [], newsByTeam: new Map() };

describe("renderFixturesMarketsPage", () => {
  it("produces a self-contained HTML doc with no external assets", () => {
    const html = renderFixturesMarketsPage([makeEvent()], "2026-07-10", DEPS);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // No external stylesheets, scripts, images, or fonts — must render offline
    // in Telegram's in-app browser.
    expect(html).not.toMatch(/<link[^>]+href|src=["']https?:|@import|<img/i);
  });

  it("renders one <details> dropdown per fixture with the markets ladder inside", () => {
    const html = renderFixturesMarketsPage(
      [makeEvent(), makeEvent({ home: "Spain", away: "Portugal" })],
      "2026-07-10",
      DEPS
    );
    expect((html.match(/<details>/g) ?? []).length).toBe(2);
    // Markets table headers + a captured outcome are present.
    expect(html).toContain("Over/Under");
    expect(html).toContain("Over 2.5");
    expect(html).toContain("1.9");
  });

  it("mirrors the spreadsheet's headline 1X2 in the collapsed summary", () => {
    const html = renderFixturesMarketsPage([makeEvent()], "2026-07-10", DEPS);
    expect(html).toContain("France v Morocco");
    expect(html).toContain("World Cup");
    expect(html).toContain("1.79"); // 1X2 home in the summary row
  });

  it("HTML-escapes team names (no markup injection from scraped data)", () => {
    const html = renderFixturesMarketsPage(
      [makeEvent({ home: "<script>x</script>" })],
      "2026-07-10",
      DEPS
    );
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("handles an empty slate and a fixture with no markets gracefully", () => {
    expect(renderFixturesMarketsPage([], "2026-07-10", DEPS)).toContain("No fixtures");
    const noMarkets = makeEvent({
      detail: { eventId: "e", odds: { allMarkets: [] } },
    } as Partial<SportyBetEvent>);
    expect(renderFixturesMarketsPage([noMarkets], "2026-07-10", DEPS)).toContain(
      "No markets captured"
    );
  });
});
