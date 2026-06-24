/**
 * Verification probe: tests the booking fix against live SportyBet.
 * Uses fixtures from today's scraped sidecar to build realistic picks.
 * Run: node probe_fix_verify.mjs
 */
import { readFileSync } from "fs";
import { chromium } from "playwright";
import { addLegToBetslip } from "./dist/page.js";

const SIDECAR = "../../.tmp/fixtures/sportybet_today.json";
const sidecar = JSON.parse(readFileSync(new URL(SIDECAR, import.meta.url)));
const events = sidecar.events ?? [];

// Pick a fixture that has BTTS, DC, and O/U data
function pickFixtureWith(fields) {
  return events.find((ev) => {
    const o = ev.odds ?? {};
    return fields.every((f) => {
      if (f === "btts") return o.btts?.yes || o.btts?.no;
      if (f === "dc") return o.dc?.["1x"] || o.dc?.["12"];
      if (f === "ou25") return o.ou25?.over;
      if (f === "tt_home") return o.tt_home_05?.over;
      if (f === "weh") return o.half?.win_either_half?.home?.yes;
      if (f === "1x2") return o["1x2"]?.home;
      return false;
    });
  });
}

// Build test picks covering all major markets
function buildPicks(ev) {
  if (!ev) return [];
  const o = ev.odds ?? {};
  const picks = [];

  // 1X2 (control — was already working)
  if (o["1x2"]?.home) {
    picks.push({ market: "1X2", side: "Home Win", home: ev.home, away: ev.away, odds: o["1x2"].home, fixture: ev.home + " vs " + ev.away });
  }

  // Goals O/U
  if (o.ou25?.over) {
    picks.push({ market: "Goals O/U", side: "Over 2.5", home: ev.home, away: ev.away, odds: o.ou25.over, fixture: ev.home + " vs " + ev.away });
  }

  // BTTS
  if (o.btts?.yes) {
    picks.push({ market: "BTTS", side: "Yes", home: ev.home, away: ev.away, odds: o.btts.yes, fixture: ev.home + " vs " + ev.away });
  }

  // Double Chance
  if (o.dc?.["1x"]) {
    picks.push({ market: "Double Chance", side: "1X", home: ev.home, away: ev.away, odds: o.dc["1x"], fixture: ev.home + " vs " + ev.away });
  }

  // Team Total
  if (o.tt_home_05?.over) {
    picks.push({ market: "Team Total", side: "Home Total Over 0.5", home: ev.home, away: ev.away, odds: o.tt_home_05.over, fixture: ev.home + " vs " + ev.away });
  }

  // Win Either Half
  if (o.half?.win_either_half?.home?.yes) {
    picks.push({ market: "Win Either Half", side: "Win Either Half (H)", home: ev.home, away: ev.away, odds: o.half.win_either_half.home.yes, fixture: ev.home + " vs " + ev.away });
  }

  // Draw No Bet
  if (o.dnb?.home) {
    picks.push({ market: "Draw No Bet", side: "Home", home: ev.home, away: ev.away, odds: o.dnb.home, fixture: ev.home + " vs " + ev.away });
  }

  return picks;
}

// Use a fixture with broad market coverage
const testFix = pickFixtureWith(["1x2", "ou25", "btts", "dc", "weh"]) ?? events[0];
console.log(`\n[verify] Test fixture: ${testFix?.home} vs ${testFix?.away} (${testFix?.league})`);
const testPicks = buildPicks(testFix);
console.log(`[verify] Testing ${testPicks.length} market picks:\n`);
testPicks.forEach((p, i) => console.log(`  ${i + 1}. ${p.market} | ${p.side}`));

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  locale: "en-NG",
  timezoneId: "Africa/Lagos",
});
const page = await ctx.newPage();

const results = [];

for (const pick of testPicks) {
  console.log(`\n[verify] Testing: ${pick.market} | ${pick.side}`);
  try {
    const result = await addLegToBetslip(page, pick);
    if (result) {
      console.log(`  ✅ PASS — label="${result.selectionLabel}" odds="${result.odds}"`);
      results.push({ market: pick.market, side: pick.side, status: "PASS", ...result });
    } else {
      console.log(`  ❌ FAIL — returned null`);
      results.push({ market: pick.market, side: pick.side, status: "FAIL" });
    }
  } catch (err) {
    console.log(`  💥 ERROR — ${err.message}`);
    results.push({ market: pick.market, side: pick.side, status: "ERROR", error: err.message });
  }
}

await browser.close();

console.log("\n══════ SUMMARY ══════");
const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status !== "PASS").length;
console.log(`Passed: ${passed}/${results.length}  Failed: ${failed}/${results.length}`);
results.forEach((r) => {
  const icon = r.status === "PASS" ? "✅" : "❌";
  const detail = r.status === "PASS" ? `@ ${r.odds}` : r.error ?? "null returned";
  console.log(`  ${icon} ${r.market} | ${r.side} — ${detail}`);
});

if (failed > 0) process.exit(1);
