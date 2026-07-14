# SOP: Cloud News Intelligence Routine (`oracle-news-intel`)

## Objective

This is the standing instruction set for a Claude Code CLOUD ROUTINE — an
Anthropic-managed cloud session that clones this repo's default branch fresh
every run (no persisted state between runs) and executes daily at 07:45
Africa/Lagos. The routine's saved prompt is exactly: *"Read and follow
workflows/cloud_news_intel.md for today's date."* Everything the run needs
must therefore be self-contained in this file — do not assume any prior
conversation, memory, or local-machine context.

Goal of the run: for today's fixture slate, use Claude's own WebSearch/
WebFetch tools (the AGENTIC TIER) to find confirmed pre-match team news —
injuries, suspensions, lineup hints, motivation/travel flags — one JSON file
per fixture, committed to the `data` branch. The local machine's 09:30 WAT
enrichment step later merges this into the Parquet lake via
`tools/sync_cloud_news.py`.

## Hard Environment Facts (verified 2026-07-11 — do not soften or re-litigate)

- **No browser automation.** The cloud sandbox CANNOT run Playwright/Chromium
  — the security proxy lacks HTTP CONNECT support
  (anthropics/claude-code#11791). NEVER attempt `tools/scrape_google_ai.py`,
  `tools/fetch_fotmob.py`, or `tools/fetch_sofascore.py`, and never add a
  Playwright install step to work around this. Plain HTTP (`urllib`/
  `requests`) and Claude's native WebSearch/WebFetch tools DO work.
- **VM:** Ubuntu 24.04, 4 vCPU / 16GB RAM.
- **Network:** custom allowlist only — Sportradar gismo, ESPN, Sky, RSS hosts
  (BBC/Sky/The Athletic/Guardian/Olé/OneFootball/Evening Standard/
  FootballCritic), Transfermarkt, Perplexity, api-sports. Anything outside
  this allowlist will simply fail to connect — treat that as a normal skip,
  not an error to work around.
- **Env vars available:** `PERPLEXITY_API_KEY`, `API_FOOTBALL_KEY`,
  `TZ=Africa/Lagos`.
- **No SportyBet sidecar in cloud** — it depends on Playwright. 0 odds/stats
  rows out of `acquire_daily.py` is EXPECTED here, not a failure. Fixtures
  still land from the ESPN/Sky HTTP scrapers.
- **Output path:** this routine never touches `main`. It commits only to the
  long-lived `data` branch (unrestricted branch pushes are enabled for this
  repo) and pushes. It never writes to `.tmp/` in a way that gets committed —
  `.tmp/` is scratch, disposable, VM-local only.

## Required Inputs

- Today's date, Africa/Lagos (`TZ=Africa/Lagos` is set in the environment —
  derive the date from it, do not assume UTC).
- `PERPLEXITY_API_KEY` (optional, cost-gated — see `workflows/news_intel.md`'s
  Cost Gate section; missing key degrades that one source, never blocks).
- `API_FOOTBALL_KEY` (optional; missing key degrades gracefully, never
  blocks).
- Nothing else — no local-machine state carries over into this session.

## Tools Used

- `tools/acquire_daily.py` — fixture acquisition (ESPN/Sky HTTP paths only in
  this environment).
- `tools/enrich_news.py` — RSS + Transfermarkt + (cost-gated) Perplexity rows
  into the VM-local lake.
- `tools/daily_store.py` — `read_table()` to read back what was just written.
- Claude's native WebSearch / WebFetch — the agentic research tier itself.

## Steps

1. **Determine today's date** in Africa/Lagos (`TZ=Africa/Lagos` is already
   set in the environment).

2. **Acquire the day's fixtures** — Playwright-free:
   ```bash
   python tools/acquire_daily.py --no-playwright --quiet
   ```
   This lands fixtures in `.tmp/oracle-daily` from ESPN/Sky HTTP scrapers. 0
   odds/stats rows is expected (no SportyBet sidecar here) — do not treat
   that as failure.

3. **Run the free/cheap enrichment tier**, browser sources disabled:
   ```bash
   python tools/enrich_news.py --date <date> --no-google --no-fotmob --no-sofascore --limit 60
   ```
   This writes RSS + Transfermarkt + (cost-gated) Perplexity rows into the
   VM-local lake. Politeness constraints: never raise `--limit` above 80;
   never add the `--no-google`/`--no-fotmob`/`--no-sofascore` browser tiers
   back — they cannot run here (see Hard Environment Facts) and re-enabling
   them will just burn the run on failures.

4. **Read back today's slate and what's already covered**, so the agentic
   tier below knows which teams/fixtures exist and what signal is already in
   hand:
   ```python
   import sys
   sys.path.insert(0, "tools")
   import daily_store as ds

   fixtures = ds.read_table("fixtures", date)   # today's slate
   news = ds.read_table("news", date)           # rows step 3 just wrote
   ```
   Use `fixtures` for the team/league/kickoff list and `news` to see what RSS/
   Transfermarkt/Perplexity already surfaced per team — fold that into step 5
   instead of re-deriving it.

5. **Agentic research tier — the point of this routine.** For each fixture,
   prioritized by (a) priority leagues first, then (b) team recognizability,
   up to roughly the top 40 fixtures of the slate: use WebSearch/WebFetch to
   find CONFIRMED team news within 48 hours of kickoff — injuries,
   suspensions, lineup hints, motivation flags (trophy race, relegation
   battle, dead rubber, cup hangover), travel/fixture-congestion flags. Only
   sourced facts, never speculation — carry the citation URL for every claim.
   Merge in anything relevant already found in step 4's `news` rows rather
   than re-searching for it. This mirrors the research style and JSON
   discipline of `packages/llm/src/callNewsIntel.ts`'s `buildPrompt`/`SYSTEM`
   prompt (confirmed facts only, sourced, 48h window) — apply the same
   standard here even though this tier runs as Claude's own agentic search,
   not a Sonar API call.

