import { chromium } from "playwright";
import { addLegToBetslip } from "./dist/page.js";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  locale: "en-NG",
  timezoneId: "Africa/Lagos",
});
const page = await context.newPage();

// Discover current live fixtures from the listing page first.
await page.goto("https://www.sportybet.com/ng/sport/football", {
  waitUntil: "networkidle",
  timeout: 45_000,
});
await page.waitForTimeout(5_000);

const fixtures = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll(".m-table-row.match-row")).slice(0, 10);
  return rows.map((row) => {
    const teamEls = Array.from(row.querySelectorAll(".home-team, .away-team"));
    return { home: teamEls[0]?.textContent.trim(), away: teamEls[1]?.textContent.trim() };
  });
});
console.log("Fixtures:", fixtures.map((f) => `${f.home} vs ${f.away}`).join(" | "));

const f = (i) => ({ home: fixtures[i].home, away: fixtures[i].away });
const basePick = (overrides) => ({
  league: "Premier League",
  kickoff: new Date().toISOString(),
  odds: 1.5,
  stakePct: 1,
  confidence: 0.6,
  ...overrides,
});

const picks = [
  { name: "1X2 (regression)", pick: basePick({ ...f(0), market: "1X2", side: "Home" }) },
  { name: "Goals O/U 2.5", pick: basePick({ ...f(1), market: "Goals O/U", side: "Over 2.5" }) },
  { name: "BTTS Yes", pick: basePick({ ...f(2), market: "BTTS", side: "Yes" }) },
  { name: "Double Chance 1X", pick: basePick({ ...f(3), market: "Double Chance", side: "1X" }) },
  {
    name: "Asian Handicap Home -0.5",
    pick: basePick({ ...f(4), market: "Asian Handicap", side: "Home -0.5" }),
  },
  {
    name: "Team Total (Home) Over 0.5",
    pick: basePick({ ...f(5), market: "Team Total", side: "Home Total Over 0.5" }),
  },
  {
    name: "Win Either Half (Home)",
    pick: basePick({ ...f(6), market: "Win Either Half", side: "Win Either Half (H)" }),
  },
  {
    name: "First Half O/U 0.5",
    pick: basePick({ ...f(7), market: "First Half", side: "FH Over 0.5 Goals" }),
  },
];

const results = [];
for (const { name, pick } of picks) {
  console.log(`\n--- Testing: ${name} (${pick.home} vs ${pick.away}) ---`);
  try {
    const result = await addLegToBetslip(page, pick);
    console.log("Result:", JSON.stringify(result));
    results.push({ name, ...pick, result });
  } catch (err) {
    console.log("ERROR:", err.message);
    results.push({ name, error: err.message });
  }
}

console.log("\n\n=== SUMMARY ===");
for (const r of results) {
  console.log(`${r.name}: ${r.result ? `OK -> ${JSON.stringify(r.result)}` : r.error ? `EXCEPTION ${r.error}` : "NULL (unmatched)"}`);
}

// Check final betslip leg count
const finalCount = await page.evaluate(() => {
  const text = document.querySelector(".tabs-v2.betslip-tabs")?.textContent || "";
  return text.trim();
});
console.log("\nFinal betslip tab text:", finalCount);

await browser.close();
