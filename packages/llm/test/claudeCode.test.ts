/** callClaudeCode / isLocalRuntime — tier-0 local CLI transport. Pins the
 *  "never throws, returns null on any failure" contract. node:child_process
 *  is mocked rather than spawning a real stub binary: a live-probed gotcha
 *  (spawning a .cmd file directly throws EINVAL on this Node/Windows
 *  combination, and cmd.exe-wrapping reintroduces Windows path-quoting bugs
 *  for paths containing spaces, e.g. this box's own "HP PC" home dir) makes a
 *  real-binary stub both platform-fragile and a poor fit for a portable unit
 *  test. Mocking the spawn boundary tests the same parse/never-throw/timeout
 *  contract without depending on OS process-spawning quirks. */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn, execFile } = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn((_cmd: string, _args: string[], cb?: () => void) => cb?.()),
}));

vi.mock("node:child_process", () => ({ spawn, execFile }));

const { _resetClaudeCodeCaches, callClaudeCode, isLocalRuntime } = await import(
  "../src/callClaudeCode.js"
);

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  pid = 4242;
}

beforeEach(() => {
  _resetClaudeCodeCaches();
  delete process.env.CLAUDE_BIN;
  delete process.env.ORACLE_RUNTIME;
  spawn.mockReset();
  execFile.mockClear();
});

afterEach(() => {
  delete process.env.CLAUDE_BIN;
  delete process.env.ORACLE_RUNTIME;
});

function envelope(body: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(body), "utf8");
}

/** _spawnWithStdin wires up listeners inside a dynamic import()'s .then() —
 *  emitting on the fake child synchronously after calling callClaudeCode
 *  races that microtask and the event is lost (or, for "error" with no
 *  listener yet attached, thrown as an uncaught exception). Flush a few
 *  microtask ticks first so the listeners are attached before any emit. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("callClaudeCode", () => {
  it("parses .result from a success envelope", async () => {
    const child = new FakeChild();
    spawn.mockReturnValue(child);
    const promise = callClaudeCode("hello");
    await flushMicrotasks();
    child.stdout.emit("data", envelope({ type: "result", is_error: false, result: "OK" }));
    child.emit("close", 0);
    expect(await promise).toBe("OK");
  });

  it("strips markdown code fences from .result, same convention as callOpenRouter", async () => {
    const child = new FakeChild();
    spawn.mockReturnValue(child);
    const promise = callClaudeCode("hello");
    await flushMicrotasks();
    child.stdout.emit(
      "data",
      envelope({ type: "result", is_error: false, result: '```json\n{"a":1}\n```' })
    );
    child.emit("close", 0);
    expect(await promise).toBe('{"a":1}');
  });

  it("returns null on an is_error envelope instead of handing the error text downstream", async () => {
    const child = new FakeChild();
    spawn.mockReturnValue(child);
    const promise = callClaudeCode("hello");
    await flushMicrotasks();
    child.stdout.emit(
      "data",
      envelope({ type: "result", is_error: true, result: "model not found" })
    );
    child.emit("close", 0);
    expect(await promise).toBeNull();
  });

  it("returns null on non-zero exit — never throws", async () => {
    const child = new FakeChild();
    spawn.mockReturnValue(child);
    const promise = callClaudeCode("hello");
    await flushMicrotasks();
    child.stdout.emit("data", envelope({ type: "result", is_error: false, result: "OK" }));
    child.emit("close", 1);
    await expect(promise).resolves.toBeNull();
  });

  it("returns null when stdout is not valid JSON — never throws", async () => {
    const child = new FakeChild();
    spawn.mockReturnValue(child);
    const promise = callClaudeCode("hello");
    await flushMicrotasks();
    child.stdout.emit("data", Buffer.from("not json"));
    child.emit("close", 0);
    await expect(promise).resolves.toBeNull();
  });

  it("returns null when spawn throws synchronously (binary missing) — never throws", async () => {
    spawn.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });
    await expect(callClaudeCode("hello")).resolves.toBeNull();
  });

  it("returns null when the child emits an error event", async () => {
    const child = new FakeChild();
    spawn.mockReturnValue(child);
    const promise = callClaudeCode("hello");
    await flushMicrotasks();
    child.emit("error", new Error("EACCES"));
    await expect(promise).resolves.toBeNull();
  });

  it("tree-kills and resolves null when the process exceeds the timeout", async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const child = new FakeChild();
      spawn.mockReturnValue(child);
      const promise = callClaudeCode("hello", { timeoutMs: 300 });
      await vi.advanceTimersByTimeAsync(300);
      expect(await promise).toBeNull();
      // _killTree branches on process.platform: Windows shells out to taskkill
      // (execFile), everywhere else signals the process group directly via
      // process.kill — assert whichever branch this runner actually takes
      // instead of hardcoding the Windows-only path (the latter passes on a
      // Windows dev box but fails CI's Ubuntu runner, which never calls
      // execFile at all).
      if (process.platform === "win32") {
        expect(execFile).toHaveBeenCalledWith(
          "taskkill",
          ["/pid", "4242", "/T", "/F"],
          expect.any(Function)
        );
      } else {
        expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
      }
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("writes the prompt to stdin and requests JSON output via -p, pinned to opus by default", async () => {
    const child = new FakeChild();
    spawn.mockReturnValue(child);
    const promise = callClaudeCode("analyze this fixture");
    await flushMicrotasks();
    child.stdout.emit("data", envelope({ type: "result", is_error: false, result: "OK" }));
    child.emit("close", 0);
    await promise;
    expect(spawn).toHaveBeenCalledWith(expect.any(String), [
      "-p",
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--model",
      "opus",
    ]);
    expect(child.stdin.write).toHaveBeenCalledWith("analyze this fixture");
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("honours an explicit opts.model override (e.g. fable)", async () => {
    const child = new FakeChild();
    spawn.mockReturnValue(child);
    const promise = callClaudeCode("analyze this fixture", { model: "fable" });
    await flushMicrotasks();
    child.stdout.emit("data", envelope({ type: "result", is_error: false, result: "OK" }));
    child.emit("close", 0);
    await promise;
    expect(spawn).toHaveBeenCalledWith(expect.any(String), [
      "-p",
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--model",
      "fable",
    ]);
  });
});

describe("isLocalRuntime", () => {
  it("returns true when ORACLE_RUNTIME=local", () => {
    process.env.ORACLE_RUNTIME = "local";
    expect(isLocalRuntime()).toBe(true);
  });

  it("returns true when ORACLE_RUNTIME=vps", () => {
    process.env.ORACLE_RUNTIME = "vps";
    expect(isLocalRuntime()).toBe(true);
  });

  it("returns false on any other explicit ORACLE_RUNTIME value", () => {
    process.env.ORACLE_RUNTIME = "api-only";
    expect(isLocalRuntime()).toBe(false);
  });

  it("caches the result across calls until reset", () => {
    process.env.ORACLE_RUNTIME = "local";
    expect(isLocalRuntime()).toBe(true);
    process.env.ORACLE_RUNTIME = "api-only"; // mutated after first read — should not matter
    expect(isLocalRuntime()).toBe(true);
    _resetClaudeCodeCaches();
    expect(isLocalRuntime()).toBe(false);
  });
});
