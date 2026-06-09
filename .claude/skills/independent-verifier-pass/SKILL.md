---
name: independent-verifier-pass
description: Separate verification pass with no implementer context — trusts only command output
triggers: /independent-verifier, /verify-pass
---

# Independent Verifier Pass Loop

**Goal**: Build, typecheck, and tests all pass under independent verification
**Max iterations**: 8
**Between iterations run**: `pnpm turbo run typecheck test build`
**Exit when**: All verification commands exit with code 0

**Workflow**:
1. Trust only command output. Ignore prior claims of success.
2. Run the full verification suite cold.
3. Fix any issues found.
4. Repeat until all commands exit 0.

Use this as the final gate before requesting human review or merging.
