import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  locale: "en-NG",
  timezoneId: "Africa/Lagos",
});
const page = await context.newPage();
await page.goto(
  "https://www.sportybet.com/ng/sport/football/England/Premier_League/Arsenal_vs_Coventry_City/sr:match:72221154",
  { waitUntil: "networkidle", timeout: 45_000 }
);
await page.waitForTimeout(5_000);

// Find GG/NG block, click "Yes" cell
const clicked = await page.evaluate(() => {
  const detail = document.querySelector(".m-detail-wrapper");
  const blocks = Array.from(detail.children);
  for (const b of blocks) {
    const h = b.querySelector(".m-table-header-title");
    if (!h || h.textContent.trim() !== "GG/NG") continue;
    const cells = Array.from(b.querySelectorAll(".m-table-cell"));
    for (const cell of cells) {
      const items = Array.from(cell.querySelectorAll(".m-table-cell-item"));
      const label = items[0]?.textContent.trim();
      if (label === "Yes") {
        cell.click();
        return { clicked: true, label, odds: items[1]?.textContent.trim() };
      }
    }
  }
  return { clicked: false };
});
console.log("click result", clicked);

await page.waitForTimeout(2_000);

// check betslip count / content
const betslip = await page.evaluate(() => {
  const slipEls = Array.from(document.querySelectorAll('[class*="bet-slip"], [class*="betslip"], [class*="m-coupon"]'));
  return slipEls.slice(0, 5).map((e) => ({ cls: e.className, text: (e.textContent || "").slice(0, 200) }));
});
console.log("betslip elements:", JSON.stringify(betslip, null, 1));

await browser.close();
