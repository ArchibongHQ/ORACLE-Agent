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

const rows = await page.evaluate(() => {
  const rowEls = Array.from(document.querySelectorAll(".m-table-row.match-row")).slice(0, 8);
  return rowEls.map((row) => {
    const teamsEl = row.querySelector(".teams, .home-team, .away-team");
    const text = (row.textContent || "").replace(/\s+/g, " ").trim().slice(0, 150);
    const link = row.querySelector("a")?.getAttribute("href") || null;
    return { text, link };
  });
});
console.log("LISTING ROWS:\n", JSON.stringify(rows, null, 1));

await browser.close();
