# ORACLE Agent

A self-improving football-prediction and betting-analysis engine for a single power user.
A deterministic quant core (Poisson/Dixon-Coles scorelines, Elo/pi ratings, GBM residual model,
hierarchical calibration) produces eligible bets; a multi-tier LLM cascade (Claude → Gemini →
OpenRouter, with a deterministic last resort) selects among them; hard code-level gates the LLM
cannot override validate the result. Delivery is via CLI, a localhost web UI, a Telegram bot, and
a daily cron worker.

## Quick start

```bash
pnpm install
cp .env.example .env        # fill in CLAUDE_API_KEY, GEMINI_API_KEY, ODDS_API_KEY at minimum
pnpm turbo run typecheck test build
```

Run things:

```bash
pnpm --filter @oracle/worker start        # cron daemon (daily 09:00 batch, 14:00 resolve)
pnpm --filter @oracle/worker start:now    # one-shot batch + resolve
pnpm --filter @oracle/web start           # web UI/API on http://127.0.0.1:8787
node apps/cli/dist/cli.js help            # CLI (after build)
python -m pytest tools/ -q                # Python tool tests
```

## Layout

| Path | What it is |
|---|---|
| `packages/engine` | Deterministic quant core — math, batch, decision cascade, calibration, safety gates, swarm, RAG |
| `packages/storage` | `StoragePort` + Memory/GBrain(PGlite)/Sql adapters |
| `packages/llm` | LLM provider clients + model cascades (`cascade.ts` is the canonical model-ID table) |
| `packages/runtime` | Shared app layer — fixtures, analysis orchestration, reports, punt pipeline |
| `packages/notify` | Telegram/Slack/Email/OpenClaw push (env-gated, optional) |
| `apps/worker` | Cron daemon; stamps `.tmp/worker_heartbeat.json` (surfaced at `/health`) |
| `apps/web` | Zero-dep node:http UI/API, localhost-only |
| `apps/cli` | `oracle` command |
| `apps/bot` | Telegram punt bot (single chat-ID gated) |
| `apps/booking` | Playwright SportyBet accumulator agent (anonymous, no real money) |
| `tools/` | Python data-acquisition + ML scripts (see `tools/lib/` for shared helpers) |
| `workflows/` | Operational SOPs — the authoritative how-to for every recurring task |
| `archive/` | Pre-refactor monolith, kept for provenance only |

## Where to read next

- `VISION.md` — goals, KPIs, roadmap
- `CLAUDE.md` — standing instructions for agent sessions (WAT framework, verification loop)
- `ORACLE_PRD.md` — historical spec; rationale for the objective function and methodology gates
- `workflows/` — per-task SOPs (daily run, resolve, backfill, backtest, skillopt, …)

## Verification

Every change must pass the full local pipeline before it lands:

```bash
pnpm turbo run typecheck test build && pnpm exec biome ci .
```

CI (`.github/workflows/ci.yml`) enforces the same pipeline plus `pytest tools/` on every push.
