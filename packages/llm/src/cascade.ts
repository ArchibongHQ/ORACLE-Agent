/** Model cascade constants lifted from ORACLE_v2026_8_0.jsx §0b. */

export const MODELS = {
  GEMINI_FLASH:      'gemini-3.5-flash',
  GEMINI_FLASH_LITE: 'gemini-3.1-flash-lite',
  GEMINI_PRO:        'gemini-3.1-pro-preview',
  CLAUDE_OPUS:       'claude-opus-4-8',
  CLAUDE_SONNET:     'claude-sonnet-4-6',
} as const;

export type ModelId = typeof MODELS[keyof typeof MODELS];

export const THINKING_LEVELS = {
  MINIMAL: 'minimal',
  LOW:     'low',
  MEDIUM:  'medium',
  HIGH:    'high',
} as const;

export type ThinkingLevel = typeof THINKING_LEVELS[keyof typeof THINKING_LEVELS];

/** Cascade for acquisition turns (T1/T2/T3): Flash → Flash-Lite fallback. */
export const ACQUISITION_CASCADE: ModelId[] = [
  MODELS.GEMINI_FLASH,
  MODELS.GEMINI_FLASH_LITE,
];

/** Cascade for decision layer: Pro first (best reasoning), Flash as fallback. */
export const DECISION_CASCADE: ModelId[] = [
  MODELS.GEMINI_PRO,
  MODELS.GEMINI_FLASH,
];
