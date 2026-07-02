/** §3.3 — totals engine (full-match O/U ladder, any line; odd/even).
 *
 *  Half-lines are exact Poisson tails off the grid. Whole lines (push
 *  possible) return the CONDITIONAL p′ = p_win / (1 − p_push), compared
 *  downstream against the de-vigged two-way price (which is itself priced
 *  around the push). Totals are split-invariant, so the stats grid serves. */

import type { V3Route } from "../feedDictionary.js";
import { sumWhere } from "../grid.js";
import type { V3EngineCtx, V3Price } from "./types.js";

export interface ParsedOU {
  side: "over" | "under";
  line: number;
}

/** Parse "Over 2.5" / "under 3" — line falls back to the routed `total=`. */
export function parseOUDesc(desc: string, routedTotal?: number): ParsedOU | null {
  const m = desc.match(/^(over|under)\s*([\d.]+)?$/i);
  if (!m) return null;
  const side = m[1]!.toLowerCase() as "over" | "under";
  const line = m[2] !== undefined ? Number.parseFloat(m[2]) : routedTotal;
  if (line === undefined || !Number.isFinite(line)) return null;
  return { side, line };
}

/** Price a total-goals condition with push handling. `count` maps a grid cell
 *  to the counted quantity (default: total goals). */
export function priceOU(
  ctx: Pick<V3EngineCtx, "statsGrid">,
  parsed: ParsedOU,
  count: (home: number, away: number) => number = (h, a) => h + a
): V3Price {
  const { side, line } = parsed;
  const isWholeLine = Number.isInteger(line);
  const pWin = sumWhere(ctx.statsGrid, (h, a) =>
    side === "over" ? count(h, a) > line : count(h, a) < line
  );
  if (!isWholeLine) return { p: pWin };
  const pPush = sumWhere(ctx.statsGrid, (h, a) => count(h, a) === line);
  const denom = 1 - pPush;
  return { p: denom > 0 ? pWin / denom : 0, conditional: true };
}

export function priceTotalsOutcome(ctx: V3EngineCtx, route: V3Route, desc: string): V3Price | null {
  const d = desc.toLowerCase().trim();
  if (route.family === "odd_even") {
    if (d === "odd") return { p: sumWhere(ctx.statsGrid, (h, a) => (h + a) % 2 === 1) };
    if (d === "even") return { p: sumWhere(ctx.statsGrid, (h, a) => (h + a) % 2 === 0) };
    return null;
  }
  const parsed = parseOUDesc(d, route.total);
  if (!parsed) return null;
  return priceOU(ctx, parsed);
}
