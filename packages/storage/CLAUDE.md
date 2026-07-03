# @oracle/storage

Persistence layer implementing a single `StoragePort` interface with multiple backends: in-memory (tests), DuckDB (Parquet/analytics), SQL adapter, and PGLite-based `GBrainAdapter` (the primary local "gbrain" store).

- **Entry points:** `src/index.ts`, `src/StoragePort.ts` (the contract), `src/GBrainAdapter.ts`, `src/DuckDbAdapter.ts`, `src/SqlAdapter.ts`, `src/MemoryAdapter.ts`.
- **Key exports:** `StoragePort` (interface), `GBrainAdapter`, `DuckDbAdapter`, `SqlAdapter`, `MemoryAdapter`, `STORAGE_KEYS`, `withKeyLock`/`_resetKeyLocks`, `queryParquetRows`/`escapeSqlLiteral`. Consumed by `@oracle/engine`, `@oracle/runtime`, `apps/web`, `apps/cli`.
- **Test command:** `test` uses `--config vitest.config.ts` explicitly (differs from other packages' plain `vitest run`).

**Gotcha:** `StoragePort` is the ONLY persistence contract for `@oracle/engine` — always code against the interface, never a concrete adapter. `GBrainAdapter` (PGLite/WASM) serializes every DB op onto a single promise chain because PGLite is single-threaded WASM and aborts/corrupts pages if two queries overlap — do not bypass that serialization.
