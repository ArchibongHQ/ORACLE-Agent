# Local Development — Running All ORACLE Services

## The Problem: PC Crash on Full Stack Launch

Running all ORACLE services (worker + bot + web) simultaneously on an 8 GB RAM machine caused Windows to force-restart. Root cause: unbounded Node.js heap + 8 concurrent batch jobs + Playwright browser launches combined to exceed available RAM, triggering a Windows OOM kernel restart.

---

## Fix Applied (code-side)

Three changes are already committed to the repo:

| What | Where | Effect |
|---|---|---|
| Node heap caps | `apps/*/package.json` `start` scripts | worker ≤ 512 MB, bot/web ≤ 256 MB each |
| Lower concurrency default | `.env.example` | `BATCH_CONCURRENCY=3` instead of 8 |
| Staggered startup | `scripts/start-local.js` | web → bot → worker with 3s gaps |

---

## How to Start All Services Locally

```
pnpm start:local
```

This runs `scripts/start-local.js` which starts services with 3-second gaps so they don't all spike RAM at the same moment. Press **Ctrl+C** to stop everything cleanly.

**Do not** run `pnpm --filter @oracle/worker start`, `pnpm --filter @oracle/bot start`, and `pnpm --filter @oracle/web start` in three terminals simultaneously — that's what caused the crash.

---

## Required: Windows Page File Configuration

With only 8 GB physical RAM, Windows needs a page file (virtual memory on disk) as a safety valve. Without it, any RAM spike causes an instant kernel restart instead of a graceful slowdown.

**Steps:**
1. Press `Win + R` → type `sysdm.cpl` → Enter
2. Go to **Advanced** tab → **Performance** → **Settings**
3. Go to **Advanced** tab → **Virtual Memory** → **Change**
4. Uncheck **"Automatically manage paging file size for all drives"**
5. Select your SSD drive (usually C:)
6. Choose **"Custom size"**: Initial = **8192 MB**, Maximum = **16384 MB**
7. Click **Set** → **OK** → restart when prompted

After this, a RAM spike will cause temporary slowness (paging to SSD) instead of a hard restart.

---

## Environment Variables for Local Runs

In your `.env`, set these values for local stability:

```bash
BATCH_CONCURRENCY=3          # 3 is safe; 8 is for Railway cloud
ENABLE_SPORTYBET_BOOKING=false   # Playwright browser = 400-600 MB spike; keep off locally
ENABLE_SWARM=false               # Multiplies LLM calls; not needed locally
ENABLE_NEWS_INTEL=false          # Extra Perplexity call per fixture
MAX_FIXTURES_PER_RUN=20          # Reduce from 50 to limit batch duration and RAM
```

---

## Memory Budget (post-fix, at batch time)

| Service | Heap cap | Actual typical |
|---|---|---|
| oracle-web | 256 MB | ~80–120 MB |
| oracle-bot | 256 MB | ~60–100 MB |
| oracle-worker (idle) | 512 MB | ~100–150 MB |
| oracle-worker (batch, 3 concurrent) | 512 MB | ~300–450 MB |
| Python subprocess (scraper) | uncapped | ~100–200 MB |
| Windows + background | — | ~3–4 GB |
| **Total peak** | | **~4–5 GB of 8 GB** |

This leaves ~3 GB headroom — enough to avoid a crash.

---

## If You Still See High Memory

1. Open Task Manager → Details tab → sort by Memory
2. Look for `node.exe` processes exceeding their caps (shouldn't happen with `--max-old-space-size`)
3. Look for `python.exe` processes — Playwright-based scrapers can hold memory if they crash mid-run
4. Kill any zombie Python processes: `taskkill /F /IM python.exe`
5. Check `.tmp/` folder size — large accumulated reports/models can cause disk pressure which worsens paging

---

## Never Force-Kill a Node Process Touching `.tmp/gbrain`

`GBrainAdapter` (`packages/storage/src/GBrainAdapter.ts`) is backed by PGlite —
Postgres compiled to WASM, running in-process with no separate server. It has
no crash-recovery story: if the process is killed while a write is in flight
(`taskkill /F`, PowerShell `Stop-Process -Force`, a hung-process cleanup, a
host OOM-killer), the WASM heap's page files on disk can corrupt such that
even a bare `SELECT 1` aborts on the *next* connection attempt — before any
application query runs, during Postgres's own WAL-replay startup. There is no
repair path: PGlite doesn't expose `pg_resetwal`/single-user recovery mode, so
once this happens the store is a write-off, not a fix-it.

This has happened three times (2026-06-15 ×2, 2026-06-22) from killing
runaway/orphaned `node` CLI or worker processes mid-run instead of letting
them exit.

**Rule:** never `taskkill /F`, `Stop-Process -Force`, or otherwise hard-kill a
node process that might be mid-write to `.tmp/gbrain` (any `oracle punt`,
`oracle analyze`, worker batch run, or anything instantiating
`GBrainAdapter`). If a run needs to be stopped:

1. Prefer `Ctrl+C` (SIGINT) in the owning terminal — Node's normal shutdown
   lets in-flight PGlite operations finish or fail cleanly.
2. If it must be killed from outside that terminal (e.g. an orphaned
   background task), send a plain `Stop-Process` (no `-Force`) first and give
   it a few seconds.
3. Only use `-Force`/`/F` as a last resort, and only when you're prepared for
   `.tmp/gbrain` to need rebuilding afterward.

**If corruption happens anyway** (any `GBrainAdapter` call throws
`Aborted(). Build with -sASSERTIONS for more info.`):

1. Confirm it's the on-disk store, not a regression — a fresh in-memory
   instance (`new GBrainAdapter()`, no path) should still work fine.
2. There is no recovery — `mv .tmp/gbrain .tmp/gbrain.corrupted-<date>` (don't
   delete immediately; keep one copy in case offline forensic recovery of
   `oracle_v2026_ledger`/`oracle_v2026_bankroll` is ever worth attempting),
   then let the next run create a fresh store.
3. Run `pnpm --filter @oracle/storage test` to confirm the fresh store
   round-trips correctly before resuming normal use.
4. Calibration ledger, bankroll state, and Elo/Pi ratings accumulated since
   the last successful read are lost — there is currently no periodic backup
   of `.tmp/gbrain`. Treat this as the cost of the force-kill, not a tooling
   bug to chase further right now.

---

## Cloud (Railway) — No Change Needed

Railway services each run in isolated containers with dedicated RAM. The heap caps in `package.json` apply there too (worker gets 512 MB, others 256 MB) but Railway allocates per-service so there's no contention. Set `BATCH_CONCURRENCY=8` in Railway environment variables to restore cloud-scale throughput.
