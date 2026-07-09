/** @oracle/notify tests — summary derivation, payload formatting, env-gated factory, fan-out. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchSummary } from "../src/index.js";
import {
  buildAnalysisModelNote,
  buildNotifiers,
  EmailNotifier,
  formatSummaryHtml,
  formatSummaryText,
  notifyAll,
  OpenClawNotifier,
  SlackNotifier,
  summarizeBatch,
  TelegramNotifier,
} from "../src/index.js";

// Minimal BatchResult fake
function fakeBatch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    date: "2026-06-05",
    rankingMode: "CONFIDENCE_WEIGHTED",
    runId: "r1",
    calibrationSnapshotId: "c1",
    completedCount: 2,
    actionableCount: 1,
    errorCount: 0,
    totalRecommendedStakePct: 3,
    cost: { estimatedUsd: 0, ceilingUsd: null, halted: false },
    errors: [],
    jobs: [
      {
        status: "ok",
        home: "Arsenal",
        away: "Chelsea",
        league: "Premier League",
        kickoff: "2026-06-05T15:00:00Z",
        decision: {
          primaryPick: { market: "Goals O/U", side: "Over 2.5", odds: 2.1, stake: 0.03 },
          confidence: 0.78,
        },
      },
      {
        status: "ok",
        home: "A",
        away: "B",
        league: "L",
        kickoff: "k",
        decision: {
          primaryPick: { market: "1x2", side: "home", odds: 1.5 },
          grade: "NO_EDGE",
          confidence: 0,
        },
      },
    ],
    ...overrides,
  } as never;
}

const sampleSummary: BatchSummary = {
  date: "2026-06-05",
  analysed: 2,
  actionableCount: 1,
  errors: 0,
  actionable: [
    {
      home: "Arsenal",
      away: "Chelsea",
      league: "Premier League",
      kickoff: "k",
      market: "Goals O/U",
      side: "Over 2.5",
      odds: 2.1,
      stakePct: 3,
      confidence: 0.78,
    },
  ],
  reportUrl: "http://localhost:8787/reports/2026-06-05",
};

describe("summarizeBatch", () => {
  it("extracts only actionable (non-NO_EDGE) picks", () => {
    const s = summarizeBatch(fakeBatch(), "http://x/r");
    expect(s.actionable).toHaveLength(1);
    expect(s.actionable[0]?.home).toBe("Arsenal");
    expect(s.actionable[0]?.market).toBe("Goals O/U");
    expect(s.reportUrl).toBe("http://x/r");
  });

  it("leaves eventId undefined when no resolver is given", () => {
    const s = summarizeBatch(fakeBatch());
    expect(s.actionable[0]?.eventId).toBeUndefined();
  });

  it("populates eventId from the resolver when given (booking needs this — bookAccumulator skips legs with no eventId)", () => {
    const s = summarizeBatch(fakeBatch(), undefined, (home, away) =>
      home === "Arsenal" && away === "Chelsea" ? "sr:match:123" : undefined
    );
    expect(s.actionable[0]?.eventId).toBe("sr:match:123");
  });
});

describe("formatSummaryText", () => {
  it("renders header + pick line", () => {
    const txt = formatSummaryText(sampleSummary);
    expect(txt).toMatch(/ORACLE 2026-06-05/);
    expect(txt).toMatch(/Arsenal vs Chelsea/);
    expect(txt).toMatch(/Goals O\/U/);
  });
  it("handles empty actionable list", () => {
    expect(formatSummaryText({ ...sampleSummary, actionable: [] })).toMatch(/No actionable picks/);
  });
  it("renders the combined slip line when combinedProb/combinedOdds are present", () => {
    const txt = formatSummaryText({ ...sampleSummary, combinedProb: 0.1234, combinedOdds: 56.7 });
    expect(txt).toMatch(/Combined: 12\.3% win prob/);
    expect(txt).toMatch(/@56\.70 odds/);
  });
  it("omits the combined slip line when combinedProb/combinedOdds are absent", () => {
    expect(formatSummaryText(sampleSummary)).not.toMatch(/Combined:/);
  });
});

describe("formatSummaryHtml", () => {
  it("renders the combined slip line when combinedProb/combinedOdds are present", () => {
    const html = formatSummaryHtml({ ...sampleSummary, combinedProb: 0.1234, combinedOdds: 56.7 });
    expect(html).toMatch(/Combined: 12\.3% win prob/);
    expect(html).toMatch(/@56\.70 odds/);
  });
  it("omits the combined slip line when combinedProb/combinedOdds are absent", () => {
    expect(formatSummaryHtml(sampleSummary)).not.toMatch(/Combined:/);
  });
});

describe("buildAnalysisModelNote", () => {
  it("reports Claude on all legs when every model is a claude-* id", () => {
    const note = buildAnalysisModelNote(["claude-opus-4-8", "claude-opus-4-8"]);
    expect(note).toMatch(/Claude \(claude-opus-4-8\) on all 2/);
  });
  it("states Claude NOT used and the reason when no leg used Claude", () => {
    const note = buildAnalysisModelNote(["gemini-3.5-flash", "gemini-3.5-flash"]);
    expect(note).toMatch(/Claude NOT used/);
    expect(note).toMatch(/gemini-3\.5-flash/);
    expect(note).toMatch(/cascade fell through/);
  });
  it("attributes deterministic-only legs when no model id is present", () => {
    const note = buildAnalysisModelNote([null, null]);
    expect(note).toMatch(/Claude NOT used/);
    expect(note).toMatch(/deterministic engine only/);
  });
  it("splits the attribution on a mixed slip", () => {
    const note = buildAnalysisModelNote(["claude-opus-4-8", "gemini-3.5-flash", null]);
    expect(note).toMatch(/Claude on 1\/3/);
    expect(note).toMatch(/gemini-3\.5-flash on the rest/);
    expect(note).toMatch(/1 deterministic-only/);
  });
  it("returns undefined for an empty slip", () => {
    expect(buildAnalysisModelNote([])).toBeUndefined();
  });
});

describe("formatSummaryText analysisModelNote", () => {
  it("renders the model attribution line when present", () => {
    const txt = formatSummaryText({
      ...sampleSummary,
      analysisModelNote: "🧠 Final analysis: Claude (claude-opus-4-8) on all 1 leg(s).",
    });
    expect(txt).toMatch(/Final analysis: Claude/);
  });
});

describe("formatSummaryText/formatSummaryHtml sanityNote (PR-5b)", () => {
  it("renders without throwing and omits the note when sanityNote is absent", () => {
    expect(() => formatSummaryText(sampleSummary)).not.toThrow();
    expect(() => formatSummaryHtml(sampleSummary)).not.toThrow();
    expect(formatSummaryText(sampleSummary)).not.toMatch(/Sanity checks/);
    expect(formatSummaryHtml(sampleSummary)).not.toMatch(/Sanity checks/);
  });

  it("renders the sanity note text when present, in both text and HTML output", () => {
    const withSanity: BatchSummary = {
      ...sampleSummary,
      sanityNote: "Sanity checks: clean (no flags)",
    };
    expect(() => formatSummaryText(withSanity)).not.toThrow();
    expect(() => formatSummaryHtml(withSanity)).not.toThrow();
    expect(formatSummaryText(withSanity)).toMatch(/Sanity checks: clean \(no flags\)/);
    expect(formatSummaryHtml(withSanity)).toMatch(/Sanity checks: clean \(no flags\)/);
  });
});

describe("formatSummaryText/formatSummaryHtml marketCoverageNote (PR-20)", () => {
  it("renders without throwing and omits the note when marketCoverageNote is absent", () => {
    expect(() => formatSummaryText(sampleSummary)).not.toThrow();
    expect(() => formatSummaryHtml(sampleSummary)).not.toThrow();
    expect(formatSummaryText(sampleSummary)).not.toMatch(/markets: \d/);
    expect(formatSummaryHtml(sampleSummary)).not.toMatch(/markets: \d/);
  });

  it("renders the market-coverage note when present, in both text and HTML output", () => {
    const withCoverage: BatchSummary = {
      ...sampleSummary,
      marketCoverageNote: "markets: 100 total / 80 routed / 70 priced / 5 gate-passed",
    };
    expect(() => formatSummaryText(withCoverage)).not.toThrow();
    expect(() => formatSummaryHtml(withCoverage)).not.toThrow();
    expect(formatSummaryText(withCoverage)).toMatch(
      /markets: 100 total \/ 80 routed \/ 70 priced \/ 5 gate-passed/
    );
    expect(formatSummaryHtml(withCoverage)).toMatch(
      /markets: 100 total \/ 80 routed \/ 70 priced \/ 5 gate-passed/
    );
  });
});

describe("buildNotifiers", () => {
  it("empty env → no notifiers", () => {
    expect(buildNotifiers({})).toHaveLength(0);
  });
  it("telegram env → TelegramNotifier", () => {
    const ns = buildNotifiers({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" });
    expect(ns.map((n) => n.name)).toEqual(["telegram"]);
  });
  it("partial telegram env → skipped", () => {
    expect(buildNotifiers({ TELEGRAM_BOT_TOKEN: "t" })).toHaveLength(0);
  });
  it("all channels configured → four notifiers including openclaw", () => {
    const ns = buildNotifiers({
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_CHAT_ID: "c",
      SLACK_WEBHOOK_URL: "http://hook",
      MAIL_API_KEY: "k",
      MAIL_FROM: "a@b.c",
      MAIL_TO: "d@e.f",
      OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789",
      OPENCLAW_TOKEN: "oc-tok",
    });
    expect(ns.map((n) => n.name).sort()).toEqual(["email", "openclaw", "slack", "telegram"]);
  });

  it("partial openclaw env → skipped", () => {
    expect(buildNotifiers({ OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789" })).toHaveLength(0);
  });
});

describe("adapters POST correctly", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Telegram posts to the Bot API with chat_id", async () => {
    await new TelegramNotifier("TOKEN", "CHAT").notify(sampleSummary);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain("/botTOKEN/sendMessage");
    expect(JSON.parse(opts.body).chat_id).toBe("CHAT");
  });

  it("Slack posts text to the webhook", async () => {
    await new SlackNotifier("http://hook").notify(sampleSummary);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("http://hook");
    expect(JSON.parse(opts.body).text).toMatch(/ORACLE/);
  });

  it("Email posts html with auth header", async () => {
    await new EmailNotifier({ apiKey: "KEY", from: "a@b.c", to: "d@e.f" }).notify(sampleSummary);
    const [, opts] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(opts.headers.authorization).toBe("Bearer KEY");
    expect(JSON.parse(opts.body).html).toMatch(/<table/);
  });

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "" });
    await expect(new SlackNotifier("http://hook").notify(sampleSummary)).rejects.toThrow(
      /HTTP 500/
    );
  });

  it("includes the response body in HTTP error messages", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" });
    await expect(new TelegramNotifier("T", "C").notify(sampleSummary)).rejects.toThrow(
      /HTTP 429 — rate limited/
    );
    await expect(
      new EmailNotifier({ apiKey: "k", from: "a@b.c", to: "d@e.f" }).notify(sampleSummary)
    ).rejects.toThrow(/HTTP 429 — rate limited/);
  });

  it("OpenClaw POSTs to /v1/responses with correct headers and body", async () => {
    await new OpenClawNotifier({
      gatewayUrl: "http://127.0.0.1:18789",
      token: "oc-tok",
      agentId: "main",
    }).notify(sampleSummary);
    const [url, opts] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("http://127.0.0.1:18789/v1/responses");
    expect(opts.headers.authorization).toBe("Bearer oc-tok");
    expect(opts.headers["x-openclaw-agent-id"]).toBe("main");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("openclaw");
    expect(body.input).toMatch(/ORACLE/);
    expect(body.user).toBe("oracle-batch-notifier");
  });

  it("OpenClaw defaults agentId to main", async () => {
    await new OpenClawNotifier({ gatewayUrl: "http://127.0.0.1:18789", token: "tok" }).notify(
      sampleSummary
    );
    const [, opts] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(opts.headers["x-openclaw-agent-id"]).toBe("main");
  });

  it("OpenClaw throws on non-ok Gateway response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "Unauthorized" });
    await expect(
      new OpenClawNotifier({ gatewayUrl: "http://127.0.0.1:18789", token: "bad" }).notify(
        sampleSummary
      )
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe("notifyAll", () => {
  it("continues when one channel throws", async () => {
    const good = { name: "good", notify: vi.fn().mockResolvedValue(undefined) };
    const bad = { name: "bad", notify: vi.fn().mockRejectedValue(new Error("boom")) };
    await notifyAll([good, bad], sampleSummary);
    expect(good.notify).toHaveBeenCalledOnce();
    expect(bad.notify).toHaveBeenCalledOnce();
  });

  it("logs the failing channel to stderr instead of swallowing it", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
      writes.push(String(s));
      return true;
    }) as typeof process.stderr.write);
    const bad = { name: "telegram", notify: vi.fn().mockRejectedValue(new Error("boom")) };
    await notifyAll([bad], sampleSummary);
    spy.mockRestore();
    expect(writes.join("")).toMatch(/\[notify\] telegram failed: boom/);
  });
});
