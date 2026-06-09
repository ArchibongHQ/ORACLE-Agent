---
name: ship-pr-until-green
description: Implement + Test + PR + Fix CI until merge-ready
triggers: /ship-pr-until-green, /ship-green
---

# Ship PR Until Green Loop

**Goal**: PR is open with all CI checks passing
**Max iterations**: 20
**Between iterations run**: `pnpm turbo run typecheck test build && gh pr checks`
**Exit when**: All PR checks succeed

**Workflow**:
1. Implement on a feature branch, test locally, push, open PR.
2. Fix any CI failures.
3. Repeat until PR is green and merge-ready.

Use full gstack review process (`/gstack-review`, `/gstack-cso`) before final ship.
Branch naming: `feature/short-description` or `bugfix/issue-id`.
