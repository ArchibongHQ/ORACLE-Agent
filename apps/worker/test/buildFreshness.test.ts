/** Build-freshness watchdog — unit tests for checkBuildFreshness's
 *  git-commit-time-vs-dist comparison (plus its mtime fallback) and the
 *  getStaleBuildNote/setStaleBuildNote stash, using a disposable fake repoRoot
 *  (packages/<name>/{src,dist}) so this never touches the real repo's actual
 *  build output. node:child_process is mocked (dataHealthLine.test.ts
 *  convention) — the default implementation throws, simulating "no git", so
 *  every mtime-based test below exercises the fallback path; git-mode tests
 *  override the mock per-test. Mirrors catalogOverlay.test.ts's mkdtemp +
 *  afterEach cleanup convention. */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));

import {
  checkBuildFreshness,
  getStaleBuildNote,
  setStaleBuildNote,
} from "../src/buildFreshness.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "oracle-build-freshness-"));
  mocks.execFileSync.mockReset();
  mocks.execFileSync.mockImplementation(() => {
    throw new Error("git: command not found");
  });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

/** Writes a file and stamps its mtime explicitly — Windows/CI filesystems can
 *  have coarse mtime resolution, so tests set times far enough apart
 *  (well beyond the 60s stale threshold) to be unambiguous either way. */
function writeAt(path: string, atSecondsFromEpoch: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  const t = new Date(atSecondsFromEpoch * 1000);
  utimesSync(path, t, t);
}

function makePackage(
  group: "packages" | "apps",
  name: string,
  opts: {
    pkgName?: string;
    srcAtSec?: number;
    distAtSec?: number;
    skipSrc?: boolean;
    skipDist?: boolean;
  } = {}
): void {
  const pkgRoot = join(repoRoot, group, name);
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(
    join(pkgRoot, "package.json"),
    JSON.stringify({ name: opts.pkgName ?? `@oracle/${name}` })
  );
  if (!opts.skipSrc) writeAt(join(pkgRoot, "src", "index.ts"), opts.srcAtSec ?? 1_000_000);
  if (!opts.skipDist) writeAt(join(pkgRoot, "dist", "index.js"), opts.distAtSec ?? 1_000_000);
}

describe("checkBuildFreshness", () => {
  it("returns no warnings when dist is newer than src", () => {
    makePackage("packages", "engine", { srcAtSec: 1_000_000, distAtSec: 1_000_500 });
    expect(checkBuildFreshness(repoRoot)).toEqual([]);
  });

  it("returns no warnings when src is newer than dist but within the 60s threshold", () => {
    makePackage("packages", "engine", { srcAtSec: 1_000_030, distAtSec: 1_000_000 });
    expect(checkBuildFreshness(repoRoot)).toEqual([]);
  });

  it("flags a package whose src is newer than dist by more than 60s, using package.json's name", () => {
    makePackage("packages", "engine", {
      pkgName: "@oracle/engine",
      srcAtSec: 1_000_000 + 4200,
      distAtSec: 1_000_000,
    });
    const warnings = checkBuildFreshness(repoRoot);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe("@oracle/engine dist STALE (src > dist by 4200s)");
  });

  it("skips a package missing src/ or dist/", () => {
    makePackage("packages", "no-dist", { skipDist: true });
    makePackage("packages", "no-src", { skipSrc: true });
    expect(checkBuildFreshness(repoRoot)).toEqual([]);
  });

  it("scans both packages/* and apps/*, flagging multiple stale packages", () => {
    makePackage("packages", "engine", {
      pkgName: "@oracle/engine",
      srcAtSec: 2_000_100,
      distAtSec: 2_000_000,
    });
    makePackage("apps", "worker", {
      pkgName: "@oracle/worker",
      srcAtSec: 3_000_200,
      distAtSec: 3_000_000,
    });
    const warnings = checkBuildFreshness(repoRoot);
    expect(warnings.sort()).toEqual(
      [
        "@oracle/engine dist STALE (src > dist by 100s)",
        "@oracle/worker dist STALE (src > dist by 200s)",
      ].sort()
    );
  });

  it("never throws and returns [] when packages/ and apps/ don't exist", () => {
    const empty = mkdtempSync(join(tmpdir(), "oracle-build-freshness-empty-"));
    try {
      expect(() => checkBuildFreshness(empty)).not.toThrow();
      expect(checkBuildFreshness(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("never throws given a nonexistent repoRoot entirely", () => {
    expect(() => checkBuildFreshness(join(repoRoot, "does-not-exist"))).not.toThrow();
    expect(checkBuildFreshness(join(repoRoot, "does-not-exist"))).toEqual([]);
  });
});

describe("checkBuildFreshness — git commit-time mode", () => {
  it("REGRESSION: no warning when the last src commit predates dist, even though src mtimes are newer (post-git-pull shape)", () => {
    // git pull rewrote src mtimes to "now" (10000s past dist) but the last
    // commit touching src predates the dist build — the build is current.
    makePackage("packages", "engine", { srcAtSec: 1_010_000, distAtSec: 1_000_000 });
    mocks.execFileSync.mockReturnValue(Buffer.from("999000\n"));
    expect(checkBuildFreshness(repoRoot)).toEqual([]);
  });

  it("flags when the last src commit is newer than dist by more than 60s, ignoring src mtimes", () => {
    // src mtimes equal dist (would be fresh under the old check) — but the
    // last commit touching src postdates the dist build by 4200s.
    makePackage("packages", "engine", {
      pkgName: "@oracle/engine",
      srcAtSec: 1_000_000,
      distAtSec: 1_000_000,
    });
    mocks.execFileSync.mockReturnValue(Buffer.from("1004200\n"));
    expect(checkBuildFreshness(repoRoot)).toEqual([
      "@oracle/engine dist STALE (src > dist by 4200s)",
    ]);
  });

  it("asks git for the package's forward-slash src pathspec with repoRoot as cwd", () => {
    makePackage("packages", "engine", {});
    mocks.execFileSync.mockReturnValue(Buffer.from("999000\n"));
    checkBuildFreshness(repoRoot);
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "git",
      ["log", "-1", "--format=%ct", "--", "packages/engine/src"],
      expect.objectContaining({ cwd: repoRoot })
    );
  });

  it("falls back to the mtime comparison when git output is empty (no commit history)", () => {
    makePackage("packages", "engine", {
      pkgName: "@oracle/engine",
      srcAtSec: 1_004_200,
      distAtSec: 1_000_000,
    });
    mocks.execFileSync.mockReturnValue(Buffer.from("\n"));
    expect(checkBuildFreshness(repoRoot)).toEqual([
      "@oracle/engine dist STALE (src > dist by 4200s)",
    ]);
  });

  it("warns about the fallback exactly once per scan, no matter how many packages", () => {
    makePackage("packages", "engine", {});
    makePackage("apps", "worker", {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      checkBuildFreshness(repoRoot); // default mock throws → fallback for both packages
      const fallbackWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("falling back to mtime")
      );
      expect(fallbackWarns).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("getStaleBuildNote/setStaleBuildNote", () => {
  afterEach(() => {
    setStaleBuildNote(undefined); // reset module-level stash between tests
  });

  it("returns undefined before anything is stashed", () => {
    expect(getStaleBuildNote()).toBeUndefined();
  });

  it("returns exactly what was set", () => {
    setStaleBuildNote("⚠️ build freshness: @oracle/engine dist STALE (src > dist by 4200s)");
    expect(getStaleBuildNote()).toBe(
      "⚠️ build freshness: @oracle/engine dist STALE (src > dist by 4200s)"
    );
  });
});
