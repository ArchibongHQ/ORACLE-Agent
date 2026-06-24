import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  locale: "en-NG",
  timezoneId: "Africa/Lagos",
});
const page = await context.newPage();

// Leg 1: go to listing, click 1X2 home on first row
await page.goto("https://www.sportybet.com/ng/sport/football", { waitUntil: "networkidle", timeout: 45_000 });
await page.waitForTimeout(5_000);
let rows = await page.locator(".m-table-row.match-row").all();
const row1Text = await rows[0].textContent();
console.log("Leg1 row:", row1Text.slice(0, 60));
const outcomes1 = await rows[0].locator(".m-outcome").all();
await outcomes1[0].click();
await page.waitForTimeout(1500);

// Leg 2: navigate again to listing (simulating fixed addLegToBetslip behavior), find 2nd fixture, go to detail, pick GG/NG Yes
await page.goto("https://www.sportybet.com/ng/sport/football", { waitUntil: "networkidle", timeout: 45_000 });
await page.waitForTimeout(5_000);
rows = await page.locator(".m-table-row.match-row").all();
const row2Text = await rows[1].textContent();
console.log("Leg2 row:", row2Text.slice(0, 60));
const teamsEl = rows[1].locator(".teams, .home-team, .away-team").first();
await teamsEl.click();
await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(3000);
console.log("Leg2 URL:", page.url());

const clicked2 = await page.evaluate(() => {
  const detail = document.querySelector(".m-detail-wrapper");
  const blocks = Array.from(detail.children);
  for (const b of blocks) {
    const h = b.querySelector(".m-table-header-title");
    if (!h || h.textContent.trim() !== "GG/NG") continue;
    const cells = Array.from(b.querySelectorAll(".m-table-cell"));
    for (const cell of cells) {
      const items = Array.from(cell.querySelectorAll(".m-table-cell-item"));
      if (items[0]?.textContent.trim() === "Yes") {
        cell.click();
        return { label: items[0].textContent.trim(), odds: items[1].textContent.trim() };
      }
    }
  }
  return null;
});
console.log("Leg2 click:", clicked2);
await page.waitForTimeout(2000);

// Check betslip count
const slipCount = await page.evaluate(() => {
  const tab = document.querySelector(".m-betslip-text")?.parentElement;
  const text = document.querySelector(".tabs-v2.betslip-tabs")?.textContent || "";
  return text.trim().slice(0, 50);
});
console.log("Betslip tab text:", slipCount);

await browser.close();
