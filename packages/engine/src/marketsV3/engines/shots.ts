/** §3.9-adjacent — shots-on-target module (Negative Binomial), dormant
 *  unless BOTH the odds AND the supporting stats exist.
 *
 *  Shot counts are overdispersed like corners (not plain Poisson), so this
 *  reuses corners.ts's NB primitives (nbTailOver/nbTailUnder/clampCornersDispersion)
 *  rather than duplicating the log-gamma machinery for a second module. Scope
 *  is deliberately narrow: match-total + team-total Over/Under only (catalog
 *  ids 900393 "Shots on Target Over/Under", 900395/900396 team-scoped) — no
 *  1X2/handicap/range variants (unlike corners/cards, no such shots markets
 *  are catalogued, so there's nothing to route to them). This is priced
 *  shots-on-target O/U from real shots data — NOT a pseudo-xG estimate; no
 *  xG signal ships from this module.
 *
 *  Pure math, no I/O. */

import { clampCornersDispersion, nbTailOver, nbTailUnder } from "./corners.js";

export interface V3ShotsInput {
  sotForH?: number;
  sotForA?: number;
  dispersion?: number;
}

export interface V3ShotsMeans {
  total: number;
  home: number;
  away: number;
  r: number;
}

/** Returns null (dormant) when either side's shots-on-target average is missing. */
export function shotsMeans(input: V3ShotsInput): V3ShotsMeans | null {
  const { sotForH: home, sotForA: away } = input;
  if (home == null || away == null || !Number.isFinite(home) || !Number.isFinite(away)) return null;
  return { total: home + away, home, away, r: clampCornersDispersion(input.dispersion) };
}

/** Price "Over/Under X.5" (match total) or a team-total shots-on-target
 *  outcome. `side` selects which mean to use; undefined = match total. */
export function priceShotsOutcome(
  means: V3ShotsMeans,
  desc: string,
  side?: "home" | "away"
): number | null {
  const m = desc
    .toLowerCase()
    .trim()
    .match(/^(over|under)\s*([\d.]+)$/);
  if (!m) return null;
  const line = Number.parseFloat(m[2]!);
  const mean = side === "home" ? means.home : side === "away" ? means.away : means.total;
  return m[1] === "over" ? nbTailOver(line, mean, means.r) : nbTailUnder(line, mean, means.r);
}
