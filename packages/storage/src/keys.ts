/** Canonical storage keys — single source of truth. Maps to the existing ORACLE localStorage keys
 *  so MemoryAdapter state stays compatible with pre-refactor data shapes. */
export const STORAGE_KEYS = {
  teamsElo:                'oracle_v2026_teams',
  teamsPi:                 'oracle_v2026_pi',
  calibrationLedger:       'oracle_v2026_ledger',
  ragStore:                'oracle_v2026_3_12_rag_store',
  decisionDisagreementLog: 'oracle_decision_disagreement',
  bankrollState:           'oracle_v2026_bankroll',
  // Phase 2 — scored history ledger
  analysisRecords:         'oracle_v2026_analysis',
  resolutionRecords:       'oracle_v2026_resolution',
  // §11A — run manifests
  runManifests:            'oracle_v2026_manifests',
} as const;

export type StorageKey = typeof STORAGE_KEYS[keyof typeof STORAGE_KEYS];
