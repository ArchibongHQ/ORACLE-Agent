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

## Cloud (Railway) — No Change Needed

Railway services each run in isolated containers with dedicated RAM. The heap caps in `package.json` apply there too (worker gets 512 MB, others 256 MB) but Railway allocates per-service so there's no contention. Set `BATCH_CONCURRENCY=8` in Railway environment variables to restore cloud-scale throughput.
