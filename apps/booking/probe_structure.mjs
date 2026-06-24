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
  for (const b of blocks) {
    const h = b.querySelector(".m-table-header-title");
    if (!h || h.textContent.trim() !== "GG/NG") continue;
    const outcome = b.querySelector(".m-outcome");
    // dump full HTML structure
    function describe(el, depth) {
      if (depth > 4) return null;
      const cls = el.className || "";
      const items = Array.from(el.children).map((c) => describe(c, depth + 1)).filter(Boolean);
      return { tag: el.tagName, cls, text: el.children.length === 0 ? el.textContent.trim() : undefined, children: items.length ? items : undefined };
    }
    return describe(outcome, 0);
  }
  return null;
});
console.log(JSON.stringify(result, null, 1));

await browser.close();
