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

/** Spawn a process, write `input` to its stdin, collect stdout. Async (not
 *  spawnSync) so this never blocks the event loop. Stdin (not argv) carries
 *  the prompt — avoids Windows' ~8K command-line length limit on long
 *  briefing/CVL prompts. */
function _spawnWithStdin(
  command: string,
  args: string[],
  input: string,
  timeoutMs: number
): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    void import("node:child_process").then(({ spawn }) => {
      let child: import("node:child_process").ChildProcess;
      try {
        child = spawn(command, args);
      } catch {
        resolve({ status: null, stdout: "" });
        return;
      }
      let stdout = "";
      let settled = false;
      const finish = (status: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status, stdout });
      };
      const timer = setTimeout(() => {
        if (child.pid != null) _killTree(child.pid);
        finish(null);
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", () => finish(null));
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

/** Call the local Claude Code CLI headlessly. Returns the cleaned response
 *  text (fence-stripped, same convention as callOpenRouter.ts) or null on any
 *  failure — including an is_error envelope, which carries a human-readable
 *  error description in `result`, not decision JSON. Callers hand the
 *  returned text to the same parseDecisionResponse/fence-stripping logic the
 *  API cascade already uses. */
export async function callClaudeCode(
  prompt: string,
  opts: { timeoutMs?: number; model?: string } = {}
): Promise<string | null> {
  const bin = resolveClaudeBin();
  const { status, stdout } = await _spawnWithStdin(
    bin,
    ["-p", "--output-format", "json", "--max-turns", "1", "--model", opts.model ?? DEFAULT_MODEL],
    prompt,
    opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  );
  if (status !== 0 || !stdout.trim()) return null;

  let envelope: ClaudeCodeEnvelope;
  try {
    envelope = JSON.parse(stdout) as ClaudeCodeEnvelope;
  } catch {
    return null;
  }
  if (envelope.is_error || !envelope.result) return null;

  return envelope.result
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
}
