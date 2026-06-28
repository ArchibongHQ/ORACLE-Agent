/** I/O layer for the Q5 backtest — reads the on-disk analysis + resolution
 *  ledgers (MemoryAdapter's default .tmp/oracle-store/*.json files) and joins
 *  them. Kept separate from backtestLowScoringThresholds.ts so the grid-search
 *  logic itself stays a pure, easily-testable function. */
import { MemoryAdapter, STORAGE_KEYS } from "@oracle/storage";
import type { AnalysisRecord, ResolutionRecord } from "../../src/types.js";
import { type JoinedRecord, joinRecords } from "./backtestLowScoringThresholds.js";

export async function loadJoinedLedger(storeDir?: string): Promise<JoinedRecord[]> {
  const storage = new MemoryAdapter(storeDir);
  const [analysisRecords, resolutionRecords] = await Promise.all([
    storage.get<AnalysisRecord[]>(STORAGE_KEYS.analysisRecords),
    storage.get<ResolutionRecord[]>(STORAGE_KEYS.resolutionRecords),
  ]);
  return joinRecords(analysisRecords ?? [], resolutionRecords ?? []);
}
