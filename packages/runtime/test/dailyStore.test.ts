/** Tests for dailyStore.ts — the Parquet-lake reader for the 00:00 acquisition
 *  snapshot. queryParquetRows is mocked at module level (the DuckDB native-
 *  binding plumbing itself lives in @oracle/storage's duckdb.ts); this suite
 *  covers dailyStore's own row-unflattening + memoization + fail-open
 *  behavior, mirroring how sidecarFetch.test.ts mocks readFile. */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@oracle/storage", () => ({
  queryParquetRows: vi.fn(),
  escapeSqlLiteral: (s: string) => s.replace(/'/g, "''"),
}));

const { queryParquetRows } = await import("@oracle/storage");
const { loadDailyFixtures, loadDailyOdds, loadDailyNews, teamSlug, _resetDailyStoreCache } =
  await import("../src/dailyStore.js");
const { sidecarKey } = await import("../src/selectFixtures.js");

const DT = "2026-06-21";

const FIXTURE_ROWS = [
  {
    event_id: "sr:match:1",
    home: "Germany",
    away: "Ivory Coast",
    league: "FIFA World Cup",
    kickoff_utc: "2026-06-21T18:00:00Z",
    market_count: 1101,
  },
];

const ODDS_ROWS = [
  { event_id: "sr:match:1", market: "1x2", side: "home", price: 1.76, overround: null },
  { event_id: "sr:match:1", market: "1x2", side: "draw", price: 3.4, overround: null },
  { event_id: "sr:match:1", market: "1x2", side: "away", price: 5.5, overround: null },
  { event_id: "sr:match:1", market: "ah", side: "home", price: 1.9, overround: -0.5 },
  { event_id: "sr:match:1", market: "ah", side: "away", price: 1.95, overround: -0.5 },
];

const STATS_ROWS = [
  {
    event_id: "sr:match:1",
    subtab: "form",
    payload_json: JSON.stringify({ home: { w: 3, d: 1, l: 1 } }),
  },
  {
    event_id: "sr:match:1",
    subtab: "commentary",
    payload_json: JSON.stringify(["Germany have a winning streak of 10 matches."]),
  },
  {
    event_id: "sr:match:1",
    subtab: "statscoverage",
    payload_json: JSON.stringify({ leaguetable: true }),
  },
];

function mockThreeQueries(fixtures: unknown[] | null, odds: unknown[] = [], stats: unknown[] = []) {
  const mocked = vi.mocked(queryParquetRows);
  mocked.mockResolvedValueOnce(fixtures);
  if (fixtures !== null) {
    mocked.mockResolvedValueOnce(odds);
    mocked.mockResolvedValueOnce(stats);
  }
}

afterEach(() => {
  vi.clearAllMocks();
  _resetDailyStoreCache();
});

