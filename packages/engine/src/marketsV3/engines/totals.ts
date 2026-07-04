/** §3.3 — totals engine (full-match O/U ladder, any line; odd/even).
 *
 *  Half-lines are exact Poisson tails off the grid. Whole lines (push
 *  possible) return the CONDITIONAL p′ = p_win / (1 − p_push), compared
 *  downstream against the de-vigged two-way price (which is itself priced
 *  around the push). Totals are split-invariant, so the stats grid serves.
 *
 *  §0.3 (PR-4): the 1.5/2.5/3.5 lines each carry a season O/U hit-rate
 *  (ou{15,25,35}PctH/A). Totals stay MODEL-ONLY (no empirical blend, per the
 *  header above) — the rate's only role here is a data-quality flag
 *  (marketStatMissing, §5.3 −1) when it's absent for the priced line. Lines
 *  without a tracked hit-rate (0.5, 4.5, …) are never flagged — they never had
 *  this stat to begin with. */

import type { V3Route } from "../feedDictionary.js";
import { sumWhere } from "../grid.js";
import type { V3EngineCtx, V3Price } from "./types.js";

const OU_HIT_RATE_KEYS: Record<
  number,
  { h: keyof V3EngineCtx["empirical"]; a: keyof V3EngineCtx["empirical"] }
> = {
  1.5: { h: "ou15PctH", a: "ou15PctA" },
  2.5: { h: "ou25PctH", a: "ou25PctA" },
  3.5: { h: "ou35PctH", a: "ou35PctA" },
};

function ouHitRateMissing(empirical: V3EngineCtx["empirical"], line: number): boolean {
  const keys = OU_HIT_RATE_KEYS[line];
  if (!keys) return false;
  return empirical[keys.h] === undefined || empirical[keys.a] === undefined;
}

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
  ctx: Pick<V3EngineCtx, "statsGrid" | "empirical">,
  parsed: ParsedOU,
  count: (home: number, away: number) => number = (h, a) => h + a
): V3Price {
  const { side, line } = parsed;
  const isWholeLine = Number.isInteger(line);
  const marketStatMissing = ouHitRateMissing(ctx.empirical, line);
  const pWin = sumWhere(ctx.statsGrid, (h, a) =>
    side === "over" ? count(h, a) > line : count(h, a) < line
  );
  if (!isWholeLine) return { p: pWin, marketStatMissing };
  const pPush = sumWhere(ctx.statsGrid, (h, a) => count(h, a) === line);
  const denom = 1 - pPush;
  return { p: denom > 0 ? pWin / denom : 0, conditional: true, marketStatMissing };
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
