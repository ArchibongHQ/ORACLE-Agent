/** Model cascade constants lifted from ORACLE_v2026_8_0.jsx §0b. */

export const MODELS = {
  GEMINI_FLASH: "gemini-3.5-flash", // GA at Google I/O 2026 — faster + better agentic than 3.1 Pro
  GEMINI_FLASH_LITE: "gemini-3.1-flash-lite", // cheapest tier — 3.5 Flash-Lite not yet GA
  GEMINI_PRO: "gemini-3.5-flash", // 3.5 Flash outperforms 3.1 Pro on agentic at 4x speed
  CLAUDE_OPUS: "claude-opus-4-8", // #1 SWE-bench (88.6%) — Briefing + framing-bias check + CVL pass
  CLAUDE_FABLE: "claude-fable-5", // newest Claude family — local-CLI arbiter targets this or Opus, never Sonnet/older
  // Dead constant: this was meant to be a narrow, cost-conscious exception for
  // the goals-discovery screening stage (packages/runtime/src/goalsScreen.ts),
  // routed through callClaude.ts's API transport. That routing was never wired
  // up — goalsScreen.ts calls callClaudeCode() (local CLI, pinned to Opus) like
  // every other call site. No code references this constant outside test
  // mocks; the no-Sonnet policy has no exceptions in practice.
  CLAUDE_SONNET: "claude-sonnet-4-6",
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

/** OpenRouter model IDs — Tier 2 (paid) and Tier 3 (free).
 *  Cascade order per owner directive 2026-06-29:
 *  Claude (primary) → GLM-5.2 → GLM-5.1 → DeepSeek → Kimi-2.7 → GPT → Qwen3 → Minimax-M3
 *  then free tier: GPT-OSS-120B → Nemotron → Qwen3-Next 80B → etc. */
export const OPENROUTER_MODELS = {
  // ── Tier 2 — paid frontier models ────────────────────────────────────────
  GLM_5_2: "z-ai/glm-5.2", // 744B MoE, 1M ctx — primary OR model
  GLM_5_1: "z-ai/glm-5.1", // GLM-5.2 internal fallback
  DEEPSEEK_R1: "deepseek/deepseek-r1", // DeepSeek R1 reasoning model
  KIMI_K2_7: "moonshotai/kimi-k2", // Kimi K2.7 (verify slug on openrouter.ai/models)
  GPT_4O: "openai/gpt-4o", // GPT-4o (verify slug on openrouter.ai/models)
  QWEN3_235B_THINKING: "qwen/qwen3-235b-a22b-thinking-2507", // Qwen3 235B — reasoning, near-frontier
  MINIMAX_M3: "minimax/minimax-m3", // Minimax M3 (verify slug on openrouter.ai/models)
  MIMO_V2_5_PRO: "xiaomi/mimo-v2.5-pro", // beats Claude Opus on SWE-bench Pro
  QWEN3_CODER_NEXT: "qwen/qwen3-coder-next", // SWE-bench Verified >70%, 80B MoE
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
} as const;

export type OpenRouterModelId = (typeof OPENROUTER_MODELS)[keyof typeof OPENROUTER_MODELS];