describe("loadDailyFixtures", () => {
  it("returns null when the fixtures partition is missing (fail-open)", async () => {
    mockThreeQueries(null);
    expect(await loadDailyFixtures(DT)).toBeNull();
  });

  it("returns a valid empty index when the partition exists but has zero fixtures", async () => {
    mockThreeQueries([]);
    const idx = await loadDailyFixtures(DT);
    expect(idx).not.toBeNull();
    expect(idx!.events).toHaveLength(0);
    expect(idx!.byKey.size).toBe(0);
  });

  it("assembles a SportyBetIndex from fixtures+odds+stats rows", async () => {
    mockThreeQueries(FIXTURE_ROWS, ODDS_ROWS, STATS_ROWS);
    const idx = await loadDailyFixtures(DT);
    expect(idx).not.toBeNull();
    expect(idx!.date).toBe(DT);
    expect(idx!.events).toHaveLength(1);

    const key = sidecarKey("Germany", "Ivory Coast");
    expect(idx!.byKey.get(key)).toBe(1101);

    const detail = idx!.detailByKey.get(key);
    expect(detail).toBeDefined();
    expect(detail!.eventId).toBe("sr:match:1");
    expect(detail!.odds?.["1x2"]).toEqual({ home: 1.76, draw: 3.4, away: 5.5 });
    expect(detail!.odds?.ah).toEqual({ home: 1.9, away: 1.95, line: -0.5 });
    expect(detail!.stats?.form?.home?.w).toBe(3);
    expect(detail!.stats?.commentary).toEqual(["Germany have a winning streak of 10 matches."]);
    expect(detail!.statscoverage).toEqual({ leaguetable: true });
  });

  it("skips a fixture row with a blank team name instead of throwing", async () => {
    mockThreeQueries([{ ...FIXTURE_ROWS[0], home: "" }], [], []);
    const idx = await loadDailyFixtures(DT);
    expect(idx!.events).toHaveLength(0);
  });

  it("memoizes per date — a second call for the same dt does not re-query", async () => {
    mockThreeQueries(FIXTURE_ROWS, ODDS_ROWS, STATS_ROWS);
    await loadDailyFixtures(DT);
    await loadDailyFixtures(DT);
    expect(vi.mocked(queryParquetRows)).toHaveBeenCalledTimes(3); // fixtures+odds+stats once, not six times
  });

  it("does not memoize a zero-fixture read — retries on the next call instead of poisoning the day", async () => {
    mockThreeQueries([]);
    const first = await loadDailyFixtures(DT);
    expect(first!.events).toHaveLength(0);

    mockThreeQueries(FIXTURE_ROWS, ODDS_ROWS, STATS_ROWS);
    const second = await loadDailyFixtures(DT);
    expect(second!.events).toHaveLength(1);
    // 3 (empty fixtures still queries odds+stats too — only a null fixtureRows
    // short-circuits) + 3 (fixtures+odds+stats on the retried call) = 6.
    expect(vi.mocked(queryParquetRows)).toHaveBeenCalledTimes(6);
  });

  it("does not clobber a different date's cache entry when an in-flight empty read for another date resolves late (e.g. resolve-yesterday racing daily-batch)", async () => {
    const D1 = "2026-06-20";
    const D2 = "2026-06-21";
    const mocked = vi.mocked(queryParquetRows);

    let resolveD1Fixtures!: (rows: unknown[]) => void;
    const d1FixturesPromise = new Promise<unknown[]>((resolve) => {
      resolveD1Fixtures = resolve;
    });
    // Declaration order mirrors actual invocation order: D1's fixtures query
    // is called first but stays pending, so D2's full fixtures+odds+stats
    // sequence runs to completion before D1's odds+stats are ever reached.
    mocked.mockImplementationOnce(() => d1FixturesPromise); // D1 fixtures — held pending
    mocked.mockResolvedValueOnce(FIXTURE_ROWS); // D2 fixtures
    mocked.mockResolvedValueOnce(ODDS_ROWS); // D2 odds
    mocked.mockResolvedValueOnce(STATS_ROWS); // D2 stats
    mocked.mockResolvedValueOnce([]); // D1 odds (reached once D1 unblocks)
    mocked.mockResolvedValueOnce([]); // D1 stats

    const d1Call = loadDailyFixtures(D1); // sets _cache = {dt: D1, promise: pending}

    const d2Result = await loadDailyFixtures(D2); // overwrites _cache = {dt: D2, promise: resolved}
    expect(d2Result!.events).toHaveLength(1);

    resolveD1Fixtures([]); // D1 resolves empty AFTER D2 already owns the cache slot
    const d1Result = await d1Call;
    expect(d1Result!.events).toHaveLength(0);

    // D2's cache entry must survive D1's late empty resolution — a second
    // call for D2 should hit the memo, not re-query.
    const callsBefore = mocked.mock.calls.length;
    const d2Second = await loadDailyFixtures(D2);
    expect(d2Second!.events).toHaveLength(1);
    expect(mocked.mock.calls.length).toBe(callsBefore);
  });

  it("does not memoize a null (missing-partition) read — retries on the next call", async () => {
    mockThreeQueries(null);
    expect(await loadDailyFixtures(DT)).toBeNull();

    mockThreeQueries(FIXTURE_ROWS, ODDS_ROWS, STATS_ROWS);
    const second = await loadDailyFixtures(DT);
    expect(second!.events).toHaveLength(1);
    expect(vi.mocked(queryParquetRows)).toHaveBeenCalledTimes(4); // 1 (null) + 3 (fixtures+odds+stats)
  });
});

describe("loadDailyOdds", () => {
  it("returns null when the lake is unavailable", async () => {
    mockThreeQueries(null);
    expect(await loadDailyOdds(DT, "Germany", "Ivory Coast")).toBeNull();
  });

  it("returns the matched fixture's odds block", async () => {
    mockThreeQueries(FIXTURE_ROWS, ODDS_ROWS, STATS_ROWS);
    const odds = await loadDailyOdds(DT, "Germany", "Ivory Coast");
    expect(odds?.["1x2"]?.home).toBe(1.76);
  });

  it("returns null when no fixture matches the given names", async () => {
    mockThreeQueries(FIXTURE_ROWS, ODDS_ROWS, STATS_ROWS);
    expect(await loadDailyOdds(DT, "Arsenal", "Chelsea")).toBeNull();
  });
});

describe("loadDailyNews", () => {
  it("returns null when the news partition is missing", async () => {
    vi.mocked(queryParquetRows).mockResolvedValueOnce(null);
    expect(await loadDailyNews(DT, "germany")).toBeNull();
  });

  it("maps news rows to camelCase fields", async () => {
    vi.mocked(queryParquetRows).mockResolvedValueOnce([
      {
        team_slug: "germany",
        source: "google_ai",
        summary: "no injuries reported",
        raw_json: "{}",
        scraped_at: "2026-06-21T00:00:00Z",
      },
    ]);
    const rows = await loadDailyNews(DT, "germany");
    expect(rows).toEqual([
      {
        source: "google_ai",
        summary: "no injuries reported",
        rawJson: "{}",
        scrapedAt: "2026-06-21T00:00:00Z",
      },
    ]);
  });
});

describe("teamSlug", () => {
  it.each([
    ["Germany", "germany"],
    ["Ivory Coast", "ivory_coast"],
    ["GIF Sundsvall", "gif_sundsvall"],
    ["St. Pölten", "st_pölten"],
    ["  Bayern Munich  ", "bayern_munich"],
  ])("slugifies %s -> %s", (input, expected) => {
    expect(teamSlug(input)).toBe(expected);
  });
});
