# ORACLE Agent — Claude Instructions

## Architecture: WAT Framework

This project separates concerns so probabilistic AI handles reasoning while deterministic code handles execution. That separation is what makes the system reliable.

**Why it matters:** If each step is 90% accurate, five steps in a row yields 59% success. By offloading execution to deterministic scripts, the agent stays focused on orchestration and decision-making — where it excels.

### Layer 1 — Workflows (The Instructions)
Markdown SOPs stored in `workflows/`. Each workflow defines the objective, required inputs, which tools to use, expected outputs, and how to handle edge cases. Written in plain language, the same way you'd brief someone on your team.

### Layer 2 — Agent (The Decision-Maker)
This is Claude's role. Read the relevant workflow, run tools in the correct sequence, handle failures gracefully, and ask clarifying questions when needed. Connect intent to execution without trying to do everything directly.

> Example: Need to pull data from a website? Read `workflows/scrape_website.md`, identify required inputs, then execute `tools/scrape_single_site.py`. Do not attempt it directly.

### Layer 3 — Tools (The Execution)
Python scripts in `tools/` that do the actual work — API calls, data transformations, file operations, database queries. Credentials and API keys live in `.env`. These scripts are consistent, testable, and fast.

---

## Operating Rules

### 1. Look for existing tools first
Check `tools/` and `.claude/skills/` or  [at](https://www.skills.sh/) - pick only those with high GitHub Stars, installs, security pass and scanning with security tools/skills first - before building anything new. Only create new scripts when nothing exists for that task.

### 2. State a plan before acting
For any non-trivial task, lead with a 3-step execution plan, identify required context and tool dependencies, and propose alternative recovery paths before starting.

### 3. Learn and adapt when things fail
When you hit an error:
- Read the full error message and trace
- Fix the script and retest
- If the fix involves paid API calls or credits, check before running again
- Document what you learned in the workflow (rate limits, timing quirks, unexpected behavior)

### 4. Keep workflows current
Workflows evolve as you learn. When you find better methods, discover constraints, or hit recurring issues, update the relevant workflow. Do not create or overwrite workflows without asking unless explicitly told to — these are standing instructions, not disposable notes.

### 5. Self-improvement loop
Every failure is a chance to make the system stronger:
1. Identify what broke
2. Fix the tool
3. Verify the fix works
4. Update the workflow with the new approach
5. Move on with a more robust system

### 6. Data is never a blocker
A missing API key or credit MUST NEVER produce a BLOCKED / "user must get key" outcome. Every data point ORACLE needs (odds, stats, xG, lineups, injuries, results) can be acquired by querying Google.com's "AI Mode" through Playwright — the same pattern as the SportyBet sidecar scraper (`tools/scrape_fixtures.py`). Treat a missing key as "use the Playwright/Google-AI-Mode fallback tier," not as a terminal state. When planning, any step depending on a key must include the scrape fallback inline.

### 7. Real-time research before any plan or decision
Before making ANY plan or decision, carry out proper real-time research via web searches from MULTIPLE independent sources AND recent research papers. Newer/better methodologies, technologies, skills (https://www.skills.sh/) and papers (including football-prediction methods) ship every day; in-distribution knowledge goes stale fast. Cite sources, cross-check claims across ≥2 sources, and never assert a fact (or call something fabricated) from memory without verifying first. This is mandatory, not optional, even when confident.

---

## Code & Response Discipline

- **Zero conversational filler.** No pleasantries, no preamble. Output immediate, actionable results.
- **Surgical edits only.** Modify only what was asked. No drive-by refactoring of adjacent working code.
- **Simplicity over abstraction.** Write the shortest, cleanest code that solves the immediate problem. No speculative future-proofing.
- **Ask, don't assume.** If a prompt has multiple interpretations or missing edge-case details, stop and ask before proceeding.
- **Pin key files.** Reference critical files explicitly in prompts using `@path/to/file` (e.g., `@packages/runtime/src/index.ts`) to anchor reasoning to real code, not memory.
- **Mandatory verification.** Every code change must be followed by running the project's test and lint commands to confirm zero regressions.
- **Context compaction.** Alert the user to run `/clear` when the conversation hits 15–20 messages to prevent token bloat.
- **Model selection for coding subagents.**
  - **Tiering (skip when overhead beats benefit):** a trivial, single-file/single-line fix is handled inline — a subagent's cold-start context re-derivation costs more than it saves. Bounded standard feature/bugfix work delegates to Sonnet. Mechanical bulk/boilerplate edits (repeated renames, scaffolding) delegate to Haiku. Architecture-level decisions, high-ambiguity tasks, or high-stakes review passes delegate to Opus.
  - **Parallelize:** independent subtasks (separate files/modules, no shared state) are dispatched as parallel subagent calls in one batch, never sequential turns.
  - **Self-contained prompts:** subagents start cold with no memory of this conversation — every delegation must state the objective, exact files/line numbers, constraints already in force (surgical edits only, no drive-by refactors), and the verification step expected on return.
  - **Verification still applies:** a subagent's diff isn't done until it clears the Verification Loop below (typecheck → test → build); escalate to an Opus `/gstack-review` pass if a "standard" diff grows past ~50 lines or spans more than 2–3 files.

---

## File Structure

```
.tmp/              # Temporary files (scraped data, intermediate exports). Disposable — regenerated as needed.
tools/             # Python scripts for deterministic execution
workflows/         # Markdown SOPs defining objectives, steps, and edge cases
packages/          # TS monorepo: engine, storage, llm, runtime (shared app layer), notify (push)
apps/              # worker (cron), cli (`oracle` command), web (node:http UI/API on 127.0.0.1:8787),
                   # bot (Telegram punt bot, single chat-ID gated), booking (Playwright SportyBet
                   # accumulator agent — anonymous, no real money)
archive/           # Pre-refactor monolith (ORACLE_v2026_8_0.jsx etc.) — provenance only, never edit
.env               # API keys and secrets — NEVER store credentials anywhere else (.env.example = template)
credentials.json   # Google OAuth (gitignored)
token.json         # Google OAuth (gitignored)
```

Each `apps/*` and `packages/*` directory also has its own `CLAUDE.md` with that module's purpose, entry points, key exports, and gotchas — loaded automatically when Claude edits files there.

**Optional `.env` keys for push integrations (`@oracle/notify`):**
Telegram: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Slack: `SLACK_WEBHOOK_URL` | Email: `MAIL_API_KEY` + `MAIL_FROM` + `MAIL_TO` | OpenClaw: `OPENCLAW_GATEWAY_URL` + `OPENCLAW_TOKEN` (local OpenClaw agent gateway — see workflows/integrations.md). Missing/partial env = silently skipped. Web server: `PORT` (default 8787).

**Core principle:** Local files are for processing only. Final deliverables go to cloud services (Google Sheets, Slides, etc.) where the user can access them directly. Everything in `.tmp/` is disposable.

---

## Project Overview

- **Package Manager:** pnpm
- **Build System:** Turborepo
- **Tech Stack:** TypeScript, Node.js, Monorepo architecture

---

## Development Commands

### Global Pipeline

- **Run complete pipeline:** `pnpm turbo run typecheck test build`
- **Typecheck all:** `pnpm turbo run typecheck`
- **Test all:** `pnpm turbo run test`
- **Build all:** `pnpm turbo run build`

### Service-Specific Commands

- **Run worker (cron daemon):** `pnpm --filter @oracle/worker start`
- **Run batch worker once:** `pnpm --filter @oracle/worker start:now`
- **Web UI / API Server:** `pnpm --filter @oracle/web start`
- **Run CLI tool:** `pnpm --filter @oracle/cli build && node apps/cli/dist/cli.js`

---

## See also (modular rules in `.claude/rules/`)

- [`git-workflow.md`](.claude/rules/git-workflow.md) — branching, commit style, code style, PR review checklist, deployment stages
- [`verification.md`](.claude/rules/verification.md) — mandatory post-change verification loop
- [`gstack-integration.md`](.claude/rules/gstack-integration.md) — gstack stage-to-command table + skill routing rules
- [`gbrain.md`](.claude/rules/gbrain.md) — GBrain static configuration (search guidance stays below, auto-synced)
- Machine-specific notes (Windows paths, local services, known local quirks) live in `CLAUDE.local.md` (gitignored, not checked in)

## GBrain Search Guidance (configured by /sync-gbrain)

<!-- gstack-gbrain-search-guidance:start -->

GBrain is set up and synced on this machine. The agent should prefer gbrain
over Grep when the question is semantic or when you don't know the exact
identifier yet.

**This worktree is pinned to a worktree-scoped code source** via the
`.gbrain-source` file in the repo root (kubectl-style context).
`gbrain code-def`, `code-refs`, `code-callers`, `code-callees`, `search`, and
`query` from anywhere under this worktree route to that source by default —
no `--source` flag needed (gbrain >= 0.41.38.0; on older gbrain the call-graph
commands need `--source "$(cat .gbrain-source)"`). Conductor sibling worktrees
of the same repo each have their own pin and their own indexed pages, so
semantic results match the code on disk here.

Call-graph queries (`code-callers`/`code-callees`) also need the graph to be
built first — run `/sync-gbrain --dream` (or `--full`) if they return
`count: 0`. This only works if this source's gbrain schema pack extracts code
symbols; on a non-code-aware pack `--dream` completes but the graph stays empty
and reports a WARN. `code-def`/`code-refs` need the same extraction.

Two indexed corpora available via the `gbrain` CLI:

- This worktree's code (auto-pinned via `.gbrain-source`).
- `~/.gstack/` curated memory (registered as `gstack-brain-hppc` source via
  the existing federation pipeline).

Prefer gbrain when:

- "Where is X handled?" / semantic intent, no exact string yet:
    `gbrain search "<terms>"` or `gbrain query "<question>"`
- "Where is symbol Y defined?" / symbol-based code questions:
    `gbrain code-def <symbol>` or `gbrain code-refs <symbol>`
- "What calls Y?" / "What does Y depend on?":
    `gbrain code-callers <symbol>` / `gbrain code-callees <symbol>`
- "What did we decide last time?" / past plans, retros, learnings:
    `gbrain search "<terms>" --source gstack-brain-hppc`

Grep is still right for known exact strings, regex, multiline patterns, and
file globs. Run `/sync-gbrain` after meaningful code changes; for ongoing
auto-sync across all worktrees, run `gbrain autopilot --install` once per
machine — gbrain's daemon handles incremental refresh on a schedule.

Safety: don't run `/sync-gbrain` while `gbrain autopilot` is active — the
orchestrator refuses destructive source ops when it detects a running autopilot
to avoid racing it (#1734). Prefer registering user repos with `gbrain sources
add --path <dir>` (no `--url`): URL-managed sources can auto-reclone, and the
sync code walk for them requires an explicit `--allow-reclone` opt-in.

<!-- gstack-gbrain-search-guidance:end -->
