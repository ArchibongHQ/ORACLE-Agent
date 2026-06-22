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

const { loadDailyNews } = await import("../src/dailyStore.js");
const { enrichWithNewsIntel } = await import("../src/newsIntel.js");

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
