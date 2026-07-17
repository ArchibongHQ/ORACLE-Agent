# @oracle/engine

Core prediction/decision engine — batching, calibration, market models (goals, markets V3, GBM), rating/regime models, RAG, safety checks, and the swarm decision layer. This is the analytical heart of ORACLE.

- **Entry points:** `src/index.ts` (large curated re-export surface), `src/config.ts` (`OracleConfig`), `src/types.ts`.
- **Key exports:** `runBatch`/`parseFixtureList`/`runPool` (batch execution), `CalibrationEngine`/`plattScale`/`isotonicCalibrateFp` (calibration), plus modules under `batch/`, `calibration/`, `decision/`, `execution/`, `gbm/`, `goalsV3/`, `markets/`, `marketsV3/`, `math/`, `rag/`, `ratings/`, `regime/`, `safety/`, `swarm/`. Consumed by nearly every other app/package.

**Gotcha:** Depends only on `@oracle/storage` and `@oracle/llm` — keep it free of app-level concerns (notify/bot/booking). `StoragePort` (in `@oracle/storage`) is the ONLY persistence contract for this package — never import a concrete storage adapter directly, always go through `StoragePort`.
