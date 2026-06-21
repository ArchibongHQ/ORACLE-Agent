/** Unit tests for refreshSidecarIfStale — the sidecar freshness guard in runPunt.ts.
 *  We mock node:fs (existsSync / readFileSync) and node:child_process (spawn) to
 *  exercise every branch without touching the filesystem or spawning a real process. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs")>();
  return { ...mod, existsSync: vi.fn(), readFileSync: vi.fn() };
});

vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return { ...mod, spawn: vi.fn() };
});

// Must be imported AFTER the mocks are registered.
// Dynamic import ensures vitest hoists the vi.mock calls above before resolution.
const { existsSync, readFileSync } = await import("node:fs");
const { spawn } = await import("node:child_process");
const { refreshSidecarIfStale } = await import("../src/runPunt.js");

const TODAY = new Date().toISOString().slice(0, 10);

/** Build a minimal fake child-process that fires "close" synchronously. */
function makeChild(opts: { error?: boolean; killable?: boolean } = {}) {
  const handlers: Record<string, () => void> = {};
  const child = {
    on(event: string, cb: () => void) {
      handlers[event] = cb;
      // fire "close" or "error" on the next tick so the Promise resolves quickly
      if (event === (opts.error ? "error" : "close")) {
        setImmediate(cb);
      }
      return child;
    },
    kill: vi.fn(),
  };
  return child as unknown as ReturnType<typeof spawn>;
}

describe("refreshSidecarIfStale", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => vi.clearAllMocks());

  it("returns immediately without spawning when the sidecar is fresh", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ date: TODAY }));

    await refreshSidecarIfStale();

    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns scrape_fixtures.py when the sidecar is missing", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(spawn).mockReturnValue(makeChild());

    await refreshSidecarIfStale();

    expect(spawn).toHaveBeenCalledOnce();
    const [cmd, args] = vi.mocked(spawn).mock.calls[0]!;
    // resolvePythonBin falls back to a bare interpreter when no install is found
    // (existsSync is mocked false here): "python" on Windows, "python3" elsewhere.
    expect(cmd).toBe(process.platform === "win32" ? "python" : "python3");
    expect((args as string[]).some((a) => a.includes("scrape_fixtures.py"))).toBe(true);
  });

  it("spawns when the sidecar date is stale (yesterday)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ date: yesterday }));
    vi.mocked(spawn).mockReturnValue(makeChild());

    await refreshSidecarIfStale();

    expect(spawn).toHaveBeenCalledOnce();
  });

  it("spawns when the sidecar JSON is corrupt (JSON.parse throws)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not-valid-json");
    vi.mocked(spawn).mockReturnValue(makeChild());

    await refreshSidecarIfStale();

    expect(spawn).toHaveBeenCalledOnce();
  });

  it("resolves without throwing when the child process emits an error", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(spawn).mockReturnValue(makeChild({ error: true }));

    await expect(refreshSidecarIfStale()).resolves.toBeUndefined();
  });
});
