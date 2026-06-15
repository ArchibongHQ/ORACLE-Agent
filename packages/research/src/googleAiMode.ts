/** @oracle/research — Google "AI Mode" / AI Overview acquisition via Playwright.
 *
 *  Navigates the Google AI-Mode search surface (`&udm=50`), extracts the
 *  AI-overview prose + citation links. Generic by design: callers pass any
 *  query (news, stats, odds) and reshape the prose downstream (e.g. via Gemini).
 *
 *  Never throws — returns null on any failure so callers can fall back cleanly.
 *
 *  Cloud/VPS safety: the GPU-disable launch flags apply ONLY on local Windows and
 *  auto-drop when ORACLE_IS_VPS=true or the platform is non-Windows. Identical guard
 *  to the SportyBet booking agent and the Python fixture scraper.
 */

import { chromium } from "playwright";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export interface GoogleAiModeResult {
  /** The AI-overview prose Google returned for the query. */
  text: string;
  /** Citation/source URLs surfaced alongside the overview. */
  sources: string[];
  /** ISO timestamp of when this acquisition ran (recency anchor). */
  observedAt: string;
}

/** Scrape Google AI-Mode for an arbitrary query. Returns null on any failure. */
export async function scrapeGoogleAiMode(query: string): Promise<GoogleAiModeResult | null> {
  if (!query.trim()) return null;

  const isLocalWindows = process.platform === "win32" && process.env["ORACLE_IS_VPS"] !== "true";
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        ...(isLocalWindows
          ? ["--disable-gpu", "--disable-dev-shm-usage", "--disable-software-rasterizer"]
          : []),
      ],
    });

    const context = await browser.newContext({
      userAgent: CHROME_UA,
      viewport: { width: 1280, height: 800 },
      locale: "en-GB",
      timezoneId: "Africa/Lagos",
      extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
    });
    // Mask the automation flag so the AI-Mode surface renders.
    await context.addInitScript("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})");

    const page = await context.newPage();
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Dismiss the EU/consent interstitial if present (best-effort, non-fatal).
    await dismissConsent(page);

    // Give the AI-overview block time to stream in.
    await page.waitForTimeout(3_000);

    const text = await extractOverviewText(page);
    if (!text) return null;

    const sources = await extractSourceLinks(page);

    return { text, sources, observedAt: new Date().toISOString() };
  } catch {
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}

/** Click through a Google consent dialog if one is shown. Best-effort. */
async function dismissConsent(page: import("playwright").Page): Promise<void> {
  const selectors = [
    'button:has-text("Accept all")',
    'button:has-text("Reject all")',
    'button:has-text("I agree")',
    "#L2AGLb",
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1_000 })) {
        await btn.click({ timeout: 2_000 });
        await page.waitForTimeout(500);
        return;
      }
    } catch {
      /* selector absent — keep trying */
    }
  }
}

/** Pull the AI-overview prose. Falls back to the main results column text. */
async function extractOverviewText(page: import("playwright").Page): Promise<string> {
  // AI-Mode renders the overview inside the main content region. These selectors
  // are deliberately broad — Google rotates class names, so we anchor on roles
  // and the search container rather than brittle hashed classes.
  const candidates = ["[data-rcs]", 'div[role="main"]', "#rso", "#search"];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        const txt = (await loc.innerText({ timeout: 5_000 })).trim();
        if (txt.length > 80) return collapse(txt);
      }
    } catch {
      /* try next selector */
    }
  }
  return "";
}

/** Collect citation/source hrefs from the overview region. */
async function extractSourceLinks(page: import("playwright").Page): Promise<string[]> {
  try {
    const hrefs = await page
      .locator('div[role="main"] a[href^="http"]')
      .evaluateAll((els) =>
        els
          .map((el) => (el as HTMLAnchorElement).href)
          .filter((h) => h && !h.includes("google.com") && !h.includes("gstatic.com"))
      );
    return Array.from(new Set(hrefs)).slice(0, 20);
  } catch {
    return [];
  }
}

/** Normalize whitespace to keep payloads compact for downstream LLM reshape. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 6_000);
}
