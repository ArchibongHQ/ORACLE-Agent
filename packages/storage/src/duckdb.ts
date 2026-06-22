/** Shared lazy DuckDB-over-Parquet query helper.
 *
 *  @duckdb/node-api ships prebuilt native bindings (no node-gyp compile step),
 *  but a native module can still fail to load on an unsupported platform/ABI.
 *  Loaded via dynamic import so that failure degrades to null, never throws —
 *  every caller (DuckDbAdapter.ts here, @oracle/runtime's dailyStore.ts) fails
 *  open to its existing JSON/live path on any null.
 *
 *  One in-memory DuckDB instance is reused across calls in this process — the
 *  workload is read-mostly small local Parquet scans, so paying the instance
 *  startup cost once is worth it; each query still gets its own connection. */
import type { DuckDBInstance } from "@duckdb/node-api";

let instancePromise: Promise<DuckDBInstance | null> | null = null;

async function getInstance(): Promise<DuckDBInstance | null> {
  if (!instancePromise) {
    instancePromise = (async () => {
      try {
        const mod = await import("@duckdb/node-api");
        return await mod.DuckDBInstance.create(":memory:");
      } catch {
        return null;
      }
    })();
  }
  return instancePromise;
}

/** Escape a path for embedding as a SQL string literal. Project-controlled
 *  local paths only (never user input) — this only needs to handle the stray
 *  apostrophe, not a general SQL-injection threat model. */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** Run a read-only SQL query and return rows as plain JS objects.
 *  Returns null on ANY failure (native load, connect, parse, missing file) —
 *  callers must treat null as "lake unavailable" and fail open. An empty
 *  array is a real, successful empty result, distinct from null. */
export async function queryParquetRows<T = Record<string, unknown>>(
  sql: string
): Promise<T[] | null> {
  try {
    const instance = await getInstance();
    if (!instance) return null;
    const conn = await instance.connect();
    try {
      const reader = await conn.runAndReadAll(sql);
      return reader.getRowObjectsJS() as T[];
    } finally {
      conn.closeSync();
    }
  } catch {
    return null;
  }
}
