/** Model cascade constants lifted from ORACLE_v2026_8_0.jsx §0b. */

export const MODELS = {
  GEMINI_FLASH: "gemini-3.5-flash", // GA at Google I/O 2026 — faster + better agentic than 3.1 Pro
  GEMINI_FLASH_LITE: "gemini-3.1-flash-lite", // cheapest tier — 3.5 Flash-Lite not yet GA
  GEMINI_PRO: "gemini-3.5-flash", // 3.5 Flash outperforms 3.1 Pro on agentic at 4x speed
  CLAUDE_OPUS: "claude-opus-4-8", // #1 SWE-bench (88.6%) — Briefing + framing-bias check
  CLAUDE_SONNET: "claude-sonnet-4-6", // adversarial CVL pass
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

/** OpenRouter model IDs — Tier 2 (paid, cheap frontier) and Tier 3 (free). */
export const OPENROUTER_MODELS = {
  // Tier 2 — paid
  GLM_5_2: "z-ai/glm-5.2", // 744B MoE, 1M context, MIT — primary decision model (2026-06-13)
  GLM_5_1: "z-ai/glm-5.1", // #1 SWE-bench Pro 58.4%, AIME 95.3% — GLM-5.2 fallback
  QWEN3_235B_THINKING: "qwen/qwen3-235b-a22b-thinking-2507", // cheapest near-frontier reasoning
  MIMO_V2_5_PRO: "xiaomi/mimo-v2.5-pro", // beats Claude Opus on SWE-bench Pro
  QWEN3_CODER_NEXT: "qwen/qwen3-coder-next", // SWE-bench Verified >70%, 80B MoE
  // Tier 3 — free (:free variants). Verified live on the project OpenRouter
  // account 2026-06-17: GPT_OSS_120B + NEMOTRON_SUPER_120B respond with zero
  // credits; the rest are free but can 429 (transient upstream rate-limit) —
  // kept as deeper fallbacks so a busy model just rolls to the next. The old
  // DeepSeek-R1/V4, GLM-4.5-Air, and Kimi-K2.6 ":free" slugs were RETIRED by
  // OpenRouter (now 404 "unavailable for free") and removed from the cascade.
  GPT_OSS_120B: "openai/gpt-oss-120b:free", // 117B MoE — CONFIRMED working free
  NEMOTRON_SUPER_120B: "nvidia/nemotron-3-super-120b-a12b:free", // 120B MoE, 1M ctx — CONFIRMED working free
  QWEN3_NEXT_80B: "qwen/qwen3-next-80b-a3b-instruct:free", // 80B MoE, 262K ctx — free (can 429)
  NEMOTRON_NANO_30B: "nvidia/nemotron-3-nano-30b-a3b:free", // 30B reasoning, 256K ctx — free
  GPT_OSS_20B: "openai/gpt-oss-20b:free", // 20B MoE — lighter free fallback
  LLAMA_3_3_70B: "meta-llama/llama-3.3-70b-instruct:free", // 70B general — free (can 429)
} as const;

export type OpenRouterModelId = (typeof OPENROUTER_MODELS)[keyof typeof OPENROUTER_MODELS];
