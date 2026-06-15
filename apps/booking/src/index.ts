/** @oracle/booking — anonymous SportyBet accumulator booking agent.
 *  No login, no stake, no real money. Generates a shareable booking code only. */

import type { ActionablePick } from "@oracle/notify";
import { chromium } from "playwright";
import { addLegToBetslip, triggerBookAndScrape } from "./page.js";

export type { LoadedSlip, RawLeg } from "./loadCode.js";
export { loadBookingCode } from "./loadCode.js";

export interface BookedLeg {
  pick: ActionablePick;
  selectionLabel: string;
  odds: string;
}

export interface BookingResult {
  code: string | null;
  loadUrl: string | null;
  totalOdds: number;
  bookedLegs: BookedLeg[];
  unmatched: ActionablePick[];
  bookedAt: string;
  error?: string;
}

/** Book all picks as a single accumulator on SportyBet (anonymous, no-stake).
 *  Never throws — returns error in-band so it never blocks report delivery. */
export async function bookAccumulator(picks: ActionablePick[]): Promise<BookingResult> {
  const bookedAt = new Date().toISOString();
  const empty: BookingResult = {
    code: null,
    loadUrl: null,
    totalOdds: 0,
    bookedLegs: [],
    unmatched: [...picks],
    bookedAt,
  };

  if (!picks.length) return { ...empty, unmatched: [], error: "no actionable picks to book" };

  const isLocalWindows = process.platform === "win32" && process.env["ORACLE_IS_VPS"] !== "true";
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      ...(isLocalWindows ? ["--disable-gpu", "--disable-dev-shm-usage", "--disable-software-rasterizer"] : []),
    ],
  });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      locale: "en-NG",
      timezoneId: "Africa/Lagos",
    });
    const page = await context.newPage();

    const bookedLegs: BookedLeg[] = [];
    const unmatched: ActionablePick[] = [];

    for (const pick of picks) {
      const result = await addLegToBetslip(page, pick);
      if (result) {
        bookedLegs.push({ pick, selectionLabel: result.selectionLabel, odds: result.odds });
      } else {
        unmatched.push(pick);
      }
    }

    if (!bookedLegs.length) {
      return { ...empty, unmatched, error: "no picks could be mapped to SportyBet selections" };
    }

    const { code, totalOdds, loadUrl } = await triggerBookAndScrape(page);

    return { code, loadUrl, totalOdds, bookedLegs, unmatched, bookedAt };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await browser.close();
  }
}
