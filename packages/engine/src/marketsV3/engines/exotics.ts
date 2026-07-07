/** §3.8 — exotics engine (Correct Score, HT/FT, combos) — Class X.
 *
 *  All derivable as grid cells (CS), products of half-grids (HT/FT), or joint
 *  events (1X2 & O/U, DC & GG/NG) — computed JOINTLY on the grid, never by
 *  multiplying marginals as if independent (result and totals are correlated
 *  by construction; the grid encodes it). Every candidate here carries the
 *  −5 class penalty (applied by the orchestrator via classifyMarket → "X"). */

import type { Matrix } from "../../types.js";
import type { V3Route } from "../feedDictionary.js";
import { sumWhere } from "../grid.js";
import type { V3EngineCtx, V3Price } from "./types.js";

/** "2-1" / "2:1" — correct score. */
function priceCorrectScore(mat: Matrix, d: string): V3Price | null {
  const m = d.match(/^(\d+)\s*[-:]\s*(\d+)$/);
  if (!m) return null;
  const h = Number.parseInt(m[1]!, 10);
  const a = Number.parseInt(m[2]!, 10);
  return { p: sumWhere(mat, (i, j) => i === h && j === a) };
}

/** "Home/Home" / "Draw/Away" — HT/FT, genuinely joint: iterate every
 *  (1H score, 2H score) pair, classify HT from the 1H cell and FT from the
 *  SUMMED score, and accumulate. This is the joint-on-grid requirement in
 *  practice — HT and FT are correlated (a 1H lead makes the same FT result
 *  more likely) because FT is literally composed from 1H + 2H, not multiplied
 *  as independent marginals. */
function priceHtFt(ctx: V3EngineCtx, d: string): V3Price | null {
  const m = d.match(/^(home|draw|away)\s*\/\s*(home|draw|away)$/);
  if (!m) return null;
  const ht = m[1] as "home" | "draw" | "away";
  const ft = m[2] as "home" | "draw" | "away";
  const half1 = ctx.halfStats[0];
  const half2 = ctx.halfStats[1];
  const matches = (side: "home" | "draw" | "away", h: number, a: number) =>
    side === "home" ? h > a : side === "draw" ? h === a : h < a;

  let p = 0;
  for (let i1 = 0; i1 < half1.length; i1++) {
    const row1 = half1[i1];
    if (!row1) continue;
    for (let j1 = 0; j1 < row1.length; j1++) {
      const p1 = row1[j1] ?? 0;
      if (!p1 || !matches(ht, i1, j1)) continue;
      for (let i2 = 0; i2 < half2.length; i2++) {
        const row2 = half2[i2];
        if (!row2) continue;
        for (let j2 = 0; j2 < row2.length; j2++) {
          const p2 = row2[j2] ?? 0;
          if (!p2) continue;
          if (matches(ft, i1 + i2, j1 + j2)) p += p1 * p2;
        }
      }
    }
  }
  return { p };
}

/** Exact goals (e.g., "2", "2-3 goals", "6+", "1-3+"). Match desc against
 *  grid cell counts, closed ranges, or open-ended tails.
 *
 *  BUG FIX: the previous regex never looked for a trailing "+", so any
 *  open-ended bucket ("6+" — catalog id 22 "Exact Goals"; "3+" — ids 23/24
 *  "Home/Away Team Exact Goals") silently fell through to the exact-match
 *  branch and priced P(total===N) instead of the intended P(total>=N) — a
 *  real, live mispricing on every N+ outcome routed here. */
