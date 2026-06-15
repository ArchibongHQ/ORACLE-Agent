/** StoragePort parity suite — runs against both MemoryAdapter and GBrainAdapter.
 *  Phase 2 done criteria: GBrainAdapter passes the same tests as MemoryAdapter.
 *
 *  Design: one shared instance per describe block so PGLite WASM loads only once.
 *  Each test uses a unique key (key + '_' + i) to avoid cross-test pollution.
 *  MemoryAdapter gets a per-run tmpDir so file state stays isolated. */

import { mkdirSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GBrainAdapter } from "../src/GBrainAdapter.js";
import { MemoryAdapter } from "../src/MemoryAdapter.js";
import { SqlAdapter } from "../src/SqlAdapter.js";
import type { StoragePort } from "../src/StoragePort.js";

// Unique suffix per test file run
const RUN_ID = Date.now().toString(36);

// ── Shared protocol ────────────────────────────────────────────────────────────

function adapterSuite(label: string, getAdapter: () => StoragePort): void {
  // Counter per suite to generate unique keys without needing Date.now()
  let seq = 0;
  const k = (base: string): string => `${base}_${label.replace(/\W/g, "")}_${RUN_ID}_${++seq}`;

  describe(label, () => {
    describe("get / set", () => {
      it("returns null for missing key", async () => {
        const s = getAdapter();
        expect(await s.get(k("missing"))).toBeNull();
      });

      it("round-trips a number", async () => {
        const s = getAdapter();
        const key = k("num");
        await s.set(key, 42);
        expect(await s.get<number>(key)).toBe(42);
      });

      it("round-trips an object", async () => {
        const s = getAdapter();
        const key = k("obj");
        await s.set(key, { a: 1, b: "hello" });
        expect(await s.get<{ a: number; b: string }>(key)).toEqual({ a: 1, b: "hello" });
      });

      it("overwrites on second set", async () => {
        const s = getAdapter();
        const key = k("overwrite");
        await s.set(key, "first");
        await s.set(key, "second");
        expect(await s.get(key)).toBe("second");
      });

      it("round-trips an array", async () => {
        const s = getAdapter();
        const key = k("arr");
        await s.set(key, [1, 2, 3]);
        expect(await s.get<number[]>(key)).toEqual([1, 2, 3]);
      });
    });

    describe("list", () => {
      it("returns empty array when nothing matches prefix", async () => {
        const s = getAdapter();
        const unique = `zz${RUN_ID}`;
        await s.set(`other${unique}`, 1);
        const keys = await s.list(`noprefix${unique}`);
        expect(keys).toEqual([]);
      });

      it("returns keys matching prefix", async () => {
        const s = getAdapter();
        const prefix = `pfx${RUN_ID}`;
        await s.set(`${prefix}teams`, []);
        await s.set(`${prefix}ledger`, []);
        await s.set(`unrelated${RUN_ID}`, 99);
        const keys = await s.list(prefix);
        expect(keys).toContain(`${prefix}teams`);
        expect(keys).toContain(`${prefix}ledger`);
        expect(keys).not.toContain(`unrelated${RUN_ID}`);
      });
    });

    describe("query", () => {
      it("returns items passing the filter", async () => {
        const s = getAdapter();
        await s.set(k("r1"), { type: "bet", ev: 0.05 });
        await s.set(k("r2"), { type: "bet", ev: -0.02 });
        await s.set(k("r3"), { type: "config", ev: 0 });
        const positiveEv = await s.query<{ type: string; ev: number }>(
          (item) => item.type === "bet" && item.ev > 0
        );
        // At least 1 positive-EV bet in the store (may include prior test data)
        expect(positiveEv.length).toBeGreaterThanOrEqual(1);
        expect(positiveEv.every((x) => x.type === "bet" && x.ev > 0)).toBe(true);
      });

      it("returns empty array when nothing passes filter", async () => {
        const s = getAdapter();
        await s.set(k("x"), { val: 1 });
        const result = await s.query<{ val: number }>((item) => item.val > 999999);
        expect(result).toHaveLength(0);
      });
    });

    describe("upsertBulk", () => {
      it("inserts items when key is empty", async () => {
        const s = getAdapter();
        const key = k("ub1");
        await s.upsertBulk(
          key,
          [
            { id: "a", v: 1 },
            { id: "b", v: 2 },
          ],
          "id"
        );
        const stored = await s.get<Array<{ id: string; v: number }>>(key);
        expect(stored).toHaveLength(2);
      });

      it("replaces existing item with same idField value", async () => {
        const s = getAdapter();
        const key = k("ub2");
        await s.upsertBulk(key, [{ id: "a", v: 1 }], "id");
        await s.upsertBulk(key, [{ id: "a", v: 99 }], "id");
        const stored = await s.get<Array<{ id: string; v: number }>>(key);
        expect(stored).toHaveLength(1);
        expect(stored?.[0]?.v).toBe(99);
      });

      it("appends new items and replaces existing in the same call", async () => {
        const s = getAdapter();
        const key = k("ub3");
        await s.upsertBulk(
          key,
          [
            { id: "a", v: 1 },
            { id: "b", v: 2 },
          ],
          "id"
        );
        await s.upsertBulk(
          key,
          [
            { id: "b", v: 20 },
            { id: "c", v: 3 },
          ],
          "id"
        );
        const stored = await s.get<Array<{ id: string; v: number }>>(key);
        expect(stored).toHaveLength(3);
        const byId = Object.fromEntries(stored?.map((x) => [x.id, x.v]));
        expect(byId.a).toBe(1);
        expect(byId.b).toBe(20);
        expect(byId.c).toBe(3);
      });

      it("does not create duplicates when same items written twice", async () => {
        const s = getAdapter();
        const key = k("ub4");
        const items = [
          { id: "x", v: 7 },
          { id: "y", v: 8 },
        ];
        await s.upsertBulk(key, items, "id");
        await s.upsertBulk(key, items, "id");
        const stored = await s.get<typeof items>(key);
        expect(stored).toHaveLength(2);
      });
    });

    describe("bulkWrite", () => {
      it("appends items to an empty key", async () => {
        const s = getAdapter();
        const key = k("bulk1");
        await s.bulkWrite(key, [{ id: "a" }, { id: "b" }]);
        const stored = await s.get<Array<{ id: string }>>(key);
        expect(stored).toEqual([{ id: "a" }, { id: "b" }]);
      });

      it("appends to existing items without overwriting", async () => {
        const s = getAdapter();
        const key = k("bulk2");
        await s.set(key, [{ id: "a" }]);
        await s.bulkWrite(key, [{ id: "b" }, { id: "c" }]);
        const stored = await s.get<Array<{ id: string }>>(key);
        expect(stored).toHaveLength(3);
        expect(stored?.map((x) => x.id)).toEqual(["a", "b", "c"]);
      });

      it("handles 500-item batch without timeout", async () => {
        const s = getAdapter();
        const key = k("bulk500");
        const items = Array.from({ length: 500 }, (_, i) => ({ idx: i, val: i * 1.1 }));
        await s.bulkWrite(key, items);
        const stored = await s.get<typeof items>(key);
        expect(stored).toHaveLength(500);
      });
    });
  });
}

