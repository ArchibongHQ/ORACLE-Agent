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

const result = await page.evaluate(() => {
  const detail = document.querySelector(".m-detail-wrapper");
  const blocks = Array.from(detail.children);
  const out = [];
  for (const b of blocks) {
    const h = b.querySelector(".m-table-header-title");
    if (!h) continue;
    const text = (h.textContent || "").trim();
    if (
      text === "Over/Under" ||
      text === "GG/NG" ||
      text === "Double Chance" ||
      text === "Draw No Bet" ||
      /^Asian Handicap/.test(text) ||
      text === "Arsenal Over/Under" ||
      text === "Home Team to Win Either Half" ||
      text === "Away Team to Win Either Half" ||
      text === "1st Half - 1X2" ||
      text === "1st Half - Over/Under"
    ) {
      const outcomeEls = Array.from(b.querySelectorAll(".m-outcome"));
      const outcomes = outcomeEls.map((o) => {
        const items = Array.from(o.querySelectorAll(".m-table-cell-item")).map((i) =>
          i.textContent.trim()
        );
        return items;
      });
      out.push({ text, outcomeCount: outcomeEls.length, outcomes });
    }
  }
  return out;
});
console.log(JSON.stringify(result, null, 1));

await browser.close();