function priceExactGoals(mat: Matrix, d: string): V3Price | null {
  // "2" → i+j === 2. "2-3 goals" → i+j in [2,3] (no end anchor — trailing
  // words like " goals" are ignored, same as before). "6+" → i+j >= 6.
  // Compound "1-3+"/"2-3+" (catalog ids 450002/450003 "Goal Bounds") read as
  // "N or more" — the trailing '+' on the upper end makes the whole bucket
  // open-ended, so the lower bound is the only one that constrains it.
  const m = d.match(/^(\d+)(?:\s*-\s*(\d+))?(\+)?/);
  if (!m) return null;
  const minGoals = Number.parseInt(m[1]!, 10);
  if (m[3] === "+") return { p: sumWhere(mat, (i, j) => i + j >= minGoals) };
  const maxGoals = m[2] ? Number.parseInt(m[2], 10) : minGoals;
  return { p: sumWhere(mat, (i, j) => i + j >= minGoals && i + j <= maxGoals) };
}

/** Multi-goals (e.g., "from=2|to=4" specifier). Same logic as exactGoals,
 *  but parsed from structured specifier rather than desc text. */
function priceMultigoals(
  mat: Matrix,
  from: number | undefined,
  to: number | undefined
): V3Price | null {
  if (from === undefined && to === undefined) return null;
  const minGoals = from ?? 0;
  const maxGoals = to ?? 20; // reasonable upper bound
  return { p: sumWhere(mat, (i, j) => i + j >= minGoals && i + j <= maxGoals) };
}

/** "1X2 & O/U" combos ("Home & Over 1.5"), "1X2 & GG/NG" ("Home & yes"),
 *  "O/U & GG/NG" ("Over 2.5 & Yes") — joint cell sums on the SAME grid so the
 *  correlation between result and goals is preserved. */
function priceCombo(mat: Matrix, marketName: string, d: string): V3Price | null {
  const parts = d.split("&").map((s) => s.trim());
  if (parts.length !== 2) return null;
  const [legA, legB] = parts as [string, string];

  const resultPred = (leg: string): ((h: number, a: number) => boolean) | null => {
    if (leg === "home") return (h, a) => h > a;
    if (leg === "draw") return (h, a) => h === a;
    if (leg === "away") return (h, a) => h < a;
    return null;
  };
  const ouPred = (leg: string): ((h: number, a: number) => boolean) | null => {
    const m = leg.match(/^(over|under)\s*([\d.]+)$/);
    if (!m) return null;
    const line = Number.parseFloat(m[2]!);
    return m[1] === "over" ? (h, a) => h + a > line : (h, a) => h + a < line;
  };
  const bttsPred = (leg: string): ((h: number, a: number) => boolean) | null => {
    if (leg === "yes") return (h, a) => h > 0 && a > 0;
    if (leg === "no") return (h, a) => !(h > 0 && a > 0);
    return null;
  };

  const nameLc = marketName.toLowerCase();
  let predA: ((h: number, a: number) => boolean) | null = null;
  let predB: ((h: number, a: number) => boolean) | null = null;
  if (nameLc.includes("1x2") && nameLc.includes("over/under")) {
    predA = resultPred(legA);
    predB = ouPred(legB);
  } else if (nameLc.includes("1x2") && (nameLc.includes("gg/ng") || nameLc.includes("btts"))) {
    predA = resultPred(legA);
    predB = bttsPred(legB);
  } else if (
    nameLc.includes("over/under") &&
    (nameLc.includes("gg/ng") || nameLc.includes("btts"))
  ) {
    predA = ouPred(legA);
    predB = bttsPred(legB);
  }
  if (!predA || !predB) return null;
  return { p: sumWhere(mat, (h, a) => predA(h, a) && predB(h, a)) };
}

export function priceExoticsOutcome(
  ctx: V3EngineCtx,
  route: V3Route,
  marketName: string,
  desc: string
): V3Price | null {
  const d = desc.toLowerCase().trim();
  switch (route.family) {
    case "correct_score":
      return priceCorrectScore(ctx.statsGrid, d);
    case "ht_ft":
      return priceHtFt(ctx, d);
    case "exact_goals":
      return priceExactGoals(ctx.statsGrid, d);
    case "multigoals":
      return priceMultigoals(ctx.statsGrid, route.from, route.to);
    case "combo":
      return priceCombo(ctx.statsGrid, marketName, d);
    default:
      return null;
  }
}
