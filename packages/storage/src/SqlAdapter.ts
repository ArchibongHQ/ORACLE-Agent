/** SqlAdapter — plain-Postgres StoragePort fallback (PRD §10).
 *  Implements the same kv_store schema as GBrainAdapter but targets a real Postgres server.
 *  Uses an injected query function to avoid a hard dependency on any specific pg client:
 *
 *    import { Pool } from 'pg';
 *    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *    const adapter = new SqlAdapter((sql, params) => pool.query(sql, params));
 *
 *  Compatible with `pg`, `postgres`, `@neondatabase/serverless`, etc. */
import type { StoragePort } from "./StoragePort.js";

export type SqlQueryFn = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: Record<string, unknown>[] }>;

const DDL = `
  CREATE TABLE IF NOT EXISTS kv_store (
    key         TEXT    PRIMARY KEY,
    value       TEXT    NOT NULL,
    updated_at  BIGINT  DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
  );
`;

export class SqlAdapter implements StoragePort {
  private _initialized = false;

  constructor(private readonly _query: SqlQueryFn) {}

  private async _ensureSchema(): Promise<void> {
    if (this._initialized) return;
    await this._query(DDL);
    this._initialized = true;
  }

  async get<T>(key: string): Promise<T | null> {
    await this._ensureSchema();
    const { rows } = await this._query("SELECT value FROM kv_store WHERE key = $1", [key]);
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0]?.value as string) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this._ensureSchema();
    await this._query(
      `INSERT INTO kv_store(key, value)
       VALUES($1, $2)
       ON CONFLICT(key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT`,
      [key, JSON.stringify(value)]
    );
  }

  async list(prefix: string): Promise<string[]> {
    await this._ensureSchema();
    const { rows } = await this._query(
      "SELECT key FROM kv_store WHERE key LIKE $1 || '%' ORDER BY key",
      [prefix]
    );
    return rows.map((r) => r.key as string);
  }

  async query<T>(filter: (item: T) => boolean): Promise<T[]> {
    await this._ensureSchema();
    const { rows } = await this._query("SELECT value FROM kv_store");
    const out: T[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value as string) as T;
        if (filter(parsed)) out.push(parsed);
      } catch {
        /* skip unparseable rows */
      }
    }
    return out;
  }

  async bulkWrite<T>(key: string, items: T[]): Promise<void> {
    await this._ensureSchema();
    const existing = (await this.get<T[]>(key)) ?? [];
    await this.set(key, [...existing, ...items]);
  }

  async upsertBulk<T extends Record<string, unknown>>(
    key: string,
    items: T[],
    idField: keyof T
  ): Promise<void> {
    await this._ensureSchema();
    const existing = (await this.get<T[]>(key)) ?? [];
    const map = new Map<unknown, T>(existing.map((item) => [item[idField], item]));
    for (const item of items) map.set(item[idField], item);
    await this.set(key, [...map.values()]);
  }
}
