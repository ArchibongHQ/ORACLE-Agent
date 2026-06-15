import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixtureJob } from "@oracle/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enrichWithLineups } from "../src/lineups.js";

let dir: string;
let storePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oracle-lineups-"));
  storePath = join(dir, "oracle_lineups.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function job(home: string, away: string): FixtureJob {
  return { home, away, league: "EPL", kickoff: new Date().toISOString() };
}

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fixture_id: 12345,
    home: "Arsenal FC",
    away: "Chelsea FC",
    date: new Date().toISOString(),
    home_formation: "4-3-3",
    away_formation: "5-4-1",
    home_xi_confirmed: true,
    away_xi_confirmed: false,
    home_starting_xi: ["Raya", "Saliba", "Rice"],
    away_starting_xi: ["Sanchez", "Colwill"],
    ...overrides,
  };
}

describe("enrichWithLineups", () => {
  it("returns jobs unchanged when the store file is missing", async () => {
    const jobs = [job("Arsenal", "Chelsea")];
    const out = await enrichWithLineups(jobs, join(dir, "nope.json"));
    expect(out).toEqual(jobs);
  });

  it("returns jobs unchanged on invalid JSON or non-array payload", async () => {
    const jobs = [job("A", "B")];

    await writeFile(storePath, "{not json", "utf8");
    expect(await enrichWithLineups(jobs, storePath)).toEqual(jobs);

    await writeFile(storePath, JSON.stringify({ foo: 1 }), "utf8");
    expect(await enrichWithLineups(jobs, storePath)).toEqual(jobs);
  });

  it("merges lineup soft context for a name-matched fixture", async () => {
    await writeFile(storePath, JSON.stringify([summary()]), "utf8");
    const out = await enrichWithLineups([job("Arsenal", "Chelsea")], storePath);

    const soft = out[0]?.state?.telemetry?.softContext as Array<Record<string, unknown>>;
    expect(soft).toHaveLength(2);
    expect(soft[0]).toMatchObject({ kind: "lineup", source: "api-football-lineups" });
    expect(soft[0]?.text).toContain("formation 4-3-3");
    expect(soft[0]?.text).toContain("confirmed XI — Raya, Saliba, Rice");
    expect(soft[1]?.text).toContain("expected XI — Sanchez, Colwill");
  });

  it("preserves existing soft context and appends lineup items", async () => {
    await writeFile(storePath, JSON.stringify([summary()]), "utf8");
    const existing = {
      kind: "news",
      text: "prior item",
      source: "test",
      observedAt: new Date().toISOString(),
    };
    const seeded: FixtureJob = {
      ...job("Arsenal", "Chelsea"),
      state: { telemetry: { softContext: [existing] } },
    };
    const out = await enrichWithLineups([seeded], storePath);

    const soft = out[0]?.state?.telemetry?.softContext as Array<Record<string, unknown>>;
    expect(soft).toHaveLength(3);
    expect(soft[0]).toEqual(existing);
  });

  it("leaves non-matching fixtures untouched", async () => {
    await writeFile(storePath, JSON.stringify([summary()]), "utf8");
    const other = job("Liverpool", "Everton");
    const out = await enrichWithLineups([other], storePath);
    expect(out[0]).toEqual(other);
  });

  it("ignores stale summaries (fixture date >36h away)", async () => {
    const stale = summary({ date: new Date(Date.now() - 48 * 3_600_000).toISOString() });
    await writeFile(storePath, JSON.stringify([stale]), "utf8");
    const out = await enrichWithLineups([job("Arsenal", "Chelsea")], storePath);
    expect(out[0]?.state?.telemetry?.softContext).toBeUndefined();
  });

  it("skips summaries with no formation and no XI", async () => {
    const empty = summary({
      home_formation: "",
      away_formation: "",
      home_starting_xi: [],
      away_starting_xi: [],
    });
    await writeFile(storePath, JSON.stringify([empty]), "utf8");
    const out = await enrichWithLineups([job("Arsenal", "Chelsea")], storePath);
    expect(out[0]?.state?.telemetry?.softContext).toBeUndefined();
  });
});
