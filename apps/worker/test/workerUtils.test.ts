/** [regression test, 2026-07-16 silent-failure-logging fix] runPythonScript
 *  used to have no timeout — execFile's default is unbounded (0). Confirmed
 *  in production: a weekly kaggle-refresh step (fetch_squad_availability.py)
 *  logged its own internal error and then never produced a completion line —
 *  the caller's sequential await chain just stalled on it forever, with zero
 *  visible failure signal. This proves a hung subprocess is killed and
 *  resolves as a synthesized timeout error within the given bound, instead
 *  of hanging the caller (and this test) forever.
 *
 *  Uses `node -e "<code>"` as a fast, dependency-free stand-in for a hung/
 *  fast Python script — no real Python interpreter required in the test
 *  environment, and each test passes a short custom timeoutMs override so
 *  the suite runs in milliseconds rather than waiting out the real 15-minute
 *  DEFAULT_PYTHON_TIMEOUT_MS.
 *
 *  ./workerContext.js is mocked (same reasoning as dailyAcquisition.test.ts):
 *  the real module runs loadEnv()/buildConfig() at import time, which this
 *  unit test must not depend on. workerUtils.ts only imports ROOT from it. */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/workerContext.js", () => ({ ROOT: "." }));

const { runPythonScript } = await import("../src/workerUtils.js");

describe("runPythonScript — timeout bound", () => {
  it("kills a hung subprocess and resolves a timeout error instead of hanging forever", async () => {
    // 800ms timeoutMs against a 30s hang: generous margin over a real `node`
    // process spawn's startup latency (this box's own local notes document
    // multi-minute AV-induced I/O stalls historically) so this doesn't flake
    // under load, while still keeping the test itself fast.
    const result = await runPythonScript(process.execPath, "-e", ["setTimeout(() => {}, 30_000)"], {
      cwd: ".",
      timeoutMs: 800,
    });

    expect(result.err).not.toBeNull();
    expect(result.err?.message).toMatch(/timed out after 800ms/);
    expect(result.err?.killed).toBe(true);
  }, 10_000);

  it("resolves normally when the subprocess finishes well within the timeout", async () => {
    const result = await runPythonScript(process.execPath, "-e", ["process.stdout.write('ok')"], {
      cwd: ".",
      timeoutMs: 5_000,
    });

    expect(result.err).toBeNull();
    expect(result.stdout).toBe("ok");
  });

  it("falls back to the 15-minute default when timeoutMs is not passed", async () => {
    // Doesn't wait out the real 15 minutes — just proves a fast script still
    // resolves normally (err: null) when no explicit timeoutMs is supplied,
    // i.e. the new default doesn't regress the existing no-timeout call sites.
    const result = await runPythonScript(process.execPath, "-e", ["process.stdout.write('ok')"], {
      cwd: ".",
    });

    expect(result.err).toBeNull();
    expect(result.stdout).toBe("ok");
  });
});
