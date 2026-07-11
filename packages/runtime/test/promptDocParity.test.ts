import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HEADLINE_TOLERANCE,
  MIN_MEANINGFUL_PAIRED_ENTRIES,
  SRL_TWIN_IDENTITY_RATIO,
} from "../src/feedIntegrity.js";
import { V3_COMPLETENESS_WEIGHTS } from "../src/goalsV3/completeness.js";

// ── Doc/code parity (runtime-owned constants) ────────────────────────────────
// Engine can't import runtime and vice-versa, so the v5.1 parity check is split:
// this file asserts the runtime-owned PARITY tables (completeness weights, feed-
// integrity thresholds); packages/engine/test/promptDocParity.test.ts asserts the
// engine-owned gating tables. See docs/prompts/unified-markets-analysis-prompt-v5.1.md.
const DOC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "prompts",
  "unified-markets-analysis-prompt-v5.1.md"
);
const DOC = readFileSync(DOC_PATH, "utf8");

/** Two-column key|value PARITY table → map. Stops at the first blank line. */
function kvFromDoc(name: string): Record<string, number> {
  const anchor = `<!-- PARITY:${name} -->`;
  const start = DOC.indexOf(anchor);
  if (start === -1) throw new Error(`anchor ${anchor} not found in v5.1 doc`);
  const lines = DOC.slice(start + anchor.length).split("\n");
  const out: Record<string, number> = {};
  let seenTable = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("|")) {
      if (seenTable) break;
      continue;
    }
    seenTable = true;
    const cells = t
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^-+$/.test(c))) continue; // separator
    if (cells[0] === "field" || cells[0] === "key") continue; // header
    out[cells[0]] = Number(cells[1]);
  }
  return out;
}

describe("v5.1 prompt-doc parity — runtime constants", () => {
  it("COMPLETENESS_WEIGHTS match V3_COMPLETENESS_WEIGHTS", () => {
    const doc = kvFromDoc("COMPLETENESS_WEIGHTS");
    for (const [field, weight] of Object.entries(V3_COMPLETENESS_WEIGHTS)) {
      expect(doc[field]).toBe(weight);
    }
    // and no extra rows in the doc that aren't real weights
    expect(Object.keys(doc).sort()).toEqual(Object.keys(V3_COMPLETENESS_WEIGHTS).sort());
  });

  it("FEED_INTEGRITY thresholds match", () => {
    const doc = kvFromDoc("FEED_INTEGRITY");
    expect(doc.SRL_TWIN_IDENTITY_RATIO).toBe(SRL_TWIN_IDENTITY_RATIO);
    expect(doc.MIN_MEANINGFUL_PAIRED_ENTRIES).toBe(MIN_MEANINGFUL_PAIRED_ENTRIES);
    expect(doc.HEADLINE_TOLERANCE).toBe(HEADLINE_TOLERANCE);
  });
});
