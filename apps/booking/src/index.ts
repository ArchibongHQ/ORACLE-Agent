/** @oracle/booking — anonymous SportyBet accumulator booking agent.
 *  No login, no stake, no real money. Generates a shareable booking code only.
 *
 *  API-first approach: calls SportyBet's internal REST API directly to resolve
 *  market/outcome IDs and POST to /orders/share. No Playwright DOM clicking
 *  needed for the booking step — Playwright is only used by loadCode.ts. */

import type { ActionablePick } from "@oracle/notify";
import { mapMarket, normalise } from "./marketMap.js";

export type { LoadedSlip, RawLeg } from "./loadCode.js";
export { loadBookingCode } from "./loadCode.js";

const API_BASE = "https://www.sportybet.com/api/ng";
const SHARE_URL = `${API_BASE}/orders/share`;
const EVENT_URL = (eventId: string) =>
  `${API_BASE}/factsCenter/event?eventId=${encodeURIComponent(eventId)}&productId=3&_t=${Date.now()}`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Content-Type": "application/json",
  Origin: "https://www.sportybet.com",
  Referer: "https://www.sportybet.com/ng/",
};

const FETCH_TIMEOUT_MS = 15_000;

function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

export interface BookedLeg {
  pick: ActionablePick;
  selectionLabel: string;
  odds: string;
}

export interface BookingResult {
  code: string | null;
  loadUrl: string | null;
  totalOdds: number;
  bookedLegs: BookedLeg[];
  unmatched: ActionablePick[];
  bookedAt: string;
  error?: string;
}

interface SportyBetOutcome {
  id: string;
  desc?: string | null;
  odds?: string | null;
}

interface SportyBetMarket {
  id: string;
  name?: string | null;
  desc?: string | null;
  specifier?: string | null;
  outcomes?: SportyBetOutcome[];
}

interface SportyBetEventData {
  eventId: string;
  gameId: string | number;
  sportId?: string;
  estimateStartTime?: number;
  markets?: SportyBetMarket[];
}

/** Fetch the SportyBet event data for one pick's eventId. Returns null on any error. */
async function fetchEventData(eventId: string): Promise<SportyBetEventData | null> {
  try {
    const res = await fetchWithTimeout(EVENT_URL(eventId), { headers: HEADERS });
    if (!res.ok) return null;
    const json = (await res.json()) as { bizCode?: number; data?: SportyBetEventData };
    if (json.bizCode !== 10000 || !json.data) return null;
    return json.data;
  } catch {
    return null;
  }
}

/** Match an ORACLE (market, side) pair to a SportyBet market+outcome using the
 *  event's market list. Returns null when no matching market/outcome is found. */
function resolveSelection(
  eventData: SportyBetEventData,
  pick: ActionablePick
): { marketId: string; specifier: string; outcomeId: string; odds: number; label: string } | null {
  const mapping = mapMarket(pick.market, pick.side);
  if (!mapping) return null;

  const { sportyMarket, sportySelection } = mapping;
  const markets = eventData.markets ?? [];

  // Normalise for fuzzy matching
  const normSel = normalise(sportySelection);

  for (const mkt of markets) {
    const mktName = normalise(mkt.name ?? mkt.desc ?? "");
    const normSportyMarket = normalise(sportyMarket);

    // Header match: must contain the mapped market name
    if (!mktName.includes(normSportyMarket) && !normSportyMarket.includes(mktName)) continue;

    for (const outcome of mkt.outcomes ?? []) {
      const outNorm = normalise(outcome.desc ?? "");
      if (outNorm === normSel || outNorm.includes(normSel) || normSel.includes(outNorm)) {
        const odds = parseFloat(outcome.odds ?? "0");
        if (odds <= 1) continue; // suspended or invalid
        return {
          marketId: mkt.id,
          specifier: mkt.specifier ?? "",
          outcomeId: outcome.id,
          odds,
          label: outcome.desc ?? sportySelection,
        };
      }
    }
  }
  return null;
}

/** Book all picks as a single accumulator on SportyBet (anonymous, no-stake).
 *  Uses the SportyBet REST API directly — no Playwright needed.
 *  Never throws — returns error in-band so it never blocks report delivery. */
export async function bookAccumulator(picks: ActionablePick[]): Promise<BookingResult> {
  const bookedAt = new Date().toISOString();
  const empty: BookingResult = {
    code: null,
    loadUrl: null,
    totalOdds: 0,
    bookedLegs: [],
    unmatched: [...picks],
    bookedAt,
  };

  if (!picks.length) return { ...empty, unmatched: [], error: "no actionable picks to book" };

  const bookedLegs: BookedLeg[] = [];
  const unmatched: ActionablePick[] = [];
  const selections: Array<{
    eventId: string;
    gameId: string;
    marketId: string;
    specifier: string;
    outcomeId: string;
    odds: number;
  }> = [];

  for (const pick of picks) {
    if (!pick.eventId) {
      process.stderr.write(`[booking] no eventId for ${pick.home} vs ${pick.away} — skipping\n`);
      unmatched.push(pick);
      continue;
    }

    const eventData = await fetchEventData(pick.eventId);
    if (!eventData) {
      process.stderr.write(
        `[booking] could not fetch event data for ${pick.home} vs ${pick.away} (${pick.eventId})\n`
      );
      unmatched.push(pick);
      continue;
    }

    const sel = resolveSelection(eventData, pick);
    if (!sel) {
      process.stderr.write(
        `[booking] no market match for ${pick.home} vs ${pick.away}: ${pick.market} / ${pick.side ?? ""}\n`
      );
      unmatched.push(pick);
      continue;
    }

    bookedLegs.push({ pick, selectionLabel: sel.label, odds: String(sel.odds) });
    selections.push({
      eventId: pick.eventId,
      gameId: String(eventData.gameId),
      marketId: sel.marketId,
      specifier: sel.specifier,
      outcomeId: sel.outcomeId,
      odds: sel.odds,
    });
  }

  if (!bookedLegs.length) {
    return { ...empty, unmatched, error: "no picks could be mapped to SportyBet selections" };
  }

  try {
    const res = await fetchWithTimeout(SHARE_URL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ selections }),
    });
    const json = (await res.json()) as {
      bizCode?: number;
      message?: string;
      data?: { shareCode?: string; shareURL?: string };
    };

    if (json.bizCode !== 10000 || !json.data?.shareCode) {
      return {
        ...empty,
        bookedLegs,
        unmatched,
        error: json.message ?? "share API returned no code",
      };
    }

    const code = json.data.shareCode;
    const loadUrl = json.data.shareURL ?? `https://www.sportybet.com/ng/?shareCode=${code}`;
    const totalOdds = selections.reduce((acc, s) => acc * s.odds, 1);

    process.stdout.write(
      `[booking] code=${code} legs=${bookedLegs.length} odds=${totalOdds.toFixed(2)}\n`
    );
    return { code, loadUrl, totalOdds, bookedLegs, unmatched, bookedAt };
  } catch (err) {
    return {
      ...empty,
      bookedLegs,
      unmatched,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
