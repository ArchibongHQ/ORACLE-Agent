export type { LLMProvider, LLMCallContext, LLMKeyConfig } from './types.js';
export { callClaude } from './callClaude.js';
export { fetchGeminiWithCascade, callGeminiDecision } from './callGemini.js';
export { MODELS, THINKING_LEVELS, ACQUISITION_CASCADE, DECISION_CASCADE } from './cascade.js';
export type { ModelId, ThinkingLevel } from './cascade.js';
// B1
export { callBriefing } from './callBriefing.js';
export type { BriefingResult } from './callBriefing.js';
// B2
export { callVerification } from './callVerification.js';
export type { CvlResult, CvlStatus } from './callVerification.js';
// B3
export { callRedTeam } from './callRedTeam.js';
export type { RedTeamResult } from './callRedTeam.js';
// B4
export { embedText, makeEmbedder } from './embed.js';
export type { EmbedderFn } from './embed.js';
// B5
export { synthesizePostmortems } from './callPostmortem.js';
export type { PostmortemLossInput, PostmortemSynthesisResult } from './callPostmortem.js';
// B6
export { callRegimeHint } from './callRegimeHint.js';
export type { RegimeHint, RegimeHintLabel } from './callRegimeHint.js';
// B7
export { routeFixture } from './routeBatch.js';
export type { BatchRoute, RouteTier } from './routeBatch.js';
// Odds acquisition
export { fetchOddsViaGemini } from './callOdds.js';
export type { OddsAcquisitionResult } from './callOdds.js';
// T0 — news / team intelligence (Perplexity Sonar)
export { fetchNewsIntelligence } from './callNewsIntel.js';
export type { NewsIntelResult } from './callNewsIntel.js';
// Swarm worker (Kimi K2.6)
export { callKimiVote } from './callKimi.js';
export type { KimiVote } from './callKimi.js';
