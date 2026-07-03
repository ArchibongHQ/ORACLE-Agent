# Git Workflow, Code Review & Deployment

## Branching & Commit Style

- **Branch Naming:** `feature/short-description`, `bugfix/issue-id`, or `chore/task-name`.
- **Commit Messages:** Follow Conventional Commits (e.g., `feat(cli): add export command`, `fix(worker): handle timeout error`).

## Code Style & Guidelines

TypeScript conventions load automatically when working with `.ts` files — see `.claude/rules/typescript.md`.

## Code Review (PR) Guidelines

When preparing a Pull Request or reviewing code, ensure the following criteria are met:

- **Self-Review Checklist:**
  1. Does the code pass the complete local pipeline (`pnpm turbo run typecheck test build`)?
  2. Are there any console logs left behind? (Remove or convert to system logs.)
  3. Are new feature additions covered by unit or integration tests?
  4. If this PR touches `packages/engine/src/{math,goalsV3,marketsV3,safety,calibration,ratings,rag,swarm,gbm}/**`, update `.claude/skills/oracle-engine/SKILL.md`'s module-index table and/or add a changelog row there.
- **PR Description Template:** Always provide a brief summary of *What* changed, *Why* it changed, and a *How to Test* section.

## Deployment Stages

### 1. Staging / Verification

- Merges into the `main` branch automatically trigger the CI/CD pipeline.
- Ensure all automated integration tests pass in the staging environment before pushing to production.

### 2. Production Release

- Production deployments are triggered via Git Tags (e.g., `v1.2.3`).
- **Post-Deployment Verification:** Check the `@oracle/worker` logs immediately after deployment to ensure cron loops initialize without runtime exceptions.
