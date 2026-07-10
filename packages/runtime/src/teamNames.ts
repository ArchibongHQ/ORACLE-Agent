/** Shared team-name normalisation + alias-aware matching.
 *
 *  Single source of truth for resolving the AH/OTS abbreviation↔full-name gap and
 *  for fuzzy fixture matching across odds providers. Both fixtures.ts and
 *  oddsProviders.ts import from here — do not reimplement matching elsewhere.
 */
import { SRL_TEAM_SUFFIX_RE } from "./srlPatterns.js";

/** Normalise a team name for fuzzy matching: lowercase, strip common suffixes & punctuation.
 *  Diacritics are folded (é→e, ô→o, ü→u, …) before punctuation is stripped — otherwise
 *  e.g. "Côte d'Ivoire" loses the "ô" entirely instead of folding to "o" and silently
 *  fails to match both the plain-ASCII spelling and the alias table below. */
export function normTeam(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks
      .toLowerCase()
      // Strip SportyBet SRL simulation-league suffix ("Sweden SRL" → "Sweden").
      // [refactor P1-3] Uses the narrow SRL_TEAM_SUFFIX_RE (srlPatterns.ts), NOT
      // the broad SRL_VIRTUAL_RE — this call site strips a team-name suffix, it
      // doesn't classify a whole fixture as SRL/virtual, so the wider pattern
      // (e-soccer/esports/simulated-reality wording) would over-strip here.
      .replace(SRL_TEAM_SUFFIX_RE, "")
      .replace(/\b(fc|afc|sc|cf|ac|as|ss|ssc|sv|bk|if|cd|ud)\b/g, "")
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// Common international team name aliases (SportyBet / Wikipedia → Odds API / FIFA).
// Keys are normTeam() output (post diacritic-fold), so write them in plain ASCII —
// an accented key here would never match since normTeam() always folds first.
export const TEAM_ALIASES: Record<string, string> = {
  "ir iran": "iran",
  "ivory coast": "cote divoire",
  "cote d ivoire": "cote divoire",
  "korea republic": "south korea",
  "republic of korea": "south korea",
  turkiye: "turkey",
  "czech republic": "czechia",
  "bosnia herzegovina": "bosnia and herzegovina",
  "bosnia-herzegovina": "bosnia and herzegovina",
  usa: "united states",
  "united states of america": "united states",
};

/** Normalise then map through the alias table. */
export function resolveAlias(name: string): string {
  const n = normTeam(name);
  return TEAM_ALIASES[n] ?? n;
}

/** True when two team names refer to the same club/nation (alias- and substring-tolerant). */
export function namesMatch(a: string, b: string): boolean {
  const na = resolveAlias(a),
    nb = resolveAlias(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}
