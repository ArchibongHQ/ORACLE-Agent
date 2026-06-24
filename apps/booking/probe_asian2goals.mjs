import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  locale: "en-NG",
  timezoneId: "Africa/Lagos",
});
const page = await context.newPage();

// Try to find tournament fixtures - check listing for World Cup / international comps
await page.goto("https://www.sportybet.com/ng/sport/football", { waitUntil: "networkidle", timeout: 45_000 });
await page.waitForTimeout(5_000);

const leagues = await page.evaluate(() => {
  const headers = Array.from(document.querySelectorAll('[class*="league"], [class*="tournament"], [class*="m-title"]'));
  return headers.slice(0, 40).map((h) => (h.textContent || "").trim()).filter(Boolean);
});
console.log("LEAGUE HEADERS:", JSON.stringify(leagues.slice(0, 30), null, 1));

await browser.close();
