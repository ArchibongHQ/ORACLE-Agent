/** §3.4 — result engine (DC, DNB, handicaps, winning margin) — STATS split.
 *
 *  Every price here is a cell sum over the stats-split grid (anti-circularity:
 *  anchoring result derivatives to the market's own 1X2 would zero their edge
 *  by construction). Plain 1X2 is never a candidate (routed out upstream).
 *
 *  Push handling: DNB and whole-ball AH return the conditional
 *  p′ = p_win / (1 − p_push); quarter-balls average the two adjacent lines. */

import type { V3Route } from "../feedDictionary.js";
import { resultProbs, winPushSplit } from "../grid.js";
import type { V3EngineCtx, V3Price } from "./types.js";

const result = (p: number, conditional = false): V3Price => ({
  p,
  conditional,
  resultClass: true,
});

/** Double Chance legs (3-way de-vig handled by the orchestrator). */
function priceDoubleChance(ctx: V3EngineCtx, d: string): V3Price | null {
  const { pHome, pDraw, pAway } = resultProbs(ctx.statsGrid);
  if (d === "home or draw" || d === "1x") return result(pHome + pDraw);
  if (d === "home or away" || d === "12") return result(pHome + pAway);
  if (d === "draw or away" || d === "x2") return result(pDraw + pAway);
  return null;
}

/** DNB family: "Draw No Bet" (draw void) + the "Home/Away No Bet" variants
 *  (that side void). Conditional on the voided outcome not happening. */
function priceNoBet(ctx: V3EngineCtx, name: string, d: string): V3Price | null {
  const { pHome, pDraw, pAway } = resultProbs(ctx.statsGrid);
  const cond = (num: number, denom: number): V3Price | null =>
    denom > 0 ? result(num / denom, true) : null;
  if (name.includes("draw no bet")) {
    if (d === "home") return cond(pHome, pHome + pAway);
    if (d === "away") return cond(pAway, pHome + pAway);
    return null;
  }
  if (name.includes("home no bet")) {
    if (d === "draw") return cond(pDraw, pDraw + pAway);
    if (d === "away") return cond(pAway, pDraw + pAway);
    return null;
  }
  if (name.includes("away no bet")) {
    if (d === "home") return cond(pHome, pHome + pDraw);
    if (d === "draw") return cond(pDraw, pHome + pDraw);
    return null;
  }
  return null;
}

/** One Asian line for one side; the outcome desc's own line wins over the
 *  routed specifier (each outcome row carries its line, e.g. "Home (-0.5)"). */
function asianLine(
  ctx: V3EngineCtx,
  side: "home" | "away",
  line: number
): { pWin: number; pPush: number } {
  return winPushSplit(ctx.statsGrid, (h, a) => (side === "home" ? h - a : a - h) + line);
}

function priceAsian(ctx: V3EngineCtx, side: "home" | "away", line: number): V3Price {
  const frac = Math.abs(line % 1);
  const isQuarter = Math.abs(frac - 0.25) < 1e-9 || Math.abs(frac - 0.75) < 1e-9;
  if (isQuarter) {
    // Quarter-ball = half stake on each adjacent line; price as their mean.
    const lo = priceAsian(ctx, side, line - 0.25);
    const hi = priceAsian(ctx, side, line + 0.25);
    return result((lo.p + hi.p) / 2, lo.conditional || hi.conditional);
  }
  const { pWin, pPush } = asianLine(ctx, side, line);
  if (Number.isInteger(line)) {
    const denom = 1 - pPush;
    return result(denom > 0 ? pWin / denom : 0, true);
  }
  return result(pWin); // half-ball: no push possible
}

/** "Home (-0.5)" / "Away (+1.0)" / "Home -1.5". */
function parseAsianDesc(d: string): { side: "home" | "away"; line: number } | null {
  const m = d.match(/^(home|away)\s*\(?\s*([+-]?[\d.]+)\s*\)?$/);
  if (!m) return null;
  const line = Number.parseFloat(m[2]!);
  if (!Number.isFinite(line)) return null;
  return { side: m[1] as "home" | "away", line };
}

/** European handicap "Home (0:1)": shift the grid by the head start and read
 *  1X2 off the shifted margin (§3.4). 3-way de-vig upstream. */
function priceEuropean(ctx: V3EngineCtx, d: string, hcpScore?: [number, number]): V3Price | null {
  const m = d.match(/^(home|draw|away)\s*(?:\((\d+)\s*:\s*(\d+)\))?$/);
  if (!m) return null;
  const outcome = m[1] as "home" | "draw" | "away";
  const h0 = m[2] !== undefined ? Number.parseInt(m[2], 10) : hcpScore?.[0];
  const a0 = m[3] !== undefined ? Number.parseInt(m[3], 10) : hcpScore?.[1];
  if (h0 === undefined || a0 === undefined) return null;
  const { pWin, pPush } = winPushSplit(ctx.statsGrid, (h, a) => h + h0 - (a + a0));
  if (outcome === "home") return result(pWin);
  if (outcome === "draw") return result(pPush);
  // away = 1 − home − draw over the shifted margin
  const { pWin: pAwayWin } = winPushSplit(ctx.statsGrid, (h, a) => a + a0 - (h + h0));
  if (outcome === "away") return result(pAwayWin);
  return null;
}

/** "Home by 1" / "Away by 3+" / "Draw". */
function priceWinningMargin(ctx: V3EngineCtx, d: string): V3Price | null {
  if (d === "draw" || d === "no goals" || d === "score draw") {
    const { pDraw } = resultProbs(ctx.statsGrid);
    return result(pDraw);
  }
  const m = d.match(/^(home|away)\s+by\s+(\d+)(\+)?$/);
  if (!m) return null;
  const side = m[1] as "home" | "away";
  const n = Number.parseInt(m[2]!, 10);
  const plus = m[3] === "+";
  const { pWin } = winPushSplit(ctx.statsGrid, (h, a) => {
    const margin = side === "home" ? h - a : a - h;
    return plus ? (margin >= n ? 1 : -1) : margin === n ? 1 : -1;
  });
  return result(pWin);
}

export function priceResultOutcome(
  ctx: V3EngineCtx,
  route: V3Route,
  marketName: string,
  desc: string
): V3Price | null {
  const name = marketName.toLowerCase();
  const d = desc.toLowerCase().trim();

  switch (route.family) {
    case "double_chance":
      return priceDoubleChance(ctx, d);
    case "dnb":
      return priceNoBet(ctx, name, d);
    case "asian_handicap": {
      const parsed = parseAsianDesc(d);
      if (parsed) return priceAsian(ctx, parsed.side, parsed.line);
      if (route.hcpNum !== undefined && (d === "home" || d === "away")) {
        // Line only in the specifier; sign convention: hcp applies to home.
        return priceAsian(ctx, d, d === "home" ? route.hcpNum : -route.hcpNum);
      }
      return null;
    }
    case "handicap":
      // European (score head start) when the specifier/desc carries h:a;
      // otherwise SportyBet's "Handicap" with numeric line = Asian semantics.
      if (route.hcpScore || /\(\d+\s*:\s*\d+\)/.test(d)) {
        return priceEuropean(ctx, d, route.hcpScore);
      }
      return priceResultOutcome(ctx, { ...route, family: "asian_handicap" }, marketName, desc);
    case "winning_margin":
      return priceWinningMargin(ctx, d);
    default:
      return null;
  }
}
