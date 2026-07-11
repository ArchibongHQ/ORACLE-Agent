/** Build-freshness watchdog — flags any workspace package whose dist/ predates
 *  its own src/, i.e. a `pnpm build` was skipped/forgotten before this deploy
 *  started. Compares the newest dist/ file mtime against the last git commit
 *  touching that package's src/; a src commit newer than dist by more than
 *  STALE_THRESHOLD_MS means the shipped dist is stale code.
 *
 *  Git commit time is the truth source, not src file mtimes: a `git pull`
 *  rewrites src mtimes to checkout time (and a turbo cache hit restores dist/
 *  with its original archive mtimes), so mtime-vs-mtime cried wolf after every
 *  pull even when the build was current. Deploy gaps always arrive via
 *  commits, so commit time can't false-positive that way — the deliberate
 *  trade is that uncommitted local src edits don't trigger the watchdog.
 *  When git is unavailable (missing binary, not a repo), falls back to the
 *  old mtime comparison with one console.warn so logs show which mode ran.
 *  Never throws — checkBuildFreshness degrades to [] plus one console.warn on
 *  any fs error, so a misread here can never block worker startup (mirrors
 *  every other best-effort check in this app, e.g. effectiveConfig.ts's
 *  printEffectiveConfig). */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE_GROUPS = ["packages", "apps"] as const;
const STALE_THRESHOLD_MS = 60_000; // src newer than dist by more than this = stale

let staleBuildNote: string | undefined;

/** Newest mtime (ms since epoch) of any file found recursively under `dir`.
 *  Returns null when the directory is empty, unreadable, or doesn't exist —
 *  callers treat null as "nothing to compare" rather than "definitely fresh". */
function newestMtimeMs(dir: string): number | null {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = newestMtimeMs(full);
      if (sub !== null && (newest === null || sub > newest)) newest = sub;
    } else if (entry.isFile()) {
      try {
        const mtime = statSync(full).mtimeMs;
        if (newest === null || mtime > newest) newest = mtime;
      } catch {
        /* unreadable file — skip, don't fail the whole walk */
      }
    }
  }
  return newest;
}

/** Epoch ms of the last commit touching `relPath` (forward-slash pathspec),
 *  or null when git is unavailable, times out, errors, or the path has no
 *  commit history — callers fall back to the mtime comparison on null. */
function lastCommitMs(repoRoot: string, relPath: string): number | null {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%ct", "--", relPath], {
      cwd: repoRoot,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (!/^\d+$/.test(out)) return null;
    return Number(out) * 1000;
  } catch {
    return null;
  }
}

/** package.json's "name" field (e.g. "@oracle/engine") for the warning label,
 *  falling back to the "<group>/<dirName>" path when unreadable — the
 *  freshness signal itself is what matters, not the label. */
function packageName(repoRoot: string, group: string, dirName: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, group, dirName, "package.json"), "utf8")
    ) as { name?: string };
    return pkg.name ?? `${group}/${dirName}`;
  } catch {
    return `${group}/${dirName}`;
  }
}

/** Scans packages/* and apps/* for a stale dist/ relative to src/. Skips any
 *  package missing either directory (nothing to compare). Returns one warning
 *  string per stale package — empty array when everything's fresh or the scan
 *  itself failed. */
export function checkBuildFreshness(repoRoot: string): string[] {
  try {
    const warnings: string[] = [];
    let warnedFallback = false;
    for (const group of WORKSPACE_GROUPS) {
      const groupDir = join(repoRoot, group);
      let pkgDirs: string[];
      try {
        pkgDirs = readdirSync(groupDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        continue; // no packages/ or apps/ dir in this repoRoot — nothing to scan
      }
      for (const dirName of pkgDirs) {
        const pkgRoot = join(groupDir, dirName);
        const srcDir = join(pkgRoot, "src");
        const distDir = join(pkgRoot, "dist");
        if (!existsSync(srcDir) || !existsSync(distDir)) continue; // skip missing

        let newestSrc = lastCommitMs(repoRoot, `${group}/${dirName}/src`);
        if (newestSrc === null) {
          if (!warnedFallback) {
            console.warn("[build-freshness] git unavailable — falling back to mtime comparison");
            warnedFallback = true;
          }
          newestSrc = newestMtimeMs(srcDir);
        }
        const newestDist = newestMtimeMs(distDir);
        if (newestSrc === null || newestDist === null) continue;

        const deltaMs = newestSrc - newestDist;
        if (deltaMs > STALE_THRESHOLD_MS) {
          const name = packageName(repoRoot, group, dirName);
          warnings.push(`${name} dist STALE (src > dist by ${Math.round(deltaMs / 1000)}s)`);
        }
      }
    }
    return warnings;
  } catch (err) {
    console.warn(
      `[build-freshness] check failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

/** Stashes the joined warning summary so dailyBatch.ts (run later in the same
 *  process, well after index.ts's startup check) can surface it on the
 *  Telegram summary without re-running the fs walk. Process-lifetime only —
 *  reset each restart by index.ts's startup call, never persisted to disk. */
export function setStaleBuildNote(note: string | undefined): void {
  staleBuildNote = note;
}

export function getStaleBuildNote(): string | undefined {
  return staleBuildNote;
}
