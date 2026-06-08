/** The ONLY persistence contract for @oracle/engine. No engine module imports a concrete adapter. */
export interface StoragePort {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  list(prefix: string): Promise<string[]>;
  query<T>(filter: (item: T) => boolean): Promise<T[]>;
  /** Batch-insert path used by the §8.7 historical backfill harness. */
  bulkWrite<T>(key: string, items: T[]): Promise<void>;
  /** Upsert items into the array at key, deduplicating by idField (PRD §11A.3).
   *  Existing items whose idField value matches a new item are replaced; new items are appended. */
  upsertBulk<T extends Record<string, unknown>>(
    key: string,
    items: T[],
    idField: keyof T
  ): Promise<void>;
}
