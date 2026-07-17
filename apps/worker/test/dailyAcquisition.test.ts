/** [regression test] sendDailyFixtureReport's blocked-state Telegram alert used
 *  to fire unconditionally on every cron invocation whenever fixtures were
 *  unavailable — 3+ Telegram spam sends/day in production. The fix suppresses
 *  the alert to once per (date, blocked-reason) via a heartbeat file, read
 *  through workerUtils.js's readFixtureReportState/writeHeartbeat. This test
 *  proves the suppression actually holds: calling sendDailyFixtureReport()
 *  twice for the same blocked reason on the same day must only send once.
 *
 *  ./workerContext.js is mocked wholesale — importing the real module runs
 *  loadEnv()/buildConfig()/resolvePythonBin() at import time (real .env +
 *  filesystem reads), which this unit test must not depend on. ./workerUtils.js
 *  is mocked with an in-memory fake heartbeat store standing in for the real
 *  .tmp/worker_heartbeat.json file, so the suppression behavior is observed
 *  through the same (date, reason) keying the real code uses, without ever
 *  touching disk. watDateString is pinned to a fixed date so "today" cannot
 *  drift between the two calls in a single test. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendTelegramTextMock = vi.fn().mockResolvedValue(undefined);
const sendTelegramDocumentMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@oracle/notify", () => ({
  sendTelegramText: (...args: unknown[]) => sendTelegramTextMock(...args),
  sendTelegramDocument: (...args: unknown[]) => sendTelegramDocumentMock(...args),
}));

// generateAndWriteFixtureWorkbook is the true source of `result` in
// sendDailyFixtureReport (packages/runtime/src/fixtureWorkbook.ts) — it
// resolves null when SportyBet listed no fixtures for the date, which is
// exactly the "no-fixtures" blocked branch under test. The other
// @oracle/runtime exports dailyAcquisition.ts imports are not reached on this
// code path but must still exist on the mock or the ESM import itself fails.
const generateAndWriteFixtureWorkbookMock = vi.fn();
vi.mock("@oracle/runtime", () => ({
  fetchSharpFairPrice: vi.fn(),
  findSportyBetEventId: vi.fn(),
  generateAndWriteFixtureWorkbook: (...args: unknown[]) =>
    generateAndWriteFixtureWorkbookMock(...args),
  LEAGUE_TO_SPORT: {},
  loadSportyBetIndex: vi.fn(),
  SHARP_ODDS_STORAGE_KEY: "sharpOdds",
  sharpOddsRecordId: vi.fn(),
}));

vi.mock("@oracle/storage", () => ({
  MemoryAdapter: class {},
  STORAGE_KEYS: {},
}));

// Fully inert replacement — the real module has import-time side effects
// (loadEnv/buildConfig/resolvePythonBin touching the real .env/filesystem)
// that a unit test must not trigger. Plain literals only.
//
// NOTE: the path here is written relative to THIS test file
// (apps/worker/test/), not to src/dailyAcquisition.ts's own "./workerContext.js"
// specifier — Vitest resolves a relative vi.mock() path against the file that
// calls vi.mock, so "../src/workerContext.js" is required for this to resolve
// to the same absolute module dailyAcquisition.ts imports. Both this and the
// SUT's own specifier resolve to the same file on disk, which is what makes
// the mock registry (keyed by resolved absolute path) intercept it correctly.
vi.mock("../src/workerContext.js", () => ({
  config: {},
  env: { TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "test-chat" },
  MARKET_CATALOG_OVERLAY_PATH: ".tmp/market_catalog_overlay.json",
  PYTHON_BIN: "python",
  ROOT: ".",
  STORE_PATH: ".tmp/oracle-store",
}));

// In-memory stand-in for the real heartbeat file (.tmp/worker_heartbeat.json)
// — mirrors the shape readFixtureReportState/writeHeartbeat share in
// workerUtils.ts, so the (date, reason) suppression logic under test runs
// unmodified against this fake store instead of the real filesystem.
let heartbeat: { fixtureReportPlaceholder?: { date: string; reason: string } } = {};

const runPythonScriptMock = vi.fn().mockResolvedValue({ err: null, stdout: "", stderr: "" });

// Same test-file-relative resolution note as workerContext.js above.
vi.mock("../src/workerUtils.js", () => ({
  readFixtureReportState: () => ({
    placeholderDate: heartbeat.fixtureReportPlaceholder?.date,
    placeholderReason: heartbeat.fixtureReportPlaceholder?.reason,
  }),
  writeHeartbeat: (event: string, detail: Record<string, unknown>) => {
    if (event === "fixtureReportPlaceholder") {
      heartbeat.fixtureReportPlaceholder = detail as { date: string; reason: string };
    }
  },
  runPythonScript: (...args: unknown[]) => runPythonScriptMock(...args),
  // Pinned so "today" cannot drift between the two sendDailyFixtureReport()
  // calls each test makes.
  watDateString: () => "2026-07-15",
  watYesterdayString: () => "2026-07-14",
}));

const { sendDailyFixtureReport, runWeeklyKaggleRefresh, acquireDaily } = await import(
  "../src/dailyAcquisition.js"
);

describe("sendDailyFixtureReport — blocked-state Telegram alert suppression", () => {
  beforeEach(() => {
    heartbeat = {};
    sendTelegramTextMock.mockClear();
    sendTelegramDocumentMock.mockClear();
    runPythonScriptMock.mockClear();
    generateAndWriteFixtureWorkbookMock.mockReset();
  });

  it("sends the no-fixtures alert only once across two calls on the same day (regression: was 3+/day spam)", async () => {
    // null => the "no SportyBet fixtures available" branch (!result).
    generateAndWriteFixtureWorkbookMock.mockResolvedValue(null);

    await sendDailyFixtureReport();
    await sendDailyFixtureReport();

    expect(sendTelegramTextMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramTextMock).toHaveBeenCalledWith(
      "test-token",
      "test-chat",
      expect.stringContaining("no SportyBet fixtures found for 2026-07-15")
    );
  });

  it("gives each distinct blocked reason its own one-time send (no-fixtures, then markets-empty)", async () => {
    generateAndWriteFixtureWorkbookMock.mockResolvedValueOnce(null);
    await sendDailyFixtureReport(); // 1st send: no-fixtures

    generateAndWriteFixtureWorkbookMock.mockResolvedValueOnce(null);
    await sendDailyFixtureReport(); // suppressed repeat of no-fixtures

    generateAndWriteFixtureWorkbookMock.mockResolvedValue({
      fixturesPath: "fixtures.xlsx",
      marketsPaths: [],
      htmlPagePath: "page.html",
      fixtureCount: 3,
      marketsEmpty: true,
      xgCoverage: { covered: 0, total: 3, bySrc: {} },
    });
    await sendDailyFixtureReport(); // 2nd send: markets-empty (new reason, same day)
    await sendDailyFixtureReport(); // suppressed repeat of markets-empty

    expect(sendTelegramTextMock).toHaveBeenCalledTimes(2);
    expect(sendTelegramTextMock).toHaveBeenNthCalledWith(
      1,
      "test-token",
      "test-chat",
      expect.stringContaining("no SportyBet fixtures found for 2026-07-15")
    );
    expect(sendTelegramTextMock).toHaveBeenNthCalledWith(
      2,
      "test-token",
      "test-chat",
      expect.stringContaining("market depth not yet enriched")
    );
  });
});

/** [regression test, 2026-07-16 silent-failure-logging fix] Production logs
 *  showed a weekly kaggle-refresh step (squad-availability) start, log its
 *  own internal error, then never produce a completion line — the
 *  sequential await chain just stalled on that one hung/failed step with no
 *  chain-level signal, and availability_features.csv sat 36 days stale
 *  before this was ever noticed. This proves (a) a failed/timed-out step no
 *  longer blocks the steps after it, and (b) the final summary line always
 *  reports an accurate pass/fail tally instead of requiring a multi-log
 *  forensic search to find a silent partial failure. */
