---
name: de-sloppify-pass
description: Cleanup pass — removes debug code, dead branches, and poor naming after implementation
triggers: /de-sloppify, /cleanup-pass
---

# De-Sloppify Pass Loop

**Goal**: Recent changes are clean, minimal, and convention-aligned
**Max iterations**: 6
**Between iterations run**: `pnpm turbo run typecheck test`
**Exit when**: No slop found and checks pass

**Workflow**:
1. Review the diff for: debug/console logs, dead code branches, magic numbers, poor naming, speculative abstractions.
2. Fix with minimal, surgical edits only (no drive-by refactoring of unrelated code).
3. Repeat until clean.

Run this after every major implementation task, before opening a PR.
