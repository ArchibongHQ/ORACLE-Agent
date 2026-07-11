/** Tests for newsIntel.ts's lake-first store read, added for the Phase A
 *  latency overhaul. dailyStore.js is mocked at module level — same approach
 *  as dailyStore.test.ts mocking @oracle/storage — so this suite covers
 *  enrichWithNewsIntel's own lookup-order/merge logic, not the lake's native
 *  DuckDB plumbing (covered separately in dailyStore.test.ts). */

import type { FixtureJob } from "@oracle/engine";
import { afterEach, describe, expect, it, vi } from "vitest";

// vi.mock's relative specifier resolves from THIS file's location, so
// "../src/dailyStore.js" — not newsIntel.ts's own "./dailyStore.js" — is what
// correctly intercepts newsIntel.ts's dynamic import() of the same file.
vi.mock("../src/dailyStore.js", () => ({
  loadDailyNews: vi.fn(),
  teamSlug: (s: string) => s.toLowerCase().replace(/\s+/g, "_"),
}));

// fetchNewsEnsemble/isLocalRuntime mocked so tests that reach the live-ensemble
// branch never touch the network/Playwright — same convention as runPunt.test.ts.
vi.mock("@oracle/llm", () => ({
  fetchNewsEnsemble: vi.fn().mockResolvedValue(null),
  isLocalRuntime: vi.fn(() => false),
}));

const { loadDailyNews } = await import("../src/dailyStore.js");
const { fetchNewsEnsemble, isLocalRuntime } = await import("@oracle/llm");
const { enrichWithNewsIntel, enrichWithNewsIntelReport } = await import("../src/newsIntel.js");

function job(home: string, away: string): FixtureJob {
  return {
    home,
    away,
    league: "Test League",
    kickoff: "2026-06-21T18:00:00Z",
    state: {},
  } as FixtureJob;
}

afterEach(() => vi.clearAllMocks());

describe("enrichWithNewsIntel — lake-first read", () => {
  it("returns jobs unchanged when the lake is empty and no live keys are configured", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]);
    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, {});
    expect(result).toEqual(jobs);
  });

  it("merges a perplexity lake row into softContext without needing a live key", async () => {
    vi.mocked(loadDailyNews).mockImplementation(async (_dt: string, slug: string) => {
      if (slug === "germany") {
        return [
          {
            source: "perplexity",
            summary: "x",
            rawJson: JSON.stringify({
              injuries: ["Player A — knee injury"],
              suspensions: [],
              lineupHints: [],
              motivationFlags: [],
              travelFlags: [],
              model: "perplexity-sonar-pro",
            }),
            scrapedAt: "2026-06-21T00:00:00Z",
          },
        ];
      }
      return [];
    });

    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, {}); // no keys at all
    const soft = result[0]?.state?.telemetry?.softContext as Array<{ kind: string; text: string }>;
    expect(soft).toHaveLength(1);
    expect(soft[0]).toMatchObject({ kind: "injury", text: "Player A — knee injury" });
  });

  it("merges a google_ai lake row as a single raw news item", async () => {
    vi.mocked(loadDailyNews).mockImplementation(async (_dt: string, slug: string) => {
      if (slug === "ivory_coast") {
        return [
          {
            source: "google_ai",
            summary: "Ivory Coast have no reported injuries ahead of kickoff.",
            rawJson: "{}",
            scrapedAt: "2026-06-21T00:00:00Z",
          },
        ];
      }
      return [];
    });

    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, {});
    const soft = result[0]?.state?.telemetry?.softContext as Array<{ kind: string; text: string }>;
    expect(soft).toEqual([
      {
        kind: "news",
        text: "Ivory Coast have no reported injuries ahead of kickoff.",
        source: "google-ai-mode-lake",
        observedAt: "2026-06-21T00:00:00Z",
      },
    ]);
  });

  it("[PR-8] surfaces an unrecognised lake source generically as news (closes the 7th-source gap)", async () => {
    vi.mocked(loadDailyNews).mockImplementation(async (_dt: string, slug: string) => {
      if (slug === "germany") {
        return [
          {
            source: "brand_new_scraper", // a source with no explicit branch in lakeRowToSoftContext
            summary: "Germany confirm a full-strength squad for the friendly.",
            rawJson: "{}",
            scrapedAt: "2026-06-21T00:00:00Z",
          },
        ];
      }
      return [];
    });

    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, {});
    const soft = result[0]?.state?.telemetry?.softContext as Array<{ kind: string; text: string }>;
    expect(soft).toEqual([
      {
        kind: "news",
        text: "Germany confirm a full-strength squad for the friendly.",
        source: "brand_new_scraper-lake",
        observedAt: "2026-06-21T00:00:00Z",
      },
    ]);
  });

  it("[PR-8] drops an unrecognised lake row with an empty summary", async () => {
    vi.mocked(loadDailyNews).mockImplementation(async (_dt: string, slug: string) => {
      if (slug === "germany") {
        return [
          {
            source: "brand_new_scraper",
            summary: "",
            rawJson: "{}",
            scrapedAt: "2026-06-21T00:00:00Z",
          },
        ];
      }
      return [];
    });
    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, {});
    // Empty-summary generic rows contribute nothing → jobs unchanged.
    expect(result).toEqual(jobs);
  });

  it("does not call the live ensemble path when the lake already has data", async () => {
    // Returns the same row for every call — loadLakeNews queries home AND
    // away, so 2 merged items (one per team) confirms both lookups ran and
    // the lake short-circuited before the live ensemble path.
    vi.mocked(loadDailyNews).mockResolvedValue([
      {
        source: "google_ai",
        summary: "no news",
        rawJson: "{}",
        scrapedAt: "2026-06-21T00:00:00Z",
      },
    ]);
    const jobs = [job("Germany", "Ivory Coast")];
    // Passing live keys to prove they're never reached for a lake hit — if the
    // ensemble path fired it would hit the network and likely throw/hang in CI.
    const result = await enrichWithNewsIntel(jobs, {
      perplexityApiKey: "fake",
      geminiApiKey: "fake",
    });
    expect(result[0]?.state?.telemetry?.softContext).toHaveLength(2);
  });

  it("degrades to an empty result (not a throw) when dailyStore's import rejects", async () => {
    vi.mocked(loadDailyNews).mockRejectedValue(new Error("native load failure"));
    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, {});
    expect(result).toEqual(jobs);
  });
});