describe("runWeeklyKaggleRefresh — per-step tally (2026-07-16 silent-failure-logging fix)", () => {
  beforeEach(() => {
    runPythonScriptMock.mockClear();
  });

  it("runs every step even after failures mid-chain, and tallies pass/fail in the final summary line", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // 9 steps, strictly sequential, in call order: odds_timeseries, spi,
    // fbref, transfermarkt, squad-availability, xg, xg-table, travel,
    // catalog-diff — mockResolvedValueOnce queue order lines up 1:1 with the
    // real await order since there is no concurrency in this chain.
    runPythonScriptMock
      .mockResolvedValueOnce({ err: null, stdout: "", stderr: "" }) // odds_timeseries
      .mockResolvedValueOnce({ err: null, stdout: "", stderr: "" }) // spi
      .mockResolvedValueOnce({ err: null, stdout: "", stderr: "" }) // fbref
      .mockResolvedValueOnce({
        err: new Error("no squad value data found"),
        stdout: "",
        stderr: "",
      }) // transfermarkt: FAILED (real production failure mode)
      .mockResolvedValueOnce({
        // Simulates the timeout error runPythonScript now synthesizes on a
        // hang, rather than the pre-fix behavior of never resolving at all.
        err: Object.assign(new Error("fetch_squad_availability.py timed out after 900000ms"), {
          killed: true,
        }),
        stdout: "",
        stderr: "",
      }) // squad-availability: simulated hang/timeout
      .mockResolvedValueOnce({ err: null, stdout: "", stderr: "" }) // xg
      .mockResolvedValueOnce({ err: null, stdout: "", stderr: "" }) // xg-table
      .mockResolvedValueOnce({ err: null, stdout: "", stderr: "" }) // travel
      .mockResolvedValueOnce({ err: null, stdout: "", stderr: "" }); // catalog-diff

    await runWeeklyKaggleRefresh();

    // All 9 steps must still have been invoked despite 2 failures mid-chain —
    // proves a hang/failure can no longer silently strand the rest.
    expect(runPythonScriptMock).toHaveBeenCalledTimes(9);

    const summaryLine = writeSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("weekly refresh complete"));
    expect(summaryLine).toContain("7/9 ok");
    expect(summaryLine).toContain("FAILED: transfermarkt, squad-availability");

    writeSpy.mockRestore();
    errWriteSpy.mockRestore();
  });

  it("reports a clean tally with no FAILED clause when every step succeeds", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    runPythonScriptMock.mockResolvedValue({ err: null, stdout: "", stderr: "" });

    await runWeeklyKaggleRefresh();

    const summaryLine = writeSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("weekly refresh complete"));
    expect(summaryLine).toContain("9/9 ok");
    expect(summaryLine).not.toContain("FAILED");

    writeSpy.mockRestore();
  });
});

