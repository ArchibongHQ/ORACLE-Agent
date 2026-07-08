/** [PR-26] getDataHealthLine's stdout/error-shaping logic — mocks
 *  node:child_process's execFile so no real Python process is spawned,
 *  same convention as runPythonScript.test.ts. */
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { getDataHealthLine } = await import("../src/dailyAcquisition.js");

type ExecFileCb = (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

describe("getDataHealthLine", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the trimmed stdout line on success", async () => {
    execFileMock.mockImplementation((_py, _args, _opts, cb: ExecFileCb) =>
      cb(null, "data health: xg-table 165 (2.1h old)\n", "")
    );
    expect(await getDataHealthLine()).toBe("data health: xg-table 165 (2.1h old)");
  });

  it("invokes acquire_daily.py with --health", async () => {
    execFileMock.mockImplementation((_py, _args, _opts, cb: ExecFileCb) => cb(null, "ok\n", ""));
    await getDataHealthLine();
    const [, scriptArgs] = execFileMock.mock.calls[0] as [string, string[]];
    expect(scriptArgs[0]).toMatch(/acquire_daily\.py$/);
    expect(scriptArgs).toContain("--health");
  });

  it("forwards non-empty stderr even on a successful run", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    execFileMock.mockImplementation((_py, _args, _opts, cb: ExecFileCb) =>
      cb(null, "data health: ok\n", "WARN some artifact unreadable\n")
    );
    await getDataHealthLine();
    expect(stderrSpy).toHaveBeenCalledWith("WARN some artifact unreadable\n");
    stderrSpy.mockRestore();
  });

  it("returns null (never throws) when the subprocess errors", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    execFileMock.mockImplementation((_py, _args, _opts, cb: ExecFileCb) =>
      cb(new Error("python not found") as NodeJS.ErrnoException, "", "")
    );
    expect(await getDataHealthLine()).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("data-health check failed: python not found")
    );
    stderrSpy.mockRestore();
  });

  it("returns null on empty stdout rather than an empty string", async () => {
    execFileMock.mockImplementation((_py, _args, _opts, cb: ExecFileCb) => cb(null, "   \n", ""));
    expect(await getDataHealthLine()).toBeNull();
  });
});
