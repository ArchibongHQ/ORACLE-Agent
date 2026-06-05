# SOP: ORACLE CLI

## Objective
Drive ORACLE from the terminal via the `oracle` command instead of raw `node dist/index.js`.

## Build
```bash
pnpm --filter @oracle/cli build
# then either:
node apps/cli/dist/cli.js <command>
# or link globally:
cd apps/cli && npm link    # exposes `oracle` on PATH
```

## Commands
| Command | Purpose |
|---|---|
| `oracle run [--date] [--mode M] [--no-llm] [--json]` | Fetch today's fixtures (Odds API) and analyse all |
| `oracle fixture "Home vs Away" [--league L] [--json]` | Analyse a single fixture by name (Odds API lookup) |
| `oracle analyze <file> [--json]` | Analyse a fixture-list file (paste/upload format) |
| `oracle resolve [--date] [--json]` | Resolve a day's fixtures against actual results |
| `oracle report [--date] [--open]` | Print / open a generated HTML report |
| `oracle help` | Usage |

## Notes
- `--no-llm` zeroes the Claude/Gemini keys for that run → forces deterministic decisions.
- All commands delegate to `@oracle/runtime` (`runAnalysis` / `resolveDay`) — identical engine path to the worker.
- Storage = `.tmp/gbrain`; reports written to `.tmp/reports/oracle-<date>.html`.
- `--json` emits the RunManifest (or resolve summary) for scripting.

## Verified
`oracle fixture "Mexico vs South Africa" --league "FIFA World Cup" --no-llm` → resolved via Odds API,
analysed, wrote report (2026-06-03).
