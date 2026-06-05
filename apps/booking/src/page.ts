/** Playwright DOM interactions for SportyBet Nigeria.
 *  Selectors verified live against https://www.sportybet.com/ng/ on 2026-06-04.
 *  Update this file when SportyBet changes their UI — all selectors are isolated here. */

import type { Page } from 'playwright';
import type { ActionablePick } from '@oracle/notify';
import { mapMarket, fuzzyMatch, normalise } from './marketMap.js';

const BASE_URL = 'https://www.sportybet.com/ng/sport/football';
const NAV_TIMEOUT = 45_000;
const CLICK_WAIT  = 1_000;
const BOOK_WAIT   = 6_000;

export interface AddLegResult {
  selectionLabel: string;
  odds: string;
}

/** Navigate to SportyBet football, find a matching fixture, add the selection to betslip.
 *  Returns { selectionLabel, odds } on success, null if fixture/market can't be matched. */
export async function addLegToBetslip(page: Page, pick: ActionablePick): Promise<AddLegResult | null> {
  const mapping = mapMarket(pick.market, pick.side);
  if (!mapping) return null;

  try {
    // Only navigate on first call; subsequent picks reuse the loaded page
    if (!page.url().includes('sportybet.com')) {
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
      await page.waitForTimeout(5_000);
    }

    const homeNorm = normalise(pick.home);
    const awayNorm = normalise(pick.away);

    // Find match row containing both team names
    const matchRows = await page.locator('.m-table-row.match-row').all();
    for (const row of matchRows) {
      const rowText = (await row.textContent() ?? '').toLowerCase();
      const homeWords = homeNorm.split(' ').filter(w => w.length > 2);
      const awayWords = awayNorm.split(' ').filter(w => w.length > 2);
      const homeMatch = homeWords.some(w => rowText.includes(w));
      const awayMatch = awayWords.some(w => rowText.includes(w));

      if (!homeMatch || !awayMatch) continue;

      // Determine which outcome to click: 1=home, X=draw, 2=away (for 1X2)
      // For goals O/U: find the over/under market tab then the outcome
      const outcomes = await row.locator('.m-outcome').all();
      if (!outcomes.length) continue;

      // For 1X2: outcomes[0]=home, [1]=draw, [2]=away
      // For O/U (Goals): need to click the market tab on the fixture page
      let targetOutcome: typeof outcomes[0] | null = null;

      const sel = mapping.sportySelection.toLowerCase();
      if (outcomes.length >= 3) {
        if (sel === '1' || sel.includes('home win')) targetOutcome = outcomes[0] ?? null;
        else if (sel === 'x' || sel.includes('draw'))  targetOutcome = outcomes[1] ?? null;
        else if (sel === '2' || sel.includes('away win')) targetOutcome = outcomes[2] ?? null;
      }

      // For Over/Under — click the "+N" more markets button to open fixture
      if (!targetOutcome && (sel.includes('over') || sel.includes('under'))) {
        const moreBtn = row.locator('[class*="more"], [class*="plus"]').first();
        if (await moreBtn.count() > 0) {
          await moreBtn.evaluate(el => (el as HTMLElement).click());
          await page.waitForTimeout(2_000);
          // Now look for O/U market on the fixture detail page
          const marketTabs = await page.locator('[class*="market-name"], [class*="tab"]').all();
          for (const tab of marketTabs) {
            const tabText = (await tab.textContent() ?? '').toLowerCase();
            if (tabText.includes('over') || tabText.includes('goal') || tabText.includes('total')) {
              await tab.evaluate(el => (el as HTMLElement).click());
              await page.waitForTimeout(1_000);
              break;
            }
          }
          // Find over/under outcomes matching our line
          const allOutcomes = await page.locator('.m-outcome').all();
          for (const o of allOutcomes) {
            const oText = (await o.textContent() ?? '').toLowerCase();
            if (fuzzyMatch(mapping.sportySelection, oText)) {
              targetOutcome = o;
              break;
            }
          }
          // Navigate back if needed
          if (!targetOutcome) {
            await page.goBack({ waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
            await page.waitForTimeout(2_000);
          }
        }
      }

      if (!targetOutcome) continue;

      // Scrape odds from the outcome element (the span inside)
      const oddsText = await targetOutcome.evaluate(el => {
        const oddsEl = el.querySelector('.m-outcome-odds') ?? el;
        return (oddsEl.textContent ?? '').trim();
      });
      await targetOutcome.evaluate(el => (el as HTMLElement).click());
      await page.waitForTimeout(CLICK_WAIT);

      return { selectionLabel: mapping.sportySelection, odds: oddsText };
    }

    return null; // fixture not found on current page
  } catch {
    return null;
  }
}

/** Click the "Book Bet" button (anonymous, no stake) and scrape the booking code.
 *  Verified selector: .booking-code-share-code */
export async function triggerBookAndScrape(page: Page): Promise<{ code: string | null; totalOdds: number; loadUrl: string | null }> {
  try {
    // Click Book Bet span
    await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll<HTMLSpanElement>('span'));
      const bookSpan = spans.find((s: HTMLSpanElement) => (s.textContent || '').trim() === 'Book Bet');
      if (bookSpan) bookSpan.click();
    });

    // Wait for booking code modal to appear
    await page.waitForSelector('.booking-code-share-code, .m-code', { timeout: BOOK_WAIT });
    await page.waitForTimeout(1_000);

    // Scrape code — primary: .booking-code-share-code; fallback: input[readonly]
    const code = await page.evaluate((): string | null => {
      const el = document.querySelector('.booking-code-share-code');
      if (el) return (el.textContent || '').trim();
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[readonly]'));
      for (const inp of inputs) {
        const val = inp.value.trim();
        if (/^[A-Z0-9]{4,10}$/.test(val)) return val;
      }
      return null;
    });

    // Scrape load URL from readonly input
    const loadUrl = await page.evaluate((): string | null => {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[readonly]'));
      for (const inp of inputs) {
        if (inp.value.includes('shareCode') || inp.value.includes('sportybet')) return inp.value.trim();
      }
      return null;
    });

    // Scrape total odds from betslip modal
    const totalOdds = await page.evaluate((): number => {
      const body = document.querySelector('.m-booking-code-body');
      if (!body) return 0;
      const text = body.textContent || '';
      const m = text.match(/Odds\s+([\d.]+)/i);
      return m ? parseFloat(m[1] ?? '0') : 0;
    });

    return { code: code || null, totalOdds, loadUrl: loadUrl || (code ? `https://www.sportybet.com/?shareCode=${code}&c=ng` : null) };
  } catch {
    return { code: null, totalOdds: 0, loadUrl: null };
  }
}
