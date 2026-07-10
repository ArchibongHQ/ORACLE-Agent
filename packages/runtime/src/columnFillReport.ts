/** [Wave-2 W2-S] Per-slate column-fill report — computed before pricing,
 *  surfaces which stats/xG/odds columns are actually populated across
 *  today's fixture pool so data gaps are visible in the daily log/report
 *  instead of discovered later as silent completeness downgrades.
 *
 *  Pure function — no I/O. Callers (e.g. batch/index.ts, ahead of the
 *  pricing pass) are responsible for logging/printing the returned report;
 *  see this module's header comment for the original stub rationale. */

import type { SportyBetEvent } from "./selectFixtures.js";

export interface ColumnFillStat {
  column: string;
  filled: number;
  total: number;
}

export interface ColumnFillReport {
  slateDate: string;
  columns: ColumnFillStat[];
}

/** One checkable column: a human-readable id plus a predicate over a single
 *  fixture's already-loaded SportyBet detail. Order here is the render order
 *  of ColumnFillReport.columns. */
const COLUMN_CHECKS: Array<{ column: string; present: (event: SportyBetEvent) => boolean }> = [
  { column: "odds.1x2", present: (e) => !!e.detail?.odds?.["1x2"] },
  {
    column: "odds.allMarkets",
    present: (e) => !!e.detail?.odds?.allMarkets && e.detail.odds.allMarkets.length > 0,
  },
  { column: "stats.xg.home", present: (e) => !!e.detail?.stats?.xg?.home },
  { column: "stats.xg.away", present: (e) => !!e.detail?.stats?.xg?.away },
  { column: "stats.h2h", present: (e) => !!e.detail?.stats?.h2h },
  {
    column: "stats.form",
    present: (e) => !!(e.detail?.stats?.form?.home || e.detail?.stats?.form?.away),
  },
  {
    column: "stats.goals",
    present: (e) => !!(e.detail?.stats?.goals?.home || e.detail?.stats?.goals?.away),
  },
  {
    column: "stats.overunder",
    present: (e) => !!(e.detail?.stats?.overunder?.home || e.detail?.stats?.overunder?.away),
  },
  {
    column: "stats.availability",
    present: (e) => !!(e.detail?.stats?.availability?.home || e.detail?.stats?.availability?.away),
  },
];

/** Build the column-fill report for a slate: for each checkable column,
 *  counts how many of `fixtures` have it populated vs the slate total. Never
 *  throws — a fixture with no `detail` at all simply counts as unfilled on
 *  every column. */
export function buildColumnFillReport(
  slateDate: string,
  fixtures: SportyBetEvent[]
): ColumnFillReport {
  const total = fixtures.length;
  const columns: ColumnFillStat[] = COLUMN_CHECKS.map(({ column, present }) => ({
    column,
    filled: fixtures.reduce((n, f) => n + (present(f) ? 1 : 0), 0),
    total,
  }));
  return { slateDate, columns };
}
