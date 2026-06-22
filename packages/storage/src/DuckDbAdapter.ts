import { join } from "node:path";
import { escapeSqlLiteral, queryParquetRows } from "./duckdb.js";
import { MemoryAdapter } from "./MemoryAdapter.js";
import type { StoragePort } from "./StoragePort.js";

const DEFAULT_PARQUET_DIR = ".tmp/oracle-store-parquet";

function keyToParquetPath(key: string, dir: string): string {
  return join(dir, `${key.replace(/[^a-z0-9_-]/gi, "_")}.parquet`);
}

/** StoragePort backed by DuckDB-over-Parquet for durable, queryable reads.
 *
 *  Phase A reality: nothing writes Parquet under `parquetDir` yet — set/
 *  bulkWrite/upsertBulk delegate straight to the composed MemoryAdapter (JSON
 *  files), unchanged. get/list/query check for a Parquet file behind `key`
 *  first and fall open to that same MemoryAdapter on any miss/native-load
 *  failure, so in Phase A this behaves identically to a plain MemoryAdapter
 *  plus one harmless failed lookup per call. Broadening this to actually write
 *  Parquet from the engine's durable path is Phase C scope (see the latency
 *  overhaul plan) — this class exists now so that read path is ready. */
export class DuckDbAdapter implements StoragePort {
  private readonly _memory: MemoryAdapter;
  private readonly _parquetDir: string;

  constructor(opts: { parquetDir?: string; memory?: MemoryAdapter } = {}) {
    this._parquetDir = opts.parquetDir ?? DEFAULT_PARQUET_DIR;
    this._memory = opts.memory ?? new MemoryAdapter();
  }

  async get<T>(key: string): Promise<T | null> {
    const path = keyToParquetPath(key, this._parquetDir);
    const rows = await queryParquetRows(`SELECT * FROM read_parquet('${escapeSqlLiteral(path)}')`);
    if (rows && rows.length > 0) return rows as unknown as T;
    return this._memory.get<T>(key);
  }

  async set<T>(key: string, value: T): Promise<void> {
    return this._memory.set(key, value);
  }

  async list(prefix: string): Promise<string[]> {
    return this._memory.list(prefix);
  }

  async query<T>(filter: (item: T) => boolean): Promise<T[]> {
    return this._memory.query(filter);
  }

  async bulkWrite<T>(key: string, items: T[]): Promise<void> {
    return this._memory.bulkWrite(key, items);
  }

  async upsertBulk<T extends Record<string, unknown>>(
    key: string,
    items: T[],
    idField: keyof T
  ): Promise<void> {
    return this._memory.upsertBulk(key, items, idField);
  }
}
