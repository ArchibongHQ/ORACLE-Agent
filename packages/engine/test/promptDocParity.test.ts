import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { V3_EDGE_CAP_DEFAULT } from "../src/goalsV3/edgeGate.js";
import { EMPIRICAL_BLEND_N_CAP, EMPIRICAL_BLEND_W } from "../src/marketsV3/engines/types.js";
import {
  CLASS_GATE,
  CLASS_GATE_BLEND,
  CLASS_GATE_BLEND_HEIGHTENED,
  CLASS_GATE_HEIGHTENED,
  RELATIVE_CAP_ODDS_FLOOR,
  RELATIVE_CAP_RATIO,
  RELATIVE_CAP_RATIO_X,
  V3_ALLMARKETS_PENALTY_PTS,
  V3_BLEND_GATE_ODDS_FLOOR,
  V3_BLEND_MIN_EDGE,
  V3_BLEND_W_CAP,
  V3_BLEND_W_COMPLETENESS_COEF,
  V3_BLEND_W_FLOOR,
  V3_BLEND_W_XG_COEF,
} from "../src/marketsV3/evGate.js";

// ── Doc/code parity ──────────────────────────────────────────────────────────
// The v5.1 prompt doc documents the engine's gating constants; this test asserts
// each <!-- PARITY:* -->-anchored table in the doc equals the exported constant,
// so doc/code drift is a CI failure ("code is truth; the doc documents it"). See
// docs/prompts/unified-markets-analysis-prompt-v5.1.md.
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

/** Extract the markdown table rows immediately following `<!-- PARITY:<name> -->`.
 *  Returns each row as an array of trimmed cell strings (header + separator
 *  skipped). Stops at the first blank line after the table starts. */
function parityRows(name: string): string[][] {
  const anchor = `<!-- PARITY:${name} -->`;
  const start = DOC.indexOf(anchor);
  if (start === -1) throw new Error(`anchor ${anchor} not found in v5.1 doc`);
  const lines = DOC.slice(start + anchor.length).split("\n");
  const rows: string[][] = [];
  let seenTable = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("|")) {
      if (seenTable) break; // table ended
      continue; // blank lines between anchor and table
    }
    seenTable = true;
    const cells = t
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^-+$/.test(c))) continue; // separator row
    rows.push(cells);
  }
  return rows;
}

const num = (s: string): number | null => (s === "null" ? null : Number(s));

/** Parse a class-gate PARITY table (class | edge | evPct | maxOdds) into a map. */
function classGateFromDoc(
  name: string,
  edgeKey: string
): Record<string, { edge: number; ev: number | null; maxOdds: number | null } | null> {
  const rows = parityRows(name);
  const header = rows[0];
  expect(header[1]).toBe(edgeKey); // guards against column reordering
  const out: Record<string, { edge: number; ev: number | null; maxOdds: number | null } | null> =
    {};
  for (const r of rows.slice(1)) {
    const [cls, edge, ev, maxOdds] = r;
    out[cls] = edge === "null" ? null : { edge: Number(edge), ev: num(ev), maxOdds: num(maxOdds) };
  }
  return out;
}

/** Parse a two-column key|value PARITY table into a map. */
function kvFromDoc(name: string): Record<string, number> {
  const rows = parityRows(name);
  const out: Record<string, number> = {};
  for (const r of rows.slice(1)) out[r[0]] = Number(r[1]);
  return out;
}