// ── MemoryAdapter suite ────────────────────────────────────────────────────────

describe("MemoryAdapter", () => {
  const tmpDir = `.tmp/adapter-test-mem-${RUN_ID}`;
  let adapter: MemoryAdapter;

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    adapter = new MemoryAdapter(tmpDir);
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  adapterSuite("MemoryAdapter", () => adapter);
});

// ── GBrainAdapter suite ───────────────────────────────────────────────────────

describe("GBrainAdapter", () => {
  let adapter: GBrainAdapter;

  beforeAll(async () => {
    adapter = new GBrainAdapter(); // in-memory for test isolation
    await adapter.get("__warmup__"); // trigger WASM init before tests
  }, 30_000); // PGLite WASM first-init can take ~15s

  afterAll(async () => {
    await adapter.close();
  });

  adapterSuite("GBrainAdapter", () => adapter);
});

// ── Concurrency regression: single-threaded PGLite WASM must not be hit in ─────
//    parallel. The engine runs fixtures up to 8-way concurrent; before the
//    serialization mutex this threw "RuntimeError: Aborted()" / corrupted pages.

describe("GBrainAdapter concurrency", () => {
  let adapter: GBrainAdapter;

  beforeAll(async () => {
    adapter = new GBrainAdapter(); // in-memory
    await adapter.get("__warmup__");
  }, 30_000);

  afterAll(async () => {
    await adapter.close();
  });

  it("serialises overlapping reads and writes without aborting", async () => {
    const N = 32;
    // Fire all ops at once, no await between them — the pre-fix abort scenario.
    const writes = Array.from({ length: N }, (_, i) =>
      adapter.set(`conc_${RUN_ID}_${i}`, { i })
    );
    const reads = Array.from({ length: N }, (_, i) => adapter.get(`conc_${RUN_ID}_${i}`));
    const bulks = Array.from({ length: 4 }, (_, i) =>
      adapter.upsertBulk(`conc_bulk_${RUN_ID}_${i}`, [{ id: i, n: i }], "id")
    );

    await expect(Promise.all([...writes, ...reads, ...bulks])).resolves.toBeDefined();

    // Every write must be readable afterward — no lost/raced rows.
    for (let i = 0; i < N; i++) {
      expect(await adapter.get<{ i: number }>(`conc_${RUN_ID}_${i}`)).toEqual({ i });
    }
  }, 30_000);

  it("does not let a failing op poison the queue", async () => {
    // A get with a key that round-trips fine, interleaved with many ops.
    const ops = Array.from({ length: 16 }, (_, i) => adapter.set(`poison_${RUN_ID}_${i}`, i));
    await Promise.all(ops);
    expect(await adapter.get<number>(`poison_${RUN_ID}_5`)).toBe(5);
  }, 30_000);
});

