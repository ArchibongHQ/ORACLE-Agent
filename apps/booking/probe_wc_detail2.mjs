import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  locale: "en-NG",
  timezoneId: "Africa/Lagos",
});
const page = await context.newPage();
await page.goto("https://www.sportybet.com/ng/sport/football/sr:category:top/sr:tournament:16", {
  waitUntil: "networkidle",
  timeout: 45_000,
});
await page.waitForTimeout(4000);

const rows = await page.locator(".m-table-row.match-row").all();
const rowText = await rows[5].textContent();
console.log("clicking:", rowText.slice(0, 60));
const teamsEl = rows[5].locator(".teams, .home-team, .away-team").first();
await teamsEl.click();
await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(3000);
console.log("URL:", page.url());

const headers = await page.evaluate(() => {
  const detail = document.querySelector(".m-detail-wrapper");
  if (!detail) return [];
  const blocks = Array.from(detail.children);
  return blocks
    .map((b) => b.querySelector(".m-table-header-title"))
    .filter(Boolean)
    .map((h) => h.textContent.trim());
});
const asianRelated = headers.filter((h) => /asian|2 goals|two goals/i.test(h));
console.log("HEADERS COUNT:", headers.length, "ASIAN-RELATED:", JSON.stringify(asianRelated, null, 1));

await browser.close();
