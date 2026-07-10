/** ratings/index.ts — TeamRatingsEngine pi-rating sample-count tracking (Wave
 *  2 WS2-B) + the ratingsXgd/buildRatingsLambdaInput derivation glue. */

import { buildRatingsLambdaInput, ratingsXgd, TeamRatingsEngine } from "@oracle/engine";
import type { StoragePort } from "@oracle/storage";
import { beforeEach, describe, expect, it } from "vitest";

/** Minimal in-memory StoragePort test double — no disk I/O, no shared state
 *  across tests. Only the methods TeamRatingsEngine actually calls (get/set)
 *  need real behavior; the rest just satisfy the interface. */
class InMemoryStorage implements StoragePort {
  private _store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return (this._store.get(key) as T | undefined) ?? null;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this._store.set(key, value);
  }
  async list(): Promise<string[]> {
    return [...this._store.keys()];
  }
  async query<T>(filter: (item: T) => boolean): Promise<T[]> {
    return [...this._store.values()].filter((v) => filter(v as T)) as T[];
  }
  async bulkWrite<T>(key: string, items: T[]): Promise<void> {
    const existing = ((await this.get<T[]>(key)) ?? []).concat(items);
    await this.set(key, existing);
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

describe("TeamRatingsEngine — pi-rating sample-count (n) tracking (Wave 2 WS2-B)", () => {
  let storage: InMemoryStorage;
  let engine: TeamRatingsEngine;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    engine = new TeamRatingsEngine(storage);
    await engine.hydrate();
  });

  it("getPiN defaults to 0 for a team never updated", () => {
    expect(engine.getPiN("Nowhere FC")).toBe(0);
  });

  it("increments n for BOTH teams on every updatePi call", () => {
    engine.updatePi("Home FC", "Away FC", 2, 1);
    expect(engine.getPiN("Home FC")).toBe(1);
    expect(engine.getPiN("Away FC")).toBe(1);
    engine.updatePi("Home FC", "Away FC", 0, 0);
    expect(engine.getPiN("Home FC")).toBe(2);
    expect(engine.getPiN("Away FC")).toBe(2);
  });

  it("tracks n independently per team across different fixtures", () => {
    engine.updatePi("Home FC", "Away FC", 2, 1);
    engine.updatePi("Home FC", "Third FC", 1, 1);
    expect(engine.getPiN("Home FC")).toBe(2);
    expect(engine.getPiN("Away FC")).toBe(1);
    expect(engine.getPiN("Third FC")).toBe(1);
  });

  it("round-trips n through persist/hydrate", async () => {
    engine.updatePi("Home FC", "Away FC", 2, 0);
    engine.updatePi("Home FC", "Away FC", 1, 1);
    await engine.persist();

    const rehydrated = new TeamRatingsEngine(storage);
    await rehydrated.hydrate();
    expect(rehydrated.getPiN("Home FC")).toBe(2);
    expect(rehydrated.getPiN("Away FC")).toBe(2);
    // Ratings themselves also round-trip (sanity — not the focus of this file).
    expect(rehydrated.getPiRating("Home FC", "home")).toBeCloseTo(
      engine.getPiRating("Home FC", "home"),
      10
    );
  });

  it("does not crash on pre-Wave-2 persisted data with no n field at all — defaults to 0", async () => {
    // Simulate a store written before this Wave (no `n` key whatsoever).
    await storage.set("oracle_v2026_pi", {
      "home fc": { home: 0.42, away: -0.1 },
    });
    const legacy = new TeamRatingsEngine(storage);
    await legacy.hydrate();
    expect(legacy.getPiN("Home FC")).toBe(0);
    // getPiRating must also still work unaffected.
    expect(legacy.getPiRating("Home FC", "home")).toBeCloseTo(0.42, 10);

    // And a further updatePi on that legacy entry must not throw, and must
    // start counting from 0 (not NaN / not crash on the missing field).
    legacy.updatePi("Home FC", "Away FC", 1, 0);
    expect(legacy.getPiN("Home FC")).toBe(1);
    expect(legacy.getPiN("Away FC")).toBe(1);
  });
});

describe("ratingsXgd (Wave 2 WS2-B)", () => {
  it("is 0 when both teams have identical pi-ratings", () => {
    expect(ratingsXgd(0.3, 0.3)).toBe(0);
  });

  it("is positive when the home team's pi-rating is higher (home expected stronger)", () => {
    expect(ratingsXgd(0.6, 0.1)).toBeGreaterThan(0);
  });

  it("is negative when the away team's pi-rating is higher", () => {
    expect(ratingsXgd(0.1, 0.6)).toBeLessThan(0);
  });

  it("reuses the exact /3 tanh normalization updatePi uses internally", () => {
    const homePi = 0.5;
    const awayPi = -0.2;
    expect(ratingsXgd(homePi, awayPi)).toBeCloseTo(Math.tanh((homePi - awayPi) / 3), 12);
  });

  it("is bounded in (-1, 1) — tanh-compressed, never an unbounded raw difference", () => {
    // tanh(4) ≈ 0.9993 — large enough to be near-saturated, small enough
    // that float precision doesn't round the result all the way to 1.0
    // (unlike an extreme input like ±100, where tanh saturates to exactly
    // 1.0 in double precision and the "< 1" assertion would flake).
    expect(ratingsXgd(6, -6)).toBeLessThan(1);
    expect(ratingsXgd(6, -6)).toBeGreaterThan(0.99);
    expect(ratingsXgd(-6, 6)).toBeGreaterThan(-1);
    expect(ratingsXgd(-6, 6)).toBeLessThan(-0.99);
  });
});

describe("buildRatingsLambdaInput (Wave 2 WS2-B integration glue)", () => {
  let storage: InMemoryStorage;
  let engine: TeamRatingsEngine;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    engine = new TeamRatingsEngine(storage);
    await engine.hydrate();
  });

  it("returns ratingsXgd=0 and ratingsN=0 for two never-seen teams", () => {
    const result = buildRatingsLambdaInput(engine, "Ghost FC", "Phantom FC");
    expect(result.ratingsXgd).toBe(0);
    expect(result.ratingsN).toBe(0);
  });

  it("derives ratingsXgd from the engine's own getPiRating(home,'home')/getPiRating(away,'away')", () => {
    engine.updatePi("Home FC", "Away FC", 3, 0); // pushes Home FC's rating up, Away FC's down
    engine.updatePi("Home FC", "Away FC", 3, 0);
    engine.updatePi("Home FC", "Away FC", 3, 0);
    const result = buildRatingsLambdaInput(engine, "Home FC", "Away FC");
    const expected = ratingsXgd(
      engine.getPiRating("Home FC", "home"),
      engine.getPiRating("Away FC", "away")
    );
    expect(result.ratingsXgd).toBeCloseTo(expected, 12);
    expect(result.ratingsXgd).toBeGreaterThan(0); // home has consistently won big
  });

  it("ratingsN is the MIN of both teams' n, not the max or sum", () => {
    engine.updatePi("Home FC", "Away FC", 1, 1); // both n=1
    engine.updatePi("Home FC", "Third FC", 1, 1); // Home FC n=2, Third FC n=1
    const result = buildRatingsLambdaInput(engine, "Home FC", "Third FC");
    expect(result.ratingsN).toBe(1); // min(2, 1)
  });
});
