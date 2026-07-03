# @oracle/llm

LLM transport/routing layer — wraps Claude, Gemini, Kimi, OpenRouter, and a local "Claude Code CLI" tier, plus specialized callers for briefings, odds, news intelligence, postmortems, red-team review, regime hints, and verification, with tiered cascade/fallback routing.

- **Entry points:** `src/index.ts` (re-exports everything), individual `callX.ts` files per model/task, `src/cascade.ts` (fallback orchestration), `src/routeBatch.ts`, `src/embed.ts`.
- **Key exports:** `callBriefing`, `callClaude`, `callClaudeCode`/`isLocalRuntime` (shells out to `claude` CLI instead of HTTP), `callGeminiDecision`, `callKimiVote`/`callOpenRouterVote`/`callClaudeCodeVote` (swarm voting), `fetchNewsEnsemble`, `fetchOddsViaGemini`, `synthesizePostmortems`. Consumed by `@oracle/engine` and `@oracle/runtime`.

**Gotcha:** Depends on `@anthropic-ai/sdk` and `@google/genai` directly plus `@oracle/research`. `callClaudeCode.ts` is a Tier-0 local transport that shells out to a local `claude` CLI rather than calling an HTTP API — different failure/latency profile than the other callers.
