/**
 * Diagnostic: confirm resolvePythonBin() finds Python under whatever account runs it.
 *
 * The OracleWorker/OracleBot Windows services run as LocalSystem, whose LOCALAPPDATA
 * points at the systemprofile (not the human user), so a bare spawn("python") used to
 * fail ENOENT. resolvePythonBin() now scans real user profiles for the per-user install.
 *
 * To prove the fix under the SAME account the services use, run this AS SYSTEM from an
 * elevated console (the project's local Python is on the interactive user's PATH, so
 * running it as yourself does NOT reproduce the service condition):
 *
 *   psexec -s -accepteula "C:\Program Files\nodejs\node.exe" ^
 *     "C:\Users\HP PC\Documents\ORACLE\ORACLE Agent\tools\verify_python_resolution.mjs"
 *
 * PASS == "spawn error code: none" (and ideally a non-error scrape exit code).
 * Requires `pnpm --filter @oracle/runtime build` to have produced dist/ first.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePythonBin } from "../packages/runtime/dist/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

console.log("USERNAME:", process.env.USERNAME);
console.log("LOCALAPPDATA:", process.env.LOCALAPPDATA);
console.log("PYTHON_BIN env:", process.env.PYTHON_BIN ?? "(unset)");

const py = resolvePythonBin();
console.log("resolved python:", py);
console.log("python exists:", existsSync(py));

const r = spawnSync(py, ["tools/scrape_fixtures.py", "--quiet"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 240000,
});
console.log("spawn error code:", r.error ? r.error.code : "none");
console.log("scrape exit code:", r.status);
console.log("stdout tail:", (r.stdout || "").slice(-600));
console.log("stderr tail:", (r.stderr || "").slice(-600));
