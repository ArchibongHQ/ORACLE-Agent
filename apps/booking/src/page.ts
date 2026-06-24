/** Playwright DOM interactions for SportyBet Nigeria.
 *  Selectors verified live against https://www.sportybet.com/ng/ on 2026-06-23.
 *  Update this file when SportyBet changes their UI — all selectors are isolated here. */

import type { ActionablePick } from "@oracle/notify";
import type { Locator, Page } from "playwright";
import { mapMarket, normalise, resolvePageTarget } from "./marketMap.js";

const BASE_URL = "https://www.sportybet.com/ng/sport/football";
const NAV_TIMEOUT = 45_000;
const CLICK_WAIT = 1_000;
const BOOK_WAIT = 6_000;

export interface AddLegResult {
  selectionLabel: string;
  odds: string;
}

/** Scan `.m-detail-wrapper > *` blocks on a fixture detail page for ones whose
 *  `.m-table-header-title` text satisfies `headerMatches`. Many markets repeat
 *  as multiple blocks sharing the same header (one per line) — callers that
 *  need a specific line must filter further within the returned blocks. */
async function findMarketBlocks(
  page: Page,
  headerMatches: (headerText: string) => boolean
): Promise<Locator[]> {
  const blocks = await page.locator(".m-detail-wrapper > *").all();
  const matches: Locator[] = [];
  for (const block of blocks) {
    const headerEl = block.locator(".m-table-header-title").first();
    if ((await headerEl.count()) === 0) continue;
    const headerText = ((await headerEl.textContent()) ?? "").trim();
    if (headerMatches(headerText)) matches.push(block);
  }
  return matches;
}

/** Within a market block, find the outcome cell whose first `.m-table-cell-item`
 *  (the label) satisfies `matchesLabel`. The two cell-item spans (label, odds)
 *  are read separately — textContent on the parent concatenates them with no
 *  space, so a regex on the joined text would be unreliable. */
async function findOutcomeInBlock(
  block: Locator,
  matchesLabel: (labelText: string) => boolean
): Promise<{ locator: Locator; oddsText: string } | null> {
  const cells = await block.locator(".m-table-cell").all();
  for (const cell of cells) {
    const items = cell.locator(".m-table-cell-item");
    const itemCount = await items.count();
    if (itemCount < 2) continue;
    const labelText = ((await items.nth(0).textContent()) ?? "").trim();
    if (!matchesLabel(labelText)) continue;
    const oddsText = ((await items.nth(1).textContent()) ?? "").trim();
    return { locator: cell, oddsText };
  }
  return null;
}

/** Find+click a market's outcome on the current fixture detail page.
 *  Scans every block matching the header predicate (markets that repeat per
 *  line have several), returning the first outcome whose label matches. */
async function findAndClickOnDetailPage(
  page: Page,
  headerMatches: (headerText: string) => boolean,
  labelMatches: (labelText: string) => boolean
): Promise<{ locator: Locator; oddsText: string } | null> {
  const blocks = await findMarketBlocks(page, headerMatches);
  for (const block of blocks) {
    const found = await findOutcomeInBlock(block, labelMatches);
    if (found) return found;
  }
  return null;
}

/** Navigate to SportyBet football, find a matching fixture, add the selection to betslip.
 *  Returns { selectionLabel, odds } on success, null if fixture/market can't be matched.
 *
 *  When `pick.eventId` is present (e.g. "sr:match:66456926"), navigates directly to
 *  the fixture detail URL — bypassing the paginated listing page that only renders
 *  fixtures currently in the DOM. Falls back to the listing-scan path when absent. */
