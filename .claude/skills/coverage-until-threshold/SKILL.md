---
name: coverage-until-threshold
description: Add tests until coverage target is met without changing production behavior
triggers: /coverage-until-threshold, /coverage-green
---

# Coverage Until Threshold Loop

**Goal**: Coverage ≥ 80% with all tests passing
**Max iterations**: 12
**Between iterations run**: `pnpm turbo run test -- --coverage` (run per-package if needed)
**Exit when**: Coverage threshold met and all tests pass

**Workflow**:
1. Run coverage report.
2. Identify the largest uncovered gaps (lines, branches, functions).
3. Add focused unit/integration tests for those gaps.
4. Repeat without changing production behavior unnecessarily.

Do not write tests that merely inflate coverage — tests must assert real behavior.