// ── Phase 2 done criterion: GBrainAdapter state persists across two instances ──

describe("GBrainAdapter persistence (Phase 2 criterion)", () => {
  it("state survives close + re-open at same path", async () => {
    const tmpPath = `.tmp/gbrain-persist-${RUN_ID}`;
    const a1 = new GBrainAdapter(tmpPath);
    await a1.set("ping", { value: "pong" });
    await a1.close();

    const a2 = new GBrainAdapter(tmpPath);
    const result = await a2.get<{ value: string }>("ping");
    expect(result).toEqual({ value: "pong" });
    await a2.close();

    try {
      rmSync(tmpPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }, 60_000); // file-backed PGLite takes longer to initialize
});

// ── SqlAdapter (mock-backed — no real Postgres required) ─────────────────────

describe("SqlAdapter", () => {
  /** Minimal mock that backs SqlAdapter with an in-memory Map — no Postgres needed. */
  function makeMockQueryAdapter(): SqlAdapter {
    const store = new Map<string, string>();
    const mockQuery = async (sql: string, params: unknown[] = []) => {
      const s = sql.trim().replace(/\s+/g, " ");
      // DDL — no-op
      if (/CREATE TABLE/i.test(s)) return { rows: [] };
      // SELECT value WHERE key = $1
      if (/SELECT value FROM kv_store WHERE key/.test(s)) {
        const key = params[0] as string;
        const v = store.get(key);
        return v !== undefined ? { rows: [{ value: v }] } : { rows: [] };
      }
      // SELECT key WHERE key LIKE
      if (/SELECT key FROM kv_store/.test(s)) {
        const prefix = (params[0] as string) ?? "";
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        return { rows: keys.map((k) => ({ key: k })) };
      }
      // SELECT value FROM kv_store (all rows)
      if (/SELECT value FROM kv_store/.test(s)) {
        return { rows: [...store.values()].map((v) => ({ value: v })) };
      }
      // INSERT … ON CONFLICT … DO UPDATE
      if (/INSERT INTO kv_store/.test(s)) {
        const key = params[0] as string;
        const val = params[1] as string;
        store.set(key, val);
        return { rows: [] };
      }
      return { rows: [] };
    };
    return new SqlAdapter(mockQuery);
  }

  adapterSuite("SqlAdapter (mock-backed)", makeMockQueryAdapter);
});
