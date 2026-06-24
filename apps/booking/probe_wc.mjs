import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  locale: "en-NG",
  timezoneId: "Africa/Lagos",
});
const page = await context.newPage();

await page.goto("https://www.sportybet.com/ng/sport/football/World", { waitUntil: "networkidle", timeout: 45_000 }).catch(() => {});
await page.waitForTimeout(3000);
console.log("Tried /World, URL:", page.url());

// Fallback: use the listing page and click the World Cup league filter link if present
await page.goto("https://www.sportybet.com/ng/sport/football", { waitUntil: "networkidle", timeout: 45_000 });
await page.waitForTimeout(4000);

const wcLink = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll("a, div, span"));
  const el = els.find((e) => (e.textContent || "").trim() === "World Cup");
  if (!el) return null;
  el.scrollIntoView();
  return true;
});
console.log("found World Cup label:", wcLink);

if (wcLink) {
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("a, div, span"));
    const el = els.find((e) => (e.textContent || "").trim() === "World Cup");
    el?.click();
  });
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

console.log("URL after WC click:", page.url());
const rows = await page.locator(".m-table-row.match-row").all();
console.log("rows after filter:", rows.length);
if (rows.length) {
  const t = await rows[0].textContent();
  console.log("first row:", t.slice(0, 80));
}

await browser.close();
