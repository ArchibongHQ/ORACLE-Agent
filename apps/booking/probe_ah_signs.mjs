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
const teamsEl = rows[5].locator(".teams, .home-team, .away-team").first();
await teamsEl.click();
await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(3000);
console.log("URL:", page.url());

const result = await page.evaluate(() => {
  const detail = document.querySelector(".m-detail-wrapper");
  const blocks = Array.from(detail.children);
  const out = [];
  for (const b of blocks) {
    const h = b.querySelector(".m-table-header-title");
    if (!h) continue;
    const text = h.textContent.trim();
    if (/^Asian Handicap/.test(text)) {
      const cells = Array.from(b.querySelectorAll(".m-table-cell"));
      const items = cells.map((c) =>
        Array.from(c.querySelectorAll(".m-table-cell-item")).map((i) => i.textContent.trim())
      );
      out.push({ header: text, items });
    }
  }
  return out;
});
console.log(JSON.stringify(result, null, 1));

await browser.close();
