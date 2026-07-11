/** Build-freshness watchdog — unit tests for checkBuildFreshness's src-vs-dist
 *  mtime comparison and the getStaleBuildNote/setStaleBuildNote stash, using a
 *  disposable fake repoRoot (packages/<name>/{src,dist}) so this never touches
 *  the real repo's actual build output. Mirrors catalogOverlay.test.ts's
 *  mkdtemp + afterEach cleanup convention. */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkBuildFreshness,
  getStaleBuildNote,
  setStaleBuildNote,
} from "../src/buildFreshness.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "oracle-build-freshness-"));
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
