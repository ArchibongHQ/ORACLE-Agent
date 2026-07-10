/** [Wave-2 W2-S stub, owner WS2-E] Per-slate column-fill report — computed
 *  before pricing, surfaces which stats/xG/odds columns are actually
 *  populated across today's fixture pool so data gaps are visible in the
 *  daily log/report instead of discovered later as silent completeness
 *  downgrades.
 *
 *  Inert stub — WS2-E fleshes this out. Exported shape exists so other
 *  Wave-2 workstreams can typecheck against the eventual real contract. */

export interface ColumnFillStat {
  column: string;
  filled: number;
  total: number;
}

export interface ColumnFillReport {
  slateDate: string;
  columns: ColumnFillStat[];
}

/** Build the column-fill report for a slate. Inert stub — returns an empty
 *  report; never throws. */
export function buildColumnFillReport(slateDate: string, _fixtures: unknown[]): ColumnFillReport {
  return { slateDate, columns: [] };
}
