#!/usr/bin/env node
/**
 * Staggered local startup — prevents all services from spiking RAM simultaneously.
 * Starts web → bot → worker with a 3s gap between each.
 * Use: node scripts/start-local.js  (or: pnpm start:local)
 */

"use strict";

const { spawn } = require("node:child_process");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");

const services = [
  { label: "oracle-web",    filter: "@oracle/web",    script: "start" },
  { label: "oracle-bot",    filter: "@oracle/bot",    script: "start" },
  { label: "oracle-worker", filter: "@oracle/worker", script: "start" },
];

const children = [];

function launch(svc) {
  process.stdout.write(`[start-local] launching ${svc.label}...\n`);
  const child = spawn(
    "pnpm",
    ["--filter", svc.filter, "run", svc.script],
    { cwd: ROOT, stdio: "inherit", shell: true }
  );
  child.on("exit", (code) => {
    process.stderr.write(`[start-local] ${svc.label} exited with code ${code ?? "?"}\n`);
  });
  children.push(child);
}

function killAll(signal) {
  process.stdout.write(`\n[start-local] shutting down all services...\n`);
  for (const c of children) {
    try { c.kill(signal); } catch (_) { /* already dead */ }
  }
}

process.on("SIGINT",  () => { killAll("SIGINT");  setTimeout(() => process.exit(0), 2000); });
process.on("SIGTERM", () => { killAll("SIGTERM"); setTimeout(() => process.exit(0), 2000); });

// Stagger: web → 3s → bot → 3s → worker
launch(services[0]);
setTimeout(() => launch(services[1]), 3_000);
setTimeout(() => launch(services[2]), 6_000);

process.stdout.write("[start-local] all services queued. Press Ctrl+C to stop all.\n");
