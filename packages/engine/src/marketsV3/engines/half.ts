/** §3.6 — half engine (1H/2H O/U, half results, half shape markets, Highest
 *  Scoring Half).
 *
 *  First-half goal share ρ: from the sheet's own 1H data (typed fhShareH/A,
 *  averaged) when available, else the league default ρ = 0.44 (goals skew
 *  late) — tagged marketStatMissing (§5.3 −1) on the default path. Half grids
 *  (ctx.halfStats/halfShape) are plain independent Poisson (no DC) built by
 *  the orchestrator on μ scaled by ρ (1H) / (1−ρ) (2H), same stats/odds split
 *  as the full-time grids. */

import { poissonPMF } from "../../math/index.js";
import type { Matrix } from "../../types.js";
import type { V3Route } from "../feedDictionary.js";
import { resultProbs, sumWhere, winPushSplit } from "../grid.js";
import type { V3EngineCtx, V3Price } from "./types.js";

export const V3_FIRST_HALF_SHARE_DEFAULT = 0.44;

const withDefault = (base: V3Price, isDefault: boolean): V3Price => ({
  ...base,
  marketStatMissing: isDefault || base.marketStatMissing,
});

function priceHalfTotal(mat: Matrix, d: string): V3Price | null {
  const m = d.match(/^(over|under)\s*([\d.]+)$/);
  if (!m) return null;
  const isOver = m[1] === "over";
  const line = Number.parseFloat(m[2]!);
  const pWin = sumWhere(mat, (h, a) => (isOver ? h + a > line : h + a < line));
  if (!Number.isInteger(line)) return { p: pWin };
  const pPush = sumWhere(mat, (h, a) => h + a === line);
  const denom = 1 - pPush;
  return { p: denom > 0 ? pWin / denom : 0, conditional: true };
}

function priceHalfTeamTotal(mat: Matrix, side: "home" | "away", d: string): V3Price | null {
  const m = d.match(/^(over|under)\s*([\d.]+)$/);
  if (!m) return null;
  const isOver = m[1] === "over";
  const line = Number.parseFloat(m[2]!);
  const pick = (h: number, a: number) => (side === "home" ? h : a);
  const pWin = sumWhere(mat, (h, a) => (isOver ? pick(h, a) > line : pick(h, a) < line));
  if (!Number.isInteger(line)) return { p: pWin };
  const pPush = sumWhere(mat, (h, a) => pick(h, a) === line);
  const denom = 1 - pPush;
  return { p: denom > 0 ? pWin / denom : 0, conditional: true };
}

function priceHalfResult(mat: Matrix, name: string, d: string): V3Price | null {
  const { pHome, pDraw, pAway } = resultProbs(mat);
  if (name.includes("double chance")) {
    if (d === "home or draw" || d === "1x") return { p: pHome + pDraw };
    if (d === "home or away" || d === "12") return { p: pHome + pAway };
    if (d === "draw or away" || d === "x2") return { p: pDraw + pAway };
    return null;
  }
  if (name.includes("draw no bet")) {
    const denom = pHome + pAway;
    if (d === "home" && denom > 0) return { p: pHome / denom, conditional: true };
    if (d === "away" && denom > 0) return { p: pAway / denom, conditional: true };
    return null;
  }
  // Plain half 1X2 (e.g. "1st Half - 1X2") — allowed here (unlike full-time,
  // half winner is not the spec's banned "plain 1X2" market).
  if (d === "home") return { p: pHome };
  if (d === "draw") return { p: pDraw };
  if (d === "away") return { p: pAway };
  return null;
}

function priceHalfShapeSingle(
  mat: Matrix,
  family: V3Route["family"],
  name: string,
  d: string
): V3Price | null {
  if (family === "clean_sheet") {
    const side = name.includes("home") ? "home" : name.includes("away") ? "away" : null;
    if (!side) return null;
    const p = sumWhere(mat, (h, a) => (side === "home" ? a === 0 : h === 0));
    if (d === "yes") return { p };
    if (d === "no") return { p: 1 - p };
    return null;
  }
  if (family === "win_to_nil") {
    const side = name.includes("home") ? "home" : name.includes("away") ? "away" : null;
    if (!side) return null;
    const p = sumWhere(mat, (h, a) => (side === "home" ? h > a && a === 0 : a > h && h === 0));
    if (d === "yes") return { p };
    if (d === "no") return { p: 1 - p };
    return null;
  }
  if (family === "btts") {
    const p = sumWhere(mat, (h, a) => h > 0 && a > 0);
    if (d === "yes") return { p };
    if (d === "no") return { p: 1 - p };
    return null;
  }
  return null;
}

