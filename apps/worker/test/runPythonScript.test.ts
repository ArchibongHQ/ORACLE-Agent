/** [PR-10] runPythonScript's retry-on-network-error path. Mocks node:child_process's
 *  execFile so no real Python process is spawned, and fake-timers withRetry's
 *  backoff (5s/10s in production) so the retry tests run instantly. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { runPythonScript } = await import("../src/workerUtils.js");

type ExecFileCb = (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

describe("runPythonScript", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("resolves with stdout/stderr and no err on success", async () => {
    execFileMock.mockImplementation((_py, _args, _opts, cb: ExecFileCb) => cb(null, "ok:1", ""));
    const result = await runPythonScript("python", "script.py", [], { cwd: "." });
    expect(result).toEqual({ err: null, stdout: "ok:1", stderr: "" });
  });

  it("without retryOnNetworkError, resolves once with the err populated (never rejects)", async () => {
    execFileMock.mockImplementation((_py, _args, _opts, cb: ExecFileCb) =>
      cb(new Error("Command failed") as NodeJS.ErrnoException, "", "getaddrinfo failed")
    );
    const result = await runPythonScript("python", "script.py", [], { cwd: "." });
    expect(result.err?.message).toBe("Command failed");
    expect(execFileMock).toHaveBeenCalledTimes(1); // no retry when the option is off
  });

  it("with retryOnNetworkError, retries a DNS-shaped stderr failure and succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    execFileMock.mockImplementation((_py, _args, _opts, cb: ExecFileCb) => {
      calls++;
      if (calls < 3) {
        cb(new Error("Command failed") as NodeJS.ErrnoException, "", "getaddrinfo failed");
      } else {
        cb(null, "acquired:12", "");
      }
    });
    const resultPromise = runPythonScript("python", "acquire_daily.py", [], {
      cwd: ".",
      retryOnNetworkError: true,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toEqual({ err: null, stdout: "acquired:12", stderr: "" });
    expect(calls).toBe(3);
  });

  it("with retryOnNetworkError, does not retry a non-network failure (fails fast)", async () => {
    execFileMock.mockImplementation((_py, _args, _opts, cb: ExecFileCb) =>
      cb(new Error("Command failed") as NodeJS.ErrnoException, "", "Traceback: KeyError 'foo'")
    );
    const result = await runPythonScript("python", "acquire_daily.py", [], {
      cwd: ".",
      retryOnNetworkError: true,
    });
    expect(result.err?.message).toBe("Command failed");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("with retryOnNetworkError, resolves (never rejects) once retries are exhausted", async () => {
    vi.useFakeTimers();
    execFileMock.mockImplementation((_py, _args, _opts, cb: ExecFileCb) =>
      cb(new Error("Command failed") as NodeJS.ErrnoException, "", "Name or service not known")
    );
    const resultPromise = runPythonScript("python", "acquire_daily.py", [], {
      cwd: ".",
      retryOnNetworkError: true,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.err?.message).toBe("Command failed");
    expect(execFileMock).toHaveBeenCalledTimes(3); // 1 original + 2 retries, then give up
  });
});
