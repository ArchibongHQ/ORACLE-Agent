/** [PR-9, worker god-file split] Module-level bootstrap state, computed ONCE at
 *  process start and shared by index.ts plus every extracted pipeline module
 *  (dailyAcquisition.ts, dailyBatch.ts, goalsV3Pipeline.ts, goalsAccumulator.ts,
 *  resolveYesterday.ts). Re-invoking loadEnv/buildConfig/buildGoalsV3Config per
 *  module (instead of importing the single instance computed here) would be a
 *  behavior change — this file exists specifically to prevent that.
 *
 *  Both index.ts and the extracted files import these constants FROM this
 *  module — never from each other — so there is no circular import between
 *  index.ts and the pipeline files it wires together. */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig, buildGoalsV3Config, loadEnv } from "@oracle/runtime";

const __dir = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dir, "../../..");

export const env = loadEnv(join(ROOT, ".env"));
export const config = buildConfig(env);
export const goalsV3Config = buildGoalsV3Config(env);
export const STORE_PATH = join(ROOT, ".tmp/oracle-store");

// Max fixtures per chunk loop iteration. Priority-sorted fixtures are analyzed
// in batches of this size; the loop stops as soon as 39 actionable picks are
// found — avoiding analysis of hundreds of low-priority fixtures when top leagues
// already provide enough edges. Applies to both daily batch and goals batch.
export const ANALYSIS_CHUNK_SIZE = Math.max(1, Number(env.ANALYSIS_CHUNK_SIZE ?? 50));

// A bare "python"/"python3" relies on PATH resolution, which a Windows service
// host does not inherit the same way an interactive shell does (the install is
// only on this user's PATH, not the machine PATH) — causing a silent spawn
// ENOENT under Servy while working fine from a terminal. Resolve an absolute
// path up front so the scrapers/tools run identically in both contexts.
export const PYTHON_BIN = resolvePythonBin();

function resolvePythonBin(): string {
  if (process.env.PYTHON_BIN && existsSync(process.env.PYTHON_BIN)) return process.env.PYTHON_BIN;
  if (process.platform === "win32") {
    const candidates = [
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python313", "python.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Python", "bin", "python.exe"),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    return "python"; // fall back to PATH resolution (works in an interactive shell)
  }
  return "python3";
}
