export type { BriefingResult } from "./callBriefing.js";
// B1
export { callBriefing } from "./callBriefing.js";
export { callClaude } from "./callClaude.js";
// Tier-0 local transport — shells out to the `claude` CLI instead of an HTTP SDK
export { _resetClaudeCodeCaches, callClaudeCode, isLocalRuntime } from "./callClaudeCode.js";
export { callGeminiDecision, fetchGeminiWithCascade } from "./callGemini.js";
export type { KimiVote } from "./callKimi.js";
// Swarm worker (Kimi K2.6 + OpenRouter fallbacks + tier-0 local Claude Code)
export { callClaudeCodeVote, callKimiVote, callOpenRouterVote } from "./callKimi.js";
export type { NewsIntelResult } from "./callNewsIntel.js";
// T0 — news / team intelligence (Perplexity Sonar + Google AI-Mode ensemble)
export {
  fetchNewsEnsemble,
  fetchNewsIntelligence,
  fetchNewsViaGoogleAiMode,
} from "./callNewsIntel.js";
export type { OddsAcquisitionResult } from "./callOdds.js";
// Odds acquisition
export { fetchOddsViaGemini } from "./callOdds.js";
// OpenRouter generic transport (Tier 2/3 fallbacks)
export { callOpenRouter, callOpenRouterJson } from "./callOpenRouter.js";
export type { PostmortemLossInput, PostmortemSynthesisResult } from "./callPostmortem.js";
// B5
export { synthesizePostmortems } from "./callPostmortem.js";
export type { RedTeamResult } from "./callRedTeam.js";
// B3
export { callRedTeam } from "./callRedTeam.js";
export type { RegimeHint, RegimeHintLabel } from "./callRegimeHint.js";
// B6
export { callRegimeHint } from "./callRegimeHint.js";
export type { CvlResult, CvlStatus } from "./callVerification.js";
// B2
export { callVerification } from "./callVerification.js";
export type { ModelId, OpenRouterModelId, ThinkingLevel } from "./cascade.js";
export {
  ACQUISITION_CASCADE,
  DECISION_CASCADE,
  MODELS,
  OPENROUTER_BASE_URL,
  OPENROUTER_MODELS,
  THINKING_LEVELS,
} from "./cascade.js";
export type { EmbedderFn } from "./embed.js";
// B4
export { embedText, makeEmbedder } from "./embed.js";
export type { BatchRoute, RouteTier } from "./routeBatch.js";
// B7
export { routeFixture } from "./routeBatch.js";
export type { LLMCallContext, LLMKeyConfig, LLMProvider } from "./types.js";
