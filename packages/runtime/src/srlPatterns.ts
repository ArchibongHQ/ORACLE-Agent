/** [refactor P1-3] Single source of truth for SRL / virtual / e-soccer fixture
 *  detection. Consolidates four previously-duplicated regexes:
 *    - goalsV3/eligibility.ts SRL_RE
 *    - selectFixtures.ts SRL_PATTERN
 *    - teamNames.ts " SRL" suffix strip
 *    - tools/acquire_daily.py _SRL_VIRTUAL_RE (Python mirror — cannot import
 *      this module; test/srlPatterns parity test asserts the two stay equal)
 *
 *  WS1-D replaces the duplicated definitions with imports from here. Any
 *  change to these patterns MUST be mirrored in tools/acquire_daily.py.
 *
 *  Pure constants, no I/O. */

/** Matches SRL/simulated-reality/virtual/e-soccer league or team labels.
 *  Superset union of the four legacy patterns (case-insensitive). */
export const SRL_VIRTUAL_RE =
  /simulated\s*reality|\bsrl\b|e-?soccer|esports?|virtual\s*(football|soccer|sport)?/i;

/** Trailing " SRL" team-name suffix (teamNames.ts strip case). Word-boundary
 *  anchored rather than end-of-string anchored — mirrors teamNames.ts's
 *  pre-consolidation inline regex (`/\s+srl\b/g`) exactly so normTeam()'s
 *  behavior doesn't shift. Deliberately NOT global: normTeam()'s call site
 *  (a single .replace()) only ever needs the first hit, and this same
 *  pattern is also .test()'d elsewhere (isSrlTeamName) where a `g` flag
 *  would introduce lastIndex statefulness bugs across repeated calls. */
export const SRL_TEAM_SUFFIX_RE = /\s+srl\b/i;

/** True when a league/competition label denotes an SRL or virtual product. */
export function isSrlVirtualLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  return SRL_VIRTUAL_RE.test(label);
}

/** True when a team name carries the SRL twin suffix (e.g. "France SRL"). */
export function isSrlTeamName(name: string | null | undefined): boolean {
  if (!name) return false;
  return SRL_TEAM_SUFFIX_RE.test(name) || SRL_VIRTUAL_RE.test(name);
}

/** Strip the SRL suffix from a team name — used to pair a real fixture with
 *  its SRL twin for the Rule 0.14 contamination comparison. */
export function stripSrlSuffix(name: string): string {
  return name.replace(SRL_TEAM_SUFFIX_RE, "").trim();
}
