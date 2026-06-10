---
name: build-until-green
description: Fix until typecheck and production build both succeed
triggers: /build-until-green, /build-green
---

# Build Until Green Loop

**Goal**: Production build and typecheck succeed
**Max iterations**: 10
**Between iterations run**: `pnpm turbo run typecheck build`
**Exit when**: Command exits with code 0

**Workflow**:
1. Run typecheck + build.
2. Fix the first compile/type error.
3. Repeat until both pass.

Combine with CLAUDE.md verification loop and `/gstack-review` before marking complete.
