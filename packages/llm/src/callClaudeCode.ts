/** Local transport: shells out to the `claude` CLI in headless mode instead of
 *  an HTTP SDK. Mirrors callOpenRouter.ts's contract — never throws, returns
 *  null on any failure (binary missing, timeout, non-zero exit, an `is_error`
 *  envelope, unparseable JSON) — so every call site falls through to the
 *  existing GLM-first API cascade unchanged on null.
 *
 *  Envelope shape live-verified 2026-06-22 via `claude -p --output-format
 *  json` (success and a forced model-404 error case): top-level
 *  `{ type: "result", is_error: boolean, result: string, ... }`. On
 *  is_error=true, `result` is a human-readable error description, not
 *  decision JSON — treated as a failure, not handed downstream.
 *
 *  Model: pinned to DEFAULT_MODEL ("opus") via --model on every invocation —
 *  never left to the CLI's account default, which could silently resolve to
 *  Sonnet on some accounts. Operator instruction: every Claude call doing
 *  analysis/decision-making in this pipeline must target Opus or Fable-5-or-
 *  newer, never Sonnet or older. Callers may override via opts.model (e.g.
 *  "fable") but must not pass a Sonnet/Haiku alias.
 *
 *  Auditability: the CLI still samples at the pinned model's own default
 *  temperature — there is no temperature knob to pin to 0, so callers must not
 *  claim temperature=0 for this tier (unlike callClaude.ts's API path). Record
 *  model as "claude-code-local" (or "claude-code-arbiter" at the decision-layer
 *  call site) and keep the raw envelope for DecisionReplay at the call site.
 *
 *  The no-Sonnet rule above has no exceptions in practice: the goals-discovery
 *  screening stage (packages/runtime/src/goalsScreen.ts) also calls through
 *  this file and resolves to DEFAULT_MODEL ("opus") like every other call site,
 *  despite its own header comment historically describing a Sonnet exception
 *  routed through callClaude.ts's API transport — that routing was never
 *  actually wired up. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const REQUEST_TIMEOUT_MS = 20_000;

/** Tree-kill a process on timeout. child.kill() on Windows only signals the
 *  immediate child — taskkill /T recurses the whole tree. Same pattern as
 *  fixtures.ts's _killTree (kept local here to avoid a runtime->llm
 *  cross-package dependency for one helper). */
function _killTree(pid: number): void {
  if (process.platform === "win32") {
    void import("node:child_process").then(({ execFile }) => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {
        /* best-effort — process may have already exited */
      });
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* process group may not exist if already exited */
    }
  }
}

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

/** Spawn a process, write `input` to its stdin, collect stdout+stderr. Async
 *  (not spawnSync) so this never blocks the event loop. Stdin (not argv)
 *  carries the prompt — avoids Windows' ~8K command-line length limit on long
 *  briefing/CVL prompts. Captures stderr and the specific failure mode
 *  (spawn error / timeout / exit code) so callClaudeCode's caller can log a
 *  real reason instead of a bare null — every failure used to be
 *  indistinguishable, which made the CLI's fallback path impossible to
 *  root-cause from the worker's own logs (confirmed live 2026-07-01: the
 *  Windows Service fell back to "Claude local unavailable" on ~49/50
 *  fixtures with zero diagnostic trace anywhere). */
function _spawnWithStdin(
  command: string,
  args: string[],
  input: string,
  timeoutMs: number
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    void import("node:child_process").then(({ spawn }) => {
      let child: import("node:child_process").ChildProcess;
      // Forward USERPROFILE so the claude CLI finds its OAuth credentials when
      // the worker runs as LocalSystem (which has no .claude/ in its own profile).
      const env = process.env.CLAUDE_USERPROFILE
        ? { ...process.env, USERPROFILE: process.env.CLAUDE_USERPROFILE }
        : process.env;
      try {
        child = spawn(command, args, { env });
      } catch (err) {
        resolve({
          status: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          spawnError: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const finish = (status: number | null, spawnError?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status, stdout, stderr, timedOut, spawnError });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid != null) _killTree(child.pid);
        finish(null);
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => finish(null, err instanceof Error ? err.message : String(err)));
      child.on("close", (code) => finish(code));
      child.stdin?.on("error", () => {
        /* EPIPE if the process exits before stdin finishes writing — finish()
         * via close/error handles the outcome either way. */
      });
      child.stdin?.write(input);
      child.stdin?.end();
    });
  });
}

let _binCache: string | undefined;

/** Resolve the claude CLI binary. Honors CLAUDE_BIN, then the known install
 *  location (~/.local/bin/claude[.exe] — live-verified via `where claude` on
 *  this box), then falls back to bare "claude" for PATH resolution. Mirrors
 *  apps/worker/src/index.ts's resolvePythonBin() shape. Cached per process. */
function resolveClaudeBin(): string {
  if (_binCache !== undefined) return _binCache;
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) {
    _binCache = process.env.CLAUDE_BIN;
    return _binCache;
  }
  const candidate = join(
    homedir(),
    ".local",
    "bin",
    process.platform === "win32" ? "claude.exe" : "claude"
  );
  _binCache = existsSync(candidate) ? candidate : "claude"; // fall back to PATH resolution
  return _binCache;
}

