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
  GLM_5_1: "z-ai/glm-5.1", // #1 SWE-bench Pro 58.4%, AIME 95.3%
  QWEN3_235B_THINKING: "qwen/qwen3-235b-a22b-thinking-2507", // cheapest near-frontier reasoning
  MIMO_V2_5_PRO: "xiaomi/mimo-v2.5-pro", // beats Claude Opus on SWE-bench Pro
  QWEN3_CODER_NEXT: "qwen/qwen3-coder-next", // SWE-bench Verified >70%, 80B MoE
  // Tier 3 — free (:free variants)
  GPT_OSS_120B: "openai/gpt-oss-120b:free", // 117B MoE, leading complex logic
  DEEPSEEK_R1: "deepseek/deepseek-r1:free", // o1-level reasoning, open CoT
  KIMI_K2_FREE: "moonshotai/kimi-k2.6:free", // same model as KIMI_SWARM, free tier
  GLM_4_5_AIR: "z-ai/glm-4.5-air:free", // hybrid thinking mode, native tool use
  DEEPSEEK_V4_FLASH: "deepseek/deepseek-v4-flash:free", // 284B MoE, 1M context, fast
  LLAMA_3_3_70B: "meta-llama/llama-3.3-70b-instruct:free", // best general open-source
} as const;

export type OpenRouterModelId = (typeof OPENROUTER_MODELS)[keyof typeof OPENROUTER_MODELS];
