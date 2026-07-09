/** PR-19: formats the daily xG coverage line ("xG coverage: 7/30 fixtures
 *  (understat 5, google_ai 2, fotmob 0)") for the Telegram caption + worker
 *  log. Extracted as its own tiny, dependency-free module (mirrors
 *  acquireChain.ts's convention) so this pure formatting logic is
 *  unit-testable without importing the rest of apps/worker/src/index.ts. */
import type { XgCoverage } from "@oracle/runtime";

/** Sorted desc by count; zero-count sources omitted EXCEPT fotmob, which
 *  always shows (including at 0) since a silent-zero FotMob tier is exactly
 *  the failure mode this line exists to surface. */
export function formatXgCoverageNote(coverage: XgCoverage): string {
  const bySrc: Record<string, number> = { fotmob: 0, ...coverage.bySrc };
  const parts = Object.entries(bySrc)
    .filter(([src, n]) => n > 0 || src === "fotmob")
    .sort(([, a], [, b]) => b - a)
    .map(([src, n]) => `${src} ${n}`);
  return `xG coverage: ${coverage.covered}/${coverage.total} fixtures (${parts.join(", ")})`;
}
