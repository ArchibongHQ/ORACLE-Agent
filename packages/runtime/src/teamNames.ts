/** Shared team-name normalisation + alias-aware matching.
 *
 *  Single source of truth for resolving the AH/OTS abbreviation↔full-name gap and
 *  for fuzzy fixture matching across odds providers. Both fixtures.ts and
 *  oddsProviders.ts import from here — do not reimplement matching elsewhere.
 */

/** Normalise a team name for fuzzy matching: lowercase, strip common suffixes & punctuation. */
export function normTeam(name: string): string {
  return name
    .toLowerCase()
    // Strip SportyBet SRL simulation-league suffix ("Sweden SRL" → "Sweden")
    .replace(/\s+srl\b/g, "")
    .replace(/\b(fc|afc|sc|cf|ac|as|ss|ssc|sv|bk|if|cd|ud)\b/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Common international team name aliases (SportyBet / Wikipedia → Odds API / FIFA)
export const TEAM_ALIASES: Record<string, string> = {
  "ir iran": "iran",
  "ivory coast": "cote divoire",
  "cote d ivoire": "cote divoire",
  "côte d'ivoire": "cote divoire",
  "korea republic": "south korea",
  "republic of korea": "south korea",
  turkiye: "turkey",
  türkiye: "turkey",
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
