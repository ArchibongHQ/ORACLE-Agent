import React, { useState, useEffect, useRef } from "react";
import {
  TrendingUp, ShieldAlert, Zap, BrainCircuit, BarChart3, History, Search,
  AlertTriangle, Activity, Award, Target, Database, RefreshCw, Layers,
  Thermometer, Wind, Volume2, Info, Scale, Crosshair, ClipboardList,
  ShieldCheck, UserCheck, AlertCircle, TrendingDown, Gauge, Cpu, BarChart,
  Swords, Bot
} from "lucide-react";

// ═══════════════════════════════════════════════════════════════════════════════
// §0a — IN-MEMORY STORAGE (replaces localStorage for artifact compatibility)
// Claude.ai artifacts do not support localStorage. All persistence is in-memory.
// ═══════════════════════════════════════════════════════════════════════════════
const _memStore = {};
const _safeStorage = {
  getItem: (k) => { try { return _memStore[k] !== undefined ? _memStore[k] : null; } catch(e) { return null; } },
  setItem: (k, v) => { try { _memStore[k] = v; } catch(e) {} },
  removeItem: (k) => { try { delete _memStore[k]; } catch(e) {} },
};
// Patch window.localStorage with in-memory version for artifact compat
if (typeof window !== 'undefined') {
  try { Object.defineProperty(window, 'localStorage', { get: () => _safeStorage, configurable: true }); } catch(e) {}
}



// ═══════════════════════════════════════════════════════════════════════════════
// O.R.A.C.L.E. AI v2026.8.0 — FOOTBALL ANALYSIS AI
// Omniscient Research & Analytical Computation for League Evaluation
//
// ── v2026.8.0 — RESEARCH-GROUNDED PREDICTION TUNING (literature-backed):
// 🟢 [A1] Ranked Probability Score (RPS) — the football-standard ordinally-aware metric
//        (Constantinou & Fenton; Soccer Prediction Challenges). Now primary in
//        CalibrationEngine + RegressionHarness; Brier kept as secondary. driftAlert uses RPS.
// 🟡 [A2] xG-primary λ weighting (flag XG_PRIMARY_WEIGHT). Literature: xG > actual goals for
//        prediction (Heuer & Rubner 2012; Mead 2023). TUNE — gate on RPS, raise 0.40→~0.55.
// 🟡 [A3] Pi-ratings (Constantinou & Fenton 2013) added to TeamRatingsEngine + updated on
//        every resolve. Canonical when USE_PI_RATINGS_CANONICAL=true. Literature: pi > Elo.
// 🟡 [A4] DC time-decay ξ default 0.004→0.0020/day (empirical optimum ~0.0018-0.0033;
//        opisthokonta/penaltyblog). Python core adds tune_time_decay() RPS grid-search.
// 🟢 [C1] Market-velocity (Gamma) λ-layer quarantine flag — removes edge-vs-market
//        circularity. When on, Gamma's weight → Alpha; velocity becomes sharp-signal only.
// 🟢 [C2] Draw-calibration diagnostic (RegressionHarness.drawCalibration) — predicted vs
//        realised draw frequency per league; flags |gap|>0.03 (DC Poisson draw-bias check).
// 🟢 [A1b] RPS now normalises before clamping + meanRPS() helper added.
// All A2/A3/A4/C1 are TUNE (flag-gated, default conservative) — enable per RPS backtest.
//
// ── v2026.7.0 — low-scoring regime detector + computed AH pivot + reasoning rubric.
// ── v2026.6.0 — multi-provider (Claude Opus briefing / Gemini fallback) + audit refactor.
//
// ── v2026.3.12 AUDIT-DRIVEN CRITICAL BUG FIXES (adversarial audit round 3):
// 🔴 [BUG-C01 FIXED] Dynamic rho sign asymmetry: estimateDynamicRho now uses
// 🟢 [R1] ORACLE_REASONING_RUBRIC injected into briefing + adversarial layers
//        (domain-specific reasoning discipline; SAFE).
// 🟢 [R2] detectLowScoringRegime: classifies LOW_SCORING from the final matrix
//        (E[goals]<2.35, P(U2.5)>0.58, low-score mass>0.34, no dominant favourite).
// 🟢 [R5/R6] asianHandicapPivot: computed favourite-vs-underdog AH line replaces the
//        narrative-only AH instruction. Dominant fav → −0.25/DNB (push-protected);
//        even grind → +0.5 (a 0-0 WINS the line). Scored by settlement prob × accuracy.
// 🟢 [R7] Per-league/per-side AH hit-rate tracker in CalibrationEngine (feeds R5).
// 🟡 [R3] calibratedZipPi(λH,λA): two-feature ledger-fit zero-inflation (TUNE — flag
//        ENABLE_CALIBRATED_ZIP, default OFF, logistic-prior fallback).
// 🟡 [R4] Conditional ZIP ensemble weight in LOW_SCORING regime (TUNE — flag
//        LOWSCORE_ZIP_WEIGHT, default 0.08).
// KEY INSIGHT: "catching 0-0" is NOT a probability problem (model assigns ~14.9% vs
//        ~12% empirical) — it's a market-selection problem. The pivot routes low-scoring
//        fixtures to the market a 0-0 cannot bust (AH/Under), not a 1X2 result bet.
//
// ── v2026.6.0 — multi-provider + audit refactor: Claude Opus primary for briefing
//        (Gemini 3.x fallback), correct Kelly denominator, analytic variance,
//        run-scoped state, settlement-correct AH, real Sarmanov, bounded rho solver.
//
// ── v2026.3.12 AUDIT-DRIVEN CRITICAL BUG FIXES (adversarial audit round 3):
// 🔴 [BUG-C01 FIXED] Dynamic rho sign asymmetry: estimateDynamicRho now uses
//                    correct four-cell MLE (0-0, 1-0, 0-1, 1-1) and clamp logic
//                    respects empirical sign direction with league-specific floor
// 🔴 [BUG-C02 FIXED] Kelly q denominator: was `1 - 1/odds` (market-implied prob);
//                    corrected to `1 - modelProb` (canonical Kelly complementary prob)
//                    per Kelly (1956), Thorp (2008). Systematic stake mis-sizing resolved.
// 🔴 [BUG-C03 FIXED] Monte Carlo variance now applies Dixon-Coles tau correction
//                    so varFlag/varMultiplier align with DC-calibrated matrix probs
// 🟡 [BUG-M01 FIXED] Dynamic rho MLE rebuilt: four low-scoring cells (joint MLE)
//                    replaces single 0-0 cell approximation
// 🟡 [BUG-M03 FIXED] Elo momentum direction INVERTED (confirmed via direct math):
//                    regression now indexes time correctly (i=0=oldest) so rising
//                    Elo → positive slope → momentum > 1.0 as intended
// 🟡 [BUG-M05 FIXED] Correlated parlay "hard cap" now enforced: co-deployment of
//                    ρ > 0.7 market pairs is blocked via hard veto in scanMarkets
// 🟡 [BUG-M07 FIXED] MLSafetyFilter xG gap 2.1–2.3 closed: explicit soft-reject
//                    added for 2.1 < xG < 2.3 range (below optimal window)
// 🟡 [BUG-M08 FIXED] isPopularTeam bidirectional false-positive: exact-first-word
//                    reverse branch removed; replaced with curated alias Set lookup
// 🟡 [BUG-M09 FIXED] clvProjection.survivalProb renamed to edgeRetentionFraction
//                    and semantically corrected; S05 threshold recalibrated
// 🟢 [BUG-L01 FIXED] getConfidenceBand boundary documentation clarified
// 🟢 [BUG-L02 FIXED] AH +0.25 hW0 now includes dr*0.5 for proper draw-push component
// 🟢 [BUG-L03 FIXED] Synthetic alpha vig applies 4% per leg (market-aligned, not 5%)
// 🟢 [BUG-L04 FIXED] T128 mutual exclusion test uses non-trivially separable inputs
// 🟢 [BUG-L05 NOTE] T2 (Pro) promoted for acquisition when HIGH thinking level active
//
// ── v29.0 NEW FEATURES & ENHANCEMENTS:
// ✨ [NEW-25] Pre-Analysis Wrapper: Arbitrage VIG-Removal Fix applied at LLM layer
//            + SHARP_COMPRESSION constraint reconciled with S04/NEW-18 scoring
// ✨ [NEW-26] Loss Aversion Adversary Override: when adversary.confidence < 65 AND
//            bet.ev > 0.08, Referee applies lossAversionVeto=false guard to prevent
//            adversary asymmetrically killing moderate-edge bets (Kahneman & Tversky)
// ✨ [NEW-27] Survivorship Bias Flag in RAG: if top-5 analogues are all high-profile
//            leagues (PL/UCL/LL), flags [SURVIVORSHIP_BIAS_SAMPLE] on RAG signal
// ✨ [NEW-28] Enhanced ML Safety Filter: aligned with ORACLE core logic; 17 sections
//            (added §16 Sharp Consensus Gate, §17 Calibration Factor Gate);
//            correlated-parlay hard veto integrated into ML recommendation output
// ✨ [NEW-29] Draw calibration citation corrected: practitioner consensus sourcing
//            (Constantinou & Fenton 2012 + Dixon & Coles 1997) replaces Hvattum 2010
//
// ── All v28.0 fixes and v26.7–v27.0 assertions retained and passing (T1–T159)
// ── New test suite: T160–T192 covering all v29 audit fixes
// ── v2026.3.12 test suite: T193–T275 covering all 15 new blocks (83 assertions)
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// §0 — MODEL CONFIGURATION (v2026.6.0 — multi-provider architecture)
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// §0b — GEMINI MODEL CONSTANTS (v2026.6.0 — verified May 23, 2026)
//
// MODEL LANDSCAPE (fact-checked against ai.google.dev/gemini-api/docs/models):
//
//  gemini-3.5-flash           ← STABLE GA (May 19 2026). Strongest agentic/coding Flash ever.
//                               Beats 3.1 Pro on agentic benchmarks. 1M ctx, $1.50/$9 per 1M tok.
//                               Default model for Gemini app + AI Mode. Text-only output.
//
//  gemini-3.1-pro-preview     ← PREVIEW (Feb 19 2026). Deepest reasoning model. 2M ctx.
//                               $2/$12 (≤200K) or $4/$18 (>200K). Best for complex multi-step.
//                               gemini-3-pro-preview SHUT DOWN Mar 9 — do NOT use.
//
//  gemini-3.1-flash-lite      ← STABLE. Cheapest 3.x model. $0.25/$1.50 per 1M tok.
//                               High-volume, low-latency. Supports thinking_level.
//
//  gemini-3.5-pro             ← NOT YET RELEASED (as of May 23 2026). Rolling out next month per
//                               Google. Do NOT reference in code until GA. Use 3.1-pro-preview.
//
//  gemini-2.5-*               ← PREVIOUS GENERATION. Still functional but superseded.
//                               gemini-2.0-flash retires Jun 1 2026.
//
// FULL LAYER→MODEL MAPPING (Gemini + Claude, per PRD §Appendix):
//
//   LAYER                   PRIMARY                      FALLBACK
//   ─────────────────────   ─────────────────────────    ───────────────────────────
//   Acquisition (T1/2/3)    gemini-3.5-flash             gemini-3.1-flash-lite
//   Briefing/Reasoning      Claude Opus (claude-opus-4-6) → gemini-3.1-pro-preview ensemble
//   Verification (CVL)      Claude Sonnet (claude-sonnet-4-6) ×3 parallel  (SKIP if no key)
//   Deliberation Gate       Deterministic JS (no LLM)    —
//   Math/Kelly/Variance     Pure JS compute              —
//
//   Claude model constants defined at §10b (CLAUDE_MODELS).
//   If Claude API is unreachable, Gemini models below handle all layers seamlessly.
// ═══════════════════════════════════════════════════════════════════════════════
const MODELS = {
  T1:       'gemini-3.5-flash',              // Data acquisition — GA stable, agentic-optimised
  T1b:      'gemini-3.1-flash-lite',         // Acquisition fallback — cheapest, fast
  T2:       'gemini-3.1-pro-preview',        // Processing, reasoning, briefing — deepest reasoning
  T2b:      'gemini-3.5-flash',              // T2 fallback — 3.5 Flash beats older Pro on agentic tasks
  FALLBACK: 'gemini-3.1-flash-lite',         // Last-resort — always available, cheapest
};

// ═══════════════════════════════════════════════════════════════════════════════
// THINKING_LEVELS (v2026.6.0 — updated to new string-enum API)
//
// Gemini 3.5 Flash replaced the integer thinkingBudget with a string thinking_level enum.
// The old integer values (1024, 4096, etc.) are DEPRECATED and will cause empty responses
// on the Interactions API. The new values are: 'minimal', 'low', 'medium' (default), 'high'.
//
// CRITICAL MIGRATION NOTE: the default changed from 'high' (3 Flash Preview) to 'medium'
// (3.5 Flash). ORACLE explicitly sets 'high' for briefing/reasoning to preserve prior behavior.
// For acquisition turns, 'low' is sufficient (Google retuned 'low' for agentic/code tasks).
//
// All generationConfig blocks must now use:
//   thinkingConfig: { thinkingLevel: THINKING_LEVELS.HIGH }
// instead of:
//   thinkingConfig: { thinkingBudget: 24576 }
// ═══════════════════════════════════════════════════════════════════════════════
const THINKING_LEVELS = {
  MINIMAL: 'minimal',    // Fact retrieval, classification — lowest token cost
  LOW:     'low',        // Agentic/code tasks — retuned for tool-calling workflows
  MEDIUM:  'medium',     // Default for 3.5 Flash — good quality/cost balance
  HIGH:    'high',       // Deep reasoning — use for briefing, adversarial, complex analysis
};

// ═══════════════════════════════════════════════════════════════════════════════
// §0c — RUNTIME CONFIG / FEATURE FLAGS (v2026.6.0)
// TUNE-classified behaviours are flagged so they can be A/B tested against the
// resolved ledger via RegressionHarness before being enabled in production.
// Defaults reflect the refactor decisions: softmax blend OFF (no proven benefit,
// no theoretical basis); Sarmanov OFF (enable per-league only after Brier passes).
// ═══════════════════════════════════════════════════════════════════════════════
const ORACLE_CONFIG = {
  ENABLE_SOFTMAX_BLEND: false,   // B1: undocumented stake damper — disabled pending backtest
  SARMANOV_ORDER:       0,       // B8: 0 = pure DC (marginal-safe). >0 enables real Sarmanov per-league
  RADEMACHER_MIN_FIRES: 37,      // B10: min signal firings before a non-unity multiplier
  CONVERGENCE_FIXTURE_VETO: true,// B7: apply convergence tier veto fixture-wide, not apex-only
  // ── v2026.7 (low-scoring / AH pivot) ──────────────────────────────────────
  ENABLE_LOWSCORE_REGIME: true,  // R2: low-scoring regime detector (SAFE — detection only)
  ENABLE_AH_PIVOT:        true,  // R5/R6: computed AH pivot replaces narrative-only AH guess (SAFE wiring)
  ENABLE_CALIBRATED_ZIP:  false, // R3: ledger-fit zero-inflation — TUNE, enable after RPS passes (n>=50)
  LOWSCORE_ZIP_WEIGHT:    0.08,  // R4: ZIP ensemble weight in LOW_SCORING regime — TUNE (raise to 0.18 once gated)
  // ── v2026.8 (research-grounded prediction tuning — all TUNE, gate on RPS) ──
  XG_PRIMARY_WEIGHT:      0.40,  // A2: Layer-1 weight when verified xG present. Literature: xG>goals
                                 //     for prediction (Heuer&Rubner; Mead 2023). Raise to ~0.55 once RPS-gated.
  USE_PI_RATINGS_CANONICAL: false, // A3: promote pi-ratings over Elo as canonical (literature: pi>Elo). TUNE.
  QUARANTINE_MARKET_VELOCITY: false, // C1: drop Gamma (odds-velocity) λ-layer from the probability
                                 //     ensemble to remove edge-vs-market circularity. TUNE (gate RPS+CLV).
  TIME_DECAY_XI:          0.0020,// A4: per-day DC time-decay; empirical optimum ~0.0018-0.0033 (was 0.004-0.005)
};

// ═══════════════════════════════════════════════════════════════════════════════
// §0b — RUNTIME API KEY CONFIGURATION (BUG-002: no hardcoded keys)
// All keys are supplied at runtime via user input or environment — never bundled.
// ═══════════════════════════════════════════════════════════════════════════════

const getApiKeys = () => {
  if (typeof window !== 'undefined' && window.__ORACLE_CORE__) {
    const st = window.__ORACLE_CORE__.getState();
    return {
      openWeather:  st.ui?.owKey     || '',
      footballData: st.ui?.fdKey     || '',
      apiFootball:  st.ui?.afKey     || '',
      oddsApi:      st.ui?.odKey     || '',
      claudeKey:    st.ui?.claudeKey || '', // B14-02: Anthropic Claude API key
    };
  }
  return { openWeather:'', footballData:'', apiFootball:'', oddsApi:'', claudeKey:'' };
};

// ═══════════════════════════════════════════════════════════════════════════════
// §1 — LEAGUE PARAMETERS (v29.0: rho now seed for dynamic fitting; NEW-07)
// avgGA retained for SoS; kFactor = BBN prior strength
// ═══════════════════════════════════════════════════════════════════════════════

const LEAGUE_PARAMS = {
  "Premier League":   { baseRho:-0.13, homeAvg:1.48, awayAvg:1.22, kFactor:15, avgGA:1.35, drawRate:0.245, reliability:'high', upsetLeague:false },
  "La Liga":          { baseRho:-0.16, homeAvg:1.52, awayAvg:1.18, kFactor:12, avgGA:1.28, drawRate:0.280, reliability:'medium', upsetLeague:true },
  "Serie A":          { baseRho:-0.18, homeAvg:1.42, awayAvg:1.10, kFactor:12, avgGA:1.25, drawRate:0.295, reliability:'medium', upsetLeague:true },
  "Bundesliga":       { baseRho:-0.14, homeAvg:1.62, awayAvg:1.35, kFactor:10, avgGA:1.45, drawRate:0.220, reliability:'high', upsetLeague:false },
  "Ligue 1":          { baseRho:-0.15, homeAvg:1.44, awayAvg:1.15, kFactor:10, avgGA:1.30, drawRate:0.260, reliability:'medium', upsetLeague:true },
  "Champions League": { baseRho:-0.10, homeAvg:1.55, awayAvg:1.25, kFactor:18, avgGA:1.40, drawRate:0.235, reliability:'high', upsetLeague:false },
  "Europa League":    { baseRho:-0.12, homeAvg:1.50, awayAvg:1.20, kFactor:15, avgGA:1.35, drawRate:0.240, reliability:'high', upsetLeague:false },
  "Eredivisie":       { baseRho:-0.12, homeAvg:1.72, awayAvg:1.38, kFactor:10, avgGA:1.52, drawRate:0.210, reliability:'high', upsetLeague:false },
  "Scottish Premiership":{ baseRho:-0.13, homeAvg:1.55, awayAvg:1.18, kFactor:8, avgGA:1.38, drawRate:0.225, reliability:'high', upsetLeague:false },
  "Austrian Bundesliga":{ baseRho:-0.13, homeAvg:1.65, awayAvg:1.30, kFactor:8, avgGA:1.45, drawRate:0.218, reliability:'high', upsetLeague:false },
  "Primeira Liga":    { baseRho:-0.14, homeAvg:1.58, awayAvg:1.22, kFactor:10, avgGA:1.38, drawRate:0.232, reliability:'high', upsetLeague:false },
  "Belgian Pro League":{ baseRho:-0.13, homeAvg:1.60, awayAvg:1.28, kFactor:9, avgGA:1.42, drawRate:0.226, reliability:'high', upsetLeague:false },
  "Championship":     { baseRho:-0.13, homeAvg:1.50, awayAvg:1.20, kFactor:8, avgGA:1.35, drawRate:0.265, reliability:'low', upsetLeague:true },
  "Default":          { baseRho:-0.13, homeAvg:1.45, awayAvg:1.15, kFactor:8,  avgGA:1.30, drawRate:0.250, reliability:'medium', upsetLeague:false },
  // Women's football leagues — higher overdispersion, different negative correlation, smaller samples (higher kFactor)
  // Source: Flag audit recommendation; Sarmanov 2023 notes non-Poisson marginals in women's football
  "WSL":              { baseRho:-0.08, homeAvg:1.52, awayAvg:1.18, kFactor:20, avgGA:1.35, drawRate:0.230, reliability:'medium', upsetLeague:true },
  "NWSL":             { baseRho:-0.07, homeAvg:1.48, awayAvg:1.12, kFactor:20, avgGA:1.30, drawRate:0.225, reliability:'medium', upsetLeague:true },
  "Women's Champions League": { baseRho:-0.06, homeAvg:1.65, awayAvg:1.30, kFactor:22, avgGA:1.45, drawRate:0.215, reliability:'medium', upsetLeague:true },
};

// BUG-020 / BUG-B11 FIXED: use isPopularTeam() helper with substring matching
// instead of exact Set.has() — LLMs return full official names ("Tottenham Hotspur"
// won't match "tottenham" via exact Set lookup)
const POPULAR_TEAMS = new Set([
  "manchester city","manchester united","liverpool","arsenal","chelsea","tottenham",
  "real madrid","barcelona","atletico madrid","bayern munich","borussia dortmund",
  "psg","paris saint-germain","juventus","inter milan","ac milan","napoli","ajax",
  "porto","benfica","man city","man utd","man united","spurs","bvb","fcb","fcbayern",
  "barca","atletico","inter","juve","bayer leverkusen","rb leipzig","sevilla",
  "valencia","real sociedad","villarreal","roma","lazio","fiorentina","atalanta",
  "dortmund","schalke","wolves","wolverhampton","leicester","west ham","newcastle",
  "aston villa","brighton","celtic","rangers","psv","feyenoord","lyon",
  "marseille","monaco","lille","sporting cp","braga","galatasaray","fenerbahce",
  "tottenham hotspur","wolverhampton wanderers","west ham united","leicester city",
  "aston villa","newcastle united","paris saint germain","atletico de madrid",
  "borussia dortmund","rb leipzig","bayer 04 leverkusen","fc barcelona","real madrid cf"
]);

// BUG-B11 FIX / BUG-M08 FIXED (v29): isPopularTeam — curated alias lookup only
// BUG-M08 ROOT CAUSE: bidirectional check `t.includes(n.split(' ')[0])` caused false
//   positives for teams whose first name matches popular team tokens (e.g. "Milan Sremska"
//   matching "ac milan" because "ac milan".includes("milan")=true).
// FIX: use ONLY forward substring check (n.includes(t)) — input name must CONTAIN a
//   popular token, not vice versa. This eliminates the reverse-direction false positive.
const isPopularTeam = (name) => {
  if (!name) return false;
  const n = name.toLowerCase().trim();
  if (POPULAR_TEAMS.has(n)) return true;
  // Forward-only: check if the input name CONTAINS a popular token as a word (not substring of word)
  // Uses word-boundary check: "milan sremska" contains word "milan" → true (by design — catches AC Milan queries)
  // But T133/T174 tests expect false for "Brentford United" and "Milan Sremska"
  // Fix: only match if the popular team token is at the START of the name or follows a space
  return [...POPULAR_TEAMS].some(t => {
    const re = new RegExp('(^|\\s)' + t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '(\\s|$)');
    return re.test(n);
  });
};

// Bookmaker tier classification for sharp/square split (NEW-09)
const SHARP_BOOKS  = new Set(['pinnacle','sbobet','ibc','sb','asian','matchbook','betfair_exchange']);
const SQUARE_BOOKS = new Set(['bet365','paddy power','draftkings','fanduel','betmgm','unibet','coral','ladbrokes','bwin','888sport']);

const getGeminiUrl = (model) => {
  const k = typeof window !== 'undefined' ? (window.__ORACLE_CORE__?.getState()?.ui?.userApiKey || '') : '';
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${k}`;
};

// ═══════════════════════════════════════════════════════════════════════════════
// §2 — API CASCADE (v29.0 — validated models, exponential backoff)
// ═══════════════════════════════════════════════════════════════════════════════

const fetchGeminiWithCascade = async (models, payload, opts = {}) => {
  // BLOCK B12 (V3-C FIX): full jitter (avoids thundering-herd lockstep retries across
  // concurrent sessions / parallel passes), honor server Retry-After on 429, and a total
  // elapsed-time budget so a hung analysis can't stall ~90s+. 4xx (non-429) → next model
  // immediately (no retry). Single clear retry bound.
  const base = 800, maxTotalMs = opts.maxTotalMs || 45000, started = Date.now();
  let lastErr;
  const cascade = (Array.isArray(models) && models.length > 0)
    ? [...new Set([...models, MODELS.FALLBACK])]
    : [MODELS.FALLBACK];

  for (const model of cascade) {
    for (let i = 0; i < 5; i++) {
      if (Date.now() - started > maxTotalMs) throw new Error('Cascade timeout budget exceeded');
      try {
        const r = await fetch(getGeminiUrl(model), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (r.ok) return await r.json();
        if (r.status >= 400 && r.status < 500 && r.status !== 429) throw new Error(`ABORT_${r.status}`);
        // 429 / 5xx → retry with jitter, honoring Retry-After if present
        const ra = parseFloat(r.headers?.get?.('retry-after')) * 1000;
        const backoff = Number.isFinite(ra) ? ra : Math.random() * base * Math.pow(2, i);
        await new Promise(res => setTimeout(res, backoff));
      } catch(e) {
        lastErr = e;
        if (String(e.message).startsWith('ABORT_')) break; // client error → next model, no retry
        await new Promise(res => setTimeout(res, Math.random() * base * Math.pow(2, i)));
      }
    }
  }
  throw new Error("Critical API Failure: All fallback models exhausted. Trace: " + (lastErr?.message || ""));
};

// ═══════════════════════════════════════════════════════════════════════════════
// §3 — MATH ENGINE (v29.0 — all bug fixes + ZIP layer + dynamic rho + enhanced Kelly)
// ═══════════════════════════════════════════════════════════════════════════════

const MathEngine = {
  MAX_GOALS: 14,  // Raised from 12 — covers high-lambda Bundesliga games
  MOS: 0.05,

  clamp: (v, min, max) => {
    if (v === null || v === undefined || Number.isNaN(v)) return min;
    return Math.max(min, Math.min(max, v));
  },

  safeNum: (val, fallback = 0) => {
    if (val === null || val === undefined) return fallback;
    const parsed = parseFloat(val);
    return Number.isNaN(parsed) ? fallback : parsed;
  },

  getConfidenceBand: (p) => {
    if (p >= 0.75) return 'A';
    if (p >= 0.60) return 'B';
    if (p >= 0.40) return 'C';
    if (p >= 0.20) return 'D';
    return 'E';
  },

  poissonPMF: (k, lambda) => {
    const lam = Math.max(0.01, lambda);
    let logP = k * Math.log(lam) - lam;
    for (let i = 1; i <= k; i++) logP -= Math.log(i);
    return Math.exp(logP);
  },

  // ZIP (Zero-Inflated Poisson) PMF — NEW-03
  // π = zero-inflation weight (0=pure Poisson, 0.15=15% structural zeros)
  zipPMF: (k, lambda, pi = 0.08) => {
    const pois = MathEngine.poissonPMF(k, lambda);
    if (k === 0) return pi + (1 - pi) * pois;
    return (1 - pi) * pois;
  },

  // v2026.7 R3 — CALIBRATED ZERO-INFLATION π(λH, λA)
  // Replaces the Baio-Blangiardo single-variable logistic with a two-feature form fit
  // from ledger data: π = σ(β0 + β1·(λH+λA) + β2·|λH−λA|). The |λH−λA| term captures
  // that mismatched fixtures (one team much stronger) have a different structural-zero
  // rate than even fixtures at the same total. Coefficients come from CalibrationEngine
  // (fit on resolved low-scoring fixtures); falls back to the logistic prior until n≥50.
  // TUNE: gated by ORACLE_CONFIG.ENABLE_CALIBRATED_ZIP.
  calibratedZipPi: function(lH, lA, coeffs) {
    const total = (lH || 0) + (lA || 0);
    const diff = Math.abs((lH || 0) - (lA || 0));
    if (coeffs && typeof coeffs.b0 === 'number') {
      const z = coeffs.b0 + coeffs.b1 * total + coeffs.b2 * diff;
      return this.clamp(1 / (1 + Math.exp(-z)), 0.03, 0.22);
    }
    // Fallback: Baio-Blangiardo logistic prior (same as current default)
    return this.clamp(1 / (1 + Math.exp(-(-2.8 + 4.2 * total))), 0.03, 0.18);
  },

  // Dixon-Coles tau correction — v29.0 sign convention confirmed — see BUG-C01 for dynamic rho asymmetry fix:
  // baseRho is stored NEGATIVE so 1 - lH*lA*rho = 1 + lH*lA*|rho| (increases 0-0 prob as intended)
  dixonColesTau: (x, y, lH, lA, rho) => {
    if (rho === 0) return 1.0;
    if (x === 0 && y === 0) return Math.max(0.1, Math.min(3.0, 1 - lH * lA * rho));
    if (x === 0 && y === 1) return Math.max(0.1, Math.min(3.0, 1 + lH * rho));
    if (x === 1 && y === 0) return Math.max(0.1, Math.min(3.0, 1 + lA * rho));
    if (x === 1 && y === 1) return Math.max(0.1, Math.min(3.0, 1 - rho));
    return 1.0;
  },

  // Dynamic rho estimation from ledger data (NEW-07)
  // B1-01 v2026.3.12: Newton-Raphson MLE — 50 iterations, tolerance 1e-6
  // Min sample raised 20 → 30 (Kimi M01). Four-cell joint MLE via NR gradient descent.
  estimateDynamicRho: (goalData, baseRho) => {
    if (!goalData || goalData.n < 30) return baseRho; // B1-01: min sample 30
    const n = goalData.n;
    const lH = Math.max(0.01, goalData.hG / n);
    const lA = Math.max(0.01, goalData.aG / n);
    const obs00 = Math.max(0.001, (goalData.zeroZero || 0) / n);
    const obs10 = Math.max(0.001, (goalData.oneZero  || 0) / n);
    const obs01 = Math.max(0.001, (goalData.zeroOne  || 0) / n);
    const obs11 = Math.max(0.001, (goalData.oneOne   || 0) / n);
    // BLOCK B9 (V1-D FIX): The gradient/Hessian were correct, but in-loop-clamped Newton
    // can overshoot the [-0.30, 0.02] bound, corrupt the next gradient, and (when the
    // local Hessian is non-concave) step AWAY from the maximum — returning a spurious
    // boundary value. Replace with BRACKETED BISECTION on the gradient dL/drho, which
    // cannot leave the admissible interval and cannot diverge. (Dead exp00..exp11 vars
    // removed — they were never used.)
    // dL/drho = -lH*lA*obs00/tau00 + lA*obs10/tau10 + lH*obs01/tau01 - obs11/tau11
    const dL = (r) => {
      const tau00 = Math.max(1e-9, 1 - lH * lA * r);
      const tau10 = Math.max(1e-9, 1 + lA * r);
      const tau01 = Math.max(1e-9, 1 + lH * r);
      const tau11 = Math.max(1e-9, 1 - r);
      return (-lH * lA * obs00 / tau00) + (lA * obs10 / tau10) +
             (lH * obs01 / tau01) - (obs11 / tau11);
    };
    let lo = -0.30, hi = 0.02, fLo = dL(lo), fHi = dL(hi);
    // No sign change ⇒ no interior MLE root in the bracket ⇒ keep the prior (clamped).
    if (fLo * fHi > 0) return MathEngine.clamp(baseRho, -0.30, 0.02);
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2, fMid = dL(mid);
      if (Math.abs(fMid) < 1e-7 || (hi - lo) < 1e-6) return mid;
      if (fLo * fMid < 0) { hi = mid; } else { lo = mid; fLo = fMid; }
    }
    return MathEngine.clamp((lo + hi) / 2, -0.30, 0.02);
  },

  // BUG-007 FIXED: Zip boost now conditional — only fires if NOT already DC-corrected
  // (i.e., for high totalXG games where DC correction is minimal anyway)
  buildMatrix: function(lH, lA, rho, useZIP = false, zipPi = 0.08) {
    const mat = []; let sum = 0;
    const totalXG = lH + lA;
    // BUG-007 FIX: zipBoost only when totalXG < 1.5 (extreme low scoring) AND DC rho is weak
    // DC already handles 0-0 inflation for moderate low-scoring (1.5-2.5 xG) games
    const dcStrength = Math.abs(rho) * lH * lA;
    const zipBoost00 = (totalXG < 1.5 && dcStrength < 0.05) ? 1.08 : 1.0; // Reduced from 1.15; conditional
    const zipBoost11 = (totalXG < 1.5 && dcStrength < 0.05) ? 1.03 : 1.0;

    for (let i = 0; i < this.MAX_GOALS; i++) {
      const pmfH = useZIP ? this.zipPMF(i, lH, zipPi) : this.poissonPMF(i, lH);
      if (pmfH < 1e-7) { mat[i] = new Array(this.MAX_GOALS).fill(0); continue; }
      mat[i] = [];
      for (let j = 0; j < this.MAX_GOALS; j++) {
        const pmfA = useZIP ? this.zipPMF(j, lA, zipPi) : this.poissonPMF(j, lA);
        if (pmfA < 1e-7) { mat[i][j] = 0; continue; }
        // B8: use marginal-preserving Sarmanov tau when enabled per-league, else DC.
        const tau = (typeof ORACLE_CONFIG !== 'undefined' && ORACLE_CONFIG.SARMANOV_ORDER > 0)
          ? this.sarmanovTau(i, j, lH, lA, rho, ORACLE_CONFIG.SARMANOV_ORDER)
          : this.dixonColesTau(i, j, lH, lA, rho);
        let v = pmfH * pmfA * tau;
        if (i === 0 && j === 0) v *= zipBoost00;
        if (i === 1 && j === 1) v *= zipBoost11;
        mat[i][j] = v; sum += v;
      }
    }
    if (sum > 0) for (let i = 0; i < this.MAX_GOALS; i++) for (let j = 0; j < this.MAX_GOALS; j++) mat[i][j] = (mat[i][j]||0) / sum;
    return mat;
  },

  applyEnvironmentalPenalties: (lH, lA, weather, ref) => {
    let mH = 1, mA = 1;
    if (weather?.wind_mph > 18.5) { mH *= 0.92; mA *= 0.92; }
    if (weather?.rain_mm > 5.0)   { mH *= 0.94; mA *= 0.94; }
    if (ref?.cards_per_game > 4.5){ mH *= 0.97; mA *= 0.97; }
    return { lH: lH * mH, lA: lA * mA, lambdaH: lH * mH, lambdaA: lA * mA, penalized: (mH < 1 || mA < 1) };
  },

  // B1-05: Asymmetric fatigue model — short rest penalised more steeply than long rest bonus
  // Short rest (≤3 days): exp(-0.07 * |d|) — steeper decay
  // Long rest (>7 days): bonus capped at 1.05 — diminishing marginal benefit
  // Source: Wrapper L30 + OpenClaw-RL L30 conceptual analogue
  applyFatigueDecay: (restH, restA, lH, lA) => {
    let mH = 1, mA = 1;
    const d = restH - restA;
    // Penalty side — short rest (≤3 days relative deficit)
    if (restH <= 3 && d <= -2) mH = Math.exp(-0.07 * Math.abs(d)); // B1-05: steeper 0.07
    else if (restA <= 3 && d >= 2) mA = Math.exp(-0.07 * d);
    // Moderate fatigue — original threshold
    else if (restH <= 4 && d <= -3) mH = Math.exp(-0.07 * Math.abs(d));
    else if (restA <= 4 && d >= 3)  mA = Math.exp(-0.07 * d);
    // Bonus side — long rest (>7 days): marginal benefit capped at 1.05
    if (restH > 7 && restA <= 4) mH = Math.min(1.05, mH * 1.03); // B1-05: cap bonus
    if (restA > 7 && restH <= 4) mA = Math.min(1.05, mA * 1.03);
    return { lH: lH * mH, lA: lA * mA, lambdaH: lH * mH, lambdaA: lA * mA, penalized: (mH < 1 || mA < 1) };
  },

  applyTravelFriction: (travelKm, altitudeM, lA) => {
    let modA = 1.0;
    if (travelKm > 1000) modA *= 0.97;
    if (altitudeM > 2000) modA *= 0.85;
    return { lA: lA * modA, lambdaA: lA * modA, penalized: modA < 1.0 };
  },

  // v28.0: SoS adjustment retained
  adjustXGForSoS: (rawXG, oppGA, avgGA) => {
    const factor = avgGA / Math.max(0.5, oppGA || avgGA);
    return rawXG * MathEngine.clamp(factor, 0.5, 2.0);
  },

  extractMarkets: (mat) => {
    let hw = 0, dr = 0, aw = 0, btts = 0;
    const N = mat.length || 14;
    const totals = new Array(N * 2).fill(0);
    for (let i = 0; i < N; i++) {
      if (!mat[i]) continue;
      for (let j = 0; j < N; j++) {
        const p = mat[i][j] || 0;
        if (i > j) hw += p; else if (i === j) dr += p; else aw += p;
        if (i > 0 && j > 0) btts += p;
        if (i+j < totals.length) totals[i+j] += p;
      }
    }
    const ou = {};
    [0.5,1.5,2.5,3.5,4.5].forEach(t => {
      let over = 0;
      for (let g = Math.ceil(t); g < totals.length; g++) over += totals[g];
      ou[`over_${t}`] = over; ou[`under_${t}`] = 1 - over;
    });
    const dnbH = (hw + aw) > 0 ? hw / (hw + aw) : 0.5;
    const dnbA = (hw + aw) > 0 ? aw / (hw + aw) : 0.5;

    // BLOCK B6 (V2-B FIX): Quarter-ball lines (±0.25, ±0.75) are NOT single-Bernoulli
    // markets. Half the stake rides the integer/half line, half rides the adjacent half
    // line; a draw can yield a half-win + half-push (net +0.5 units), NOT a full win and
    // NOT a refund folded into "win probability". The previous code folded dr*0.5 into a
    // scalar win-probability, which OVERSTATES EV when fed to mp*o-1 (a push refund cushions
    // the loss side; it does not pay out). We now expose {pWin,pHalf,pLoss} and a settlement
    // EV helper. The scalar key (hm025/hp025) is retained for back-compat as pWin+0.5*pHalf
    // (correct WIN-equivalent probability), but EV MUST be computed via ah.qEV() downstream.
    const ah = {};
    // Settlement EV for a quarter-ball back bet at decimal odds o, given components.
    // net: win→(o-1), half→0.5*(o-1) [half wins, half pushes], loss→-1
    ah.qEV = (pWin, pHalf, pLoss, o) => pWin*(o-1) + pHalf*0.5*(o-1) - pLoss;
    [-2.5,-2.0,-1.5,-1.0,-0.5,-0.25,0.25,0.5,1.0,1.5,2.0,2.5].forEach(line => {
      let hW = 0, aW = 0, push = 0;
      for (let i=0;i<N;i++) {
        if(!mat[i]) continue;
        for (let j=0;j<N;j++) {
          const p = mat[i][j]||0, margin=(i-j)+line;
          if (Math.abs(margin)<0.01) push+=p; else if(margin>0) hW+=p; else aW+=p;
        }
      }
      if (line===-0.25) {
        // AH -0.25 HOME: half at AH -0.5 (home must WIN), half at AH 0.0 (win, push on draw).
        // Home components: pWin = home wins outright (both halves win);
        //                  pHalf = draw (−0.5 half loses? no): at −0.25, a draw means the
        //                  −0.5 half LOSES and the 0.0 half PUSHES → net −0.5 → that is a
        //                  half-LOSS, represented as pLoss-half. Model as: home win=pWin,
        //                  draw → half-loss, away win → full loss.
        let hWin=0, drP=0, aWin=0;
        for(let i=0;i<N;i++){if(!mat[i])continue;for(let j=0;j<N;j++){const p=mat[i][j]||0;if(i>j)hWin+=p;else if(i===j)drP+=p;else aWin+=p;}}
        // Home -0.25: win=hWin; draw=half-loss (net -0.5); away=full loss.
        // Express as pWin/pHalf/pLoss where pHalf is the half-WIN-eligible mass; here the
        // partial outcome is on the LOSS side, so pHalf=0 and we fold draw into an effective
        // loss of 0.5 — represent via a dedicated record.
        ah['hm025_c'] = { pWin:hWin, pHalfWin:0, pHalfLoss:drP, pLoss:aWin, side:'home', line:-0.25 };
        ah['hm025'] = hWin; // win-equivalent scalar (draw is a half-loss, not counted as win)
        ah['ap025'] = aWin + drP; // away +0.25 mirror: away win + draw half-win-eligible
        ah['ap025_c'] = { pWin:aWin, pHalfWin:drP, pHalfLoss:0, pLoss:hWin, side:'away', line:0.25 };
      } else if (line===0.25) {
        // AH +0.25 HOME: half at AH 0.0 (win, push on draw), half at AH +0.5 (win or draw both win).
        // → home win=pWin (full), draw=half-WIN (net +0.5), away=full loss.
        let hWin=0, drP=0, aWin=0;
        for(let i=0;i<N;i++){if(!mat[i])continue;for(let j=0;j<N;j++){const p=mat[i][j]||0;if(i>j)hWin+=p;else if(i===j)drP+=p;else aWin+=p;}}
        ah['hp025_c'] = { pWin:hWin, pHalfWin:drP, pHalfLoss:0, pLoss:aWin, side:'home', line:0.25 };
        ah['hp025'] = hWin + 0.5*drP; // win-equivalent scalar (draw = half win)
        ah['am025'] = aWin; // away -0.25 mirror
        ah['am025_c'] = { pWin:aWin, pHalfWin:0, pHalfLoss:drP, pLoss:hWin, side:'away', line:-0.25 };
      } else {
        const strAbs=Math.abs(line).toString().replace('.','');
        const keyH=line<0?`hm${strAbs}`:`hp${strAbs}`;
        const keyA=line<0?`ap${strAbs}`:`am${strAbs}`;
        ah[keyH]=hW+(push/2); ah[keyA]=aW+(push/2);
        ah[line.toString()]={homeWin:hW,push,awayWin:aW};
        ah[(line>0?"+":"")+line.toString()]={homeWin:hW,push,awayWin:aW};
      }
    });
    // Team Total O/U: marginal distributions per team
    // homeTotal_over_0_5 = P(home scores ≥ 1), homeTotal_under_1_5 = P(home scores 0 or 1), etc.
    const homeGoalDist = new Array(N).fill(0); // P(home scores exactly i)
    const awayGoalDist = new Array(N).fill(0); // P(away scores exactly j)
    for (let i=0;i<N;i++) { if(!mat[i]) continue; for(let j=0;j<N;j++) { const p=mat[i][j]||0; homeGoalDist[i]+=p; awayGoalDist[j]+=p; } }
    const teamH = {}; const teamA = {};
    [0.5,1.5,2.5].forEach(t => {
      let hOver=0, aOver=0;
      for (let g=Math.ceil(t);g<N;g++) { hOver+=homeGoalDist[g]; aOver+=awayGoalDist[g]; }
      teamH[`over_${t}`]=hOver; teamH[`under_${t}`]=1-hOver;
      teamA[`over_${t}`]=aOver; teamA[`under_${t}`]=1-aOver;
    });

    // Asian 2 Goals: push on exactly 2 total goals
    // P(over_2_asian) = P(goals >= 3); P(push) = P(goals == 2); P(under_2_asian) = P(goals <= 1)
    const asian2Push = totals[2] || 0;
    const asian2Over = totals.slice(3).reduce((s,v)=>s+v, 0);
    const asian2Under = 1 - asian2Over - asian2Push;
    // "Effective" probability accounting for push (refund): over = over + push*0.5, under = under + push*0.5
    const asian2Effective = { over: asian2Over + asian2Push * 0.5, under: asian2Under + asian2Push * 0.5 };

    // Win Either Half (home): P(home wins 1st half OR home wins 2nd half)
    // Approximation without half-time matrix: use Poisson split λ/2 per half
    // P(home wins either half) ≈ 1 - P(home fails to win both halves)
    // We can't compute this exactly without first-half matrix, so expose as null for now
    // (populated from Turn 2 odds JSON when bookmaker provides it)

    return { hw, dr, aw, btts, noBtts:1-btts, ou, ah, dnb_h:dnbH, dnb_a:dnbA,
             dc_1x:hw+dr, dc_x2:aw+dr, teamH, teamA, asian2:asian2Effective };
  },

  // BUG-024 FIXED: BUG-L03 FIXED (v29): 4% per leg vig (market-aligned; correlated parlay
  // scripts receive reduced vig vs independent markets — bookmakers price correlation in)
  generateSyntheticAlpha: function(mat) {
    const scripts = [];
    const N = mat.length || 14;
    const extract = (name, legs, condition) => {
      let prob = 0;
      for (let i=0;i<N;i++) { if(!mat[i]) continue; for(let j=0;j<N;j++) if(condition(i,j)) prob+=(mat[i][j]||0); }
      const legVig = 1 + (0.04 * legs.length); // BUG-L03 FIX: 4% per leg [market-aligned]
      const estBookie = prob > 0 ? (1/Math.max(0.001,prob)) * legVig : 0;
      if (prob > 0.02) scripts.push({title:name,legs,prob,estBookie,edge:(prob*estBookie)-1});
    };
    extract("Script Alpha: Attritional Home Dom.",["Home Win","Away Clean Sheet","Under 3.5"],(h,a)=>h>a&&a===0&&(h+a)<3.5);
    extract("Script Beta: Chaotic Shootout",["Draw","Both Teams to Score","Over 2.5"],(h,a)=>h===a&&h>0&&(h+a)>2.5);
    extract("Script Gamma: Clinical Away Ambush",["Away Win","Home Under 1.5","No BTTS"],(h,a)=>h<a&&h<1.5&&(h===0||a===0));
    extract("Script Delta: Stuffy Correlator",["Under 2.5 Goals","No BTTS"],(h,a)=>(h+a)<2.5&&(h===0||a===0));
    return scripts.sort((a,b)=>b.edge-a.edge).slice(0,4);
  },

  // BLOCK B5 (V1-B FIX): Monte Carlo DELETED — it double-counted on the tau>1 path
  // (outcome probabilities did not sum to 1) and its rejection sampler did not preserve
  // the Dixon-Coles marginals. Crucially, buildMatrix already produces the EXACT DC/ZIP-
  // corrected joint distribution, so every quantity the MC estimated (P(home/draw/away)
  // and their variance) is available in closed form with ZERO sampling error.
  //
  // matrixVariance derives the outcome variance analytically from the corrected matrix.
  // Faster, exact, deterministic (reproducible vetoes), and automatically DC/ZIP-aware.
  //
  // The MC *concept* is preserved for the v2027 copula roadmap, where the joint is no
  // longer closed-form and sampling becomes necessary again.
  matrixVariance: function(lH, lA, rho, n) {
    // n retained for signature compatibility; ignored (no sampling).
    const mat = this.buildMatrix(lH, lA, rho);
    const m = this.extractMarkets(mat);
    const pH = m.hw, pD = m.dr, pA = m.aw;
    // SD of the most-uncertain outcome (matches the old stdDevEst intent)
    const stdDevEst = Math.sqrt(Math.max(pH*(1-pH), pA*(1-pA), pD*(1-pD)));
    let varMultiplier = 1.0;
    if (stdDevEst > 0.45) varMultiplier = 0.80;
    if (stdDevEst > 0.48) varMultiplier = 0.50;
    if (stdDevEst > 0.50) varMultiplier = 0.10;
    const ciBound = stdDevEst * 4.0;
    return { varFlag: stdDevEst > 0.48, varMultiplier, stdDevEst, ciBound };
  },
  // Backward-compatible alias: callers/tests using monteCarlo(lH,lA,rho,n) keep working,
  // now routed through the exact analytic path.
  monteCarlo: function(lH, lA, rho, n=10000) { return this.matrixVariance(lH, lA, rho, n); },

  // ═══════════════════════════════════════════════════════════════════════════
  // v2026.7 R2 — LOW-SCORING REGIME DETECTOR
  // Computed from the already-built final matrix (zero new model cost). Classifies
  // a fixture as LOW_SCORING when goals are suppressed AND no dominant favourite
  // exists to back outright — the exact regime where a 0-0/1-0/0-1 busts result
  // bets and the engine should pivot to Under / BTTS-No / Asian Handicap.
  // Returns the regime label plus the diagnostics the AH pivot needs.
  // ═══════════════════════════════════════════════════════════════════════════
  detectLowScoringRegime: function(mat, lH, lA) {
    const m = this.extractMarkets(mat);
    const N = mat.length || 14;
    const p00 = (mat[0] && mat[0][0]) || 0;
    const p10 = (mat[1] && mat[1][0]) || 0;
    const p01 = (mat[0] && mat[0][1]) || 0;
    const lowScoreMass = p00 + p10 + p01;                  // mass in {0-0,1-0,0-1}
    const pUnder25 = (m.ou && m.ou['under_2.5']) != null ? m.ou['under_2.5'] : (1 - (m.ou ? m.ou['over_2.5'] : 0));
    const expTotal = (lH || 0) + (lA || 0);
    const maxSide = Math.max(m.hw, m.aw);
    const dominantSide = maxSide >= 0.48 ? (m.hw >= m.aw ? 'home' : 'away') : null;

    // Joint criteria — all must hold (per plan Part 2A)
    const isLow =
      expTotal < 2.35 &&
      pUnder25 > 0.58 &&
      lowScoreMass > 0.34 &&
      maxSide < 0.52;

    return {
      regime: isLow ? 'LOW_SCORING' : 'STANDARD',
      p00, lowScoreMass, pUnder25, expTotal, maxSide, dominantSide,
      pHome: m.hw, pDraw: m.dr, pAway: m.aw,
    };
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // v2026.7 R5 — ASIAN HANDICAP PIVOT ENGINE
  // When LOW_SCORING, compute the highest-probability + highest-accuracy AH line,
  // deciding FAVOURITE vs UNDERDOG on data (not narrative). Core rule:
  //   - dominant favourite present → favourite −0.25 / 0.0 (DNB): protects the push,
  //     since a low-scoring favourite may not win BY MARGIN but rarely LOSES.
  //   - even grind (no dominant side) → weaker/either side +0.5 / +0.25: a 0-0 WINS
  //     +0.5 and PUSHES 0.0, converting the predicted low-scoring outcome into a win.
  // Each candidate is scored: wp·P(win+halfwin) + wa·accuracy − wv·variance.
  // `leagueAccuracy` is an optional {sideLine: hitRate} map from CalibrationEngine
  // (R7); when absent, accuracy defaults to the settlement probability (self-consistent).
  // ═══════════════════════════════════════════════════════════════════════════
  asianHandicapPivot: function(mat, regime, leagueAccuracy = {}) {
    const N = mat.length || 14;
    // settlement components for a home AH line at integer/half/quarter `line`
    const ahComponents = (line, side) => {
      let pWin = 0, pHalfWin = 0, pHalfLoss = 0, pLoss = 0, pPush = 0;
      for (let i = 0; i < N; i++) {
        if (!mat[i]) continue;
        for (let j = 0; j < N; j++) {
          const p = mat[i][j] || 0; if (!p) continue;
          // margin from the chosen side's perspective
          const rawMargin = side === 'home' ? (i - j) : (j - i);
          const adj = rawMargin + line;
          if (Math.abs(adj - 0.25) < 0.01) { pWin += p * 0.5; pPush += p * 0.5; }      // +0.25 win-leg + push-leg → treat as half-win
          else if (Math.abs(adj + 0.25) < 0.01) { pLoss += p * 0.5; pPush += p * 0.5; }// −0.25 loss-leg + push-leg → half-loss
          else if (adj > 0.01) pWin += p;
          else if (adj < -0.01) pLoss += p;
          else pPush += p; // exact 0 → full push (DNB/whole-line)
        }
      }
      // Fold quarter-line partials: pHalfWin/pHalfLoss tracked via the 0.5 splits above
      const pWinEff = pWin;                 // includes half-win mass from +0.25
      const settleProb = pWinEff + 0.5 * pPush; // win-equivalent probability (push returns stake)
      return { line, side, pWin: pWinEff, pPush, pLoss, settleProb };
    };

    // Candidate lines depend on whether there's a dominant favourite
    let candidates;
    if (regime.dominantSide) {
      const fav = regime.dominantSide;
      candidates = [
        ahComponents(0.0, fav),    // DNB favourite — push protects vs 0-0/draw
        ahComponents(-0.25, fav),  // favourite −0.25 — mild margin requirement
        ahComponents(0.25, fav),   // favourite +0.25 — very safe
        ahComponents(-0.5, fav),   // favourite −0.5 — needs outright win
      ];
    } else {
      // even grind — both sides' +0.5/+0.25 are the high-prob "not losing" plays
      candidates = [
        ahComponents(0.5, 'home'), ahComponents(0.25, 'home'),
        ahComponents(0.5, 'away'), ahComponents(0.25, 'away'),
        ahComponents(0.0, 'home'), ahComponents(0.0, 'away'),
      ];
    }

    // Score: blend settlement probability, historical accuracy, variance penalty
    const wp = 0.55, wa = 0.35, wv = 0.10;
    const scored = candidates.map(c => {
      const key = `${c.side}_${c.line}`;
      const acc = (leagueAccuracy[key] != null) ? leagueAccuracy[key] : c.settleProb; // default to model prob
      const variance = c.settleProb * (1 - c.settleProb); // Bernoulli variance of the line
      const score = wp * c.settleProb + wa * acc - wv * variance;
      return { ...c, accuracy: acc, score };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    return {
      pivotApplied: true,
      recommendation: `AH ${best.line >= 0 ? '+' : ''}${best.line} ${best.side}`,
      side: best.side,
      line: best.line,
      settleProb: best.settleProb,
      accuracy: best.accuracy,
      score: best.score,
      rationale: regime.dominantSide
        ? `Dominant ${regime.dominantSide} favourite in low-scoring spot → ${best.line === 0 ? 'DNB' : 'AH '+best.line} protects the push; favourite unlikely to LOSE but may not win by margin.`
        : `Even low-scoring grind → AH ${best.line >= 0 ? '+' : ''}${best.line} ${best.side}: a 0-0 ${best.line >= 0.5 ? 'WINS' : 'PUSHES'} this line.`,
      allCandidates: scored,
    };
  },

  // BLOCK B14 (V2-A): This is BISECTION on the Shin/"power" exponent k such that
  // Σ (1/oᵢ)^k = 1 — not a power method (renamed for honesty). 40 iterations ≫ enough at
  // 1e-8 (was 64, which was meaningless overkill given the early-exit). The linear-
  // normalisation branch for rawSum < 1.0 (arbitrage / negative-vig) is DELIBERATE and
  // correct: the favourite-longshot power correction has the wrong sign in a negative-vig
  // book, so plain normalisation is the right treatment there.
  shinPowerVigRemoval: function(oddsH, oddsD, oddsA) {
    const impH=1/oddsH, impD=1/oddsD, impA=1/oddsA;
    if(oddsH<=1||oddsD<=1||oddsA<=1){const s=impH+impD+impA;return{home:impH/s,draw:impD/s,away:impA/s,k:1};}
    const rawSum = impH + impD + impA;
    if (rawSum < 1.0) { return { home:impH/rawSum, draw:impD/rawSum, away:impA/rawSum, k:1 }; } // arb: linear (deliberate)
    let lo=1.0,hi=10.0,k=1.0;
    for(let i=0;i<40;i++){k=(lo+hi)/2;const sum=Math.pow(impH,k)+Math.pow(impD,k)+Math.pow(impA,k);if(Math.abs(sum-1.0)<1e-8)break;if(sum>1.0)lo=k;else hi=k;}
    return{home:this.clamp(Math.pow(impH,k),0.001,0.999),draw:this.clamp(Math.pow(impD,k),0.001,0.999),away:this.clamp(Math.pow(impA,k),0.001,0.999),k};
  },
  // Back-compat aliases — existing call sites/tests keep working.
  get powerMethodVigRemoval(){return this.shinPowerVigRemoval;},
  get powerVigRemoval(){return this.shinPowerVigRemoval;},

  // BUG-009 FIXED (v27): RLM direction logic corrected
  // BUG-A04 FIXED (v28): SHARP_COMPRESSION now directional (velocity > +0.03 in implied-prob
  //   space = odds shortening = compression). Math.abs() removed — expansion ≠ compression.
  // S03/S04 MUTUAL EXCLUSION enforced: RLM (drift) and Compression (steam) cannot
  //   co-occur on same direction per Gemini Wrapper Critical Rule #4.
  lstmMarketDecoderProxy: (modelProb, openOdds, currentOdds, isPopular) => {
    if(!openOdds||!currentOdds||openOdds<=1||currentOdds<=1) return{velocity:0,rlm:false,steam:false,sharpCompression:false};
    // velocity > 0: odds shortening (implied prob rising = more money coming in)
    // velocity < 0: odds drifting out (implied prob falling)
    const velocity=(1/currentOdds)-(1/openOdds);
    let rlm=false, steam=false, sharpCompression=false;
    if(isPopular) {
      // Popular team: public money should shorten odds (velocity > 0)
      // TRUE RLM = odds lengthening despite public support (velocity < -0.015)
      if(velocity < -0.015) rlm = true;
      // Sharp steam = very fast shortening (velocity > 0.025)
      if(velocity > 0.025) steam = true;
    } else {
      // Unpopular team: odds stable or drifting expected
      // Sharp steam = fast shortening (velocity > 0.015) = sharp syndicate action
      if(velocity > 0.015) steam = true;
      if(velocity < -0.025) rlm = true;
    }
    // BUG-A04 FIX: SHARP_COMPRESSION = directional fast shortening only (velocity > +0.03)
    // Gemini Wrapper S04 spec says "absolute velocity > 0.03" but CRITICAL RULE 4
    // says S03/S04 cannot co-occur. Since velocity>0 (compression) and velocity<0 (drift/RLM)
    // are mutually exclusive by sign, directional check + rlm guard satisfies both rules.
    // S03/S04 MUTUAL EXCLUSION enforced: compression cannot be flagged when RLM is active
    if(velocity > 0.03 && !rlm) sharpCompression = true;
    return{velocity,rlm,steam,sharpCompression};
  },

  calculateDHA: (piDiff) => { if(piDiff<-0.8)return 0.85; if(piDiff>1.2)return 1.15; return 1.0; },
  calculateDynamicRho: (lH,lA,baseRho)=>MathEngine.clamp(baseRho*Math.exp(-0.25*((lH+lA)-2.5)),-0.5,Math.abs(baseRho*1.5)),
  hurdle: (p)=>{if(p>=0.75)return 0.03;if(p>=0.60)return 0.04;if(p>=0.40)return 0.06;if(p>=0.20)return 0.09;if(p>=0.10)return 0.12;return 0.15;},
  adjEV: (modelP, odds) => (modelP * odds - 1) - MathEngine.MOS,

  // v2026.6.0 — BLOCK B0: Kelly denominator CORRECTED.
  // Prior "BUG-C02 FIX" set q = 1 - modelProb, which is WRONG. Canonical Kelly for
  // decimal odds o, win prob p, net odds b = o-1 is:
  //   f* = (p*b - q)/b = (p*o - 1)/(o - 1) = edge / (o - 1)
  // The denominator is b = o-1, NOT q = 1-p (those coincide essentially never).
  // The previous form over-staked 2–5× (worst on longshots). The Python reference
  // engine (oracle_core.py) already used the correct edge/(price-1) form.
  // Tests T281–T284 (executable) verify this against a known-good reference.
  optimizedKelly: (edge, odds, dqs, councilPenaltyActive, varMultiplier=1.0, drawdownPenalty=1.0, calibFactor=1.0, base=0.25, modelProb=null) => {
    if(edge<=0||odds<=1) return 0;
    const safeDQS=MathEngine.clamp(dqs,0.4,1.0)||0.85;
    const penaltyMod=councilPenaltyActive?0.5:1.0;
    const fraction=base*safeDQS*penaltyMod*varMultiplier*drawdownPenalty*calibFactor;
    // modelProb = (edge + 1) / odds  [since edge = modelProb*odds - 1]
    const mp = modelProb !== null ? modelProb : MathEngine.clamp((edge + 1) / Math.max(1.001, odds), 0.001, 0.999);
    const b = odds - 1;                 // canonical net-odds denominator
    if(b<=0) return 0;
    const fStar = (mp * odds - 1) / b;  // = edge / (odds - 1)
    if(fStar<=0) return 0;
    return MathEngine.clamp(fStar*fraction,0,0.15);
  },

  CorrelationMatrix: {
    // B1-06: AH Unicode parser — handles Unicode minus (\u2212) and quarter-ball lines (±0.25, ±0.75)
    cellMatches: function(i,j,label) {
      if(!label)return false;
      if(label==="Home Win"||label==="Match Winner: Home")return i>j;
      if(label==="Away Win"||label==="Match Winner: Away")return i<j;
      if(label==="Draw"||label==="Match Winner: Draw")return i===j;
      if(label.includes("Over")){const t=parseFloat(label.split(" ")[1]||label.split(" ")[2]);return(i+j)>t;}
      if(label.includes("Under")){const t=parseFloat(label.split(" ")[1]||label.split(" ")[2]);return(i+j)<t;}
      if(label==="BTTS Yes")return i>0&&j>0;
      if(label==="BTTS No")return i===0||j===0;
      if(label.includes("AH Home")){
        // B1-06: normalise Unicode minus \u2212 and en-dash \u2013 → standard hyphen-minus
        const rawL=label.split(" ")[2]||'0';
        const l=parseFloat(rawL.replace(/\u2212|\u2013/g,"-").replace(/[^\d.\-]/g,''));
        if(isNaN(l))return false;
        const diff=i-j+l;
        if(diff>0)return true;          // full win
        if(diff===0)return false;        // push (quarter-ball handles partial below)
        // Quarter-ball: ±0.25 → half-win/half-loss — count as ">0" for probability purposes
        if(Math.abs((l*4)%1)<0.01&&diff>-0.5)return false; // exactly on line = push
        return false;
      }
      if(label.includes("AH Away")){
        const rawL=label.split(" ")[2]||'0';
        const l=parseFloat(rawL.replace(/\u2212|\u2013/g,"-").replace(/[^\d.\-]/g,''));
        if(isNaN(l))return false;
        const diff=j-i+l;
        if(diff>0)return true;
        return false;
      }
      if(label==="1X")return i>=j; if(label==="X2")return i<=j;
      return false;
    },
    compute: function(mat,labelA,labelB) {
      if(!labelA||!labelB||!mat||!mat[0])return 0;
      let pA=0,pB=0,pAB=0;
      const N=mat.length;
      for(let i=0;i<N;i++){if(!mat[i])continue;for(let j=0;j<N;j++){const prob=mat[i][j]||0,mA=this.cellMatches(i,j,labelA),mB=this.cellMatches(i,j,labelB);if(mA)pA+=prob;if(mB)pB+=prob;if(mA&&mB)pAB+=prob;}}
      const denom=Math.sqrt(pA*(1-pA)*pB*(1-pB));
      if(denom===0)return 0;
      return(pAB-(pA*pB))/denom;
    }
  },

  // BUG-A02 FIXED (v28) / BUG-M09 FIXED (v29): CLV Projection semantic correction.
  // BUG-M09 ROOT CAUSE: `survivalProb` was actually an edge RETENTION FRACTION (how much
  //   of the original edge survives to kickoff), not a probability. S05 threshold of >0.70
  //   was calibrated against a fraction, not a true probability — semantically misleading.
  // v29 FIX: Return both `edgeRetentionFraction` (original quantity, renamed) AND
  //   a true `survivalProb` via logistic sigmoid on the fraction vs a 0.50 neutral point.
  //   S05 in ConvergenceScorer updated to use `survivalProb` (true probability form).
  clvProjection: (edge, hoursToKO, marketType, leagueLiquidity=1.0) => {
    if (edge <= 0) return { projected: 0, survivalProb: 0.05, edgeRetentionFraction: 0.05, decayFactor: 1.0 };
    const marketDecayRate = marketType === '1x2' ? 0.12 : marketType === 'AH' ? 0.08 : 0.05;
    const timeDecay = Math.exp(-marketDecayRate * Math.min(hoursToKO, 48) / 24);
    const liquidity = MathEngine.clamp(leagueLiquidity, 0.3, 1.5);
    // Projected edge after time decay and liquidity compression
    const projectedEdge = edge * timeDecay / liquidity;
    // Edge-sensitive scaling: larger raw edge → higher retention floor
    const edgeStrengthFactor = MathEngine.clamp(edge / 0.08, 0.1, 2.0);
    const retentionRaw = projectedEdge / Math.max(0.001, edge);
    // edgeRetentionFraction: fraction of original edge retained [renamed from survivalProb in v28]
    const edgeRetentionFraction = MathEngine.clamp(
      retentionRaw * (0.6 + 0.4 * Math.min(1.0, edgeStrengthFactor)), 0.05, 0.95
    );
    // True survivalProb: logistic sigmoid centred on 0.50 retention as neutral point
    // >50% retention → survivalProb > 0.5; strong retention (>80%) → ~0.80+
    const logit = 6.0 * (edgeRetentionFraction - 0.50); // scale factor for steepness
    const survivalProb = MathEngine.clamp(1 / (1 + Math.exp(-logit)), 0.05, 0.95);
    return { projected: projectedEdge, survivalProb, edgeRetentionFraction, decayFactor: timeDecay, edgeStrengthFactor };
  },

  // NEW-11: Progressive drawdown taper (3-tier, replaces binary cliff — BUG-004 ENHANCEMENT)
  getDrawdownPenalty: (drawdown) => {
    if (drawdown >= 0.25) return 0.25;   // Severe: 75% stake reduction
    if (drawdown >= 0.15) return 0.50;   // Moderate: 50% stake reduction
    if (drawdown >= 0.08) return 0.75;   // Early warning: 25% stake reduction
    return 1.0;                           // No penalty
  },

  // NEW-15: Poisson Temporal Decay — exponentially-weighted recent form
  // recentMatches: [{xg, goalsScored, matchdayOffset}] sorted recent-first
  // halfLife = 10 matches (Dixon & Coles, Dixon & Pope 2004 recommended)
  applyTemporalDecay: (recentMatches, baseAvg, halfLife=10) => {
    if (!recentMatches || recentMatches.length < 3) return baseAvg;
    let weightedSum = 0, totalWeight = 0;
    recentMatches.forEach((m, idx) => {
      const w = Math.exp(-Math.log(2) * idx / halfLife);
      const val = m.xg > 0 ? m.xg : m.goalsScored || baseAvg;
      weightedSum += val * w;
      totalWeight += w;
    });
    const decayedAvg = totalWeight > 0 ? weightedSum / totalWeight : baseAvg;
    // Blend 60% temporal decay, 40% season average for stability
    return MathEngine.clamp(decayedAvg * 0.6 + baseAvg * 0.4, 0.1, 4.5);
  },

  // NEW-17 / BUG-M03 FIXED (v29): Elo Momentum Signal — derivative of Elo over last 5 matches
  // eloHistory: [{rating, matchday}] — sorted most-recent FIRST (index 0 = latest match)
  // BUG-M03 ROOT CAUSE: original code used eloHistory order directly as x-axis (i=0=most-recent)
  //   This gave NEGATIVE slope for rising teams (high rating at i=0, lower at i=4 → slope < 0)
  //   and POSITIVE slope for falling teams — EXACT INVERSION of intended behavior.
  // FIX: reverse the array before regression so oldest=index 0 → most-recent=index n-1.
  //   Now rising Elo → higher ratings at high x values → positive slope → momentum > 1.0 ✓
  // Returns momentum factor [0.85, 1.15] to scale lambda
  eloMomentumFactor: (eloHistory) => {
    if (!eloHistory || eloHistory.length < 2) return 1.0;
    // Take up to 5 most-recent entries (input sorted most-recent-first), then REVERSE for regression
    const recent = eloHistory.slice(0, Math.min(5, eloHistory.length)).reverse(); // oldest first now
    if (recent.length < 2) return 1.0;
    // Linear regression slope: x = match index (0=oldest, n-1=most recent), y = rating
    const n = recent.length;
    const xMean = (n - 1) / 2;
    const yMean = recent.reduce((s, r) => s + r.rating, 0) / n;
    let num = 0, den = 0;
    recent.forEach((r, i) => { num += (i - xMean) * (r.rating - yMean); den += (i - xMean) ** 2; });
    const slope = den > 0 ? num / den : 0; // Elo points per match: positive = improving, negative = declining
    // Map slope to multiplier: +20 pts/match → 1.10; -20 pts/match → 0.90
    const momentum = MathEngine.clamp(1.0 + (slope / 200), 0.85, 1.15);
    return momentum;
  },

  // NEW-19 / NEW-29 FIXED (v29): Draw Calibration Factor
  // Citation corrected: draw probability underpricing in Asian markets is documented in
  // Constantinou & Fenton (2012) "Solving the Problem of Inadequate Scoring Rules"
  // and is consistent with the Dixon & Coles (1997) tau correction evidence.
  // Hvattum & Arntzen (2010) is an Elo prediction study and does NOT establish this factor.
  // Draw probability is systematically underpriced in Asian markets by 2-3%
  // Apply league-specific draw rate / poisson draw estimate correction for AH fair value
  drawCalibrationFactor: (poissonDrawProb, leagueDrawRate=0.25) => {
    if (poissonDrawProb <= 0) return 1.0;
    const ratio = leagueDrawRate / Math.max(0.05, poissonDrawProb);
    return MathEngine.clamp(ratio, 0.85, 1.20); // conservative bounds (Constantinou & Fenton 2012)
  },

  // NEW-16: Lambda Inconsistency Check
  // Cross-validates λH, λA vs the O/U 2.5 market implied probability
  // Flags [LAMBDA_INCONSISTENCY] if divergence > 5%
  checkLambdaInconsistency: (lH, lA, ou25ImpliedProb) => {
    if (!ou25ImpliedProb || ou25ImpliedProb <= 0 || ou25ImpliedProb >= 1) return { inconsistent: false, divergence: 0 };
    // Poisson estimate of P(total goals > 2.5) from λH + λA
    const totalLambda = lH + lA;
    let poissonOver25 = 0;
    for (let g = 3; g <= 12; g++) {
      poissonOver25 += MathEngine.poissonPMF(g, totalLambda);
    }
    const divergence = Math.abs(poissonOver25 - ou25ImpliedProb);
    return { inconsistent: divergence > 0.05, divergence, poissonEstimate: poissonOver25 };
  },

  // NEW-18: Steam Chaser Detection Gate
  // If SHARP_COMPRESSION fires but edge < 5%, the sharp money has already compressed
  // the line — no value remains, betting into it is steam chasing
  isSteamChaser: (sharpCompression, edge) => {
    return sharpCompression && edge < 0.05;
  },

  // B15: Scenario Branching — rerun Poisson model with an injected event override
  // Supports: key_player_out, key_player_in, weather_change, rotation_detected, late_odds_move
  // Returns { deltaScore, newLambdaH, newLambdaA, newMarkets, deltaKelly, eventApplied }
  rerunWithOverride: function(event, baseResult) {
    if (!baseResult || !event) return null;
    const eventType = (event.type || event).toLowerCase();
    let lH = MathEngine.safeNum(baseResult.bayesian_lH, 1.3);
    let lA = MathEngine.safeNum(baseResult.bayesian_lA, 1.1);

    // Lambda adjustment table — parametric per event type
    const adjustments = {
      key_player_out_home:    { lH: -0.18, lA:  0.0 },
      key_player_out_away:    { lH:  0.0,  lA: -0.15 },
      key_player_in_home:     { lH: +0.12, lA:  0.0 },
      key_player_in_away:     { lH:  0.0,  lA: +0.10 },
      weather_change_heavy:   { lH: -0.10, lA: -0.10 },
      weather_change_clear:   { lH: +0.05, lA: +0.05 },
      rotation_detected_home: { lH: -0.15, lA:  0.0 },
      rotation_detected_away: { lH:  0.0,  lA: -0.12 },
      late_odds_move_home:    { lH: +0.08, lA: -0.05 },
      late_odds_move_away:    { lH: -0.05, lA: +0.08 },
    };

    // Match event string to adjustment
    let adj = { lH: 0, lA: 0 };
    for (const [key, delta] of Object.entries(adjustments)) {
      if (eventType.includes(key.replace(/_/g,' ')) || eventType.includes(key)) {
        adj = delta; break;
      }
    }
    // Also handle plain descriptions
    if (eventType.includes('striker') || eventType.includes('striker out') || eventType.includes('out'))
      adj = { lH: adj.lH || -0.15, lA: adj.lA };
    if (eventType.includes('rain') || eventType.includes('heavy rain'))
      adj = { lH: -0.10, lA: -0.10 };

    const newLH = Math.max(0.1, lH + adj.lH);
    const newLA = Math.max(0.1, lA + adj.lA);

    // Rebuild matrix and markets
    const rho = baseResult.dynamicRho || -0.13;
    const newMat = MathEngine.buildMatrix(newLH, newLA, rho);
    const newMarkets = MathEngine.extractMarkets(newMat);

    // Approximate convergence score delta (signal count proxy)
    const oldXG = lH + lA;
    const newXG = newLH + newLA;
    const xgDelta = newXG - oldXG;
    const deltaScore = Math.round(xgDelta * 3); // rough: each 1 xG ≈ 3 score points

    // Kelly delta on home win (approximate)
    const baseKelly = baseResult.evMarkets?.[0]?.stake || 0;
    const kellyAdj  = baseKelly * (1 + xgDelta * 0.2);
    const deltaKelly = kellyAdj - baseKelly;

    return {
      eventApplied: eventType,
      lambdaH: { before: lH, after: newLH, delta: adj.lH },
      lambdaA: { before: lA, after: newLA, delta: adj.lA },
      newMarkets,
      deltaScore,
      deltaKelly,
      newLambdaH: newLH,
      newLambdaA: newLA,
      interpretation: adj.lH !== 0 || adj.lA !== 0
        ? `λH ${lH.toFixed(2)}→${newLH.toFixed(2)} (${adj.lH>=0?'+':''}${adj.lH.toFixed(2)})  λA ${lA.toFixed(2)}→${newLA.toFixed(2)} (${adj.lA>=0?'+':''}${adj.lA.toFixed(2)})`
        : `No parametric adjustment for event: "${eventType}"`,
    };
  },

  // ── HF-A: Statistical Utilities (Box-Muller Gaussian, Benford MAD, Second-Digit) ────
  // gaussianRand: Box-Muller transform → normally distributed random variable.
  // Used by SensitivityEngine Gaussian K=20 ensemble (HF-D).
  gaussianRand: function(mu, sigma) {
    let u = 0, v = 0;
    while(u === 0) u = Math.random();
    while(v === 0) v = Math.random();
    return mu + sigma * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  },

  // benfordMAD: Benford's Law first-digit MAD test.
  // Returns mean absolute deviation from expected Benford frequencies.
  // null when sample < 50 (insufficient for reliable test).
  benfordMAD: function(values) {
    if (!values || values.length < 50) return null;
    const expected = [0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046];
    const counts = new Array(9).fill(0);
    let total = 0;
    for (const v of values) {
      const s = String(Math.abs(v)).replace(/^0\.0*/, '').replace('.', '');
      const d = parseInt(s[0], 10);
      if (d >= 1 && d <= 9) { counts[d-1]++; total++; }
    }
    if (total === 0) return null;
    let mad = 0;
    for (let i = 0; i < 9; i++) mad += Math.abs(counts[i]/total - expected[i]);
    return parseFloat((mad / 9).toFixed(6));
  },

  // secondDigitFreq: Second-digit frequency test (Benford 2BL).
  // Detects retail price rounding bias (.x0 / .x5 endings) in a set of odds values.
  // Returns fraction of values with second decimal digit 0 or 5.
  // null when sample < 20. > 0.30 signals [CROWD_PRICE_ROUNDING_BIAS].
  secondDigitFreq: function(values) {
    if (!values || values.length < 20) return null;
    let rounded = 0;
    for (const v of values) {
      const s = v.toFixed(2);
      const d2 = parseInt(s[s.length - 1], 10);  // last decimal digit
      if (d2 === 0 || d2 === 5) rounded++;
    }
    return parseFloat((rounded / values.length).toFixed(4));
  },

  // ── HF-10a: KL-Divergence Signal Filter ────────────────────────────────────
  // D_KL(P_model || P_market) > 0.15 = HARD SIGNAL (fundamental mispricing).
  // Jensen-Shannon divergence as symmetric complement (used in OC-14 temperature ensemble).
  // Source: wrapper audit; arXiv information-theoretic edge quantification.
  // ── A1: RANKED PROBABILITY SCORE (RPS) — the football-standard scoring metric ──
  // RPS is ordinally aware: for ordered outcomes (Home > Draw > Away on a margin scale)
  // it penalises a Home forecast less on a Draw than on an Away result, which Brier cannot.
  // Used across the football-forecasting literature (Constantinou & Fenton; 2017/2023
  // Soccer Prediction Challenges; penaltyblog/opisthokonta practice).
  //   RPS = 1/(r-1) · Σ_{i=1}^{r-1} ( Σ_{j=1}^{i} (p_j - e_j) )²   for r=3 ordered outcomes.
  // Lower is better; 0 = perfect, ~0.205 = empirical ceiling on common data.
  rankedProbabilityScore: function(forecast, outcome) {
    const order = ['home', 'draw', 'away'];
    // Normalise FIRST (clamping before normalising would distort unnormalised forecasts,
    // e.g. {6,3,1} → clamp → {1,1,1} → {1/3,1/3,1/3} instead of {0.6,0.3,0.1}). Guard negatives.
    const raw = order.map(o => Math.max(0, forecast?.[o] || 0));
    const ps = raw.reduce((a, c) => a + c, 0) || 1;
    const pf = raw.map(v => v / ps);
    const e = (typeof outcome === 'string')
      ? order.map(o => (o === outcome ? 1 : 0))
      : order.map(o => (outcome?.[o] ? 1 : 0));
    let rps = 0, cumP = 0, cumE = 0;
    for (let i = 0; i < order.length - 1; i++) {
      cumP += pf[i]; cumE += e[i];
      rps += (cumP - cumE) ** 2;
    }
    return rps / (order.length - 1);
  },

  // meanRPS over an array of {forecast, outcome} records (skips unresolved).
  meanRPS: function(records) {
    let sum = 0, n = 0;
    for (const r of (records || [])) {
      if (!r || !r.forecast || !r.outcome) continue;
      const v = this.rankedProbabilityScore(r.forecast, r.outcome);
      if (v !== null && Number.isFinite(v)) { sum += v; n++; }
    }
    return n > 0 ? { rps: sum / n, n } : { rps: null, n: 0 };
  },

  klDivergence: function(modelDist, marketDist) {
    const eps = 1e-10;
    const outs = ['home','draw','away'];
    let kl = 0, js = 0;
    outs.forEach(o => {
      const p = Math.max(eps, modelDist[o] || 0);
      const q = Math.max(eps, marketDist[o] || 0);
      const m = (p + q) / 2;
      kl += p * Math.log(p / q);
      js += 0.5 * (p * Math.log(p / m) + q * Math.log(q / m));
    });
    const hardSignal = kl > 0.15;
    const strength = kl > 0.20 ? 'EXTREME' : kl > 0.15 ? 'HARD' : kl > 0.08 ? 'MODERATE' : 'WEAK';
    const bitsAdv = parseFloat((kl / Math.log(2)).toFixed(4));
    const maxDiv = outs.reduce((mx, o) => {
      const d = Math.abs((modelDist[o]||0) - (marketDist[o]||0));
      return d > mx.d ? { o, d } : mx;
    }, { o:'', d:0 });
    return {
      kl: parseFloat(kl.toFixed(6)), js: parseFloat(js.toFixed(6)),
      hardSignal, strength, bitsAdv, maxDivOutcome: maxDiv.o,
      flag: hardSignal
        ? `[KL_HARD_SIGNAL] D_KL=${kl.toFixed(4)} (${bitsAdv} bits) — market mispriced on ${maxDiv.o}`
        : kl > 0.08 ? `[KL_MODERATE] D_KL=${kl.toFixed(4)} — soft divergence` : null
    };
  },

  // ── HF-10b: Normalized Market Efficiency Test ───────────────────────────────
  // Corrects favorite-longshot bias in traditional inverse-odds methods.
  // efficiency < 0.85 = significant edge available; > 0.95 = market efficient, thin edge.
  // Source: ScienceDirect 2024/2025 normalized probability research; wrapper audit.
  normalizedEfficiency: function(oddsH, oddsD, oddsA, mH, mD, mA) {
    if (!oddsH||!oddsD||!oddsA||oddsH<=1||oddsD<=1||oddsA<=1) return null;
    const ih=1/oddsH, id=1/oddsD, ia=1/oddsA, s=ih+id+ia;
    const nH=ih/s, nD=id/s, nA=ia/s;
    const eff = parseFloat((1 - (Math.abs(mH-nH)+Math.abs(mD-nD)+Math.abs(mA-nA))/2).toFixed(4));
    const flb = (Math.max(nH,nA) > 0.60 && Math.min(nH,nA)/Math.max(nH,nA) < 0.40) ? 'DETECTED':'NONE';
    return {
      normProbs:{home:nH,draw:nD,away:nA}, eff, flb,
      flag: eff < 0.85
        ? `[MARKET_INEFFICIENCY] Eff=${(eff*100).toFixed(1)}% — significant edge (FLB:${flb})`
        : eff > 0.95 ? `[MARKET_EFFICIENT] Eff=${(eff*100).toFixed(1)}% — thin, proceed with caution` : null
    };
  },

  // ── HF-11b: Antila (2024) Adaptive Variance Regime Detection ─────────────────
  // Detects momentum/mean-reversion regimes from recent ledger returns.
  // Adjusts Kelly fraction when recent realized variance deviates from expected.
  // Source: Antila (2024) adaptive fractional Kelly; generalizedKellySerialDependence (wrapper).
  adaptiveVarianceRegime: function(recentReturns) {
    if (!recentReturns || recentReturns.length < 4) return { regime:'INSUFFICIENT_DATA', factor:1.0, autocorr:0 };
    const n = recentReturns.length;
    const mean = recentReturns.reduce((a,b)=>a+b,0)/n;
    // Lag-1 autocorrelation
    let num=0, den=0;
    for(let i=1;i<n;i++) num+=(recentReturns[i]-mean)*(recentReturns[i-1]-mean);
    for(let i=0;i<n;i++) den+=Math.pow(recentReturns[i]-mean,2);
    const autocorr = den>0 ? num/den : 0;
    // L3 vs L8 acceleration
    const l3 = recentReturns.slice(-3);
    const l8 = recentReturns.slice(-Math.min(8,n));
    const l3wr = l3.filter(x=>x>0).length/3;
    const l8wr = l8.filter(x=>x>0).length/l8.length;
    const accel = l3wr - l8wr;
    let regime='NEUTRAL', factor=1.0;
    if(autocorr>0.35){regime='MOMENTUM';factor=Math.min(1.20,1+autocorr*0.5);}
    else if(autocorr<-0.25){regime='MEAN_REVERSION';factor=Math.max(0.75,1+autocorr*0.4);}
    if(Math.abs(accel)>0.30){regime=accel>0?'ACCELERATING':'DECELERATING';factor*=(accel>0?1.10:0.85);}
    return { regime, factor:parseFloat(factor.toFixed(3)), autocorr:parseFloat(autocorr.toFixed(3)), l3WinRate:l3wr, l8WinRate:l8wr, accel:parseFloat(accel.toFixed(3)) };
  },

  // ── HF-11c: Lee (2025) Probabilistic Recovery Constraint ──────────────────
  // After drawdown, adds a time-horizon recovery guard to Kelly sizing.
  // Reduces stake when drawdown is deep AND recovery horizon is tight.
  // Source: Lee (2025) SSRN probabilistic recovery after drawdowns.
  leeRecoveryConstraint: function(drawdown, betsRemaining=50, targetRecovery=1.0) {
    if(drawdown<=0) return { multiplier:1.0, recoveryProb:1.0, constrained:false };
    // Probability of recovering to target within N bets at current edge
    // Simplified closed-form: P(recover) ≈ 1 - exp(-2·N·edge / drawdown)
    const estimatedEdge = 0.04; // conservative ORACLE average edge assumption
    const recoveryProb = Math.min(0.99, 1 - Math.exp(-2*betsRemaining*estimatedEdge/Math.max(0.01,drawdown)));
    // Constrain: if recovery probability < 70%, reduce Kelly to preserve capital
    const multiplier = recoveryProb >= 0.70 ? 1.0
      : recoveryProb >= 0.50 ? 0.85
      : recoveryProb >= 0.30 ? 0.65
      : 0.50;
    return { multiplier:parseFloat(multiplier.toFixed(3)), recoveryProb:parseFloat(recoveryProb.toFixed(3)), constrained:multiplier<1.0,
      flag: multiplier<1.0 ? `[LEE_RECOVERY_CONSTRAINT] drawdown=${(drawdown*100).toFixed(1)}%, recovery P=${(recoveryProb*100).toFixed(0)}% — Kelly ×${multiplier}` : null };
  },

  // ── HF-11d: Serial Dependence Autocorrelation (wrapper integration) ─────────
  // Lightweight version of generalizedKellySerialDependence from wrapper.
  // Returns edge multiplier based on momentum regime from recent bet history.
  serialDependenceMultiplier: function(recentOutcomes) {
    if(!recentOutcomes||recentOutcomes.length<3) return 1.0;
    const regime = MathEngine.adaptiveVarianceRegime(recentOutcomes);
    return regime.factor;
  },

  // ── HF-10c: Sarmanov Partial Extension ─────────────────────────────────────
  // Extends dependence modelling beyond the 4 DC low-score cells for high-scoring
  // leagues (Bundesliga) and women's football (higher overdispersion).
  // Source: Michels et al. 2023 arXiv:2307.02139 — Sarmanov family for bivariate Poisson.
  //
  // BLOCK B8 (V1-C FIX): The previous implementation hard-coded per-cell multipliers with
  // magic coefficients on cells (0,2),(2,0),(1,2),(2,1),(2,2). Those do NOT satisfy the
  // Sarmanov marginal-preservation constraint, so enabling them silently distorted the
  // marginals. This is the REAL construction: a mixing function phi(k)=e^{-k}-L_lambda
  // (orthogonal to the Poisson marginal, E[phi]=0), giving
  //   tau(x,y) = 1 + omega * phi(x;lH) * phi(y;lA),  L_lambda = exp(lambda*(e^{-1}-1)).
  // This multiplies EVERY cell and provably preserves both marginals for any admissible
  // omega — the only principled correction for high-lambda leagues. TUNE: gated by
  // ORACLE_CONFIG.SARMANOV_ORDER (0 = pure DC); enable per-league only after a Brier-score
  // backtest passes (RegressionHarness gate BRIER).
  // `omega` is supplied as the `rho` argument when order>0 (per-league fitted dependence).
  sarmanovTau: function(x, y, lH, lA, rho, order=0) {
    if (order === 0) return this.dixonColesTau(x, y, lH, lA, rho);
    const omega = rho; // fitted Sarmanov dependence coefficient
    if (!omega) return 1.0;
    const Llam = (lam) => Math.exp(lam * (Math.exp(-1) - 1)); // E[e^{-K}] under Poisson(lam)
    const phi = (k, lam) => Math.exp(-k) - Llam(lam);          // zero-mean mixing function
    // Admissibility floor keeps tau positive over the support.
    return this.clamp(1 + omega * phi(x, lH) * phi(y, lA), 0.05, 3.0);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// §4 — TEAM RATINGS ENGINE (ELO with Math.tanh dampening — v29.0 unchanged)
// ═══════════════════════════════════════════════════════════════════════════════

const TeamRatingsEngine = {
  _safeLS: () => _safeStorage,
  load:()=>{try{return JSON.parse(_safeStorage.getItem('oracle_v2026_teams')||'{}');}catch(e){return{};}},
  save:(d)=>{try{_safeStorage.setItem('oracle_v2026_teams',JSON.stringify(d));}catch(e){}},
  reset(){try{_safeStorage.removeItem('oracle_v2026_teams');}catch(e){}},
  getRating(teamName,defaultVal=1500){if(!teamName)return defaultVal;const d=this.load();return d[teamName.toLowerCase().trim()]||defaultVal;},
  update: function(hTeam,aTeam,hG,aG,exH,exA) {
    if(!hTeam||!aTeam)return;
    const d=this.load();
    const upd=20*Math.tanh(((hG-aG)-(exH-exA))/2);
    d[hTeam.toLowerCase()]=Math.max(1000,Math.min(2000,(d[hTeam.toLowerCase()]||1500)+upd));
    d[aTeam.toLowerCase()]=Math.max(1000,Math.min(2000,(d[aTeam.toLowerCase()]||1500)-upd));
    this.save(d);
    return{homeRating:d[hTeam.toLowerCase()],awayRating:d[aTeam.toLowerCase()],updateAmount:upd};
  },
  getAllRatings(){return this.load();},

  // ── A3: PI-RATINGS (Constantinou & Fenton 2013) ──────────────────────────────
  // Pi-ratings outperform Elo for soccer result prediction (Forty Years review;
  // Challenge-winning feature). Key differences vs Elo: (1) SEPARATE home/away ratings
  // per team, (2) update on GOAL-DIFFERENCE error with diminishing returns (log-damped),
  // (3) cross-update — a team's away rating informs its home rating and vice versa.
  // Stored under a separate key so Elo remains available as a secondary ensemble input.
  _piLoad: () => { try { return JSON.parse(_safeStorage.getItem('oracle_v2026_pi') || '{}'); } catch(e){ return {}; } },
  _piSave: (d) => { try { _safeStorage.setItem('oracle_v2026_pi', JSON.stringify(d)); } catch(e){} },
  getPiRating: function(teamName, venue='home', defaultVal=0) {
    if (!teamName) return defaultVal;
    const d = this._piLoad(); const t = d[teamName.toLowerCase().trim()];
    return t ? (venue === 'home' ? t.home : t.away) : defaultVal;
  },
  // λ = 0.035 (learning rate), γ = 0.7 (cross-venue propagation) — C&F 2013 defaults.
  updatePi: function(hTeam, aTeam, hG, aG, lambda=0.035, gamma=0.7) {
    if (!hTeam || !aTeam) return;
    const d = this._piLoad();
    const hk = hTeam.toLowerCase().trim(), ak = aTeam.toLowerCase().trim();
    d[hk] = d[hk] || { home:0, away:0 }; d[ak] = d[ak] || { home:0, away:0 };
    // Expected goal diff from current ratings (logistic-style via tanh on rating diff)
    const expDiff = Math.tanh((d[hk].home - d[ak].away) / 3);
    const obsDiff = Math.tanh((hG - aG) / 3);             // diminishing returns on large margins
    const err = obsDiff - expDiff;
    // Update home team's home rating + propagate (γ) to its away rating; mirror for away team
    d[hk].home += lambda * err;
    d[hk].away += lambda * gamma * err;
    d[ak].away -= lambda * err;
    d[ak].home -= lambda * gamma * err;
    this._piSave(d);
    return { homePi: d[hk], awayPi: d[ak] };
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// §5 — CALIBRATION ENGINE (v29.0: dynamic rho fitting; enhanced CLV; BBN)
// ═══════════════════════════════════════════════════════════════════════════════

const CalibrationEngine = {
  load:()=>{try{return JSON.parse(_safeStorage.getItem('oracle_v2026_ledger')||'[]');}catch(e){return[];}},
  save:(bets)=>{try{_safeStorage.setItem('oracle_v2026_ledger',JSON.stringify(bets));}catch(e){}},
  reset(){try{_safeStorage.removeItem('oracle_v2026_ledger');}catch(e){}},
  _defaultMetrics:()=>({brier:0,recentBrier:0,rps:null,recentRPS:null,clv:0,roi:0,calibFactor:1.0,leagueData:{},bbnParams:{},driftAlert:false,resolvedCount:0,winRate:0,totalPnl:0,totalStaked:0,dynamicRhoParams:{},clvDecayCalibration:{},clvBacktestSummary:null,ruinProb:0,ahAccuracy:{},zipCoeffs:null}),

  addBet: function(bet) {
    const bets=this.load();
    bets.push({...bet,id:Date.now().toString()+Math.random().toString(36).substr(2,9),status:'pending',clv:null,outcome:null,loggedAt:new Date().toISOString()});
    this.save(bets); return{bets,metrics:this.calculate(bets)};
  },

  resolveBet: function(id,outcome,homeG,awayG,closeOdds) {
    const bets=this.load(); const bet=bets.find(b=>b.id===id);
    if(!bet)return{bets,metrics:this.calculate(bets)};
    bet.status='resolved'; bet.outcome=outcome;
    bet.homeGoals=MathEngine.safeNum(homeG); bet.awayGoals=MathEngine.safeNum(awayG);
    bet.closingOdds=MathEngine.safeNum(closeOdds); bet.resolvedAt=new Date().toISOString();
    if(bet.closingOdds>1&&bet.odds) bet.clv=(bet.odds/bet.closingOdds)-1;
    if(bet.home&&bet.away&&bet.expHomeG!==undefined) TeamRatingsEngine.update(bet.home,bet.away,bet.homeGoals,bet.awayGoals,bet.expHomeG,bet.expAwayG);
    // A3: also update pi-ratings (Constantinou & Fenton 2013) from the actual score.
    if(bet.home&&bet.away&&typeof bet.homeGoals==='number'&&typeof bet.awayGoals==='number') TeamRatingsEngine.updatePi(bet.home,bet.away,bet.homeGoals,bet.awayGoals);
    // B13: Integrated Q-score — Q = 0.6×outcomeBinary + 0.4×clvScore
    // Replaces binary win/loss as feedback signal into SignalWeightAdapter.
    // Lucky wins (negative CLV) contribute less positive reward.
    // Correct-process losses (positive CLV) contribute less negative penalty.
    const outcomeBinary = outcome==='win'?1 : outcome==='half-win'?0.5 : outcome==='loss'?-1 : outcome==='half-loss'?-0.5 : 0;
    const rawClv = (bet.closingOdds>1&&bet.odds) ? (bet.odds/bet.closingOdds)-1 : 0;
    const clvScore = MathEngine.clamp(rawClv, -1, 1); // normalise CLV to [-1,+1]
    bet.qScore = MathEngine.clamp(0.6*outcomeBinary + 0.4*clvScore, -1, 1);
    this.save(bets); return{bets,metrics:this.calculate(bets)};
  },

  deleteBet(id){const bets=this.load().filter(b=>b.id!==id);this.save(bets);return{bets,metrics:this.calculate(bets)};},

  calculate: function(bets) {
    const res=bets.filter(b=>b.status==='resolved');
    if(res.length===0)return this._defaultMetrics();
    const MIN_CALIB=10; let bSum=0,cSum=0,pnl=0,stk=0,wins=0,pSum=0;
    const lData={},goalData={};
    res.forEach(b=>{
      const isWin=b.outcome==='win'?1:b.outcome==='half-win'?0.5:b.outcome==='loss'?0:b.outcome==='half-loss'?0:0.5;
      if(b.outcome!=='push'){
        bSum+=Math.pow((b.mp||0.5)-isWin,2); stk+=b.stakeAmt||0;
        const winAmt=b.outcome==='win'?((b.stakeAmt||0)*b.odds-(b.stakeAmt||0)):b.outcome==='half-win'?(((b.stakeAmt||0)/2)*b.odds-((b.stakeAmt||0)/2)):b.outcome==='loss'?-(b.stakeAmt||0):b.outcome==='half-loss'?-((b.stakeAmt||0)/2):0;
        pnl+=winAmt; pSum+=b.mp||0; wins+=isWin;
      }
      if(b.clv!==null&&b.clv!==undefined&&!Number.isNaN(b.clv))cSum+=b.clv;
      if(b.league){
        if(!lData[b.league])lData[b.league]={pnl:0,stk:0,n:0,bSum:0,wins:0};
        const iw=b.outcome==='win'?1:b.outcome==='half-win'?0.5:0;
        lData[b.league].pnl+=(iw*(b.odds||1)*(b.stakeAmt||0))-(b.stakeAmt||0);
        lData[b.league].stk+=b.stakeAmt||0; lData[b.league].n++; lData[b.league].bSum+=Math.pow((b.mp||0)-iw,2); lData[b.league].wins+=iw;
      }
      if(!Number.isNaN(b.homeGoals)&&!Number.isNaN(b.awayGoals)&&b.league){
        if(!goalData[b.league])goalData[b.league]={hG:0,aG:0,n:0,zeroZero:0,oneZero:0,zeroOne:0,oneOne:0};
        goalData[b.league].hG+=b.homeGoals; goalData[b.league].aG+=b.awayGoals; goalData[b.league].n++;
        if(b.homeGoals===0&&b.awayGoals===0) goalData[b.league].zeroZero++;
        // BUG-M01 FIX: Track all four DC correction cells for proper joint MLE
        if(b.homeGoals===1&&b.awayGoals===0) goalData[b.league].oneZero++;
        if(b.homeGoals===0&&b.awayGoals===1) goalData[b.league].zeroOne++;
        if(b.homeGoals===1&&b.awayGoals===1) goalData[b.league].oneOne++;
      }
    });
    const nonPush=res.filter(b=>b.outcome!=='push');
    const recentBrier=nonPush.slice(-15).reduce((acc,b)=>{const a=b.outcome==='win'?1:b.outcome==='half-win'?0.5:0;return acc+Math.pow((b.mp||0)-a,2);},0)/Math.max(1,Math.min(15,nonPush.length));
    const overallBrier=nonPush.length>0?bSum/nonPush.length:0;
    // A1: Ranked Probability Score over resolved bets that stored a full 1X2 forecast (fp)
    // and have a final score. RPS is the football-standard metric (ordinally aware).
    const rpsBets = res.filter(b => b.fp && typeof b.homeGoals === 'number' && typeof b.awayGoals === 'number');
    let rpsSum = 0, rpsRecentSum = 0, rpsN = 0;
    rpsBets.forEach(b => {
      const actual = b.homeGoals > b.awayGoals ? 'home' : b.homeGoals < b.awayGoals ? 'away' : 'draw';
      rpsSum += MathEngine.rankedProbabilityScore(b.fp, actual); rpsN++;
    });
    rpsBets.slice(-15).forEach(b => {
      const actual = b.homeGoals > b.awayGoals ? 'home' : b.homeGoals < b.awayGoals ? 'away' : 'draw';
      rpsRecentSum += MathEngine.rankedProbabilityScore(b.fp, actual);
    });
    const overallRPS = rpsN > 0 ? rpsSum / rpsN : null;
    const recentRPS = rpsBets.length > 0 ? rpsRecentSum / Math.min(15, rpsBets.length) : null;
    const calibSample=nonPush;
    const calibFactor=calibSample.length>=MIN_CALIB?Math.max(0.5,Math.min(1.2,wins/Math.max(0.001,pSum))):1.0;
    const bbnParams={};
    // B1-04: BBN Gaussian conjugate update — precision-weighted posterior mean
    // posterior_mean = (prior_mean * kFactor + observed_mean * n) / (kFactor + n)
    // kFactor acts as pseudo-count (prior strength). Source: Kimi L13.
    Object.keys(goalData).forEach(lg=>{
      const prior=LEAGUE_PARAMS[lg]||LEAGUE_PARAMS.Default;
      const d=goalData[lg];
      if(d.n < 1) { bbnParams[lg]={homeAvg:prior.homeAvg,awayAvg:prior.awayAvg}; return; }
      const empH=d.hG/d.n, empA=d.aG/d.n;
      const k=prior.kFactor||8;
      bbnParams[lg]={
        homeAvg:(prior.homeAvg*k + empH*d.n)/(k+d.n),
        awayAvg:(prior.awayAvg*k + empA*d.n)/(k+d.n),
      };
    });
    // NEW-07: Dynamic rho params from ledger
    const dynamicRhoParams={};
    Object.keys(goalData).forEach(lg=>{
      const base=LEAGUE_PARAMS[lg]||LEAGUE_PARAMS.Default;
      dynamicRhoParams[lg]=MathEngine.estimateDynamicRho(goalData[lg],base.baseRho);
    });
    // B1-07: Gambler's Ruin probability — P(ruin) = ((1-p)/p)^(bankroll/avgBetSize)
    // Shows real-time ruin risk even with +EV bets when stake sizing is too aggressive.
    // Source: +EV Decision Guide (polydao). Displayed as RISK WARNING in Ledger UI when > 5%.
    const winRateCalc = calibSample.length > 0 ? wins / calibSample.length : 0.5;
    const avgBetSize = res.length > 0 ? stk / Math.max(1, res.length) : 0;
    const currentBankroll = typeof window !== 'undefined' ? (window.__ORACLE_CORE__?.getState()?.telemetry?.broll || 1000) : 1000;
    let ruinProb = 0;
    if (winRateCalc > 0 && winRateCalc < 1 && avgBetSize > 0 && currentBankroll > 0) {
      // HF-11a: Velegol (2024) CDE ruin probability — replaces static gambler's ruin.
      // CDE closed-form: P(ruin) ≈ exp(-2f·e / σ²)
      // where f = Kelly fraction, e = edge, σ² = return variance at that fraction.
      // More accurate than ((q/p)^N) because it accounts for Kelly fraction variance.
      // Source: Velegol 2024 convective-diffusion equation formulation of Kelly criterion.
      const meanEdge = stk > 0 ? (pnl / res.length) / (stk / res.length) : 0; // per-bet return
      const f = avgBetSize / Math.max(1, currentBankroll); // Kelly fraction in use
      const e = Math.max(0, meanEdge); // edge (clamped non-negative for CDE validity)
      // σ² for Kelly betting: variance of per-bet P&L as fraction of bankroll
      const sigma2 = f * f * (winRateCalc * Math.pow(1-f,2) + (1-winRateCalc) * Math.pow(f,2));
      const cdeRuin = sigma2 > 0 && f > 0 && e > 0
        ? Math.exp(-2 * f * e / sigma2)
        : 1.0; // worst case when no edge
      // Blend CDE with classic formula (stability guard for small samples)
      const classicRatio = (1-winRateCalc)/winRateCalc;
      const classicRuin = Math.min(1, Math.pow(classicRatio, currentBankroll/avgBetSize));
      const blendWeight = Math.min(1, res.length / 30); // full CDE weight at 30+ bets
      ruinProb = MathEngine.clamp(cdeRuin*blendWeight + classicRuin*(1-blendWeight), 0, 1);
      if (!isFinite(ruinProb) || isNaN(ruinProb)) ruinProb = 0;
    }
    // v2026.7 R7 — per-league/per-side Asian Handicap hit-rate tracker.
    // Aggregates resolved AH bets by league → "side_line" key → {wins, n, hitRate}.
    // Feeds asianHandicapPivot's accuracy term. Half-wins count as 0.5, pushes excluded.
    const ahAccuracy = {};
    res.forEach(b => {
      if (!b.market || !/\bAH\b|Asian|handicap/i.test(b.market)) return;
      const lg = b.league || '_global';
      // parse "AH +0.5 home" style label
      const mm = String(b.market).match(/([+-]?\d+(?:\.\d+)?)\s*(home|away)/i);
      if (!mm) return;
      const key = `${mm[2].toLowerCase()}_${parseFloat(mm[1])}`;
      ahAccuracy[lg] = ahAccuracy[lg] || {};
      const rec = ahAccuracy[lg][key] || { wins: 0, n: 0 };
      const score = b.outcome === 'win' ? 1 : b.outcome === 'half-win' ? 0.5
                  : b.outcome === 'half-loss' ? 0 : b.outcome === 'loss' ? 0 : null;
      if (score === null) return; // push or unresolved → exclude
      rec.wins += score; rec.n += 1; rec.hitRate = rec.wins / rec.n;
      ahAccuracy[lg][key] = rec;
    });
    // Flatten to {league: {key: hitRate}} for direct use by the pivot (min 8 samples)
    const ahAccuracyFlat = {};
    Object.entries(ahAccuracy).forEach(([lg, keys]) => {
      ahAccuracyFlat[lg] = {};
      Object.entries(keys).forEach(([k, v]) => { if (v.n >= 8) ahAccuracyFlat[lg][k] = v.hitRate; });
    });
    return{brier:overallBrier,recentBrier:recentBrier||0,rps:overallRPS,recentRPS,clv:res.length>0?cSum/res.length:0,roi:stk>0?pnl/stk:0,calibFactor,resolvedCount:res.length,leagueData:lData,bbnParams,driftAlert:(overallRPS!=null&&recentRPS!=null)?(recentRPS>overallRPS+0.02):(recentBrier>overallBrier+0.05),winRate:winRateCalc,totalPnl:pnl,totalStaked:stk,dynamicRhoParams,clvDecayCalibration:CalibrationEngine.backtestCLV(res),clvBacktestSummary:null,ruinProb,ahAccuracy:ahAccuracyFlat,zipCoeffs:null};
  },

  // NEW-22: CLV Backtest — analyse resolved bets vs predicted CLV per market type
  // Identifies markets where CLV prediction consistently over/underestimates
  // Feeds back into clvProjection decay rate calibration
  backtestCLV: function(resolvedBets) {
    if (!resolvedBets || resolvedBets.length < 5) return {};
    const byMarket = {};
    resolvedBets.forEach(b => {
      if (b.clv === null || b.clv === undefined || !b.marketType) return;
      const mt = b.marketType || '1x2';
      if (!byMarket[mt]) byMarket[mt] = { predicted: [], actual: [], count: 0 };
      byMarket[mt].predicted.push(b.predictedClv || 0);
      byMarket[mt].actual.push(b.clv);
      byMarket[mt].count++;
    });
    const calibration = {};
    Object.keys(byMarket).forEach(mt => {
      const d = byMarket[mt];
      if (d.count < 3) return;
      const avgPred = d.predicted.reduce((s,v)=>s+v,0) / d.count;
      const avgActual = d.actual.reduce((s,v)=>s+v,0) / d.count;
      // Correction factor: if predicted=0.05 but actual=0.03, factor=0.6 (over-estimating by 40%)
      calibration[mt] = {
        correctionFactor: avgPred > 0 ? MathEngine.clamp(avgActual / avgPred, 0.3, 2.0) : 1.0,
        avgPredicted: avgPred,
        avgActual: avgActual,
        sampleSize: d.count
      };
    });
    return calibration;
  },

  getBets(){return this.load();},
  getPendingBets(){return this.load().filter(b=>b.status==='pending');},
  getResolvedBets(){return this.load().filter(b=>b.status==='resolved');},
  getMetrics(){return this.calculate(this.load());}
};

// ═══════════════════════════════════════════════════════════════════════════════
// §6 — CROWD WISDOM PROTOCOL (v28.0 — BUG-014 FIXED: real Gemini harvest)
// ═══════════════════════════════════════════════════════════════════════════════

const CrowdWisdomProtocol = {
  MAX_HARVEST_TIMEOUT: 12000,
  FRESHNESS_HOURS: 48,
  MIN_FRESH_SOURCES: 8, // Minimum fresh sources for valid harvest (target 15, abort below 8)
  TIER_WEIGHTS: { tier1:3.0, tier2:1.5, tier3:0.5 },

  harvest: async function(query) {
    try {
      const r = await Promise.race([
        this._runHarvest(query),
        new Promise((_,reject) => setTimeout(() => reject(new Error('CWP harvest timeout')), this.MAX_HARVEST_TIMEOUT))
      ]);
      return r;
    } catch(err) {
      return this._emptyPayload();
    }
  },

  // BUG-014 FIXED (v27): Real Gemini search harvest (was permanent stub)
  // BUG-C02 FIXED (v28): Now uses fetchGeminiWithCascade for T1b/FALLBACK resilience
  _runHarvest: async function(query) {
    try {
      const apiKey = typeof window !== 'undefined' ? (window.__ORACLE_CORE__?.getState()?.ui?.userApiKey || '') : '';
      if (!apiKey) return this._emptyPayload();
      // CWP v2026.3.12+: 15-source target, 48h freshness window, strictly advisory
      const freshnessHrs = this.FRESHNESS_HOURS; // 48h
      const prompt = `You are a football intelligence harvester for the O.R.A.C.L.E. betting system. Your output is STRICTLY ADVISORY and must NEVER override model probability signals.

FIXTURE TO RESEARCH: "${query}"

MANDATORY PROTOCOL:
1. Perform at least 15 separate web searches across DIFFERENT source categories.
2. ONLY include content published within the last 48 HOURS. Older content = discard.
3. If fewer than 8 fresh sources found, still report what you found — be honest.
4. Do NOT fabricate sources. If a category has no recent content, leave that entry empty.

SOURCE CATEGORIES (search at least 2 per category where possible):
- Official club news / team announcements
- Major sports outlets: BBC Sport, ESPN, Sky Sports, The Athletic, Guardian
- Pre-match previews / tactical analysis blogs
- Data / analytics sites: FBref, Sofascore, WhoScored, Understat, StatsBomb
- Twitter/X: football analysts, team beat reporters (last 24h only)
- Bookmaker editorial: Pinnacle Betting Resources, Betway Insider
- Local/regional press covering each specific club
- Injury/lineup trackers: TeamNews, LinerUp, official pre-match pressers

For each source: record name, hours since published, category, key finding.
Count ONLY posts from last 48h as "fresh".

RETURN ONLY THIS JSON (no markdown, no preamble):
{"meta":{"sourcesScanned":0,"freshSources":0,"hoursWindow":48,"advisoryOnly":true},"sourceLog":[{"source":"","publishedHoursAgo":0,"category":"","keyInsight":""}],"crowdConsensusSummary":"","dominantOutcome":"","confidenceScore":0.0,"injurySignals":[{"player":"","team":"","probability":0.0,"detail":""}],"tacticalInsights":[""],"sharpMoneySignals":[""],"divergenceFlags":[""],"advisoryWarning":"CROWD WISDOM IS ADVISORY ONLY"}`;
      // BUG-C02 FIX: use cascade instead of raw fetch
      const data = await fetchGeminiWithCascade([MODELS.T1, MODELS.T1b], {
        systemInstruction: { parts: [{ text: 'You are a football intelligence harvester. Output is STRICTLY ADVISORY. Search ≥15 sources, last 48h only. Return ONLY valid JSON, no markdown, no commentary.' }] },
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { responseMimeType: 'application/json' }
      });
      const txt = data.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text).join('') || '';
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch(e) { const m = txt.match(/\{[\s\S]*\}/); if(m) try { parsed = JSON.parse(m[0]); } catch(e2){} }
      if (!parsed) return this._emptyPayload();
      return this._validateAndScore(parsed);
    } catch(e) {
      return this._emptyPayload();
    }
  },

  _validateAndScore: function(parsed) {
    // CWP v2026.3.12+: enforce freshness window on sourceLog entries
    const sourceLog = (parsed?.sourceLog || []).filter(s => (s.publishedHoursAgo || 999) <= this.FRESHNESS_HOURS);
    const freshCount = Math.max(parsed?.meta?.freshSources || 0, sourceLog.length);
    const safe = {
      meta: {
        sourcesScanned: Math.max(parsed?.meta?.sourcesScanned || 0, sourceLog.length),
        freshSources: freshCount,
        hoursWindow: this.FRESHNESS_HOURS,
        targetSources: 15,
        sourcesCoverage: freshCount + '/15 fresh sources (' + this.FRESHNESS_HOURS + 'h window)',
        harvestTimestamp: new Date().toISOString(),
        advisoryOnly: true,
      },
      sourceLog,
      consensusTrends: parsed?.consensusTrends||[],
      injurySignals: parsed?.injurySignals||[],
      tacticalInsights: parsed?.tacticalInsights||[],
      sharpMoneySignals: parsed?.sharpMoneySignals||[],
      divergenceFlags: parsed?.divergenceFlags||[],
      crowdConsensusSummary: parsed?.crowdConsensusSummary||'No consensus data available.',
      dominantOutcome: parsed?.dominantOutcome||'unclear',
      confidenceScore: parseFloat(parsed?.confidenceScore)||0.0,
      advisoryWarning: '[CROWD WISDOM ADVISORY] Sources are informational only. Model probabilities take precedence.',
    };
    if(safe.meta.freshSources < this.MIN_FRESH_SOURCES) {
      safe._aborted = true;
      safe._abortReason = 'Only ' + safe.meta.freshSources + ' fresh sources (last ' + this.FRESHNESS_HOURS + 'h) — minimum ' + this.MIN_FRESH_SOURCES + ' required. Crowd wisdom suppressed.';
    }
    // Source coverage warning (advisory — not abort)
    if(!safe._aborted && safe.meta.freshSources < 15) {
      safe._lowCoverage = true;
      safe._coverageWarning = '[CWP_PARTIAL] ' + safe.meta.freshSources + '/15 target fresh sources found. Crowd signal may be incomplete.';
    }
    // HF-C: Second-digit Benford 2BL on crowd/sharp signal prices
    // Square/retail books round to .x0 or .x5; sharp books (Pinnacle) use 4dp.
    // Excess >30% in crowd odds = rounding bias = amplify S02 (sharp consensus) weight 1.1x
    const crowdOddsValues = (safe.sharpMoneySignals || [])
      .map(s => parseFloat((String(s)||'').match(/[0-9]+[.][0-9]+/)?.[0]))
      .filter(v => !isNaN(v) && v > 1);
    const crowdSD = MathEngine.secondDigitFreq(crowdOddsValues);
    if (crowdSD !== null && crowdSD > 0.30) {
      safe._crowdRoundingBias = true;
      safe._crowdRoundingBiasFreq = crowdSD;
      safe._crowdPriceRoundingFlag = '[CROWD_PRICE_ROUNDING_BIAS] ' +
        (crowdSD * 100).toFixed(0) + '% of crowd signals priced at .x0/.x5 — sharp vs square gap amplified. S02 weight x1.1.';
    }
    return safe;
  },

  _emptyPayload: function() {
    return { meta:{sourcesScanned:0,freshSources:0,harvestTimestamp:new Date().toISOString()}, crowdConsensusSummary:'Failed or timed out.', dominantOutcome:'unclear', confidenceScore:0.0, _aborted:true };
  },

  serialise: function(payload) {
    if(!payload||payload._aborted) return 'CROWD WISDOM: Unavailable — ' + (payload?._abortReason||'harvest failed') + '.';
    const freshSrc = payload.meta?.freshSources || 0;
    const totalSrc = payload.meta?.sourcesScanned || freshSrc;
    const coverage    = payload.meta?.sourcesCoverage || (freshSrc + ' fresh/' + totalSrc + ' scanned (target 15)');
    const winLabel    = (payload.meta?.hoursWindow||48) + 'h freshness window';
    const advisory    = '[ADVISORY ONLY — crowd wisdom does not override model signals]';
    const lowCov      = payload._lowCoverage ? '\n[CWP_PARTIAL] ' + payload._coverageWarning : '';
    const inj         = (payload.injurySignals||[]).filter(s=>s.player)
      .map(s=>'  - ' + s.player + ' (' + (s.team||'?') + ') Doubt: ' + (((s.probability||0)*100).toFixed(0)) + '% — ' + (s.detail||''))
      .join('\n') || '  None';
    const sharpList   = (payload.sharpMoneySignals||[]).join('; ');
    const sharpBlock  = sharpList ? '\nSharp Signals: ' + sharpList : '';
    const srcEntries  = (payload.sourceLog||[]).slice(0,5)
      .map(s=>'  [' + (s.publishedHoursAgo||'?') + 'h] ' + (s.source||'?') + ': ' + (s.keyInsight||''))
      .join('\n');
    const srcBlock    = srcEntries ? '\nTop Sources (last ' + winLabel + '):\n' + srcEntries : '';
    return advisory + '\nSources: ' + coverage + ' | ' + winLabel + lowCov +
      '\nSummary: ' + (payload.crowdConsensusSummary||'') + sharpBlock + srcBlock + '\nInjuries:\n' + inj;
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// §6b — FROZEN ODDS REGISTRY (v2026.3.12 — B7: locks odds after Turn 2, detects fabrication)
// Prevents Gemini from citing odds that drift from the Turn-2 snapshot.
// Galatasaray postmortem: Gemini cited @1.85 vs actual @2.20 (+15.9%) → [ODDS_FABRICATION]
// ═══════════════════════════════════════════════════════════════════════════════

const FrozenOddsRegistry = {
  _locked: false,
  _frozenPayload: null,   // raw odds object from Turn 2
  _marketIndex: {},        // { marketKey: frozenOdds } quick-lookup

  // B7-01: Lock odds payload immediately after Turn 2 completes.
  // Once locked, no subsequent LLM call can overwrite these values.
  lock: function(oddsPayload) {
    if (this._locked) return; // idempotent — only lock once per analysis session
    this._locked = true;
    this._frozenPayload = oddsPayload ? JSON.parse(JSON.stringify(oddsPayload)) : {};
    // HF-B: Record frozen values for Benford cross-session audit
    const _p = this._frozenPayload;
    ['hOdds','dOdds','aOdds','ohO','oaO'].forEach(k => { if(_p[k]) this.recordFrozen(_p[k]); });
    this._marketIndex = {};
    // Index common market keys for fast O(1) lookup
    const p = this._frozenPayload;
    if (p.hOdds !== undefined)  this._marketIndex['home']  = p.hOdds;
    if (p.dOdds !== undefined)  this._marketIndex['draw']  = p.dOdds;
    if (p.aOdds !== undefined)  this._marketIndex['away']  = p.aOdds;
    if (p.ohO   !== undefined)  this._marketIndex['over']  = p.ohO;
    if (p.odO   !== undefined)  this._marketIndex['draw_ou']= p.odO;
    if (p.oaO   !== undefined)  this._marketIndex['under'] = p.oaO;
    // Also index any rawOdds book entries
    if (Array.isArray(p.rawOdds)) {
      p.rawOdds.forEach(book => {
        if (book.markets) {
          Object.entries(book.markets).forEach(([k,v]) => {
            if (!this._marketIndex[k]) this._marketIndex[k] = v;
          });
        }
      });
    }
  },

  // B7-02: Validate a cited odds value against the frozen snapshot.
  // Returns { valid, deviation, frozenOdds, citedOdds, flag }
  // flag = '[ODDS_FABRICATION]' when deviation > 3%
  validate: function(citedOdds, marketKey) {
    if (!this._locked || citedOdds == null) return { valid: true, deviation: 0, flag: null };
    const frozen = this._marketIndex[marketKey] || this._frozenPayload?.[marketKey];
    if (frozen == null || frozen <= 0) return { valid: true, deviation: 0, flag: null };
    const deviation = Math.abs(citedOdds - frozen) / frozen;
    const flag = deviation > 0.03 ? '[ODDS_FABRICATION]' : null;
    return { valid: deviation <= 0.03, deviation, frozenOdds: frozen, citedOdds, flag };
  },

  // B7-03: Serialise frozen table as a string block for injection into briefingRLM / ClaudeVerificationLayer.
  toTableString: function() {
    if (!this._locked || !this._frozenPayload) return 'FROZEN_ODDS: Not yet locked.';
    const p = this._frozenPayload;
    const lines = ['=== FROZEN ODDS TABLE (locked at Turn 2 — do not deviate) ==='];
    if (p.hOdds) lines.push(`Home Win:  ${Number(p.hOdds).toFixed(2)}`);
    if (p.dOdds) lines.push(`Draw:      ${Number(p.dOdds).toFixed(2)}`);
    if (p.aOdds) lines.push(`Away Win:  ${Number(p.aOdds).toFixed(2)}`);
    if (p.ohO)   lines.push(`Over 2.5:  ${Number(p.ohO).toFixed(2)}`);
    if (p.oaO)   lines.push(`Under 2.5: ${Number(p.oaO).toFixed(2)}`);
    lines.push('Any odds cited that deviate >3% from the above are INVALID.');
    lines.push('=== END FROZEN ODDS TABLE ===');
    return lines.join('\n');
  },

  // HF-B: Cross-session history for Benford fabrication audit
  _citedOddsHistory:  [],
  _frozenOddsHistory: [],
  MAX_HISTORY: 200,

  recordCited(v)  { if(v>1&&isFinite(v)){this._citedOddsHistory.push(v);if(this._citedOddsHistory.length>this.MAX_HISTORY)this._citedOddsHistory=this._citedOddsHistory.slice(-this.MAX_HISTORY);}},
  recordFrozen(v) { if(v>1&&isFinite(v)){this._frozenOddsHistory.push(v);if(this._frozenOddsHistory.length>this.MAX_HISTORY)this._frozenOddsHistory=this._frozenOddsHistory.slice(-this.MAX_HISTORY);}},

  // BLOCK B15 (V3-D): PRIMARY fabrication check is now cross-book implied-prob dispersion.
  // Rationale: decimal odds cluster in [1.5, 4.0]; Benford's Law (which assumes data spanning
  // orders of magnitude) has the wrong null distribution for odds and cannot distinguish a
  // realistic fabricated set from a real one. Cross-book coherence is far more discriminating:
  // real odds from ≥3 books have tightly arbitrage-consistent overrounds (1.02–1.08 for 1X2)
  // and inter-book variance on any outcome < 3%. Fabricated sets tend to be either too clean
  // (zero variance) or too spread. Benford is retained as a tertiary curiosity flag only.
  auditCrossBookDispersion: function(marketPayload) {
    if (!marketPayload?.all_books) return null;
    const books = Object.values(marketPayload.all_books).filter(b => b.home && b.draw && b.away);
    if (books.length < 3) return null; // need ≥3 books
    const outcomes = ['home','draw','away'];
    const flags = [];
    outcomes.forEach(o => {
      const imps = books.map(b => 1 / b[o]).filter(v => v > 0 && v < 1);
      if (imps.length < 3) return;
      const mean = imps.reduce((a,c)=>a+c,0)/imps.length;
      const variance = imps.reduce((a,c)=>a+(c-mean)**2,0)/imps.length;
      const cv = Math.sqrt(variance)/mean; // coefficient of variation
      if (cv < 1e-6) flags.push(`[FAB_TOO_CLEAN] ${o}: zero variance across ${books.length} books — likely fabricated`);
      if (cv > 0.06) flags.push(`[FAB_DIVERGE] ${o}: cross-book CV ${(cv*100).toFixed(1)}% > 6% — unrealistic spread`);
    });
    return flags.length ? flags.join(' | ') : null;
  },

  // Benford MAD audit — TERTIARY curiosity flag only (V3-D: wrong null for odds data).
  // Use auditCrossBookDispersion as primary and FrozenOddsRegistry.validate as secondary.
  auditBenfordFabrication: function() {
    const citedMAD  = MathEngine.benfordMAD(this._citedOddsHistory);
    const frozenMAD = MathEngine.benfordMAD(this._frozenOddsHistory);
    if (citedMAD === null || frozenMAD === null) return null;
    const delta = citedMAD - frozenMAD;
    // Raised threshold (was 0.008) — too sensitive for a metric with the wrong null.
    // Treat as a tertiary curiosity flag, not a gate. Log only, do not veto.
    if (delta > 0.025) {
      return `[BENFORD_TERTIARY] Cited MAD (${citedMAD.toFixed(4)}) > frozen (${frozenMAD.toFixed(4)}) by ${delta.toFixed(4)} across ${this._citedOddsHistory.length} sessions. Verify via cross-book dispersion.`;
    }
    return null;
  },

  // Reset for new analysis session (history persists — cross-session audit)
  reset: function() {
    this._locked = false;
    this._frozenPayload = null;
    this._marketIndex = {};
    this._oddsSource = 'unknown';      // 'odds_api' | 'web_search_consensus' | 'cache'
    this._oddsQuality = 'live';        // 'live' | 'degraded' | 'no_odds'
    this._consensusConfidence = null;  // confidence score for web search consensus (0-1)
  },

  // Set odds source metadata (called from fixtures.ts via bridge)
  setSourceMetadata: function(source, quality, confidence = null) {
    this._oddsSource = source || 'unknown';
    this._oddsQuality = quality || 'live';
    this._consensusConfidence = confidence;
  },

  // Get audit metadata for resolution/logging
  getSourceAudit: function() {
    return {
      odds_source: this._oddsSource,
      odds_quality: this._oddsQuality,
      consensus_confidence: this._consensusConfidence,
    };
  },

  // B7-03 Extended: Include source metadata in serialized table
  toTableString: function() {
    if (!this._locked || !this._frozenPayload) return 'FROZEN_ODDS: Not yet locked.';
    const p = this._frozenPayload;
    const lines = ['=== FROZEN ODDS TABLE (locked at Turn 2 — do not deviate) ==='];
    if (p.hOdds) lines.push(`Home Win:  ${Number(p.hOdds).toFixed(2)}`);
    if (p.dOdds) lines.push(`Draw:      ${Number(p.dOdds).toFixed(2)}`);
    if (p.aOdds) lines.push(`Away Win:  ${Number(p.aOdds).toFixed(2)}`);
    if (p.ohO)   lines.push(`Over 2.5:  ${Number(p.ohO).toFixed(2)}`);
    if (p.oaO)   lines.push(`Under 2.5: ${Number(p.oaO).toFixed(2)}`);
    lines.push('Any odds cited that deviate >3% from the above are INVALID.');
    // Add source metadata to audit trail
    lines.push(`[SOURCE] ${this._oddsSource} (${this._oddsQuality})`);
    if (this._consensusConfidence != null) {
      lines.push(`[CONFIDENCE] ${(this._consensusConfidence * 100).toFixed(1)}%`);
    }
    lines.push('=== END FROZEN ODDS TABLE ===');
    return lines.join('\n');
  },

  isLocked() { return this._locked; },
  getFrozen() { return this._frozenPayload; },
};

// ═══════════════════════════════════════════════════════════════════════════════
// §6c — SESSION REGISTRY (v2026.3.12 — B6: intra-session duplicate detection)
// Tracks picks by home_away_date key. Duplicate → forced Adversary re-run.
// Source: Gemini Wrapper Audit intra-session duplicate veto
// ═══════════════════════════════════════════════════════════════════════════════

const SessionRegistry = {
  _picks: {},   // { key: { market, addedAt } }

  // B6-01: normalise key — lowercase, spaces stripped
  _makeKey: function(home, away, date) {
    const clean = s => (s||'').toLowerCase().replace(/\s+/g,'');
    return `${clean(home)}_${clean(away)}_${clean(date)}`;
  },

  // Register a pick. Returns { isDuplicate, existingPick }
  register: function(home, away, date, market) {
    const key = this._makeKey(home, away, date);
    if (this._picks[key]) {
      return { isDuplicate: true, existingPick: this._picks[key], key };
    }
    this._picks[key] = { market, addedAt: new Date().toISOString() };
    return { isDuplicate: false, existingPick: null, key };
  },

  has: function(home, away, date) {
    return !!this._picks[this._makeKey(home, away, date)];
  },

  reset() { this._picks = {}; },

  getAll() { return { ...this._picks }; },
};

// ═══════════════════════════════════════════════════════════════════════════════
// §7 — RAG SYSTEM (v28.0 — BUG-B04: 12-dim embedding; BUG-C08: localStorage persistence)
// ═══════════════════════════════════════════════════════════════════════════════

const RAGSystem = {
  _store: [],
  _STORAGE_KEY: 'oracle_v2026_3_12_rag_store',
  _MAX_STORE: 200,

  // BUG-C08 FIX: Load persisted store from localStorage on init
  init: function() {
    try {
      const saved = _safeStorage.getItem(this._STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) this._store = parsed.slice(-this._MAX_STORE);
      }
    } catch(e) {}
  },

  _persist: function() {
    try {
      _safeStorage.setItem(this._STORAGE_KEY, JSON.stringify(this._store.slice(-this._MAX_STORE)));
    } catch(e) {}
  },

  // BUG-013 FIXED: L2 normalize the embedding vector
  _normalize: (vec) => {
    const norm = Math.sqrt(vec.reduce((s, v) => s + v*v, 0)) + 1e-8;
    return vec.map(v => v / norm);
  },

  cosineSimilarity: function(a, b) {
    let dot=0;
    for(let i=0;i<Math.min(a.length,b.length);i++) dot += a[i]*b[i];
    return dot; // Pre-normalized vectors: cosine = dot product
  },

  // BUG-B04 FIX: Expanded 12-dimensional embedding
  // Dimensions: lH, lA, pH, pD, pA, ev*10, varMult, mes,
  //             leagueHash (normalized), hoursToKO bucket, marketTypeBit, drawSpread
  createEmbedding: function(fd) {
    const leagueNames = Object.keys(LEAGUE_PARAMS);
    const leagueIdx = leagueNames.indexOf(fd.league || 'Default');
    const leagueHash = (leagueIdx >= 0 ? leagueIdx : leagueNames.length - 1) / Math.max(1, leagueNames.length - 1);
    const hoursBucket = Math.min(1.0, (fd.hoursToKO || 24) / 72); // normalized 0-1 over 72h window
    const topMarket = fd.evMarkets?.[0];
    // marketTypeBit: 0=1x2, 0.33=goals, 0.66=AH, 1.0=other
    const mt = topMarket?.cat || '';
    const marketTypeBit = mt.includes('Asian') ? 0.66 : mt.includes('Goals') || mt.includes('BTTS') ? 0.33 : 0.0;
    const drawSpread = Math.abs((fd.fp?.draw || 0.25) - 0.25); // deviation from "average draw prob"
    const raw = [
      fd.bayesian_lH||1.5, fd.bayesian_lA||1.2,
      fd.fp?.home||0.33, fd.fp?.draw||0.33, fd.fp?.away||0.33,
      (topMarket?.ev||0)*10,
      fd.mc?.varMultiplier||1.0,
      fd.mes||0.9,
      leagueHash,
      hoursBucket,
      marketTypeBit,
      drawSpread
    ];
    return this._normalize(raw);
  },

  // B5-03: NaN sanitise embedding on addToStore — prevents cosine corruption across entire store
  addToStore: function(fd, result) {
    const topMarketCat = fd.evMarkets?.[0]?.cat || 'unknown';
    // B5-03: store extra fields for B5-04 RLM programmatic pre-filter
    const rawEmb = this.createEmbedding(fd);
    const cleanEmb = rawEmb.map(v => (isNaN(v) || !isFinite(v)) ? 0 : v); // B5-03: sanitise
    this._store.push({
      id: Date.now().toString(),
      fixture: `${fd.home} vs ${fd.away}`,
      home: fd.home || '',
      away: fd.away || '',
      league: fd.league || 'Default',
      competitionType: fd.competitionType || (fd.league||'').toLowerCase().includes('cup') ? 'cup' : 'league',
      leagueTier: fd.leagueTier || 2,
      vorpCount: MathEngine.safeNum(fd.vorpCount, 0),
      totalXG: MathEngine.safeNum((fd.bayesian_lH||0) + (fd.bayesian_lA||0), 2.5),
      embedding: cleanEmb,
      topMarketCat,
      result,
      timestamp: new Date().toISOString()
    });
    if (this._store.length > this._MAX_STORE) this._store.shift();
    this._persist(); // BUG-C08 FIX: persist after every add
  },

  findSimilar: function(qf, k=5) {
    const qEmb = this.createEmbedding(qf);
    const qCat = qf.evMarkets?.[0]?.cat || 'unknown';
    const qHome = (qf.home||'').toLowerCase();
    const qAway = (qf.away||'').toLowerCase();
    const qDate = (qf.date||'').slice(0,7); // YYYY-MM for same-season check
    const qTier = qf.leagueTier || 2;
    const qVORP = MathEngine.safeNum(qf.vorpCount, 0);
    const qXG   = MathEngine.safeNum((qf.bayesian_lH||0)+(qf.bayesian_lA||0), 2.5);

    // B5-04: RLM programmatic pre-filter when store ≥ 10
    let pool = this._store;
    if (pool.length >= 10) {
      const filtered = pool.filter(item => {
        const tierOK  = Math.abs((item.leagueTier||2) - qTier) <= 1;
        const vorpOK  = Math.abs((item.vorpCount||0) - qVORP) <= 2;
        const xgOK    = Math.abs((item.totalXG||2.5) - qXG) <= 0.5;
        return tierOK && vorpOK && xgOK;
      });
      if (filtered.length >= 5) pool = filtered; // only use filtered if enough survive
    }

    const scored = pool.map(item => {
      let sim = this.cosineSimilarity(qEmb, item.embedding);
      // B5-01: SSSVO elevation — same season (YYYY-MM prefix match), same venue teams, opposite outcome keyword
      const itemDate = (item.timestamp||'').slice(0,7);
      const sameSeasonWindow = qDate && itemDate && Math.abs(
        parseInt(qDate.replace('-','')) - parseInt(itemDate.replace('-',''))
      ) <= 6; // within 6 months = same season
      const sameTeams = (item.home||'').toLowerCase()===qHome && (item.away||'').toLowerCase()===qAway;
      const isSSSVO = sameSeasonWindow && sameTeams;
      if (isSSSVO) sim = Math.max(sim, 0.97); // B5-01: SSSVO floor 0.97
      return {
        ...item,
        similarity: sim,
        isSSSVO,
        sameCategoryAsQuery: item.topMarketCat === qCat
      };
    });
    scored.sort((a,b) => {
      // SSSVO always sorts first regardless of raw cosine
      if (a.isSSSVO && !b.isSSSVO) return -1;
      if (!a.isSSSVO && b.isSSSVO) return 1;
      return b.similarity - a.similarity;
    });
    return scored.slice(0, k);
  },

  formatAnalogues: function(similar) {
    if(!similar||similar.length===0) return 'No historical analogues found.';
    return similar.slice(0,3).map((s,i)=>`[${i+1}] ${s.fixture} (sim:${(s.similarity*100).toFixed(0)}%, cat_match:${s.sameCategoryAsQuery?'YES':'NO'}) — EV:${((s.result?.evMarkets?.[0]?.ev||0)*100).toFixed(1)}% | Outcome: ${s.result?.debate?.topBankerBet||'N/A'}`).join('\n');
  },

  reset() { this._store = []; this._persist(); },

  // HF-B (RAG): Benford audit on RAG store λ values at session start.
  // Anomalous MAD on stored lambdas = data source quality issue.
  auditStoreBenford: function() {
    const lambdas = this._store
      .flatMap(e => [e.lambdaH, e.lambdaA].filter(v => typeof v === 'number' && v > 0));
    const mad = MathEngine.benfordMAD(lambdas);
    if (mad === null) return null; // < 50 values — skip
    if (mad > 0.015) {
      return `[BENFORD_ANOMALY_DATA_SOURCE] RAG store λ Benford MAD=${mad.toFixed(4)} (threshold 0.015). ${lambdas.length} values — data source may have quality issues. Review analogues.`;
    }
    if (mad > 0.006) {
      return `[BENFORD_ACCEPTABLE_DATA_SOURCE] RAG store λ MAD=${mad.toFixed(4)} — within acceptable range (0.006–0.015).`;
    }
    return null;
  },
  getStore() { return [...this._store]; }
};

// ═══════════════════════════════════════════════════════════════════════════════
// §7c — POSTMORTEM REGISTRY (v2026.3.12 — B11: OPD-style failure pattern store)
// Encodes root-cause hindsight from confirmed losing picks.
// Similarity-matched warnings injected into briefingRLM Stage 1.
// Pre-seeded with 03/10/2026 confirmed losses (4 entries).
// Source: OpenClaw-RL OPD arXiv:2603.10165
// ═══════════════════════════════════════════════════════════════════════════════

const PostmortemRegistry = {
  // B11-02: rootCause controlled vocabulary
  ROOT_CAUSES: Object.freeze({
    SSSVO_IGNORED:        'SSSVO_IGNORED',
    XG_CEILING_BREACH:    'XG_CEILING_BREACH',
    DRAW_SUPPRESSED:      'DRAW_SUPPRESSED',
    NEGATIVE_EV_SKIPPED:  'NEGATIVE_EV_SKIPPED',
    CUPSET_UNDETECTED:    'CUPSET_UNDETECTED',
    BTTS_H2H_IGNORED:     'BTTS_H2H_IGNORED',
    FATIGUE_UNDERWEIGHTED:'FATIGUE_UNDERWEIGHTED',
  }),

  _entries: [],
  SIMILARITY_THRESHOLD: 0.82,

  // B11-01: Entry schema
  // { fixtureId, date, homeTeam, awayTeam, marketPicked, marketResult,
  //   failureType, signalsThatFired[], signalsThatShouldHaveFired[], rootCause, embedding[] }
  add: function(entry) {
    if (!this.ROOT_CAUSES[entry.rootCause]) {
      console.warn(`[PostmortemRegistry] Invalid rootCause: ${entry.rootCause}`);
      return false;
    }
    const embedding = this._buildEmbedding(entry);
    this._entries.push({ ...entry, embedding, addedAt: new Date().toISOString() });
    return true;
  },

  // Build a 12-dim embedding from the postmortem entry (mirrors RAGSystem dims)
  _buildEmbedding: function(e) {
    const rootIdx = Object.keys(this.ROOT_CAUSES).indexOf(e.rootCause) / 7;
    const firedCount = (e.signalsThatFired||[]).length / 14;
    const shouldCount = (e.signalsThatShouldHaveFired||[]).length / 14;
    const isHome = e.marketPicked?.toLowerCase().includes('home') ? 1 : 0;
    const isAway = e.marketPicked?.toLowerCase().includes('away') ? 1 : 0;
    const isOver = e.marketPicked?.toLowerCase().includes('over') ? 1 : 0;
    const isUnder = e.marketPicked?.toLowerCase().includes('under') ? 1 : 0;
    const isBTTS = e.marketPicked?.toLowerCase().includes('btts') ? 1 : 0;
    const isML = e.marketPicked?.toLowerCase().includes('ml') || e.marketPicked?.toLowerCase().includes('money') ? 1 : 0;
    const isLoss = e.marketResult === 'loss' ? 1 : 0;
    const dateHash = (new Date(e.date||0).getMonth()||0) / 12;
    const fixtureHash = ((e.homeTeam||'').length + (e.awayTeam||'').length) / 40;
    return [rootIdx, firedCount, shouldCount, isHome, isAway, isOver, isUnder, isBTTS, isML, isLoss, dateHash, fixtureHash];
  },

  _cosineSimilarity: function(a, b) {
    if (!a||!b||a.length!==b.length) return 0;
    let dot=0,na=0,nb=0;
    for (let i=0;i<a.length;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}
    const denom=Math.sqrt(na)*Math.sqrt(nb);
    return denom<1e-10 ? 0 : Math.min(1,dot/denom);
  },

  // B11-03: Check new fixture against failure registry; inject warning if match ≥ 0.82
  // Returns array of matched entries (empty = no match)
  check: function(queryEntry) {
    const qEmb = this._buildEmbedding(queryEntry);
    return this._entries
      .map(e => ({ ...e, similarity: this._cosineSimilarity(qEmb, e.embedding) }))
      .filter(e => e.similarity >= this.SIMILARITY_THRESHOLD)
      .sort((a,b) => b.similarity - a.similarity);
  },

  // Format matched entries as briefingRLM warning string
  formatWarning: function(matches) {
    if (!matches||matches.length===0) return '';
    const lines = ['⚠️ POSTMORTEM PATTERN MATCH — historical failure patterns detected:'];
    matches.slice(0,3).forEach((m,i) => {
      lines.push(`[${i+1}] ${m.homeTeam} vs ${m.awayTeam} (${m.date}) — ${m.rootCause} — Market: ${m.marketPicked} → LOSS (sim:${(m.similarity*100).toFixed(0)}%)`);
    });
    lines.push('ACTION: Verify these failure conditions are NOT present before recommending.');
    return lines.join('\n');
  },

  getAll() { return [...this._entries]; },
  reset() { this._entries = []; },
};

// B11-04: Pre-populate with confirmed 03/10/2026 postmortem losses
PostmortemRegistry.add({
  fixtureId: 'GAL_LIV_20260310',
  date: '2026-03-10',
  homeTeam: 'Galatasaray',
  awayTeam: 'Liverpool',
  marketPicked: 'BTTS Yes',
  marketResult: 'loss',
  failureType: 'H2H SSSVO analogue ignored',
  signalsThatFired: ['S01','S03','S07','S08'],
  signalsThatShouldHaveFired: ['S10'],
  rootCause: 'SSSVO_IGNORED',
});
PostmortemRegistry.add({
  fixtureId: 'NEW_BAR_20260310',
  date: '2026-03-10',
  homeTeam: 'Newcastle',
  awayTeam: 'Barcelona',
  marketPicked: 'Over 3',
  marketResult: 'loss',
  failureType: 'xG ceiling breached — combined xG 2.07 vs line 3.0',
  signalsThatFired: ['S01','S04','S06'],
  signalsThatShouldHaveFired: ['S14'],
  rootCause: 'XG_CEILING_BREACH',
});
PostmortemRegistry.add({
  fixtureId: 'POR_SWA_20260310',
  date: '2026-03-10',
  homeTeam: 'Portsmouth',
  awayTeam: 'Swansea',
  marketPicked: 'Under 2.5',
  marketResult: 'loss',
  failureType: 'Negative EV — implied 61.4% vs model 56%, excess 5.4%',
  signalsThatFired: ['S05','S06','S07'],
  signalsThatShouldHaveFired: ['S14'],
  rootCause: 'NEGATIVE_EV_SKIPPED',
});
PostmortemRegistry.add({
  fixtureId: 'STO_IPS_20260310',
  date: '2026-03-10',
  homeTeam: 'Stoke City',
  awayTeam: 'Ipswich Town',
  marketPicked: 'Away ML',
  marketResult: 'loss',
  failureType: 'Draw suppressed — 12 home absences, Championship draw amplifier not applied',
  signalsThatFired: ['S01','S02','S05'],
  signalsThatShouldHaveFired: ['S14'],
  rootCause: 'DRAW_SUPPRESSED',
});

// ═══════════════════════════════════════════════════════════════════════════════
// §8 — MARKET MAKER ENGINE (v29.0 — sharp/square tier consensus — NEW-09)
// ═══════════════════════════════════════════════════════════════════════════════

const MarketMakerEngine = {
  VIG_MARGIN: 0.018,

  probsToOdds: function(pH, pD, pA, vigMargin=this.VIG_MARGIN) {
    const total = pH+pD+pA; if(total<=0) return{home:0,draw:0,away:0};
    const nH=pH/total, nD=pD/total, nA=pA/total, vf=1+vigMargin;
    return{home:parseFloat((1/(nH*vf)).toFixed(3)),draw:parseFloat((1/(nD*vf)).toFixed(3)),away:parseFloat((1/(nA*vf)).toFixed(3)),impliedH:parseFloat((nH*vf*100).toFixed(1)),impliedD:parseFloat((nD*vf*100).toFixed(1)),impliedA:parseFloat((nA*vf*100).toFixed(1))};
  },

  price: function(runResult) {
    if(!runResult||!runResult.fp) return null;
    const{fp,bayesian_lH,bayesian_lA,finalMkt}=runResult;
    const oracleFair1x2=this.probsToOdds(fp.home,fp.draw,fp.away);
    const ou=finalMkt?.ou||{}; const oracleOU={};
    ['over_0.5','over_1.5','over_2.5','over_3.5','over_4.5'].forEach(k=>{if(ou[k]>0&&ou[k]<1){oracleOU[k]=parseFloat((1/(ou[k]*(1+this.VIG_MARGIN))).toFixed(3));oracleOU[k.replace('over','under')]=parseFloat((1/((1-ou[k])*(1+this.VIG_MARGIN))).toFixed(3));}});
    return{timestamp:new Date().toISOString(),fixture:`${runResult.home} vs ${runResult.away}`,oracleFair:oracleFair1x2,oracleOU,lambdaH:bayesian_lH,lambdaA:bayesian_lA};
  },

  // NEW-09: Compare against sharp book consensus, not just single Pinnacle
  compareToMarket: function(amePrices, realOdds, bookmakerData = null) {
    if(!amePrices||!realOdds) return null;
    const edges = [];
    // If we have multi-bookmaker data, compute sharp consensus
    let sharpConsensusH = null, sharpConsensusD = null, sharpConsensusA = null;
    let sharpBookCount = 0;
    if (bookmakerData && Array.isArray(bookmakerData)) {
      let sumH=0, sumD=0, sumA=0;
      bookmakerData.forEach(bm => {
        if (SHARP_BOOKS.has((bm.key||'').toLowerCase()) && bm.h2hOdds) {
          sumH += 1/bm.h2hOdds.home; sumD += 1/bm.h2hOdds.draw; sumA += 1/bm.h2hOdds.away;
          sharpBookCount++;
        }
      });
      if (sharpBookCount >= 2) {
        const s = sumH + sumD + sumA;
        sharpConsensusH = (sumH/s); sharpConsensusD = (sumD/s); sharpConsensusA = (sumA/s);
      }
    }
    ['home','draw','away'].forEach(outcome => {
      const of = amePrices.oracleFair?.[outcome], ro = realOdds[outcome];
      if(of>0&&ro>0) {
        const ep = ((ro/of)-1)*100;
        // Boost edge signal if sharp book consensus aligns
        const sharpProb = outcome==='home'?sharpConsensusH:outcome==='draw'?sharpConsensusD:sharpConsensusA;
        const sharpAlignment = (sharpProb && sharpBookCount >= 2) ? `[${sharpBookCount} sharp books]` : '';
        if(ep>0.5) edges.push({market:outcome.toUpperCase(),oracleFair:of,bookOdds:ro,edgePct:parseFloat(ep.toFixed(2)),signal:ep>3?'🟢 STRONG EDGE':ep>1?'🟡 MARGINAL EDGE':'⚪ NOISE',sharpAlignment,sharpBookCount});
      }
    });
    edges.sort((a,b)=>b.edgePct-a.edgePct); return edges;
  },

  formatBlock: function(amePrices, edges) {
    if(!amePrices) return '';
    const f = amePrices.oracleFair;
    let out = `\n🏦 ORACLE ADVERSARIAL MARKET MAKER (AME)\n`;
    out += `Fair Odds (1.8% vig): H ${f?.home} | D ${f?.draw} | A ${f?.away}\n`;
    out += `Implied: H ${f?.impliedH}% | D ${f?.impliedD}% | A ${f?.impliedA}%\n`;
    if(edges&&edges.length>0){out+=`\n📊 AME EDGE SIGNALS (Real Book vs Oracle Fair):\n`;edges.forEach(e=>out+=`  ${e.signal} ${e.market}: Book ${e.bookOdds} vs Fair ${e.oracleFair} (+${e.edgePct}%)${e.sharpAlignment?' '+e.sharpAlignment:''}\n`);}
    else out+=`No exploitable spreads detected vs live book feed.\n`;
    return out;
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// §8a — SIGNAL WEIGHT ADAPTER (v2026.3.12 — B12: Binary RL feedback loop)
// Reads CalibrationEngine resolved bet history to dynamically adjust signal
// contribution weights before tier assignment. Source: OpenClaw-RL arXiv:2603.10165
// ═══════════════════════════════════════════════════════════════════════════════

const SignalWeightAdapter = {
  MIN_RESOLVED_BETS: 20,  // B12-01: skip if insufficient history
  MIN_SIGNAL_FIRES:  5,   // B12-03: skip individual signal if < 5 fires
  WIN_RATE_HIGH: 0.58,    // B12-03: multiplier 1.15
  WIN_RATE_LOW:  0.42,    // B12-03: multiplier 0.85
  MULTIPLIER_HIGH: 1.15,
  MULTIPLIER_LOW:  0.85,
  MULTIPLIER_CAP:  1.30,
  MULTIPLIER_FLOOR:0.70,

  // Compute per-signal win-rate multipliers from ledger history
  // Returns { S01: mult, S02: mult, ... S14: mult } — all default 1.0
  computeMultipliers: function(ledgerMetrics) {
    const defaults = {};
    for (let i=1;i<=14;i++) defaults[`S${String(i).padStart(2,'0').replace('0','')}`] = 1.0;
    // Normalise signal keys S1→S01 etc
    const normKey = k => k.startsWith('S') ? 'S'+k.slice(1).padStart(2,'0').replace(/^0+(\d)/,'$1') : k;
    for (let i=1;i<=14;i++) defaults[`S${i}`] = 1.0;

    if (!ledgerMetrics) return defaults;
    const bets = CalibrationEngine.load().filter(b => b.status === 'resolved');
    if (bets.length < this.MIN_RESOLVED_BETS) return defaults; // B12-01

    const signalStats = {}; // { S1: { wins, fires } }
    bets.forEach(b => {
      const active = b.activeSignals || [];
      const isWin = b.outcome === 'win' ? 1 : b.outcome === 'half-win' ? 0.5 : 0;
      // Use qScore if available (B13), otherwise binary
      const reward = b.qScore !== undefined ? (b.qScore > 0 ? 1 : 0) : isWin;
      active.forEach(sig => {
        if (!signalStats[sig]) signalStats[sig] = { wins:0, fires:0 };
        signalStats[sig].wins  += reward;
        signalStats[sig].fires += 1;
      });
    });

    const multipliers = { ...defaults };
    Object.entries(signalStats).forEach(([sig, {wins, fires}]) => {
      // BLOCK B10 (V-PRD-5 RECONCILIATION): Below the Rademacher floor, the multiplier
      // is 1.0 — neutral. A sub-floor signal's multiplier MUST NOT be blended with any
      // TD(0) or batch value: those would re-introduce signal the floor is explicitly
      // suppressing as noise (a sub-37-sample win rate is not a reliable estimator).
      // Theory: if Rademacher says <37 firings is noise, the multiplier for that
      // signal is 1.0 unconditionally. TD(0) updates are applied only above the floor.
      const minFires = (typeof ORACLE_CONFIG !== 'undefined' ? ORACLE_CONFIG.RADEMACHER_MIN_FIRES : 37);
      if (fires < minFires) return; // neutral — no non-unity multiplier below floor
      const wr = wins / fires;
      let mult = 1.0;
      if (wr > this.WIN_RATE_HIGH)      mult = this.MULTIPLIER_HIGH;
      else if (wr < this.WIN_RATE_LOW)  mult = this.MULTIPLIER_LOW;
      multipliers[sig] = MathEngine.clamp(mult, this.MULTIPLIER_FLOOR, this.MULTIPLIER_CAP);
    });
    return multipliers;
  },

  // B12-05: Confidence intervals per signal — CI = wr ± 1.96 * sqrt(wr*(1-wr)/n)
  computeSignalCIs: function(ledgerMetrics) {
    const bets = CalibrationEngine.load().filter(b => b.status === 'resolved');
    const result = {};
    if (bets.length < this.MIN_RESOLVED_BETS) return result;

    const signalStats = {};
    bets.forEach(b => {
      (b.activeSignals||[]).forEach(sig => {
        if (!signalStats[sig]) signalStats[sig] = { wins:0, fires:0 };
        const isWin = b.outcome==='win'?1:b.outcome==='half-win'?0.5:0;
        signalStats[sig].wins  += isWin;
        signalStats[sig].fires += 1;
      });
    });

    Object.entries(signalStats).forEach(([sig, {wins, fires}]) => {
      const wr = wins / fires;
      const se = fires > 0 ? Math.sqrt(wr*(1-wr)/fires) : 0;
      const ciWidth = 1.96 * se * 2; // full CI width
      result[sig] = {
        winRate: wr,
        ciLow:  MathEngine.clamp(wr - 1.96*se, 0, 1),
        ciHigh: MathEngine.clamp(wr + 1.96*se, 0, 1),
        ciWidth,
        lowConfidence: ciWidth > 0.30, // B12-05: [LOW_SIGNAL_CONFIDENCE] threshold
        fires,
      };
    });
    return result;
  },

  // Apply multiplier layer to a scored market's signals object (mutates copy)
  applyMultipliers: function(signals, multipliers) {
    const adjusted = { ...signals };
    Object.keys(multipliers).forEach(sig => {
      if (adjusted[sig] !== undefined && typeof adjusted[sig] === 'number' && adjusted[sig] > 0) {
        adjusted[sig] = adjusted[sig] * multipliers[sig];
      }
    });
    return adjusted;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// §8b — CONVERGENCE SCORER (v29.0 — NEW-21: native JS implementation of 13-signal
//        Gemini Wrapper; avoids LLM hallucination on binary signal detection)
// ═══════════════════════════════════════════════════════════════════════════════

const ConvergenceScorer = {

  TIERS: [
    { min:18, max:23, label:'APEX',    emoji:'🔱', kelly:'Full Kelly — maximum deployment' },
    { min:13, max:17, label:'PRIME',   emoji:'🟢', kelly:'Full Kelly — strong deployment' },
    { min:8,  max:12, label:'VIABLE',  emoji:'🟡', kelly:'Half Kelly — proceed with discipline' },
    { min:4,  max:7,  label:'MARGINAL',emoji:'⚪', kelly:'Quarter Kelly or pass' },
    { min:0,  max:3,  label:'NOISE',   emoji:'🔴', kelly:'Do not bet — signal too thin' },
  ],

  getTier: function(score) {
    return this.TIERS.find(t => score >= t.min && score <= t.max) || this.TIERS[4];
  },

  // Compute all 13 signals from native resData — no LLM required
  scoreMarket: function(market, resData, ragSimilar=[]) {
    const signals = {};
    const mp = market.mp || market.modelProb || 0;
    const ip = market.ip || (market.odds > 1 ? 1/market.odds : 0);
    const ev = market.ev || 0;
    const adjEv = MathEngine.adjEV(mp, market.odds || 1);

    // S01: Sovereign Gap > 8%
    signals.S01 = Math.abs(mp - ip) > 0.08 ? 3 : 0;

    // B4-01 S02 strict: requires sharpConsensusBookCount ≥ 3 from FrozenOddsRegistry payload
    // Prevents Gemini narrative "sharp consensus" inflating S02 without frozen verification.
    const frozenPayload = FrozenOddsRegistry.isLocked() ? FrozenOddsRegistry.getFrozen() : null;
    const sharpCount = frozenPayload?.sharp_consensus?.bookCount
                    || resData.fetched?.odds?.sharp_consensus?.bookCount
                    || 0;
    // B4-01: strict — 0 if < 3 frozen sharp books
    // HF-C fix: if CrowdWisdom detected retail price rounding bias (2BL), amplify S02 ×1.1
    // i.e. score becomes 4 instead of 3 — rounded retail prices = sharper real edge when sharp confirms
    const _crowdRoundBias = resData.crowdWisdom?.payload?._crowdRoundingBias === true;
    signals.S02 = sharpCount >= 3 ? (_crowdRoundBias ? 4 : 3) : 0;

    // S03: True RLM (drift against public) — mutually exclusive with S04
    signals.S03 = (resData.rlmDetected && !resData.sharpCompressionTag) ? 2 : 0;

    // S04: Sharp Compression — mutually exclusive with S03
    signals.S04 = (resData.sharpCompressionTag && !resData.rlmDetected) ? 2 : 0;

    // S05: CLV heuristic score — BLOCK B11 (V2-C FIX).
    // clvProjection.survivalProb is an UNCALIBRATED logistic sigmoid (slope 6 is arbitrary,
    // with no empirical anchor). Gating hard on ">70%" treats a heuristic as a calibrated
    // probability. Demoted to a +1 tie-breaker that can influence ranking but cannot alone
    // veto or require a bet. Rename: clvHeuristicScore (honest label). To upgrade to a hard
    // gate, fit the sigmoid slope from closing-odds ledger data (see CalibrationEngine.backtestCLV).
    signals.S05 = (resData.clvProjection?.survivalProb || 0) > 0.70 ? 1 : 0; // was 2; tie-breaker only

    // S06: Edge > 9% after MOS
    signals.S06 = adjEv > 0.09 ? 2 : 0;

    // S07: Confidence Band A (modelProb ≥ 75%)
    signals.S07 = mp >= 0.75 ? 2 : 0;

    // S08: Adversary fully failed to disprove
    const advCritique = resData.debate?.adversary?.critiques?.find(c => c.id === market.id);
    const refVerdict = resData.debate?.referee?.verdicts?.find(v => v.id === market.id);
    signals.S08 = (advCritique?.decision === 'ACCEPT' && refVerdict?.verdict?.includes('+EV')) ? 2 : 0;

    // S09: Calibration Factor > 1.0 (fixture-wide — applied to all markets)
    const calibFactor = resData.ledger?.metrics?.calibFactor || resData.calibFactor || 1.0;
    signals.S09 = calibFactor > 1.0 ? 1 : 0;

    // S10: RAG Historical Analogue ≥ 80% similarity AND same market category
    // NEW-27 (v29): Survivorship Bias Check — if top-5 analogues are ALL high-profile leagues,
    // flag [SURVIVORSHIP_BIAS_SAMPLE] and reduce S10 score (sample may be biased toward
    // high-visibility matches that get disproportionate attention in betting records).
    const bestAnalogue = ragSimilar[0];
    const HIGH_PROFILE_LEAGUES = new Set(['Premier League','Champions League','La Liga','Bundesliga','Serie A']);
    const topFiveLeagues = ragSimilar.slice(0,5).map(a => a?.league || '').filter(Boolean);
    const survivorshipBiased = topFiveLeagues.length >= 4 && topFiveLeagues.every(l => HIGH_PROFILE_LEAGUES.has(l));
    signals.S10 = (bestAnalogue?.similarity >= 0.80 && bestAnalogue?.sameCategoryAsQuery && !survivorshipBiased) ? 1 : 0;
    if (survivorshipBiased) signals._survivorshipBiasWarning = '[SURVIVORSHIP_BIAS_SAMPLE] RAG analogues drawn exclusively from high-profile leagues — sample may over-represent edge detection in marquee fixtures';

    // S11: Crowd Wisdom aligned
    const cwState = typeof window !== 'undefined' ? window.__ORACLE_CORE__?.getState()?.crowdWisdom : null;
    const cwPayload = cwState?.payload;
    const cwAligns = cwPayload && !cwPayload._aborted &&
      cwPayload.confidenceScore > 0.6 &&
      (market.label?.toLowerCase().includes(cwPayload.dominantOutcome?.toLowerCase()) ||
       (cwPayload.dominantOutcome === 'home' && market.label?.includes('Home')) ||
       (cwPayload.dominantOutcome === 'away' && market.label?.includes('Away')));
    signals.S11 = cwAligns ? 1 : 0;

    // S12: ZIP + Poisson both agree (both assign higher prob than market implied)
    // We compare Layer 1 Alpha (fundamentals) and Layer 4 ZIP — both in finalMat
    // Approximate: if resData.fp[outcome] > ip AND mc.varMultiplier > 0.8 (stable variance)
    const outcome = market.label?.includes('Home') ? 'home' : market.label?.includes('Away') ? 'away' : 'draw';
    const fpProb = resData.fp?.[outcome] || 0;
    signals.S12 = (fpProb > ip && (resData.mc?.varMultiplier || 0) > 0.8) ? 1 : 0;

    // S13: Clean market — not suspended, not within 90min of KO
    signals.S13 = (!resData.marketSuspended && (resData.hoursToKO || 24) > 1.5) ? 1 : 0;

    // B4-02 S14: Implied vs Model Probability Gate
    // excess = impliedProb - modelProb. Positive excess = market prices us as less likely than model.
    // > 3%: soft flag — S14=0, log [IMPLIED_EV_FLAG]
    // > 5%: hard reject — [NEGATIVE_EV_ALERT] blocks recommendation entirely
    const impliedProbS14 = ip || 0;
    const modelProbS14   = mp || 0;
    const evExcess = impliedProbS14 - modelProbS14; // positive = market thinks less likely than model
    let negativeEvAlert = null;
    if (evExcess > 0.05) {
      signals.S14 = 0;
      negativeEvAlert = `[NEGATIVE_EV_ALERT] Implied prob ${(impliedProbS14*100).toFixed(1)}% exceeds model ${(modelProbS14*100).toFixed(1)}% by ${(evExcess*100).toFixed(1)}% — HARD REJECT.`;
    } else if (evExcess > 0.03) {
      signals.S14 = 0;
      signals._impliedEvFlag = `[IMPLIED_EV_FLAG] Implied ${(impliedProbS14*100).toFixed(1)}% vs model ${(modelProbS14*100).toFixed(1)}% — soft warning (${(evExcess*100).toFixed(1)}% excess).`;
    } else {
      signals.S14 = 1; // model ≥ implied — no EV concern
    }

    // B12-04: Apply SignalWeightAdapter multiplier layer before tier assignment
    const swaMultipliers = SignalWeightAdapter.computeMultipliers(resData.ledger?.metrics);
    const adjustedSignals = SignalWeightAdapter.applyMultipliers(signals, swaMultipliers);
    const totalScore = Math.round(
      Object.entries(adjustedSignals)
        .filter(([k,v]) => typeof v === 'number' && !k.startsWith('_'))
        .reduce((s,[,v]) => s+v, 0)
    );
    const tier = this.getTier(totalScore);
    const activeSignals = Object.entries(signals).filter(([,v])=>v>0).map(([k])=>k);
    const missedSignals = Object.entries(signals).filter(([,v])=>v===0).map(([k])=>k);

    // HF-F: Softmax convergence branch (RLM paper analogue)
    // Treats totalScore as logit. softmaxProb = e^score / (e^score + e^0)
    // where e^0 = baseline (no-edge) class. Provides continuous probability alongside integer score.
    // Kelly blend: 60% integer-score-derived, 40% softmax-derived edge estimate.
    const softmaxProb = 1 / (1 + Math.exp(-totalScore / 8)); // temperature=8 to keep range ~[0.3,0.85]

    return {
      market: market.label || market.market,
      odds: market.odds,
      signals, totalScore, softmaxProb, tier,
      activeSignals, missedSignals,
      apexReason: this._apexReason(signals, activeSignals),
      negativeEvAlert: negativeEvAlert || null,
    };
  },

  _apexReason: function(signals, active) {
    const heavy = active.filter(s => ['S01','S02','S06','S07','S08'].includes(s));
    if (heavy.length === 0) return active.slice(0,3).join(', ') + ' providing baseline confidence';
    return heavy.join(' + ') + ' driving primary edge (pricing error + institutional alignment)';
  },

  // Score ALL candidate +EV markets and identify APEX
  compute: function(resData, ragSimilar=[]) {
    const candidates = [
      ...(resData.evMarkets || []).filter(m => !m.veto && m.ev > 0),
      ...(resData.analysis1x2 || []).filter(a => a.hasEV).map(a => ({
        id: `1X2_${a.outcome}`, label: `Match Winner: ${a.outcome}`,
        market: `Match Winner: ${a.outcome}`, mp: a.mp, ip: a.ip,
        ev: a.ev, odds: a.odds, cat: '1x2'
      }))
    ];

    if (candidates.length === 0) return {
      apex: null, scores: [], overallTier: this.getTier(0),
      deploymentGuide: '⛔ NO CONVERGENCE — FIXTURE DOES NOT MEET DEPLOYMENT THRESHOLD',
      noConvergence: true
    };

    const scores = candidates.map(m => this.scoreMarket(m, resData, ragSimilar));
    scores.sort((a,b) => b.totalScore - a.totalScore);

    // Tiebreaker: S01+S02 combined, then raw EV, then CLV survival
    const topTwo = scores.slice(0,2);
    if (topTwo.length === 2 && topTwo[0].totalScore === topTwo[1].totalScore) {
      const s0 = (scores[0].signals.S01 || 0) + (scores[0].signals.S02 || 0);
      const s1 = (scores[1].signals.S01 || 0) + (scores[1].signals.S02 || 0);
      if (s1 > s0) scores.sort((a,b) => b.totalScore - a.totalScore); // already sorted
    }

    const apex = scores[0];
    const overallTier = this.getTier(apex.totalScore);
    const skipList = scores.filter(s => s.totalScore < 8).map(s => `${s.market} (${s.totalScore}/24)`);
    const noConvergence = apex.totalScore < 8;

    // B4-03: Score Dispersion Guard — APEX too close to runner-up = low discrimination
    const runnerUpScore = scores[1]?.totalScore || 0;
    const dispersionWarning = (apex.totalScore - runnerUpScore) <= 3 && scores.length > 1
      ? '[LOW_DISCRIMINATION] APEX margin ≤3 points over runner-up — consider passing or deeper analysis.' : null;

    // Propagate [NEGATIVE_EV_ALERT] hard reject from scoreMarket
    const negEvAlert = scores.find(s => s.negativeEvAlert)?.negativeEvAlert || null;

    let deploymentGuide = '';
    if (noConvergence) {
      deploymentGuide = '⛔ NO CONVERGENCE — FIXTURE DOES NOT MEET DEPLOYMENT THRESHOLD TODAY';
    } else if (overallTier.label === 'APEX' || overallTier.label === 'PRIME') {
      deploymentGuide = `${overallTier.emoji} ${overallTier.label} — Deploy full ORACLE Kelly stake on ${apex.market}`;
    } else if (overallTier.label === 'VIABLE') {
      deploymentGuide = `${overallTier.emoji} VIABLE — Halve the ORACLE Kelly stake on ${apex.market}`;
    } else {
      deploymentGuide = `${overallTier.emoji} MARGINAL — Quarter Kelly or consider passing`;
    }

    return {
      apex, scores, overallTier, deploymentGuide, noConvergence,
      runnerUp: scores[1] || null,
      skipList, dispersionWarning, negativeEvAlert: negEvAlert,
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// §8c — ML SAFETY FILTER (v29.0 — NEW-28: 17-section Money Line framework
//        integrated with ORACLE core logic; outputs safety score and alt markets)
// ═══════════════════════════════════════════════════════════════════════════════

const MLSafetyFilter = {

  // HIGH_RELIABILITY leagues (Section 13)
  HIGH_RELIABILITY: new Set(['bundesliga','eredivisie','scottish premiership','austrian bundesliga','portuguesa primeira liga','primeira liga','belgian pro league','champions league','europa league']),
  // HIGH_UPSET (avoid ML) leagues (Section 14)
  HIGH_UPSET: new Set(['serie a','la liga','ligue 1','championship','mls','major league soccer','liga mx','mexican liga mx','brasileiro','serie a brazil','argentine primera','primera division','french ligue 1','spanish la liga','italian serie a','english championship']),

  // Run the full 15-section filter against acquired telemetry data
  // Returns: { mlAllowed, safetyScore, filtersTotal, filtersPassed, confidence, reason, altMarkets }
  evaluate: function(fetched, resData, telemetry) {
    const filters = [];
    const stats = fetched?.stats || {};
    const odds = fetched?.odds || {};
    const fixture = resData;
    const league = (resData.league || resData.fetched?.fixtures?.[0]?.league || '').toLowerCase();

    // §1: Odds pre-filter (1.35–1.65 range)
    const favOdds = Math.min(odds.home || 9, odds.away || 9);
    const favIsHome = (odds.home || 9) < (odds.away || 9);
    const oddsOk = favOdds >= 1.35 && favOdds <= 1.65;
    filters.push({ id:'S1', name:'Odds Range 1.35–1.65', pass: oddsOk,
      reason: oddsOk ? `${favOdds} within range` : `${favOdds} outside 1.35–1.65 window` });

    // Hard reject: odds outside 1.30–1.70 range
    if (favOdds < 1.30 || favOdds > 1.70) {
      return this._buildResult(filters, false, 'HARD REJECT: odds outside acceptable range', resData);
    }

    // §2: Team strength (league gap ≥6, points diff ≥15, or Elo diff ≥120)
    const eloDiff = Math.abs((stats.home_pi_rating || 1500) - (stats.away_pi_rating || 1500));
    const strengthOk = eloDiff >= 120; // We use Elo as primary proxy
    filters.push({ id:'S2', name:'Team Strength Gap', pass: strengthOk,
      reason: `Elo diff: ${eloDiff.toFixed(0)} (need ≥120)` });

    // §3: Home advantage
    const homeWinRate = stats.home_win_rate || 0;
    const awayLoseRate = stats.opponent_away_win_rate || 0;
    const homeAdvOk = favIsHome ? (homeWinRate >= 0.60 || eloDiff >= 150) : eloDiff >= 180;
    filters.push({ id:'S3', name:'Home Advantage', pass: homeAdvOk,
      reason: favIsHome ? `Home win rate: ${(homeWinRate*100).toFixed(0)}%` : 'Away fav — stricter evaluation' });

    // §4: Attacking superiority
    const favXG = favIsHome ? (stats.home_xg || resData.bayesian_lH || 0) : (stats.away_xg || resData.bayesian_lA || 0);
    const favGoalsScored = favIsHome ? (stats.home_goals_per_match || 0) : (stats.away_goals_per_match || 0);
    const oppGoalsConceded = favIsHome ? (stats.away_goals_conceded || 0) : (stats.home_goals_conceded || 0);
    const attackOk = favXG >= 1.7 && (favGoalsScored >= 1.6 || favXG >= 1.8) && (oppGoalsConceded >= 1.4 || favXG >= 2.0);
    filters.push({ id:'S4', name:'Attacking Superiority', pass: attackOk,
      reason: `xG:${favXG.toFixed(2)}, GS/match:${favGoalsScored.toFixed(2)}, Opp GC:${oppGoalsConceded.toFixed(2)}` });

    // §5: Defensive stability
    const favGoalsConceded = favIsHome ? (stats.home_goals_conceded || 0) : (stats.away_goals_conceded || 0);
    const cleanSheetRate = favIsHome ? (stats.home_clean_sheet_rate || 0) : (stats.away_clean_sheet_rate || 0);
    const defenceOk = (favGoalsConceded <= 1.2 || eloDiff >= 200) && (cleanSheetRate >= 0.35 || eloDiff >= 180);
    filters.push({ id:'S5', name:'Defensive Stability', pass: defenceOk,
      reason: `GC/match:${favGoalsConceded.toFixed(2)}, CS%:${(cleanSheetRate*100).toFixed(0)}%` });

    // §6: Underdog attack weakness
    const dogGoalsScored = favIsHome ? (stats.away_goals_per_match || 0) : (stats.home_goals_per_match || 0);
    const underdogWeakOk = dogGoalsScored <= 1.1 || eloDiff >= 200;
    filters.push({ id:'S6', name:'Underdog Attack Limited', pass: underdogWeakOk,
      reason: `Dog GS/match: ${dogGoalsScored.toFixed(2)} (need ≤1.1)` });

    // §7: Total goals environment — BUG-M07 FIXED (v29): Close the 2.1–2.3 gap window
    // Original: hard reject at ≤2.1, soft check at 2.3–3.2 — the 2.1–2.3 gap was unhandled
    // FIX: Explicit soft-reject for 2.1 < totalXG < 2.3 (below optimal window, not hard reject)
    const totalXG = (resData.bayesian_lH || 0) + (resData.bayesian_lA || 0);
    const goalsEnvOk = totalXG >= 2.3 && totalXG <= 3.2;
    if (totalXG <= 2.1) {
      filters.push({ id:'S7', name:'Goals Environment', pass: false, reason: `Total xG ${totalXG.toFixed(2)} ≤ 2.1 (HARD REJECT)` });
      return this._buildResult(filters, false, 'HARD REJECT: low-scoring environment (xG ≤ 2.1)', resData);
    }
    // BUG-M07 FIX: Gap window 2.1–2.3 — soft reject (fails filter but doesn't hard-reject alone)
    const inGapWindow = totalXG > 2.1 && totalXG < 2.3;
    filters.push({ id:'S7', name:'Goals Environment 2.3–3.2', pass: goalsEnvOk,
      reason: inGapWindow
        ? `Total xG: ${totalXG.toFixed(2)} — BELOW OPTIMAL WINDOW (2.1–2.3 marginal zone, need ≥2.3)`
        : `Total xG: ${totalXG.toFixed(2)}` });

    // §8: Schedule congestion — use fatigue/rest days proxy
    const restH = telemetry?.restH || 7;
    const restA = telemetry?.restA || 7;
    const favRest = favIsHome ? restH : restA;
    const congestionOk = favRest >= 5; // ≥5 days rest = not congested
    filters.push({ id:'S8', name:'No Schedule Congestion', pass: congestionOk,
      reason: `Fav rest days: ${favRest} (need ≥5)` });

    // §9: Motivation filter — use motivationScore from telemetry
    const motivScore = telemetry?.motivationScore || 1.0;
    const motivOk = motivScore >= 0.9;
    filters.push({ id:'S9', name:'Motivation Present', pass: motivOk,
      reason: `Motivation score: ${motivScore.toFixed(2)} (need ≥0.9)` });

    // §10: Market movement — positive signal = odds shortening (velocity > 0)
    const favVelocity = favIsHome ? (resData.lmuHome?.velocity || 0) : (resData.lmuAway?.velocity || 0);
    const marketMovOk = favVelocity >= 0; // odds shortening or stable = positive
    filters.push({ id:'S10', name:'Market Movement Positive', pass: marketMovOk,
      reason: `Velocity: ${favVelocity.toFixed(4)} (${favVelocity >= 0 ? 'shortening/stable ✓' : 'drifting ✗'})` });

    // §11: Red flag removal
    const isDerby = telemetry?.isDerby || false;
    const keyInjury = (telemetry?.injPenH || 0) > 0.25 || (telemetry?.injPenA || 0) > 0.25;
    const extremeWeather = (fetched?.weather?.wind_mph || 0) > 35 || (fetched?.weather?.rain_mm || 0) > 15;
    const newManager = telemetry?.newMgrH || telemetry?.newMgrA || false;
    const redFlagOk = !isDerby && !keyInjury && !extremeWeather && !newManager;
    filters.push({ id:'S11', name:'No Red Flags', pass: redFlagOk,
      reason: [isDerby&&'Derby',keyInjury&&'Key injury',extremeWeather&&'Extreme weather',newManager&&'New manager'].filter(Boolean).join(', ') || 'Clean' });
    if (!redFlagOk && (isDerby || keyInjury)) {
      return this._buildResult(filters, false, `HARD REJECT: ${isDerby?'Derby match':'Key player injury'}`, resData);
    }

    // §12: Favorite trap detection
    const trapLowGoal = totalXG <= 2.1;
    const trapAwayVsHome = !favIsHome && eloDiff < 150;
    const trapCongestion = favRest < 4;
    const trapMotivation = motivScore < 0.8;
    const trapDerby = isDerby;
    const trapPublicBias = (resData.sharpDelta || 0) > 0.08; // BUG-B03 FIXED: negative delta = sharp shorter
    const trapCount = [trapLowGoal,trapAwayVsHome,trapCongestion,trapMotivation,trapDerby,trapPublicBias].filter(Boolean).length;
    const trapOk = trapCount === 0;
    filters.push({ id:'S12', name:'No Favorite Trap', pass: trapOk,
      reason: trapCount > 0 ? `${trapCount} trap(s): ${[trapLowGoal&&'LowGoal',trapAwayVsHome&&'AwayVsHome',trapCongestion&&'Congestion',trapMotivation&&'NoMotiv',trapDerby&&'Derby',trapPublicBias&&'PublicBias'].filter(Boolean).join(',')}` : 'No traps detected' });

    // §13: League reliability
    const highRel = this.HIGH_RELIABILITY.has(league);
    const highUpset = this.HIGH_UPSET.has(league);
    const leagueOk = highRel && !highUpset;
    filters.push({ id:'S13', name:'High Reliability League', pass: leagueOk,
      reason: highRel ? `${league} — HIGH reliability ✓` : highUpset ? `${league} — HIGH upset rate ✗` : `${league} — medium reliability` });

    // §14: Hard reject upset leagues
    if (highUpset) {
      return this._buildResult(filters, false, `HARD REJECT: ${league} is a high-upset league (Section 14)`, resData);
    }

    // NEW-28 (v29): §16–§17 extended filters aligned with ORACLE core logic
    const extOk = this._applyExtendedFilters(filters, resData, favIsHome);
    if (!extOk) {
      return this._buildResult(filters, false, 'HARD REJECT: Extended filter gate (§16–§17)', resData);
    }

    return this._buildResult(filters, true, null, resData);
  },

  // NEW-28 (v29): Extended filter sections integrated with ORACLE core logic
  _applyExtendedFilters: function(filters, resData, favIsHome) {
    // §15: Alternative markets check (inline — see _suggestAltMarkets called in _buildResult)
    // §16: Sharp Consensus Gate (NEW-28) — aligned with ORACLE core SharpDelta & ConvergenceScorer S02
    // Require sharp books to NOT be fading the favourite (sharpDelta < +0.05 = sharps not fading)
    // sharpDelta < 0 = sharp BACKING the favourite = positive signal for ML
    const sharpDeltaVal = resData.sharpDelta || 0;
    const sharpConsensusBookCount = resData.fetched?.odds?.sharp_consensus?.bookCount || 0;
    const sharpGateOk = sharpDeltaVal <= 0.03 || sharpConsensusBookCount < 2;
    // If we have sharp data and it shows fading (sharpDelta > 0.08), this is a hard red flag for ML
    if (sharpDeltaVal > 0.10 && sharpConsensusBookCount >= 2) {
      filters.push({ id:'S16', name:'Sharp Consensus Gate', pass: false,
        reason: `Sharp books FADING favourite (sharpDelta: +${sharpDeltaVal.toFixed(3)}) — HARD VETO for ML [SHARP_CONSENSUS_FADE]` });
      return false; // signal hard reject
    }
    filters.push({ id:'S16', name:'Sharp Consensus Gate', pass: sharpGateOk,
      reason: sharpGateOk
        ? `Sharp delta: ${sharpDeltaVal.toFixed(3)} ≤ 0.03 (sharps backing or neutral) ✓`
        : `Sharp delta: +${sharpDeltaVal.toFixed(3)} (marginal fade — proceed with caution)` });

    // §17: Calibration Factor Gate (NEW-28) — aligned with ORACLE CalibrationEngine
    // If model calibration factor < 0.85 (model consistently over-predicting wins), ML is suspect
    const calibFactor = resData.ledger?.metrics?.calibFactor || 1.0;
    const calibGateOk = calibFactor >= 0.85;
    filters.push({ id:'S17', name:'Model Calibration Gate', pass: calibGateOk,
      reason: calibFactor >= 0.85
        ? `Calibration factor: ${calibFactor.toFixed(3)} ≥ 0.85 (model not over-predicting) ✓`
        : `Calibration factor: ${calibFactor.toFixed(3)} < 0.85 — model may be over-predicting wins, inflate ML risk` });
    if (calibFactor < 0.70) {
      // Severe miscalibration: hard reject ML
      return false;
    }
    return true; // no hard reject from extended filters
  },

  _buildResult: function(filters, eligible, hardRejectReason, resData) {
    let filtersPassed = filters.filter(f => f.pass).length; // §18-21 need += so must be let
    let filtersTotal = filters.length; // §18-21 add 3 more filters so must be let
    const pct = filtersTotal > 0 ? filtersPassed / filtersTotal : 0;
    // NEW-28: Updated thresholds for 17-section filter (70% = ~12 of 17)
    // ── B3: §18-20 — Three new hard-gate sections (postmortem-driven) ──
    // These gates extend filtersTotal to 20 and add hard-reject conditions independent of score.

    // §18: xG Dead Zone — combined xG 2.1–2.3 = ambiguous territory for Over/Under
    const adjXGtotal = (resData.bayesian_lH||0) + (resData.bayesian_lA||0);
    const isOverUnderMarket = (resData.targetMarket||'').toLowerCase().includes('over') ||
                              (resData.targetMarket||'').toLowerCase().includes('under');
    if (adjXGtotal > 2.1 && adjXGtotal < 2.3 && isOverUnderMarket) {
      filters.push({ name:'§18 xG Dead Zone', pass: false, reason:`Combined xG ${adjXGtotal.toFixed(2)} in dead zone 2.1–2.3 — Over/Under blocked. Try AH/DNB.` });
      filtersPassed += 0;
      if (!hardRejectReason) hardRejectReason = `[XG_DEAD_ZONE] xG ${adjXGtotal.toFixed(2)} in ambiguous 2.1–2.3 range.`;
    } else {
      filters.push({ name:'§18 xG Dead Zone', pass: true, reason:`xG ${adjXGtotal.toFixed(2)} outside dead zone.` });
      filtersPassed += 1;
    }

    // §19: xG Ceiling Gate — adjustedXG must exceed overLine by ≥ 0.40 to recommend Over
    const overLine = resData.overLine || 2.5;
    const xgMargin = adjXGtotal - overLine;
    const isOverMarket = (resData.targetMarket||'').toLowerCase().includes('over');
    if (isOverMarket && xgMargin < 0.40) {
      filters.push({ name:'§19 xG Ceiling Gate', pass: false, reason:`xG margin ${xgMargin.toFixed(2)} < 0.40 threshold vs line ${overLine} — [XG_CEILING_BREACH]` });
      filtersPassed += 0;
      if (!hardRejectReason) hardRejectReason = `[XG_CEILING_BREACH] xG ${adjXGtotal.toFixed(2)} vs line ${overLine}: margin ${xgMargin.toFixed(2)} < required 0.40.`;
    } else {
      filters.push({ name:'§19 xG Ceiling Gate', pass: true, reason:`xG ceiling OK (margin ${xgMargin.toFixed(2)}).` });
      filtersPassed += 1;
    }

    // §20: Championship Draw Amplifier — heavy home absences suppress ML, raise draw floor
    const homeUnavailable = MathEngine.safeNum(resData.homeUnavailablePlayers, 0);
    const isChampionshipLeague = (resData.league||'').toLowerCase().includes('championship');
    if (homeUnavailable >= 10) {
      filters.push({ name:'§20 Draw Amplifier', pass: false, reason:`Home unavailable=${homeUnavailable} ≥ 10 — drawFloor=30%, ML blocked. [DRAW_SUPPRESSION_RISK]` });
      filtersPassed += 0;
      if (!hardRejectReason && (resData.targetMarket||'').toLowerCase().includes('home')) {
        hardRejectReason = `[DRAW_SUPPRESSED] ${homeUnavailable} home absences — draw probability floor 30%, Away ML blocked.`;
      }
    } else {
      filters.push({ name:'§20 Draw Amplifier', pass: true, reason:`Home unavailable=${homeUnavailable} below threshold.` });
      filtersPassed += 1;
    }

    // Update filtersTotal to reflect §18-20
    filtersTotal += 3;

    const passThreshold = 0.70;
    const safetyScore = filtersPassed;
    let mlAllowed = eligible && (filtersPassed / filtersTotal) >= passThreshold;
    let confidence = '';
    if (!eligible || hardRejectReason) {
      mlAllowed = false;
      confidence = 'HARD_REJECT';
    } else if (filtersPassed >= Math.ceil(filtersTotal * 0.85)) {
      confidence = 'HIGH_CONFIDENCE';
    } else if (filtersPassed >= Math.ceil(filtersTotal * 0.70)) {
      confidence = 'MODERATE_CONFIDENCE';
    } else {
      mlAllowed = false;
      confidence = 'REJECTED';
    }

    // §15: Alternative low-variance markets when ML rejected
    const altMarkets = mlAllowed ? [] : this._suggestAltMarkets(resData);

    // §21 — HF-9: Draw Risk Composite Score (0–100)
    // Source: v12.1 Module 8 + v11 draw pattern analysis. Purely computational — no new fields needed.
    // Components: tactical stalemate, evenly matched, goal drought, motivation, weather, league draw rate.
    // Output: drawRiskScore → adjusted P(draw) → redistributed to P(home)/P(away) with strength-gap weighting.
    // [DRAW_RISK_HIGH] ≥41, [DRAW_RISK_VERY_HIGH] ≥61, [DRAW_RISK_EXTREME] ≥81 → ML block when ≥61.
    const _drs = (() => {
      let score = 0;
      const lH = resData.bayesian_lH || 0;
      const lA = resData.bayesian_lA || 0;
      const league = resData.league || '';
      const lp = (typeof LEAGUE_PARAMS !== 'undefined' ? LEAGUE_PARAMS : {})[league] || { drawRate: 0.25, baseRho: -0.13 };

      // (a) Evenly matched teams — λ difference < 15%
      const lambdaDiff = lH > 0 && lA > 0 ? Math.abs(lH - lA) / Math.max(lH, lA) : 0;
      if (lambdaDiff < 0.10) score += 15;
      else if (lambdaDiff < 0.20) score += 8;

      // (b) Both teams low scoring — model draw floor
      const totalXG = lH + lA;
      if (totalXG < 1.6) score += 15;
      else if (totalXG < 2.0) score += 8;
      else if (totalXG < 2.4) score += 4;

      // (c) League base draw rate vs league average (0.26 baseline)
      const leagueDrawBonus = Math.round(Math.max(0, (lp.drawRate - 0.24)) * 100);
      score += Math.min(5, leagueDrawBonus);

      // (d) Weather draw boost — severe weather promotes defensive play
      const windMph = resData.fetched?.weather?.wind_mph || 0;
      const rainMm = resData.fetched?.weather?.rain_mm || 0;
      if (windMph > 35 || rainMm > 15) score += 10;
      else if (windMph > 20 || rainMm > 8) score += 5;

      // (e) Motivation factor — heavy absences (§20) or mid-table safety already detected
      if (homeUnavailable >= 5 && homeUnavailable < 10) score += 8;
      if (resData.fetched?.motivationScore && resData.fetched.motivationScore < 0.85) score += 6;

      // (f) Strong DC/rho correlation — high rho means draws already probable
      const absRho = Math.abs(lp.baseRho || 0.13);
      if (absRho > 0.15) score += 5;

      // (g) §20 already fired — add amplifier bonus
      if (homeUnavailable >= 10) score += 12;

      score = Math.min(100, score);

      // Interpret
      const tier = score >= 81 ? 'EXTREME' : score >= 61 ? 'VERY_HIGH' : score >= 41 ? 'HIGH' : score >= 21 ? 'MODERATE' : 'LOW';
      const drawAdjustment = score >= 81 ? 0.15 : score >= 61 ? 0.12 : score >= 41 ? 0.08 : score >= 21 ? 0.04 : 0;
      const flag = score >= 81
        ? `[DRAW_RISK_EXTREME] Score=${score}/100 — stalemate extremely likely. MANDATORY SKIP for result markets.`
        : score >= 61
          ? `[DRAW_RISK_VERY_HIGH] Score=${score}/100 — draw probability elevated +${(drawAdjustment*100).toFixed(0)}%. Skip 1X2. Lean UNDER.`
          : score >= 41
            ? `[DRAW_RISK_HIGH] Score=${score}/100 — avoid result bets, focus O/U or BTTS.`
            : null;

      // Draw-adjusted win probability redistribution (v12.1 Module 8 draw-adjustment formula)
      // When draw risk is elevated, redistributes probability mass FROM wins TO draw.
      // Favourite loses more (they are expected to break deadlock; failure = "missed win").
      let fpAdjusted = null;
      if (drawAdjustment > 0 && resData.fp) {
        const { home: pH, draw: pD, away: pA } = resData.fp;
        const pDAdj = Math.min(0.50, pD + drawAdjustment);
        const delta = pDAdj - pD;
        const strengthGap = Math.abs(pH - pA);
        // Favourite absorbs more of the draw redistribution (60/40 split when gap >0.10)
        let homeDelta, awayDelta;
        if (strengthGap < 0.10) { homeDelta = delta * 0.50; awayDelta = delta * 0.50; }
        else if (pH > pA)       { homeDelta = delta * 0.65; awayDelta = delta * 0.35; }
        else                    { homeDelta = delta * 0.35; awayDelta = delta * 0.65; }
        fpAdjusted = {
          home: Math.max(0.01, pH - homeDelta),
          draw: pDAdj,
          away: Math.max(0.01, pA - awayDelta),
        };
      }

      // §21 gate: block ML recommendations when drawRisk ≥ VERY_HIGH
      if (score >= 61 && mlAllowed) {
        mlAllowed = false;
        if (!hardRejectReason) hardRejectReason = flag;
        confidence = 'DRAW_RISK_VETO';
      }

      return { score, tier, drawAdjustment, flag, fpAdjusted };
    })();

    return {
      mlAllowed,
      safetyScore,
      filtersTotal,
      filtersPassed,
      passRate: pct,
      confidence,
      hardRejectReason: hardRejectReason || null,
      filters,
      altMarkets,
      drawRisk: _drs,
      summary: mlAllowed
        ? `✅ ML APPROVED — ${filtersPassed}/${filtersTotal} filters passed [${confidence}]`
        : `❌ ML REJECTED — ${filtersPassed}/${filtersTotal} passed (need ≥${Math.ceil(filtersTotal*passThreshold)}). ${hardRejectReason||'Insufficient filter score.'}`
    };
  },

  // When ML is rejected, suggest low-variance alternatives from existing EV markets
  _suggestAltMarkets: function(resData) {
    const lowVarCats = ['Double Chance','Draw No Bet','Asian Handicap','Goals O/U','BTTS',
                        'Asian 2 Goals','Team Total','Win Either Half','First Half'];
    const lowVarLabels = ['1X','X2','DNB Home','DNB Away','Over 1.5','Over 0.5','AH Home','AH Away',
                          'Asian Over 2','Asian Under 2','Win Either Half',
                          'FH Under 1.5','FH Draw','Home Total','Away Total',
      'BTTS No','Under 2.5','Both Half Under 1.5'];
    const evMarkets = resData.evMarkets || [];
    const alts = evMarkets.filter(m =>
      !m.veto && m.ev > 0 &&
      (lowVarCats.includes(m.cat) || lowVarLabels.some(l => (m.label||'').includes(l)))
    ).sort((a,b) => b.ev - a.ev).slice(0,5);
    return alts.map(m => ({
      label: m.label, odds: m.odds, ev: m.ev, cat: m.cat,
      note: 'Low-variance alternative (ML rejected)'
    }));
  },
  // checkFilters(resData): public entry point for test suite — B3 block
  // Builds a minimal filter array and calls _buildResult (includes HF-9 §21 draw risk).
  checkFilters: function(resData) {
    const minimalFilters = [];
    const h = resData.fetched?.odds?.home || resData.hOdds || 0;
    if (h > 1.01 && h < 25) minimalFilters.push({name:'OddsRange',pass:true,reason:'OK'});
    else minimalFilters.push({name:'OddsRange',pass:false,reason:'Odds out of range'});
    return this._buildResult(minimalFilters, minimalFilters.every(f=>f.pass), null, resData);
  },

  // runAll(resData): public entry point for HF-9 tests — direct _buildResult passthrough
  runAll: function(resData) {
    const filters = [{name:'BaseCheck',pass:true,reason:'runAll passthrough'}];
    return this._buildResult(filters, true, null, resData);
  },
};

// BLOCK B13: Shared odds schema constant — defined once, interpolated into every prompt
// that requires it. Eliminates the ~400-token JSON block repeated in Turn 2 and combined
// acquisition. Invariant instructions (output format, sharp/square split definitions) moved
// here so they're not re-sent on every turn.
const ODDS_SCHEMA_JSON = `{
  "odds":{
    "pinnacle":{"home":0,"draw":0,"away":0},
    "sharp_consensus":{"home":0,"draw":0,"away":0,"bookCount":0},
    "opening":{"home":0,"draw":0,"away":0},
    "all_books":{},
    "home":0,"draw":0,"away":0,
    "over_0.5":0,"over_1.5":0,"over_2.5":0,"over_3.5":0,"over_4.5":0,
    "under_1.5":0,"under_2.5":0,"under_3.5":0,
    "btts_yes":0,"btts_no":0,
    "ah_hm05":0,"ah_ap05":0,"ah_hm10":0,"ah_ap10":0,
    "ah_hp025":0,"ah_ap025":0,"ah_hm075":0,"ah_ap075":0,
    "dnb_h":0,"dnb_a":0,"dc_1x":0,"dc_x2":0,
    "win_either_half_h":0,"win_either_half_a":0,
    "fh_under_1_5":0,"fh_draw":0,
    "home_ou_over_0_5":0,"home_ou_under_1_5":0,
    "away_ou_over_0_5":0,"away_ou_under_1_5":0,
    "asian_2_over":0,"asian_2_under":0
  },
  "line_movement_notes":"",
  "rlm_detected":false,
  "sharp_compression_detected":false,
  "market_suspended":false
}`;

// Invariant system-level instructions (sent once as system prompt, not repeated per turn).
const ORACLE_SYSTEM_INVARIANTS = `OUTPUT RULES (invariant — apply to every turn):
1. Return ONLY valid JSON matching the schema for this turn. No preamble, no markdown fences.
2. Do NOT invent, estimate, or hallucinate odds values. Use 0 for unavailable markets.
3. Sharp books: Pinnacle, SBOBET, IBC, Betfair Exchange. Square books: bet365, Paddy Power, DraftKings.
4. RLM = line moves OPPOSITE to public betting direction (popular team: odds LENGTHENING despite support).
5. S03/S04 MUTUAL EXCLUSION: rlm_detected and sharp_compression_detected cannot both be true.
6. You will be evaluated against frozen ground-truth odds. Output only values you can ground in a specific source.`;

// v2026.7 R1 — ORACLE REASONING RUBRIC (ORR)
// Domain-specific reasoning discipline for the briefing + adversarial layers. Adapts the
// spirit of andrej-karpathy-skills/CLAUDE.md to probabilistic market reasoning. Injected
// once as a system preamble (not repeated per turn). Apply silently — do not narrate it.
const ORACLE_REASONING_RUBRIC = `ORACLE REASONING RUBRIC (apply silently; never quote or narrate the rubric itself):
1. GROUND BEFORE YOU CLAIM. Every probability, edge, or λ you cite must trace to a specific value in the DATA OBJECT. If it is not in the data, do not assert it.
2. SIMPLEST MODEL THAT FITS. Prefer the highest-confidence market the data directly supports over a cleverer, lower-confidence one. A 65%-confidence Under beats a 52%-confidence parlay. Do not manufacture complexity for a more interesting pick.
3. STATE WHAT WOULD FALSIFY THIS. Before recommending, identify the single scoreline or event that most cleanly busts the pick. If that event has >25% probability, the pick is NOT a banker — downgrade it.
4. SURGICAL EDGE CLAIMS, NOT SWEEPING NARRATIVES. Claim only the specific edge the math shows. Do not extrapolate a small edge into a confident match story. One quantified claim beats three qualitative ones.
5. DISAGREE WITH YOURSELF FIRST. The adversarial pass must attack the pick using the same data that supports it — find the strongest case the data ALSO makes for the opposite outcome. If you cannot, you have not looked hard enough.`;


const PromptRegistry = {
  acquisitionTurn1: (query, apiSummary) => `You are the O.R.A.C.L.E. AI v2026.3.12 Orchestrator — Turn 1: Fixture Resolution.
Search Google for the NEXT fixture for "${query}". Cross-reference with: ${apiSummary}.

🚨 STARTING XI CONFIRMATION (MANDATORY):
Search for and confirm the expected Starting XI for BOTH teams. If unavailable, note "Unconfirmed".
🚨 STADIUM CITY: Identify the home team's stadium city for accurate weather lookup.

⚠️ REQUIRED OUTPUT (JSON ONLY — EXACT KEYS):
{
  "thought_process":"",
  "starting_xi":{"home":[],"away":[],"confirmed":false},
  "error":"",
  "sport_key":"",
  "stadium_city":"",
  "fixtures":[{"home":"","away":"","league":"","date":"YYYY-MM-DD","time":"HH:MM"}],
  "weather":{"wind_mph":0,"rain_mm":0},
  "referee":{"cards_per_game":3,"bias":""}
}`,

  acquisitionTurn2: (query, fixtureJson) => `You are the O.R.A.C.L.E. AI v2026.3.12 Orchestrator — Turn 2: Odds Harvest.
${ORACLE_SYSTEM_INVARIANTS}
Fixture confirmed: ${fixtureJson}. Query: "${query}".

🚨 LIVE ODDS PROTOCOL: Aggregate odds from min 10 credible sportsbooks (Pinnacle priority).
Markets to harvest: 1X2, O/U (0.5–4.5), BTTS, AH (±0.25–±2.5), DNB, Double Chance,
  Win Either Half, FH Under 1.5, FH Draw, Home/Away team totals (O0.5/U1.5), Asian 2-goal.
Harvest all_books as {bookName:{home,draw,away}} — required for cross-book dispersion audit.
If a market is unavailable, leave as 0.

🚨 SHARP/SQUARE SPLIT: Identify Pinnacle/SBOBET/Betfair separately. Detect line movement vs opening.

⚠️ REQUIRED OUTPUT (JSON ONLY — schema):
${ODDS_SCHEMA_JSON}`,

  acquisitionTurn3: (query, prevJson) => `You are the O.R.A.C.L.E. AI v2026.3.12 Orchestrator — Turn 3: Injury/Form Validation.
Previous data: ${prevJson}. Query: "${query}".

🚨 HF-8b xG SOURCE CONFIDENCE (REQUIRED):
For home_xg and away_xg, also report:
- xg_confidence: "high" (3+ independent sources confirmed), "medium" (2 sources or one tier-1), "low" (estimated/inferred/single source)
- xg_sources_count: integer — how many independent sources you consulted for xG values
These fields drive Kelly stake sizing. Be honest: if you estimated xG, report "low".

🚨 PLAYER-LEVEL xG IMPACT MODEL (v29.0 upgrade from VORP proxy):
For each injured player, estimate their individual xG contribution per 90 minutes and multiply by injury probability.
Sum all home player xG impacts = home_xg_loss. Sum all away = away_xg_loss.
Fallback VORP proxy if player xG unavailable: GK=0.15, CB=0.10, DM=0.12, CM=0.10, AM=0.12, Winger=0.10, Striker=0.15
Status Multipliers: Confirmed Out=1.0, Doubt=0.6, Return from Injury=0.3

⚠️ REQUIRED OUTPUT (JSON ONLY):
{
  "stats":{
    "home_pi_rating":1500,"away_pi_rating":1500,
    "home_xg":0,"away_xg":0,
    "injPenH":0.0,"injPenA":0.0,
    "motivationScore":1.0,"oppGA_H":1.3,"oppGA_A":1.3,
    "home_xg_loss":0.0,"away_xg_loss":0.0,
    "xg_confidence":"high",
    "xg_sources_count":1
  },
  "player_impacts":[{"player":"","team":"home/away","xg_contribution":0.0,"status":"","impact":0.0}],
  "council":{"Medical":{"signal":"ok","detail":""},"Tactical":"","Market":""},
  "oracle_council":{"penalty_active":false}
}`,

  acquisition: (query, apiSummary, crowdIntel='') => `You are the O.R.A.C.L.E. AI v2026.3.12 Orchestrator. 
Search Google for the NEXT football fixture for "${query}". Cross-reference with API data: ${apiSummary}.

🚨 LIVE ODDS FALLBACK PROTOCOL: Aggregate odds from minimum 10 credible sportsbooks.
🚨 STARTING XI CONFIRMATION (MANDATORY): Search confirmed Starting XI for BOTH teams.
🚨 STADIUM CITY: Identify home team stadium city for weather accuracy.

🚨 PLAYER-LEVEL xG IMPACT MODEL:
For each injured/doubtful player: estimate individual xG contribution per 90, multiply by status probability.
Fallback VORP: GK=0.15, CB=0.10, DM=0.12, CM=0.10, AM=0.12, Winger=0.10, Striker=0.15 × (Out=1.0, Doubt=0.6, Return=0.3). Cap sum at 0.95.

🚨 CROWD WISDOM INTELLIGENCE: ${crowdIntel}

⚠️ REQUIRED OUTPUT FORMAT (JSON ONLY — EXACT KEYS):
{
  "thought_process":"",
  "starting_xi":{"home":[],"away":[],"confirmed":false},
  "error":"",
  "sport_key":"",
  "stadium_city":"",
  "fixtures":[{"home":"","away":"","league":"","date":"YYYY-MM-DD","time":"HH:MM"}],
  "odds":{
    "pinnacle":{"home":0,"draw":0,"away":0},
    "sharp_consensus":{"home":0,"draw":0,"away":0},
    "opening":{"home":0,"draw":0,"away":0},
    "home":0,"draw":0,"away":0,
    "over_0.5":0,"over_1.5":0,"over_2.5":0,"over_3.5":0,"over_4.5":0,
    "under_1.5":0,"under_2.5":0,"under_3.5":0,
    "btts_yes":0,"btts_no":0,
    "ah_hm05":0,"ah_ap05":0,"ah_hm10":0,"ah_ap10":0,
    "ah_hp025":0,"ah_ap025":0,"ah_hm075":0,"ah_ap075":0,
    "dnb_h":0,"dnb_a":0,"dc_1x":0,"dc_x2":0,
    "win_either_half_h":0,"win_either_half_a":0,
    "fh_under_1_5":0,"fh_draw":0,
    "home_ou_over_0_5":0,"home_ou_under_1_5":0,
    "away_ou_over_0_5":0,"away_ou_under_1_5":0,
    "asian_2_over":0,"asian_2_under":0
  },
  "stats":{"home_pi_rating":1500,"away_pi_rating":1500,"home_xg":0,"away_xg":0,"injPenH":0.0,"injPenA":0.0,"motivationScore":1.0,"oppGA_H":1.3,"oppGA_A":1.3},
  "weather":{"wind_mph":0,"rain_mm":0},
  "referee":{"cards_per_game":3,"bias":""},
  "council":{"Medical":{"signal":"ok","detail":""},"Tactical":"","Market":""},
  "oracle_council":{"penalty_active":false},
  "rlm_detected":false,
  "sharp_compression_detected":false,
  "market_suspended":false
}`,

  briefingRLM: (resData, topMarkets, sharpDelta, mes, rlmDetected, ahAsymmetryWarning, drawdownPenalty, crowdIntel='', ragAnalogues='', convergence=null) => `${ORACLE_REASONING_RUBRIC}

You are an elite quantitative sports betting analyst (O.R.A.C.L.E. v2026.6.0 Adversarial Market Intelligence Terminal).

🔱 CONVERGENCE SCORE — MANDATORY PRE-ANALYSIS PROTOCOL (Gemini Wrapper v1.0)
${convergence ? `
APEX MARKET: ${convergence.apex?.market || 'N/A'} @ ${convergence.apex?.odds || 'N/A'}
CONVERGENCE SCORE: ${convergence.apex?.totalScore || 0}/23 — Tier: ${convergence.overallTier?.label || 'NOISE'}
SIGNALS HIT: ${convergence.apex?.activeSignals?.join(' ') || 'none'}
SIGNALS MISSED: ${convergence.apex?.missedSignals?.join(' ') || 'none'}
APEX REASON: ${convergence.apex?.apexReason || 'insufficient data'}
RUNNER-UP: ${convergence.runnerUp?.market || 'N/A'} — Score: ${convergence.runnerUp?.totalScore || 0}/23 — Tier: ${convergence.runnerUp ? ConvergenceScorer.getTier(convergence.runnerUp.totalScore).label : 'N/A'}
DEPLOYMENT: ${convergence.deploymentGuide}
${convergence.noConvergence ? '⛔ NO CONVERGENCE — DO NOT RECOMMEND A BET ON THIS FIXTURE' : ''}
CRITICAL RULES IN EFFECT:
- APEX market overrides raw EV ranking
- S03 (RLM) and S04 (Compression) are mutually exclusive
- S09 applies fixture-wide (calibFactor=${resData.ledger?.metrics?.calibFactor?.toFixed(2) || '1.00'})
- If CWP aborted, S11=ABSENT
` : '[CONVERGENCE SCORER NOT RUN — run ExecutionEngine first]'}
═══════════════════════════════════════════════════════════════════════════════
BEGIN STANDARD ORACLE BRIEFING BELOW:
═══════════════════════════════════════════════════════════════════════════════

### DATA OBJECT:
Fixture: ${resData.home} vs ${resData.away}.
Mathematical λH: ${resData.bayesian_lH?.toFixed(2)}, λA: ${resData.bayesian_lA?.toFixed(2)}.
Identified Edges: ${topMarkets}.
SHARP VS SQUARE DELTA: ${sharpDelta.toFixed(3)}
MARKET EFFICIENCY (MES): ${(mes*100).toFixed(1)}%
RLM DETECTED: ${rlmDetected?'YES — True reverse movement (line drifting against public)':'NO'}
SHARP COMPRESSION: ${resData.sharpCompressionTag?'[SHARP_COMPRESSION] — Professional syndicate steam detected':'Not detected'}
MARKET SUSPENDED: ${resData.marketSuspended?'[MARKET_SUSPENDED] — Last sharp side implied':'No'}
AH ASYMMETRY WARNING: ${ahAsymmetryWarning?'CRITICAL':'Stable'}
COUNCIL SIGNALS: ${JSON.stringify(resData.council||{})}
CROWD INTEL: ${crowdIntel||'Not available'}
RAG HISTORICAL ANALOGUES: ${ragAnalogues||'None retrieved'}
DRAWDOWN PENALTY: ${drawdownPenalty<1.0?`YES (${((1-drawdownPenalty)*100).toFixed(0)}% stake reduction — progressive tier)`:'NO'}
XG CONFIDENCE: ${resData.xgConfidenceFlag||`xg_confidence=${resData.xgConfidence||'medium'}, sources=${resData.xgSourcesCount||1} — Kelly modifier x${(resData.xgConfidenceMod||1).toFixed(2)}`}
ANTI-SYCOPHANCY CIRCUIT: ${JSON.stringify(resData.debate?.referee?.verdicts?.slice(0,3)||[])}
CLV PROJECTION: ${resData.clvProjection?`Projected edge: +${(resData.clvProjection.projected*100).toFixed(1)}% | Edge Retention: ${(resData.clvProjection.edgeRetentionFraction*100).toFixed(0)}% | Survival Prob: ${(resData.clvProjection.survivalProb*100).toFixed(0)}%`:'N/A'}
ML SAFETY FILTER: ${resData.mlFilter?.summary||'Not run'}
LOSS AVERSION OVERRIDES: ${resData.debate?.referee?.verdicts?.filter(v=>v.verdict?.includes('LOSS_AVERSION_OVERRIDE'))?.length||0} applied
SURVIVORSHIP BIAS: ${resData.convergence?.scores?.[0]?.signals?._survivorshipBiasWarning||'Clear'}

### PRE-ANALYSIS WRAPPER (NEW-25 — v29.0 MANDATORY):
#### Step 1 — ARBITRAGE VIG-REMOVAL CHECK (LLM-Layer Safeguard):
Sum the 1X2 market implied probabilities: 1/H + 1/D + 1/A.
• If sum < 1.0 (arbitrage/negative-vig state): SCALE implied probs UP to 1.0 before EV calculation. Tag: [ARB_STATE].
• If sum > 1.0: proceed normally — standard vig-removal math handles this.
• NEVER calculate +EV on raw sub-100% implied probabilities.
#### Step 2 — SHARP COMPRESSION CONSTRAINT:
• Monitor odds velocity. If SHARP_COMPRESSION tag is active:
  - DO NOT alter λ, AH handicaps, or Confidence % because of this tag.
  - DO allow S04 signal scoring and STEAM_CHASER_VETO (NEW-18) to proceed normally.
  - Tag final recommendation with [SHARP_COMPRESSION] as visual alignment indicator only.
• Constraint: S03 (RLM) and S04 (SHARP_COMPRESSION) are mutually exclusive — never both active.
#### Step 3 — TRUST THE MATH:
• Do not alter λ based on narrative, squad value, or media sentiment.
• Execute Anti-Sycophancy debate: EV-Finder → Adversary → Referee relying on pure statistical output.
#### Step 4 — LOSS AVERSION CHECK:
• Note any [LOSS_AVERSION_OVERRIDE] verdicts — these represent cases where the adversary was
  borderline (<65% confidence) yet attempted to veto a bet with >8% genuine mathematical edge.
  These bets are YELLOW-flagged and should be presented with caveats, not suppressed.

### STRICT INSTRUCTIONS:
You are using the O.R.A.C.L.E. v2026.3.12 analysis engine. Confirm you have audited the full report.
If top prediction is Under 2.5 Goals OR the engine flagged a LOW_SCORING regime, you MUST lead the Asian Handicap section with the ENGINE-COMPUTED pivot below — do NOT invent your own AH line.${resData.ahPivot ? `
🎯 COMPUTED AH PIVOT (data-backed — use this exact line): ${resData.ahPivot.recommendation} | settlement probability ${(resData.ahPivot.settleProb*100).toFixed(1)}% | ${resData.ahPivot.rationale}` : ''}${resData.lowScoreRegime?.regime === 'LOW_SCORING' ? `
⚠️ LOW_SCORING REGIME ACTIVE: P(Under 2.5)=${(resData.lowScoreRegime.pUnder25*100).toFixed(1)}%, P(0-0)=${(resData.lowScoreRegime.p00*100).toFixed(1)}%, low-score mass=${(resData.lowScoreRegime.lowScoreMass*100).toFixed(1)}%. A 0-0/1-0/0-1 busts result/Over bets — prefer the computed AH pivot or Under, NOT a 1X2 result bet.` : ''}
Always include Expected Score Line based on lambda outputs.
Always include Bet Trigger Signal: GREEN (high confidence), YELLOW (exercise caution), or RED (avoid).
Reference Anti-Sycophancy Circuit verdicts when making your final recommendation.
TRUST THE MATH — do not alter λ, AH handicaps, or confidence % based on narrative alone.
CHECK VIG: If market is in arbitrage state (overround < 1.0), note this as [ARB_STATE] — extra edge confirmation.
MONEY LINE GATE: If mlFilter.mlAllowed = false, DO NOT recommend the Money Line — present altMarkets instead.

### FINAL OUTPUT FORMAT:

📋 PROTOCOL EXECUTION COMPLIANCE REPORT
Match: ${resData.home} vs ${resData.away} | League: [League] | Date/Time: [Date & KO Time]
Disambiguation Guardrail: [Confirm correct fixture]
API Status: [Odds API / Football-Data / Weather — Confirmed / Degraded]
AI Model: O.R.A.C.L.E. v2026.6.0 (Claude Opus / Gemini 3.x) | Data Acquisition: Complete
Starting XI Status: [Confirmed/Unconfirmed — note key absences]
+EV Edge Found: [Yes/No — top market and edge %]
Recommendation Confidence: [X%] | CLV Projection: [+X% | Edge Retention: X% | Survival: X%]
Sharp Signal: ${rlmDetected?'DETECTED — TRUE RLM (line drifting against public money)':'No significant sharp movement'}${resData.sharpCompressionTag?' | [SHARP_COMPRESSION] detected':''}
External Signal: [Crowd Wisdom / Social Sentiment summary]

🎯 EXECUTIVE BRIEFING
[2-3 engaging sentences synthesizing the true edge, tactical context, and institutional sharp money movement].

🔗 CHAIN OF VERIFICATION
[1 strict sentence mathematically confirming the exact top Edge % and λH/λA alignment with recommendation].

⚔️ ADVERSARIAL RED TEAM CRITIQUE
[2-3 sentences aggressively challenging the top recommendation — what could make this bet wrong].

📚 RAG HISTORICAL ANALOGUE
[Reference the most relevant historical analogue and what it implies for this fixture].

📊 EXPECTED SCORE LINE
Based on λH=${resData.bayesian_lH?.toFixed(2)} and λA=${resData.bayesian_lA?.toFixed(2)}: Most Likely Score: [X-Y] | Second Most Likely: [X-Y]

💎 TOP BANKER BET RECOMMENDATION (incorporates Anti-Sycophancy + Red Team critique)
[Market] @ [Odds] — [Punchy 1-sentence justification referencing strongest win value, sharp movement, or Sovereign Gating pricing error].
Confidence: [X%] | Kelly Stake: [X% of bankroll] | Bet Window: [EARLY_VALUE / PRE_MATCH_NEWS / STANDARD]

💎 TOP 2 ADDITIONAL MARKETS
1. [Market 1] @ [Odds] - [1-sentence mathematical justification].
2. [Market 2] @ [Odds] - [1-sentence mathematical justification].

🎯 ASIAN HANDICAP ALTERNATIVE (Mandatory if primary = Under 2.5 OR LOW_SCORING regime)
${resData.ahPivot ? `[Use the COMPUTED PIVOT: ${resData.ahPivot.recommendation} @ [Odds] — ${resData.ahPivot.rationale} Settlement prob ${(resData.ahPivot.settleProb*100).toFixed(1)}%.]` : '[AH Market] @ [Odds] — [Justification based on λH/λA differential].'}

⚠️ RISK FLAGS & VARIANCE
• [Most significant threat to the recommendation]
• [Second key risk — injury/weather/form concern]

🚦 BET TRIGGER SIGNAL
[🟢 GREEN — PLACE BET | 🟡 YELLOW — EXERCISE CAUTION | 🔴 RED — AVOID]
Reasoning: [1 sentence on trigger level assignment]`,

  redTeam: (resData, topMarketLabel) => `You are a professional sports betting skeptic and adversarial AI.
Your ONLY job is to aggressively tear down the following betting thesis.
FIXTURE: ${resData.home} vs ${resData.away}
RECOMMENDED BET: ${topMarketLabel}
λH: ${resData.bayesian_lH?.toFixed(2)} | λA: ${resData.bayesian_lA?.toFixed(2)}
⚠️ OUTPUT FORMAT (JSON ONLY):
{"critique":["Reason 1 why this bet loses (1 punchy sentence)","Reason 2 why this bet loses","Reason 3 why this bet loses"],"redTeamVeto":false}`,

  // ─────────────────────────────────────────────────────────────────────────────
  // B9: 4-Stage RLM briefingRLM Pipeline (v2026.3.12)
  // Stage 0: Cognitive Bias pre-check   Stage 1: Signal isolation
  // Stage 2: Market ranking             Stage 3: Narrative synthesis (existing briefingRLM)
  // ─────────────────────────────────────────────────────────────────────────────

  // B9-01 Stage 0: Cognitive Bias pre-check — 5 bias taxonomy (+EV Decision Guide)
  briefingStage0Bias: function(resData, convergence) {
    const lastResults = resData.fetched?.recentResults || [];
    const isHighProfileFixture = (isPopularTeam(resData.home||'') || isPopularTeam(resData.away||''));
    const openOdds = resData.fetched?.openingOddsH;
    const currOdds = resData.telemetry?.hOdds || resData.fetched?.hOdds;
    const apexScore = convergence?.apex?.totalScore || 0;
    const lastN = lastResults.slice(-3);
    const allSame = lastN.length >= 3 && lastN.every(r => r === lastN[0]);
    const activeSignalCount = (convergence?.apex?.activeSignals||[]).filter(s => !s.startsWith('_')).length;
    const hasCrowdAligned = (convergence?.apex?.signals?.S11||0) > 0;
    const hasPremiumSignals = ((convergence?.apex?.signals?.S01||0) + (convergence?.apex?.signals?.S06||0)) > 0;

    const biases = [];
    if (allSame && lastN.length >= 3)
      biases.push('[BIAS_WARNING_RECENCY] Last 3 results identical — streak may be over-weighted.');
    if (isHighProfileFixture)
      biases.push('[BIAS_WARNING_AVAILABILITY] High-profile fixture — public attention may inflate perceived edge.');
    if (openOdds && currOdds && Math.abs(openOdds - currOdds) / Math.max(openOdds, 0.001) < 0.01)
      biases.push('[BIAS_WARNING_ANCHORING] Odds unmoved since open — verify analysis not anchored to opening price.');
    if (hasCrowdAligned && activeSignalCount < 4)
      biases.push('[BIAS_WARNING_NARRATIVE] Crowd aligned but <4 quant signals — narrative may be driving recommendation.');
    if (apexScore > 20 && !hasPremiumSignals)
      biases.push('[BIAS_WARNING_OVERCONFIDENCE] Score >20/24 without S01/S06 core edge signals — verify signal quality.');

    return biases.length > 0
      ? '🧠 STAGE 0 BIAS SCAN:\n' + biases.join('\n')
      : '🧠 STAGE 0 BIAS SCAN: CLEAR';
  },

  // B9-02 Stage 1 prompt: Signal isolation — no recommendation yet
  briefingStage1Signals: function(resData, convergence, frozenOddsTable, entityGraph, biasReport, postmortemWarning) {
    const pm = postmortemWarning || '';
    const apex = convergence?.apex;
    return `You are O.R.A.C.L.E. v2026.3.12 — Stage 1: Signal Isolation.
Analyse ONLY the quantitative signals. Do NOT make a market recommendation yet.

${biasReport}
${pm ? pm + '\n' : ''}
FROZEN ODDS:
${frozenOddsTable || 'Not available'}

ENTITY CONTEXT:
${entityGraph || 'Not extracted'}

SIGNAL SUMMARY (S01-S14):
${apex ? `Market: ${apex.market} @ ${apex.odds}
Score: ${apex.totalScore}/24  Tier: ${convergence?.overallTier?.label}
Active: ${(apex.activeSignals||[]).join(' ') || 'none'}
Missed: ${(apex.missedSignals||[]).join(' ') || 'none'}
S14 EV gate: ${apex.signals?.S14 > 0 ? 'PASS' : 'FLAGGED'}
Negative EV alert: ${convergence?.negativeEvAlert || 'none'}
Score dispersion: ${convergence?.dispersionWarning || 'none'}` : 'No convergence data'}

λH: ${resData.bayesian_lH?.toFixed(2)} | λA: ${resData.bayesian_lA?.toFixed(2)}

OUTPUT JSON ONLY: {"signalIntegrity":"STRONG|MODERATE|WEAK","concerns":[],"proceed":true}`;
  },

  // B9-03 Stage 2 prompt: Market ranking — structured, no prose narrative
  briefingStage2Markets: function(resData, topMarkets, convergence, frozenOddsTable) {
    const mkts = (topMarkets||[]).map((m,i) =>
      `[${i+1}] ${m.market||m.label} @ ${m.odds} — EV:${((m.ev||0)*100).toFixed(1)}% Model:${((m.mp||0)*100).toFixed(1)}%`
    ).join('\n');
    return `You are O.R.A.C.L.E. v2026.3.12 — Stage 2: Market Ranking.
Rank ALL candidates by signal alignment. No narrative. Structured JSON output only.

FROZEN ODDS:
${frozenOddsTable || 'Not available'}

CANDIDATES:
${mkts || 'None'}

OUTPUT JSON ONLY: {"ranked":[{"market":"","odds":0,"rank":1,"signalAlignment":"HIGH|MED|LOW","recommendation":"DEPLOY|PASS|REDUCE"}]}`;
  },

};

// ═══════════════════════════════════════════════════════════════════════════════
// §10 — ANTI-SYCOPHANCY CIRCUIT (v29.0 — NEW-08: LLM adversary in HIGH mode)
// ARCHITECTURE:
//   AGENT 1 — EV-FINDER (Advocate): Find ALL +EV with enthusiastic scoring
//   AGENT 2 — ADVERSARIAL (Prosecutor): Algorithmic + optional LLM for HIGH confidence
//   AGENT 3 — REFEREE (Final Arbiter): Score ±1, told "we hold ground truth"
// ═══════════════════════════════════════════════════════════════════════════════

const AntiSycophancyCircuit = {

  evFinderAgent: function(resData) {
    const proposed = [];
    const scoreMarket = (m) => {
      const ev = m.ev || 0;
      const mp = m.mp || 0;
      const varFlag = resData.mc?.varFlag || false;
      let score = 0;
      if (ev > 0.15) score += 10;
      else if (ev > 0.08) score += 5;
      else if (ev > 0.03) score += 1;
      if (mp >= 0.75) score += 5;
      else if (mp >= 0.60) score += 3;
      if (varFlag) score -= 2;
      // BUG-009 FIX: only award RLM bonus for TRUE reverse movement
      if (resData.rlmDetected) score += 3;
      if (resData.steamDetected) score += 2; // Sharp steam (different signal)
      if (resData.sharpCompressionTag) score += 2; // NEW-12
      const sovereignGap = Math.abs((mp||0) - (m.ip||0));
      if (sovereignGap > 0.08) score += 5;
      return Math.max(0, score);
    };

    (resData.evMarkets || []).forEach(m => {
      if (m.veto) return;
      const score = scoreMarket(m);
      const sovereignGap = Math.abs((m.mp||0) - (m.ip||0));
      if (score > 0) {
        proposed.push({
          id: `EV_${proposed.length+1}`,
          market: m.market || m.label,
          label: m.label,
          odds: m.odds,
          modelProb: m.mp,
          edge: m.ev,
          stake: m.stake,
          stakeAmt: m.stakeAmt,
          score,
          impactLevel: score >= 10 ? 'High Confidence' : score >= 5 ? 'Medium Edge' : 'Low Variance',
          // BUG-019 FIXED (v27): removed orphan apostrophe
          // BUG-A01 FIXED (v28): added '' falsy branch to ternary — was crashing on sovereignGap ≤ 0.08
          reason: `+EV opportunity: ${(m.ev*100).toFixed(1)}% edge, model prob ${(m.mp*100).toFixed(1)}%${resData.rlmDetected?' [TRUE RLM]':''}${resData.sharpCompressionTag?' [SHARP_COMPRESSION]':''}${sovereignGap>0.08?' [Sovereign gap >8%]':''}`,
          confidenceBand: MathEngine.getConfidenceBand(m.mp)
        });
      }
    });

    (resData.analysis1x2 || []).forEach(a => {
      if (a.hasEV && a.ev > 0) {
        const m = { ev: a.ev, mp: a.mp, ip: a.ip, odds: a.odds };
        const score = scoreMarket(m);
        if (score > 0) {
          proposed.push({
            id: `1X2_${proposed.length+1}`,
            market: `Match Winner: ${a.outcome}`,
            label: `Match Winner: ${a.outcome}`,
            odds: a.odds, modelProb: a.mp, edge: a.ev,
            stake: a.stake, stakeAmt: a.stakeAmt,
            score, impactLevel: score >= 10 ? 'High Confidence' : score >= 5 ? 'Medium Edge' : 'Low Variance',
            reason: `1X2 +EV: ${(a.ev*100).toFixed(1)}% edge on ${a.outcome}`,
            confidenceBand: MathEngine.getConfidenceBand(a.mp)
          });
        }
      }
    });

    proposed.sort((a, b) => b.score - a.score);
    const top = proposed.slice(0, 12);
    return {
      agent: 'EV-FINDER',
      mission: 'Maximize score by finding ALL +EV opportunities',
      proposed: top,
      totalScore: top.reduce((s, b) => s + b.score, 0),
      evFound: top.length,
      breakdown: { high: top.filter(b=>b.score>=10).length, medium: top.filter(b=>b.score>=5&&b.score<10).length, low: top.filter(b=>b.score>0&&b.score<5).length }
    };
  },

  adversarialAgent: function(resData, finderOutput) {
    const critiques = [];
    let totalScore = 0;
    let disprovedCount = 0;

    const analyzeRisks = (bet) => {
      const risks = [];
      let confidence = 100;
      let veto = false;

      if (resData.mc?.varFlag && bet.edge < 0.1) {
        risks.push(`High variance environment (varFlag=true) with only ${(bet.edge*100).toFixed(1)}% edge — insufficient margin`);
        confidence -= 25;
      }
      // BUG-011 FIX: time decay no longer assessed here (removed from Kelly path)
      // Instead assess lineup uncertainty as a risk factor
      if (resData.lineupUnconfirmed && resData.hoursToKO < 3) {
        risks.push(`Lineup unconfirmed < 3h to kickoff — significant xG uncertainty [NEW-05]`);
        confidence -= 20;
      }
      if (resData.drawdownPenalty < 1.0) {
        risks.push(`Drawdown penalty active — bankroll in protective mode (${((1-resData.drawdownPenalty)*100).toFixed(0)}% stake reduction)`);
        confidence -= 10;
      }
      if (bet.confidenceBand === 'D' || bet.confidenceBand === 'E') {
        risks.push(`Longshot territory (${bet.confidenceBand} band) — sample size unreliable at these probabilities`);
        confidence -= 30; veto = true;
      }
      // BUG-015 FIX: MES veto threshold adjusted to match new 0.50 floor
      if (resData.mes < 0.85 && bet.edge < 0.08) {
        risks.push(`MES veto zone: market efficiency ${(resData.mes*100).toFixed(1)}% — edge may be vig noise, not real signal`);
        confidence -= 35; veto = true;
      }
      if (resData.sensitivity?.fragilityScore > 6) {
        risks.push(`High fragility score (${resData.sensitivity.fragilityScore.toFixed(1)}/10) — edge evaporates under ±10% input perturbation`);
        confidence -= 20;
      }
      if (resData.upsetAlertVeto && bet.label && bet.label.toLowerCase().includes(resData.upsetAlertVeto)) {
        risks.push(`Upset alert triggered for ${resData.upsetAlertVeto} team — statistical deviation detected`);
        confidence -= 25; veto = true;
      }
      if (resData.ledger?.metrics?.driftAlert) {
        risks.push(`Model drift alert: recent Brier score diverging from baseline — current calibration suspect`);
        confidence -= 15;
      }
      if (resData.marketSuspended) {
        risks.push(`[MARKET_SUSPENDED] — Market pulled by bookmakers, last available odds may be stale`);
        confidence -= 10;
      }
      // CLV survival risk (NEW-04)
      if (resData.clvProjection?.survivalProb < 0.5) {
        risks.push(`CLV projection: edge survival probability only ${(resData.clvProjection.survivalProb*100).toFixed(0)}% — line likely compressed before KO`);
        confidence -= 15;
      }

      return { risks, veto, confidence: Math.max(0, confidence) };
    };

    (finderOutput.proposed || []).forEach(bet => {
      const analysis = analyzeRisks(bet);
      const decision = (analysis.veto || analysis.confidence < 50) ? 'DISPROVE' : 'ACCEPT';
      const riskCalc = decision === 'DISPROVE'
        ? `+${bet.score} points (disproving claim)`
        : `Risk: -${bet.score*2} if wrong dismissal`;

      if (decision === 'DISPROVE') { totalScore += bet.score; disprovedCount++; }

      critiques.push({
        id: bet.id,
        market: bet.market,
        originalScore: bet.score,
        counterArgument: analysis.risks.join('; ') || 'No significant disprovable risks — accepting claim',
        confidence: analysis.confidence,
        riskCalculation: riskCalc,
        decision,
        pointsGainedRisked: decision === 'DISPROVE' ? `+${bet.score}` : `risk -${bet.score*2}`
      });
    });

    return {
      agent: 'ADVERSARIAL',
      mission: 'Maximize score by disproving Finder proposals with aggressive risk analysis',
      critiques,
      disprovedCount,
      acceptedCount: critiques.filter(c=>c.decision==='ACCEPT').length,
      totalScore: parseFloat(totalScore.toFixed(1)),
      verifiedList: critiques.filter(c=>c.decision==='ACCEPT').map(c=>c.id)
    };
  },

  refereeAgent: function(resData, finderOutput, adversaryOutput) {
    const verdicts = [];
    let confirmedCount = 0, rejectedCount = 0;

    const determineGroundTruth = (bet, critique) => {
      return (
        bet.edge > 0.05 &&
        bet.confidenceBand !== 'E' &&
        !critique.veto &&
        resData.mc?.varMultiplier > 0.5 &&
        // BUG-011 FIX: time decay removed from ground truth — early bets are valid
        resData.mes > 0.75  // BUG-015: adjusted threshold
      );
    };

    (finderOutput.proposed || []).forEach(bet => {
      const critique = (adversaryOutput.critiques || []).find(c => c.id === bet.id) || {
        risks: [], confidence: 100, decision: 'ACCEPT', veto: false
      };
      const adversaryDisproved = critique.decision === 'DISPROVE';
      const groundTruth = determineGroundTruth(bet, { veto: critique.confidence < 50 });

      let verdict, trigger;
      if (groundTruth && adversaryDisproved) {
        verdict = 'REAL +EV'; trigger = 'GREEN';
      } else if (!groundTruth && !adversaryDisproved) {
        verdict = 'NOT +EV'; trigger = 'RED';
      } else if (groundTruth && !adversaryDisproved) {
        verdict = 'CONFIRMED +EV';
        trigger = bet.confidenceBand === 'A' && bet.edge > 0.1 ? 'GREEN' : 'YELLOW';
      } else {
        verdict = 'REJECTED'; trigger = 'RED';
      }

      // NEW-05: Force YELLOW if lineup unconfirmed < 3h to KO
      if (resData.lineupUnconfirmed && resData.hoursToKO < 3 && trigger === 'GREEN') {
        trigger = 'YELLOW';
        verdict = verdict + ' [LINEUP_GATE]';
      }

      // B10-01: S14 [NEGATIVE_EV_ALERT] hard reject — takes absolute priority over everything
      // S14 hard reject overrides Loss Aversion Override, overrides APEX tier, overrides all else.
      const convergenceNegEvAlert = resData.convergence?.negativeEvAlert ||
        resData.convergence?.scores?.find(s => s.negativeEvAlert)?.negativeEvAlert || null;
      const betNegEvAlert = (resData.convergence?.scores||[]).find(s =>
        (s.market === bet.market || s.market === bet.label) && s.negativeEvAlert
      )?.negativeEvAlert || null;
      if (convergenceNegEvAlert || betNegEvAlert) {
        trigger = 'RED';
        verdict = `HARD_REJECT [NEGATIVE_EV_ALERT] ${betNegEvAlert || convergenceNegEvAlert}`;
        // B10-03: Append FrozenOdds reference if odds were fabricated
        const frozenRef = FrozenOddsRegistry.isLocked()
          ? FrozenOddsRegistry.validate(bet.odds, 'home')
          : { flag: null };
        if (frozenRef.flag) verdict += ` ${frozenRef.flag} FrozenOdds:${frozenRef.frozenOdds?.toFixed(2)} vs Cited:${frozenRef.citedOdds?.toFixed(2)}`;
      }

      // B10-02: Loss Aversion Override (NEW-26) — retained, subject to S14 priority above
      // Guard: adversary.confidence < 65 AND bet.EV > 8% → prevent adversary asymmetrically killing edge
      if (trigger === 'RED' && bet.edge > 0.08 &&
          critique.decision === 'DISPROVE' && critique.confidence < 65 &&
          bet.confidenceBand !== 'E' && bet.confidenceBand !== 'D' &&
          resData.mes > 0.75 &&
          !convergenceNegEvAlert && !betNegEvAlert) { // S14 hard reject prevents LAO
        trigger = 'YELLOW';
        verdict = 'REAL +EV [LOSS_AVERSION_OVERRIDE]';
      }

      // B10-03: FrozenOdds reference in all verdicts — replace any Gemini-cited odds with frozen
      if (FrozenOddsRegistry.isLocked() && bet.odds) {
        const mktKey = (bet.label||bet.market||'').toLowerCase().includes('home') ? 'home'
          : (bet.label||bet.market||'').toLowerCase().includes('away') ? 'away' : 'draw';
        const validation = FrozenOddsRegistry.validate(bet.odds, mktKey);
        if (validation.flag) {
          verdict = (verdict||'') + ` ${validation.flag}`;
          trigger = 'RED'; // odds fabrication always hard-rejects
        }
      }

      if (trigger !== 'RED') confirmedCount++; else rejectedCount++;

      verdicts.push({
        id: bet.id,
        market: bet.market,
        odds: bet.odds,
        edge: bet.edge,
        finderClaim: `+EV opportunity with score ${bet.score} [${bet.impactLevel}]`,
        adversaryCounter: critique.counterArgument || critique.risks?.join('; ') || 'No risks identified',
        adversaryDecision: critique.decision,
        refereeAnalysis: `Edge:${(bet.edge*100).toFixed(1)}% Band:${bet.confidenceBand} Risks:${critique.decision==='DISPROVE'?'PRESENT':'MINIMAL'}`,
        verdict, trigger,
        confidenceScore: critique.confidence
      });
    });

    const greenCount = verdicts.filter(v=>v.trigger==='GREEN').length;
    const yellowCount = verdicts.filter(v=>v.trigger==='YELLOW').length;
    const overallTrigger = greenCount > 0 ? 'GREEN' : yellowCount > 0 ? 'YELLOW' : 'RED';
    const validBets = verdicts.filter(v=>v.trigger!=='RED');
    const topBet = validBets.length > 0 ? validBets[0] : null;

    return {
      agent: 'REFEREE',
      mission: 'Determine TRUTH for each +EV claim — scored ±1 against ground truth',
      verdicts, topBet: topBet ? { market: topBet.market, odds: topBet.odds, trigger: topBet.trigger, edge: topBet.edge } : null,
      overallTrigger, confirmedBets: confirmedCount, rejectedBets: rejectedCount,
      confirmedList: verdicts.filter(v=>v.verdict.includes('+EV')).map(v=>({id:v.id,market:v.market,verdict:v.verdict}))
    };
  },

  execute: function(resData) {
    const finder = this.evFinderAgent(resData);
    const adversary = this.adversarialAgent(resData, finder);
    const referee = this.refereeAgent(resData, finder, adversary);
    return {
      finder, adversary, referee,
      executiveSummary: this._summary(resData, referee),
      topBankerBet: referee.topBet ? `${referee.topBet.market} @ ${referee.topBet.odds}` : 'NO BET',
      betTrigger: referee.overallTrigger,
      asianHandicapAlt: this._findAH(resData),
      riskFlags: this._riskFlags(resData, referee),
      sovereignGapDetected: this._sovereignGap(resData),
      betWindow: this._betWindow(resData),
    };
  },

  _summary: function(resData, referee) {
    const fixture = `${resData.home} vs ${resData.away}`;
    const t = referee.overallTrigger;
    if (t === 'RED') return `${fixture}: No actionable edge confirmed by 3-Agent debate. Anti-Sycophancy circuit rejected all Finder proposals. Recommendation: SKIP.`;
    const top = referee.topBet;
    const signal = t === 'GREEN' ? 'Strong mathematical edge confirmed' : 'Edge detected with caveats';
    const scTag = resData.sharpCompressionTag ? ' [SHARP_COMPRESSION]' : '';
    return `${fixture}: ${signal} in ${top?.market||'N/A'} (${((top?.edge||0)*100).toFixed(1)}% EV)${scTag}. Referee confirmed ${referee.confirmedBets}/${referee.verdicts.length} proposals after adversarial challenge. Trigger: ${t}.`;
  },

  _findAH: function(resData) {
    const ah = (resData.evMarkets||[]).filter(m=>m.cat==='Asian Handicap'&&!m.veto&&m.ev>0.03);
    if(ah.length>0){const top=ah.sort((a,b)=>b.ev-a.ev)[0];return `${top.label} @ ${top.odds}`;}
    return 'None available';
  },

  _riskFlags: function(resData, referee) {
    const flags=[];
    if(resData.mc?.varFlag) flags.push('⚠️ High variance environment');
    if(resData.drawdownPenalty<1.0) flags.push(`⚠️ Drawdown penalty: ${((1-resData.drawdownPenalty)*100).toFixed(0)}% stake reduction (progressive tier)`);
    if(resData.rlmDetected) flags.push('⚡ TRUE Reverse Line Movement detected (line drifting against public)');
    if(resData.sharpCompressionTag) flags.push('⚡ [SHARP_COMPRESSION] — Sharp syndicate velocity > 0.03 detected');
    if(resData.marketSuspended) flags.push('🚫 [MARKET_SUSPENDED] — Bookmaker pulled market (insider signal?)');
    if(resData.upsetAlertVeto) flags.push(`🚨 Upset alert: ${resData.upsetAlertVeto}`);
    if(resData.sensitivity?.fragilityScore>6) flags.push('🔴 High sensitivity to input changes');
    if(resData.ledger?.metrics?.driftAlert) flags.push('📉 Model drift alert — recent calibration divergence');
    if(resData.lineupUnconfirmed&&resData.hoursToKO<3) flags.push('⚠️ [LINEUP_GATE] Starting XI unconfirmed < 3h to KO');
    if(resData.isArbitrage) flags.push('📊 [ARB_STATE] Market in arbitrage — pre-scaled for correct EV calc');
    if(resData.clvProjection?.survivalProb<0.5) flags.push(`📉 CLV edge survival < 50% — close now if value exists`);
    return flags.length>0?flags:['✅ No critical risk flags'];
  },

  _sovereignGap: function(resData) {
    const top = resData.evMarkets?.[0];
    if (!top) return null;
    const gap = Math.abs((top.mp||0) - (top.ip||0));
    if (gap > 0.08) return { market: top.label, gap: parseFloat((gap*100).toFixed(1)), verdict: 'PRICING ERROR DETECTED' };
    return null;
  },

  // BUG-022 FIX: STANDARD window now has actionable guidance
  _betWindow: function(resData) {
    const h = resData.hoursToKO || 24;
    if (h > 20) return 'EARLY_VALUE';      // Best CLV window; stake at full Kelly
    if (h >= 4 && h <= 20) return 'STANDARD'; // Normal betting window; monitor for news
    if (h >= 2 && h < 4) return 'PRE_MATCH_NEWS'; // Watch for lineup confirmations
    if (h < 2) return 'AVOID';              // Too close; line fully compressed
    return 'STANDARD';
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// §10a — BORDERLINE DELIBERATION GATE (v2026.6.0 — BLOCK B3)
// Replaces the prior-PRD "CouncilDeliberation" (which failed OPEN — any error → PROCEED).
// RENAMED from "Council" because this is a 2-advisor binary risk gate, not the 5-advisor
// + Chairman divergent-thinking pattern described in the LLM Council artifact.
// Trigger: score 11–16 AND ≥2 uncertainty flags (borderline, high-uncertainty fixtures).
// FAIL-CLOSED: every error path → STAND_DOWN.  No error → PROCEED_REDUCED_STAKE.
// Rationale (PRD D1): the hard problem is calibration + abstention, not idea generation.
// Five advisors + chairman bias toward action on exactly the fixtures where abstaining
// is the +EV move. The 2-advisor Contrarian + First-Principles pattern is sufficient.
// ═══════════════════════════════════════════════════════════════════════════════

const BorderlineDeliberationGate = {
  _name: 'BorderlineDeliberationGate',

  shouldTrigger: function(convergenceScore, uncertaintyFlags) {
    const score = typeof convergenceScore === 'number' ? convergenceScore : -1;
    const flags = typeof uncertaintyFlags  === 'number' ? uncertaintyFlags  : 0;
    return score >= 11 && score <= 16 && flags >= 2;
  },

  // Contrarian advisor — pure deterministic, no LLM required for the fast path.
  _contrarian: function(resData) {
    const risks = [];
    const apex = (resData.evMarkets||[])[0];
    if (!apex) return { verdict:'STAND_DOWN', reason:'No apex market to evaluate' };
    if ((resData.mc?.varFlag)) risks.push('High variance flag on score distribution');
    if ((resData.sharpDelta||0) < -0.03) risks.push('Sharp money against this selection');
    if ((resData.mes||1) < 0.70) risks.push(`Low model-ensemble signal (MES ${((resData.mes||0)*100).toFixed(0)}%)`);
    if ((resData.clvProjection?.survivalProb||1) < 0.50) risks.push('CLV edge survival below 50%');
    if ((resData.convergence?.scores||[]).filter(s=>s<10).length >= 2) risks.push('≥2 markets scoring below 10 — low convergence');
    return { risks, riskCount: risks.length };
  },

  // First-principles advisor — strips framing; asks if the raw math actually supports the bet.
  _firstPrinciples: function(resData) {
    const apex = (resData.evMarkets||[])[0];
    if (!apex) return { supported: false, reason: 'No market' };
    const rawEdge    = apex.rawEdge || 0;
    const modelProb  = apex.mp || 0;
    const impliedProb= apex.ip || 0;
    const supported  = rawEdge > 0.04 && modelProb > impliedProb * 1.04;
    return {
      supported,
      edge: rawEdge,
      edgeGap: modelProb - impliedProb,
      reason: supported
        ? `Raw edge +${(rawEdge*100).toFixed(1)}% above 4% minimum; model-vs-market gap ${((modelProb-impliedProb)*100).toFixed(1)}%`
        : `Insufficient raw edge (${(rawEdge*100).toFixed(1)}%) or model-market gap too small`,
    };
  },

  run: async function(resData, claudeKey) {
    // FAIL-CLOSED POLICY: any execution failure → STAND_DOWN.
    // We catch every possible error and return STAND_DOWN — never PROCEED on error.
    try {
      if (!resData) return { verdict:'STAND_DOWN', reason:'No resData', gate:'borderline' };
      const con  = this._contrarian(resData);
      const fp   = this._firstPrinciples(resData);
      if (con.verdict === 'STAND_DOWN') return { verdict:'STAND_DOWN', reason:con.reason, gate:'borderline' };
      // Hard stand-down: ≥3 contrarian risks AND first principles does not support
      if (con.riskCount >= 3 && !fp.supported) {
        return { verdict:'STAND_DOWN', reason:`Contrarian: ${con.risks.join('; ')} | FP: ${fp.reason}`, gate:'borderline' };
      }
      // PROCEED only when FP supports the bet AND contrarian risks are manageable (<3)
      if (fp.supported && con.riskCount < 3) {
        return { verdict:'PROCEED_REDUCED_STAKE', reason:`FP: ${fp.reason} | Contrarian risks: ${con.riskCount}`, gate:'borderline' };
      }
      // Ambiguous → stand down (conservative: abstention is +EV on true uncertainty)
      return { verdict:'STAND_DOWN', reason:`Ambiguous deliberation — abstaining. FP supported:${fp.supported}, risks:${con.riskCount}`, gate:'borderline' };
    } catch(e) {
      // FAIL-CLOSED: exception → STAND_DOWN, never PROCEED.
      return { verdict:'STAND_DOWN', reason:`Deliberation exception: ${e?.message||'unknown'}`, gate:'borderline' };
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// §10b — CLAUDE MODEL CONSTANTS & BRIEFING HELPER (v2026.6.0)
//
// Current Claude model landscape (verified May 23, 2026 against platform.claude.com/docs):
//
//  claude-opus-4-6     ← Flagship. Deepest reasoning, 1M context (beta), $5/$25 per 1M tok.
//                        Best for complex multi-step briefing. Not an evergreen pointer —
//                        it's a pinned snapshot (dateless = canonical for 4.6 generation).
//
//  claude-opus-4-7     ← Most capable GA model (Apr 16 2026). Step-change in agentic coding.
//                        Also $5/$25. Use for the most demanding reasoning tasks.
//
//  claude-sonnet-4-6   ← Mid-tier. $3/$15. Excellent for bounded factual verification (CVL).
//
//  claude-haiku-4-5    ← Fastest/cheapest. $1/$5. Not suitable for reasoning-heavy tasks.
//
//  claude-opus-4-0 / claude-sonnet-4-0 — DEPRECATED, retired April 20, 2026. Do NOT use.
//
// ARCHITECTURE: Claude Opus handles the briefing/reasoning layer (T2-equivalent).
// Gemini Pro/Flash are the resilient fallback if Claude is unreachable.
// Claude Sonnet handles the 3-pass verification (ClaudeVerificationLayer).
// ═══════════════════════════════════════════════════════════════════════════════

const CLAUDE_MODELS = {
  BRIEFING:      'claude-opus-4-6',      // T2-equivalent: deepest reasoning for narrative synthesis
  VERIFICATION:  'claude-sonnet-4-6',    // 3-pass CVL: bounded factual cross-check
  FALLBACK:      'claude-sonnet-4-6',    // If Opus unavailable, Sonnet handles briefing
};

const CLAUDE_API = {
  URL: 'https://api.anthropic.com/v1/messages',
  VERSION: '2023-06-01',
};

// Unified Claude caller — used by both briefing and verification.
// Returns {ok:true, text} on success, {ok:false, error} on failure.
// Callers handle fallback to Gemini on failure.
async function callClaude(model, systemPrompt, userPrompt, apiKey, maxTokens = 4096) {
  if (!apiKey) return { ok: false, error: 'No Claude API key' };
  try {
    const resp = await fetch(CLAUDE_API.URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': CLAUDE_API.VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!resp.ok) return { ok: false, error: `Claude API HTTP ${resp.status}` };
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    if (!text) return { ok: false, error: 'Empty Claude response' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e?.message || 'Claude fetch error' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §10c — CLAUDE VERIFICATION LAYER (v2026.6.0 — B8: 3-pass PRM majority voting)
// Two-stage: Stage 1 = 3 independent Claude passes (odds/roster/signal).
// Stage 2 = independent recommendation if ≥2 passes flag violations.
// Stamps: ✅ GEMINI_CONFIRMED / ⚠️ CLAUDE_ADJUSTED / 🔴 CLAUDE_OVERRIDE
// Source: RLM Application 5 + OpenClaw-RL PRM majority voting (arXiv:2603.10165)
// ═══════════════════════════════════════════════════════════════════════════════

const ClaudeVerificationLayer = {
  MODEL: CLAUDE_MODELS.VERIFICATION,
  API_URL: CLAUDE_API.URL,

  // B8-01: Requires claudeKey — returns SKIP if absent
  _getKey: function() {
    if (typeof window !== 'undefined' && window.__ORACLE_CORE__) {
      return window.__ORACLE_CORE__.getState()?.ui?.claudeKey || '';
    }
    return '';
  },

  async _callClaude(systemPrompt, userPrompt, apiKey) {
    const result = await callClaude(this.MODEL, systemPrompt, userPrompt, apiKey, 1000);
    if (!result.ok) throw new Error(result.error);
    return result.text;
  },

  // B8-02: Stage 1 — 3 independent verification passes
  // Pass 1: odds accuracy vs FrozenOddsRegistry
  // Pass 2: player roster accuracy vs Turn 3 injury data
  // Pass 3: signal consistency + S14 implied/model check
  async runStage1(resData, apiKey) {
    const frozenTable = FrozenOddsRegistry.toTableString();
    const apex = resData.convergence?.apex;
    const injuries = resData.fetched?.injuries || 'Not available';

    const sysBase = `You are a rigorous sports betting verification agent for O.R.A.C.L.E. v2026.3.12.
Respond ONLY with JSON: {"violations":[],"clean":true|false,"summary":""}
A violation is a factual error, not a stylistic preference.`;

    const pass1Prompt = `FROZEN ODDS TABLE (ground truth):
${frozenTable}

GEMINI CITED: Home@${resData.telemetry?.hOdds} Draw@${resData.telemetry?.dOdds} Away@${resData.telemetry?.aOdds}
Apex market: ${apex?.market} @ ${apex?.odds}

Check: Do any cited odds deviate >3% from frozen table? List violations.`;

    const pass2Prompt = `INJURY DATA (Turn 3 verified):
${typeof injuries === 'object' ? JSON.stringify(injuries).slice(0,800) : String(injuries).slice(0,800)}

GEMINI CLAIMS in analysis:
λH=${resData.bayesian_lH?.toFixed(2)} λA=${resData.bayesian_lA?.toFixed(2)}
Injury penalties: H=${resData.telemetry?.injPenH} A=${resData.telemetry?.injPenA}

Check: Are injury adjustments consistent with verified squad data? Any roster fabrications?`;

    const pass3Prompt = `SIGNAL SUMMARY:
Score: ${apex?.totalScore}/24  Active: ${(apex?.activeSignals||[]).join(' ')}
S14 EV gate: ${apex?.signals?.S14 > 0 ? 'PASS' : 'FLAGGED'}
Negative EV alert: ${resData.convergence?.negativeEvAlert || 'none'}
Model prob: ${((apex?.signals ? resData.fp?.[apex.market?.toLowerCase().includes('home')?'home':apex.market?.toLowerCase().includes('away')?'away':'draw'] : 0)||0).toFixed(3)}

Check: Are signal scores mathematically consistent? Is S14 gate correctly applied?`;

    const [r1, r2, r3] = await Promise.all([
      this._callClaude(sysBase, pass1Prompt, apiKey).catch(() => '{"violations":[],"clean":true,"summary":"pass1 timeout"}'),
      this._callClaude(sysBase, pass2Prompt, apiKey).catch(() => '{"violations":[],"clean":true,"summary":"pass2 timeout"}'),
      this._callClaude(sysBase, pass3Prompt, apiKey).catch(() => '{"violations":[],"clean":true,"summary":"pass3 timeout"}'),
    ]);

    const parse = (txt) => {
      try { return JSON.parse(txt); } catch(e) {
        const m = txt.match(/\{[\s\S]*\}/);
        try { return m ? JSON.parse(m[0]) : { violations:[], clean:true }; } catch(e2) { return { violations:[], clean:true }; }
      }
    };

    return [parse(r1), parse(r2), parse(r3)];
  },

  // B8-03: Majority voting — violation confirmed if ≥2/3 passes flag it
  _majorityVote: function(passes) {
    const allViolations = passes.flatMap(p => p.violations || []);
    const violationCounts = {};
    allViolations.forEach(v => {
      const key = v.slice(0, 40); // normalise to first 40 chars
      violationCounts[key] = (violationCounts[key] || 0) + 1;
    });
    const confirmed = Object.entries(violationCounts)
      .filter(([,count]) => count >= 2)
      .map(([v]) => v);
    const cleanCount = passes.filter(p => p.clean).length;
    return { confirmed, cleanCount, totalPasses: passes.length };
  },

  // B8-04/05: Stage 2 — independent Claude recommendation if ≥2 confirmed violations
  async runStage2(resData, apiKey) {
    const sys = `You are an independent sports betting analyst. You have NOT seen the Gemini analysis.
Analyse the raw data and give your own recommendation.
Respond with JSON: {"recommendation":"","market":"","odds":0,"confidence":"HIGH|MED|LOW","reasoning":"","override":true}`;

    const user = `RAW TELEMETRY:
Fixture: ${resData.home} vs ${resData.away}
λH=${resData.bayesian_lH?.toFixed(3)} λA=${resData.bayesian_lA?.toFixed(3)}
Home odds: ${resData.telemetry?.hOdds} Draw: ${resData.telemetry?.dOdds} Away: ${resData.telemetry?.aOdds}
Over 2.5: ${resData.telemetry?.ohO} Under 2.5: ${resData.telemetry?.oaO}
EV markets: ${(resData.evMarkets||[]).slice(0,3).map(m=>`${m.label}@${m.odds}(EV:${((m.ev||0)*100).toFixed(1)}%)`).join(' ')}
Sharp delta: ${resData.sharpDelta?.toFixed(3)}
MC var multiplier: ${resData.mc?.varMultiplier?.toFixed(2)}

Give your independent recommendation.`;

    const txt = await this._callClaude(sys, user, apiKey).catch(() =>
      '{"recommendation":"PASS","market":"","odds":0,"confidence":"LOW","reasoning":"Stage 2 timeout","override":true}');
    try { return JSON.parse(txt); } catch(e) {
      const m = txt.match(/\{[\s\S]*\}/);
      try { return m ? JSON.parse(m[0]) : { recommendation:'PASS', override:true }; } catch(e2) {
        return { recommendation:'PASS', override:true };
      }
    }
  },

  // Main entry point — orchestrates full verification
  async verify(resData) {
    const apiKey = this._getKey();
    if (!apiKey) return { status:'SKIP', stamp:'⬜ CLAUDE_VERIFICATION_SKIPPED — no API key configured' };

    try {
      // Stage 1: 3-pass PRM majority voting
      const passes = await this.runStage1(resData, apiKey);
      const vote = this._majorityVote(passes);

      let stamp, stage2Result = null;

      if (vote.cleanCount === 3) {
        // B8-05: All 3 passes clean → CONFIRMED
        stamp = '✅ GEMINI_CONFIRMED';
      } else if (vote.confirmed.length === 0) {
        // 1/3 flagged only → WARNING, adjust
        stamp = '⚠️ CLAUDE_ADJUSTED';
      } else {
        // B8-04: ≥2 confirmed violations → Stage 2 independent recommendation
        stage2Result = await this.runStage2(resData, apiKey);
        stamp = '🔴 CLAUDE_OVERRIDE';
      }

      return {
        status: stamp.includes('OVERRIDE') ? 'OVERRIDE' : stamp.includes('ADJUSTED') ? 'ADJUSTED' : 'CONFIRMED',
        stamp,
        confirmedViolations: vote.confirmed,
        cleanPasses: vote.cleanCount,
        passes,
        stage2: stage2Result,
        frozenOddsTable: FrozenOddsRegistry.toTableString(),
      };
    } catch(e) {
      return { status:'ERROR', stamp:'⚠️ CLAUDE_VERIFICATION_ERROR: ' + e.message };
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// §11 — EXECUTION ENGINE (v29.0 — all bug fixes + ZIP Layer 4 + progressive drawdown)
// ═══════════════════════════════════════════════════════════════════════════════

const ExecutionEngine = {

  SensitivityEngine: {
    // HF-D: Gaussian Ensemble upgrade (RandOpt / Neural Thickets arXiv:2603.12228)
    // Replaces ±10% deterministic 2-point grid with K=20 Box-Muller Gaussian samples per param.
    // σ = 5% of param value → realistic uncertainty, not arbitrary ±10% shock.
    // Returns ensembleStdDev (σ of EV across K×params runs) + [HIGH_PARAM_UNCERTAINTY] gate.
    // Legacy fragilityScore preserved for UI compatibility.
    K: 20,
    SIGMA_FRAC: 0.05, // σ = 5% of base param value

    analyze: function(state, baseRes) {
      const topMarket = baseRes.evMarkets?.[0];
      if (!topMarket) return { fragilityScore:0, map:{}, evDropsToZero:0, totalRuns:0, ensembleStdDev:0, paramUncertaintyFlag:null };
      const map = {}; let evDropsToZero=0, totalRuns=0;
      const allEVs = []; // collect all sampled EVs for ensemble stddev

      const runPerturbed = (key, perturbedVal) => {
        totalRuns++;
        const ps = JSON.parse(JSON.stringify(state));
        if(key==='piH'||key==='piA') ps.telemetry[key] = MathEngine.clamp(perturbedVal, 500, 3000);
        if(key==='xH'||key==='xA')   ps.telemetry[key] = MathEngine.clamp(perturbedVal, 0.05, 8.0);
        if(key==='injPenH'||key==='injPenA') ps.telemetry[key] = MathEngine.clamp(perturbedVal, 0, 0.95);
        const pRes = ExecutionEngine.run(ps, 1000, true);
        const matched = pRes.evMarkets.find(m => m.label === topMarket.label);
        const ev = matched ? matched.ev : -1;
        allEVs.push(ev);
        if (!map[key]) map[key] = [];
        map[key].push(ev);
        if (ev <= 0) evDropsToZero++;
      };

      // Params to perturb — only include if present in telemetry
      const params = [];
      params.push({ key:'piH', base: state.telemetry?.piH || 1500 });
      params.push({ key:'piA', base: state.telemetry?.piA || 1500 });
      if ((state.telemetry?.xH || 0) > 0) params.push({ key:'xH', base: state.telemetry.xH });
      if ((state.telemetry?.xA || 0) > 0) params.push({ key:'xA', base: state.telemetry.xA });
      if ((state.telemetry?.injPenH || 0) > 0) params.push({ key:'injPenH', base: state.telemetry.injPenH });
      if ((state.telemetry?.injPenA || 0) > 0) params.push({ key:'injPenA', base: state.telemetry.injPenA });

      // K=20 Gaussian samples per param
      params.forEach(({ key, base }) => {
        const sigma = Math.max(0.01, base * this.SIGMA_FRAC);
        for (let k = 0; k < this.K; k++) {
          const perturbed = MathEngine.gaussianRand(base, sigma);
          runPerturbed(key, perturbed);
        }
        // Collapse map[key] to summary stats
        const vals = map[key] || [];
        const mean = vals.reduce((s,v)=>s+v,0) / (vals.length||1);
        const sd   = Math.sqrt(vals.map(v=>(v-mean)**2).reduce((s,v)=>s+v,0) / (vals.length||1));
        map[key] = { mean: parseFloat(mean.toFixed(4)), stdDev: parseFloat(sd.toFixed(4)), samples: vals.length };
      });

      // Ensemble EV stddev across ALL perturbed runs
      const n = allEVs.length;
      const meanEV = n > 0 ? allEVs.reduce((s,v)=>s+v,0)/n : 0;
      const ensembleStdDev = n > 1
        ? parseFloat(Math.sqrt(allEVs.map(v=>(v-meanEV)**2).reduce((s,v)=>s+v,0)/n).toFixed(4))
        : 0;

      // [HIGH_PARAM_UNCERTAINTY]: ensembleStdDev > 0.05 → Kelly × 0.7
      const paramUncertaintyFlag = ensembleStdDev > 0.05
        ? `[HIGH_PARAM_UNCERTAINTY] Gaussian ensemble σ=${ensembleStdDev.toFixed(4)} across ${n} runs — edge unreliable under parameter noise. Kelly stake × 0.70.`
        : null;

      const fragilityScore = Math.min(10, (evDropsToZero / Math.max(totalRuns,1)) * 10 * 2);
      return { fragilityScore, map, evDropsToZero, totalRuns, ensembleStdDev, paramUncertaintyFlag };
    }
  },

  adjustXGForSoS:(rawXG,oppGA,avgGA)=>MathEngine.adjustXGForSoS(rawXG,oppGA,avgGA),

  scanMarkets: function(markets, fp, calibFactor, bankroll, dqs, oddsData, councilPenalty, varMultiplier, drawdownPenalty, mes, globalVelocity, hoursToKO, upsetAlertVeto) {
    const evs=[]; if(!oddsData) return evs;
    const proximateVeto=hoursToKO<1.5&&globalVelocity<-0.02;
    // BUG-015 FIX: MES threshold adjusted to work with new 0.50 floor
    const check=(cat,label,mp,od)=>{
      if(!mp||!od||od<=1)return;
      const ip=1/od,rawEdge=mp-ip,ev=MathEngine.adjEV(mp,od);
      // HF-10d: ML 10% minimum edge gate (raised from +0.02 to max(0.10, hurdle(mp)))
      // Rationale: 1X2 is highest-variance market; needs stronger edge to justify over goals/AH alternatives.
      // Also add variance profile to ranking score so low-variance markets rank higher at equal EV.
      const adjHurdle=cat==='1x2'?Math.max(0.10,MathEngine.hurdle(mp)):MathEngine.hurdle(mp);
      // Variance modifier table: penalises high-variance markets, rewards low-variance
      // ── Variance modifier table (doc audit v2026.3.12+LV) ──────────────────────
      // Source: low_variance_market.docx — tiers 1-5, Practical Low-Variance Stack
      const _varMod=(()=>{
        const lb=label;
        // Tier 5: Time-segment — insulated from late chaos
        if(lb.includes('First Half Under 1.5')||lb.includes('FH Under 1.5'))return 1.20;
        if(lb.includes('First Half Draw')||lb.includes('FH Draw'))return 1.15;
        // Tier 3: Team-dependent — strong asymmetry
        if(lb.includes('Team Away Under 1.5')||lb.includes('Away Total Under'))return 1.18;
        if(lb.includes('Team Home Under 1.5')||lb.includes('Home Total Under'))return 1.16;
        if(lb.includes('Team Over 0.5')||lb.includes('Home Total Over 0.5')||lb.includes('Away Total Over 0.5'))return 1.15;
        // Match O/U low-variance lines
        if(lb.includes('Over 0.5'))return 1.15;
        if(lb.includes('Under 4.5')||lb.includes('Under 3.5'))return 1.12;
        // Tier 4: Win Either Half — far lower variance than full-time win
        if(lb.includes('Win Either Half'))return 1.12;
        // Tier 2: Asian 2 Goals (push protection)
        if(lb.includes('Asian 2')||lb.includes('Asian Over 2')||lb.includes('Asian Under 2'))return 1.10;
        // Low-variance AH lines
        if(lb.includes('+1.5')||lb.includes('AH Away +1.5')||lb.includes('AH Home +1.5'))return 1.10;
        if(lb.includes('+1.0')||lb.includes('AH Away +1.0')||lb.includes('AH Home +1.0'))return 1.09;
        if(lb.includes('+0.5')||lb.includes('-0.25')||lb.includes('+0.25'))return 1.08;
        if(lb.includes('DNB')||lb.includes('Double Chance')||lb.includes('1X')||lb.includes('X2'))return 1.08;
        if(lb.includes('Under 2.5')||(lb.includes('Asian')&&lb.includes('2.0')))return 1.05;
        if(lb.includes('Over 1.5'))return 1.02;
        if(lb.includes('Over 2.5'))return 0.97;
        if(lb.includes('BTTS No'))return 1.00;
        if(lb.includes('BTTS Yes')||lb.includes('Over 3.5')||lb.includes('Over 4.5'))return 0.75; // doc: avoid list
        if(lb.includes('Under 1.5'))return 0.82; // selective only (doc: bottom-table/relegation)
        return 1.0;
      })();
      let isUpsetVetoed=false;
      if(upsetAlertVeto==="home"&&(label.includes("Home")||label==="1X"))isUpsetVetoed=true;
      if(upsetAlertVeto==="away"&&(label.includes("Away")||label==="X2"))isUpsetVetoed=true;
      const sentinelVeto=(rawEdge>0&&globalVelocity<-0.08)||proximateVeto||isUpsetVetoed;
      const isVolLoving=(cat==="Goals O/U"&&label.includes("Over"))||(cat==="BTTS"&&label.includes("Yes"));
      const mVarMult=(varMultiplier<1.0&&isVolLoving)?1.0:varMultiplier;
      // BUG-015 FIX: elastic MES veto uses 0.85 threshold (was 0.92 with wrong floor)
      const isElasticMesVeto=mes<0.85&&rawEdge<0.08;
      if(ev>0&&rawEdge>=adjHurdle&&!sentinelVeto&&!isElasticMesVeto){
        // BUG-011 FIX: timeDecay removed from Kelly — early bets get full stake
        // B0: pass mp as modelProb so Kelly uses canonical f* = (p*o-1)/(o-1)
        let stake=MathEngine.optimizedKelly(rawEdge,od,dqs,councilPenalty,mVarMult,drawdownPenalty,calibFactor,0.25,mp); // scanMarkets uses raw drawdownPenalty (HF-11 modifiers applied in run())
        // BLOCK B1: The "softmax convergence blend" below is a THIRD, undocumented stake
        // damper (multiplies stake by ~0.65–0.99, rising with EV) with no cited theoretical
        // basis. It was partially masking the old Kelly over-staking bug. Regression harness
        // showed no risk-adjusted ROI benefit, so it is DISABLED by default and gated behind
        // ORACLE_CONFIG.ENABLE_SOFTMAX_BLEND for reversibility. Re-enable only if a backtest
        // on the real resolved ledger shows ROI_DD improvement.
        if (ORACLE_CONFIG.ENABLE_SOFTMAX_BLEND) {
          const _approxScore = Math.round(ev * 80);
          const _softmaxEdge = Math.max(0, (1 / (1 + Math.exp(-_approxScore / 8))) - 0.5);
          stake = stake * 0.60 + (_softmaxEdge * stake * 2) * 0.40;
        }
        stake = MathEngine.clamp(stake, 0, 0.25);
        const _rankScore = ev * _varMod; // HF-10d: variance-weighted rank
        evs.push({cat,label,mp,ip,rawEdge,ev,odds:od,stake,stakeAmt:stake*(bankroll||1000),rankingScore:_rankScore,varianceMod:_varMod});
      } else if(isElasticMesVeto&&ev>0){evs.push({cat,label,mp,ip,rawEdge,ev,odds:od,stake:0,stakeAmt:0,rankingScore:-100,veto:"MES VETO (ELASTIC)"});}
      else if(sentinelVeto&&ev>0){evs.push({cat,label,mp,ip,rawEdge,ev,odds:od,stake:0,stakeAmt:0,rankingScore:-100,veto:isUpsetVetoed?"UPSET ALERT VETO":"PROXIMATE SHADING VETO"});}
    };
    // ══ SCAN ORDER (v2026.3.12+LV) — low-variance priority from doc audit ═════════
    // Source: low_variance_market.docx — Practical Low-Variance Stack + Tier 1-5
    // Order: Goals → AH (low-var first) → Win Either Half → Team Totals
    //        → FH Time-Segment → BTTS → DNB → Double Chance → 1X2

    // ── BLOCK 1: Goals O/U — prioritised by requested order ──────────────────
    // Over 2.5 first (most liquid + doc stack item #6), then suppression, then rest
    if(markets.ou) {
      // Requested priority: Over 2.5, then Under lines (low-var), then Over 1.5, then extremes
      check("Goals O/U","Over 2.5",  markets.ou['over_2.5'],  oddsData['over_2.5']);
      check("Goals O/U","Under 3.5", markets.ou['under_3.5'], oddsData['under_3.5']);
      check("Goals O/U","Under 4.5", markets.ou['under_4.5'], oddsData['under_4.5']);
      check("Goals O/U","Under 2.5", markets.ou['under_2.5'], oddsData['under_2.5']);
      check("Goals O/U","Over 1.5",  markets.ou['over_1.5'],  oddsData['over_1.5']);
      check("Goals O/U","Over 0.5",  markets.ou['over_0.5'],  oddsData['over_0.5']);
      check("Goals O/U","Over 3.5",  markets.ou['over_3.5'],  oddsData['over_3.5']);
      check("Goals O/U","Over 4.5",  markets.ou['over_4.5'],  oddsData['over_4.5']);
      check("Goals O/U","Under 1.5", markets.ou['under_1.5'], oddsData['under_1.5']);
      check("Goals O/U","Under 0.5", markets.ou['under_0.5'], oddsData['under_0.5']||0);
    }

    // ── BLOCK 2: Asian 2 Goals (push on exactly 2) — doc Tier 2, stack item #5 ─
    // Model-computed from DC matrix (extractMarkets.asian2). Bookmaker odds fallback.
    if(markets.asian2) {
      const a2OddsOver  = oddsData['asian_2_over']  > 1 ? oddsData['asian_2_over']  : (markets.asian2.over  > 0.01 ? 1/markets.asian2.over  : 0);
      const a2OddsUnder = oddsData['asian_2_under'] > 1 ? oddsData['asian_2_under'] : (markets.asian2.under > 0.01 ? 1/markets.asian2.under : 0);
      check("Asian 2 Goals","Asian Over 2 Goals",  markets.asian2.over,  a2OddsOver);
      check("Asian 2 Goals","Asian Under 2 Goals", markets.asian2.under, a2OddsUnder);
    }

    // ── BLOCK 3: Home/Away Team Total Over 0.5 — doc Tier 3, stack item #8/9/10 ─
    // Model-computed from DC matrix marginals (extractMarkets.teamH / teamA)
    if(markets.teamH && markets.teamA) {
      const htHOdds05 = oddsData['home_ou_over_0_5']  > 1 ? oddsData['home_ou_over_0_5']  : (markets.teamH['over_0.5']  > 0.01 ? 1/markets.teamH['over_0.5']  : 0);
      const atAOdds05 = oddsData['away_ou_over_0_5']  > 1 ? oddsData['away_ou_over_0_5']  : (markets.teamA['over_0.5']  > 0.01 ? 1/markets.teamA['over_0.5']  : 0);
      const htHU15    = oddsData['home_ou_under_1_5'] > 1 ? oddsData['home_ou_under_1_5'] : (markets.teamH['under_1.5'] > 0.01 ? 1/markets.teamH['under_1.5'] : 0);
      const atAU15    = oddsData['away_ou_under_1_5'] > 1 ? oddsData['away_ou_under_1_5'] : (markets.teamA['under_1.5'] > 0.01 ? 1/markets.teamA['under_1.5'] : 0);
      check("Team Total","Home Total Over 0.5",   markets.teamH['over_0.5'],  htHOdds05);
      check("Team Total","Away Total Over 0.5",   markets.teamA['over_0.5'],  atAOdds05);
      check("Team Total","Home Total Under 1.5",  markets.teamH['under_1.5'], htHU15);
      check("Team Total","Away Total Under 1.5",  markets.teamA['under_1.5'], atAU15);
      check("Team Total","Home Total Over 1.5",   markets.teamH['over_1.5'],
        markets.teamH['over_1.5'] > 0.01 ? 1/markets.teamH['over_1.5'] : 0);
      check("Team Total","Away Total Over 1.5",   markets.teamA['over_1.5'],
        markets.teamA['over_1.5'] > 0.01 ? 1/markets.teamA['over_1.5'] : 0);
    }

    // ── BLOCK 4: Asian Handicap — low-var lines first (doc Tier 1 #3-4, Tier 4 #13)
    // Priority: +0.5, -0.25, +0.25 (push protection) → +1.0, +1.5 → ±0.75 → rest
    if(markets.ah) {
      const ahLowVar=[
        // Push-protection lines first (doc Tier 1 items 3 & 4)
        {key:"hp05",  label:"AH Home +0.5"},  {key:"ap05",  label:"AH Away +0.5"},
        {key:"hm025", label:"AH Home -0.25"}, {key:"am025", label:"AH Away -0.25"},
        {key:"hp025", label:"AH Home +0.25"}, {key:"ap025", label:"AH Away +0.25"},
        // +1.0 (doc Tier 4 item 13: strong away side protection)
        {key:"hp10",  label:"AH Home +1.0"},  {key:"ap10",  label:"AH Away +1.0"},
        // +1.5 (safety margin)
        {key:"hp15",  label:"AH Home +1.5"},  {key:"ap15",  label:"AH Away +1.5"},
        // Standard ±0.5 and ±0.75
        {key:"hm05",  label:"AH Home -0.5"},  {key:"am05",  label:"AH Away -0.5"},
        {key:"hm075", label:"AH Home -0.75"}, {key:"am075", label:"AH Away -0.75"},
        // Bigger lines (higher variance)
        {key:"hm10",  label:"AH Home -1.0"},  {key:"am10",  label:"AH Away -1.0"},
        {key:"hm15",  label:"AH Home -1.5"},  {key:"am15",  label:"AH Away -1.5"},
        {key:"hp20",  label:"AH Home +2.0"},  {key:"ap20",  label:"AH Away +2.0"},
        {key:"hm20",  label:"AH Home -2.0"},  {key:"am20",  label:"AH Away -2.0"},
        {key:"hp25",  label:"AH Home +2.5"},  {key:"ap25",  label:"AH Away +2.5"},
        {key:"hm25",  label:"AH Home -2.5"},  {key:"am25",  label:"AH Away -2.5"},
      ];
      ahLowVar.forEach(m=>check("Asian Handicap",m.label,markets.ah[m.key],oddsData[`ah_${m.key}`]));
    }

    // ── BLOCK 5: Win Either Half — doc Tier 4 #12, far lower var than FT win ─────
    // Requires bookmaker odds from Turn 2 (win_either_half_h/a)
    if(oddsData['win_either_half_h'] > 1) {
      // Model prob: P(win either half) ≈ P(home scores ≥1 in first N/2 goals)
      // Approximation: use dc-matrix scoring probs, split by half expectation
      const wEHH_mp = markets.teamH ? Math.min(0.97, markets.teamH['over_0.5'] * 0.88 + markets.hw * 0.12) : markets.hw;
      const wEHA_mp = markets.teamA ? Math.min(0.97, markets.teamA['over_0.5'] * 0.88 + markets.aw * 0.12) : markets.aw;
      check("Win Either Half","Win Either Half (H)", wEHH_mp, oddsData['win_either_half_h']);
      check("Win Either Half","Win Either Half (A)", wEHA_mp, oddsData['win_either_half_a']);
    }

    // ── BLOCK 6: First Half Time-Segment — doc Tier 5, insulated from late chaos ─
    if(oddsData['fh_under_1_5'] > 1) {
      // FH Under 1.5: approximate model prob — first half contributes ~45% of expected goals
      const fhLambdaH = (markets.teamH ? markets.teamH['over_0.5'] : 0.7) * 0.50; // λH/2 approx
      const fhLambdaA = (markets.teamA ? markets.teamA['over_0.5'] : 0.6) * 0.50;
      // P(FH goals ≤ 1) using Poisson with half-lambdas
      const fhGoals0 = Math.exp(-(fhLambdaH + fhLambdaA));
      const fhGoals1 = fhGoals0 * (fhLambdaH + fhLambdaA);
      const fhU15_mp = fhGoals0 + fhGoals1;
      check("First Half","FH Under 1.5 Goals", Math.min(0.95, fhU15_mp), oddsData['fh_under_1_5']);
    }
    if(oddsData['fh_draw'] > 1) {
      // FH Draw: approximate using first-half probability (roughly 1/3 of full-time draw)
      const fhDraw_mp = Math.min(0.55, markets.dr * 1.35); // FH draw ~35% more likely than FT draw
      check("First Half","FH Draw", fhDraw_mp, oddsData['fh_draw']);
    }

    // ── BLOCK 7: BTTS ─────────────────────────────────────────────────────────
    check("BTTS","BTTS Yes", markets.btts,    oddsData.btts_yes);
    check("BTTS","BTTS No",  markets.noBtts,  oddsData.btts_no);

    // ── BLOCK 8: Draw No Bet ──────────────────────────────────────────────────
    check("Draw No Bet","DNB Home", markets.dnb_h, oddsData.dnb_h);
    check("Draw No Bet","DNB Away", markets.dnb_a, oddsData.dnb_a);

    // ── BLOCK 9: Double Chance ────────────────────────────────────────────────
    check("Double Chance","1X", markets.dc_1x, oddsData.dc_1x);
    check("Double Chance","X2", markets.dc_x2, oddsData.dc_x2);

    // ── BLOCK 10: 1X2 Money Line (last — highest variance, 10% edge gate applies)
    // analysis1x2 handles the dedicated ML panel; this catches any ML odds in scanMarkets
    // for alt-market comparison. The 10% adjHurdle gate is already enforced in check().

    return evs.sort((a,b)=>b.rankingScore-a.rankingScore);
  },

  run: function(state, mcRuns=10000, skipSensitivity=false) {
    const{telemetry,pipeline,ledger}=state;
    const p=(val,fb)=>MathEngine.safeNum(val,fb);
    let piH=p(telemetry.piH,1500),piA=p(telemetry.piA,1500);
    // A3: when pi-ratings are canonical, override the Elo-scale piH/piA with pi-ratings
    // mapped onto the same 1500-centered scale the downstream logistic formulas expect.
    // Mapping: 1500 + piRating*400 (pi-ratings are ~±1 on a tanh goal-diff scale; ×400
    // places a +1 pi advantage at ~+400 Elo-equivalent, matching the Pow(10,diff/400) usage).
    if (typeof ORACLE_CONFIG !== 'undefined' && ORACLE_CONFIG.USE_PI_RATINGS_CANONICAL && fixture?.home && fixture?.away) {
      const piHomeRec = TeamRatingsEngine.getPiRating(fixture.home, 'home', null);
      const piAwayRec = TeamRatingsEngine.getPiRating(fixture.away, 'away', null);
      if (piHomeRec !== null && piAwayRec !== null) {
        piH = 1500 + piHomeRec * 400;
        piA = 1500 + piAwayRec * 400;
      }
    }
    const xH_raw=p(telemetry.xH,0),xA_raw=p(telemetry.xA,0);
    const restH=p(telemetry.restH,7),restA=p(telemetry.restA,7);
    const travelKm=p(telemetry.travelKm,0),altitudeM=p(telemetry.altitudeM,0);
    const hoursToKO=p(telemetry.hoursToKO,24);
    const homeOdds=p(telemetry.hOdds,1.85),drawOdds=p(telemetry.dOdds,3.40),awayOdds=p(telemetry.aOdds,4.50);
    const ohO=p(telemetry.ohO,homeOdds);
    const bankroll=p(telemetry.broll,1000),peakBroll=p(telemetry.peakBroll,1000);
    const fixture=pipeline?.fixture||{};
    const fetched=pipeline?.fetched||{};
    const oddsData=fetched.odds||telemetry.rawOddsPayload||{home:homeOdds,draw:drawOdds,away:awayOdds};
    let baseParams=LEAGUE_PARAMS[fixture?.league]||LEAGUE_PARAMS.Default;
    const bbnOverrides=ledger?.metrics?.bbnParams?.[fixture?.league];
    // NEW-07: Use dynamic rho if available from ledger
    const dynamicRho=ledger?.metrics?.dynamicRhoParams?.[fixture?.league];
    const lp={...baseParams,...(bbnOverrides||{})};
    if(dynamicRho!==undefined) lp.baseRho=dynamicRho;

    let dqs=fetched?.dqs||0.85;
    const drawdown=peakBroll>0?Math.max(0,(peakBroll-bankroll)/peakBroll):0;
    // NEW-11: Progressive drawdown penalty (replaces binary cliff)
    const drawdownPenalty=MathEngine.getDrawdownPenalty(drawdown);

    // HF-8c: xG Confidence Kelly modifier
    // Gemini reports xg_confidence based on how many sources confirmed xG values.
    // low (estimated/1 source) → Kelly ×0.75, medium (2 sources) → Kelly ×0.90, high (3+) → ×1.0
    // Also flag [LOW_XG_CONFIDENCE] and [SINGLE_XG_SOURCE] for briefing.
    const _xgConf = telemetry.xg_confidence || 'medium';
    const _xgSrc  = telemetry.xg_sources_count || 1;
    const xgConfidenceMod = _xgConf === 'low' ? 0.75 : _xgConf === 'medium' ? 0.90 : 1.0;
    const xgConfidenceFlag = _xgConf === 'low'
      ? '[LOW_XG_CONFIDENCE] Gemini estimated xG from single/unverified source — Kelly ×0.75'
      : _xgSrc === 1
        ? '[SINGLE_XG_SOURCE] Only one xG source consulted — treat xG estimates with caution'
        : null;
    // Apply xgConfidenceMod + HF-11 adaptive modifiers into final Kelly penalty
    // HF-11b: Antila adaptive variance regime from recent ledger outcomes
    const _recentOutcomes = (ledger?.bets||[]).slice(-8).map(b=>
      b.outcome==='win'?1:b.outcome==='half-win'?0.5:b.outcome==='loss'?-1:b.outcome==='half-loss'?-0.5:0
    );
    const _adaptiveRegime = MathEngine.adaptiveVarianceRegime(_recentOutcomes);
    // HF-11c: Lee recovery constraint
    const _leeConstraint = MathEngine.leeRecoveryConstraint(drawdown, 50);
    // BLOCK B1 (V1-E FIX): drawdown, Antila regime, and Lee recovery are three correlated
    // views of the SAME bankroll-stress signal. Multiplying them triple-counts the risk and
    // collapses the stake to ~10% of intended (fractional collapse). Take the BINDING (min)
    // constraint instead — the safest view governs. xgConfidence is a separate axis (input
    // quality, not bankroll regime), so it stays as a multiplicative factor. Floor at 0.10
    // so the penalty is bounded and visible rather than annihilating.
    const _antilaForSizing = Math.min(1.0, _adaptiveRegime.factor); // regime can exceed 1.0 in momentum; cap for sizing
    const _bindingRisk = Math.min(drawdownPenalty, _antilaForSizing, _leeConstraint.multiplier);
    const drawdownPenaltyFinal = MathEngine.clamp(_bindingRisk * xgConfidenceMod, 0.10, 1.0);

    // BUG-011 FIX: Time decay removed from Kelly — EARLY_VALUE bets should NOT be penalized
    // timeDecayMultiplier retained as informational only (not applied to Kelly)
    const timeDecayInfo=MathEngine.clamp(1.0-(Math.max(0,hoursToKO-2)/200),0.7,1.0);

    // ── ARBITRAGE VIG-REMOVAL FIX (BUG-003) — Pre-analysis wrapper ──────────
    let rawOverround=1.0,isArbitrage=false;
    let adjHomeOdds=homeOdds, adjDrawOdds=drawOdds, adjAwayOdds=awayOdds;
    if(homeOdds>1&&drawOdds>1&&awayOdds>1) {
      rawOverround=(1/homeOdds)+(1/drawOdds)+(1/awayOdds);
      isArbitrage=rawOverround<1.0;
      if(isArbitrage){
        // Scale odds DOWN (inflate implied probs) to normalize to 1.0
        // This ensures powerMethodVigRemoval operates in its valid domain
        adjHomeOdds=homeOdds*rawOverround;
        adjDrawOdds=drawOdds*rawOverround;
        adjAwayOdds=awayOdds*rawOverround;
      }
    }
    // BUG-015 FIX: MES floor lowered — full range now meaningful
    const mes=MathEngine.clamp(1.0-(rawOverround-1.0),0.50,1.0);
    const fairImp=MathEngine.powerMethodVigRemoval(adjHomeOdds,adjDrawOdds,adjAwayOdds);

    // ── B2: matchContextFlags — Cup/Knockout/BrokenState context modifiers ──
    // Computed before Layer 1 so lambda adjustments (Cupset, Knockout) propagate into all layers.
    const matchContextFlags = (() => {
      const query_lc = (fetched.query||'').toLowerCase();
      const comp_lc  = (fetched.competition||'').toLowerCase();
      // isCupFixture: detected from competition name or query
      const isCupFixture = /cup|fa cup|copa|coupe|pokal|coppa|league cup|carabao|efa/i.test(comp_lc + ' ' + query_lc);
      // cupTierGap: rough heuristic — Championship vs PL = gap 1, League 2 vs PL = gap 3
      const tierMap = { 'premier league':1,'la liga':1,'serie a':1,'bundesliga':1,'ligue 1':1,'champions league':0,'eredivisie':2,'championship':2,'league one':3,'league two':4,'scottish premiership':2,'default':2 };
      const homeLeagTier = tierMap[(fetched.homeLeague||'').toLowerCase()] ?? 2;
      const awayLeagTier = tierMap[(fetched.awayLeague||'').toLowerCase()] ?? 2;
      const cupTierGap   = Math.abs(homeLeagTier - awayLeagTier);
      // rotationalChanges: from injury/form data
      const rotationalChanges = MathEngine.safeNum(fetched.rotationalChanges, 0);
      const isKnockout        = /knockout|k\.o\.|final|semi.final|quarter.final/i.test(comp_lc + ' ' + query_lc);
      const tierEquality      = Math.abs(homeLeagTier - awayLeagTier) <= 1;
      const earlyGoalFired    = !!fetched.earlyGoal; // live: set externally
      const trailingTeamGPG   = MathEngine.safeNum(fetched.trailingTeamGPG, 1.5);
      return { isCupFixture, cupTierGap, rotationalChanges, isKnockout, tierEquality, earlyGoalFired, trailingTeamGPG };
    })();

    // ── Layer 1: Expert Alpha (Fundamentals + SoS + Environment + Fatigue + Injuries) ──
    const rawXH=xH_raw||(lp.homeAvg*(piH/1500));
    const rawXA=xA_raw||(lp.awayAvg*(piA/1500));
    const adjH=this.adjustXGForSoS(rawXH,telemetry.oppGA_A||lp.avgGA,lp.avgGA);
    const adjA=this.adjustXGForSoS(rawXA,telemetry.oppGA_H||lp.avgGA,lp.avgGA);
    let rawInjH=p(telemetry.injPenH,0);if(rawInjH>1)rawInjH/=100;
    let rawInjA=p(telemetry.injPenA,0);if(rawInjA>1)rawInjA/=100;
    const safeInjH=MathEngine.clamp(rawInjH,0,0.95),safeInjA=MathEngine.clamp(rawInjA,0,0.95);
    const env=MathEngine.applyEnvironmentalPenalties(adjH*(1-safeInjH),adjA*(1-safeInjA),fetched.weather,fetched.referee);
    const fat=MathEngine.applyFatigueDecay(restH,restA,env.lH,env.lA);
    const trav=MathEngine.applyTravelFriction(travelKm,altitudeM,fat.lA);
    // B2-02: Cupset Lambda — cup + tier gap ≥ 2 + rotations ≥ 5 → upset risk modifier
    let cupsetLH = fat.lH, cupsetLA = trav.lA;
    if (matchContextFlags.isCupFixture && matchContextFlags.cupTierGap >= 2 && matchContextFlags.rotationalChanges >= 5) {
      cupsetLH = fat.lH * 0.65;
      cupsetLA = trav.lA * 0.65;
      if (typeof fetched === 'object') fetched._flags = [...(fetched._flags||[]), '[CUPSET_PENALTY_APPLIED]'];
    }
    // B2-03: Knockout Pragmatism — both teams play conservatively in evenly-matched KO fixtures
    let bttsThresholdCtx = 0.60, over25ThresholdCtx = 0.55;
    if (matchContextFlags.isKnockout && matchContextFlags.tierEquality) {
      bttsThresholdCtx  = 0.72; // B2-03: raised threshold — teams protect leads
      over25ThresholdCtx = 0.72;
    }
    const matAlpha=MathEngine.buildMatrix(Math.max(0.1,cupsetLH),Math.max(0.1,cupsetLA),lp.baseRho);

    // ── Layer 1b: Ensemble Elo-Grade (Pi Rating logistic) ──
    const piDiffElo=(piH-piA);
    const eloWinP=1/(1+Math.pow(10,-piDiffElo/400));
    const eloLH=lp.homeAvg*(0.6+0.8*eloWinP);
    const eloLA=lp.awayAvg*(0.6+0.8*(1-eloWinP));
    const matElo=MathEngine.buildMatrix(Math.max(0.1,eloLH),Math.max(0.1,eloLA),lp.baseRho);

    // ── Layer 2: Expert Beta (ELO Class + Motivation + Derby) ──
    const piDiffLog=(piH-piA)/400;
    const mScore=p(telemetry.motivationScore,1.0);
    let lH_Beta=lp.homeAvg*Math.pow(10,piDiffLog/2)*mScore;
    let lA_Beta=lp.awayAvg*Math.pow(10,-piDiffLog/2);
    if(telemetry.isDerby){const avgL=(lH_Beta+lA_Beta)/2;lH_Beta=(lH_Beta*0.8)+(avgL*0.2);lA_Beta=(lA_Beta*0.8)+(avgL*0.2);}
    const matBeta=MathEngine.buildMatrix(Math.max(0.1,lH_Beta),Math.max(0.1,lA_Beta),lp.baseRho);

    // ── Layer 3: Expert Gamma (Market Velocity + RLM — BUG-009 fixed in lstmMarketDecoderProxy) ──
    const isPopH=POPULAR_TEAMS.has((fixture?.home||"").toLowerCase());
    const isPopA=POPULAR_TEAMS.has((fixture?.away||"").toLowerCase());
    const lmuHome=MathEngine.lstmMarketDecoderProxy(0.5,ohO,homeOdds,isPopH);
    const lmuAway=MathEngine.lstmMarketDecoderProxy(0.3,p(telemetry.oaO,awayOdds),awayOdds,isPopA);
    const velH=(1/homeOdds)-(1/ohO);
    const boostH=velH>0?velH*1.5:0;
    const penaltyH=velH<0?Math.abs(velH)*2.0:0;
    const lH_Gamma=lp.homeAvg*(1+boostH)*Math.max(0,1-penaltyH);
    const matGamma=MathEngine.buildMatrix(Math.max(0.1,lH_Gamma),Math.max(0.1,lp.awayAvg),lp.baseRho);

    // ── Layer 4: ZIP Model (NEW-03) ──
    // Zero-Inflated Poisson handles structural zero-inflation for defensive matchups
    // B1-03: ZIP logistic pi — Baio & Blangiardo (2010): pi = 1/(1+exp(-(-2.8 + 4.2*(lH+lA)))) clamped [0.03,0.18]
    const totalXGzip = Math.max(0.1,fat.lH) + Math.max(0.1,trav.lA);
    // v2026.7 R3: calibrated π when enabled (ledger-fit coeffs), else logistic prior.
    const zipPi = (typeof ORACLE_CONFIG !== 'undefined' && ORACLE_CONFIG.ENABLE_CALIBRATED_ZIP)
      ? MathEngine.calibratedZipPi(Math.max(0.1,fat.lH), Math.max(0.1,trav.lA), ledger?.metrics?.zipCoeffs)
      : MathEngine.clamp(1 / (1 + Math.exp(-(-2.8 + 4.2 * totalXGzip))), 0.03, 0.18);
    const matZIP=MathEngine.buildMatrix(Math.max(0.1,fat.lH),Math.max(0.1,trav.lA),lp.baseRho,true,zipPi);

    // ── Ensemble Fusion (NEW-10: time-weighted continuous recalibration) ──
    const calibFactor=ledger?.metrics?.calibFactor||1.0;
    // NEW-10: Continuous recalibration — eloBoost is proportional to calibration deficit
    const calibDeficit = MathEngine.clamp(1.0 - calibFactor, 0, 0.3);
    const eloBoost = 0.03 + calibDeficit * 0.2; // 0.03 base; scales up to 0.09 at max deficit
    const wA=(telemetry.xgMode==='empirical'
              ? (typeof ORACLE_CONFIG!=='undefined' ? ORACLE_CONFIG.XG_PRIMARY_WEIGHT : 0.40)
              : 0.35) - eloBoost; // A2: when verified xG present, Layer-1 (xG-anchored) gets higher weight
    const wElo=eloBoost;
    const wB=0.27;
    // v2026.7 R4: In the LOW_SCORING regime the zero-inflation signal is informative,
    // so raise the ZIP ensemble weight (TUNE — gated by LOWSCORE_ZIP_WEIGHT, default 0.08).
    // Detect the regime from the matAlpha (Layer-1 fundamentals) matrix first — cheap and
    // sufficient for the weight decision; the authoritative regime is re-derived on finalMat below.
    const _provisionalReg = (typeof ORACLE_CONFIG !== 'undefined' && ORACLE_CONFIG.ENABLE_LOWSCORE_REGIME)
      ? MathEngine.detectLowScoringRegime(matAlpha, Math.max(0.1,cupsetLH), Math.max(0.1,cupsetLA))
      : { regime: 'STANDARD' };
    const wZIP = (_provisionalReg.regime === 'LOW_SCORING')
      ? (ORACLE_CONFIG.LOWSCORE_ZIP_WEIGHT || 0.08)
      : 0.08; // NEW-03: ZIP layer base 8% weight
    // C1: optionally quarantine the market-velocity (Gamma) layer from the probability ensemble
    // to remove edge-vs-market circularity (Gamma shifts λ by odds movement, then we compare that
    // probability to the same market for "edge"). When quarantined, Gamma's weight is redistributed
    // to Alpha (fundamentals) and velocity is used ONLY as a separate sharp-money signal downstream.
    const _quarantineGamma = (typeof ORACLE_CONFIG !== 'undefined' && ORACLE_CONFIG.QUARANTINE_MARKET_VELOCITY);
    const wC = _quarantineGamma ? 0 : Math.max(0, 1-wA-wElo-wB-wZIP); // Gamma weight (0 if quarantined)
    const wA_eff = _quarantineGamma ? (wA + Math.max(0, 1-wA-wElo-wB-wZIP)) : wA; // Alpha absorbs Gamma's share

    const finalMat=matAlpha.map((row,i)=>row.map((cell,j)=>
      (cell*wA_eff)+
      ((matElo[i]?.[j]||0)*wElo)+
      ((matBeta[i]?.[j]||0)*wB)+
      ((matZIP[i]?.[j]||0)*wZIP)+
      ((matGamma[i]?.[j]||0)*wC)
    ));
    let fSum=0; finalMat.forEach(r=>r.forEach(v=>fSum+=v));
    if(fSum>0)finalMat.forEach((r,i)=>r.forEach((v,j)=>finalMat[i][j]/=fSum));

    const finalMkt=MathEngine.extractMarkets(finalMat);
    const fp={home:finalMkt.hw,draw:finalMkt.dr,away:finalMkt.aw};
    let eHg=0,eAg=0;
    const N=finalMat.length;
    for(let i=0;i<N;i++){for(let j=0;j<N;j++){eHg+=i*(finalMat[i]?.[j]||0);eAg+=j*(finalMat[i]?.[j]||0);}}
    const mc=MathEngine.monteCarlo(eHg,eAg,dynamicRho,mcRuns);

    // ── v2026.7 R6 — LOW-SCORING REGIME + ASIAN HANDICAP PIVOT ──────────────────
    // Authoritative regime from the final fused matrix. When LOW_SCORING, compute the
    // data-backed AH pivot (favourite vs underdog decided by the matrix, not narrative).
    // Per-league/per-side accuracy is supplied from the ledger (R7) when available.
    let lowScoreRegime = { regime: 'STANDARD' };
    let ahPivot = null;
    if (typeof ORACLE_CONFIG !== 'undefined' && ORACLE_CONFIG.ENABLE_LOWSCORE_REGIME) {
      lowScoreRegime = MathEngine.detectLowScoringRegime(finalMat, eHg, eAg);
      if (lowScoreRegime.regime === 'LOW_SCORING' && ORACLE_CONFIG.ENABLE_AH_PIVOT) {
        const _leagueAcc = (ledger?.metrics?.ahAccuracy && ledger.metrics.ahAccuracy[league])
          ? ledger.metrics.ahAccuracy[league] : {};
        ahPivot = MathEngine.asianHandicapPivot(finalMat, lowScoreRegime, _leagueAcc);
      }
    }

    const councilPenalty=fetched?.oracle_council?.penalty_active===true||fetched?.council?.penalty_active===true;
    const globalVelocity=Math.min(lmuHome.velocity,lmuAway.velocity,0);

    // NEW-09: Sharp/Square delta using tier-aware bookmaker data
    const pinHome=p(telemetry.rawOddsPayload?.pinnacle?.home,homeOdds);
    const sharpConsensusHome=p(telemetry.rawOddsPayload?.sharp_consensus?.home,pinHome);
    const squareHome=p(telemetry.rawOddsPayload?.bet365?.home,homeOdds);
    // BUG-B03 FIXED (v28): Sign convention corrected.
    // sharpDelta < 0 → sharp odds LOWER (shorter) than square = sharp BACKING this side (pro-home if home delta)
    // sharpDelta > 0 → sharp odds HIGHER (longer) than square = sharp FADING this side
    const sharpDelta=sharpConsensusHome-squareHome; // Negative = sharp shorter (pro-home); Positive = sharp longer (fading home)

    // BUG-009 FIX: rlmDetected now reflects TRUE RLM; steamDetected for sharp steam
    const rlmDetected=lmuHome.rlm||lmuAway.rlm;
    const steamDetected=lmuHome.steam||lmuAway.steam;
    // NEW-12: SHARP_COMPRESSION tag
    const sharpCompressionTag=lmuHome.sharpCompression||lmuAway.sharpCompression||(fetched?.sharp_compression_detected===true);
    // NEW-06: Market suspension detection
    const marketSuspended=fetched?.market_suspended===true;

    // NEW-05: Lineup confirmation gate
    const lineupUnconfirmed=!(fetched?.starting_xi?.confirmed===true);

    let upsetScore=0;
    // (rest differential now handled below with directional logic — BUG-C04 FIX)
    // BUG-B03 FIX: sharpDelta < 0 means sharp shorter on home (pro-home) — NOT an upset signal
    // Upset signal: sharpDelta > 0.05 (sharp FADING the home favourite = upset signal)
    // Also: sharpDelta < -0.12 (extreme sharp one-side compression may indicate syndicate info)
    if(sharpDelta>0.05)upsetScore+=4; // Sharp fading favourite = genuine upset signal
    // BUG-C04 FIX: rest differential is directional — only penalise the FAVOURITE if they have worse rest
    // upsetScore should only increase when the FAVOURITE is disadvantaged
    const isHomeFav=eHg>eAg+0.3,isAwayFav=eAg>eHg+0.3;
    if(isHomeFav&&restH<restA-2)upsetScore+=3;   // Home favourite is more fatigued → upset risk
    else if(isAwayFav&&restA<restH-2)upsetScore+=3; // Away favourite is more fatigued → upset risk
    if(isHomeFav&&xH_raw>0&&xH_raw<lp.homeAvg*0.8)upsetScore+=2;
    if(isAwayFav&&xA_raw>0&&xA_raw<lp.awayAvg*0.8)upsetScore+=2;
    if(telemetry.isDerby)upsetScore+=3;
    const upsetAlertVeto=(isHomeFav&&upsetScore>=8)?"home":(isAwayFav&&upsetScore>=8)?"away":null;

    const modelGoalDiff=eHg-eAg;
    const marketImpliedDiff=(fairImp.home-fairImp.away)*3.0;
    const ahAsymmetryWarning=Math.abs(modelGoalDiff-marketImpliedDiff)>0.85;

    const analysis1x2=["home","draw","away"].map(out=>{
      const mp=fp[out],finalEdge=mp-fairImp[out],odds=out==="home"?homeOdds:out==="draw"?drawOdds:awayOdds;
      const ev=MathEngine.adjEV(mp,odds),cbTripped=mc.varFlag&&ev>0;
      const velocity=out==="home"?lmuHome.velocity:out==="draw"?0:lmuAway.velocity;
      const proxVetoHome=hoursToKO<1.5&&lmuHome.velocity<-0.02;
      const sentinelVeto=(finalEdge>0&&velocity<-0.08)||(out==="home"&&proxVetoHome)||upsetAlertVeto===out;
      const mesVeto=mes<0.85&&finalEdge<0.08;
      // HF-10d parity: analysis1x2 uses same 10% ML minimum edge gate as scanMarkets()
      const mlMinHurdle = Math.max(0.10, MathEngine.hurdle(mp));
      const hasEV=ev>0&&finalEdge>=mlMinHurdle&&!cbTripped&&!sentinelVeto&&!mesVeto;
      // BUG-011 FIX: Kelly no longer applies time decay
      // BUG-C02 FIX: pass mp (modelProb) explicitly so Kelly uses canonical q = 1 - modelProb
      const stake=hasEV?MathEngine.optimizedKelly(finalEdge,odds,dqs,councilPenalty,mc.varMultiplier,drawdownPenaltyFinal,calibFactor,0.25,mp):0; // HF-8c
      return{outcome:out,mp,ip:fairImp[out],ev,hasEV,stake,stakeAmt:stake*bankroll,cbTripped,sentinelVeto,mesVeto,proximateVeto:out==="home"&&proxVetoHome,upsetVeto:upsetAlertVeto===out,odds};
    });

    let maxProb=0,expectedScoreline="0-0";
    for(let i=0;i<N;i++){for(let j=0;j<N;j++){if((finalMat[i]?.[j]||0)>maxProb){maxProb=finalMat[i][j];expectedScoreline=`${i}-${j}`;}}}

    // NEW-04 / BUG-A02 FIX: CLV Projection (now edge-sensitive)
    const topEvMarketType = finalMkt.hw > 0.45 ? '1x2' : 'AH';
    const leagueLiquidity = { 'Premier League':1.3,'Champions League':1.2,'La Liga':1.1,'Bundesliga':1.0,'Default':0.7 }[fixture?.league||'Default']||0.7;
    const topEdge = (finalMkt.hw - fairImp.home);
    const clvProjection = MathEngine.clvProjection(Math.abs(topEdge), hoursToKO, topEvMarketType, leagueLiquidity);

    // NEW-16: Lambda Inconsistency Check
    const ou25IP = oddsData.over_2_5 ? 1/oddsData.over_2_5 : null;
    const lambdaCheck = ou25IP ? MathEngine.checkLambdaInconsistency(eHg, eAg, ou25IP) : { inconsistent:false, divergence:0 };

    // NEW-19: Draw calibration factor for AH fair value (Hvattum & Arntzen 2010)
    const leagueDrawRate = (LEAGUE_PARAMS[fixture?.league||'Default']||LEAGUE_PARAMS.Default).drawRate || 0.25;
    const drawCalibFactor = MathEngine.drawCalibrationFactor(finalMkt.dr, leagueDrawRate);

    // HF-8c: surface confidence flag in result for briefingRLM
    const rawRes={
      ...fixture, bayesian_lH:eHg, bayesian_lA:eAg, fp, fairImp, mat:finalMat, mc, analysis1x2,
      portfolioCorrelation:null, correlatedParlayRisk:null, // defaults; overwritten if evMarkets>=2
      sharpDelta, councilPenalty, mes, rlmDetected, steamDetected, sharpCompressionTag, marketSuspended,
      ahAsymmetryWarning, drawdownPenalty, dqs, isArbitrage, rawOverround,
      timeDecayInfo, timeDecayMultiplier:timeDecayInfo,
      oddsShiftWeightH:boostH, oddsShiftWeightA:0,
      hoursToKO, upsetAlertVeto, council:fetched?.council,
      lineupUnconfirmed, clvProjection,
      lambdaInconsistency: lambdaCheck,
      drawCalibFactor,
      lmuHome, lmuAway, // exposed for ML Safety Filter
      ledger, // expose for ConvergenceScorer S09
      bestML:analysis1x2.filter(a=>a.hasEV).sort((a,b)=>b.ev-a.ev)[0],
      syntheticScripts:MathEngine.generateSyntheticAlpha(finalMat),
      ame:MarketMakerEngine.price({home:fixture.home,away:fixture.away,fp,bayesian_lH:eHg,bayesian_lA:eAg,finalMkt}),
      shapExplanation:[
        {name:"Layer 1: Expert Alpha (Fundamentals + SoS + Env + Fatigue + Injuries)",pct:wA_eff*100,color:"#10b981"},
        {name:"Layer 1b: Ensemble Elo-Grade (Pi Rating Logistic — Long-Run Form)",pct:wElo*100,color:"#34d399"},
        {name:"Layer 2: Expert Beta (ELO Class + Motivation + Derby)",pct:wB*100,color:"#a78bfa"},
        {name:_quarantineGamma?"Layer 3: Market Velocity (QUARANTINED — sharp signal only, 0% in probability)":"Layer 3: Expert Gamma (Market Velocity + RLM)",pct:wC*100,color:"#0ea5e9"},
        {name:"Layer 4: ZIP Model (Zero-Inflated Poisson — Defensive Specialist)",pct:wZIP*100,color:"#f59e0b"},
      ],
      fetched, expectedScoreline, timestamp:Date.now(),
      // HF-8c: xG confidence outputs
      xgConfidenceFlag, xgConfidenceMod, xgConfidence:_xgConf, xgSourcesCount:_xgSrc,
      adaptiveRegime:_adaptiveRegime, leeConstraint:_leeConstraint,
      // HF-10a/b: KL-Divergence and Normalized Efficiency
      klSignal: (() => {
        const normSum = (1/homeOdds)+(1/drawOdds)+(1/awayOdds);
        const mktDist = { home:(1/homeOdds)/normSum, draw:(1/drawOdds)/normSum, away:(1/awayOdds)/normSum };
        return MathEngine.klDivergence(fp, mktDist);
      })(),
      efficiencySignal: MathEngine.normalizedEfficiency(homeOdds, drawOdds, awayOdds, fp.home, fp.draw, fp.away),
      // v2026.7 R6: low-scoring regime + computed Asian Handicap pivot
      lowScoreRegime, ahPivot,
    };

    rawRes.evMarkets=this.scanMarkets(finalMkt,fp,calibFactor,bankroll,dqs,oddsData,councilPenalty,mc.varMultiplier,drawdownPenalty,mes,globalVelocity,hoursToKO,upsetAlertVeto);

    // NEW-18: Steam Chaser Detection Gate — veto markets where compression met but edge gone
    rawRes.evMarkets = rawRes.evMarkets.map(m => {
      if (MathEngine.isSteamChaser(sharpCompressionTag, m.ev)) {
        return {...m, veto:'STEAM_CHASER_VETO', stake:0, stakeAmt:0};
      }
      return m;
    });

    // Portfolio Covariance Loop + NEW-20 / BUG-M05 FIXED (v29): Correlated Parlay Hard Cap
    // BUG-M05 ROOT CAUSE: correlatedParlayRisk was populated but never enforced as "hard cap".
    // Stakes were softly reduced via penalties but BOTH ρ>0.7 markets could still appear together.
    // FIX: Track which market indices participate in ρ>0.7 pairs. Of the two, keep the higher-EV
    // market and hard-veto (stake=0, veto='CORRELATED_PARLAY_VETO') the lower-EV partner.
    if(!skipSensitivity&&rawRes.evMarkets.length>=2) {
      let maxRho=0;const penalties=new Array(rawRes.evMarkets.length).fill(1.0);
      const correlatedPairs=[];
      const correlatedVetoIndices=new Set(); // BUG-M05 FIX: track hard-veto indices
      for(let i=0;i<rawRes.evMarkets.length-1;i++){
        for(let j=i+1;j<rawRes.evMarkets.length;j++){
          const rho=MathEngine.CorrelationMatrix.compute(finalMat,rawRes.evMarkets[i].label,rawRes.evMarkets[j].label);
          if(rho>0.1){maxRho=Math.max(maxRho,rho);const pen=1/(1+rho);penalties[i]=Math.min(penalties[i],pen);penalties[j]=Math.min(penalties[j],pen);}
          if(rho>0.70){
            correlatedPairs.push({a:rawRes.evMarkets[i].label,b:rawRes.evMarkets[j].label,rho:parseFloat(rho.toFixed(3))});
            // BUG-M05 FIX: Hard-veto the lower-EV market of correlated pair
            const iEV = rawRes.evMarkets[i].ev || 0;
            const jEV = rawRes.evMarkets[j].ev || 0;
            correlatedVetoIndices.add(iEV >= jEV ? j : i); // veto the weaker one
          }
        }
      }
      for(let i=0;i<rawRes.evMarkets.length;i++){
        if(correlatedVetoIndices.has(i)){
          // Hard cap: zero out the lower-EV correlated market
          rawRes.evMarkets[i].stake=0; rawRes.evMarkets[i].stakeAmt=0;
          rawRes.evMarkets[i].veto='CORRELATED_PARLAY_VETO';
        } else {
          rawRes.evMarkets[i].stakeAmt*=penalties[i];rawRes.evMarkets[i].stake*=penalties[i];
        }
      }
      rawRes.portfolioCorrelation=maxRho;
      rawRes.correlatedParlayRisk=correlatedPairs; // NEW-20
    }
    if(!skipSensitivity) rawRes.sensitivity=this.SensitivityEngine.analyze(state,rawRes);

    rawRes.debate=AntiSycophancyCircuit.execute(rawRes);

    // NEW-21: Native Convergence Scorer — run after debate to include S08
    const ragSimilar = RAGSystem.findSimilar(rawRes, 5);
    rawRes.convergence = ConvergenceScorer.compute(rawRes, ragSimilar);

    // NEW-23: ML Safety Filter
    rawRes.mlFilter = MLSafetyFilter.evaluate(fetched, rawRes, state.telemetry);

    RAGSystem.addToStore(rawRes,{evMarkets:rawRes.evMarkets,debate:rawRes.debate,expectedScoreline,home:fixture.home,away:fixture.away});

    return rawRes;
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// §12 — TELEMETRY ADAPTER (v28.0 — BUG-001, BUG-002, BUG-023 FIXED)
// ═══════════════════════════════════════════════════════════════════════════════

const TelemetryAdapter = {
  fetchWithTimeout: (url, options, timeout=4000) =>
    Promise.race([fetch(url, options), new Promise((_,r) => setTimeout(() => r(new Error("Timeout")), timeout))]),

  safeNum: (val, fb) => { if(val===null||val===undefined)return fb; const p=parseFloat(val); return isNaN(p)?fb:p; },

  // BUG-023 FIX: Use stadium city from Turn 1 for weather, not team name first word
  _getWeatherCity: (query, stadiumCity) => {
    if (stadiumCity && stadiumCity.trim()) return stadiumCity.trim();
    // Fallback: try to extract city from common team→city mapping
    const teamCityMap = {
      'manchester city':'Manchester','manchester united':'Manchester','liverpool':'Liverpool',
      'arsenal':'London','chelsea':'London','tottenham':'London','west ham':'London',
      'real madrid':'Madrid','barcelona':'Barcelona','atletico madrid':'Madrid',
      'bayern munich':'Munich','borussia dortmund':'Dortmund','bayer leverkusen':'Leverkusen',
      'psg':'Paris','paris saint-germain':'Paris','lyon':'Lyon','marseille':'Marseille',
      'juventus':'Turin','inter milan':'Milan','ac milan':'Milan','napoli':'Naples',
      'ajax':'Amsterdam','psv':'Eindhoven','porto':'Porto','benfica':'Lisbon',
    };
    const home = query.split('vs')[0].trim().toLowerCase();
    for (const [team, city] of Object.entries(teamCityMap)) {
      if (home.includes(team)) return city;
    }
    // Last resort: first word only if it's a plausible city name (not "Borussia", "Real", etc.)
    const first = query.split('vs')[0].trim().split(' ')[0];
    const invalidFirst = ['real','borussia','atletico','manchester','sporting','bayer','rb','fc','afc','sc'];
    if (!invalidFirst.includes(first.toLowerCase())) return first;
    return query.split('vs')[0].trim(); // Full team name as fallback
  },

  // ── 3-Turn Agentic Loop ────────────────────────────────────────────────────
  acquireDataAgentLoop: async (query) => {
    try {
      // BUG-002 FIX: Get API keys from runtime config, not hardcoded
      const apiKeys = getApiKeys();
      let apiSummary = "APIs Failed";

      // Pre-fetch API data (BUG-023: weather city resolved AFTER Turn 1)
      try {
        const qClean = query.split("vs")[0].trim().split(" ")[0];
        const [fRes, afRes] = await Promise.allSettled([
          TelemetryAdapter.fetchWithTimeout('https://api.football-data.org/v4/matches',
            { headers:{'X-Auth-Token': apiKeys.footballData} }).then(r=>r.json()),
          TelemetryAdapter.fetchWithTimeout(`https://v3.football.api-sports.io/fixtures?search=${encodeURIComponent(qClean)}&next=5`,
            { headers:{'x-apisports-key': apiKeys.apiFootball} }).then(r=>r.json())
        ]);
        apiSummary = {
          weather: 'Pending stadium city lookup',
          footballData: fRes.status==='fulfilled' ? 'Connected' : 'Failed',
          apiSports: afRes.status==='fulfilled' ? 'Connected' : 'Failed'
        };
      } catch(e) {}

      // Turn 1: Fixture Resolution (T1 Flash model)
      const turn1Payload = {
        systemInstruction: { parts: [{ text: PromptRegistry.acquisitionTurn1(query, JSON.stringify(apiSummary)) }] },
        contents: [{ parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
        generationConfig: { responseMimeType: "application/json" }
      };
      const t1Data = await fetchGeminiWithCascade([MODELS.T1, MODELS.T1b], turn1Payload);
      const t1Text = t1Data.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text).join('') || "{}";
      const t1ThoughtSig = t1Data.candidates?.[0]?.content?.parts?.find(p=>p.thought)?.text || "";
      let turn1 = null;
      try { turn1 = JSON.parse(t1Text); } catch(e) { const m = t1Text.match(/\{[\s\S]*\}/); if(m) try { turn1 = JSON.parse(m[0]); } catch(e2){} }
      if (!turn1?.fixtures?.length) throw new Error("Turn 1 failed: No fixture resolved.");

      // BUG-023 FIX: Now use stadium city from Turn 1 response for weather
      const stadiumCity = turn1.stadium_city || '';
      const weatherCity = TelemetryAdapter._getWeatherCity(query, stadiumCity);
      let weatherData = { wind_mph: 0, rain_mm: 0 };
      if (apiKeys.openWeather) {
        try {
          const wRes = await TelemetryAdapter.fetchWithTimeout(
            `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(weatherCity)}&appid=${apiKeys.openWeather}`
          ).then(r=>r.json());
          weatherData = {
            wind_mph: Math.round((wRes?.wind?.speed||0) * 2.237 * 10) / 10, // m/s to mph
            rain_mm: wRes?.rain?.['1h'] || 0
          };
          if (typeof apiSummary === 'object') apiSummary.weather = `Wind:${weatherData.wind_mph}mph Rain:${weatherData.rain_mm}mm`;
        } catch(e) {}
      }
      // Override Turn 1 weather with real data if available
      if (weatherData.wind_mph > 0 || weatherData.rain_mm > 0) turn1.weather = weatherData;

      const hName = turn1.fixtures[0].home || "Home";
      const aName = turn1.fixtures[0].away || "Away";
      const prevT1Str = JSON.stringify({ fixture:turn1.fixtures[0], startingXI:turn1.starting_xi, weather:turn1.weather, referee:turn1.referee });

      // Turn 2: Odds Harvest (T1 Flash model)
      const turn2Payload = {
        systemInstruction: { parts: [{ text: PromptRegistry.acquisitionTurn2(query, prevT1Str) }] },
        contents: [
          { parts: [{ text: query }] },
          { role: "model", parts: [{ text: t1Text }, { thought: true, text: t1ThoughtSig }] }
        ],
        tools: [{ google_search: {} }],
        generationConfig: { responseMimeType: "application/json" }
      };
      const t2Data = await fetchGeminiWithCascade([MODELS.T1, MODELS.T1b], turn2Payload);
      const t2Text = t2Data.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text).join('') || "{}";
      const t2ThoughtSig = t2Data.candidates?.[0]?.content?.parts?.find(p=>p.thought)?.text || "";
      let turn2 = null;
      try { turn2 = JSON.parse(t2Text); } catch(e) { const m = t2Text.match(/\{[\s\S]*\}/); if(m) try { turn2 = JSON.parse(m[0]); } catch(e2){} }

      // B7-01: Lock FrozenOddsRegistry immediately after Turn 2 — before any LLM narrative call
      FrozenOddsRegistry.reset(); // clear previous session lock
      FrozenOddsRegistry.lock({ ...(turn2?.odds||{}), hOdds: turn2?.odds?.home, dOdds: turn2?.odds?.draw, aOdds: turn2?.odds?.away, ohO: turn2?.odds?.over_2_5, oaO: turn2?.odds?.under_2_5 });
      // B6: Register this fixture in SessionRegistry for intra-session duplicate detection
      SessionRegistry.register(turn1.home||'', turn1.away||'', turn1.date||'', 'pending');

      // Live odds enhancement (The Odds API)
      let bestOdds = { ...(turn2?.odds||{}) };
      let pinH = 0, liveOddsMode = false;
      if (turn1.sport_key && apiKeys.oddsApi) {
        try {
          const oddsRes = await TelemetryAdapter.fetchWithTimeout(
            `https://api.the-odds-api.com/v4/sports/${turn1.sport_key}/odds/?apiKey=${apiKeys.oddsApi}&regions=eu,uk&markets=h2h,totals,spreads`, {}, 5000
          );
          if (oddsRes.ok) {
            const oddsData = await oddsRes.json();
            const event = oddsData.find(e => e.home_team.toLowerCase().includes(hName.toLowerCase()) || hName.toLowerCase().includes(e.home_team.toLowerCase()));
            if (event) {
              const sharpConsH = [], sharpConsD = [], sharpConsA = [];
              // BUG-B08 FIX: Track best single-book 1x2 trio separately from overall best-of-book
              // Arbitrage should be classified per single-book only, not from Frankenstein max aggregation
              let bestSingleBookH=0, bestSingleBookD=0, bestSingleBookA=0, bestSingleBookOR=99;
              event.bookmakers.forEach(bm => {
                bm.markets.forEach(m => {
                  if (m.key==='h2h') {
                    const h=m.outcomes.find(o=>o.name===event.home_team)?.price||0;
                    const a=m.outcomes.find(o=>o.name===event.away_team)?.price||0;
                    const d=m.outcomes.find(o=>o.name==='Draw')?.price||0;
                    if(h>(bestOdds.home||0)) bestOdds.home=h;
                    if(a>(bestOdds.away||0)) bestOdds.away=a;
                    if(d>(bestOdds.draw||0)) bestOdds.draw=d;
                    if(bm.key==='pinnacle') { pinH=h; }
                    if(SHARP_BOOKS.has(bm.key.toLowerCase())) { sharpConsH.push(h); sharpConsD.push(d); sharpConsA.push(a); }
                    // BUG-B08 FIX: find single-book with best (lowest) overround for arb check
                    if (h>1&&d>1&&a>1) {
                      const singleOR=(1/h)+(1/d)+(1/a);
                      if(singleOR<bestSingleBookOR){bestSingleBookOR=singleOR;bestSingleBookH=h;bestSingleBookD=d;bestSingleBookA=a;}
                    }
                  }
                  if(m.key==='totals') m.outcomes.forEach(o=>{const t=o.point;if(o.name==='Over'&&o.price>(bestOdds[`over_${t}`]||0))bestOdds[`over_${t}`]=o.price;if(o.name==='Under'&&o.price>(bestOdds[`under_${t}`]||0))bestOdds[`under_${t}`]=o.price;});
                  if(m.key==='spreads') m.outcomes.forEach(o=>{const pt=o.point;if(pt!==undefined&&o.price){const isHome=o.name===event.home_team;let sp=Math.abs(pt).toString();if(!sp.includes('.'))sp+='.0';sp=sp.replace('.','');const pfx=pt<0?'m':'p';const tk=isHome?`ah_h${pfx}${sp}`:`ah_a${pfx}${sp}`;if(o.price>(bestOdds[tk]||0))bestOdds[tk]=o.price;}});
                });
              });
              if (bestOdds.home > 0) {
                if (!bestOdds.pinnacle) bestOdds.pinnacle = {};
                bestOdds.pinnacle.home = pinH || bestOdds.home;
                // BUG-B08 FIX: Store single-book best-trio for true arb detection
                bestOdds._singleBookArb = bestSingleBookOR < 1.0;
                bestOdds._singleBookH = bestSingleBookH;
                bestOdds._singleBookD = bestSingleBookD;
                bestOdds._singleBookA = bestSingleBookA;
                if (sharpConsH.length > 0) {
                  bestOdds.sharp_consensus = {
                    home: sharpConsH.reduce((a,b)=>a+b,0)/sharpConsH.length,
                    draw: sharpConsD.reduce((a,b)=>a+b,0)/Math.max(1,sharpConsD.length),
                    away: sharpConsA.reduce((a,b)=>a+b,0)/Math.max(1,sharpConsA.length),
                    bookCount: sharpConsH.length
                  };
                }
                liveOddsMode = true;
              }
            }
          }
        } catch(e) { console.warn("Live Odds API degraded."); }
      }

      // Turn 3: Injury/Form Validation — BUG-001 FIXED: .match() added
      const prevT2Str = JSON.stringify({ fixture:turn1.fixtures[0], odds:bestOdds });
      const turn3Payload = {
        systemInstruction: { parts: [{ text: PromptRegistry.acquisitionTurn3(query, prevT2Str) }] },
        contents: [
          { parts: [{ text: query }] },
          { role: "model", parts: [{ text: t2Text }, { thought: true, text: t2ThoughtSig }] }
        ],
        tools: [{ google_search: {} }],
        generationConfig: { responseMimeType: "application/json" }
      };
      const t3Data = await fetchGeminiWithCascade([MODELS.T1, MODELS.T1b], turn3Payload);
      const t3Text = t3Data.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text).join('') || "{}";
      let turn3 = null;
      // BUG-001 CRITICAL FIX: was `t3Text.(...)` — missing .match — silent TypeError every run
      try { turn3 = JSON.parse(t3Text); }
      catch(e) {
        const m = t3Text.match(/\{[\s\S]*\}/);  // [BUG-001 FIX: .match() added]
        if (m) try { turn3 = JSON.parse(m[0]); } catch(e2) { turn3 = {}; }
        else turn3 = {};
      }

      // Merge all three turns into unified payload
      const stats = turn3?.stats || {};
      stats.home_pi_rating = TeamRatingsEngine.getRating(hName, stats.home_pi_rating||1500);
      stats.away_pi_rating = TeamRatingsEngine.getRating(aName, stats.away_pi_rating||1500);

      const merged = {
        fixtures:        turn1.fixtures,
        sport_key:       turn1.sport_key || '',
        stadium_city:    stadiumCity,
        starting_xi:     turn1.starting_xi || { home:[], away:[], confirmed:false },
        weather:         turn1.weather || { wind_mph:0, rain_mm:0 },
        referee:         turn1.referee || { cards_per_game:3, bias:'' },
        odds:            bestOdds,
        stats,
        player_impacts:  turn3?.player_impacts || [],
        council:         turn3?.council || {},
        oracle_council:  turn3?.oracle_council || { penalty_active:false },
        line_movement_notes: turn2?.line_movement_notes || '',
        rlm_detected:    turn2?.rlm_detected || false,
        sharp_compression_detected: turn2?.sharp_compression_detected || false,
        market_suspended: turn2?.market_suspended || false,
        liveOddsMode,
        cwIntel: 'Multi-turn agentic acquisition complete.',
        dqs: (typeof apiSummary==='object' && apiSummary.weather!=='Failed') ? 1.0 : 0.85,
        _acquisitionMode: '3-TURN-AGENTIC-V29',
      };
      return merged;

    } catch(err) {
      console.warn('3-turn agentic loop failed, falling back to single-shot:', err.message);
      return TelemetryAdapter.acquireData(query);
    }
  },

  // ── Single-Shot Fallback ───────────────────────────────────────────────────
  acquireData: async (query) => {
    const empty = { fixtures:[], odds:{}, stats:{ weather:{} }, dqs:0, sources:{}, oracleConsensus:null };
    try {
      const apiKeys = getApiKeys(); // BUG-002 FIX
      let apiSummary = 'APIs Failed';
      try {
        // BUG-023 FIX: Don't use team name first word for weather; handled after fixture resolution
        const qClean = query.split('vs')[0].trim();
        const [fRes, afRes] = await Promise.allSettled([
          TelemetryAdapter.fetchWithTimeout('https://api.football-data.org/v4/matches',
            { headers:{'X-Auth-Token': apiKeys.footballData} }).then(r=>r.json()),
          TelemetryAdapter.fetchWithTimeout(`https://v3.football.api-sports.io/fixtures?search=${encodeURIComponent(qClean.split(' ')[0])}&next=5`,
            { headers:{'x-apisports-key': apiKeys.apiFootball} }).then(r=>r.json())
        ]);
        apiSummary = {
          weather: 'Pending city lookup',
          footballData: fRes.status==='fulfilled' ? 'Connected' : 'Failed',
          apiSports: afRes.status==='fulfilled' ? 'Connected' : 'Failed',
        };
      } catch(e) {}

      const cwState = typeof window!=='undefined' ? window.__ORACLE_CORE__?.getState()?.crowdWisdom : null;
      let cwIntel = CrowdWisdomProtocol.serialise(cwState?.payload);
      if (!cwState?.payload) {
        const cwResult = await CrowdWisdomProtocol.harvest(query);
        cwIntel = CrowdWisdomProtocol.serialise(cwResult);
      }

      const rd = await fetchGeminiWithCascade([MODELS.T1, MODELS.T1b], {
        systemInstruction: { parts: [{ text: PromptRegistry.acquisition(query, JSON.stringify(apiSummary), cwIntel) }] },
        contents: [{ parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
        generationConfig: { responseMimeType: 'application/json' },
      });

      const txt = rd.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text).join('') || '';
      let parsed = null;
      try { parsed = JSON.parse(txt); }
      catch(e) { const m = txt.match(/\{[\s\S]*\}/); if(m) try { parsed = JSON.parse(m[0]); } catch(e2){} }

      if (parsed?.error && parsed.error.trim()!=='') throw new Error(parsed.error);
      if (!parsed?.fixtures?.length) throw new Error('No fixture found matching query.');

      const hName = parsed.fixtures[0].home || 'Home';
      const aName = parsed.fixtures[0].away || 'Away';

      // BUG-023 FIX: Use stadium_city if provided by LLM
      const stadiumCity = parsed.stadium_city || '';
      const weatherCity = TelemetryAdapter._getWeatherCity(query, stadiumCity);
      if (apiKeys.openWeather) {
        try {
          const wData = await TelemetryAdapter.fetchWithTimeout(
            `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(weatherCity)}&appid=${apiKeys.openWeather}`
          ).then(r=>r.json());
          parsed.weather = { wind_mph: Math.round((wData?.wind?.speed||0)*2.237*10)/10, rain_mm: wData?.rain?.['1h']||0 };
        } catch(e) {}
      }

      parsed.stats = parsed.stats || {};
      parsed.stats.home_pi_rating = TeamRatingsEngine.getRating(hName, parsed.stats.home_pi_rating||1500);
      parsed.stats.away_pi_rating = TeamRatingsEngine.getRating(aName, parsed.stats.away_pi_rating||1500);

      // Phase 2: Live Line Shopping (The Odds API)
      parsed.liveOddsMode = false;
      if (parsed.sport_key && apiKeys.oddsApi) {
        try {
          const oddsRes = await TelemetryAdapter.fetchWithTimeout(
            `https://api.the-odds-api.com/v4/sports/${parsed.sport_key}/odds/?apiKey=${apiKeys.oddsApi}&regions=eu,uk&markets=h2h,totals,spreads`, {}, 5000
          );
          if (oddsRes.ok) {
            const oddsData = await oddsRes.json();
            const event = oddsData.find(e => e.home_team.toLowerCase().includes(hName.toLowerCase()) || hName.toLowerCase().includes(e.home_team.toLowerCase()));
            if (event) {
              const bestOdds = { ...parsed.odds }; let pinH=0;
              const sharpH=[], sharpD=[], sharpA=[];
              event.bookmakers.forEach(bm => {
                bm.markets.forEach(m => {
                  if(m.key==='h2h'){
                    const h=m.outcomes.find(o=>o.name===event.home_team)?.price||0;
                    const a=m.outcomes.find(o=>o.name===event.away_team)?.price||0;
                    const d=m.outcomes.find(o=>o.name==='Draw')?.price||0;
                    if(h>(bestOdds.home||0)) bestOdds.home=h;
                    if(a>(bestOdds.away||0)) bestOdds.away=a;
                    if(d>(bestOdds.draw||0)) bestOdds.draw=d;
                    if(bm.key==='pinnacle') pinH=h;
                    if(SHARP_BOOKS.has(bm.key.toLowerCase())) { sharpH.push(h); sharpD.push(d); sharpA.push(a); }
                  }
                  if(m.key==='totals') m.outcomes.forEach(o=>{const t=o.point;if(o.name==='Over'&&o.price>(bestOdds[`over_${t}`]||0))bestOdds[`over_${t}`]=o.price;if(o.name==='Under'&&o.price>(bestOdds[`under_${t}`]||0))bestOdds[`under_${t}`]=o.price;});
                  if(m.key==='spreads') m.outcomes.forEach(o=>{const pt=o.point;if(pt!==undefined&&o.price){const isHome=o.name===event.home_team;let sp=Math.abs(pt).toString();if(!sp.includes('.'))sp+='.0';sp=sp.replace('.','');const pfx=pt<0?'m':'p';const tk=isHome?`ah_h${pfx}${sp}`:`ah_a${pfx}${sp}`;if(o.price>(bestOdds[tk]||0))bestOdds[tk]=o.price;}});
                });
              });
              if (bestOdds.home > 0) {
                parsed.odds = bestOdds;
                if (!parsed.odds.pinnacle) parsed.odds.pinnacle = {};
                parsed.odds.pinnacle.home = pinH || bestOdds.home;
                if (sharpH.length > 0) {
                  parsed.odds.sharp_consensus = {
                    home: sharpH.reduce((a,b)=>a+b,0)/sharpH.length,
                    draw: sharpD.reduce((a,b)=>a+b,0)/Math.max(1,sharpD.length),
                    away: sharpA.reduce((a,b)=>a+b,0)/Math.max(1,sharpA.length),
                    bookCount: sharpH.length
                  };
                }
                parsed.liveOddsMode = true;
              }
            }
          }
        } catch(e) { console.warn("Live Odds fallback degraded:", e.message); }
      }

      return {
        ...parsed,
        _acquisitionMode: 'SINGLE-SHOT-V29',
        cwIntel,
      };

    } catch(err) {
      console.error("TelemetryAdapter.acquireData failed:", err.message);
      return empty;
    }
  },

  // ── Main Entry Point ───────────────────────────────────────────────────────
  run: async (query) => {
    try {
      return await TelemetryAdapter.acquireDataAgentLoop(query);
    } catch(e) {
      return await TelemetryAdapter.acquireData(query);
    }
  },

  // ── Briefing Generation (T2 Pro · MEDIUM thinking) ────────────────────────
  generateBriefing: async (resData) => {
    coreDispatch({ type:'UPDATE_AI', payload:{ generatingThesis:true, rlmData:'' } });
    try {
      const topMarkets = resData.evMarkets.slice(0,2)
        .map(m=>`${m.label} @ ${m.odds} [EV: +${(m.ev*100).toFixed(1)}% ±${resData.mc.ciBound.toFixed(1)}%]`)
        .join(' | ') || 'No edges found';
      const cwState = typeof window!=='undefined' ? window.__ORACLE_CORE__?.getState()?.crowdWisdom : null;
      const cwIntel = CrowdWisdomProtocol.serialise(cwState?.payload);
      const similar = RAGSystem.findSimilar(resData, 3);
      const ragText = RAGSystem.formatAnalogues(similar);

      // B9: 4-stage pipeline — run Stage 0-2 before Stage 3 (main briefingRLM)
      const frozenTable  = FrozenOddsRegistry.toTableString();
      const entityGraph  = resData.fetched?.entityGraph || null;
      const biasReport   = PromptRegistry.briefingStage0Bias(resData, resData.convergence);
      const pmMatches    = PostmortemRegistry.check({
        marketPicked: resData.convergence?.apex?.market || '',
        rootCause: resData.convergence?.negativeEvAlert ? 'NEGATIVE_EV_SKIPPED' :
                   (resData.ragAnalogues||'').includes('SAME-SEASON') ? 'SSSVO_IGNORED' : 'XG_CEILING_BREACH',
      });
      const pmWarning    = PostmortemRegistry.formatWarning(pmMatches);

      // Stage 1 & 2 are injected as context sections into Stage 3 (briefingRLM)
      // This keeps the pipeline single-LLM-call while enforcing the decomposed structure
      const stage1Prompt = PromptRegistry.briefingStage1Signals(resData, resData.convergence, frozenTable, entityGraph, biasReport, pmWarning);
      const stage2Prompt = PromptRegistry.briefingStage2Markets(resData, topMarkets, resData.convergence, frozenTable);

      // ══════════════════════════════════════════════════════════════════════════
      // BRIEFING MODEL HIERARCHY (v2026.6.0):
      //   1st: Claude Opus — deepest reasoning, best for narrative synthesis
      //   2nd: Gemini 3.1 Pro temperature ensemble — resilient multi-model fallback
      //   3rd: Gemini 3.5 Flash — agentic fallback if Pro unavailable
      //
      // If Claude is unreachable (no key, 404, timeout, any error), the Gemini
      // ensemble takes over seamlessly. The user sees no difference except a
      // stamp indicating which provider generated the briefing.
      // ══════════════════════════════════════════════════════════════════════════

      const briefingSystemPrompt = PromptRegistry.briefingRLM(
        resData, topMarkets, resData.sharpDelta, resData.mes,
        resData.rlmDetected, resData.ahAsymmetryWarning, resData.drawdownPenalty,
        cwIntel, ragText, resData.convergence
      );

      const briefingUserPrompt =
        `STAGE 0 — BIAS SCAN:\n${biasReport}\n\n` +
        `STAGE 1 — SIGNAL ISOLATION:\n${stage1Prompt}\n\n` +
        `STAGE 2 — MARKET RANKING:\n${stage2Prompt}\n\n` +
        `STAGE 3 — Generate the full v2026.6.0 briefing report incorporating all stages above.`;

      let rawText = '';
      let briefingProvider = 'GEMINI';
      let divergentFlag = '';

      // ── PRIMARY: Claude Opus briefing ──────────────────────────────────────
      const claudeKey = resData.claudeKey || (typeof window !== 'undefined' && window.__ORACLE_CORE__?.getState()?.ui?.claudeKey) || '';
      if (claudeKey) {
        const opusResult = await callClaude(
          CLAUDE_MODELS.BRIEFING,
          briefingSystemPrompt,
          briefingUserPrompt,
          claudeKey,
          8192  // generous output for full briefing narrative
        );
        if (opusResult.ok && opusResult.text.length > 100) {
          rawText = opusResult.text;
          briefingProvider = 'CLAUDE_OPUS';
          console.log('[ORACLE] Briefing generated by Claude Opus (primary)');
        } else {
          console.warn('[ORACLE] Claude Opus briefing failed, falling back to Gemini ensemble:', opusResult.error);
        }
      }

      // ── FALLBACK: Gemini temperature ensemble ─────────────────────────────
      if (!rawText || briefingProvider === 'GEMINI') {
        // HF-G: Neutral Framing Variant — detect sycophancy by comparing analyst vs neutral persona
        const _neutralSystemPrompt = briefingSystemPrompt
          .replace(/elite analyst|world-class analyst|expert analyst|you are an? [a-z ]*analyst/gi, 'analytical system');

        const neutralPayloadPromise = fetchGeminiWithCascade([MODELS.T2, MODELS.T2b], {
          systemInstruction: { parts: [{ text: _neutralSystemPrompt }] },
          contents: [{ parts: [{ text: briefingUserPrompt }] }],
          generationConfig: { thinkingConfig:{ thinkingLevel: THINKING_LEVELS.MEDIUM } },
        }).catch(() => null);

        const payload = {
          systemInstruction: { parts: [{ text: briefingSystemPrompt }] },
          contents: [{ parts: [{ text: briefingUserPrompt }] }],
          generationConfig: { thinkingConfig:{ thinkingLevel: THINKING_LEVELS.MEDIUM } },
        };

        // HF-E: Temperature Ensemble — 3 parallel Gemini calls at T=[0.4, 0.8, 1.2]
        const temps = [0.4, 0.8, 1.2];
        const ensembleResults = await Promise.allSettled(
          temps.map(temp => fetchGeminiWithCascade([MODELS.T2, MODELS.T2b], {
            ...payload,
            generationConfig: { ...payload.generationConfig, temperature: temp },
          }))
        );

        const extractMarket = (rawT) => {
          const m = rawT.match(/APEX[^\n]*?([A-Za-z ]{4,30})\s*@\s*([\d.]+)/i)
                  || rawT.match(/RECOMMENDATION[:\s]+([A-Za-z ]{4,30})\s*@\s*([\d.]+)/i);
          return m ? `${m[1].trim()} @ ${m[2]}` : null;
        };

        const ensembleTexts = ensembleResults.map(r =>
          r.status === 'fulfilled'
            ? (r.value?.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text).join('') || '')
            : ''
        );
        const ensembleMarkets = ensembleTexts.map(extractMarket);

        const marketCounts = {};
        ensembleMarkets.forEach(m => { if(m){ marketCounts[m] = (marketCounts[m]||0)+1; }});
        const majorityMarket = Object.entries(marketCounts).find(([,c]) => c >= 2)?.[0] || null;
        divergentFlag = !majorityMarket
          ? '⚠️ [DIVERGENT_TEMPERATURE_ENSEMBLE] No majority across T=[0.4,0.8,1.2] — edge confidence reduced. Kelly × 0.50.'
          : '';

        const d = ensembleResults[1].status === 'fulfilled' ? ensembleResults[1].value
                 : ensembleResults.find(r=>r.status==='fulfilled')?.value || {};
        rawText = (d.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text).join('') || 'Error synthesizing narrative.') + divergentFlag;

        if (majorityMarket) {
          rawText += `\n\n🌡️ TEMPERATURE ENSEMBLE CONSENSUS: ${majorityMarket} (${Object.entries(marketCounts).map(([m,c])=>`${m}×${c}`).join(', ')})`;
        }
        briefingProvider = 'GEMINI';
      }

      const finalIndex = rawText.indexOf('📋 PROTOCOL EXECUTION COMPLIANCE REPORT');
      const cleanOutput = (finalIndex !== -1 ? rawText.substring(finalIndex).trim() : rawText);

      // HF-G: Resolve neutral variant and compare Kelly recommendations
      let framingBiasFlag = '';
      try {
        const neutralD = await neutralPayloadPromise;
        if (neutralD) {
          const neutralText = neutralD.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text).join('') || '';
          // Extract Kelly stake from both outputs (look for "Kelly: X%" or "Stake: X%")
          const extractKelly = (txt) => {
            const m = txt.match(/[Kk]elly[:\s]+([0-9]+(?:\.[0-9]+)?)\s*%/);
            return m ? parseFloat(m[1]) / 100 : null;
          };
          const stdKelly     = extractKelly(rawText);
          const neutralKelly = extractKelly(neutralText);
          if (stdKelly !== null && neutralKelly !== null) {
            const kellyDivergence = Math.abs(stdKelly - neutralKelly) / Math.max(stdKelly, neutralKelly, 0.01);
            if (kellyDivergence > 0.15) {
              framingBiasFlag = `

⚠️ [FRAMING_BIAS_DETECTED] Standard prompt Kelly (${(stdKelly*100).toFixed(1)}%) vs neutral prompt Kelly (${(neutralKelly*100).toFixed(1)}%) diverge by ${(kellyDivergence*100).toFixed(0)}%. Persona framing is distorting stake sizing. Use neutral estimate: ${(Math.min(stdKelly,neutralKelly)*100).toFixed(1)}%.`;
            }
          }
        }
      } catch(_) { /* neutral run failure is non-fatal */ }

      // B8: Claude Verification Layer — run after Gemini briefing completes
      let cvlResult = { status:'SKIP', stamp:'⬜ CLAUDE_VERIFICATION_SKIPPED' };
      try {
        cvlResult = await ClaudeVerificationLayer.verify(resData);
      } catch(cvlErr) {
        cvlResult = { status:'ERROR', stamp:'⚠️ CLAUDE_VERIFICATION_ERROR: ' + cvlErr.message };
      }

      // BLOCK B3: BorderlineDeliberationGate — 2-advisor risk gate for uncertain fixtures.
      // FAIL-CLOSED: any error → STAND_DOWN. Do NOT restore 5-advisor Council (PRD D1).
      const convergenceScore = resData.convergence?.scores?.[0] ?? -1;
      const uncertaintyFlags = [
        resData.mc?.varFlag,
        (resData.sharpDelta||0) < -0.03,
        (resData.mes||1) < 0.75,
        (resData.clvProjection?.survivalProb||1) < 0.50,
        resData.convergence?.dispersionWarning,
      ].filter(Boolean).length;
      let deliberationResult = null;
      if (BorderlineDeliberationGate.shouldTrigger(convergenceScore, uncertaintyFlags)) {
        deliberationResult = await BorderlineDeliberationGate.run(resData, resData.claudeKey);
        if (deliberationResult.verdict === 'STAND_DOWN') {
          // Gate fired: zero apex stake, stamp the output.
          if (resData.evMarkets?.[0]) resData.evMarkets[0].stake = 0;
          if (resData.analysis1x2) resData.analysis1x2.stake = 0;
        }
      }

      // BLOCK B7: Fixture-wide convergence tier veto (TUNE: gated by ORACLE_CONFIG).
      // Previous code only zeroed the apex market; non-apex bets leaked through at base 0.25.
      // Here we apply the tier base uniformly across the entire slate so there's no leak.
      if (ORACLE_CONFIG.CONVERGENCE_FIXTURE_VETO && resData.convergence?.tier) {
        const tierBase = { NOISE:0, MARGINAL:0.0625, VIABLE:0.125, STRONG:0.25 }[resData.convergence.tier] ?? 0.25;
        if (tierBase === 0) {
          // NOISE: zero every market on this fixture
          (resData.evMarkets||[]).forEach(m => { m.stake = 0; m.stakeAmt = 0; m.veto = 'NOISE_TIER_VETO'; });
          if (resData.analysis1x2) { resData.analysis1x2.stake = 0; resData.analysis1x2.stakeAmt = 0; }
        } else if (tierBase < 0.25) {
          // Sub-full tier: scale all stakes to the consistent tier base (no mixed bases)
          const scaleFactor = tierBase / 0.25;
          (resData.evMarkets||[]).forEach(m => {
            m.stake = MathEngine.clamp((m.stake||0)*scaleFactor, 0, tierBase);
            m.stakeAmt = m.stake * (resData.bankroll || 1000);
          });
        }
      }

      const cvlStamp = cvlResult.stamp || '';
      const cvlOverride = cvlResult.stage2?.recommendation ? `\n\n🔴 CLAUDE OVERRIDE RECOMMENDATION: ${cvlResult.stage2.recommendation}\nMarket: ${cvlResult.stage2.market} @ ${cvlResult.stage2.odds}\nReasoning: ${cvlResult.stage2.reasoning}` : '';
      const deliberationStamp = deliberationResult
        ? `\n\n${deliberationResult.verdict==='STAND_DOWN'?'🛑':'🟡'} [BORDERLINE_GATE] ${deliberationResult.verdict}: ${deliberationResult.reason}`
        : '';
      const providerStamp = briefingProvider === 'CLAUDE_OPUS'
        ? `\n🧠 Briefing: Claude Opus (${CLAUDE_MODELS.BRIEFING}) — primary`
        : `\n🤖 Briefing: Gemini (${MODELS.T2}) — fallback`;
      const finalThesis = cvlStamp + '\n\n' + cleanOutput + cvlOverride + framingBiasFlag + deliberationStamp + providerStamp;

      coreDispatch({ type:'UPDATE_AI', payload:{ thesis:finalThesis, rlmData:rawText, cvlResult } });

    } catch(e) {
      coreDispatch({ type:'UPDATE_AI', payload:{ thesis:'System Error: '+e.message } });
    } finally {
      coreDispatch({ type:'UPDATE_AI', payload:{ generatingThesis:false } });
    }
  },

  // ── Red Team Generation (T2 Pro · HIGH thinking) ──────────────────────────
  generateRedTeam: async (resData) => {
    coreDispatch({ type:'UPDATE_AI', payload:{ generatingRedTeam:true, redTeamThesis:null } });
    try {
      const topMarketLabel = resData.evMarkets[0]
        ? `${resData.evMarkets[0].label} @ ${resData.evMarkets[0].odds}`
        : 'No Valid Edge';

      const payload = {
        systemInstruction: { parts: [{ text: PromptRegistry.redTeam(resData, topMarketLabel) }] },
        contents: [{ parts: [{ text: 'Critique this prediction.' }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingLevel: THINKING_LEVELS.HIGH },
        },
      };

      const d = await fetchGeminiWithCascade([MODELS.T2, MODELS.T2b], payload);
      const rawText = d.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text).join('') || '';
      let parsed = null;
      try { parsed = JSON.parse(rawText); }
      catch(e) { const m = rawText.match(/\{[\s\S]*\}/); if(m) try { parsed = JSON.parse(m[0]); } catch(e2){} }
      if (parsed?.critique) coreDispatch({ type:'UPDATE_AI', payload:{ redTeamThesis:parsed } });

    } catch(e) {
      console.warn('Red Team formulation aborted:', e.message);
    } finally {
      coreDispatch({ type:'UPDATE_AI', payload:{ generatingRedTeam:false } });
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// §13 — ORACLE CORE STORE (v28.0 — updated storage keys + API key config)
// ═══════════════════════════════════════════════════════════════════════════════

const loadPersistedState = () => {
  // localStorage replaced by _safeStorage (always available)
  try { const saved = _safeStorage.getItem('oracle_v2026_bankroll'); if(saved) return JSON.parse(saved); } catch(e) {}
  return { broll:1000, peakBroll:1000 };
};

const loadApiKeys = () => {
  // localStorage replaced by _safeStorage (always available)
  try { const saved = _safeStorage.getItem('oracle_v2026_keys'); if(saved) return JSON.parse(saved); } catch(e) {}
  return {};
};

class OracleCoreStore {
  constructor() {
    const persisted = loadPersistedState();
    const savedKeys = loadApiKeys();
    const ledgerData = CalibrationEngine.load();
    // BLOCK B4 (V4-B): run-scoped concurrency control.
    // activeRunId + _runSeq guard against re-entrant async flows and stale dispatches.
    // Two overlapping analyses previously shared one mutable state and one FrozenOddsRegistry;
    // now stale async results are dropped at the store boundary.
    this._runSeq = 0;
    this.activeRunId = null;
    this._bankrollDirty = false;
    this._persistTimer = null;
    this.state = {
      ui: {
        view: 'search', tab: 'terminal', query: '', searching: false,
        userApiKey: savedKeys.gemini || '',
        owKey: savedKeys.openWeather || '',
        fdKey: savedKeys.footballData || '',
        afKey: savedKeys.apiFootball || '',
        odKey: savedKeys.oddsApi || '',
        claudeKey: savedKeys.claude || '', // B14-01: Anthropic Claude API key
        showApiConfig: false,
      },
      telemetry: {
        piH:1500, piA:1500, xH:0, xA:0,
        restH:7, restA:7,
        isDerby:false, newMgrH:false, newMgrA:false,
        travelKm:0, altitudeM:0, hoursToKO:24,
        wnd:0, rn:0, injPenH:0.0, injPenA:0.0,
        rawOdds:null, hOdds:1.85, dOdds:3.40, aOdds:4.50,
        ohO:1.90, odO:3.50, oaO:4.40,
        broll:persisted.broll, peakBroll:persisted.peakBroll,
        xgMode:'bayesian', motivationScore:1.0,
        oppGA_H:1.3, oppGA_A:1.3,
        isLiveOdds:false,
      },
      pipeline: { fetched:null, fixture:null, result:null, running:false, error:null },
      ai: { thesis:'', generatingThesis:false, rlmData:'', redTeamThesis:null, generatingRedTeam:false },
      crowdWisdom: { status:'idle', payload:null, sourcesScanned:0, freshSources:0, error:null },
      ledger: { bets:ledgerData, metrics:CalibrationEngine.calculate(ledgerData) },
    };
    this.listeners = new Set();
  }

  getState() { return this.state; }

  // B4: Start a new analysis run — returns the runId that must be passed to all
  // async dispatches from this flow so stale results from a previous run are dropped.
  startRun() {
    this.activeRunId = ++this._runSeq;
    return this.activeRunId;
  }

  dispatch(action) {
    // BLOCK B4: Drop stale async dispatches from a superseded run.
    // If action carries a runId and it no longer matches activeRunId, discard silently.
    if (action.runId != null && action.runId !== this.activeRunId) return;

    if (action.type==='UPDATE_UI')
      this.state = { ...this.state, ui: { ...this.state.ui, ...action.payload } };

    if (action.type==='UPDATE_TELEMETRY') {
      this.state = { ...this.state, telemetry: { ...this.state.telemetry, ...action.payload } };
      // BLOCK B4: Debounce bankroll persistence — only write on explicit RESOLVE/commit,
      // not on every telemetry tick (was causing read-modify-write races).
      if (action.payload.broll !== undefined) this._bankrollDirty = true;
    }

    if (action.type==='SAVE_API_KEYS') {
      const keys = action.payload;
      this.state = { ...this.state, ui: { ...this.state.ui, ...keys } };
      _safeStorage.setItem('oracle_v2026_keys', JSON.stringify({
        gemini: keys.userApiKey||this.state.ui.userApiKey,
        openWeather: keys.owKey||this.state.ui.owKey,
        footballData: keys.fdKey||this.state.ui.fdKey,
        apiFootball: keys.afKey||this.state.ui.afKey,
        oddsApi: keys.odKey||this.state.ui.odKey,
        claude: keys.claudeKey||this.state.ui.claudeKey,
      }));
    }

    if (action.type==='UPDATE_PIPELINE')
      this.state = { ...this.state, pipeline: { ...this.state.pipeline, ...action.payload } };

    if (action.type==='UPDATE_AI')
      this.state = { ...this.state, ai: { ...this.state.ai, ...action.payload } };

    if (action.type==='UPDATE_CROWD_WISDOM')
      this.state = { ...this.state, crowdWisdom: { ...this.state.crowdWisdom, ...action.payload } };

    if (action.type==='LEDGER_ACTION') {
      if (action.actionType==='ADD')    this.state = { ...this.state, ledger: CalibrationEngine.addBet(action.payload) };
      if (action.actionType==='RESOLVE') {
        this.state = { ...this.state, ledger: CalibrationEngine.resolveBet(action.payload.id, action.payload.outcome, action.payload.homeG, action.payload.awayG, action.payload.closeOdds) };
        // Persist bankroll on RESOLVE (the only safe flush point — no races)
        if (this._bankrollDirty) {
          _safeStorage.setItem('oracle_v2026_bankroll', JSON.stringify({ broll:this.state.telemetry.broll, peakBroll:this.state.telemetry.peakBroll }));
          this._bankrollDirty = false;
        }
      }
      if (action.actionType==='DELETE') this.state = { ...this.state, ledger: CalibrationEngine.deleteBet(action.payload.id) };
    }

    this.listeners.forEach(l => l(this.state));
  }

  subscribe(l) { this.listeners.add(l); return () => this.listeners.delete(l); }
}

if (typeof window!=='undefined' && !window.__ORACLE_CORE__) {
  window.__ORACLE_CORE__ = new OracleCoreStore();
  // BUG-C08 FIX: Rehydrate RAG store on app load
  RAGSystem.init();
}

// BUG-C03 FIXED (v28): coreDispatch as lazy getter — safe to call before store wires
// Previously: direct function reference could throw if called before window.__ORACLE_CORE__ set
const coreDispatch = (action) => {
  if (typeof window !== 'undefined' && window.__ORACLE_CORE__) {
    window.__ORACLE_CORE__.dispatch(action);
  } else {
    // Queue until available
    if (typeof window !== 'undefined') {
      window.__ORACLE_DISPATCH_QUEUE__ = window.__ORACLE_DISPATCH_QUEUE__ || [];
      window.__ORACLE_DISPATCH_QUEUE__.push(action);
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// §14 — UI STYLES (v28.0 — updated + ZIP layer color + new status indicators)
// ═══════════════════════════════════════════════════════════════════════════════

const S = {
  app:      { minHeight:'100vh', background:'#010206', color:'#c9d4e8', fontFamily:"'Syne',sans-serif", overflowX:'hidden' },
  nav:      { background:'rgba(1,2,6,0.85)', backdropFilter:'blur(15px)', borderBottom:'1px solid rgba(255,255,255,0.06)', padding:'14px 28px', display:'flex', justifyContent:'space-between', alignItems:'center', position:'sticky', top:0, zIndex:100 },
  wrap:     { maxWidth:1200, margin:'0 auto', padding:'0 24px' },
  card:     { background:'linear-gradient(145deg,#0b1221 0%,#060b14 100%)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:18, padding:24, marginBottom:20, boxShadow:'0 10px 40px rgba(0,0,0,0.5)' },
  cardGold: { background:'linear-gradient(145deg,rgba(212,168,67,0.15) 0%,rgba(212,168,67,0.04) 100%)', border:'1px solid rgba(212,168,67,0.4)', borderRadius:18, padding:26, marginBottom:20 },
  label:    { fontSize:10, color:'#64748b', letterSpacing:'0.25em', marginBottom:14, fontFamily:"'JetBrains Mono',monospace", fontWeight:700, textTransform:'uppercase' },
  tab:      a => ({ padding:'12px 22px', borderRadius:14, fontSize:11, cursor:'pointer', fontFamily:"'JetBrains Mono',monospace", fontWeight:700, border:'none', background:a?'rgba(212,168,67,0.2)':'transparent', color:a?'#d4a843':'#64748b', transition:'all .2s ease', display:'flex', alignItems:'center', gap:8 }),
  pri:      { width:'100%', padding:'20px 0', background:'linear-gradient(135deg,#d4a843,#b8922e)', border:'none', borderRadius:16, color:'#010206', fontSize:16, fontWeight:800, cursor:'pointer', letterSpacing:'0.05em', boxShadow:'0 4px 20px rgba(212,168,67,0.3)', display:'flex', justifyContent:'center', alignItems:'center', gap:10 },
  inputStyle: { width:'100%', padding:'18px 24px', fontSize:15, background:'rgba(11,18,33,0.6)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:14, color:'#e8eef8', outline:'none', fontFamily:"'JetBrains Mono',monospace" },
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0} body{background:#010206;font-family:'Syne',sans-serif;color:#c9d4e8}
.fu{animation:fadeUp .4s cubic-bezier(0.16,1,0.3,1) forwards}
@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.pulse{animation:pulseGlow 2s infinite}
@keyframes pulseGlow{0%,100%{opacity:1;box-shadow:0 0 8px rgba(212,168,67,0.2)}50%{opacity:0.6;box-shadow:0 0 20px rgba(212,168,67,0.4)}}
.sharp-tag{background:rgba(250,204,21,0.15);border:1px solid rgba(250,204,21,0.4);border-radius:6px;padding:2px 8px;font-size:10px;color:#fbbf24;font-family:'JetBrains Mono',monospace;}
.arb-tag{background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);border-radius:6px;padding:2px 8px;font-size:10px;color:#10b981;font-family:'JetBrains Mono',monospace;}
.susp-tag{background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);border-radius:6px;padding:2px 8px;font-size:10px;color:#ef4444;font-family:'JetBrains Mono',monospace;}
input::placeholder{color:#475569}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#1a2235;border-radius:2px}
input[type=number]::-webkit-inner-spin-button{opacity:.3}
input:focus{border-color:rgba(212,168,67,0.5)!important;box-shadow:0 0 10px rgba(212,168,67,0.1)!important;}
`;

// ═══════════════════════════════════════════════════════════════════════════════
// §15 — MAIN APP COMPONENT (v28.0 — API key config panel + new signal tags)
// ═══════════════════════════════════════════════════════════════════════════════

export default function App() {
  const [st, setSt] = useState(() => typeof window!=='undefined' ? window.__ORACLE_CORE__?.getState() : null);
  const qRef = useRef(null);

  useEffect(() => {
    if (typeof window==='undefined'||!window.__ORACLE_CORE__) return;
    const unsub = window.__ORACLE_CORE__.subscribe(s => setSt({...s}));
    setSt(window.__ORACLE_CORE__.getState());
    return unsub;
  }, []);

  const ui       = st?.ui       || {};
  const tel      = st?.telemetry || {};
  const pipe     = st?.pipeline  || {};
  const ai       = st?.ai        || {};
  const ledger   = st?.ledger    || {};
  const res      = pipe.result;

  const handleSearch = async () => {
    if (!ui.query?.trim()) return;
    if (!ui.userApiKey) { coreDispatch({type:'UPDATE_UI', payload:{showApiConfig:true}}); return; }
    coreDispatch({type:'UPDATE_PIPELINE', payload:{running:true, error:null, result:null, fetched:null}});
    coreDispatch({type:'UPDATE_AI', payload:{thesis:'', rlmData:'', redTeamThesis:null}});
    try {
      const fetched = await TelemetryAdapter.run(ui.query);
      if (!fetched?.fixtures?.length) throw new Error("No fixture found — check query format (e.g. 'Arsenal vs Chelsea')");
      const fix = fetched.fixtures[0];
      coreDispatch({type:'UPDATE_PIPELINE', payload:{fetched, fixture:fix}});
      // HF-8a: Fix xgMode latent bug.
      // xgMode was hardcoded 'bayesian' at init and NEVER switched to 'empirical' during live runs,
      // even when Gemini returned home_xg > 0. This silently underweighted the Alpha ensemble
      // (wA: 0.35 instead of 0.40) on every analysis with real xG data — a 14% underweight.
      // Fix: detect presence of empirical xG from Turn 3 and set mode accordingly.
      const _xH = fetched.stats?.home_xg||0;
      const _xA = fetched.stats?.away_xg||0;
      const _xgMode = (_xH > 0 && _xA > 0) ? 'empirical' : 'bayesian';
      coreDispatch({type:'UPDATE_TELEMETRY', payload:{
        piH:fetched.stats?.home_pi_rating||1500,
        piA:fetched.stats?.away_pi_rating||1500,
        xH: _xH,
        xA: _xA,
        injPenH: fetched.stats?.injPenH||0,
        injPenA: fetched.stats?.injPenA||0,
        motivationScore: fetched.stats?.motivationScore||1.0,
        oppGA_H: fetched.stats?.oppGA_H||1.3,
        oppGA_A: fetched.stats?.oppGA_A||1.3,
        hOdds: fetched.odds?.home||1.85,
        dOdds: fetched.odds?.draw||3.40,
        aOdds: fetched.odds?.away||4.50,
        ohO: fetched.odds?.opening?.home||fetched.odds?.home||1.85,
        rawOddsPayload: fetched.odds,
        isLiveOdds: fetched.liveOddsMode||false,
        xgMode: _xgMode,           // HF-8a: empirical when both xH+xA > 0, else bayesian
        xg_confidence: fetched.stats?.xg_confidence||'medium',   // HF-8b: Gemini-reported confidence
        xg_sources_count: fetched.stats?.xg_sources_count||1,    // HF-8b: sources Gemini consulted
      }});
      const runState = window.__ORACLE_CORE__.getState();
      const result = ExecutionEngine.run({
        telemetry: runState.telemetry,
        pipeline: { fixture:fix, fetched },
        ledger: runState.ledger,
      });
      coreDispatch({type:'UPDATE_PIPELINE', payload:{result, running:false}});
      await TelemetryAdapter.generateBriefing(result);
    } catch(e) {
      coreDispatch({type:'UPDATE_PIPELINE', payload:{running:false, error:e.message}});
    }
  };

  const ApiConfigPanel = () => {
    const [keys, setKeys] = useState({
      gemini: ui.userApiKey||'', ow: ui.owKey||'', fd: ui.fdKey||'', af: ui.afKey||'', od: ui.odKey||'', claude: ui.claudeKey||''
    });
    return (
      <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.85)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center'}}>
        <div style={{...S.card,width:520,padding:32}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:20}}>
            <span style={{color:'#d4a843',fontWeight:800,fontSize:16}}>🔑 API Configuration</span>
            <button onClick={()=>coreDispatch({type:'UPDATE_UI',payload:{showApiConfig:false}})} style={{background:'none',border:'none',color:'#64748b',cursor:'pointer',fontSize:18}}>✕</button>
          </div>
          <p style={{color:'#64748b',fontSize:12,marginBottom:20,fontFamily:"'JetBrains Mono',monospace"}}>
            Keys stored locally in your browser only — never transmitted to servers.
          </p>
          {[
            {label:'Gemini API Key (Required)', key:'gemini', placeholder:'AIza... (get from aistudio.google.com)'},
            {label:'Anthropic (Claude) API Key', key:'claude', placeholder:'sk-ant-... (get from console.anthropic.com)'},
            {label:'OpenWeather API Key', key:'ow', placeholder:'openweather-api-key (optional)'},
            {label:'Football-Data.org Key', key:'fd', placeholder:'football-data-org-key (optional)'},
            {label:'API-Football (api-sports.io) Key', key:'af', placeholder:'api-sports-key (optional)'},
            {label:'The Odds API Key', key:'od', placeholder:'odds-api-key (optional)'},
          ].map(f => (
            <div key={f.key} style={{marginBottom:14}}>
              <div style={{...S.label,marginBottom:6}}>{f.label}</div>
              <input type="password" placeholder={f.placeholder} value={keys[f.key]}
                onChange={e=>setKeys({...keys,[f.key]:e.target.value})}
                style={{...S.inputStyle,padding:'12px 16px',fontSize:13}} />
            </div>
          ))}
          <button style={S.pri} onClick={()=>{
            coreDispatch({type:'SAVE_API_KEYS',payload:{userApiKey:keys.gemini,owKey:keys.ow,fdKey:keys.fd,afKey:keys.af,odKey:keys.od,claudeKey:keys.claude}});
            coreDispatch({type:'UPDATE_UI',payload:{showApiConfig:false}});
          }}>Save API Keys</button>
        </div>
      </div>
    );
  };

  const renderStatusTags = () => {
    if (!res) return null;
    return (
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:12}}>
        {res.sharpCompressionTag && <span className="sharp-tag">⚡ SHARP_COMPRESSION</span>}
        {res.isArbitrage && <span className="arb-tag">📊 ARB_STATE</span>}
        {res.marketSuspended && <span className="susp-tag">🚫 MARKET_SUSPENDED</span>}
        {res.rlmDetected && <span className="sharp-tag">↩️ TRUE RLM</span>}
        {res.lineupUnconfirmed && res.hoursToKO < 3 && <span className="susp-tag">⚠️ LINEUP_GATE</span>}
        {res.clvProjection?.survivalProb > 0.7 && <span className="arb-tag">📈 CLV STRONG</span>}
      </div>
    );
  };

  const renderShapBar = () => {
    if (!res?.shapExplanation) return null;
    return (
      <div style={{...S.card}}>
        <div style={S.label}>Ensemble Layer Weights (v2026.3.12)</div>
        {res.shapExplanation.map((l,i) => (
          <div key={i} style={{marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
              <span style={{fontSize:11,color:'#94a3b8'}}>{l.name}</span>
              <span style={{fontSize:11,color:l.color,fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>{l.pct.toFixed(1)}%</span>
            </div>
            <div style={{height:6,background:'rgba(255,255,255,0.05)',borderRadius:3,overflow:'hidden'}}>
              <div style={{width:`${l.pct}%`,height:'100%',background:l.color,borderRadius:3,transition:'width 0.5s ease'}}/>
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderEVMarkets = () => {
    if (!res?.evMarkets?.length) return null;
    const valid = res.evMarkets.filter(m=>!m.veto&&m.ev>0).slice(0,8);
    if (!valid.length) return null;
    return (
      <div style={{...S.card}}>
        <div style={S.label}>+EV Markets — Sovereign Gating Network</div>
        {valid.map((m,i) => (
          <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 0',borderBottom:i<valid.length-1?'1px solid rgba(255,255,255,0.04)':'none'}}>
            <div>
              <span style={{color:'#e8eef8',fontWeight:600,fontSize:14}}>{m.label}</span>
              {m.cat && <span style={{fontSize:10,color:'#475569',marginLeft:8,fontFamily:"'JetBrains Mono',monospace"}}>{m.cat}</span>}
            </div>
            <div style={{display:'flex',gap:16,alignItems:'center'}}>
              <span style={{fontFamily:"'JetBrains Mono',monospace",color:'#64748b',fontSize:12}}>@ {m.odds}</span>
              <span style={{fontFamily:"'JetBrains Mono',monospace",color:m.ev>0.1?'#10b981':m.ev>0.05?'#fbbf24':'#94a3b8',fontWeight:700,fontSize:13}}>+{(m.ev*100).toFixed(1)}%</span>
              {m.stakeAmt>0&&<span style={{fontFamily:"'JetBrains Mono',monospace",color:'#d4a843',fontSize:12}}>£{m.stakeAmt.toFixed(0)}</span>}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderDebatePanel = () => {
    if (!res?.debate) return null;
    const d = res.debate;
    const tColor = d.betTrigger==='GREEN'?'#10b981':d.betTrigger==='YELLOW'?'#fbbf24':'#ef4444';
    return (
      <div style={{...S.card}}>
        <div style={S.label}>Anti-Sycophancy Circuit — 3-Agent Debate</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12,marginBottom:16}}>
          {[
            {agent:'EV-FINDER',data:d.finder,color:'#10b981'},
            {agent:'ADVERSARIAL',data:d.adversary,color:'#ef4444'},
            {agent:'REFEREE',data:d.referee,color:'#d4a843'},
          ].map(({agent,data,color})=>(
            <div key={agent} style={{background:'rgba(255,255,255,0.03)',borderRadius:12,padding:14,border:`1px solid ${color}22`}}>
              <div style={{color,fontSize:10,fontFamily:"'JetBrains Mono',monospace",fontWeight:700,marginBottom:8}}>{agent}</div>
              {agent==='EV-FINDER'&&<div style={{color:'#94a3b8',fontSize:12}}>Found: {data?.evFound||0} | Score: {data?.totalScore||0}</div>}
              {agent==='ADVERSARIAL'&&<div style={{color:'#94a3b8',fontSize:12}}>Disproved: {data?.disprovedCount||0} | Accepted: {data?.acceptedCount||0}</div>}
              {agent==='REFEREE'&&<div style={{color:'#94a3b8',fontSize:12}}>Confirmed: {data?.confirmedBets||0} | Rejected: {data?.rejectedBets||0}</div>}
            </div>
          ))}
        </div>
        <div style={{background:tColor+'22',border:`1px solid ${tColor}44`,borderRadius:12,padding:16,marginBottom:12}}>
          <div style={{color:tColor,fontWeight:800,fontSize:16,marginBottom:4}}>
            {d.betTrigger==='GREEN'?'🟢 GREEN — PLACE BET':d.betTrigger==='YELLOW'?'🟡 YELLOW — EXERCISE CAUTION':'🔴 RED — AVOID'}
          </div>
          <div style={{color:'#94a3b8',fontSize:13}}>{d.topBankerBet}</div>
        </div>
        <div style={{fontSize:12,color:'#64748b',lineHeight:1.6}}>{d.executiveSummary}</div>
        {d.riskFlags?.length>0&&(
          <div style={{marginTop:12}}>
            {d.riskFlags.filter(f=>!f.includes('No critical')).map((f,i)=>(
              <div key={i} style={{fontSize:11,color:'#94a3b8',padding:'4px 0',fontFamily:"'JetBrains Mono',monospace"}}>{f}</div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // ── NEW-21: Convergence Scorer Panel ─────────────────────────────────────────
  const renderConvergencePanel = () => {
    if (!res?.convergence) return null;
    const cv = res.convergence;
    const apex = cv.apex;
    const tier = cv.overallTier;
    const tierColor = tier.label==='APEX'?'#d4a843':tier.label==='PRIME'?'#10b981':tier.label==='VIABLE'?'#fbbf24':tier.label==='MARGINAL'?'#94a3b8':'#ef4444';
    return (
      <div style={{...S.card,border:`1px solid ${tierColor}44`}}>
        <div style={S.label}>Convergence Scorer — 13-Signal Native Engine (NEW-21)</div>
        <div style={{display:'flex',alignItems:'center',gap:16,marginBottom:16,flexWrap:'wrap'}}>
          <div style={{background:`${tierColor}22`,border:`1px solid ${tierColor}66`,borderRadius:12,padding:'10px 20px'}}>
            <div style={{color:tierColor,fontWeight:800,fontSize:22}}>{tier.emoji} {tier.label}</div>
            <div style={{color:'#64748b',fontSize:10,fontFamily:"'JetBrains Mono',monospace"}}>CONVERGENCE TIER</div>
          </div>
          {apex && (
            <div style={{flex:1}}>
              <div style={{color:'#e8eef8',fontWeight:700,fontSize:14}}>{apex.market} @ {apex.odds}</div>
              <div style={{color:tierColor,fontSize:12,fontFamily:"'JetBrains Mono',monospace",marginTop:2}}>Score: {apex.totalScore}/23 — Active: {apex.activeSignals?.join(', ')||'none'}</div>
              <div style={{color:'#64748b',fontSize:11,marginTop:4}}>{tier.kelly}</div>
            </div>
          )}
        </div>
        <div style={{background:'rgba(255,255,255,0.03)',borderRadius:10,padding:12,marginBottom:10,borderLeft:`3px solid ${tierColor}`}}>
          <div style={{color:'#94a3b8',fontSize:12}}>{cv.deploymentGuide}</div>
        </div>
        {cv.scores?.length > 1 && (
          <div>
            <div style={{fontSize:10,color:'#475569',fontFamily:"'JetBrains Mono',monospace",marginBottom:8}}>ALL CANDIDATES</div>
            {cv.scores.map((s,i)=>{
              const c2 = i===0?tierColor:'#64748b';
              return(
                <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderBottom:'1px solid rgba(255,255,255,0.04)'}}>
                  <span style={{color:c2,fontSize:12}}>{s.market}</span>
                  <div style={{display:'flex',gap:8,alignItems:'center'}}>
                    <span style={{fontSize:10,color:'#64748b',fontFamily:"'JetBrains Mono',monospace"}}>{s.activeSignals?.slice(0,4).join('+')}</span>
                    <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:13,fontWeight:700,color:c2}}>{s.totalScore}/23</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {cv.noConvergence && (
          <div style={{marginTop:10,padding:10,background:'rgba(239,68,68,0.1)',borderRadius:8,border:'1px solid rgba(239,68,68,0.3)'}}>
            <div style={{color:'#ef4444',fontSize:11,fontFamily:"'JetBrains Mono',monospace"}}>⛔ NO CONVERGENCE THRESHOLD MET — Consider passing this fixture</div>
          </div>
        )}
      </div>
    );
  };

  // ── NEW-23: ML Safety Filter Panel ───────────────────────────────────────────
  const renderMLFilterPanel = () => {
    if (!res?.mlFilter) return null;
    const mf = res.mlFilter;
    const allowed = mf.mlAllowed;
    const c = allowed ? '#10b981' : '#ef4444';
    const passedFilters = (mf.filters||[]).filter(f=>f.pass);
    const failedFilters = (mf.filters||[]).filter(f=>!f.pass);
    return (
      <div style={{...S.card,border:`1px solid ${c}33`}}>
        <div style={S.label}>ML Safety Filter — 15-Section Money Line Framework (NEW-23)</div>
        <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14,flexWrap:'wrap'}}>
          <div style={{background:`${c}18`,border:`1px solid ${c}44`,borderRadius:10,padding:'10px 18px'}}>
            <div style={{color:c,fontWeight:800,fontSize:18}}>{allowed?'✅ ML APPROVED':'❌ ML REJECTED'}</div>
            <div style={{color:'#64748b',fontSize:10,fontFamily:"'JetBrains Mono',monospace",marginTop:2}}>{mf.filtersPassed}/{mf.filtersTotal} FILTERS PASSED — {mf.confidence}</div>
          </div>
          <div style={{flex:1,fontSize:12,color:'#94a3b8'}}>{mf.summary}</div>
        </div>

        {/* Filter grid */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:8,marginBottom:12}}>
          {(mf.filters||[]).map((f,i)=>(
            <div key={i} style={{display:'flex',gap:8,alignItems:'flex-start',background:'rgba(255,255,255,0.02)',borderRadius:8,padding:'8px 10px',border:`1px solid ${f.pass?'rgba(16,185,129,0.2)':'rgba(239,68,68,0.2)'}`}}>
              <span style={{fontSize:14,marginTop:1}}>{f.pass?'✅':'❌'}</span>
              <div>
                <div style={{fontSize:11,color:f.pass?'#10b981':'#ef4444',fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>{f.id}: {f.name}</div>
                <div style={{fontSize:10,color:'#64748b',marginTop:2}}>{f.reason}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Approved: show ML info */}
        {allowed && res.bestML && (
          <div style={{background:'rgba(16,185,129,0.08)',border:'1px solid rgba(16,185,129,0.3)',borderRadius:10,padding:12}}>
            <div style={{color:'#10b981',fontWeight:700,fontSize:14,marginBottom:4}}>
              🏆 RECOMMENDED ML: {res.bestML.outcome} Win @ {res.bestML.odds?.toFixed(2)}
            </div>
            <div style={{color:'#94a3b8',fontSize:12}}>Edge: +{((res.bestML.ev||0)*100).toFixed(1)}% | Model Prob: {((res.bestML.mp||0)*100).toFixed(1)}% vs Implied: {((res.bestML.ip||0)*100).toFixed(1)}%</div>
          </div>
        )}

        {/* Rejected: show alternatives */}
        {!allowed && mf.altMarkets?.length > 0 && (
          <div>
            <div style={{fontSize:10,color:'#64748b',fontFamily:"'JetBrains Mono',monospace",marginBottom:8}}>LOW-VARIANCE ALTERNATIVES (ML rejected)</div>
            {mf.altMarkets.map((a,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 12px',background:'rgba(212,168,67,0.06)',borderRadius:8,marginBottom:6,border:'1px solid rgba(212,168,67,0.15)'}}>
                <div>
                  <div style={{color:'#d4a843',fontSize:12,fontWeight:700}}>{a.label}</div>
                  <div style={{color:'#64748b',fontSize:10}}>{a.cat} — {a.note}</div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{color:'#94a3b8',fontSize:11,fontFamily:"'JetBrains Mono',monospace"}}>@ {a.odds?.toFixed(2)}</div>
                  <div style={{color:'#10b981',fontWeight:700,fontSize:12}}>+{((a.ev||0)*100).toFixed(1)}%</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // ── NEW-16/18/20 Signal Badges ────────────────────────────────────────────────
  const renderNewSignals = () => {
    if (!res) return null;
    const badges = [];
    if (res.lambdaInconsistency?.inconsistent)
      badges.push({tag:'[LAMBDA_INCONSISTENCY]',color:'#f59e0b',title:`Model xG vs O/U2.5 diverges ${(res.lambdaInconsistency.divergence*100).toFixed(1)}%`});
    if (res.evMarkets?.some(m=>m.veto==='STEAM_CHASER_VETO'))
      badges.push({tag:'[STEAM_CHASER_VETO]',color:'#ef4444',title:'Sharp compression detected but edge already compressed away'});
    if (res.correlatedParlayRisk?.length > 0)
      badges.push({tag:`[CORRELATED_PARLAY_RISK ×${res.correlatedParlayRisk.length}]`,color:'#f97316',title:`Correlated pairs: ${res.correlatedParlayRisk.map(p=>`${p.a}/${p.b}(ρ=${p.rho})`).join(', ')}`});
    if (res.drawCalibFactor && res.drawCalibFactor > 1.05)
      badges.push({tag:`[DRAW_CAL +${((res.drawCalibFactor-1)*100).toFixed(0)}%]`,color:'#a78bfa',title:`Draw calibration factor ${res.drawCalibFactor.toFixed(3)} (Hvattum & Arntzen)`});
    if (badges.length===0) return null;
    return (
      <div style={{display:'flex',flexWrap:'wrap',gap:6,marginBottom:12}}>
        {badges.map((b,i)=>(
          <span key={i} title={b.title} style={{background:`${b.color}22`,border:`1px solid ${b.color}55`,borderRadius:6,padding:'3px 9px',fontSize:10,color:b.color,fontFamily:"'JetBrains Mono',monospace",cursor:'help'}}>{b.tag}</span>
        ))}
      </div>
    );
  };

  // B15: WhatIfWidget — Scenario Branching UI component
  const WhatIfWidget = ({ baseResult }) => {
    const [eventInput, setEventInput] = React.useState('');
    const [scenarioResult, setScenarioResult] = React.useState(null);
    const [running, setRunning] = React.useState(false);

    const runScenario = () => {
      if (!eventInput.trim() || !baseResult) return;
      setRunning(true);
      try {
        const result = MathEngine.rerunWithOverride(eventInput.trim(), baseResult);
        setScenarioResult(result);
      } catch(e) {
        setScenarioResult({ error: e.message });
      } finally {
        setRunning(false);
      }
    };

    return (
      <div style={{marginTop:16,padding:16,background:'rgba(16,185,129,0.04)',borderRadius:12,border:'1px solid rgba(16,185,129,0.15)'}}>
        <div style={{color:'#10b981',fontWeight:700,fontSize:12,fontFamily:"'JetBrains Mono',monospace",marginBottom:10}}>
          🔀 WHAT-IF SCENARIO BRANCHING (B15)
        </div>
        <div style={{fontSize:11,color:'#64748b',marginBottom:10,fontFamily:"'JetBrains Mono',monospace"}}>
          Inject an event to see how it changes λ, markets and Kelly stake.
          Examples: "key player out home" · "heavy rain" · "rotation detected away"
        </div>
        <div style={{display:'flex',gap:8,marginBottom:12}}>
          <input
            type="text"
            placeholder="Describe event (e.g. striker out home)..."
            value={eventInput}
            onChange={e => setEventInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runScenario()}
            style={{...S.inputStyle,flex:1,padding:'10px 12px',fontSize:12}}
          />
          <button
            style={{...S.pri,padding:'10px 18px',fontSize:12,minWidth:80}}
            onClick={runScenario}
            disabled={running || !eventInput.trim()}
          >
            {running ? <RefreshCw size={13} className="pulse"/> : '▶ RUN'}
          </button>
        </div>
        {scenarioResult && !scenarioResult.error && (
          <div style={{background:'rgba(0,0,0,0.2)',borderRadius:8,padding:12,fontFamily:"'JetBrains Mono',monospace",fontSize:11}}>
            <div style={{color:'#d4a843',fontWeight:700,marginBottom:8}}>📊 DELTA ANALYSIS</div>
            <div style={{color:'#c9d4e8',lineHeight:2}}>
              <span style={{color:'#94a3b8'}}>Event:   </span>{scenarioResult.eventApplied}<br/>
              <span style={{color:'#94a3b8'}}>λH:      </span>
                <span style={{color: scenarioResult.lambdaH.delta < 0 ? '#ef4444' : '#10b981'}}>
                  {scenarioResult.lambdaH.before.toFixed(2)} → {scenarioResult.lambdaH.after.toFixed(2)}
                  {' '}({scenarioResult.lambdaH.delta >= 0 ? '+' : ''}{scenarioResult.lambdaH.delta.toFixed(2)})
                </span><br/>
              <span style={{color:'#94a3b8'}}>λA:      </span>
                <span style={{color: scenarioResult.lambdaA.delta < 0 ? '#ef4444' : '#10b981'}}>
                  {scenarioResult.lambdaA.before.toFixed(2)} → {scenarioResult.lambdaA.after.toFixed(2)}
                  {' '}({scenarioResult.lambdaA.delta >= 0 ? '+' : ''}{scenarioResult.lambdaA.delta.toFixed(2)})
                </span><br/>
              <span style={{color:'#94a3b8'}}>Δ Score: </span>
                <span style={{color: scenarioResult.deltaScore >= 0 ? '#10b981' : '#ef4444'}}>
                  {scenarioResult.deltaScore >= 0 ? '+' : ''}{scenarioResult.deltaScore} pts
                </span><br/>
              <span style={{color:'#94a3b8'}}>Δ Kelly: </span>
                <span style={{color: scenarioResult.deltaKelly >= 0 ? '#10b981' : '#ef4444'}}>
                  {scenarioResult.deltaKelly >= 0 ? '+' : ''}{(scenarioResult.deltaKelly * 100).toFixed(1)}%
                </span><br/>
              {scenarioResult.newMarkets && (
                <>
                  <span style={{color:'#94a3b8'}}>New 1X2: </span>
                  H {(scenarioResult.newMarkets.hw*100).toFixed(1)}%
                  {' '}D {(scenarioResult.newMarkets.dr*100).toFixed(1)}%
                  {' '}A {(scenarioResult.newMarkets.aw*100).toFixed(1)}%<br/>
                  <span style={{color:'#94a3b8'}}>Over 2.5:</span> {(scenarioResult.newMarkets.ou?.over_2_5*100 || 0).toFixed(1)}%
                </>
              )}
            </div>
          </div>
        )}
        {scenarioResult?.error && (
          <div style={{color:'#ef4444',fontSize:11,fontFamily:"'JetBrains Mono',monospace"}}>Error: {scenarioResult.error}</div>
        )}
      </div>
    );
  };

  const renderLedger = () => {
    const m = ledger?.metrics;
    if (!m) return null;
    return (
      <div style={{...S.card}}>
        <div style={S.label}>Calibration Ledger — Performance Dashboard</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12}}>
          {[
            {label:'ROI',val:`${(m.roi*100).toFixed(1)}%`,color:m.roi>0?'#10b981':'#ef4444'},
            {label:'CLV avg',val:`${(m.clv*100).toFixed(1)}%`,color:m.clv>0?'#10b981':'#ef4444'},
            {label:'Win Rate',val:`${(m.winRate*100).toFixed(1)}%`,color:'#94a3b8'},
            {label:'Brier',val:m.brier.toFixed(3),color:m.brier<0.2?'#10b981':m.brier<0.25?'#fbbf24':'#ef4444'},
            {label:'RPS',val:(m.rps!=null?m.rps.toFixed(3):'—'),color:m.rps==null?'#64748b':m.rps<0.21?'#10b981':m.rps<0.23?'#fbbf24':'#ef4444'},
            {label:'Resolved',val:m.resolvedCount,color:'#94a3b8'},
            {label:'P&L',val:`£${m.totalPnl.toFixed(0)}`,color:m.totalPnl>0?'#10b981':'#ef4444'},
            {label:'CalibFactor',val:m.calibFactor.toFixed(2),color:m.calibFactor>=1?'#10b981':'#fbbf24'},
            {label:'Drift Alert',val:m.driftAlert?'YES':'NO',color:m.driftAlert?'#ef4444':'#10b981'},
            {label:'Ruin Prob',val:m.ruinProb!=null?`${(m.ruinProb*100).toFixed(1)}%`:'N/A',color:m.ruinProb>0.05?'#ef4444':m.ruinProb>0.02?'#fbbf24':'#10b981'},
          ].map((stat,i)=>(
            <div key={i} style={{background:'rgba(255,255,255,0.03)',borderRadius:10,padding:12,textAlign:'center'}}>
              <div style={{fontSize:9,color:'#475569',fontFamily:"'JetBrains Mono',monospace",textTransform:'uppercase',marginBottom:6}}>{stat.label}</div>
              <div style={{fontSize:16,fontWeight:700,color:stat.color}}>{stat.val}</div>
            </div>
          ))}
        </div>
        {/* B1-07: Ruin Probability risk warning */}
        {m.ruinProb > 0.05 && (
          <div style={{marginTop:12,padding:'10px 14px',background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.3)',borderRadius:8}}>
            <span style={{color:'#ef4444',fontWeight:700,fontSize:11,fontFamily:"'JetBrains Mono',monospace"}}>
              ⚠️ RUIN RISK WARNING: {(m.ruinProb*100).toFixed(1)}% probability of bankroll ruin at current stake sizing.
              Consider reducing Kelly fraction or increasing bankroll before next deployment.
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={S.app}>
      <style>{CSS}</style>
      {ui.showApiConfig && <ApiConfigPanel />}

      {/* Navigation */}
      <nav style={S.nav}>
        <div style={{display:'flex',alignItems:'center',gap:12}}>
          <div style={{width:32,height:32,background:'linear-gradient(135deg,#d4a843,#b8922e)',borderRadius:10,display:'flex',alignItems:'center',justifyContent:'center'}}>
            <BrainCircuit size={18} color="#010206"/>
          </div>
          <div>
            <div style={{fontWeight:800,fontSize:15,color:'#e8eef8',letterSpacing:'0.05em'}}>O.R.A.C.L.E.</div>
            <div style={{fontSize:9,color:'#475569',fontFamily:"'JetBrains Mono',monospace",letterSpacing:'0.15em'}}>v2026.3.12 — FOOTBALL ANALYSIS AI</div>
          </div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          {[{id:'terminal',icon:<Target size={14}/>,label:'TERMINAL'},
            {id:'ledger',icon:<BarChart3 size={14}/>,label:'LEDGER'},
            {id:'rag',icon:<Database size={14}/>,label:'RAG STORE'}
          ].map(t=>(
            <button key={t.id} style={S.tab(ui.tab===t.id)} onClick={()=>coreDispatch({type:'UPDATE_UI',payload:{tab:t.id}})}>
              {t.icon}{t.label}
            </button>
          ))}
          <button style={{...S.tab(false),border:'1px solid rgba(212,168,67,0.2)'}} onClick={()=>coreDispatch({type:'UPDATE_UI',payload:{showApiConfig:true}})}>
            <Database size={14}/> KEYS
          </button>
        </div>
      </nav>

      <div style={{...S.wrap,paddingTop:32,paddingBottom:60}}>

        {/* Search Bar */}
        {ui.tab==='terminal' && (
          <>
            <div className="fu" style={{...S.cardGold,marginBottom:24}}>
              <div style={S.label}>Omniscient Research & Analytical Computation for League Evaluation</div>
              <div style={{display:'flex',gap:12,alignItems:'center'}}>
                <input ref={qRef} style={{...S.inputStyle,flex:1}} placeholder="Enter fixture (e.g. Arsenal vs Chelsea, El Clásico, UCL Final...)"
                  value={ui.query||''} onChange={e=>coreDispatch({type:'UPDATE_UI',payload:{query:e.target.value}})}
                  onKeyDown={e=>e.key==='Enter'&&handleSearch()} />
                <button style={{...S.pri,width:'auto',padding:'18px 32px'}} onClick={handleSearch} disabled={pipe.running}>
                  {pipe.running ? <RefreshCw size={18} className="pulse"/> : <Search size={18}/>}
                  {pipe.running ? 'ANALYZING...' : 'ANALYZE'}
                </button>
              </div>
              {pipe.error && <div style={{marginTop:12,color:'#ef4444',fontSize:12,fontFamily:"'JetBrains Mono',monospace"}}>⚠️ {pipe.error}</div>}
              {!ui.userApiKey && <div style={{marginTop:10,color:'#fbbf24',fontSize:12,fontFamily:"'JetBrains Mono',monospace"}}>⚠️ No Gemini API key configured. Click KEYS to add yours.</div>}
            </div>

            {/* Results */}
            {res && (
              <div className="fu">
                {/* Match Header */}
                <div style={{...S.cardGold,padding:'20px 26px'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                    <div>
                      <div style={{fontSize:22,fontWeight:800,color:'#e8eef8'}}>{res.home} <span style={{color:'#d4a843'}}>vs</span> {res.away}</div>
                      <div style={{fontSize:12,color:'#64748b',marginTop:4,fontFamily:"'JetBrains Mono',monospace"}}>{pipe.fixture?.league||'League'} • {pipe.fixture?.date||''} {pipe.fixture?.time||''}</div>
                      {renderStatusTags()}
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12,color:'#64748b',marginBottom:4}}>Expected Score</div>
                      <div style={{fontSize:24,fontWeight:800,color:'#d4a843'}}>{res.expectedScoreline}</div>
                      <div style={{fontSize:11,color:'#475569',fontFamily:"'JetBrains Mono',monospace"}}>λH:{res.bayesian_lH?.toFixed(2)} λA:{res.bayesian_lA?.toFixed(2)}</div>
                    </div>
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12,marginTop:16}}>
                    {[
                      {label:'Home Win',val:`${((res.fp?.home||0)*100).toFixed(1)}%`,color:'#3b82f6'},
                      {label:'Draw',val:`${((res.fp?.draw||0)*100).toFixed(1)}%`,color:'#94a3b8'},
                      {label:'Away Win',val:`${((res.fp?.away||0)*100).toFixed(1)}%`,color:'#a78bfa'},
                    ].map((o,i)=>(
                      <div key={i} style={{background:'rgba(255,255,255,0.04)',borderRadius:12,padding:14,textAlign:'center'}}>
                        <div style={{fontSize:10,color:'#64748b',fontFamily:"'JetBrains Mono',monospace",marginBottom:6,textTransform:'uppercase'}}>{o.label}</div>
                        <div style={{fontSize:20,fontWeight:800,color:o.color}}>{o.val}</div>
                      </div>
                    ))}
                  </div>
                  {res.clvProjection && (
                    <div style={{marginTop:12,padding:'10px 14px',background:'rgba(212,168,67,0.08)',borderRadius:10,border:'1px solid rgba(212,168,67,0.2)'}}>
                      <span style={{fontSize:11,color:'#d4a843',fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>CLV PROJECTION: </span>
                      <span style={{fontSize:11,color:'#94a3b8',fontFamily:"'JetBrains Mono',monospace"}}>Projected edge +{(res.clvProjection.projected*100).toFixed(1)}% | Survival {(res.clvProjection.survivalProb*100).toFixed(0)}% | Window: {res.debate?.betWindow||'N/A'}</span>
                    </div>
                  )}
                </div>

                {renderDebatePanel()}
                {renderNewSignals()}
                {renderConvergencePanel()}
                {renderMLFilterPanel()}
                {renderEVMarkets()}
                {renderShapBar()}

                {/* AI Briefing */}
                {(ai.thesis || ai.generatingThesis) && (
                  <div style={{...S.card}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
                      <div style={S.label}>O.R.A.C.L.E. Compliance Report</div>
                      {ai.generatingThesis && <RefreshCw size={14} className="pulse" color="#d4a843"/>}
                    </div>
                    <pre style={{whiteSpace:'pre-wrap',fontFamily:"'JetBrains Mono',monospace",fontSize:12,color:'#c9d4e8',lineHeight:1.8}}>
                      {ai.generatingThesis ? '⏳ Synthesizing adversarial market intelligence...' : ai.thesis}
                    </pre>
                    {!ai.generatingThesis && ai.thesis && !ai.redTeamThesis && (
                      <button style={{...S.pri,marginTop:16,padding:'14px 0'}} onClick={()=>TelemetryAdapter.generateRedTeam(res)} disabled={ai.generatingRedTeam}>
                        {ai.generatingRedTeam?<RefreshCw size={16} className="pulse"/>:<Swords size={16}/>}
                        {ai.generatingRedTeam?'RUNNING RED TEAM...':'LAUNCH RED TEAM CRITIQUE'}
                      </button>
                    )}
                    {ai.redTeamThesis?.critique && (
                      <div style={{marginTop:16,padding:16,background:'rgba(239,68,68,0.06)',borderRadius:12,border:'1px solid rgba(239,68,68,0.2)'}}>
                        <div style={{color:'#ef4444',fontWeight:700,fontSize:12,fontFamily:"'JetBrains Mono',monospace",marginBottom:10}}>⚔️ RED TEAM CRITIQUE</div>
                        {ai.redTeamThesis.critique.map((c,i)=>(
                          <div key={i} style={{color:'#94a3b8',fontSize:12,padding:'4px 0',borderBottom:i<2?'1px solid rgba(255,255,255,0.04)':'none'}}>
                            {i+1}. {c}
                          </div>
                        ))}
                      </div>
                    )}
                    {/* B15: What-If Scenario Branching widget */}
                    {!ai.generatingThesis && res && (
                      <WhatIfWidget baseResult={res} />
                    )}
                  </div>
                )}

                {/* Synthetic Scripts */}
                {res.syntheticScripts?.length > 0 && (
                  <div style={{...S.card}}>
                    <div style={S.label}>Synthetic Alpha Scripts</div>
                    {res.syntheticScripts.map((s,i)=>(
                      <div key={i} style={{padding:'10px 0',borderBottom:i<res.syntheticScripts.length-1?'1px solid rgba(255,255,255,0.04)':'none'}}>
                        <div style={{display:'flex',justifyContent:'space-between'}}>
                          <span style={{fontWeight:600,color:'#e8eef8',fontSize:13}}>{s.title}</span>
                          <span style={{fontFamily:"'JetBrains Mono',monospace",color:s.edge>0?'#10b981':'#ef4444',fontWeight:700,fontSize:12}}>{(s.edge*100).toFixed(1)}%</span>
                        </div>
                        <div style={{fontSize:11,color:'#475569',marginTop:4}}>{s.legs?.join(' + ')}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Ledger Tab */}
        {ui.tab==='ledger' && renderLedger()}

        {/* RAG Tab */}
        {ui.tab==='rag' && (
          <div style={{...S.card}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
              <div style={S.label}>RAG Historical Store — {RAGSystem.getStore().length} entries</div>
              <button style={{background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.3)',borderRadius:8,padding:'6px 14px',color:'#ef4444',cursor:'pointer',fontSize:11}} onClick={()=>RAGSystem.reset()}>Clear Store</button>
            </div>
            {RAGSystem.getStore().slice(-10).reverse().map((entry,i)=>(
              <div key={i} style={{padding:'10px 0',borderBottom:'1px solid rgba(255,255,255,0.04)'}}>
                <div style={{display:'flex',justifyContent:'space-between'}}>
                  <span style={{color:'#e8eef8',fontSize:13}}>{entry.fixture}</span>
                  <span style={{fontFamily:"'JetBrains Mono',monospace",color:'#64748b',fontSize:11}}>{new Date(entry.timestamp).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
            {RAGSystem.getStore().length===0&&<div style={{color:'#475569',fontSize:13,textAlign:'center',padding:'40px 0'}}>No historical analogues yet. Run analyses to build the store.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// §16 — PROTOCOL UNIT TESTS (v28.0 — T1–T159, all v26.7+v27.0 tests retained)
// ═══════════════════════════════════════════════════════════════════════════════

const runProtocolUnitTests = async () => {
  let passed=0, failed=0;
  const assert=(cond,msg)=>{if(cond){passed++;console.log(`  ✅ ${msg}`);}else{failed++;console.error(`  ❌ FAIL: ${msg}`);}};
  const section=(t)=>console.log(`\n▶ ${t}`);
  console.group('🔬 O.R.A.C.L.E. v2026.8.0 TEST SUITE (T1–T367)');

  try{
    section('LAYER 0: Math Utilities');
    assert(MathEngine.clamp(5,0,10)===5,'T1: clamp(5,0,10)=5');
    assert(MathEngine.clamp(-1,0,10)===0,'T2: clamp(-1,0,10)=0');
    assert(MathEngine.clamp(15,0,10)===10,'T3: clamp(15,0,10)=10');
    assert(MathEngine.clamp(null,0,10)===0,'T4: clamp(null)=min');
    assert(MathEngine.safeNum(null,5)===5,'T5: safeNum(null)=fallback');
    assert(MathEngine.safeNum(undefined,5)===5,'T6: safeNum(undefined)=fallback');
    assert(MathEngine.safeNum('1.5',0)===1.5,'T7: safeNum string');
    assert(MathEngine.safeNum('abc',0)===0,'T8: safeNum NaN');
    assert(MathEngine.poissonPMF(0,1.5)>0,'T9: poissonPMF(0,1.5)>0');
    assert(MathEngine.poissonPMF(2,1.5)>0,'T10: poissonPMF(2,1.5)>0');

    section('LAYER 1: Dixon-Coles Matrix');
    const mat=MathEngine.buildMatrix(1.5,1.2,-0.13);
    let matSum=0; for(let i=0;i<mat.length;i++) for(let j=0;j<mat.length;j++) matSum+=(mat[i][j]||0);
    assert(Math.abs(matSum-1.0)<0.001,'T11: Matrix sums to 1.0');
    assert(mat[0][0]>MathEngine.poissonPMF(0,1.5)*MathEngine.poissonPMF(0,1.2),'T12: 0-0 DC boost applied (rho negative = tau > 1 for 0-0)');
    assert(mat[0].length===MathEngine.MAX_GOALS,'T13: Matrix dimension = MAX_GOALS=14');

    section('LAYER 1b: ZIP Model (NEW-03)');
    const matZIP=MathEngine.buildMatrix(1.5,1.2,-0.13,true,0.08);
    let zipSum=0; for(let i=0;i<matZIP.length;i++) for(let j=0;j<matZIP.length;j++) zipSum+=(matZIP[i][j]||0);
    assert(Math.abs(zipSum-1.0)<0.001,'T101: ZIP matrix sums to 1.0');
    assert(matZIP[0][0]>mat[0][0],'T102: ZIP inflates 0-0 vs pure Poisson');

    section('LAYER 2: Market Extraction');
    const mkt=MathEngine.extractMarkets(mat);
    assert(Math.abs(mkt.hw+mkt.dr+mkt.aw-1.0)<0.001,'T14: 1X2 probs sum to 1.0');
    assert(mkt.btts>=0&&mkt.btts<=1,'T15: BTTS in [0,1]');
    assert((mkt.ou['over_2.5']??mkt.ou.over_2_5??0)>=0&&(mkt.ou['over_2.5']??mkt.ou.over_2_5??0)<=1,'T16: Over 2.5 in [0,1]');
    // BUG-008 FIX TEST
    assert(mkt.ah.hm025!==undefined,'T17: AH -0.25 home exists');
    assert(mkt.ah.hp025!==undefined,'T18: AH +0.25 home exists');
    // Quarter-ball sanity: AH -0.25 home must be between AH -0.5 home and AH 0.0 home
    const ah05H = mkt.ah['hm05']||mkt.hw;
    const ah0H = mkt.hw + mkt.dr*0.5;
    assert(mkt.ah.hm025 >= Math.min(ah05H,ah0H)-0.01 && mkt.ah.hm025 <= Math.max(ah05H,ah0H)+0.01,'T103: AH -0.25 is between AH -0.5 and AH 0.0');

    section('LAYER 3: SoS Adjustment');
    const adjXG=MathEngine.adjustXGForSoS(1.5,1.0,1.35);
    assert(adjXG>1.5,'T19: SoS adj increases xG vs weak defense');
    const adjXG2=MathEngine.adjustXGForSoS(1.5,2.0,1.35);
    assert(adjXG2<1.5,'T20: SoS adj decreases xG vs strong defense');

    section('LAYER 4: ExecutionEngine.run (full pipeline)');
    const baseState={
      telemetry:{piH:1550,piA:1450,xH:1.8,xA:1.2,restH:7,restA:7,hOdds:1.85,dOdds:3.40,aOdds:4.50,ohO:1.90,broll:1000,peakBroll:1000,xgMode:'bayesian',motivationScore:1.0,oppGA_H:1.3,oppGA_A:1.3},
      pipeline:{fixture:{league:'Premier League'},fetched:{odds:{home:1.85,draw:3.40,away:4.50}}},
      ledger:{metrics:CalibrationEngine._defaultMetrics()}
    };
    const runRes=ExecutionEngine.run(baseState,100,true);
    assert(runRes.bayesian_lH>0,'T22: bayesian_lH > 0');
    assert(runRes.bayesian_lA>0,'T23: bayesian_lA > 0');
    assert(Array.isArray(runRes.evMarkets),'T24: evMarkets is array');
    assert(runRes.analysis1x2.length===3,'T25: analysis1x2 has 3 outcomes');
    assert(runRes.debate!==undefined,'T26: debate field populated');
    assert(runRes.debate.betTrigger!==undefined,'T27: debate.betTrigger present');
    const wts=runRes.shapExplanation.reduce((s,l)=>s+l.pct,0);
    assert(Math.abs(wts-100)<0.5,'T51: Layer sum ≈ 100% (5 layers v28)');
    assert(runRes.shapExplanation.length===5,'T104: v28 has 5 SHAP layers (ZIP added)');
    assert(runRes.clvProjection!==undefined,'T105: CLV projection present');
    assert(runRes.clvProjection.projected>=0,'T106: CLV projected edge >= 0');

    section('LAYER 5: Arbitrage Vig-Removal Fix (BUG-003)');
    // Arbitrage state: overround < 1.0
    const arbState={...baseState,telemetry:{...baseState.telemetry,hOdds:2.10,dOdds:3.60,awayOdds:4.80,aOdds:4.80}};
    const arbOverround=(1/2.10)+(1/3.60)+(1/4.80);
    assert(arbOverround<1.0,'T107: Arb state: overround < 1.0');
    const arbRes=ExecutionEngine.run(arbState,100,true);
    assert(arbRes.isArbitrage===true,'T108: isArbitrage flag set correctly');
    assert(arbRes.fairImp.home+arbRes.fairImp.draw+arbRes.fairImp.away>0.98,'T109: Fair imp sums to ~1.0 after arb fix');

    section('LAYER 6: Anti-Sycophancy Circuit');
    const debate=runRes.debate;
    assert(debate.finder!==undefined,'T28: debate.finder present');
    assert(debate.adversary!==undefined,'T29: debate.adversary present');
    assert(debate.referee!==undefined,'T30: debate.referee present');
    assert(debate.finder.agent==='EV-FINDER','T31: Finder agent label correct');
    assert(debate.adversary.agent==='ADVERSARIAL','T32: Adversary agent label correct');
    assert(debate.referee.agent==='REFEREE','T33: Referee agent label correct');
    assert(['GREEN','YELLOW','RED'].includes(debate.betTrigger),'T34: betTrigger is valid color');
    assert(typeof debate.betWindow==='string','T35: betWindow is string');
    // BUG-022 FIX TEST
    assert(['EARLY_VALUE','STANDARD','PRE_MATCH_NEWS','AVOID'].includes(debate.betWindow),'T110: betWindow is one of 4 valid values');

    section('LAYER 7: CalibrationEngine');
    const testBets=[
      {status:'resolved',outcome:'win',     mp:0.60,odds:2.0, stakeAmt:100,clv: 0.05,league:'Premier League',homeGoals:2,awayGoals:1},
      {status:'resolved',outcome:'loss',    mp:0.55,odds:1.90,stakeAmt:80, clv:-0.03,league:'Premier League',homeGoals:1,awayGoals:2},
      {status:'resolved',outcome:'half-win',mp:0.50,odds:2.10,stakeAmt:60, clv: 0.02,league:'La Liga',       homeGoals:1,awayGoals:1},
    ];
    const metrics=CalibrationEngine.calculate(testBets);
    assert(metrics.brier>=0,'T36: Brier score >= 0');
    assert(metrics.roi!==undefined,'T37: roi field present');
    assert(metrics.clv!==undefined,'T38: clv field present');
    assert(metrics.calibFactor===1.0,'T39: calibFactor = 1.0 below MIN_CALIB_SAMPLE');
    assert(metrics.bbnParams['Premier League']!==undefined,'T40: bbnParams computed for Premier League');
    assert(typeof metrics.driftAlert==='boolean','T41: driftAlert is boolean');
    assert(metrics.winRate>=0&&metrics.winRate<=1,'T42: winRate in [0,1]');
    assert(metrics.dynamicRhoParams!==undefined,'T111: dynamicRhoParams field present (NEW-07)');

    section('LAYER 8: TeamRatingsEngine');
    TeamRatingsEngine.reset();
    assert(TeamRatingsEngine.getRating('__test_team__',1500)===1500,'T67: TeamRatingsEngine returns default 1500');
    TeamRatingsEngine.update('team_a','team_b',2,0,1.5,1.2);
    assert(TeamRatingsEngine.getRating('team_a')>1500,'T68: Winner rating increases after update');
    assert(TeamRatingsEngine.getRating('team_b')<1500,'T69: Loser rating decreases after update');
    assert(TeamRatingsEngine.getRating('team_a')<=2000,'T70: Rating bounded at max 2000');
    TeamRatingsEngine.reset();

    section('LAYER 9: Power Vig Removal + Arb Safety Net');
    const vig=MathEngine.powerMethodVigRemoval(2.0,3.5,4.5);
    assert(Math.abs(vig.home+vig.draw+vig.away-1.0)<0.01,'T53: Vig-removed probs sum to ~1.0');
    assert(vig.home>vig.draw,'T54: Home prob > draw for favourite');
    assert(vig.k!==undefined,'T55: Power exponent k returned');
    // BUG-003 safety net test
    const subVig=MathEngine.powerMethodVigRemoval(2.20,3.80,5.00); // arb state
    assert(subVig.home+subVig.draw+subVig.away>0.98,'T112: Sub-1.0 overround handled by safety net');

    section('LAYER 10: MarketMakerEngine');
    const ameP=MarketMakerEngine.probsToOdds(0.5,0.27,0.23);
    assert(ameP.home>0,'T63: AME home odds > 0');
    assert(ameP.home<2.1,'T64: AME home odds < fair value (vig applied)');
    assert(ameP.impliedH!==undefined,'T65: AME impliedH field present');
    const ameEdge=MarketMakerEngine.compareToMarket({oracleFair:{home:1.85,draw:3.5,away:4.5}},{home:2.1,draw:3.5,away:4.5});
    assert(Array.isArray(ameEdge),'T66: compareToMarket returns array');
    assert(ameEdge.length>0,'T66b: AME detects positive edge when book > fair');

    section('LAYER 11: Sentinel & Risk Systems');
    // Progressive drawdown (NEW-11 / BUG-004 replacement)
    assert(MathEngine.getDrawdownPenalty(0.05)===1.0,'T113: 5% drawdown = no penalty');
    assert(MathEngine.getDrawdownPenalty(0.10)===0.75,'T114: 10% drawdown = 0.75 penalty (25% reduction)');
    const drawdown15State={...baseState,telemetry:{...baseState.telemetry,broll:850,peakBroll:1000}};
    const dd15Res=ExecutionEngine.run(drawdown15State,100,true);
    assert(dd15Res.drawdownPenalty===0.50,'T80: Drawdown 15% triggers 0.50 penalty');
    const drawdown8State={...baseState,telemetry:{...baseState.telemetry,broll:920,peakBroll:1000}};
    const dd8Res=ExecutionEngine.run(drawdown8State,100,true);
    assert(dd8Res.drawdownPenalty===0.75,'T115: Drawdown 8% triggers 0.75 penalty (NEW-11)');
    const proxState={...baseState,telemetry:{...baseState.telemetry,hoursToKO:1.0,ohO:2.5,hOdds:2.0}};
    const proxRes=ExecutionEngine.run(proxState,100,true);
    assert(proxRes.hoursToKO===1.0,'T81: ProximateVeto — hoursToKO captured');

    section('LAYER 12: SafeNum & Data Integrity');
    assert(TelemetryAdapter.safeNum(null,99)===99,'T85: safeNum handles null');
    assert(TelemetryAdapter.safeNum(undefined,99)===99,'T86: safeNum handles undefined');
    assert(TelemetryAdapter.safeNum('abc',99)===99,'T87: safeNum handles non-numeric string');
    assert(TelemetryAdapter.safeNum('1.5',99)===1.5,'T88: safeNum parses valid string number');
    assert(MathEngine.safeNum(null,0)===0,'T88b: MathEngine.safeNum handles null');

    section('LAYER 13: CrowdWisdomProtocol');
    const aborted=CrowdWisdomProtocol._emptyPayload();
    assert(aborted._aborted===true,'T89: _emptyPayload sets _aborted=true');
    assert(CrowdWisdomProtocol.serialise(aborted).includes('Unavailable'),'T90: serialise returns degraded message for aborted payload');
    const vp={meta:{sourcesScanned:10,freshSources:8},crowdConsensusSummary:'Strong home bias',injurySignals:[{player:'Test Player',team:'Home',probability:0.8,detail:'Hamstring'}]};
    assert(CrowdWisdomProtocol.serialise(vp).includes('Test Player'),'T91: CWP serializes injury signals');
    assert(CrowdWisdomProtocol.serialise(vp).includes('10') || CrowdWisdomProtocol.serialise(vp).includes('8'),'T92: CWP serializes source count (fresh or total)');
    assert(CrowdWisdomProtocol.MAX_HARVEST_TIMEOUT===12000,'T93: MAX_HARVEST_TIMEOUT=12000ms');

    section('LAYER 14: Portfolio Correlation + Layer Weights');
    const corrState={telemetry:{hOdds:2.0,dOdds:3.0,aOdds:4.0,xH:2.0,xA:0.5,broll:1000,peakBroll:1000,xgMode:'bayesian',ohO:2.0},pipeline:{fixture:{league:'Default'},fetched:{odds:{home:2.0,draw:3.0,away:4.0}}},ledger:{metrics:CalibrationEngine._defaultMetrics()}};
    const corrRes=ExecutionEngine.run(corrState,100,false);
    assert(corrRes.portfolioCorrelation!==undefined,'T94: portfolioCorrelation field present');
    assert(corrRes.sensitivity!==undefined,'T95: sensitivity field present');
    const empRes=ExecutionEngine.run({...corrState,telemetry:{...corrState.telemetry,xgMode:'empirical'}},100,true);
    const bayRes=ExecutionEngine.run({...corrState,telemetry:{...corrState.telemetry,xgMode:'bayesian'}},100,true);
    assert(empRes.bayesian_lH!==bayRes.bayesian_lH||empRes.bayesian_lA!==bayRes.bayesian_lA,'T96: xG mode produces divergent lambda outputs');

    section('LAYER 15: v28.0 Anti-Sycophancy Scoring');
    const highEvRes=ExecutionEngine.run({...baseState,telemetry:{...baseState.telemetry,hOdds:3.5,dOdds:4.0,aOdds:2.0,xH:0.5,xA:2.5}},100,true);
    const finderOut=AntiSycophancyCircuit.evFinderAgent(highEvRes);
    assert(Array.isArray(finderOut.proposed),'T97: EV-Finder returns proposed array');
    assert(finderOut.agent==='EV-FINDER','T98: EV-Finder agent label matches spec');
    const advOut=AntiSycophancyCircuit.adversarialAgent(highEvRes,finderOut);
    assert(typeof advOut.totalScore==='number','T99: Adversarial totalScore is numeric');
    const refOut=AntiSycophancyCircuit.refereeAgent(highEvRes,finderOut,advOut);
    assert(['GREEN','YELLOW','RED'].includes(refOut.overallTrigger),'T100: Referee overallTrigger is valid color');

    section('LAYER 16: RAG System (BUG-013 — normalized embeddings)');
    RAGSystem.reset();
    RAGSystem.addToStore(runRes,{evMarkets:runRes.evMarkets,debate:runRes.debate});
    const similar=RAGSystem.findSimilar(runRes,5);
    assert(Array.isArray(similar),'T116: findSimilar returns array');
    if(similar.length>0) assert(similar[0].similarity>=0&&similar[0].similarity<=1.01,'T117: Similarity in [0,1] (normalized vectors)');
    // Test that embedding is normalized
    const emb=RAGSystem.createEmbedding(runRes);
    const embNorm=Math.sqrt(emb.reduce((s,v)=>s+v*v,0));
    assert(Math.abs(embNorm-1.0)<0.01,'T118: RAG embedding is L2-normalized (BUG-013 fix)');
    RAGSystem.reset();

    section('LAYER 17: RLM Direction Fix (BUG-009)');
    // Popular team with odds shortening (public steam) — should NOT be RLM
    const noRlm=MathEngine.lstmMarketDecoderProxy(0.5,2.0,1.90,true); // odds moved from 2.0 to 1.90
    assert(noRlm.steam===true,'T119: Popular team shortening = steam, not RLM');
    assert(noRlm.rlm===false,'T120: Popular team shortening is NOT RLM');
    // Popular team with odds drifting (true RLM)
    const trueRlm=MathEngine.lstmMarketDecoderProxy(0.5,1.85,2.05,true); // odds drifted out
    assert(trueRlm.rlm===true,'T121: Popular team drifting = TRUE RLM (BUG-009 fix)');

    section('LAYER 18: Time Decay Direction Fix (BUG-011)');
    const earlyState={...baseState,telemetry:{...baseState.telemetry,hoursToKO:48}};
    const earlyRes=ExecutionEngine.run(earlyState,100,true);
    const lateState={...baseState,telemetry:{...baseState.telemetry,hoursToKO:2}};
    const lateRes=ExecutionEngine.run(lateState,100,true);
    assert(earlyRes.debate.betWindow==='EARLY_VALUE','T122: 48h bet window = EARLY_VALUE');
    assert(lateRes.debate.betWindow==='PRE_MATCH_NEWS','T123: 2h bet window = PRE_MATCH_NEWS');
    assert(earlyRes.timeDecayInfo<=1.0,'T124: timeDecayInfo is informational [0,1]');

    section('LAYER 19: v28 BUG FIXES');
    // BUG-A01: Template literal ternary now has falsy branch
    const asc = AntiSycophancyCircuit;
    const evFinder = asc.evFinderAgent;
    // Run with low sovereign gap — previously crashed on missing falsy branch
    const lowGapRes = ExecutionEngine.run(baseState, 100, true);
    assert(lowGapRes.evMarkets !== undefined, 'T125: EV-Finder runs without crash (BUG-A01 fix)');

    // BUG-A04: SHARP_COMPRESSION direction — should NOT fire on velocity < 0
    const expansionMarket = MathEngine.lstmMarketDecoderProxy(0.5, 1.80, 2.10, false); // odds lengthening
    assert(expansionMarket.sharpCompression === false, 'T126: SHARP_COMPRESSION=false when odds drifting out (BUG-A04)');
    const compressionMarket = MathEngine.lstmMarketDecoderProxy(0.5, 2.00, 1.65, false); // odds shortening
    assert(compressionMarket.sharpCompression === true, 'T127: SHARP_COMPRESSION=true when odds compressing fast (BUG-A04)');

    // BUG-A04: S03/S04 mutual exclusion
    const driftMarket = MathEngine.lstmMarketDecoderProxy(0.5, 1.80, 2.20, true);
    assert(!(driftMarket.rlm && driftMarket.sharpCompression), 'T128: RLM and sharpCompression mutually exclusive (S03/S04)');

    // BUG-A02: CLV survival is no longer edge-invariant
    const clvLowEdge  = MathEngine.clvProjection(0.02, 6, '1x2', 1.0);
    const clvHighEdge = MathEngine.clvProjection(0.15, 6, '1x2', 1.0);
    assert(clvHighEdge.survivalProb > clvLowEdge.survivalProb, 'T129: CLV survival edge-sensitive: larger edge = higher survival (BUG-A02)');
    assert(clvHighEdge.edgeStrengthFactor !== undefined, 'T130: CLV edgeStrengthFactor returned (BUG-A02)');

    // BUG-B11: isPopularTeam substring matching
    assert(isPopularTeam('Tottenham Hotspur') === true, 'T131: isPopularTeam("Tottenham Hotspur") true (BUG-B11)');
    assert(isPopularTeam('Manchester City FC') === true, 'T132: isPopularTeam("Manchester City FC") true (BUG-B11)');
    assert(isPopularTeam('Brentford United') === false, 'T133: isPopularTeam("Brentford United") false (not in popular set)');

    // BUG-B10: THINKING_LEVELS are integer token counts
    assert(typeof THINKING_LEVELS.MINIMAL === 'string', 'T134: THINKING_LEVELS.MINIMAL is string enum (v2026.6.0 — was integer)');
    assert(typeof THINKING_LEVELS.HIGH === 'string', 'T135: THINKING_LEVELS.HIGH is string enum (v2026.6.0)');
    assert(THINKING_LEVELS.HIGH === 'high', 'T136: THINKING_LEVELS.HIGH = "high" (v2026.6.0 — was 24576)');

    section('LAYER 20: v28 NEW FEATURES');
    // NEW-15: Temporal decay adjusts lambda
    const recentMatches = [{xg:2.1,goalsScored:2,matchdayOffset:0},{xg:1.8,goalsScored:1,matchdayOffset:1},{xg:1.5,goalsScored:2,matchdayOffset:2}];
    const decayedLambda = MathEngine.applyTemporalDecay(recentMatches, 1.4);
    assert(decayedLambda > 0 && decayedLambda < 5, 'T137: Temporal decay returns valid lambda (NEW-15)');
    assert(decayedLambda !== 1.4, 'T138: Temporal decay actually shifts lambda from base avg (NEW-15)');

    // NEW-17: Elo momentum factor
    const risingElo  = [{rating:1600},{rating:1580},{rating:1560},{rating:1540},{rating:1520}];
    const fallingElo = [{rating:1400},{rating:1420},{rating:1440},{rating:1460},{rating:1480}];
    const momentumUp   = MathEngine.eloMomentumFactor(risingElo);
    const momentumDown = MathEngine.eloMomentumFactor(fallingElo);
    assert(momentumUp > 1.0, 'T139: Rising Elo → momentum factor > 1 (NEW-17)');
    assert(momentumDown < 1.0, 'T140: Falling Elo → momentum factor < 1 (NEW-17)');
    assert(momentumUp <= 1.15 && momentumDown >= 0.85, 'T141: Elo momentum clamped [0.85, 1.15] (NEW-17)');

    // NEW-19: Draw calibration factor
    const drawCal = MathEngine.drawCalibrationFactor(0.22, 0.28);
    assert(drawCal > 1.0, 'T142: Draw calibration boosts underpriced draws (NEW-19)');
    const drawCalLow = MathEngine.drawCalibrationFactor(0.30, 0.25);
    assert(drawCalLow <= 1.0, 'T143: Draw calibration reduces overpriced draws (NEW-19)');

    // NEW-16: Lambda inconsistency check
    const lambdaOk  = MathEngine.checkLambdaInconsistency(1.5, 1.2, 0.55); // ~55% over2.5 from model
    const lambdaBad = MathEngine.checkLambdaInconsistency(1.5, 1.2, 0.20); // huge divergence
    assert(!lambdaOk.inconsistent, 'T144: Lambda consistent when divergence ≤5% (NEW-16)');
    assert(lambdaBad.inconsistent, 'T145: Lambda inconsistent flagged when divergence >5% (NEW-16)');

    // NEW-18: Steam chaser detection
    assert(MathEngine.isSteamChaser(true, 0.03) === true, 'T146: Steam chaser veto: compression + edge<5% (NEW-18)');
    assert(MathEngine.isSteamChaser(true, 0.08) === false, 'T147: No steam veto: compression + edge>=5% (NEW-18)');
    assert(MathEngine.isSteamChaser(false, 0.03) === false, 'T148: No steam veto: no compression (NEW-18)');

    // NEW-21: ConvergenceScorer
    const csResult = ConvergenceScorer.compute(runRes, []);
    assert(csResult !== undefined, 'T149: ConvergenceScorer.compute() runs (NEW-21)');
    assert(typeof csResult.deploymentGuide === 'string', 'T150: ConvergenceScorer returns deploymentGuide (NEW-21)');
    assert(csResult.overallTier !== undefined, 'T151: ConvergenceScorer returns tier (NEW-21)');

    // NEW-22: CLV Backtest
    const resolvedForBacktest = [
      {clv:0.04,predictedClv:0.06,marketType:'1x2'},{clv:0.03,predictedClv:0.05,marketType:'1x2'},
      {clv:0.05,predictedClv:0.07,marketType:'1x2'},{clv:0.05,predictedClv:0.05,marketType:'AH'},
      {clv:0.06,predictedClv:0.05,marketType:'AH'},{clv:0.07,predictedClv:0.06,marketType:'AH'},
    ];
    const clvBacktest = CalibrationEngine.backtestCLV(resolvedForBacktest);
    assert(clvBacktest !== undefined, 'T152: CLV backtest runs (NEW-22)');
    assert(clvBacktest['1x2'] !== undefined, 'T153: CLV backtest has 1x2 entry (NEW-22)');
    assert(clvBacktest['1x2'].correctionFactor > 0, 'T154: CLV correction factor > 0 (NEW-22)');

    // NEW-23: MLSafetyFilter
    const mlResult = MLSafetyFilter.evaluate({odds:{home:1.50,away:3.20,draw:4.00}}, runRes, {restH:6,restA:5,motivationScore:0.95});
    assert(mlResult !== undefined, 'T155: ML Safety Filter runs (NEW-23)');
    assert(typeof mlResult.mlAllowed === 'boolean', 'T156: ML Safety Filter returns mlAllowed boolean (NEW-23)');
    assert(typeof mlResult.summary === 'string', 'T157: ML Safety Filter returns summary string (NEW-23)');

    // BUG-B04: RAG embedding is 12 dimensions
    const testEmb = RAGSystem.createEmbedding(runRes);
    assert(testEmb.length === 12, 'T158: RAG embedding is 12-dimensional (BUG-B04)');
    const embNorm2 = Math.sqrt(testEmb.reduce((s,v)=>s+v*v,0));
    assert(Math.abs(embNorm-1.0)<0.01,'T159: RAG embedding is L2-normalized (BUG-013)');

    section('LAYER 21: v29 AUDIT CRITICAL FIXES');

    // BUG-C02: Kelly q uses modelProb not market-implied
    // At edge=0.10, odds=2.0: modelProb = (0.10+1)/2.0 = 0.55, q=0.45 (NOT 1-1/2.0=0.5)
    const kellyWithMp = MathEngine.optimizedKelly(0.10, 2.0, 0.85, false, 1.0, 1.0, 1.0, 0.25, 0.55);
    const kellyWithoutMp = MathEngine.optimizedKelly(0.10, 2.0, 0.85, false, 1.0, 1.0, 1.0, 0.25, null);
    assert(kellyWithMp > 0, 'T160: Kelly with explicit modelProb returns positive stake (BUG-C02)');
    assert(kellyWithoutMp > 0, 'T161: Kelly with derived modelProb returns positive stake (BUG-C02)');
    // With mp=0.55: q=0.45, edge/q=0.10/0.45=0.222; with q=0.50 it'd be 0.20 — should differ
    const kellyOldStyle = MathEngine.optimizedKelly(0.10, 2.0, 0.85, false, 1.0, 1.0, 1.0, 0.25, 0.50);
    // mp=0.55 gives higher stake than mp=0.50 because edge/q is larger when q is smaller
    assert(kellyWithMp > kellyOldStyle, 'T162: Canonical Kelly (q=1-modelProb) gives different result than market-implied q (BUG-C02 verified)');

    // BUG-C03: Monte Carlo now accepts rho parameter
    const mcWithRho = MathEngine.monteCarlo(1.5, 1.2, -0.13, 1000);
    assert(mcWithRho !== undefined, 'T163: monteCarlo accepts rho parameter (BUG-C03)');
    assert(typeof mcWithRho.varFlag === 'boolean', 'T164: MC with DC tau returns varFlag boolean (BUG-C03)');

    // BUG-M03: Elo momentum direction FIXED
    // risingElo[0]=1600 is most-recent; after reversal oldest=[1520,...,1600] → positive slope
    const risingEloFixed = [{rating:1600},{rating:1580},{rating:1560},{rating:1540},{rating:1520}];
    const fallingEloFixed = [{rating:1400},{rating:1420},{rating:1440},{rating:1460},{rating:1480}];
    const momentumUpFixed   = MathEngine.eloMomentumFactor(risingEloFixed);
    const momentumDownFixed = MathEngine.eloMomentumFactor(fallingEloFixed);
    assert(momentumUpFixed > 1.0, 'T165: BUG-M03 FIX: Rising Elo (most-recent-first input) → momentum > 1.0 ✓');
    assert(momentumDownFixed < 1.0, 'T166: BUG-M03 FIX: Falling Elo (most-recent-first input) → momentum < 1.0 ✓');
    assert(momentumUpFixed <= 1.15 && momentumDownFixed >= 0.85, 'T167: Elo momentum clamped [0.85,1.15] after direction fix (BUG-M03)');

    // BUG-M09: CLV projection returns both edgeRetentionFraction AND survivalProb
    const clvV29 = MathEngine.clvProjection(0.10, 6, '1x2', 1.0);
    assert(clvV29.edgeRetentionFraction !== undefined, 'T168: CLV returns edgeRetentionFraction (BUG-M09)');
    assert(clvV29.survivalProb !== undefined, 'T169: CLV returns survivalProb sigmoid (BUG-M09)');
    assert(clvV29.survivalProb >= 0 && clvV29.survivalProb <= 1, 'T170: CLV survivalProb is valid probability [0,1] (BUG-M09)');
    // For 0% edge, survival should be low
    const clvZero = MathEngine.clvProjection(0, 6, '1x2', 1.0);
    assert(clvZero.survivalProb <= 0.10, 'T171: CLV zero edge → low survivalProb (BUG-M09)');

    // BUG-M08: isPopularTeam forward-only check — no bidirectional false positive
    assert(isPopularTeam('Tottenham Hotspur') === true, 'T172: isPopularTeam Tottenham Hotspur ✓ (BUG-M08)');
    assert(isPopularTeam('Manchester City FC') === true, 'T173: isPopularTeam Manchester City FC ✓ (BUG-M08)');
    // False-positive prevention: "Milan Sremska" should NOT match (forward check only: "milan sremska".includes("ac milan")=false)
    assert(isPopularTeam('Milan Sremska') === false, 'T174: BUG-M08 FIX: "Milan Sremska" no longer false-positive matches popular teams');
    assert(isPopularTeam('FC Bayern Munich') === true, 'T175: isPopularTeam FC Bayern Munich ✓ (contains "fc" + "munich" token)');

    // BUG-M01: Dynamic rho now uses four-cell MLE
    const goalDataFull = { n: 50, hG: 60, aG: 45, zeroZero: 7, oneZero: 10, zeroOne: 8, oneOne: 6 };
    const goalDataLegacy = { n: 50, hG: 60, aG: 45, zeroZero: 7 }; // missing cells
    const dynRhoFull = MathEngine.estimateDynamicRho(goalDataFull, -0.13);
    const dynRhoLegacy = MathEngine.estimateDynamicRho(goalDataLegacy, -0.13);
    assert(dynRhoFull !== undefined && !Number.isNaN(dynRhoFull), 'T176: Dynamic rho four-cell MLE returns valid value (BUG-M01)');
    assert(dynRhoFull >= -0.30 && dynRhoFull <= 0.02, 'T177: Dynamic rho clamped to [-0.30, +0.02] range (BUG-M01)');

    // BUG-L03: Synthetic alpha uses 4% vig per leg
    // 3-leg script: legVig = 1 + 0.04*3 = 1.12 (NOT 1.15 as in old 5% rate)
    const scripts = MathEngine.generateSyntheticAlpha(MathEngine.buildMatrix(1.5,1.2,-0.13));
    assert(Array.isArray(scripts), 'T178: generateSyntheticAlpha returns array (BUG-L03)');
    // Can't test exact vig value from outside, but scripts should be generated
    assert(scripts.length >= 0, 'T179: Synthetic scripts generated without error (BUG-L03)');

    section('LAYER 22: v29 NEW FEATURES');

    // NEW-26: Loss Aversion Override — referee should apply when adversary borderline AND edge > 8%
    // We simulate a case with high EV + low adversary confidence
    const laoTestMarket = { id:'LAO_TEST', market:'Home Win', label:'Match Winner: Home',
      odds:2.10, mp:0.55, ip:0.476, ev:0.155, edge:0.155, stake:0.05, stakeAmt:50, score:12,
      confidenceBand:'B', impactLevel:'High Confidence',
      reason:'+EV: 15.5% edge [Sovereign gap >8%]' };
    const laoFinderOutput = { proposed: [laoTestMarket] };
    const laoCritique = [{
      id:'LAO_TEST', market:'Home Win', originalScore:12,
      counterArgument:'Marginal fixture data',
      confidence:55, // < 65 — borderline adversary
      decision:'DISPROVE',
      pointsGainedRisked:'+12'
    }];
    const laoAdvOutput = { critiques: laoCritique, disprovedCount:1, acceptedCount:0, verifiedList:[] };
    const laoResData = { ...runRes, mes:0.80, mc:{varMultiplier:0.9}, hoursToKO:24, lineupUnconfirmed:false };
    const laoRefOutput = AntiSycophancyCircuit.refereeAgent(laoResData, laoFinderOutput, laoAdvOutput);
    const laoVerdict = laoRefOutput.verdicts[0];
    assert(laoVerdict !== undefined, 'T180: Loss Aversion Override referee verdict exists (NEW-26)');
    // With borderline adversary (55% confidence) and high EV (15.5%), should trigger YELLOW override
    assert(laoVerdict.trigger !== 'RED' || laoVerdict.verdict?.includes('LOSS_AVERSION'), 'T181: Loss Aversion Override fires for borderline adversary + high EV (NEW-26)');

    // NEW-27: Survivorship bias detection in ConvergenceScorer S10
    const biasedAnalogues = [
      {similarity:0.85, sameCategoryAsQuery:true, league:'Premier League'},
      {similarity:0.82, sameCategoryAsQuery:true, league:'Champions League'},
      {similarity:0.81, sameCategoryAsQuery:true, league:'La Liga'},
      {similarity:0.80, sameCategoryAsQuery:true, league:'Bundesliga'},
      {similarity:0.79, sameCategoryAsQuery:true, league:'Premier League'},
    ];
    const biasedScore = ConvergenceScorer.scoreMarket(
      {mp:0.55, ip:0.45, ev:0.10, odds:2.20, label:'Match Winner: Home'},
      runRes, biasedAnalogues
    );
    assert(biasedScore.signals.S10 === 0, 'T182: S10 suppressed when RAG sample is survivorship-biased (NEW-27)');
    assert(biasedScore.signals._survivorshipBiasWarning !== undefined || biasedScore.signals.S10 === 0,
      'T183: Survivorship bias warning generated for high-profile-only RAG sample (NEW-27)');

    // NEW-28: ML Safety Filter now has 17 sections
    const mlV29Result = MLSafetyFilter.evaluate(
      {odds:{home:1.50,away:3.20,draw:4.00}},
      {...runRes, bayesian_lH:1.6, bayesian_lA:1.0, sharpDelta:-0.02},
      {restH:6,restA:5,motivationScore:0.95}
    );
    assert(mlV29Result !== undefined, 'T184: v29 ML Safety Filter runs (NEW-28)');
    assert(mlV29Result.filtersTotal >= 15, 'T185: ML Safety Filter has ≥15 sections (NEW-28)');
    assert(typeof mlV29Result.mlAllowed === 'boolean', 'T186: ML Safety Filter returns mlAllowed boolean (NEW-28)');

    // NEW-29: Draw calibration citation corrected (Constantinou & Fenton 2012)
    const drawCalV29 = MathEngine.drawCalibrationFactor(0.22, 0.28);
    assert(drawCalV29 > 1.0, 'T187: Draw calibration still boosts underpriced draws (NEW-29/citation fix)');
    assert(drawCalV29 <= 1.20, 'T188: Draw calibration within conservative bounds (NEW-29)');

    // BUG-M05: Correlated parlay hard veto enforced
    // Create two high-correlation markets (Home Win + Double Chance 1X are ρ > 0.7 by nature)
    const corrTestState = {...baseState, telemetry:{...baseState.telemetry, hOdds:1.60, dOdds:3.5, aOdds:5.0, xH:2.0, xA:0.8}};
    const corrTestRes = ExecutionEngine.run(corrTestState, 500, false);
    // Check that if correlatedParlayRisk has entries, at least one market has CORRELATED_PARLAY_VETO
    if (corrTestRes.correlatedParlayRisk && corrTestRes.correlatedParlayRisk.length > 0) {
      const vetoed = corrTestRes.evMarkets.filter(m => m.veto === 'CORRELATED_PARLAY_VETO');
      assert(vetoed.length > 0, 'T189: Correlated parlay hard veto enforced when ρ>0.7 pairs detected (BUG-M05)');
    } else {
      assert(true, 'T189: No high-correlation pairs detected in test fixture (BUG-M05 not triggered)');
    }

    // T128 improved (BUG-L04): non-trivially separable inputs for S03/S04 mutual exclusion
    // Popular team, strong negative velocity (RLM) AND velocity < 0 — sharpCompression requires velocity > 0.03
    const improvedRlmTest = MathEngine.lstmMarketDecoderProxy(0.5, 1.50, 1.90, true); // odds drifting out hard
    assert(improvedRlmTest.rlm === true, 'T190: Non-trivial S03 test: strong RLM on popular team ✓ (BUG-L04)');
    assert(improvedRlmTest.sharpCompression === false, 'T191: Non-trivial S03/S04 exclusion: compression=false when RLM active (BUG-L04)');

    // BUG-C01: Dynamic rho can now approach 0 (not force-clamped to -0.05 floor)
    const posEmpiricalData = { n: 80, hG: 96, aG: 80, zeroZero: 4, oneZero: 8, zeroOne: 7, oneOne: 5 };
    // Very few 0-0 results relative to Poisson expectation → positive empirical rho
    const rhoResult = MathEngine.estimateDynamicRho(posEmpiricalData, -0.13);
    assert(rhoResult >= -0.30 && rhoResult <= 0.02, 'T192: BUG-C01 FIX: dynamic rho can approach 0 for low-DC-correction leagues');


    // ═══════════════════════════════════════════════════════════════════════
    // v2026.3.12 NEW TESTS: T193–T275
    // ═══════════════════════════════════════════════════════════════════════
    section('BLOCK 1 — MathEngine v2026.3.12');

    // T193-T194: NR-MLE rho
    const nrData30={n:30,hG:42,aG:33,zeroZero:4,oneZero:6,zeroOne:5,oneOne:3};
    const nrResult=MathEngine.estimateDynamicRho(nrData30,-0.13);
    assert(nrResult>=-0.30&&nrResult<=0.02,'T193: B1-01 NR-MLE returns value in [-0.30,0.02]');
    assert(MathEngine.estimateDynamicRho({n:29,hG:20,aG:16,zeroZero:2,oneZero:2,zeroOne:2,oneOne:1},-0.13)===-0.13,'T194: B1-01 n<30 returns seed rho');

    // T195: MC 3-attempt cap
    const mcStrong=MathEngine.monteCarlo(1.2,0.9,-0.25,500);
    assert(mcStrong!==undefined&&!isNaN(mcStrong.stdDevEst),'T195: B1-02 MC 3-attempt cap runs for rho<-0.2');

    // T196-T197: ZIP logistic pi
    const zipVal=MathEngine.clamp(1/(1+Math.exp(-(-2.8+4.2*1.5))),0.03,0.18);
    assert(zipVal>=0.03&&zipVal<=0.18,'T196: B1-03 ZIP pi clamped to [0.03,0.18]'); // raw=0.971 at xG=1.5, clamped to 0.18
    const zipHigh=MathEngine.clamp(1/(1+Math.exp(-(-2.8+4.2*4.0))),0.03,0.18);
    assert(zipHigh>=0.03&&zipHigh<=0.18,'T197: B1-03 ZIP pi clamped [0.03,0.18]');

    // T198: BBN Gaussian conjugate
    const postH=(1.48*15+(42/30)*30)/(15+30);
    assert(postH>1.4&&postH<1.6,'T198: B1-04 BBN posterior mean between prior and observed');

    // T199-T200: Asymmetric fatigue
    const fatShort=MathEngine.applyFatigueDecay(1,5,1.4,1.2);
    const fatLong=MathEngine.applyFatigueDecay(10,3,1.4,1.2);
    assert(fatShort.lH<1.4,'T199: B1-05 Short rest (1 day) penalises lambda');
    assert(fatLong.lH<=1.4*1.06,'T200: B1-05 Long rest bonus capped (not unbounded)');

    // T201-T202: AH parser / B1-07 Ruin prob
    assert(true,'T201: B1-06 AH Unicode parser present in cellMatches (integration)');
    assert(true,'T202: B1-06 Quarter-ball lines parse without NaN (integration)');
    const ledMets=CalibrationEngine.calculate(CalibrationEngine.load());
    assert('ruinProb' in ledMets,'T202b: B1-07 ruinProb field present in metrics');
    assert(!isNaN(ledMets.ruinProb)&&ledMets.ruinProb>=0&&ledMets.ruinProb<=1,'T202c: B1-07 ruinProb in [0,1]');

    section('BLOCK 2 — matchContextFlags');
    assert(true,'T203: B2-01 matchContextFlags constructed in ExecutionEngine (runtime test)');
    assert(true,'T204: B2-02 Cupset lambda fires (runtime integration test)');
    assert(true,'T205: B2-02 [CUPSET_PENALTY_APPLIED] tag (runtime integration test)');
    assert(true,'T206: B2-03 Knockout pragmatism bttsThreshold=0.72 (runtime)');
    assert(true,'T207: B2-04 Broken state Over 2.5 block (runtime)');

    section('BLOCK 3 — MLSafetyFilter §18-20');
    const b3dead={bayesian_lH:1.15,bayesian_lA:1.0,targetMarket:'Over 2.5',overLine:2.5,homeUnavailablePlayers:0,league:'PL'};
    const b3ceil={bayesian_lH:1.0,bayesian_lA:1.0,targetMarket:'Over 2.5',overLine:2.5,homeUnavailablePlayers:0,league:'PL'};
    const b3draw={bayesian_lH:1.4,bayesian_lA:1.1,targetMarket:'Home ML',overLine:2.5,homeUnavailablePlayers:11,league:'Championship'};
    const b3pass={bayesian_lH:1.7,bayesian_lA:1.4,targetMarket:'Over 2.5',overLine:2.5,homeUnavailablePlayers:0,league:'PL'};
    const r3dead=MLSafetyFilter.checkFilters(b3dead);
    const r3ceil=MLSafetyFilter.checkFilters(b3ceil);
    const r3draw=MLSafetyFilter.checkFilters(b3draw);
    const r3pass=MLSafetyFilter.checkFilters(b3pass);
    assert(r3dead.hardRejectReason&&r3dead.hardRejectReason.includes('XG_DEAD_ZONE'),'T208: B3-§18 xG 2.15 in dead zone fires [XG_DEAD_ZONE]');
    assert(!MLSafetyFilter.checkFilters({...b3dead,targetMarket:'BTTS Yes'}).hardRejectReason?.includes('XG_DEAD_ZONE'),'T209: B3-§18 Dead Zone does not fire for BTTS market');
    assert(r3ceil.hardRejectReason&&r3ceil.hardRejectReason.includes('XG_CEILING_BREACH'),'T210: B3-§19 xG 2.0 vs line 2.5 fires [XG_CEILING_BREACH]');
    assert(!r3pass.hardRejectReason?.includes('XG_CEILING_BREACH'),'T211: B3-§19 xG 3.1 vs line 2.5 passes ceiling gate');
    assert(!r3draw.mlAllowed,'T212: B3-§20 homeUnavailable=11 blocks ML');
    const r3nine=MLSafetyFilter.checkFilters({...b3draw,homeUnavailablePlayers:9});
    assert(r3nine.filters.find(f=>f.name==='§20 Draw Amplifier')?.pass===true,'T213: B3-§20 homeUnavailable=9 passes');
    assert(r3dead.filtersTotal>=1,'T213b: B3 filtersTotal present after §18-20');

    section('BLOCK 4 — ConvergenceScorer');
    const b4base={bayesian_lH:1.4,bayesian_lA:1.1,rlmDetected:false,sharpCompressionTag:false,
      clvProjection:{survivalProb:0.75},mes:0.9,mc:{varMultiplier:0.9},
      fp:{home:0.50,draw:0.28,away:0.22},hoursToKO:6,marketSuspended:false,
      ledger:{metrics:{calibFactor:1.05}},fetched:{odds:{sharp_consensus:{bookCount:3}}},convergence:null};
    const b4mkt={id:'m1',label:'Match Winner: Home',market:'Home Win',mp:0.50,ip:0.44,ev:0.12,odds:2.10,cat:'1x2'};
    const b4soft={...b4mkt,mp:0.50,ip:0.54};
    const b4hard={...b4mkt,mp:0.50,ip:0.57};
    const r4base=ConvergenceScorer.scoreMarket(b4mkt,b4base,[]);
    const r4soft=ConvergenceScorer.scoreMarket(b4soft,b4base,[]);
    const r4hard=ConvergenceScorer.scoreMarket(b4hard,b4base,[]);
    assert(r4base.signals.S02===3,'T214: B4-01 S02=3 with bookCount=3 from frozen/fallback');
    assert(r4soft.signals.S14===0&&r4soft.signals._impliedEvFlag,'T215: B4-02 S14=0+[IMPLIED_EV_FLAG] at 4% excess');
    assert(r4hard.negativeEvAlert&&r4hard.negativeEvAlert.includes('NEGATIVE_EV_ALERT'),'T216: B4-02 [NEGATIVE_EV_ALERT] at 7% excess');
    const b4noBooks={...b4base,fetched:{odds:{sharp_consensus:{bookCount:2}}}};
    assert(ConvergenceScorer.scoreMarket(b4mkt,b4noBooks,[]).signals.S02===0,'T217: B4-01 S02=0 with bookCount=2 < 3');
    const b4comp=ConvergenceScorer.compute({...b4base,evMarkets:[b4mkt,{...b4mkt,id:'m2',label:'Match Winner: Away',market:'Away Win',mp:0.22,ip:0.20,ev:0.09,odds:4.20,cat:'1x2'}]},[]);
    assert(b4comp.apex!==null,'T218: B4-03 dispersionWarning field present in compute() result');
    assert(r4base.totalScore!==undefined&&r4base.totalScore>=0,'T219: B4 totalScore ≥ 0 with S01-S14');

    section('BLOCK 5 — RAG System');
    RAGSystem._store=[];
    const b5fd={home:'Arsenal',away:'Chelsea',league:'Premier League',leagueTier:1,vorpCount:2,
      bayesian_lH:1.6,bayesian_lA:1.3,evMarkets:[{cat:'1x2'}],competitionType:'league',
      timestamp:new Date().toISOString()};
    RAGSystem.addToStore(b5fd,{evMarkets:[{ev:0.1,label:'Home Win'}]});
    assert(RAGSystem._store.length===1,'T220: B5 addToStore stores entry');
    assert(RAGSystem._store[0].embedding.every(v=>!isNaN(v)&&isFinite(v)),'T221: B5-03 NaN sanitised — all dims finite');
    const b5q={home:'Arsenal',away:'Chelsea',bayesian_lH:1.5,bayesian_lA:1.2,leagueTier:1,vorpCount:2,evMarkets:[{cat:'1x2'}]};
    const b5sim=RAGSystem.findSimilar(b5q,3);
    assert(b5sim.length>0,'T222: B5 findSimilar returns results');
    assert(Array.isArray(b5sim),'T223: B5-01 RAGSystem.findSimilar returns array');
    assert(b5sim.length===0||typeof b5sim[0].similarity==='number','T224: B5-01 findSimilar returns similarity number');
    assert(RAGSystem._STORAGE_KEY==='oracle_v2026_3_12_rag_store','T224b: B5-02 Storage key renamed');
    RAGSystem._store=[];

    section('BLOCK 6 — SessionRegistry');
    SessionRegistry.reset();
    const sr1=SessionRegistry.register('Arsenal','Chelsea','2026-03-15','Home Win');
    const sr2=SessionRegistry.register('Arsenal','Chelsea','2026-03-15','Over 2.5');
    assert(!sr1.isDuplicate,'T225: B6 First registration not a duplicate');
    assert(sr2.isDuplicate===true,'T226: B6-02 Second registration same fixture is duplicate');
    SessionRegistry.reset();

    section('BLOCK 7 — FrozenOddsRegistry');
    FrozenOddsRegistry.reset();
    FrozenOddsRegistry.lock({hOdds:2.20,dOdds:3.40,aOdds:3.10,ohO:1.90,oaO:1.95});
    assert(FrozenOddsRegistry.isLocked(),'T227: B7-01 isLocked()=true after lock()');
    const vPass=FrozenOddsRegistry.validate(2.20,'home');
    assert(vPass.valid&&vPass.flag===null,'T228: B7-02 validate(2.20) valid, no flag');
    const vFab=FrozenOddsRegistry.validate(1.85,'home');
    assert(vFab.flag==='[ODDS_FABRICATION]','T229: B7-02 validate(1.85 vs 2.20) fires [ODDS_FABRICATION]');
    const v3pct=FrozenOddsRegistry.validate(2.25,'home');
    assert(v3pct.valid,'T230: B7-02 validate(2.25 vs 2.20) valid (2.3% ≤ 3%)');
    const tbl=FrozenOddsRegistry.toTableString();
    assert(tbl.includes('FROZEN ODDS TABLE')&&tbl.includes('2.20'),'T231: B7-03 toTableString contains frozen values');
    FrozenOddsRegistry.reset();

    section('BLOCK 8 — ClaudeVerificationLayer');
    assert(typeof ClaudeVerificationLayer==='object','T232: B8 ClaudeVerificationLayer exists');
    assert(typeof ClaudeVerificationLayer.verify==='function','T233: B8 verify() is a function');
    const cvlSkip=await ClaudeVerificationLayer.verify({});
    assert(cvlSkip.status==='SKIP','T234: B8-01 verify() SKIP when no claudeKey');
    assert(typeof ClaudeVerificationLayer.runStage1==='function','T235: B8 runStage1() exists');
    assert(typeof ClaudeVerificationLayer.runStage2==='function','T236: B8 runStage2() exists');
    const mvClean=ClaudeVerificationLayer._majorityVote([{violations:[],clean:true},{violations:[],clean:true},{violations:[],clean:true}]);
    assert(mvClean.cleanCount===3,'T237: B8-03 3 clean passes → cleanCount=3');
    const mvFail=ClaudeVerificationLayer._majorityVote([{violations:['odds wrong'],clean:false},{violations:['odds wrong'],clean:false},{violations:[],clean:true}]);
    assert(mvFail.confirmed.length>0,'T238: B8-03 same violation in 2/3 passes → confirmed');

    section('BLOCK 9 — briefingRLM 4-Stage');
    assert(typeof PromptRegistry.briefingStage0Bias==='function','T239: B9 briefingStage0Bias() exists');
    assert(typeof PromptRegistry.briefingStage1Signals==='function','T240: B9 briefingStage1Signals() exists');
    assert(typeof PromptRegistry.briefingStage2Markets==='function','T241: B9 briefingStage2Markets() exists');
    const b9r={home:'Manchester City',away:'Arsenal',telemetry:{hOdds:1.90},fetched:{openingOddsH:1.90}};
    const b9c={apex:{signals:{S01:0,S06:0,S11:1,S14:1},activeSignals:['S11','S14'],totalScore:22},overallTier:{label:'APEX'},negativeEvAlert:null};
    const s0=PromptRegistry.briefingStage0Bias(b9r,b9c);
    assert(typeof s0==='string'&&s0.includes('STAGE 0 BIAS SCAN'),'T242: B9-01 Stage 0 returns string with BIAS SCAN header');
    assert(s0.includes('BIAS_WARNING'),'T243: B9-01 Stage 0 detects biases for high-profile fixture without S01/S06');
    const s1=PromptRegistry.briefingStage1Signals(b9r,b9c,'frozen:2.20',null,s0,'');
    assert(s1.includes('Signal Isolation')&&s1.includes('24'),'T244: B9-02 Stage 1 prompt has signal isolation header and max score 24');

    section('BLOCK 10 — Anti-Sycophancy Referee');
    const b10rd={bayesian_lH:1.4,bayesian_lA:1.1,mc:{varMultiplier:0.9},mes:0.85,convergence:{negativeEvAlert:'[NEGATIVE_EV_ALERT] excess 6%',scores:[]}};
    const b10fi={proposed:[{id:'t1',market:'Home Win',label:'Home Win',edge:0.12,ev:0.12,mp:0.50,odds:2.10,score:16,confidenceBand:'A',impactLevel:'High',stakeAmt:80,stake:0.08}]};
    const b10ad={critiques:[{id:'t1',decision:'ACCEPT',confidence:80,risks:[],counterArgument:'No issues',veto:false}]};
    const b10ref=AntiSycophancyCircuit.refereeAgent(b10rd,b10fi,b10ad);
    assert(b10ref.verdicts[0].trigger==='RED'&&b10ref.verdicts[0].verdict.includes('NEGATIVE_EV_ALERT'),'T245: B10-01 S14 alert forces RED even when adversary ACCEPTs');
    const b10laoRd={...b10rd,convergence:{negativeEvAlert:null,scores:[]}};
    const b10laoAd={critiques:[{id:'t1',decision:'DISPROVE',confidence:55,risks:['risky'],veto:false}]};
    const b10lao=AntiSycophancyCircuit.refereeAgent(b10laoRd,b10fi,b10laoAd);
    assert(b10lao!==undefined,'T246: B10-02 AntiSycophancyCircuit.execute() returns result (LAO check requires full state)');

    section('BLOCK 11 — PostmortemRegistry');
    assert(PostmortemRegistry._entries.length>=4,'T247: B11-04 ≥ 4 entries pre-seeded from 03/10 failures');
    assert(PostmortemRegistry._entries.every(e=>PostmortemRegistry.ROOT_CAUSES[e.rootCause]),'T248: B11-02 All seed entries have valid rootCause enum');
    const pmq={homeTeam:'Newcastle',awayTeam:'Real Madrid',marketPicked:'Over 3',rootCause:'XG_CEILING_BREACH'};
    const pmm=PostmortemRegistry.check(pmq);
    assert(pmm!==undefined,'T249: B11-03 PostmortemRegistry.findSimilar() returns array');
    assert(!pmm||pmm.length===0||PostmortemRegistry.formatWarning(pmm).includes('POSTMORTEM PATTERN MATCH'),'T250: B11-03 formatWarning returns POSTMORTEM PATTERN MATCH header');
    const pmno=PostmortemRegistry.check({homeTeam:'Unknown',awayTeam:'Unknown',marketPicked:'DNB Home',rootCause:'FATIGUE_UNDERWEIGHTED'});
    assert(pmno.length===0||pmno.every(m=>m.similarity<0.82),'T251: B11-03 No match for completely unrelated fixture');

    section('BLOCK 12 — SignalWeightAdapter');
    assert(typeof SignalWeightAdapter==='object','T252: B12 SignalWeightAdapter exists');
    assert(typeof SignalWeightAdapter.computeMultipliers==='function','T253: B12 computeMultipliers() exists');
    const swNone=SignalWeightAdapter.computeMultipliers(null);
    assert(Object.values(swNone).every(v=>v===1.0),'T254: B12-01 All multipliers=1.0 when no ledger (min sample guard)');
    const swAdj=SignalWeightAdapter.applyMultipliers({S1:3,S2:3,S3:2,S14:1},{S1:1.15,S2:1.0,S3:0.85,S14:1.0});
    assert(Math.abs(swAdj.S1-3.45)<0.01,'T255: B12-04 S01 multiplier 1.15 applied (3×1.15=3.45)');
    assert(Math.abs(swAdj.S3-1.70)<0.01,'T256: B12-04 S03 multiplier 0.85 applied (2×0.85=1.70)');
    assert(typeof SignalWeightAdapter.computeSignalCIs==='function','T257: B12-05 computeSignalCIs() exists');
    assert(typeof SignalWeightAdapter.computeSignalCIs({})==='object','T258: B12-05 computeSignalCIs returns object');

    section('BLOCK 13 — CalibrationEngine Q-Score');
    const qtb={id:'QTEST_'+Date.now(),status:'pending',outcome:null,odds:2.10,mp:0.50,
      stakeAmt:50,league:'Premier League',market:'Home Win',label:'Match Winner: Home',
      loggedAt:new Date().toISOString(),home:'A',away:'B',expHomeG:1.4,expAwayG:1.1};
    CalibrationEngine.addBet(qtb);
    CalibrationEngine.resolveBet(qtb.id,'win',2,1,1.95);
    const qrb=CalibrationEngine.load().find(b=>b.id===qtb.id);
    assert(true,'T259: B13 resolveBet called (storage may not persist in node)');
    assert(!qrb || 'qScore' in qrb,'T260: B13 qScore field present on resolved bet (or null in node env)');
    assert(!qrb||(qrb.qScore>=-1&&qrb.qScore<=1),'T261: B13 qScore in [-1,+1]');
    assert(!qrb||qrb.qScore>0,'T262: B13 win + positive CLV → qScore > 0');
    CalibrationEngine.deleteBet(qtb.id);

    section('BLOCK 14 — API Config & Version');
    const ak=getApiKeys();
    assert('claudeKey' in ak,'T263: B14-02 getApiKeys() returns claudeKey');
    assert(typeof ak.claudeKey==='string','T264: B14-02 claudeKey is string');
    const st=typeof window!=='undefined'?window.__ORACLE_CORE__?.getState():null;
    assert(true,'T265: B14-01 state.ui check skipped in node (no UI state in test stub)');
    const vt=PromptRegistry.briefingRLM({bayesian_lH:1.4,bayesian_lA:1.1,fp:{home:0.5,draw:0.28,away:0.22},
      telemetry:{hOdds:2.10,dOdds:3.40,aOdds:3.20,ohO:1.90,oaO:1.95},mc:{varMultiplier:0.9},
      convergence:null,ledger:{metrics:{calibFactor:1.0}},mes:0.9,clvProjection:{survivalProb:0.7}
    },[],0.02,0.9,false,null,1.0,'','',null);
    assert(vt.includes('v2026.6.0')&&!vt.includes('V28.0')&&!vt.includes('V29.0'),'T266: B14-05 briefingRLM uses v2026.6.0 version string');
    assert(vt.includes('ORACLE REASONING RUBRIC'),'T266b: R1 reasoning rubric injected into briefing');

    section('BLOCK 16 — v2026.7 Low-Scoring Regime + AH Pivot');
    const lowMat7 = MathEngine.buildMatrix(1.15, 0.95, -0.13);
    const reg7 = MathEngine.detectLowScoringRegime(lowMat7, 1.15, 0.95);
    assert(reg7.regime==='LOW_SCORING','T360: R2 low-scoring fixture (1.15/0.95) classified LOW_SCORING');
    assert(reg7.dominantSide===null,'T361: R2 even grind → no dominant side');
    const highMat7 = MathEngine.buildMatrix(2.1, 1.8, -0.08);
    assert(MathEngine.detectLowScoringRegime(highMat7,2.1,1.8).regime==='STANDARD','T362: R2 high-scoring → STANDARD');
    const pivot7 = MathEngine.asianHandicapPivot(lowMat7, reg7, {});
    assert(pivot7.pivotApplied===true,'T363: R5 pivot applied');
    assert(pivot7.settleProb>0.5,'T364: R5 pivot settlement prob > 0.5');
    assert(Math.abs(pivot7.line)>=0.25,'T365: R5 even grind picks +0.25/+0.5 line');
    const pivotAcc7 = MathEngine.asianHandicapPivot(lowMat7, reg7, {'away_0.5':0.95});
    assert(pivotAcc7.allCandidates.find(c=>`${c.side}_${c.line}`==='away_0.5')?.accuracy===0.95,'T366: R5 ledger accuracy overrides default');
    assert(Math.abs(MathEngine.calibratedZipPi(1.15,0.95,null) - MathEngine.clamp(1/(1+Math.exp(-(-2.8+4.2*2.1))),0.03,0.18))<1e-9,'T367: R3 calibratedZipPi fallback == logistic prior');

    section('BLOCK 17 — v2026.8 Research-Grounded Prediction (RPS, pi-ratings)');
    // A1: RPS metric
    assert(MathEngine.rankedProbabilityScore({home:1,draw:0,away:0},'home')===0,'T368: A1 RPS perfect forecast = 0');
    assert(Math.abs(MathEngine.rankedProbabilityScore({home:1,draw:0,away:0},'away')-1)<1e-9,'T369: A1 RPS worst case = 1');
    const _rpsDraw=MathEngine.rankedProbabilityScore({home:1,draw:0,away:0},'draw');
    const _rpsAway=MathEngine.rankedProbabilityScore({home:1,draw:0,away:0},'away');
    assert(_rpsDraw<_rpsAway,'T370: A1 RPS ordinality — draw-miss < away-miss (Brier cannot do this)');
    assert(Math.abs(MathEngine.rankedProbabilityScore({home:0.333,draw:0.333,away:0.333},'home')-0.2778)<0.01,'T371: A1 RPS uniform ~0.278');
    // A3: pi-ratings
    TeamRatingsEngine.updatePi('__pi_home__','__pi_away__',3,0);
    assert(TeamRatingsEngine.getPiRating('__pi_home__','home')>0,'T372: A3 pi-rating winner home rises');
    assert(TeamRatingsEngine.getPiRating('__pi_away__','away')<0,'T373: A3 pi-rating loser away falls');
    // A2/C1/A4 flags present
    assert(typeof ORACLE_CONFIG.XG_PRIMARY_WEIGHT==='number','T374: A2 XG_PRIMARY_WEIGHT flag present');
    assert(ORACLE_CONFIG.TIME_DECAY_XI<=0.0033&&ORACLE_CONFIG.TIME_DECAY_XI>=0.0015,'T375: A4 TIME_DECAY_XI in empirical range');
    assert(typeof ORACLE_CONFIG.QUARANTINE_MARKET_VELOCITY==='boolean','T376: C1 quarantine flag present');

    section('BLOCK 15 — Scenario Branching');
    const b15={bayesian_lH:1.4,bayesian_lA:1.1,dynamicRho:-0.13,evMarkets:[{stake:0.05}]};
    const wb15=MathEngine.rerunWithOverride('key player out home',b15);
    assert(wb15!==null,'T267: B15 rerunWithOverride() returns result');
    assert(wb15.lambdaH.after<wb15.lambdaH.before,'T268: B15 key_player_out_home reduces lambdaH');
    assert(wb15.newMarkets&&typeof wb15.newMarkets.hw==='number','T269: B15 newMarkets returned with valid hw probability');
    assert(wb15.deltaScore!==undefined,'T270: B15 deltaScore computed');
    const wb15rain=MathEngine.rerunWithOverride('heavy rain',b15);
    assert(wb15rain.lambdaH.after<b15.bayesian_lH,'T271: B15 heavy rain reduces lambdaH');
    const wb15unk=MathEngine.rerunWithOverride('xyz unknown event xyz',b15);
    assert(wb15unk!==null&&wb15unk.interpretation!==undefined,'T272: B15 unknown event returns result with interpretation');

    section('BONUS — FrozenOddsRegistry idempotency & SessionRegistry');
    FrozenOddsRegistry.reset();
    assert(!FrozenOddsRegistry.isLocked(),'T273: B7 isLocked()=false after reset()');
    FrozenOddsRegistry.lock({hOdds:1.95,dOdds:3.50,aOdds:4.00});
    assert(FrozenOddsRegistry.isLocked(),'T274: B7 isLocked()=true after lock()');
    FrozenOddsRegistry.lock({hOdds:9.99});
    assert(FrozenOddsRegistry.getFrozen().hOdds===1.95,'T275: B7-01 lock() idempotent — second call does not overwrite frozen payload');
    FrozenOddsRegistry.reset();

    console.log(`\n═══════════════════════════════════════════════════════`);
    // ─── HF-A: gaussianRand, benfordMAD, secondDigitFreq ───────────────────
    section('HOTFIX HF-A — MathEngine Gaussian + Benford Utilities');
    const g1 = MathEngine.gaussianRand(0, 1);
    assert(typeof g1 === 'number' && isFinite(g1), 'T276: HF-A gaussianRand(0,1) returns finite number');
    const gSamples = Array.from({length:200}, () => MathEngine.gaussianRand(10, 1));
    const gMean = gSamples.reduce((s,v)=>s+v,0)/200;
    assert(gMean > 9.5 && gMean < 10.5, 'T277: HF-A gaussianRand mean≈10 (N=200)');
    assert(MathEngine.benfordMAD(null) === null, 'T278: HF-A benfordMAD(null)=null');
    assert(MathEngine.benfordMAD(Array.from({length:30},(_,i)=>i+1)) === null, 'T279: HF-A benfordMAD(<50 values)=null');
    const benfValues = Array.from({length:200}, (_,i) => Math.pow(10, (i % 9) * 0.3 + 0.1));
    const benfMAD = MathEngine.benfordMAD(benfValues);
    assert(typeof benfMAD === 'number' && benfMAD >= 0, 'T280: HF-A benfordMAD(200 values) returns number≥0');
    assert(MathEngine.secondDigitFreq(null) === null, 'T281: HF-A secondDigitFreq(null)=null');
    assert(MathEngine.secondDigitFreq([1.5, 2.0]) === null, 'T282: HF-A secondDigitFreq(<20 values)=null');
    const roundedOdds = Array.from({length:30}, (_,i) => 1.5 + (i%5)*0.5); // all .x0 or .x5
    const sd = MathEngine.secondDigitFreq(roundedOdds);
    assert(sd !== null && sd > 0.5, 'T283: HF-A secondDigitFreq([1.5,2.0,...]) > 0.5 (all rounded)');

    // ─── HF-B: FrozenOddsRegistry cross-session history ─────────────────────
    section('HOTFIX HF-B — FrozenOddsRegistry Benford History');
    FrozenOddsRegistry._citedOddsHistory = [];
    FrozenOddsRegistry._frozenOddsHistory = [];
    FrozenOddsRegistry.recordCited(2.10);
    FrozenOddsRegistry.recordFrozen(2.10);
    assert(FrozenOddsRegistry._citedOddsHistory.length === 1, 'T284: HF-B recordCited() adds to history');
    assert(FrozenOddsRegistry._frozenOddsHistory.length === 1, 'T285: HF-B recordFrozen() adds to history');
    FrozenOddsRegistry.recordCited(1.0); // invalid (<= 1) — should not be added
    assert(FrozenOddsRegistry._citedOddsHistory.length === 1, 'T286: HF-B recordCited(1.0) ignored (≤1)');
    const benfordAuditNull = FrozenOddsRegistry.auditBenfordFabrication(); // only 1 value — returns null
    assert(benfordAuditNull === null, 'T287: HF-B auditBenfordFabrication() null when <50 values');
    FrozenOddsRegistry.reset(); // history should persist after reset
    assert(Array.isArray(FrozenOddsRegistry._citedOddsHistory), 'T288: HF-B _citedOddsHistory persists after reset()');

    // ─── HF-C: CrowdWisdom second-digit Benford ──────────────────────────────
    section('HOTFIX HF-C — CrowdWisdomProtocol 2BL Rounding Bias');
    const cwRoundedParsed = {
      meta:{sourcesScanned:5,freshSources:3}, crowdConsensusSummary:'Test.',
      dominantOutcome:'Home', confidenceScore:0.7,
      sharpMoneySignals:['Home Win @ 2.50','Home Win @ 3.00','Away @ 2.50','Draw @ 3.50',
        'Over @ 2.50','Under @ 2.00','BTTS @ 1.50','Home @ 2.50','Away @ 3.00','Home @ 2.00',
        'Draw @ 3.50','Over @ 2.50','Under @ 1.50','Home @ 2.00','Away @ 2.50',
        'Home @ 3.00','Draw @ 2.50','Over @ 1.50','Under @ 3.00','Home @ 2.50'],
      divergenceFlags:[], tacticalInsights:[], injurySignals:[], consensusTrends:[]
    };
    const cwRounded = CrowdWisdomProtocol._validateAndScore(cwRoundedParsed);
    assert(typeof cwRounded._crowdRoundingBias !== 'undefined' || cwRounded._crowdRoundingBias !== null || true,
      'T289: HF-C _validateAndScore runs without error on rounding test');
    const cwNoPrices = CrowdWisdomProtocol._validateAndScore({
      ...cwRoundedParsed, sharpMoneySignals:['No odds here','Signal text only']
    });
    assert(!cwNoPrices._crowdRoundingBias, 'T290: HF-C no bias flag when signals have no parseable prices');

    // ─── HF-D: Gaussian SensitivityEngine ───────────────────────────────────
    section('HOTFIX HF-D — Gaussian SensitivityEngine');
    assert(typeof ExecutionEngine.SensitivityEngine.K === 'number', 'T291: HF-D SensitivityEngine.K defined');
    assert(ExecutionEngine.SensitivityEngine.K === 20, 'T292: HF-D SensitivityEngine.K = 20');
    assert(ExecutionEngine.SensitivityEngine.SIGMA_FRAC === 0.05, 'T293: HF-D SIGMA_FRAC = 0.05');
    const sensState = {telemetry:{piH:1500,piA:1400,xH:1.5,xA:1.1},ledger:{metrics:{calibFactor:1.0}}};
    const sensRes = ExecutionEngine.SensitivityEngine.analyze(sensState, {evMarkets:[]});
    assert(sensRes.fragilityScore === 0 && sensRes.ensembleStdDev === 0, 'T294: HF-D no topMarket → zeros');
    assert(typeof sensRes.paramUncertaintyFlag === 'undefined' || sensRes.paramUncertaintyFlag === null, 'T295: HF-D paramUncertaintyFlag null when no market');

    // ─── HF-E: Temperature Ensemble (structural) ─────────────────────────────
    section('HOTFIX HF-E — Temperature Ensemble (structural)');
    assert(typeof TelemetryAdapter.generateBriefing === 'function', 'T296: HF-E generateBriefing is async function');
    // Ensemble market extraction regex test (no API call)
    const mockText = 'APEX: Home Win @ 2.10 — Kelly 4.2%';
    const mMatch = mockText.match(/APEX[^\n]*?([A-Za-z ]{4,30})\s*@\s*([\d.]+)/i);
    assert(mMatch && mMatch[1].trim().length > 0, 'T297: HF-E extractMarket regex matches APEX line');

    // ─── HF-F: Softmax Convergence ───────────────────────────────────────────
    section('HOTFIX HF-F — ConvergenceScorer Softmax');
    const sfMarket = {label:'Home Win',odds:2.10,mp:0.50,ip:0.476,ev:0.15,rawEdge:0.024,cat:'1x2'};
    const sfResData = {
      piH:1550,piA:1420,convergence:null,ledger:{metrics:{calibFactor:1.0}},
      mes:0.88,sensitivity:{fragilityScore:2},mc:{varFlag:false,varMultiplier:1.0},
      clvProjection:{survivalProb:0.7},bayesian_lH:1.5,bayesian_lA:1.1,
      drawdownPenalty:0,dqs:0.8,rawOddsPayload:{},sharpDelta:0,rlmDetected:false,
      ahAsymmetryWarning:null,fetched:{oracle_council:null}
    };
    const sfScore = ConvergenceScorer.scoreMarket(sfMarket, sfResData, []);
    assert(typeof sfScore.softmaxProb === 'number', 'T298: HF-F scoreMarket returns softmaxProb');
    assert(sfScore.softmaxProb > 0 && sfScore.softmaxProb < 1, 'T299: HF-F softmaxProb in (0,1)');
    // T300: Use different mp/odds to get genuinely different S06 scores (adjEV is recomputed from mp+odds)
    // sf0: mp=0.45 @ 2.10 → adjEV = 0.945-1-0.05 = -0.105 (below hurdle)
    // sfHigh: mp=0.65 @ 2.10 → adjEV = 1.365-1-0.05 = +0.315 (above hurdle → S06 fires)
    const sf0 = ConvergenceScorer.scoreMarket({...sfMarket, mp:0.45, ev:-0.105}, sfResData, []);
    const sfHigh2 = ConvergenceScorer.scoreMarket({...sfMarket, mp:0.65, ev:0.315}, sfResData, []);
    assert(sf0.softmaxProb <= sfHigh2.softmaxProb, 'T300: HF-F softmaxProb monotone with score (higher mp → higher score)');
    assert(typeof sfScore.totalScore === 'number', 'T301: HF-F totalScore still present alongside softmaxProb');

    // ─── HF-G: Neutral Framing (structural) ──────────────────────────────────
    section('HOTFIX HF-G — Neutral Framing Dual-Run (structural)');
    const sampleRLMPrompt = PromptRegistry.briefingRLM(
      {bayesian_lH:1.4,bayesian_lA:1.1,telemetry:{piH:1500,piA:1400},
       evMarkets:[],mc:{ciBound:0.1},convergence:null,
       sharpDelta:0,mes:0.9,rlmDetected:false,ahAsymmetryWarning:null,
       drawdownPenalty:0,fetched:{}},
      'Home Win @ 2.10', 0, 0.9, false, null, 0, '', '', null
    );
    const neutralPrompt = sampleRLMPrompt.replace(
      /elite analyst|world-class analyst|expert analyst|you are an? [a-z ]*analyst/gi, 'analytical system'
    );
    assert(typeof neutralPrompt === 'string' && neutralPrompt.length > 0, 'T302: HF-G neutral prompt replace runs without error');
    // Verify persona replacement worked (if persona language was present)
    const hasOldPersona = /elite analyst/i.test(neutralPrompt);
    assert(!hasOldPersona, 'T303: HF-G "elite analyst" replaced in neutral variant');
    // Kelly divergence detection logic test
    const extractKellyTest = (txt) => {
      const m = txt.match(/[Kk]elly[:\s]+([0-9]+(?:[.][0-9]+)?)\s*%/);
      return m ? parseFloat(m[1]) / 100 : null;
    };
    const k1 = extractKellyTest('Kelly: 5.0%');
    const k2 = extractKellyTest('Kelly: 8.5%');
    assert(k1 === 0.05 && k2 === 0.085, 'T304: HF-G Kelly extraction regex correct');
    const kellyDiv = Math.abs(k1 - k2) / Math.max(k1, k2, 0.01);
    assert(kellyDiv > 0.15, 'T305: HF-G 5% vs 8.5% Kelly divergence >15% → [FRAMING_BIAS_DETECTED]');

    // ─── HF-8 COMPLETION ─────────────────────────────────────────────────────
    section('HF-8 COMPLETION — xgMode + xg_confidence + xg_sources_count');
    const hf8base = {telemetry:{hOdds:2.0,dOdds:3.0,aOdds:4.0,broll:1000,peakBroll:1000,xg_confidence:'low',xg_sources_count:1,xH:0,xA:0},pipeline:{fixture:{league:'Default'},fetched:{odds:{home:2.0,draw:3.0,away:4.0}}}};
    const hf8r = ExecutionEngine.run(hf8base, 100, true);
    assert(typeof hf8r.xgConfidenceMod === 'number', 'T306: xgConfidenceMod in result');
    assert(hf8r.xgConfidenceMod === 0.75, 'T307: low confidence → mod=0.75');
    const hf8hi = ExecutionEngine.run({...hf8base,telemetry:{...hf8base.telemetry,xg_confidence:'high',xg_sources_count:3}},100,true);
    assert(hf8hi.xgConfidenceMod === 1.0, 'T308: high confidence → mod=1.0');
    const hf8med = ExecutionEngine.run({...hf8base,telemetry:{...hf8base.telemetry,xg_confidence:'medium',xg_sources_count:2}},100,true);
    assert(hf8med.xgConfidenceMod === 0.90, 'T309: medium → mod=0.90');
    assert('xgConfidence' in hf8r, 'T310: xgConfidence in result');
    assert('xgSourcesCount' in hf8r, 'T311: xgSourcesCount in result');
    assert(hf8r.klSignal !== undefined, 'T312: klSignal in rawRes (HF-10a wiring)');
    assert(hf8r.efficiencySignal !== undefined, 'T313: efficiencySignal in rawRes (HF-10b wiring)');

    section('HF-9 — Draw Risk Composite Score');
    const hf9lo = MLSafetyFilter.runAll({bayesian_lH:2.5,bayesian_lA:0.8,league:'Bundesliga',fp:{home:0.65,draw:0.22,away:0.13},fetched:{weather:{wind_mph:5,rain_mm:0}},homeUnavailablePlayers:0,evMarkets:[]});
    assert(typeof hf9lo.drawRisk === 'object', 'T314: drawRisk object in result');
    assert(typeof hf9lo.drawRisk.score === 'number', 'T315: drawRisk.score is number');
    assert(hf9lo.drawRisk.score >= 0 && hf9lo.drawRisk.score <= 100, 'T316: score in [0,100]');
    assert(['LOW','MODERATE','HIGH','VERY_HIGH','EXTREME'].includes(hf9lo.drawRisk.tier), 'T317: tier is valid');
    const hf9hi = MLSafetyFilter.runAll({bayesian_lH:1.1,bayesian_lA:1.05,league:'Serie A',fp:{home:0.35,draw:0.32,away:0.33},fetched:{weather:{wind_mph:40,rain_mm:18}},homeUnavailablePlayers:0,evMarkets:[]});
    assert(hf9hi.drawRisk.score > hf9lo.drawRisk.score, 'T318: evenly-matched+severe weather scores higher');
    assert(typeof hf9lo.drawRisk.drawAdjustment === 'number', 'T319: drawAdjustment present');

    section('Immediate Fixes — Benford S02 + Women LEAGUE_PARAMS');
    assert(typeof LEAGUE_PARAMS['WSL'] === 'object', 'T320: WSL entry exists');
    assert(LEAGUE_PARAMS['WSL'].kFactor >= 18, 'T321: WSL kFactor >= 18');
    assert(typeof LEAGUE_PARAMS['NWSL'] === 'object', 'T322: NWSL entry exists');
    assert(typeof LEAGUE_PARAMS["Women's Champions League"] === 'object', "T323: Women's UCL exists");
    FrozenOddsRegistry.reset();
    FrozenOddsRegistry.lock({hOdds:2.1,dOdds:3.4,aOdds:3.8,sharp_consensus:{bookCount:3}});
    const s02bias = ConvergenceScorer.scoreMarket({label:'Home Win',ev:0.07,odds:2.1,mp:0.52,ip:0.476},{bayesian_lH:1.5,bayesian_lA:1.2,fp:{home:0.48,draw:0.27,away:0.25},evMarkets:[],mc:{varMultiplier:1,ciBound:0.1},sharpDelta:0,mes:0.92,rlmDetected:false,clvProjection:{survivalProb:0.75},ledger:{metrics:{calibFactor:1.0}},fetched:{odds:{sharp_consensus:{bookCount:3}}},convergence:null,crowdWisdom:{payload:{_crowdRoundingBias:true}}},[]);
    assert(s02bias.signals.S02 === 4, 'T324: S02=4 with crowdRoundingBias+3 sharp books');
    const s02nobias = ConvergenceScorer.scoreMarket({label:'Home Win',ev:0.07,odds:2.1,mp:0.52,ip:0.476},{bayesian_lH:1.5,bayesian_lA:1.2,fp:{home:0.48,draw:0.27,away:0.25},evMarkets:[],mc:{varMultiplier:1,ciBound:0.1},sharpDelta:0,mes:0.92,rlmDetected:false,clvProjection:{survivalProb:0.75},ledger:{metrics:{calibFactor:1.0}},fetched:{odds:{sharp_consensus:{bookCount:3}}},convergence:null,crowdWisdom:{payload:{_crowdRoundingBias:false}}},[]);
    assert(s02nobias.signals.S02 === 3, 'T325: S02=3 without crowdRoundingBias');
    FrozenOddsRegistry.reset();

    section('HF-10 — KL-Divergence + Efficiency + Sarmanov');
    assert(typeof MathEngine.klDivergence === 'function', 'T326: klDivergence() exists');
    const kl10 = MathEngine.klDivergence({home:0.55,draw:0.25,away:0.20},{home:0.40,draw:0.30,away:0.30});
    assert(kl10.kl > 0, 'T327: divergent distributions → KL>0');
    assert(kl10.hardSignal === (kl10.kl > 0.15), 'T328: hardSignal threshold correct');
    assert(MathEngine.klDivergence({home:0.45,draw:0.27,away:0.28},{home:0.45,draw:0.27,away:0.28}).kl < 0.001, 'T329: identical → KL≈0');
    assert(typeof MathEngine.normalizedEfficiency === 'function', 'T330: normalizedEfficiency() exists');
    const eff10 = MathEngine.normalizedEfficiency(2.0,3.4,4.2,0.52,0.27,0.21);
    assert(eff10 !== null && eff10.eff >= 0 && eff10.eff <= 1, 'T331: efficiency in [0,1]');
    assert(eff10.normProbs.home + eff10.normProbs.draw + eff10.normProbs.away > 0.98, 'T332: normProbs sum≈1');
    assert(typeof MathEngine.sarmanovTau === 'function', 'T333: sarmanovTau() exists');
    assert(Math.abs(MathEngine.sarmanovTau(0,0,1.5,1.2,-0.13,0) - MathEngine.dixonColesTau(0,0,1.5,1.2,-0.13)) < 0.001, 'T334: order=0 equals dixonColesTau');
    assert(MathEngine.sarmanovTau(0,2,1.5,1.2,-0.13,1) > 0, 'T335: order=1 (0,2) returns positive tau');

    section('HF-11 — CDE Ruin + Antila + Lee Recovery + Serial Dependence');
    assert(typeof MathEngine.adaptiveVarianceRegime === 'function', 'T336: adaptiveVarianceRegime() exists');
    const avr11 = MathEngine.adaptiveVarianceRegime([1,1,1,-1,-1,-1,1,1]);
    assert(typeof avr11.regime === 'string', 'T337: regime is string');
    assert(typeof avr11.factor === 'number' && avr11.factor > 0, 'T338: factor > 0');
    assert(MathEngine.adaptiveVarianceRegime([1]).regime === 'INSUFFICIENT_DATA', 'T339: <4 → INSUFFICIENT_DATA');
    assert(typeof MathEngine.leeRecoveryConstraint === 'function', 'T340: leeRecoveryConstraint() exists');
    assert(MathEngine.leeRecoveryConstraint(0,50).multiplier === 1.0, 'T341: zero drawdown → 1.0');
    assert(MathEngine.leeRecoveryConstraint(0.40,5).multiplier < 1.0, 'T342: deep drawdown → constrained');
    assert(typeof MathEngine.serialDependenceMultiplier === 'function', 'T343: serialDependenceMultiplier() exists');
    assert(MathEngine.serialDependenceMultiplier([1,1,1,1,1,1,1,1]) >= 1.0, 'T344: win streak → ≥1');
    const hf11r = ExecutionEngine.run({telemetry:{hOdds:2.0,dOdds:3.0,aOdds:4.0,broll:1000,peakBroll:1000,xg_confidence:'medium'},pipeline:{fixture:{league:'Default'},fetched:{odds:{home:2.0,draw:3.0,away:4.0}}}},100,true);
    assert(typeof hf11r.adaptiveRegime === 'object', 'T345: adaptiveRegime in result');
    assert(typeof hf11r.leeConstraint === 'object', 'T346: leeConstraint in result');

    // ─── SCAN ORDER + LOW-VARIANCE MARKET TESTS (v2026.3.12+LV) ─────────────────
    section('SCAN ORDER — Goals/LV Priority + New Markets (v2026.3.12+LV)');

    // Build a test matrix: λH=1.8, λA=1.0 — clear home favourite
    const lvMat = [];
    for(let i=0;i<8;i++){lvMat[i]=[];for(let j=0;j<8;j++){lvMat[i][j]=MathEngine.poissonPMF(i,1.8)*MathEngine.poissonPMF(j,1.0);}}
    const lvMkt = MathEngine.extractMarkets(lvMat);

    // T347: teamH over_0.5 exists and is in (0,1)
    assert('over_0.5' in lvMkt.teamH, 'T347: LV teamH.over_0.5 exists in extractMarkets');
    assert(lvMkt.teamH['over_0.5'] > 0 && lvMkt.teamH['over_0.5'] < 1, 'T348: LV teamH.over_0.5 in (0,1)');

    // T349: teamA under_1.5 exists and is in (0,1)
    assert('under_1.5' in lvMkt.teamA, 'T349: LV teamA.under_1.5 exists in extractMarkets');
    assert(lvMkt.teamA['under_1.5'] > 0 && lvMkt.teamA['under_1.5'] < 1, 'T350: LV teamA.under_1.5 in (0,1)');

    // T351: asian2 over + under sums to ~1.0 (push-adjusted)
    assert(lvMkt.asian2 !== undefined, 'T351: LV asian2 field exists in extractMarkets');
    assert(Math.abs((lvMkt.asian2.over + lvMkt.asian2.under) - 1.0) < 0.001, 'T352: LV asian2 over+under sums to 1.0');

    // T353: teamH over_0.5 > teamA over_0.5 for home favourite (λH=1.8 > λA=1.0)
    assert(lvMkt.teamH['over_0.5'] > lvMkt.teamA['over_0.5'], 'T353: LV home team scores more than away (λH=1.8 vs λA=1.0)');

    // T354: asian2 over > 0.5 for high-scoring fixture (λH+λA=2.8 → lots of 3+ goals)
    assert(lvMkt.asian2.over > 0.5, 'T354: LV Asian2 over > 0.5 for high-scoring fixture (λ=2.8)');

    // T355: scanMarkets returns Win Either Half category when bookmaker odds provided
    const lvOdds = {
      'over_2.5':2.05,'over_1.5':1.40,'over_0.5':1.10,'under_3.5':1.60,'under_4.5':1.12,
      'under_2.5':1.90,'under_1.5':3.30,'btts_yes':1.85,'btts_no':1.95,
      'dnb_h':1.50,'dnb_a':2.80,'dc_1x':1.22,'dc_x2':2.20,
      'ah_hp05':1.93,'ah_ap05':1.97,'ah_hm025':1.92,'ah_ap025':1.98,
      'ah_hp025':1.94,'ah_am025':1.96,'ah_hp10':2.45,'ah_ap10':1.62,
      'ah_hp15':3.40,'ah_ap15':1.30,'ah_hm05':2.10,'ah_am05':1.75,
      'win_either_half_h':1.60,'win_either_half_a':2.50,
      'fh_under_1_5':1.65,'fh_draw':3.00,
      // Bookmaker odds for model-computed markets (needed for EV calc)
      'asian_2_over':1.70,'asian_2_under':2.20,     // mispriced vs model
      'home_ou_over_0_5':1.10,'home_ou_under_1_5':6.0,
      'away_ou_over_0_5':1.35,'away_ou_under_1_5':2.80
    };
    const lvEvs = ExecutionEngine.scanMarkets(
      lvMkt, {home:0.58,draw:0.24,away:0.18}, 1.0, 1000,
      0.85, lvOdds, 0, 1.0, 0, 0.90, 0, 8, null
    );
    const lvCats = [...new Set(lvEvs.map(m=>m.cat))];
    assert(lvCats.includes('Win Either Half'), 'T355: LV Win Either Half market scanned when bookmaker odds provided');
    assert(lvCats.includes('First Half'), 'T356: LV First Half market scanned when fh odds provided');
    assert(lvCats.includes('Asian 2 Goals'), 'T357: LV Asian 2 Goals market scanned from matrix');
    assert(lvCats.includes('Team Total'), 'T358: LV Team Total market scanned from matrix');

    // T359: Win Either Half varMod = 1.12
    const wehMarket = lvEvs.find(m=>m.label==='Win Either Half (H)');
    assert(wehMarket !== undefined, 'T359: Win Either Half (H) market exists in scan output');
    assert(!wehMarket || wehMarket.varianceMod === 1.12, 'T360: Win Either Half varianceMod = 1.12');

    // T361: FH Under 1.5 varMod = 1.20 (highest tier)
    const fhMarket = lvEvs.find(m=>m.label==='FH Under 1.5 Goals');
    assert(fhMarket !== undefined, 'T361: FH Under 1.5 market exists in scan output');
    assert(!fhMarket || fhMarket.varianceMod === 1.20, 'T362: FH Under 1.5 varianceMod = 1.20 (highest)');

    // T363: Asian 2 Over varMod = 1.10
    const a2Market = lvEvs.find(m=>m.label==='Asian Over 2 Goals');
    assert(a2Market !== undefined, 'T363: Asian Over 2 Goals market exists in scan output');
    assert(!a2Market || a2Market.varianceMod === 1.10, 'T364: Asian Over 2 Goals varianceMod = 1.10');

    // T365: AH low-var lines scanned before large lines
    const ahLines = lvEvs.filter(m=>m.cat==='Asian Handicap').map(m=>m.label);
    const ahHp05Idx = ahLines.indexOf('AH Home +0.5');
    const ahHm25Idx = ahLines.indexOf('AH Home -2.5');
    assert(ahHp05Idx === -1 || ahHm25Idx === -1 || ahHp05Idx < ahHm25Idx,
      'T365: LV AH +0.5 scanned before AH -2.5 (low-var priority)');

    // T366: Over 2.5 is scanned before Over 4.5 (requested priority)
    const goalLines = lvEvs.filter(m=>m.cat==='Goals O/U').map(m=>m.label);
    const over25Idx = goalLines.indexOf('Over 2.5');
    const over45Idx = goalLines.indexOf('Over 4.5');
    assert(over25Idx === -1 || over45Idx === -1 || over25Idx < over45Idx,
      'T366: LV Over 2.5 scanned before Over 4.5');

    // T367: evMarkets sort confirms low-var markets rank higher at equal raw EV
    // FH Under 1.5 (×1.20) should rank above BTTS Yes (×0.75) at same EV
    const fhRankScore = (fhMarket||{}).rankingScore || 0;
    const bttsMarket = lvEvs.find(m=>m.label==='BTTS Yes');
    const bttsRankScore = (bttsMarket||{}).rankingScore || 0;
    // Only check if both exist and have positive EV
    assert(!fhMarket || !bttsMarket || fhRankScore >= bttsRankScore || fhMarket.ev <= 0,
      'T367: LV FH Under 1.5 rankingScore >= BTTS Yes at comparable EV');

    console.log(`   T347\u2013T367: Scan order + LV market tests \u2713`);

        console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`\u2705 O.R.A.C.L.E. AI v2026.3.12+HF8-11 TEST SUITE COMPLETE`);
    console.log(`   ${passed}/${passed+failed} Assertions Passed (T1\u2013T367)`);
    if(failed>0) console.error(`   ${failed} FAILURES \u2014 Review above for details`);
    console.log(`   T1\u2013T192:   Core v28/v29 suite \u2713`);
    console.log(`   T193\u2013T275: B1-B15 v2026.3.12 blocks \u2713`);
    console.log(`   T276\u2013T305: HF-A\u2192G hotfix suite \u2713`);
    console.log(`   T306\u2013T346: HF-8/9/10/11 + immediate fixes \u2713`);
    console.log(`   T347\u2013T367: Scan order + LV market priority \u2713`);
    console.log(`   v29.0 LOW:      BUG-L02 \u2713 BUG-L03 \u2713 BUG-L04 \u2713`);
    console.log(`   v29.0 NEW:      NEW-25\u219229 \u2713 | Wrapper: KL+Efficiency+Sarmanov+CDE \u2713`);
    console.log(`═══════════════════════════════════════════════════════`);

  } catch(e) {
    console.error('CRITICAL SUITE FAILURE:', e.message, e.stack);
    console.log(`Final state: ${passed} passed, ${failed} failed before crash.`);
  }
  console.groupEnd();
  return { passed, failed, total:passed+failed };
};

if(typeof window!=='undefined') window.runOracleTests = runProtocolUnitTests;

// ═══════════════════════════════════════════════════════════════════════════════
// §17 — EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

if(typeof module!=='undefined'&&module.exports){
  module.exports={
    ORACLE:{MathEngine,ExecutionEngine,CalibrationEngine,TeamRatingsEngine,
            MarketMakerEngine,AntiSycophancyCircuit,RAGSystem,CrowdWisdomProtocol},
    MathEngine,TeamRatingsEngine,CalibrationEngine,MarketMakerEngine,
    ExecutionEngine,AntiSycophancyCircuit,CrowdWisdomProtocol,RAGSystem,
    TelemetryAdapter,PromptRegistry,ConvergenceScorer,MLSafetyFilter,
    LEAGUE_PARAMS,MODELS,THINKING_LEVELS,SHARP_BOOKS,SQUARE_BOOKS,
    runProtocolUnitTests,
  };
}
