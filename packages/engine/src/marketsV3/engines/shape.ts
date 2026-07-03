/** §3.5 — shape engine (BTTS, team totals, clean sheets, teams-to-score,
 *  win-to-nil) — ODDS-ANCHORED split.
 *
 *  Empirical blend where the sheet provides season BTTS%/CS%/FTS% hit-rates:
 *  P_final = 0.7·P_model + 0.3·P_empirical (§3.5 enhancement). Absent hit-rate
 *  ⇒ model-only, flagged marketStatMissing (§5.3 −1). */

import type { V3Route } from "../feedDictionary.js";
import { sumWhere } from "../grid.js";
import { blendEmpirical, type V3EngineCtx, type V3Price } from "./types.js";

function withBlend(model: number, empirical: number | undefined): V3Price {
  return {
    p: blendEmpirical(model, empirical),
    marketStatMissing: empirical === undefined,
  };
}

function priceBtts(ctx: V3EngineCtx, d: string): V3Price | null {
  const model = sumWhere(ctx.shapeGrid, (h, a) => h > 0 && a > 0);
  const empBoth =
    ctx.empirical.bttsPctH !== undefined && ctx.empirical.bttsPctA !== undefined
      ? (ctx.empirical.bttsPctH + ctx.empirical.bttsPctA) / 2
      : undefined;
  if (d === "yes") return withBlend(model, empBoth);
  if (d === "no") return withBlend(1 - model, empBoth === undefined ? undefined : 1 - empBoth);
  return null;
}

function priceTeamTotal(ctx: V3EngineCtx, side: "home" | "away", d: string): V3Price | null {
  const m = d.match(/^(over|under)\s*([\d.]+)?$/);
  if (!m) return null;
  const isOver = m[1] === "over";
  const line = m[2] !== undefined ? Number.parseFloat(m[2]) : undefined;
  if (line === undefined) return null;
  const pick = (h: number, a: number) => (side === "home" ? h : a);
  const isWholeLine = Number.isInteger(line);
  const pWin = sumWhere(ctx.shapeGrid, (h, a) => (isOver ? pick(h, a) > line : pick(h, a) < line));
  if (!isWholeLine) return { p: pWin };
  const pPush = sumWhere(ctx.shapeGrid, (h, a) => pick(h, a) === line);
  const denom = 1 - pPush;
  return { p: denom > 0 ? pWin / denom : 0, conditional: true };
}

function priceCleanSheet(ctx: V3EngineCtx, side: "home" | "away", d: string): V3Price | null {
  const model = sumWhere(ctx.shapeGrid, (h, a) => (side === "home" ? a === 0 : h === 0));
  const emp = side === "home" ? ctx.empirical.csPctH : ctx.empirical.csPctA;
  if (d === "yes") return withBlend(model, emp);
  if (d === "no") return withBlend(1 - model, emp === undefined ? undefined : 1 - emp);
  return null;
}

function priceWinToNil(ctx: V3EngineCtx, name: string, d: string): V3Price | null {
  const side: "home" | "away" | null = name.includes("home")
    ? "home"
    : name.includes("away")
      ? "away"
      : null;
  if (!side) return null;
  const model = sumWhere(ctx.shapeGrid, (h, a) =>
    side === "home" ? h > a && a === 0 : a > h && h === 0
  );
  if (d === "yes") return { p: model };
  if (d === "no") return { p: 1 - model };
  return null;
}

/** "Which Team To Score": None / Only Home / Only Away / Both teams. */
function priceWhichTeamScores(ctx: V3EngineCtx, d: string): V3Price | null {
  if (d === "none") return { p: sumWhere(ctx.shapeGrid, (h, a) => h === 0 && a === 0) };
  if (d === "only home") return { p: sumWhere(ctx.shapeGrid, (h, a) => h > 0 && a === 0) };
  if (d === "only away") return { p: sumWhere(ctx.shapeGrid, (h, a) => a > 0 && h === 0) };
  if (d === "both teams") return { p: sumWhere(ctx.shapeGrid, (h, a) => h > 0 && a > 0) };
  return null;
}

export function priceShapeOutcome(
  ctx: V3EngineCtx,
  route: V3Route,
  marketName: string,
  desc: string
): V3Price | null {
  const name = marketName.toLowerCase();
  const d = desc.toLowerCase().trim();

  switch (route.family) {
    case "btts":
      return priceBtts(ctx, d);
    case "team_total": {
      const side: "home" | "away" | null = name.includes("home")
        ? "home"
        : name.includes("away")
          ? "away"
          : null;
      return side ? priceTeamTotal(ctx, side, d) : null;
    }
    case "clean_sheet": {
      const side: "home" | "away" | null = name.includes("home")
        ? "home"
        : name.includes("away")
          ? "away"
          : null;
      return side ? priceCleanSheet(ctx, side, d) : null;
    }
    case "win_to_nil":
      return priceWinToNil(ctx, name, d);
    case "which_team_scores":
      return priceWhichTeamScores(ctx, d);
    default:
      return null;
  }
}