function _probeClaudeOnPath(): boolean | null {
  const pathEnv = process.env.PATH ?? process.env.Path;
  if (!pathEnv) return null; // inconclusive — let the platform tiebreaker decide
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathEnv.split(delimiter)) {
    for (const ext of exts) {
      if (existsSync(join(dir, `claude${ext.toLowerCase()}`))) return true;
    }
  }
  if (existsSync(resolveClaudeBin())) return true;
  return false;
}

let _localRuntimeCache: boolean | undefined;

/** Whether tier-0 local Claude Code routing should be attempted. Checked once
 *  per process — PATH probing is a real filesystem scan, cheap but no reason
 *  to repeat per call. Precedence: ORACLE_RUNTIME env override > Vitest guard
 *  (every callBriefing/callVerification/swarm/decideInner test call site now
 *  gates on this — without the guard, a box with a real `claude` binary on
 *  PATH, like this one, would shell out for real on every test run) > claude
 *  binary actually found > process.platform === "win32" tiebreaker (reached
 *  only when PATH itself is unreadable — the inconclusive case, not "absent"). */
export function isLocalRuntime(): boolean {
  if (_localRuntimeCache !== undefined) return _localRuntimeCache;
  const override = process.env.ORACLE_RUNTIME;
  if (override === "local" || override === "vps") {
    _localRuntimeCache = true;
  } else if (override) {
    _localRuntimeCache = false;
  } else if (process.env.VITEST) {
    _localRuntimeCache = false;
  } else {
    _localRuntimeCache = _probeClaudeOnPath() ?? process.platform === "win32";
  }
  return _localRuntimeCache;
}

/** Test-only: clear the cached runtime probe + resolved binary path between
 *  cases. Mirrors dailyStore.ts's _resetDailyStoreCache convention. */
export function _resetClaudeCodeCaches(): void {
  _localRuntimeCache = undefined;
  _binCache = undefined;
}

interface ClaudeCodeEnvelope {
  type?: string;
  is_error?: boolean;
  result?: string;
}

/** Default model for every local Claude Code invocation in this pipeline. Operator
 *  instruction: analysis/decision-making calls must target Opus or Fable-5-or-newer,
 *  never Sonnet or older — so this is pinned explicitly via --model rather than left
 *  to the CLI's account default, which could silently be Sonnet on some accounts. */
const DEFAULT_MODEL = "opus";

/** Truncate a diagnostic string to keep failure logs from a 50-100-fixture
 *  batch readable — full text isn't needed to identify the failure class. */
function _truncate(s: string, max = 300): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Call the local Claude Code CLI headlessly. Returns the cleaned response
 *  text (fence-stripped, same convention as callOpenRouter.ts) or null on any
 *  failure — including an is_error envelope, which carries a human-readable
 *  error description in `result`, not decision JSON. Callers hand the
 *  returned text to the same parseDecisionResponse/fence-stripping logic the
 *  API cascade already uses.
 *
 *  Every failure branch logs one diagnostic line to stderr before returning
 *  null. Previously all failures were silent, which made the widespread
 *  "Claude local unavailable" fallback (confirmed live 2026-07-01: ~49/50
 *  fixtures in a scheduled Windows Service run) impossible to root-cause —
 *  spawn error, timeout, non-zero exit, and auth/session failure all looked
 *  identical from the outside. */
export async function callClaudeCode(
  prompt: string,
  opts: { timeoutMs?: number; model?: string } = {}
): Promise<string | null> {
  const bin = resolveClaudeBin();
  const { status, stdout, stderr, timedOut, spawnError } = await _spawnWithStdin(
    bin,
    ["-p", "--output-format", "json", "--max-turns", "1", "--model", opts.model ?? DEFAULT_MODEL],
    prompt,
    opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  );

  if (spawnError) {
    process.stderr.write(`[callClaudeCode] spawn failed (bin=${bin}): ${spawnError}\n`);
    return null;
  }
  if (timedOut) {
    process.stderr.write(
      `[callClaudeCode] timed out after ${opts.timeoutMs ?? REQUEST_TIMEOUT_MS}ms (bin=${bin})\n`
    );
    return null;
  }
  if (status !== 0 || !stdout.trim()) {
    process.stderr.write(
      `[callClaudeCode] exit=${status} stdout=${stdout.trim().length}b stderr="${_truncate(stderr)}"\n`
    );
    return null;
  }

  let envelope: ClaudeCodeEnvelope;
  try {
    envelope = JSON.parse(stdout) as ClaudeCodeEnvelope;
  } catch {
    process.stderr.write(`[callClaudeCode] unparseable stdout: "${_truncate(stdout)}"\n`);
    return null;
  }
  if (envelope.is_error || !envelope.result) {
    process.stderr.write(
      `[callClaudeCode] is_error envelope: "${_truncate(envelope.result ?? "(no result field)")}"\n`
    );
    return null;
  }

  return envelope.result
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
}
