/** Tests for newsIntel.ts's lake-first store read, added for the Phase A
 *  latency overhaul. dailyStore.js is mocked at module level — same approach
 *  as dailyStore.test.ts mocking @oracle/storage — so this suite covers
 *  enrichWithNewsIntel's own lookup-order/merge logic, not the lake's native
 *  DuckDB plumbing (covered separately in dailyStore.test.ts). */

import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureJob } from "@oracle/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// newsIntel.ts's readCache/writeCache hit the REAL filesystem (not mocked) —
// any test that reaches the live-ensemble branch with a non-null mocked
// response writes a real, TTL-gated cache file under this directory, which
// would otherwise silently short-circuit readCache on the NEXT run within
// the 2h TTL (found the hard way: a leftover file made a later run's
// fetchNewsEnsemble assertion fail with 0 calls). The Phase 3 injuries-sweep
// describe block below cleans this directory before each of its own tests
// so repeated local runs never depend on — or pollute — real disk state.
const NEWS_INTEL_TEST_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.tmp/news_intel"
);

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

describe("enrichWithNewsIntelReport — Phase 3 injuries sweep (API-Football)", () => {
  beforeEach(() => rm(NEWS_INTEL_TEST_DIR, { recursive: true, force: true }));
  afterEach(async () => {
    vi.unstubAllGlobals();
    // Also clean up AFTER — a test in this block that reaches the real
    // writeCache (via a non-null mocked ensemble response) must not leave a
    // file behind for whichever test/suite runs next (e.g. the pre-existing
    // "keyless mode" describe block right after this one).
    await rm(NEWS_INTEL_TEST_DIR, { recursive: true, force: true });
  });

  it("never calls fetch when apiFootballKey is absent — existing lake-first behavior is byte-identical", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, {});
    expect(result).toEqual(jobs);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches the slate ONCE and joins injuries onto the matching fixture by team name", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]); // lake empty — isolate the sweep's own contribution
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: [
          { team: { name: "Germany" }, player: { name: "Player A", type: "Injury" } },
          { team: { name: "Ivory Coast" }, player: { name: "Player B", type: "Suspended" } },
          { team: { name: "Some Other Team" }, player: { name: "Player C", type: "Injury" } },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, { apiFootballKey: "fake-key" });

    expect(fetchSpy).toHaveBeenCalledTimes(1); // ONE call for the whole slate, not per-fixture
    expect(fetchSpy.mock.calls[0]![0]).toContain("/injuries?date=");
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({
      headers: { "x-apisports-key": "fake-key" },
    });

    const soft = result[0]?.state?.telemetry?.softContext as Array<{
      kind: string;
      text: string;
      source: string;
    }>;
    expect(soft).toHaveLength(2);
    expect(soft).toContainEqual(
      expect.objectContaining({
        kind: "injury",
        text: "Player A (Injury)",
        source: "api-football-injuries",
      })
    );
    expect(soft).toContainEqual(
      expect.objectContaining({
        kind: "injury",
        text: "Player B (Suspended)",
        source: "api-football-injuries",
      })
    );
    // The unrelated third team's injury never leaks onto this fixture.
    expect(soft.some((s) => s.text.includes("Player C"))).toBe(false);
  });

  it("does not gate or replace the deeper lookup — the live ensemble still runs independently of any sweep hit", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]); // empty lake forces the deeper-lookup branch
    vi.mocked(fetchNewsEnsemble).mockResolvedValueOnce({
      injuries: [],
      suspensions: [],
      lineupHints: ["Confirmed XI released"],
      motivationFlags: [],
      travelFlags: [],
      model: "perplexity-sonar-pro",
      observedAt: "2026-06-21T00:00:00Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: [{ team: { name: "Germany" }, player: { name: "X" } }] }),
      })
    );

    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, {
      apiFootballKey: "fake-key",
      perplexityApiKey: "fake",
    });

    // Both the sweep's injury item AND the ensemble's lineup item are present —
    // the sweep is additive, not a replacement for the richer ensemble tier.
    const soft = result[0]?.state?.telemetry?.softContext as Array<{ kind: string; text: string }>;
    expect(fetchNewsEnsemble).toHaveBeenCalledTimes(1);
    expect(soft.some((s) => s.kind === "lineup")).toBe(true);
    expect(soft.some((s) => s.kind === "injury" && s.text === "X (unavailable)")).toBe(true);
  });

  it("degrades to no injuries (not a throw) when fetch rejects", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, { apiFootballKey: "fake-key" });
    expect(result).toEqual(jobs); // no crash, no injury item — falls through unchanged
  });

  it("degrades to no injuries when the API returns a non-ok response", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, { apiFootballKey: "fake-key" });
    expect(result).toEqual(jobs);
  });

  it("degrades to no injuries on the free-plan rejection shape (HTTP 200 + populated errors)", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ errors: { plan: "Free plans do not have access to this endpoint" } }),
      })
    );
    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, { apiFootballKey: "fake-key" });
    expect(result).toEqual(jobs);
  });

  it("reports injuriesSweep coverage in the yield only when apiFootballKey was supplied", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: [{ team: { name: "Germany" }, player: { name: "Player A" } }],
        }),
      })
    );
    const jobs = [job("Germany", "Ivory Coast"), job("Voidmark", "Testopia")];

    const withKey = await enrichWithNewsIntelReport(jobs, { apiFootballKey: "fake-key" });
    expect(withKey.yield.injuriesSweep).toEqual({ teamsCovered: 1, matchedFixtures: 1 });

    const withoutKey = await enrichWithNewsIntelReport(jobs, {});
    expect(withoutKey.yield.injuriesSweep).toBeUndefined();
  });

  it("a fixture enriched ONLY via the injuries sweep (empty lake, no live keys) counts as enriched, not failed", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: [{ team: { name: "Germany" }, player: { name: "Player A" } }],
        }),
      })
    );
    const jobs = [job("Germany", "Ivory Coast")];
    const { jobs: enriched, yield: y } = await enrichWithNewsIntelReport(jobs, {
      apiFootballKey: "fake-key",
    });
    expect(y).toMatchObject({ attempted: 1, enriched: 1, failed: 0 });
    expect(enriched[0]?.state?.telemetry?.softContext).toHaveLength(1);
  });

  it("requires an EXACT alias-resolved team-name match — does NOT fall back to substring tolerance (adversarial review finding, 2026-07-20)", async () => {
    // normTeam("America MG") === "america mg", which INCLUDES normTeam("America")
    // === "america" as a substring — exactly the collision namesMatch's
    // tolerance would produce (this diff's own bug before the fix): a
    // different club's ("America MG") injury silently attaching to an
    // unrelated "America" fixture. Must NOT happen for this global join.
    vi.mocked(loadDailyNews).mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: [{ team: { name: "America MG" }, player: { name: "Wrong Club Player" } }],
        }),
      })
    );
    const jobs = [job("America", "Some Opponent")];
    const result = await enrichWithNewsIntel(jobs, { apiFootballKey: "fake-key" });
    // No cross-contamination: the unrelated club's injury never attaches.
    expect(result).toEqual(jobs);
  });

  it("accumulates multiple injuries for the SAME team into separate softContext items", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: [
            { team: { name: "Germany" }, player: { name: "Player A", type: "Injury" } },
            { team: { name: "Germany" }, player: { name: "Player B", type: "Suspended" } },
          ],
        }),
      })
    );
    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, { apiFootballKey: "fake-key" });
    const soft = result[0]?.state?.telemetry?.softContext as Array<{ text: string }>;
    expect(soft).toHaveLength(2);
    expect(soft.map((s) => s.text)).toEqual(
      expect.arrayContaining(["Player A (Injury)", "Player B (Suspended)"])
    );
  });

  it("treats an EMPTY array-shaped errors field as success (passes response through)", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          errors: [],
          response: [{ team: { name: "Germany" }, player: { name: "Player A" } }],
        }),
      })
    );
    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, { apiFootballKey: "fake-key" });
    expect(result[0]?.state?.telemetry?.softContext).toHaveLength(1);
  });

  it("degrades to no injuries on a NON-EMPTY array-shaped errors field", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ errors: ["rate limited"] }),
      })
    );
    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, { apiFootballKey: "fake-key" });
    expect(result).toEqual(jobs);
  });

  it("silently skips a response entry missing team.name or player.name", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: [
            { team: { name: "Germany" }, player: {} }, // missing player.name
            { team: {}, player: { name: "Player A" } }, // missing team.name
            { team: { name: "Ivory Coast" }, player: { name: "Player B" } }, // valid
          ],
        }),
      })
    );
    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, { apiFootballKey: "fake-key" });
    const soft = result[0]?.state?.telemetry?.softContext as Array<{ text: string }>;
    expect(soft).toHaveLength(1);
    expect(soft[0]?.text).toBe("Player B (unavailable)");
  });

  it("falls back to player.reason when player.type is absent", async () => {
    vi.mocked(loadDailyNews).mockResolvedValue([]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: [
            { team: { name: "Germany" }, player: { name: "Player A", reason: "Hamstring" } },
          ],
        }),
      })
    );
    const jobs = [job("Germany", "Ivory Coast")];
    const result = await enrichWithNewsIntel(jobs, { apiFootballKey: "fake-key" });
    const soft = result[0]?.state?.telemetry?.softContext as Array<{ text: string }>;
    expect(soft[0]?.text).toBe("Player A (Hamstring)");
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
