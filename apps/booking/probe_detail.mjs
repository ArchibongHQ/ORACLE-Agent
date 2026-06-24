import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  locale: "en-NG",
  timezoneId: "Africa/Lagos",
});
const page = await context.newPage();
await page.goto("https://www.sportybet.com/ng/sport/football", {
  waitUntil: "networkidle",
  timeout: 45_000,
});
await page.waitForTimeout(5_000);

const rows = await page.locator(".m-table-row.match-row").all();
console.log("row count", rows.length);
const row = rows[0];
const rowText = await row.textContent();
console.log("clicking row:", rowText.slice(0, 80));

const teamsEl = row.locator(".teams, .home-team, .away-team").first();
await teamsEl.click();
await page.waitForTimeout(4_000);
await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(2_000);

console.log("URL after click:", page.url());

const headers = await page.evaluate(() => {
  const detail = document.querySelector(".m-detail-wrapper");
  if (!detail) return { error: "no .m-detail-wrapper found" };
  const blocks = Array.from(detail.children);
  return blocks.map((b, i) => {
    const h = b.querySelector(".m-table-header-title");
    return { i, header: h ? h.textContent.trim() : null, className: b.className };
  });
});
console.log("ALL BLOCKS:\n", JSON.stringify(headers, null, 1));

await browser.close();