/** [regression test, 2026-07-17] runWeeklyKaggleRefresh's credential
 *  pre-flight check previously only recognized the legacy KAGGLE_USERNAME/
 *  KAGGLE_KEY pair — it printed a false "no credentials found" warning even
 *  when the modern KAGGLE_API_TOKEN env var (verified working against a real
 *  `kaggle datasets list` call) was correctly configured. */
describe("runWeeklyKaggleRefresh — KAGGLE_API_TOKEN credential recognition (2026-07-17)", () => {
  const originalUsername = process.env.KAGGLE_USERNAME;
  const originalKey = process.env.KAGGLE_KEY;
  const originalToken = process.env.KAGGLE_API_TOKEN;

  beforeEach(() => {
    runPythonScriptMock.mockClear();
    runPythonScriptMock.mockResolvedValue({ err: null, stdout: "", stderr: "" });
    delete process.env.KAGGLE_USERNAME;
    delete process.env.KAGGLE_KEY;
    delete process.env.KAGGLE_API_TOKEN;
  });

  afterEach(() => {
    if (originalUsername === undefined) delete process.env.KAGGLE_USERNAME;
    else process.env.KAGGLE_USERNAME = originalUsername;
    if (originalKey === undefined) delete process.env.KAGGLE_KEY;
    else process.env.KAGGLE_KEY = originalKey;
    if (originalToken === undefined) delete process.env.KAGGLE_API_TOKEN;
    else process.env.KAGGLE_API_TOKEN = originalToken;
  });

  it("does not warn when only KAGGLE_API_TOKEN is set (no legacy pair)", async () => {
    process.env.KAGGLE_API_TOKEN = "KGAT_test-token";
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runWeeklyKaggleRefresh();

    const warned = errSpy.mock.calls.some((call) =>
      String(call[0]).includes("no Kaggle credentials found")
    );
    expect(warned).toBe(false);
    errSpy.mockRestore();
  });

  it("still warns when neither the legacy pair nor the token is set", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runWeeklyKaggleRefresh();

    const warned = errSpy.mock.calls.some((call) =>
      String(call[0]).includes("no Kaggle credentials found")
    );
    expect(warned).toBe(true);
    errSpy.mockRestore();
  });
});

/** [regression test, 2026-07-16 silent-failure-logging fix, review finding]
 *  acquireDaily() is one of the two "real network-scrape entry points" that
 *  must NOT inherit runPythonScript's shorter 15-minute default timeout (that
 *  default was calibrated against the weekly kaggle-refresh tools, which
 *  normally complete in well under a second) — a legitimately slow-but-alive
 *  scrape on a bad day should still get to finish. Proves the explicit 25-min
 *  override is actually passed through. */
describe("acquireDaily — explicit timeoutMs override (2026-07-16 silent-failure-logging fix)", () => {
  beforeEach(() => {
    runPythonScriptMock.mockClear();
  });

  it("passes a 25-minute timeoutMs, not the runPythonScript default", async () => {
    runPythonScriptMock.mockResolvedValue({ err: null, stdout: "acquired:12", stderr: "" });

    const count = await acquireDaily();

    expect(count).toBe(12);
    expect(runPythonScriptMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [],
      expect.objectContaining({ timeoutMs: 25 * 60 * 1000 })
    );
  });
});
