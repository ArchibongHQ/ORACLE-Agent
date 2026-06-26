#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * engine-bridge — thin CLI shim that accepts a RunState + OracleConfig patch and
 * runs one ExecutionEngine pass, printing the EVMarket[] result as JSON to stdout.
 *
 * Usage:
 *   node dist/engine-bridge.js --state '<RunState JSON>' --config-patch '<partial OracleConfig JSON>'
 *
 * The Python walk-forward harness (tools/walkforward_backtest.py) calls this per fixture
 * per config variant so it can get real TS-engine probabilities instead of falling back
 * to stored values for model-flag changes.
 *
 * Exit codes: 0 = success (JSON on stdout), 1 = bad args, 2 = engine threw.
 */
import { parseArgs } from "node:util";
import type { OracleConfig, RunState } from "@oracle/engine";
import { ExecutionEngine } from "@oracle/engine";
import { buildConfig, loadEnv } from "@oracle/runtime";
import { MemoryAdapter } from "@oracle/storage";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    state: { type: "string" },
    "config-patch": { type: "string", default: "{}" },
    "store-dir": { type: "string", default: join(ROOT, ".tmp/oracle-store") },
    help: { type: "boolean", default: false },
  },
  strict: false,
});

if (values.help || !values.state) {
  process.stderr.write(
    "Usage: engine-bridge --state '<RunState JSON>' [--config-patch '<partial OracleConfig JSON>']\n"
  );
  process.exit(values.help ? 0 : 1);
}

let state: RunState;
try {
  state = JSON.parse(values.state as string) as RunState;
} catch (e) {
  process.stderr.write(`engine-bridge: invalid --state JSON: ${e}\n`);
  process.exit(1);
}

let patch: Partial<OracleConfig>;
try {
  patch = JSON.parse((values["config-patch"] as string) ?? "{}") as Partial<OracleConfig>;
} catch (e) {
  process.stderr.write(`engine-bridge: invalid --config-patch JSON: ${e}\n`);
  process.exit(1);
}

const env = loadEnv(join(ROOT, ".env"));
const base = buildConfig(env);
const config: OracleConfig = { ...base, ...patch };

const storage = new MemoryAdapter(values["store-dir"] as string);

try {
  const result = await ExecutionEngine.run(state, { storage, config });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
} catch (e) {
  process.stderr.write(`engine-bridge: engine error: ${e}\n`);
  process.exit(2);
}
