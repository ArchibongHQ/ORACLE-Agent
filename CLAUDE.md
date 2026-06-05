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
Check `tools/` and `.claude/skills/` before building anything new. Only create new scripts when nothing exists for that task.

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

---

## Code & Response Discipline

- **Zero conversational filler.** No pleasantries, no preamble. Output immediate, actionable results.
- **Surgical edits only.** Modify only what was asked. No drive-by refactoring of adjacent working code.
- **Simplicity over abstraction.** Write the shortest, cleanest code that solves the immediate problem. No speculative future-proofing.
- **Ask, don't assume.** If a prompt has multiple interpretations or missing edge-case details, stop and ask before proceeding.
- **Mandatory verification.** Every code change must be followed by running the project's test and lint commands to confirm zero regressions.
- **Context compaction.** Alert the user to run `/clear` when the conversation hits 15–20 messages to prevent token bloat.

---

## File Structure

```
.tmp/              # Temporary files (scraped data, intermediate exports). Disposable — regenerated as needed.
tools/             # Python scripts for deterministic execution
workflows/         # Markdown SOPs defining objectives, steps, and edge cases
packages/          # TS monorepo: engine, storage, llm, runtime (shared app layer), notify (push)
apps/              # worker (cron), cli (`oracle` command), web (node:http UI/API on 127.0.0.1:8787)
.env               # API keys and secrets — NEVER store credentials anywhere else
credentials.json   # Google OAuth (gitignored)
token.json         # Google OAuth (gitignored)
```

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

## Code Development Workflow

### 1. Branching & Git Style

- **Branch Naming:** `feature/short-description`, `bugfix/issue-id`, or `chore/task-name`.
- **Commit Messages:** Follow Conventional Commits (e.g., `feat(cli): add export command`, `fix(worker): handle timeout error`).

### 2. Code Style & Guidelines

- **TypeScript:** Strict mode enabled. Prefer explicit types for exported functions and API responses. Avoid `any`.
- **Imports:** Use absolute paths with aliases (e.g., `@/components/...`) where configured. Do not use deeply nested relative paths (`../../..`).
- **Formatting:** Handled via Prettier/ESLint. Run validation before committing code.
- **Error Handling:** Wrap async operations in try/catch blocks; use robust error boundaries and explicit logging via the internal logger.

---

## Code Review (PR) Guidelines

When preparing a Pull Request or reviewing code, ensure the following criteria are met:

- **Self-Review Checklist:**
  1. Does the code pass the complete local pipeline (`pnpm turbo run typecheck test build`)?
  2. Are there any console logs left behind? (Remove or convert to system logs).
  3. Are new feature additions covered by unit or integration tests?
- **PR Description Template:** Always provide a brief summary of *What* changed, *Why* it changed, and a *How to Test* section.

---

## Deployment Stages

### 1. Staging / Verification

- Merges into the `main` branch automatically trigger the CI/CD pipeline.
- Ensure all automated integration tests pass in the staging environment before pushing to production.

### 2. Production Release

- Production deployments are triggered via Git Tags (e.g., `v1.2.3`).
- **Post-Deployment Verification:** Check the `@oracle/worker` logs immediately after deployment to ensure cron loops initialize without runtime exceptions.
