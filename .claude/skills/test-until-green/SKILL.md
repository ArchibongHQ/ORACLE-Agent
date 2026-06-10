---
name: test-until-green
description: Run tests and fix until the entire suite passes
triggers: /test-until-green, /test-green
---

# Test Until Green Loop

**Goal**: All tests pass
**Max iterations**: 12
**Between iterations run**: `pnpm turbo run test`
**Exit when**: Tests exit with code 0

**Workflow**:
1. Run the test suite.
2. If failures, identify and fix the smallest root cause.
3. Repeat until all tests pass.
4. After each iteration, give a short status update.

Follow CLAUDE.md rules. Use `/gstack-review` before marking complete if diff > 50 lines.
