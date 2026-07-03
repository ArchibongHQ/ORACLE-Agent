# @oracle/worker

Scheduled cron shell that runs ORACLE's daily automation sequence (fixture acquisition → all-markets batch → goals-only batch → resolve-yesterday/punt) using `node-cron`. Contains no analysis logic itself — pure orchestration.

- **Entry points:** `src/index.ts` (main cron scheduler), plus standalone scripts `src/export-store.ts`, `src/import-backfill.ts`, `src/smoke.ts`.
- **Depends on:** `@oracle/engine`, `@oracle/runtime`, `@oracle/notify`, `@oracle/bot`, `@oracle/booking`, `@oracle/storage`. Leaf app — nothing imports from it.
- **Dev commands:** `pnpm --filter @oracle/worker start` (runs `dist/index.js`), `start:now` / `report:now` (force immediate run), `refresh-kaggle`, `export-store`, `import-backfill`.

**Gotcha:** All analysis/fixture/report logic lives in `@oracle/runtime`; this file only schedules. New logic goes in `@oracle/runtime`, not here. Runs with `--max-old-space-size=2048`.