export async function addLegToBetslip(
  page: Page,
  pick: ActionablePick
): Promise<AddLegResult | null> {
  const mapping = mapMarket(pick.market, pick.side);
  if (!mapping) return null;

  try {
    // ── Direct fixture URL path (preferred when eventId is available) ─────────
    // The SportyBet listing is a virtualised SPA — only fixtures visible in the
    // current viewport are in the DOM. With 100+ fixtures across many leagues,
    // most picks won't be found by the listing scan. Navigate directly instead.
    if (pick.eventId) {
      const detailUrl = `${BASE_URL}/${pick.eventId}`;
      await page.goto(detailUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
      await page.waitForTimeout(3_000);

      // For 1X2 on the detail page we still use the detail-page market blocks,
      // not the listing-row shortcut (which doesn't exist on the detail page).
      const target = resolvePageTarget(mapping, pick);
      if (!target) return null;

      const found = await findAndClickOnDetailPage(page, target.headerMatches, target.labelMatches);
      if (!found) return null;

      await found.locator.click();
      await page.waitForTimeout(CLICK_WAIT);
      return { selectionLabel: mapping.sportySelection, odds: found.oddsText };
    }

    // ── Listing-scan fallback (no eventId — scans currently-visible rows) ─────
    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
    await page.waitForTimeout(5_000);

    const homeNorm = normalise(pick.home);
    const awayNorm = normalise(pick.away);
    const homeWords = homeNorm.split(" ").filter((w) => w.length > 2);
    const awayWords = awayNorm.split(" ").filter((w) => w.length > 2);

    // Find match row containing both team names
    const matchRows = await page.locator(".m-table-row.match-row").all();
    for (const row of matchRows) {
      const rowText = ((await row.textContent()) ?? "").toLowerCase();
      const homeMatch = homeWords.some((w) => rowText.includes(w));
      const awayMatch = awayWords.some((w) => rowText.includes(w));
      if (!homeMatch || !awayMatch) continue;

      // 1X2 fast path: outcomes[0]=home, [1]=draw, [2]=away, directly on the
      // listing row — confirmed live, unchanged since 2026-06-04.
      if (mapping.sportyMarket === "1X2") {
        const outcomes = await row.locator(".m-outcome").all();
        if (outcomes.length < 3) continue;
        const sel = mapping.sportySelection;
        const targetOutcome =
          sel === "1" ? outcomes[0] : sel === "X" ? outcomes[1] : sel === "2" ? outcomes[2] : null;
        if (!targetOutcome) continue;

        const oddsText = await targetOutcome.evaluate((el) => {
          const oddsEl = el.querySelector(".m-outcome-odds") ?? el;
          return (oddsEl.textContent ?? "").trim();
        });
        await targetOutcome.click();
        await page.waitForTimeout(CLICK_WAIT);
        return { selectionLabel: mapping.sportySelection, odds: oddsText };
      }

      // Every other market lives on the fixture detail page. Navigate there with
      // a real click (dispatchEvent doesn't trigger the SPA router).
      const target = resolvePageTarget(mapping, pick);
      if (!target) return null; // no confirmed live mapping for this market (e.g. Asian Total Goals)

      await row.locator(".teams, .home-team, .away-team").first().click();
      await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(3_000);

      const found = await findAndClickOnDetailPage(page, target.headerMatches, target.labelMatches);
      if (!found) return null;

      await found.locator.click();
      await page.waitForTimeout(CLICK_WAIT);
      return { selectionLabel: mapping.sportySelection, odds: found.oddsText };
    }

    return null; // fixture not found on current page
  } catch {
    return null;
  }
}

/** Click the "Book Bet" button (anonymous, no stake) and scrape the booking code.
 *  Verified selector: .booking-code-share-code */
export async function triggerBookAndScrape(
  page: Page
): Promise<{ code: string | null; totalOdds: number; loadUrl: string | null }> {
  try {
    // Click Book Bet span
    await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll<HTMLSpanElement>("span"));
      const bookSpan = spans.find(
        (s: HTMLSpanElement) => (s.textContent || "").trim() === "Book Bet"
      );
      if (bookSpan) bookSpan.click();
    });

    // Wait for booking code modal to appear
    await page.waitForSelector(".booking-code-share-code, .m-code", { timeout: BOOK_WAIT });
    await page.waitForTimeout(1_000);

    // Scrape code — primary: .booking-code-share-code; fallback: input[readonly]
    const code = await page.evaluate((): string | null => {
      const el = document.querySelector(".booking-code-share-code");
      if (el) return (el.textContent || "").trim();
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[readonly]"));
      for (const inp of inputs) {
        const val = inp.value.trim();
        if (/^[A-Z0-9]{4,10}$/.test(val)) return val;
      }
      return null;
    });

    // Scrape load URL from readonly input
    const loadUrl = await page.evaluate((): string | null => {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[readonly]"));
      for (const inp of inputs) {
        if (inp.value.includes("shareCode") || inp.value.includes("sportybet"))
          return inp.value.trim();
      }
      return null;
    });

    // Scrape total odds from betslip modal
    const totalOdds = await page.evaluate((): number => {
      const body = document.querySelector(".m-booking-code-body");
      if (!body) return 0;
      const text = body.textContent || "";
      const m = text.match(/Odds\s+([\d.]+)/i);
      return m ? parseFloat(m[1] ?? "0") : 0;
    });

    return {
      code: code || null,
      totalOdds,
      loadUrl: loadUrl || (code ? `https://www.sportybet.com/?shareCode=${code}&c=ng` : null),
    };
  } catch {
    return { code: null, totalOdds: 0, loadUrl: null };
  }
}
