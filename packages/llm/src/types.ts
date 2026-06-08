/** Minimal key config passed to every LLM call (avoids circular dep with @oracle/engine). */
export interface LLMKeyConfig {
  claudeApiKey: string;
  geminiApiKey: string;
  bankroll: number;
  [key: string]: unknown; // allows passing full OracleConfig without a hard dep
}

/** Structured context passed to every LLM call — never raw strings alone. */
export interface LLMCallContext {
  config: LLMKeyConfig;
  /** ISO-8601 timestamp; used to enforce observedAt < kickoff for soft-context items. */
  requestedAt: string;
}

/** Provider abstraction — the engine calls this interface, never a concrete SDK client. */
export interface LLMProvider {
  /** Long-form briefing (Claude Opus — §6 decision layer). Temperature = 0, model pinned. */
  callBriefing(prompt: string, ctx: LLMCallContext): Promise<string>;
  /** Data acquisition turn (Gemini cascade — T1/T2/T3). */
  callAcquisition(prompt: string, ctx: LLMCallContext): Promise<string>;
  /** Adversarial verification (Claude Sonnet — AntiSycophancyCircuit). */
  callVerification(prompt: string, ctx: LLMCallContext): Promise<string>;
}