describe("v5.1 prompt-doc parity — engine constants", () => {
  it("CLASS_GATE matches", () => {
    const doc = classGateFromDoc("CLASS_GATE", "minAdjEdge");
    for (const cls of ["S", "M", "L", "X"] as const) {
      expect(doc[cls]).not.toBeNull();
      expect(doc[cls]?.edge).toBe(CLASS_GATE[cls].minAdjEdge);
      expect(doc[cls]?.ev).toBe(CLASS_GATE[cls].minAdjEvPct);
      expect(doc[cls]?.maxOdds).toBe(CLASS_GATE[cls].maxOdds);
    }
  });

  it("CLASS_GATE_HEIGHTENED matches", () => {
    const doc = classGateFromDoc("CLASS_GATE_HEIGHTENED", "minAdjEdge");
    for (const cls of ["S", "M", "L", "X"] as const) {
      const code = CLASS_GATE_HEIGHTENED[cls];
      if (code === null) {
        expect(doc[cls]).toBeNull();
        continue;
      }
      expect(doc[cls]?.edge).toBe(code.minAdjEdge);
      expect(doc[cls]?.ev).toBe(code.minAdjEvPct);
      expect(doc[cls]?.maxOdds).toBe(code.maxOdds);
    }
  });

  it("CLASS_GATE_BLEND matches", () => {
    const doc = classGateFromDoc("CLASS_GATE_BLEND", "minAdjEdgeBlend");
    for (const cls of ["S", "M", "L", "X"] as const) {
      expect(doc[cls]).not.toBeNull();
      expect(doc[cls]?.edge).toBe(CLASS_GATE_BLEND[cls].minAdjEdgeBlend);
      expect(doc[cls]?.ev).toBe(CLASS_GATE_BLEND[cls].minBlendEvPct);
      expect(doc[cls]?.maxOdds).toBe(CLASS_GATE_BLEND[cls].maxOdds);
    }
  });

  it("CLASS_GATE_BLEND_HEIGHTENED matches (X excluded)", () => {
    const doc = classGateFromDoc("CLASS_GATE_BLEND_HEIGHTENED", "minAdjEdgeBlend");
    for (const cls of ["S", "M", "L", "X"] as const) {
      const code = CLASS_GATE_BLEND_HEIGHTENED[cls];
      if (code === null) {
        expect(doc[cls]).toBeNull();
        continue;
      }
      expect(doc[cls]?.edge).toBe(code.minAdjEdgeBlend);
      expect(doc[cls]?.ev).toBe(code.minBlendEvPct);
      expect(doc[cls]?.maxOdds).toBe(code.maxOdds);
    }
  });

  it("PENALTIES match V3_ALLMARKETS_PENALTY_PTS", () => {
    const doc = kvFromDoc("PENALTIES");
    expect(doc.exoticClass).toBe(V3_ALLMARKETS_PENALTY_PTS.exoticClass);
    expect(doc.marketStatMissing).toBe(V3_ALLMARKETS_PENALTY_PTS.marketStatMissing);
    expect(doc.shapeDisagreement).toBe(V3_ALLMARKETS_PENALTY_PTS.shapeDisagreement);
  });

  it("BLEND_W coefficients match", () => {
    const doc = kvFromDoc("BLEND_W");
    expect(doc.V3_BLEND_W_FLOOR).toBe(V3_BLEND_W_FLOOR);
    expect(doc.V3_BLEND_W_COMPLETENESS_COEF).toBe(V3_BLEND_W_COMPLETENESS_COEF);
    expect(doc.V3_BLEND_W_XG_COEF).toBe(V3_BLEND_W_XG_COEF);
    expect(doc.V3_BLEND_W_CAP).toBe(V3_BLEND_W_CAP);
  });

  it("CAPS match", () => {
    const doc = kvFromDoc("CAPS");
    expect(doc.V3_EDGE_CAP_DEFAULT).toBe(V3_EDGE_CAP_DEFAULT);
    expect(doc.RELATIVE_CAP_ODDS_FLOOR).toBe(RELATIVE_CAP_ODDS_FLOOR);
    expect(doc.RELATIVE_CAP_RATIO).toBe(RELATIVE_CAP_RATIO);
    expect(doc.RELATIVE_CAP_RATIO_X).toBe(RELATIVE_CAP_RATIO_X);
  });

  it("LONGSHOT guard matches", () => {
    const doc = kvFromDoc("LONGSHOT");
    expect(doc.V3_BLEND_GATE_ODDS_FLOOR).toBe(V3_BLEND_GATE_ODDS_FLOOR);
    expect(doc.V3_BLEND_MIN_EDGE).toBe(V3_BLEND_MIN_EDGE);
  });

  it("EMPIRICAL_BLEND matches", () => {
    const doc = kvFromDoc("EMPIRICAL_BLEND");
    expect(doc.EMPIRICAL_BLEND_W).toBe(EMPIRICAL_BLEND_W);
    expect(doc.EMPIRICAL_BLEND_N_CAP).toBe(EMPIRICAL_BLEND_N_CAP);
  });
});
