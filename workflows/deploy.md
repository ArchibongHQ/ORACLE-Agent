# SOP: Build → Merge → Update → Deploy (Railway)

## Platform Decision

**Railway** — persistent Node.js processes, pnpm monorepo support, GitHub auto-deploy,
volumes for `.tmp/`, ~$10–15/mo for three services.

**Not Netlify** — serverless only; cannot run persistent HTTP server, cron daemon, or
Telegram long-poll bot.

---

## One-Time Setup (do once)

### 1. Prepare the server for public hosting

The web server currently binds `127.0.0.1` (localhost-only). For production:

```ts
// apps/web/src/server.ts — change default host
const host = opts.host ?? process.env.HOST ?? "0.0.0.0";
```

Add a minimal bearer-token auth guard to `handleRequest()` — check
`Authorization: Bearer $WEB_SECRET` on non-health routes. Add `WEB_SECRET` to `.env`.

### 2. Create a Railway project

1. Go to railway.app → New Project → Deploy from GitHub repo
2. Select the `ArchibongHQ/ORACLE-Agent` repo
3. Railway auto-detects pnpm; set root directory to `.` (monorepo root)

### 3. Create three Railway services

| Service | Start command | Purpose |
|---|---|---|
| `oracle-web` | `pnpm --filter @oracle/web start` | HTTP UI + API on port 8787 |
| `oracle-worker` | `pnpm --filter @oracle/worker start` | Cron batch daemon |
| `oracle-bot` | `pnpm --filter @oracle/bot start` | Telegram punt bot |

### 4. Wire all environment variables

In Railway → each service → Variables, paste every key from `.env`.

> **Local vs Cloud flags** — three variables are intentionally throttled in `.env` for the
> 8 GB local machine and must be set to their full values on Railway:
>
> | Variable | Local `.env` | Railway value |
> | --- | --- | --- |
> | `BATCH_CONCURRENCY` | `3` | `8` |
> | `ENABLE_SWARM` | `false` | `true` |
> | `ENABLE_SPORTYBET_BOOKING` | `false` | `true` |

```
CLAUDE_API_KEY
GEMINI_API_KEY
OPENROUTER_API_KEY
KIMI_API_KEY
ENABLE_SWARM=true
PERPLEXITY_API_KEY
ENABLE_NEWS_INTEL=true
ODDS_API_KEY
FOOTBALL_DATA_API_KEY
API_FOOTBALL_KEY
SHARPAPI_IO_KEY
ODDS_API_IO_KEY
SPORTS_GAMEODDS_KEY
OPENWEATHER_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
BANKROLL=1000
BATCH_CONCURRENCY=8
MAX_FIXTURES_PER_RUN=50
ENABLE_SPORTYBET_BOOKING=true
PORT=8787
HOST=0.0.0.0
WEB_SECRET=<choose a strong random token>
```

### 5. Attach a Railway Volume for persistence

`.tmp/` holds reports, GBrain store, models, heartbeat. Without a volume, it resets on
every deploy.

Railway → service → Volumes → Mount at `/app/.tmp` (or wherever `ROOT` resolves).

### 6. Add Python runtime for tools

The worker calls `tools/*.py` via `child_process`. Railway's Node image does not include
Python by default. Options:

**Option A (easiest):** Add a `nixpacks.toml` to the repo root:
```toml
[phases.setup]
nixPkgs = ["python312", "python312Packages.pip"]

[phases.install]
cmds = ["pip install -r requirements.txt"]
```

**Option B:** Write a `Dockerfile` for the worker service (more control).

---

## Day-to-Day Workflow

### Developing a feature

```bash
git checkout -b feature/short-description
# ... make changes ...
pnpm turbo run typecheck test          # must be green
# for diffs >50 lines:
# /gstack-review
git add <specific files>
git commit -m "feat(scope): description"
git push origin feature/short-description
```

### Merging to main (triggers auto-deploy)

```bash
# On GitHub — open PR: feature/... → main
# CI must be green (typecheck + test + build + lint + pytest)
# Merge PR → Railway auto-deploys all three services within ~2 min
```

Manual merge locally (only when CI already confirmed green):
```bash
git checkout main
git merge --no-ff feature/short-description
git push origin main
```

### Updating a running service without a full deploy

Railway re-deploys on every push to `main`. For config-only changes (env var, no code):
- Railway Dashboard → service → Variables → edit → Save (redeploys that service only)

### Monitoring

- Railway → service → Logs (live tail)
- `GET https://<your-web-domain>/health` → `{ "ok": true, "worker": { ... } }`
- Telegram bot sends push notifications on each batch completion

### Rolling back

Railway keeps the last N deploys. Railway Dashboard → service → Deployments → pick a
prior deploy → Redeploy.

---

## Pre-Deploy Checklist (run before every merge to main)

- [ ] `pnpm turbo run typecheck test build` → all green locally
- [ ] No `console.log` left in production code (use the internal logger)
- [ ] `.env` values synced to Railway Variables for any new keys added
- [ ] `workflows/` updated if a new tool or behaviour was added
- [ ] VISION.md roadmap updated if a milestone was hit

---

## Next Code Tasks Before First Deploy

1. **`apps/web/src/server.ts`** — change default host to `0.0.0.0` + add bearer token guard
2. **`nixpacks.toml`** — add Python 3.12 + pip install so worker can call `tools/*.py`
3. **`apps/web/src/page.ts`** — update tagline/marketing copy if desired
4. Open PR: `feature/free-odds-fallbacks` → `main`

---

## Architecture on Railway (steady state)

```
GitHub push to main
       │
       ▼
  Railway CI build
  pnpm install + turbo build
       │
  ┌────┴──────────────┐
  │  oracle-web        │  GET/ POST /analyze /punt /reports /health
  │  oracle-worker     │  cron: batch every 6h + resolve at 00:15
  │  oracle-bot        │  Telegram long-poll 24/7
  └────────────────────┘
         │
     Railway Volume
     /app/.tmp/
       ├── reports/
       ├── oracle-store/
       ├── models/
       └── worker_heartbeat.json
```
