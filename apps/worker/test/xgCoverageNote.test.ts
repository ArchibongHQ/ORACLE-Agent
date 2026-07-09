/** PR-19: unit tests for the xG-coverage caption formatter. Extracted into
 *  its own dependency-free module (xgCoverageNote.ts, mirroring
 *  acquireChain.ts's convention) so this pure formatting logic is testable
 *  without importing the rest of apps/worker/src/index.ts. */
import { describe, expect, it } from "vitest";
import { formatXgCoverageNote } from "../src/xgCoverageNote.js";

describe("formatXgCoverageNote", () => {
  it("sorts sources descending by count and omits zero-count sources other than fotmob", () => {
    const note = formatXgCoverageNote({
      covered: 7,
      total: 30,
      bySrc: { understat: 5, google_ai: 2, sofascore: 0 },
    });
    expect(note).toBe("xG coverage: 7/30 fixtures (understat 5, google_ai 2, fotmob 0)");
  });

  it("always shows fotmob even at zero — the silent-zero-tier failure mode this line exists to surface", () => {
    const note = formatXgCoverageNote({ covered: 3, total: 10, bySrc: { understat: 3 } });
    expect(note).toContain("fotmob 0");
  });

  it("does not duplicate fotmob when it already appears with a nonzero count", () => {
    const note = formatXgCoverageNote({ covered: 4, total: 10, bySrc: { fotmob: 4 } });
    expect(note).toBe("xG coverage: 4/10 fixtures (fotmob 4)");
  });

  it("renders gracefully when bySrc is fully empty (still shows fotmob 0)", () => {
    expect(formatXgCoverageNote({ covered: 0, total: 0, bySrc: {} })).toBe(
      "xG coverage: 0/0 fixtures (fotmob 0)"
    );
  });
});
