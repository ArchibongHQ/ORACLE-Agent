# @oracle/web

Zero-dependency `node:http` web server exposing a fixture-analysis UI (Google-search-styled input page → HTML report) and a health endpoint.

- **Entry points:** `src/server.ts` (routes: `GET /`, `POST /analyze`, `GET /reports/:date`, `GET /health`), `src/page.ts` (HTML rendering).
- **Exports:** `WebDeps`/`WebResponse` types; leaf app, not consumed by other packages.
- **Dev commands:** `pnpm --filter @oracle/web start` → `node dist/server.js` (256MB heap cap).

**Gotcha:** Binds `0.0.0.0` by default for cloud deploy — set `HOST=127.0.0.1` for local-only. No authentication yet ("Auth deferred — PRD §1.3").
