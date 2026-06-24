import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  locale: "en-NG",
  timezoneId: "Africa/Lagos",
});
const page = await context.newPage();
await page.goto("https://www.sportybet.com/ng/sport/football", { waitUntil: "networkidle", timeout: 45_000 });
await page.waitForTimeout(5_000);

const result = await page.evaluate(() => {
  const row = document.querySelector(".m-table-row.match-row");
  const outcomes = Array.from(row.querySelectorAll(".m-outcome"));
  return outcomes.map((o) => {
    const oddsEl = o.querySelector(".m-outcome-odds");
    return {
      cls: o.className,
      text: (o.textContent || "").trim(),
      hasOddsEl: !!oddsEl,
      oddsElText: oddsEl ? oddsEl.textContent.trim() : null,
    };
  });
});
console.log(JSON.stringify(result, null, 1));

await browser.close();