describe("enrichWithNewsIntelReport — yield counts", () => {
  it("reports attempted/enriched/failed across a mixed slate (one lake hit, one lake miss, no live keys)", async () => {
    vi.mocked(loadDailyNews).mockImplementation(async (_dt: string, slug: string) => {
      if (slug === "zzyzx_wanderers") {
        return [
          {
            source: "google_ai",
            summary: "Zzyzx Wanderers have no reported injuries ahead of kickoff.",
            rawJson: "{}",
            scrapedAt: "2026-06-21T00:00:00Z",
          },
        ];
      }
      return [];
    });

    const jobs = [job("Zzyzx Wanderers", "Quixotic FC"), job("Voidmark", "Testopia")];
    const { yield: y } = await enrichWithNewsIntelReport(jobs, {});
    expect(y).toEqual({ attempted: 2, enriched: 1, failed: 1 });
  });
});

describe("enrichWithNewsIntel — delegation to enrichWithNewsIntelReport", () => {
  it("returns exactly the .jobs of the equivalent report call, unchanged in shape", async () => {
    vi.mocked(loadDailyNews).mockImplementation(async (_dt: string, slug: string) => {
      if (slug === "zzyzx_wanderers") {
        return [
          {
            source: "google_ai",
            summary: "Zzyzx Wanderers have no reported injuries ahead of kickoff.",
            rawJson: "{}",
            scrapedAt: "2026-06-21T00:00:00Z",
          },
        ];
      }
      return [];
    });

    const jobs = [job("Zzyzx Wanderers", "Quixotic FC")];
    const { jobs: reportJobs } = await enrichWithNewsIntelReport(jobs, {});
    const wrapperJobs = await enrichWithNewsIntel(jobs, {});
    expect(wrapperJobs).toEqual(reportJobs);
    expect(wrapperJobs).not.toBe(jobs); // an enriched copy, not the original array reference
  });
});

describe("enrichWithNewsIntelReport — keyless mode", () => {
  it("warns once and calls fetchNewsEnsemble with keys undefined when no provider keys are configured but the local runtime is available", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]); // empty lake — forces the deeper lookup
    vi.mocked(isLocalRuntime).mockReturnValueOnce(true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const jobs = [job("Voidmark", "Testopia")];
    const { yield: y } = await enrichWithNewsIntelReport(jobs, {});

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("keyless AI-Mode tier"));
    expect(fetchNewsEnsemble).toHaveBeenCalledWith(
      "Voidmark",
      "Testopia",
      "Test League",
      "2026-06-21T18:00:00Z",
      { perplexityKey: undefined, geminiKey: undefined }
    );
    expect(y).toEqual({ attempted: 1, enriched: 0, failed: 1 });

    warnSpy.mockRestore();
  });
});
