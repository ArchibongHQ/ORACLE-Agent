/** Reverse of bookAccumulator: load an existing SportyBet booking code → its fixture list.
 *  Mirrors tools/scrape_fixtures.py SportyBetScraper — intercepts the booking-detail XHR,
 *  falls back to DOM parsing. Selectors isolated here, like page.ts. Never throws. */

import type { Page, Response } from "playwright";
import { chromium } from "playwright";

/** One leg as it appears on the source punter's slip (raw, pre-analysis). */
export interface RawLeg {
  home: string;
  away: string;
  league: string;
  marketDesc: string; // SportyBet market description, e.g. "1X2", "Total - Over/Under"
  outcomeDesc: string; // selected outcome, e.g. "Home", "Over 2.5"
  odds: number;
}

export interface LoadedSlip {
  code: string;
  legs: RawLeg[];
  totalOdds: number;
  loadedAt: string;
  error?: string;
}

const SHARE_URL = (code: string) =>
  `https://www.sportybet.com/ng/?shareCode=${encodeURIComponent(code)}`;
const NAV_TIMEOUT = 45_000;

/** A SportyBet booking-detail response carries the selections. URL is on the confirmed
 *  /api/ng/ base (same as factsCenter/pcUpcomingEvents) and names an order/share/booking path.
 *  The exact path is undocumented (internal API); this matches the known convention. */