6. **Write one JSON file per fixture** to
   `data/news_intel/<date>/<home_slug>_vs_<away_slug>.json`, where each slug
   is the team name lowercased, spaces replaced with underscores, and every
   character outside `[a-z0-9_]` stripped. Shape is EXACTLY this — the four
   extra keys (`home`, `away`, `league`, `kickoff`) beyond the core
   `NewsIntelResult` fields are REQUIRED by the local `sync_cloud_news.py`
   merge step, do not drop them:
   ```json
   {
     "home": "Arsenal", "away": "Chelsea", "league": "Premier League", "kickoff": "<ISO>",
     "injuries": ["<player> (<team>) — <status>"], "suspensions": [], "lineupHints": [],
     "motivationFlags": [], "travelFlags": [],
     "sources": ["<url>", "..."],
     "confidence": 0.0,
     "model": "cloud-routine",
     "observedAt": "<ISO now>"
   }
   ```
   `confidence`: 0.0 when nothing was found — still write the file, a
   confident empty is signal, not a gap. Scale up toward 1.0 only with
   multiple confirmed reports. Be honest about confidence; never inflate it
   to look more useful.

7. **Write the run summary** to `data/news_intel/<date>/_summary.json`:
   ```json
   {
     "date": "<date>", "slateSize": 0, "attempted": 0, "written": 0,
     "withNews": 0,
     "sourcesUsed": {"rss": 0, "transfermarkt": 0, "perplexity": 0, "agentic": 0},
     "startedAt": "<ISO>", "finishedAt": "<ISO>"
   }
   ```
   `withNews` = count of fixtures with `confidence >= 0.4`. `sourcesUsed`
   counts rows/citations contributed by each tier (RSS and Transfermarkt from
   step 3's lake rows, Perplexity from step 3 if the cost gate allowed it,
   `agentic` from step 5's WebSearch/WebFetch findings).

8. **Commit and push, `data` branch only:**
   ```bash
   git fetch origin data
   git checkout -B data origin/data 2>/dev/null || git checkout --orphan data
   git add data/news_intel/<date>/
   git commit -m "data(news): <date> cloud news intel (<n> fixtures)"
   git push origin data
   ```
   Commit ONLY the `data/news_intel/<date>/` directory. NEVER commit to
   `main`. NEVER commit anything under `.tmp/` — it is VM-local scratch, not
   an output.

## Expected Output

- One JSON file per researched fixture under `data/news_intel/<date>/`,
  matching the shape in step 6.
- One `data/news_intel/<date>/_summary.json` matching step 7.
- A single commit on the `data` branch, pushed to `origin`, with message
  `data(news): <date> cloud news intel (<n> fixtures)`.
- Local machine's 09:30 WAT enrichment run later merges this into the
  Parquet lake via `tools/sync_cloud_news.py` — this routine's job ends at
  the push.

## Edge Cases & Known Constraints

| Scenario | Behaviour |
| --- | --- |
| `acquire_daily.py` returns 0 fixtures | Not a failure. Write `_summary.json` with `slateSize: 0` and still commit it — absence is signal, the local sync step needs to see the run happened |
| Step 2 or step 3 tool failure/exception | Non-fatal. Log it, proceed straight to the agentic tier (step 5) using WebSearch alone for whatever fixture list is available |
| `PERPLEXITY_API_KEY` / `API_FOOTBALL_KEY` missing | That one source degrades silently; RSS, Transfermarkt, and the agentic WebSearch/WebFetch tier still run in full |
| Rate-limit courtesy | Pace WebFetch calls; do not hammer a single host back-to-back across many fixtures in a tight loop |
| Login walls / CAPTCHAs | Never attempt to bypass. Skip that source for that fixture and move on |
| `git push` rejected (non-fast-forward) | Re-`fetch` and re-apply the commit on top of the latest `origin/data` once. `--force`/`--force-with-lease` is FORBIDDEN — never force-push over other runs' history on the `data` branch |
| Browser-tier tools invoked by habit | Will hang or error (no HTTP CONNECT). If you catch yourself about to run `scrape_google_ai.py` / `fetch_fotmob.py` / `fetch_sofascore.py`, stop — they are permanently out of scope for this environment, not a transient failure to retry |
| A fixture yields zero findings after genuine search effort | Still write its JSON file with empty arrays and `confidence: 0.0` — do not simply omit the file |

## Routine Setup (one-time, owner reference — not part of the daily run)

- **Environment:** `oracle-enrichment`, network allowlist as listed above
  under Hard Environment Facts.
- **Secrets:** `PERPLEXITY_API_KEY`, `API_FOOTBALL_KEY` — note these are
  visible-to-editors on this routine's environment; treat accordingly when
  granting edit access.
- **Schedule:** 07:45 Africa/Lagos daily = 1 run/day. Pro plan caps cloud
  routines at 5 runs/day — deliberately leave headroom for manual "Run now"
  retries if a run fails or needs re-triggering.
- **Created via:** the `/schedule` CLI command or the Routines UI at
  claude.ai/code/routines, saved prompt exactly: *"Read and follow
  workflows/cloud_news_intel.md for today's date."*
- **Verification note:** a green run status is NOT the same as success —
  always read the run's transcript to confirm fixtures were found, files were
  actually written, and the push to `data` succeeded, before trusting a given
  day's data.
