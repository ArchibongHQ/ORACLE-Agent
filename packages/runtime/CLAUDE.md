# @oracle/runtime

Shared application layer sitting above `@oracle/engine` — env loading, fixture sourcing, the canonical analyze/resolve pipeline, and HTML/Excel report generation. This is what `apps/worker`, `apps/cli`, and `apps/web` all delegate to so analysis logic isn't duplicated across apps.

- **Entry points:** `src/index.ts` (large re-export surface), `src/analyze.ts` (`runAnalysis`, `resolveDay`), `src/env.ts` (`loadEnv`, `buildConfig`, `validateConfig`).
- **Key exports:** `runAnalysis`, `resolveDay`, `CLV_ELIGIBLE_LEAGUES`, `runCommentBarInstruction`, `generateAndWriteDailyFixtureReport`, `buildConfig`/`loadEnv`, fixture/H2H/lineups/odds/goals-funnel modules (`goalsV3/`, `marketsV3/`). Consumed by `apps/worker`, `apps/cli`, `apps/web`, `apps/bot`.

**Gotcha:** This is the correct place to add new cross-app analysis features — never duplicate analysis logic into `apps/worker` or `apps/cli` directly. Depends on `exceljs` for workbook output (`fixtureWorkbook.ts`, `goalsWorkbook.ts`).
