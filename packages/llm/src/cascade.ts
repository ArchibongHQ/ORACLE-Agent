/** Model cascade constants lifted from ORACLE_v2026_8_0.jsx §0b. */

export const MODELS = {
  GEMINI_FLASH: "gemini-3.5-flash", // GA at Google I/O 2026 — faster + better agentic than 3.1 Pro
  GEMINI_FLASH_LITE: "gemini-3.1-flash-lite", // cheapest tier — 3.5 Flash-Lite not yet GA
  GEMINI_PRO: "gemini-3.5-flash", // 3.5 Flash outperforms 3.1 Pro on agentic at 4x speed
  CLAUDE_OPUS: "claude-opus-4-8", // #1 SWE-bench (88.6%) — still used by Briefing + framing-bias check + CVL pass
  // Newest Claude family — available as an explicit opts.model override where a
  // caller specifically wants it; no longer the local-CLI arbiter's implicit target.
  CLAUDE_FABLE: "claude-fable-5",
  // Sonnet 5 id retained as an available opts.model override; NOT the local-CLI
  // default (owner instruction 2026-07-10 pins the local decision tier to Opus —
  // see CLAUDE_OPUS above and callClaudeCode.ts's DEFAULT_MODEL "opus").
  CLAUDE_SONNET: "claude-sonnet-5",
  // Haiku — used ONLY for the news-intel Claude reshape path (fetchNewsViaClaudeReshape),
  // where the task is structured JSON extraction from scraped prose, not reasoning.
  // Cheapest Claude tier; do not use for any decision-layer work.
  CLAUDE_HAIKU: "claude-haiku-4-5-20251001",
  KIMI_SWARM: "kimi-k2.6", // Kimi K2.6 via platform.moonshot.ai (OpenAI-compatible) — swarm workers
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

export const THINKING_LEVELS = {
  MINIMAL: "minimal",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[keyof typeof THINKING_LEVELS];

/** Cascade for acquisition turns (T1/T2/T3): Flash → Flash-Lite fallback. */
export const ACQUISITION_CASCADE: ModelId[] = [MODELS.GEMINI_FLASH, MODELS.GEMINI_FLASH_LITE];

/** Cascade for decision layer: Pro first (best reasoning), Flash as fallback. */
export const DECISION_CASCADE: ModelId[] = [MODELS.GEMINI_PRO, MODELS.GEMINI_FLASH];

/** OpenRouter base URL (OpenAI-compatible endpoint). */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** OpenRouter model IDs — Tier 2 (paid) and Tier 3 (free). Paid models MUST stay
 *  ahead of the free tier in every call-site cascade — never append a new paid
 *  fallback after the free safety net, that silently demotes it below weaker models.
 *  Cascade order per owner directive 2026-07-06 — STILL the live order for
 *  callGemini.ts, callVerification.ts, and callRegimeHint.ts (out of WS1-C's scope,
 *  unchanged by the 2026-07-10 reorder below):
 *  Claude (primary) → DeepSeek-V4-Flash → DeepSeek-V4-Pro → DeepSeek-R1 → GLM-5.2 →
 *  GLM-5.1 → Kimi-K2 → GPT-4o → Qwen3-235B-Thinking → MiniMax-M3 → MiniMax-M2.5 →
 *  MiMo-V2.5 → Qwen3-Coder-480B → Qwen3-Coder-Next(80B) → LongCat-Flash-Chat →
 *  Nemotron-3-Ultra, THEN free tier last: GPT-OSS-120B → Nemotron-3-Super →
 *  Qwen3-Next-80B → GPT-OSS-20B → Llama-3.3-70B. (NEMOTRON_NANO_30B is defined but
 *  not referenced by any call site — dormant, not part of the live cascade.)
 *
 *  Owner asked for "LongCat-2.0" and "Nemotron-4-Ultra"; verified 2026-07-06 neither
 *  exists on OpenRouter yet (LongCat-2.0 not listed — meituan/longcat-2 returns "not
 *  available"; NVIDIA's current flagship is Nemotron-3-Ultra, there is no Nemotron-4
 *  Ultra). Substituted the closest live models (LongCat-Flash-Chat 560B, Nemotron-3-
 *  Ultra 550B) per owner direction. Similarly "Qwen3 Coder 32B" doesn't exist — the
 *  existing Qwen3-Coder-Next (80B) stands in as the smaller coder-specialized tier.
 *
 *  ── 2026-07-10 decision-cascade reorder (decision/index.ts + callBriefing.ts
 *  ONLY — see the "free-tier decision-cascade rungs" block below) ──
 *  New OWNER-mandated decision cascade: (1) local Claude Code CLI, Opus —
 *  cascade.ts's MODELS.CLAUDE_OPUS / callClaudeCode.ts's DEFAULT_MODEL "opus".
 *  (2) Gemini 3.5 Flash — MODELS.GEMINI_FLASH, via callGeminiDecision(). (3)-(6) are
 *  OpenRouter rungs, STRICTLY FREE variants preferred: GLM-5.2 → DeepSeek-V4-Pro →
 *  DeepSeek-V4-Flash → Gemma 4 (31B dense or 26B MoE). Verified live 2026-07-10 (see
 *  sources in the PR description / handoff notes): DeepSeek has NO free tier on
 *  OpenRouter as of this date (every DeepSeek slug is paid — deepseek-r1:free and
 *  deepseek-chat-v3:free were retired); GLM-5.2 has no :free variant either (only
 *  the older/lighter z-ai/glm-4.5-air:free is free). Gemma 4 DOES have live free
 *  variants: google/gemma-4-26b-a4b-it:free (26B MoE) and google/gemma-4-31b-it:free
 *  (31B dense) — both confirmed on openrouter.ai. Per the pre-agreed substitution
 *  rule, each named model without a live :free endpoint is tried at its own :free
 *  slug FIRST (harmless — errors and the loop just skips it) followed immediately by
 *  the nearest live free reasoning substitute: GLM-5.2 → z-ai/glm-4.5-air:free (same
 *  vendor, hybrid thinking mode); DeepSeek-V4-Pro → nvidia/nemotron-3-ultra-550b-a55b:free
 *  (550B MoE frontier-reasoning tier, confirmed free on OpenRouter's free-models
 *  collection alongside the existing paid NEMOTRON_3_ULTRA slug); DeepSeek-V4-Flash →
 *  nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free (lighter/faster explicit
 *  "reasoning" tier, matching Flash's speed-over-size intent). These new constants
 *  are ADDITIVE — every existing Tier 2/Tier 3 constant below is unchanged and still
 *  used verbatim by callGemini.ts/callVerification.ts/callRegimeHint.ts and their
 *  tests. callBriefing.ts (WS1-C scope) separately switches to a free-tier-only
 *  OpenRouter list per task policy — briefing is an optional extra, not the gated
 *  decision path, so it never needs the paid tier. */
export const OPENROUTER_MODELS = {
  // ── Tier 2 — paid frontier models ────────────────────────────────────────
  DEEPSEEK_V4_FLASH: "deepseek/deepseek-v4-flash", // 284B MoE (13B active), 1M ctx — verified 2026-07-06
  DEEPSEEK_V4_PRO: "deepseek/deepseek-v4-pro", // 1.6T MoE (49B active), 1M ctx — verified 2026-07-06
  DEEPSEEK_R1: "deepseek/deepseek-r1", // still live (paid slug) — verified 2026-07-06
  GLM_5_2: "z-ai/glm-5.2", // 744B MoE, 1M ctx
  GLM_5_1: "z-ai/glm-5.1", // GLM-5.2 internal fallback
  // Owner asked for "Kimi-2.7"; verified 2026-06-29 there is no general-purpose
  // kimi-k2.7 slug — only the original kimi-k2 (general chat/JSON, no forced
  // extended thinking) and kimi-k2.7-code (coding-specialized, always-thinking,
  // risks the 20-60s call-site timeouts). Owner chose the original general slug.
  KIMI_K2: "moonshotai/kimi-k2",
  GPT_4O: "openai/gpt-4o", // verified 2026-06-29 on openrouter.ai/models
  QWEN3_235B_THINKING: "qwen/qwen3-235b-a22b-thinking-2507", // Qwen3 235B — reasoning, near-frontier
  MINIMAX_M3: "minimax/minimax-m3", // verified 2026-06-29 on openrouter.ai/models
  MINIMAX_M2_5: "minimax/minimax-m2.5", // 197K ctx, SWE-Bench Verified 80.2% — verified 2026-07-06
  MIMO_V2_5_PRO: "xiaomi/mimo-v2.5-pro", // beats Claude Opus on SWE-bench Pro
  QWEN3_CODER_480B: "qwen/qwen3-coder", // 480B A35B MoE coder — verified 2026-07-06
  QWEN3_CODER_NEXT: "qwen/qwen3-coder-next", // SWE-bench Verified >70%, 80B MoE
  LONGCAT_FLASH_CHAT: "meituan/longcat-flash-chat", // 560B MoE — LongCat-2.0 stand-in, see note above
  NEMOTRON_3_ULTRA: "nvidia/nemotron-3-ultra-550b-a55b", // 550B MoE — Nemotron-4-Ultra stand-in, see note above
  // ── Tier 3 — free (:free variants) ───────────────────────────────────────
  // Verified live 2026-06-17: GPT_OSS_120B + NEMOTRON_SUPER_120B work with zero
  // credits; others are free but can 429 (transient rate-limit) — kept as deeper
  // fallbacks so a busy model rolls to the next. DeepSeek-R1/V4, GLM-4.5-Air,
  // Kimi-K2.6 ":free" slugs were RETIRED by OpenRouter (404 "unavailable").
  GPT_OSS_120B: "openai/gpt-oss-120b:free", // 117B MoE — CONFIRMED working free
  NEMOTRON_SUPER_120B: "nvidia/nemotron-3-super-120b-a12b:free", // 120B MoE, 1M ctx
  QWEN3_NEXT_80B: "qwen/qwen3-next-80b-a3b-instruct:free", // 80B MoE, 262K ctx (can 429)
  NEMOTRON_NANO_30B: "nvidia/nemotron-3-nano-30b-a3b:free", // 30B reasoning, 256K ctx
  GPT_OSS_20B: "openai/gpt-oss-20b:free", // 20B MoE — lighter free fallback
  LLAMA_3_3_70B: "meta-llama/llama-3.3-70b-instruct:free", // 70B general (can 429)

  // ── Free-tier decision-cascade rungs (2026-07-10 reorder) ─────────────────
  // decision/index.ts's _tryOpenRouter (rungs 3-6) and callBriefing.ts ONLY.
  // Each named model is tried at its own :free slug first (harmless if it 404s
  // — the loop skips a null result), immediately followed by the nearest live
  // free reasoning substitute. See the OPENROUTER_MODELS header comment above
  // for the verification sources/dates.
  GLM_5_2_FREE: "z-ai/glm-5.2:free", // NOT verified live 2026-07-10 — GLM-5.2 has no confirmed free slug; try anyway, loop skips on failure
  GLM_4_5_AIR_FREE: "z-ai/glm-4.5-air:free", // verified free 2026-07-10 — GLM-5.2 substitute (same vendor, hybrid thinking mode)
  DEEPSEEK_V4_PRO_FREE: "deepseek/deepseek-v4-pro:free", // NOT verified live 2026-07-10 — DeepSeek has no free tier on OpenRouter; try anyway, loop skips on failure
  NEMOTRON_3_ULTRA_FREE: "nvidia/nemotron-3-ultra-550b-a55b:free", // verified free 2026-07-10 — DeepSeek-V4-Pro substitute (550B MoE frontier reasoning)
  DEEPSEEK_V4_FLASH_FREE: "deepseek/deepseek-v4-flash:free", // NOT verified live 2026-07-10 — DeepSeek has no free tier on OpenRouter; try anyway, loop skips on failure
  NEMOTRON_NANO_OMNI_REASONING_FREE: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", // verified free 2026-07-10 — DeepSeek-V4-Flash substitute (lighter/faster explicit reasoning tier)
  GEMMA_4_26B_MOE_FREE: "google/gemma-4-26b-a4b-it:free", // verified free 2026-07-10 — 26B MoE, rung 6 primary
  GEMMA_4_31B_FREE: "google/gemma-4-31b-it:free", // verified free 2026-07-10 — 31B dense, rung 6 fallback
} as const;

export type OpenRouterModelId = (typeof OPENROUTER_MODELS)[keyof typeof OPENROUTER_MODELS];
