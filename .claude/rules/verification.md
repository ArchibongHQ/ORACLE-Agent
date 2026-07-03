# Verification Loop (Mandatory)

After every code change:

1. Run `pnpm turbo run typecheck test`
2. If anything fails, fix it before claiming success.
3. If output doesn't match expectations, explain the discrepancy — do not paper over it.
4. For any diff >50 lines, run `/gstack-review` before claiming success.
5. Use `@.claude/agents/verifier.md` for an independent review pass on non-trivial changes.
