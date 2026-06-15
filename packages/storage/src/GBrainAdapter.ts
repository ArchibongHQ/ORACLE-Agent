/** GBrainAdapter — PGLite-backed StoragePort for Phase 2.
 *  Local: PGLite (PostgreSQL in WASM, no server required).
 *  Schema: single kv_store table; bulkWrite uses a transaction batch for backfill efficiency.
 *  Pass no dbPath (or undefined) for a transient in-memory instance (tests). */
import { PGlite } from "@electric-sql/pglite";
import type { StoragePort } from "./StoragePort.js";

const DDL = `
  CREATE TABLE IF NOT EXISTS kv_store (
    key         TEXT    PRIMARY KEY,
    value       TEXT    NOT NULL,
    updated_at  BIGINT  DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
  );
`;

export class GBrainAdapter implements StoragePort {
  private _db: PGlite | null = null;
  /** Serialises every DB operation onto a single promise chain. PGlite is a
   *  single-threaded WASM instance and aborts (RuntimeError: Aborted) or
   *  corrupts pages if two queries overlap; the engine runs fixtures up to 8-way
   *  in parallel, so without this gate concurrent get/set/transaction calls race
   *  the one WASM heap. Every public method funnels through `_run`. */
  private _tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly _dbPath?: string) {}

  /** Chains `op` after any in-flight DB work and returns its result. A rejection
   *  in one op must not poison the queue, so the tail is reset to a settled
   *  promise regardless of outcome. */
  private _run<T>(op: (db: PGlite) => Promise<T>): Promise<T> {
    const result = this._tail.then(() => this._ensureDb()).then((db) => op(db));
    this._tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async _ensureDb(): Promise<PGlite> {
    if (!this._db) {
      this._db = this._dbPath ? new PGlite(this._dbPath) : new PGlite();
      await this._db.exec(DDL);
    }
    return this._db;
  }

  async get<T>(key: string): Promise<T | null> {
    return this._run(async (db) => {
      const result = await db.query<{ value: string }>(
        "SELECT value FROM kv_store WHERE key = $1",
        [key]
      );
      if (result.rows.length === 0) return null;
      try {
        return JSON.parse(result.rows[0]?.value) as T;
      } catch {
        return null;
      }
    });
  }

  async set<T>(key: string, value: T): Promise<void> {
    const json = JSON.stringify(value);
    await this._run((db) =>
      db.query(
        `INSERT INTO kv_store(key, value)
       VALUES($1, $2)
       ON CONFLICT(key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT`,
        [key, json]
      )
    );
  }

  async list(prefix: string): Promise<string[]> {
    return this._run(async (db) => {
      const result = await db.query<{ key: string }>(
        "SELECT key FROM kv_store WHERE key LIKE $1 || '%' ORDER BY key",
        [prefix]
      );
      return result.rows.map((r) => r.key);
    });
  }

  async query<T>(filter: (item: T) => boolean): Promise<T[]> {
    return this._run(async (db) => {
      const result = await db.query<{ value: string }>("SELECT value FROM kv_store");
      const out: T[] = [];
      for (const row of result.rows) {
        try {
          const parsed = JSON.parse(row.value) as T;
          if (filter(parsed)) out.push(parsed);
        } catch {
          // skip unparseable rows
        }
      }
      return out;
    });
  }

  /** Appends items to the JSON array stored at key, inside a single transaction. */
  async bulkWrite<T>(key: string, items: T[]): Promise<void> {
    await this._run((db) =>
      db.transaction(async (tx) => {
        const result = await tx.query<{ value: string }>(
          "SELECT value FROM kv_store WHERE key = $1",
          [key]
        );
        let existing: T[] = [];
        if (result.rows.length > 0) {
          try {
            existing = JSON.parse(result.rows[0]?.value) as T[];
          } catch {
            /* start fresh */
          }
        }
        const merged = JSON.stringify([...existing, ...items]);
        await tx.query(
          `INSERT INTO kv_store(key, value)
         VALUES($1, $2)
         ON CONFLICT(key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT`,
          [key, merged]
        );
      })
    );
  }

  async upsertBulk<T extends Record<string, unknown>>(
    key: string,
    items: T[],
    idField: keyof T
  ): Promise<void> {
    await this._run((db) =>
      db.transaction(async (tx) => {
        const result = await tx.query<{ value: string }>(
          "SELECT value FROM kv_store WHERE key = $1",
          [key]
        );
        let existing: T[] = [];
        if (result.rows.length > 0) {
          try {
            existing = JSON.parse(result.rows[0]?.value) as T[];
          } catch {
            /* start fresh */
          }
        }
        const map = new Map<unknown, T>(existing.map((item) => [item[idField], item]));
        for (const item of items) map.set(item[idField], item);
        const merged = JSON.stringify([...map.values()]);
        await tx.query(
          `INSERT INTO kv_store(key, value)
         VALUES($1, $2)
         ON CONFLICT(key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT`,
          [key, merged]
        );
      })
    );
  }

  /** Closes the underlying PGLite instance. Call in afterAll for test isolation.
   *  Queued behind in-flight ops so close never races a live query. */
  async close(): Promise<void> {
    await this._tail.catch(() => undefined);
    if (this._db) {
      await this._db.close();
      this._db = null;
    }
  }
}
