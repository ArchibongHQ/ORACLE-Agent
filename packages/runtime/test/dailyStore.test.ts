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
