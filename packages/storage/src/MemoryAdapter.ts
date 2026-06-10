import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StoragePort } from "./StoragePort.js";

const DEFAULT_STORE_DIR = ".tmp/oracle-store";

function keyToPath(key: string, storeDir: string): string {
  return join(storeDir, `${key.replace(/[^a-z0-9_-]/gi, "_")}.json`);
}

async function ensureDir(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

/** Phase 0-1 default adapter. Reads/writes JSON files under storeDir/{key}.json.
 *  Stateless across calls — each get reads from disk, each set overwrites. */
export class MemoryAdapter implements StoragePort {
  private readonly _storeDir: string;

  constructor(storeDir?: string) {
    this._storeDir = storeDir ?? DEFAULT_STORE_DIR;
  }

  async get<T>(key: string): Promise<T | null> {
    const p = keyToPath(key, this._storeDir);
    try {
      const raw = await readFile(p, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const p = keyToPath(key, this._storeDir);
    await ensureDir(p);
    await writeFile(p, JSON.stringify(value, null, 2), "utf8");
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const files = await readdir(this._storeDir);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
        .filter((k) => k.startsWith(prefix));
    } catch {
      return [];
    }
  }

  async query<T>(filter: (item: T) => boolean): Promise<T[]> {
    const keys = await this.list("");
    const items = (await Promise.all(keys.map((key) => this.get<T>(key)))) as (T | null)[];
    return items.filter((item): item is T => item !== null && filter(item));
  }

  async bulkWrite<T>(key: string, items: T[]): Promise<void> {
    const existing = (await this.get<T[]>(key)) ?? [];
    await this.set(key, [...existing, ...items]);
  }

  async upsertBulk<T extends Record<string, unknown>>(
    key: string,
    items: T[],
    idField: keyof T
  ): Promise<void> {
    const existing = (await this.get<T[]>(key)) ?? [];
    const map = new Map<unknown, T>(existing.map((item) => [item[idField], item]));
    for (const item of items) map.set(item[idField], item);
    await this.set(key, [...map.values()]);
  }
}
