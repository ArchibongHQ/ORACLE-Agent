# @oracle/cli

`oracle` command-line wrapper exposing the same analysis pipeline as the worker/web app for local/manual use (run, punt, fixture, analyze, resolve, report).

- **Entry points:** `src/cli.ts` (bin `oracle` → `dist/cli.js`), `src/engine-bridge.ts`.
- **Exports:** Leaf app, thin wrapper over `@oracle/runtime`; not imported by other packages.
- **Dev commands:** `pnpm --filter @oracle/cli start`, or after build, `oracle <command>` directly (`run`, `punt <CODE>`, `fixture`, `analyze <file>`, `resolve`, `report` — see `--help` in `cli.ts`).

**Gotcha:** Uses built-in `node:util` `parseArgs` deliberately (zero-dep arg parsing). Every command delegates to the shared analysis path in `@oracle/runtime` — don't duplicate analysis logic here.
