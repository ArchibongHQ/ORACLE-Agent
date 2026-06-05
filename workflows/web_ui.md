# SOP: ORACLE Web UI / API

## Objective
A Google-search-styled local web app: type a fixture **or** paste/upload a list → ORACLE returns
the HTML predictions report (probabilities + bet markets).

## Run
```bash
pnpm --filter @oracle/web build
pnpm --filter @oracle/web start        # http://127.0.0.1:8787  (override with PORT=...)
```

## Routes
| Method | Path | Purpose |
|---|---|---|
| GET  | `/` | Search page (single fixture input + league select + paste/upload list) |
| POST | `/analyze` | Body `{query, league?}` OR `{list}` (form-encoded or JSON) → HTML report |
| GET  | `/reports/:date` | Serve a previously generated report (`YYYY-MM-DD`) |
| GET  | `/health` | `{ "ok": true }` |

## Behaviour
- Single fixture (`query`) → `fetchFixtureByName` (Odds API lookup, optional `league` hint). No match → friendly notice.
- Pasted/uploaded list → `parseFixtureList` (same "Home vs Away, League, Kickoff" format as `today.txt`).
- Analysis runs synchronously (LLM calls take seconds) with a client-side loading spinner.
- Binds `127.0.0.1` only; **no auth** (single power user — PRD §1.3). Do not expose publicly as-is.

## Stack
Zero-dependency `node:http` (hand-rolled router, inline HTML/CSS) — matches the report.ts house style.
Logic split: `handleRequest()` (pure, unit-tested) + `startServer()` (socket I/O, owns one GBrainAdapter).

## Verified
`curl /health` → ok; `GET /` renders; `POST /analyze` with a pasted Brazil Serie B fixture → full report (2026-06-02).

## Follow-ups (not yet built)
- Job queue + SSE/polling for progress on large batches (v1 is synchronous POST).
- Auth + public deployment (deferred to the cloud stage).
