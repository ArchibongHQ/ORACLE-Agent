/** Shared, anchored parsing for market-outcome description strings — side,
 *  direction, numeric line, and double-chance cover-set extraction.
 *
 *  Consumed by sanity.ts (slate-level skew checks) and, via @oracle/engine's
 *  barrel export, by @oracle/runtime's calibrationFeed.ts (ledger settlement).
 *  Previously each consumer kept its own private copy, and two of them (the
 *  settlement-side `lineOfDesc`/`dcCovers`) grabbed the first digit / did
 *  naive digit-substring matching anywhere in the string — safe only because
 *  every test fixture happened to be a clean, single-token desc ("Over 2.5").
 *  A composite/display-oriented desc (e.g. execution/index.ts's "AllMarkets
 *  Scan" fallback path builds `${marketName} — ${outcome.desc}`, and the real
 *  market catalog has entries like "Double Chance - 1UP") breaks that: the
 *  "1" in "1UP" reads as a home cover, "1st Half — Over 2.5" reads as line=1.
 *  These versions are anchored (mirroring marketsV3/engines/totals.ts's
 *  parseOUDesc and result.ts's exact-token priceDoubleChance) — a desc outside
 *  the expected clean shape returns null (settlement skips it, counted) rather
 *  than silently misparsing it. */

/** "home"/"away" from a clean side desc ("Home", "Away", "Home Over 1.5"),
 *  else null (draw / ambiguous / neither mentioned). */
export function sideOfDesc(desc: string): "home" | "away" | null {
  const d = desc.toLowerCase();
  const home = d.includes("home");
  const away = d.includes("away");
  if (home && !away) return "home";
  if (away && !home) return "away";
  return null;
}

/** "over"/"under" from a totals desc, else null. */
export function dirOfDesc(desc: string): "over" | "under" | null {
  const d = desc.toLowerCase();
  const over = /\bover\b/.test(d);
  const under = /\bunder\b/.test(d);
  if (over && !under) return "over";
  if (under && !over) return "under";
  return null;
}

/** Numeric line from a clean, whole-string totals/team-total desc ("Over
 *  2.5", "Home Under 1.5") — anchored end-to-end, not a bare digit search. */
export function lineOfDesc(desc: string): number | null {
  const m = desc.trim().match(/^(?:home|away)?\s*(?:over|under)\s*([\d.]+)$/i);
  return m ? Number.parseFloat(m[1]!) : null;
}

/** Double-chance cover set from a clean DC desc. Handles compact forms
 *  ("1X", "12", "X2") and word forms joined by "/" or "or" ("Home/Draw",
 *  "Draw or Away") via exact-token matching — never a digit-substring check
 *  against the whole desc, which would spuriously match e.g. a market-name
 *  suffix like "1UP" or any other incidental "1"/"2" character. Returns null
 *  unless the desc resolves to exactly two of {home, draw, away}. */
export function dcCovers(desc: string): Set<"home" | "draw" | "away"> | null {
  const d = desc.trim().toLowerCase();
  const COMPACT: Record<string, readonly ["home" | "draw" | "away", "home" | "draw" | "away"]> = {
    "1x": ["home", "draw"],
    "12": ["home", "away"],
    x2: ["draw", "away"],
  };
  const compact = COMPACT[d];
  if (compact) return new Set(compact);

  const tokens = d.split(/\s*(?:\/|\bor\b)\s*/).filter(Boolean);
  if (tokens.length !== 2) return null;
  const valid = new Set(["home", "draw", "away"]);
  if (!tokens.every((t) => valid.has(t))) return null;
  const covers = new Set(tokens as Array<"home" | "draw" | "away">);
  return covers.size === 2 ? covers : null;
}