function isBookingDetailUrl(url: string): boolean {
  return /sportybet\.com\/api\/ng\//i.test(url) && /(orders?|share|booking|bet)/i.test(url);
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" ? (v as Obj) : null);
const str = (...vals: unknown[]): string => {
  for (const v of vals) if (v != null && v !== "") return String(v).trim();
  return "";
};
const num = (...vals: unknown[]): number => {
  for (const v of vals) {
    if (typeof v === "number" && v) return v;
    const n = parseFloat(String(v));
    if (n) return n;
  }
  return 0;
};

/** Pull the selected market/outcome out of an event node.
 *  SportyBet nests the chosen pick under markets[].outcomes[] (matching pcUpcomingEvents),
 *  or carries it flat on the event itself depending on the endpoint. */
function extractMarketOutcome(ev: Obj): { marketDesc: string; outcomeDesc: string; odds: number } {
  // Flat shape first (booking-detail "selection" rows).
  const flatMarket = str(ev.marketName, ev.marketDesc, ev.market);
  const flatOutcome = str(ev.outcomeDesc, ev.outcomeName, ev.outcome, ev.selection);
  const flatOdds = num(ev.odds, ev.oddsValue, ev.price);
  if (flatOutcome) return { marketDesc: flatMarket, outcomeDesc: flatOutcome, odds: flatOdds };

  // Nested markets[].outcomes[] — take the outcome flagged selected/picked.
  const markets = Array.isArray(ev.markets) ? (ev.markets as unknown[]) : [];
  for (const m of markets) {
    const mo = obj(m);
    if (!mo) continue;
    const outcomes = Array.isArray(mo.outcomes) ? (mo.outcomes as unknown[]) : [];
    for (const o of outcomes) {
      const oo = obj(o);
      if (!oo) continue;
      const picked = oo.isSelected === true || oo.selected === true || oo.picked === true;
      if (picked || outcomes.length === 1) {
        return {
          marketDesc: str(mo.marketName, mo.desc, mo.name),
          outcomeDesc: str(oo.outcomeDesc, oo.desc, oo.name),
          odds: num(oo.odds, oo.oddsValue, oo.price),
        };
      }
    }
  }
  return { marketDesc: flatMarket, outcomeDesc: flatOutcome, odds: flatOdds };
}

/** Build a RawLeg from any event-shaped node, or null if teams can't be read. */
function eventToLeg(node: unknown, league: string): RawLeg | null {
  const ev = obj(node);
  if (!ev) return null;
  const home = str(ev.homeTeamName, ev.home, ev.homeTeam);
  const away = str(ev.awayTeamName, ev.away, ev.awayTeam);
  if (!home || !away) return null;
  const lg = str(ev.tournamentName, ev.tournament, ev.categoryName, ev.sportName) || league;
  const { marketDesc, outcomeDesc, odds } = extractMarketOutcome(ev);
  return { home, away, league: lg, marketDesc, outcomeDesc, odds };
}

/** Best-effort extraction of legs from SportyBet's booking-detail JSON.
 *
 * Confirmed live shape (2026-06-08, /api/ng/orders/share/<CODE>):
 *   data.outcomes[]  — one entry per leg; each has homeTeamName, awayTeamName,
 *                      sport.category.tournament.name, and markets[].outcomes[]
 *   data.ticket.selections[] — parallel array with marketId + outcomeId to identify
 *                              which outcome was selected in each market
 *
 * Falls back to tournaments[].events[] and flat selections[]/events[] for other shapes.
 * totalOdds is not served by the API — computed as product of parsed leg odds.
 */
function parseBookingJson(json: unknown): { legs: RawLeg[]; totalOdds: number } | null {
  const data = obj((json as { data?: unknown })?.data) ?? obj(json);
  if (!data) return null;

  const legs: RawLeg[] = [];

  // Shape A — confirmed live: data.outcomes[] + data.ticket.selections[]
  // Build a fast lookup: eventId → { marketId, outcomeId } from ticket.selections
  const ticket = obj((data as { ticket?: unknown })?.ticket);
  const selections = Array.isArray(ticket?.selections) ? (ticket.selections as unknown[]) : [];
  const selMap = new Map<string, { marketId: string; outcomeId: string }>();
  for (const s of selections) {
    const so = obj(s);
    if (!so) continue;
    const eid = str(so.eventId);
    if (eid) selMap.set(eid, { marketId: str(so.marketId), outcomeId: str(so.outcomeId) });
  }

  const outcomes = Array.isArray(data.outcomes) ? (data.outcomes as unknown[]) : [];
  for (const node of outcomes) {
    const ev = obj(node);
    if (!ev) continue;
    const home = str(ev.homeTeamName, ev.home);
    const away = str(ev.awayTeamName, ev.away);
    if (!home || !away) continue;

    // League from sport.category.tournament.name
    const sport = obj(ev.sport);
    const category = obj(sport?.category);
    const tournament = obj(category?.tournament);
    const league =
      str(tournament?.name, category?.name, sport?.name, ev.tournamentName) || "Football";

    // Find the selected market+outcome using ticket.selections cross-ref
    const eid = str(ev.eventId);
    const sel = selMap.get(eid);
    const markets = Array.isArray(ev.markets) ? (ev.markets as unknown[]) : [];
    let marketDesc = "";
    let outcomeDesc = "";
    let odds = 0;

    if (sel) {
      for (const m of markets) {
        const mo = obj(m);
        if (!mo || str(mo.id) !== sel.marketId) continue;
        marketDesc = str(mo.desc, mo.name);
        const mOutcomes = Array.isArray(mo.outcomes) ? (mo.outcomes as unknown[]) : [];
        for (const o of mOutcomes) {
          const oo = obj(o);
          if (!oo || str(oo.id) !== sel.outcomeId) continue;
          outcomeDesc = str(oo.desc, oo.name);
          odds = num(oo.odds, oo.oddsValue);
          break;
        }
        break;
      }
    }

    // Fallback: take first market, first outcome if selection cross-ref failed
    if (!outcomeDesc && markets.length) {
      const { marketDesc: md, outcomeDesc: od, odds: o } = extractMarketOutcome(ev);
      marketDesc = md;
      outcomeDesc = od;
      odds = o;
    }

    legs.push({ home, away, league, marketDesc, outcomeDesc, odds });
  }

  // Shape B — tournaments[].events[] (factsCenter/pcUpcomingEvents style)
  if (!legs.length) {
    const order = obj((data as { order?: unknown })?.order) ?? data;
    const tournaments = Array.isArray(order.tournaments) ? (order.tournaments as unknown[]) : [];
    for (const t of tournaments) {
      const to = obj(t);
      if (!to) continue;
      const league = str(to.name, to.tournamentName) || "Football";
      const events = Array.isArray(to.events) ? (to.events as unknown[]) : [];
      for (const ev of events) {
        const leg = eventToLeg(ev, league);
        if (leg) legs.push(leg);
      }
    }
  }

  // Shape C — flat selections[] / events[]
  if (!legs.length) {
    const order = obj((data as { order?: unknown })?.order) ?? data;
    const flat =
      (Array.isArray(order.selections) && (order.selections as unknown[])) ||
      (Array.isArray(order.events) && (order.events as unknown[])) ||
      [];
    for (const node of flat) {
      const leg = eventToLeg(node, "Football");
      if (leg) legs.push(leg);
    }
  }

  if (!legs.length) return null;

  // totalOdds not served by API — compute as product of leg odds (rounded to 2dp)
  const totalOdds =
    legs.reduce((acc, l) => (l.odds > 0 ? acc * l.odds : acc), 1);

  return { legs, totalOdds: Math.round(totalOdds * 100) / 100 };
}

/** DOM fallback: read rendered betslip rows when the JSON shape can't be captured. */
async function parseFromDom(page: Page): Promise<{ legs: RawLeg[]; totalOdds: number }> {
  return page.evaluate(() => {
    const out: {
      home: string;
      away: string;
      league: string;
      marketDesc: string;
      outcomeDesc: string;
      odds: number;
    }[] = [];
    const rows = Array.from(
      document.querySelectorAll(
        '.m-table-row.match-row, .booking-detail-item, [class*="selection-item"]'
      )
    );
    for (const row of rows) {
      const text = (row.textContent || "").trim();
      // Team line usually "Home vs Away" or "Home - Away"
      const teamMatch = text.match(/(.+?)\s+(?:vs|v|-)\s+(.+?)(?:\s{2,}|$)/i);
      const oddsMatch = text.match(/(\d+\.\d{2})/);
      if (!teamMatch) continue;
      out.push({
        home: (teamMatch[1] || "").trim(),
        away: (teamMatch[2] || "").trim(),
        league: "Football",
        marketDesc: "",
        outcomeDesc: "",
        odds: oddsMatch ? parseFloat(oddsMatch[1] || "0") : 0,
      });
    }
    const totalEl = document.querySelector('.m-booking-code-body, [class*="total-odds"]');
    const tm = (totalEl?.textContent || "").match(/Odds\s+([\d.]+)/i);
    return { legs: out, totalOdds: tm ? parseFloat(tm[1] || "0") : 0 };
  });
}

/** Load a SportyBet booking code and return its fixture list. Never throws — error in-band. */
export async function loadBookingCode(code: string): Promise<LoadedSlip> {
  const loadedAt = new Date().toISOString();
  const empty: LoadedSlip = { code, legs: [], totalOdds: 0, loadedAt };
  if (!code || !/^[A-Za-z0-9]{4,16}$/.test(code.trim())) {
    return { ...empty, error: `invalid booking code: "${code}"` };
  }
  const clean = code.trim();

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      locale: "en-NG",
      timezoneId: "Africa/Lagos",
    });
    const page = await context.newPage();

    // Capture every booking-detail JSON the page fetches while resolving the share code.
    const captured: { legs: RawLeg[]; totalOdds: number }[] = [];
    page.on("response", (resp: Response) => {
      if (!isBookingDetailUrl(resp.url())) return;
      resp.json().then(
        (j) => {
          const parsed = parseBookingJson(j);
          if (parsed) captured.push(parsed);
        },
        () => {}
      );
    });

    await page.goto(SHARE_URL(clean), { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
    await page.waitForTimeout(4_000);

    // Prefer the richest captured payload (most legs).
    let best = captured.sort((a, b) => b.legs.length - a.legs.length)[0] ?? null;

    // DOM fallback if no JSON captured.
    if (!best || best.legs.length === 0) {
      const dom = await parseFromDom(page);
      if (dom.legs.length) best = dom;
    }

    if (!best || best.legs.length === 0) {
      return { ...empty, error: "no legs parsed from booking code (API + DOM both empty)" };
    }

    return { code: clean, legs: best.legs, totalOdds: best.totalOdds, loadedAt };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await browser.close();
  }
}
