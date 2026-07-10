/** [refactor P1-3] Parity + behavior tests for the consolidated SRL/virtual
 *  detection pattern (srlPatterns.ts).
 *
 *  Two concerns:
 *   1. Cross-language parity: tools/acquire_daily.py's _SRL_VIRTUAL_RE cannot
 *      import the TS module (no TS runtime in that process), so it's a
 *      hand-mirrored Python regex. This test parses BOTH source files' regex
 *      literals out of their raw text and asserts the pattern bodies are
 *      byte-identical (a faithful translation needs no semantic
 *      normalization — the only difference tolerated is syntax the two
 *      languages express differently, e.g. inline `/i` vs re.IGNORECASE,
 *      which is asserted separately) so a future edit to one side that
 *      forgets the other fails CI instead of silently drifting.
 *   2. Behavioral spot checks against a shared label table, run directly
 *      against the TS regex/helpers — the parity check alone can't catch a
 *      pattern that's textually identical but semantically wrong.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isSrlTeamName,
  isSrlVirtualLabel,
  SRL_TEAM_SUFFIX_RE,
  stripSrlSuffix,
} from "../src/srlPatterns.js";
import { normTeam } from "../src/teamNames.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, "../../..");
const TS_SOURCE_PATH = join(REPO_ROOT, "packages/runtime/src/srlPatterns.ts");
const PY_SOURCE_PATH = join(REPO_ROOT, "tools/acquire_daily.py");

function extractTsPattern(src: string): { body: string; flags: string } {
  const m = src.match(/SRL_VIRTUAL_RE\s*=\s*\/((?:\\.|[^/\\])+)\/([a-zA-Z]*)/);
  if (!m) throw new Error("could not locate SRL_VIRTUAL_RE regex literal in srlPatterns.ts");
  return { body: m[1]!, flags: m[2]! };
}

function extractPyPattern(src: string): { body: string; caseInsensitive: boolean } {
  // Match the raw-string body directly off the assignment — NOT by first
  // isolating the whole re.compile(...) call, because the pattern body itself
  // contains ')' (e.g. "(football|soccer|sport)") which any non-greedy match up
  // to the first ')' would truncate before the closing quote.
  const m = src.match(/_SRL_VIRTUAL_RE\s*=\s*re\.compile\(\s*r"([^"]*)"/);
  if (!m) throw new Error("could not locate _SRL_VIRTUAL_RE raw-string body in acquire_daily.py");
  // Flags live on the lines after the raw string, before the closing paren —
  // scan a bounded window from the match start rather than the truncated call.
  const window = src.slice(m.index!, m.index! + 400);
  return { body: m[1]!, caseInsensitive: /re\.IGNORECASE/.test(window) };
}

describe("SRL_VIRTUAL_RE cross-language parity (TS vs Python mirror)", () => {
  const tsSrc = readFileSync(TS_SOURCE_PATH, "utf8");
  const pySrc = readFileSync(PY_SOURCE_PATH, "utf8");
  const ts = extractTsPattern(tsSrc);
  const py = extractPyPattern(pySrc);

  it("has byte-identical pattern bodies", () => {
    expect(py.body).toBe(ts.body);
  });

  it("is case-insensitive on both sides", () => {
    expect(ts.flags).toContain("i");
    expect(py.caseInsensitive).toBe(true);
  });
});

describe("SRL_VIRTUAL_RE / isSrlVirtualLabel behavioral spot checks", () => {
  const cases: Array<[string, boolean]> = [
    ["Premier League SRL", true],
    ["France SRL", true],
    ["Israel SRL", true],
    ["Simulated Reality League", true],
    ["Esoccer Battle 8 mins", true],
    ["eSoccer GT Leagues", true],
    ["esports Cyber Cup", true],
    ["Virtual Bundesliga", true],
    ["Virtual Football Cup", true],
    ["Premier League", false],
    ["France", false],
    ["Manchester United", false],
    ["Bundesliga", false],
    ["Botola Pro", false],
    ["Regionalliga Nordost", false],
  ];

  it.each(cases)("isSrlVirtualLabel(%j) === %s", (label, expected) => {
    expect(isSrlVirtualLabel(label)).toBe(expected);
  });

  it("returns false for null/undefined (fail-open on missing labels)", () => {
    expect(isSrlVirtualLabel(null)).toBe(false);
    expect(isSrlVirtualLabel(undefined)).toBe(false);
  });
});

describe("SRL_TEAM_SUFFIX_RE / isSrlTeamName / stripSrlSuffix (teamNames.ts's narrow suffix strip)", () => {
  it("matches only the trailing ' SRL' team-name suffix, not the broad virtual/e-soccer wording", () => {
    expect(SRL_TEAM_SUFFIX_RE.test("France SRL")).toBe(true);
    expect(SRL_TEAM_SUFFIX_RE.test("France")).toBe(false);
    // Narrow pattern deliberately does NOT catch broad virtual/e-soccer wording —
    // that's isSrlVirtualLabel's job, not the team-name suffix stripper's.
    expect(SRL_TEAM_SUFFIX_RE.test("Virtual Bundesliga")).toBe(false);
  });

  it("isSrlTeamName is the union (suffix OR broad virtual wording)", () => {
    expect(isSrlTeamName("France SRL")).toBe(true);
    expect(isSrlTeamName("Virtual Bundesliga")).toBe(true);
    expect(isSrlTeamName("France")).toBe(false);
    expect(isSrlTeamName(null)).toBe(false);
  });

  it("stripSrlSuffix removes the suffix and trims, is a no-op otherwise", () => {
    expect(stripSrlSuffix("France SRL")).toBe("France");
    expect(stripSrlSuffix("France")).toBe("France");
  });

  it("does not use a global flag (repeated .test() calls stay consistent — no lastIndex drift)", () => {
    expect(SRL_TEAM_SUFFIX_RE.global).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect(SRL_TEAM_SUFFIX_RE.test("Sweden SRL")).toBe(true);
    }
  });
});

describe("normTeam() SRL suffix stripping stays correct post-consolidation", () => {
  it("strips the SportyBet SRL simulation-league suffix", () => {
    expect(normTeam("Sweden SRL")).toBe("sweden");
  });

  it("leaves ordinary team names untouched", () => {
    expect(normTeam("France")).toBe("france");
  });
});