/** Both halves independent per §3.6 — "win both halves" = product of the two
 *  half-win marginals; "win either half" = 1 − product of complements. */
function priceWinBothOrEither(ctx: V3EngineCtx, name: string, d: string): V3Price | null {
  const side: "home" | "away" | null = name.includes("home")
    ? "home"
    : name.includes("away")
      ? "away"
      : null;
  if (!side || (d !== "yes" && d !== "no")) return null;
  const win1 = resultProbs(ctx.halfStats[0])[side === "home" ? "pHome" : "pAway"];
  const win2 = resultProbs(ctx.halfStats[1])[side === "home" ? "pHome" : "pAway"];
  const p = name.includes("both") ? win1 * win2 : 1 - (1 - win1) * (1 - win2);
  return { p: d === "yes" ? p : 1 - p };
}

/** Highest Scoring Half: independent per-half TOTAL-goal marginals (μ is
 *  split-invariant, so this reads ctx.mu/fhShare directly rather than either
 *  grid). §3.6 structural lean noted: 2H ≥ Equal > 1H typically. */
function priceHighestScoringHalf(ctx: V3EngineCtx, d: string): V3Price | null {
  const mu1 = ctx.mu * ctx.fhShare;
  const mu2 = ctx.mu * (1 - ctx.fhShare);
  const MAX = 12;
  const pmf = (mu: number): number[] => {
    const v: number[] = [];
    let cum = 0;
    for (let k = 0; k < MAX; k++) {
      const p = poissonPMF(k, mu);
      v.push(p);
      cum += p;
    }
    v.push(Math.max(0, 1 - cum));
    return v;
  };
  const v1 = pmf(mu1);
  const v2 = pmf(mu2);
  let p1Higher = 0;
  let equal = 0;
  let p2Higher = 0;
  for (let i = 0; i < v1.length; i++) {
    for (let j = 0; j < v2.length; j++) {
      const p = (v1[i] ?? 0) * (v2[j] ?? 0);
      if (i > j) p1Higher += p;
      else if (i === j) equal += p;
      else p2Higher += p;
    }
  }
  if (d === "1st half" || d === "first half") return { p: p1Higher };
  if (d === "2nd half" || d === "second half") return { p: p2Higher };
  if (d === "equal") return { p: equal };
  return null;
}

export function priceHalfOutcome(
  ctx: V3EngineCtx,
  route: V3Route,
  marketName: string,
  desc: string
): V3Price | null {
  const name = marketName.toLowerCase();
  const d = desc.toLowerCase().trim();

  if (name.includes("highest scoring half")) {
    const r = priceHighestScoringHalf(ctx, d);
    return r && withDefault(r, ctx.fhShareIsDefault);
  }
  if (name.includes("both halves") || name.includes("either half")) {
    const r = priceWinBothOrEither(ctx, name, d);
    return r && withDefault(r, ctx.fhShareIsDefault);
  }

  const half = route.half ?? 1;
  const useShape =
    route.family === "team_total" ||
    route.family === "btts" ||
    route.family === "clean_sheet" ||
    route.family === "win_to_nil";
  const mat = useShape ? ctx.halfShape[half - 1] : ctx.halfStats[half - 1];

  let priced: V3Price | null = null;
  if (route.family === "goals_ou") priced = priceHalfTotal(mat, d);
  else if (route.family === "team_total") {
    const side: "home" | "away" | null = name.includes("home")
      ? "home"
      : name.includes("away")
        ? "away"
        : null;
    priced = side ? priceHalfTeamTotal(mat, side, d) : null;
  } else if (
    route.family === "double_chance" ||
    route.family === "dnb" ||
    route.family === "winning_margin"
  ) {
    priced = priceHalfResult(mat, name, d);
  } else {
    priced = priceHalfShapeSingle(mat, route.family, name, d);
  }
  return priced && withDefault(priced, ctx.fhShareIsDefault);
}
