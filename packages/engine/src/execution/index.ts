/** ExecutionEngine — ported from ORACLE_v2026_8_0.jsx §11, lines 4003-4676.
 *  Rewrite #2: ORACLE_CONFIG → injected OracleConfig; window/localStorage → eliminated.
 *  LEAGUE_PARAMS, POPULAR_TEAMS, MarketMakerEngine all inlined.
 *  SensitivityEngine refactored as private method (recursive via this._run). */
import type { StoragePort } from "@oracle/storage";
import { isotonicCalibrateFp } from "../calibration/index.js";
import type {
  AhPivotResult,
  MarketBook,
  Referee,
  RegimeReport,
  VarianceResult,
  Weather,
  ZipCoeffs,
} from "../math/index.js";
import {
  adaptiveVarianceRegime,
  adjEV,
  adjustXGForSoS,
  applyEnvironmentalPenalties,
  applyFatigueDecay,
  applyTravelFriction,
  asianHandicapPivot,
  buildBivariateMatrix,
  buildMatrix,
  CorrelationMatrix,
  calibratedZipPi,
  checkLambdaInconsistency,
  clamp,
  clvProjection,
  DEFAULT_BIVARIATE_LAMBDA3,
  detectLowScoringRegime,
  drawCalibrationFactor,
  extractMarkets,
  gaussianRand,
  generateSyntheticAlpha,
  getDrawdownPenalty,
  hurdle,
  isSteamChaser,
  klDivergence,
  leeRecoveryConstraint,
  lstmMarketDecoderProxy,
  monteCarlo,
  normalizedEfficiency,
  optimizedKelly,
  powerMethodVigRemoval,
  safeNum,
  skellamAHCover,
  skellamProbs,
} from "../math/index.js";
import { RAGSystem } from "../rag/index.js";
import { AntiSycophancyCircuit, ConvergenceScorer, MLSafetyFilter } from "../safety/index.js";
import type {
  EVMarket,
  Matrix,
  OracleConfig,
  RunResult,
  RunState,
  SoftContextItem,
} from "../types.js";
import { applyRankingMode } from "./ranking.js";

// ── League parameters (verbatim from JSX lines 240-260) ──────────────────────

interface LeagueParam {
  baseRho: number;
  homeAvg: number;
  awayAvg: number;
  kFactor: number;
  avgGA: number;
  drawRate: number;
  reliability: string;
  upsetLeague: boolean;
}

const LEAGUE_PARAMS: Record<string, LeagueParam> = {
  "Premier League": {
    baseRho: -0.13,
    homeAvg: 1.48,
    awayAvg: 1.22,
    kFactor: 15,
    avgGA: 1.35,
    drawRate: 0.245,
    reliability: "high",
    upsetLeague: false,
  },
  "La Liga": {
    baseRho: -0.16,
    homeAvg: 1.52,
    awayAvg: 1.18,
    kFactor: 12,
    avgGA: 1.28,
    drawRate: 0.28,
    reliability: "medium",
    upsetLeague: true,
  },
  "Serie A": {
    baseRho: -0.18,
    homeAvg: 1.42,
    awayAvg: 1.1,
    kFactor: 12,
    avgGA: 1.25,
    drawRate: 0.295,
    reliability: "medium",
    upsetLeague: true,
  },
  Bundesliga: {
    baseRho: -0.14,
    homeAvg: 1.62,
    awayAvg: 1.35,
    kFactor: 10,
    avgGA: 1.45,
    drawRate: 0.22,
    reliability: "high",
    upsetLeague: false,
  },
  "Ligue 1": {
    baseRho: -0.15,
    homeAvg: 1.44,
    awayAvg: 1.15,
    kFactor: 10,
    avgGA: 1.3,
    drawRate: 0.26,
    reliability: "medium",
    upsetLeague: true,
  },
  "Champions League": {
    baseRho: -0.1,
    homeAvg: 1.55,
    awayAvg: 1.25,
    kFactor: 18,
    avgGA: 1.4,
    drawRate: 0.235,
    reliability: "high",
    upsetLeague: false,
  },
  "Europa League": {
    baseRho: -0.12,
    homeAvg: 1.5,
    awayAvg: 1.2,
    kFactor: 15,
    avgGA: 1.35,
    drawRate: 0.24,
    reliability: "high",
    upsetLeague: false,
  },
  Eredivisie: {
    baseRho: -0.12,
    homeAvg: 1.72,
    awayAvg: 1.38,
    kFactor: 10,
    avgGA: 1.52,
    drawRate: 0.21,
    reliability: "high",
    upsetLeague: false,
  },
  "Scottish Premiership": {
    baseRho: -0.13,
    homeAvg: 1.55,
    awayAvg: 1.18,
    kFactor: 8,
    avgGA: 1.38,
    drawRate: 0.225,
    reliability: "high",
    upsetLeague: false,
  },
  "Austrian Bundesliga": {
    baseRho: -0.13,
    homeAvg: 1.65,
    awayAvg: 1.3,
    kFactor: 8,
    avgGA: 1.45,
    drawRate: 0.218,
    reliability: "high",
    upsetLeague: false,
  },
  "Primeira Liga": {
    baseRho: -0.14,
    homeAvg: 1.58,
    awayAvg: 1.22,
    kFactor: 10,
    avgGA: 1.38,
    drawRate: 0.232,
    reliability: "high",
    upsetLeague: false,
  },
  "Belgian Pro League": {
    baseRho: -0.13,
    homeAvg: 1.6,
    awayAvg: 1.28,
    kFactor: 9,
    avgGA: 1.42,
    drawRate: 0.226,
    reliability: "high",
    upsetLeague: false,
  },
  Championship: {
    baseRho: -0.13,
    homeAvg: 1.5,
    awayAvg: 1.2,
    kFactor: 8,
    avgGA: 1.35,
    drawRate: 0.265,
    reliability: "low",
    upsetLeague: true,
  },
  WSL: {
    baseRho: -0.08,
    homeAvg: 1.52,
    awayAvg: 1.18,
    kFactor: 20,
    avgGA: 1.35,
    drawRate: 0.23,
    reliability: "medium",
    upsetLeague: true,
  },
  NWSL: {
    baseRho: -0.07,
    homeAvg: 1.48,
    awayAvg: 1.12,
    kFactor: 20,
    avgGA: 1.3,
    drawRate: 0.225,
    reliability: "medium",
    upsetLeague: true,
  },
  "Women's Champions League": {
    baseRho: -0.06,
    homeAvg: 1.65,
    awayAvg: 1.3,
    kFactor: 22,
    avgGA: 1.45,
    drawRate: 0.215,
    reliability: "medium",
    upsetLeague: true,
  },
  Default: {
    baseRho: -0.13,
    homeAvg: 1.45,
    awayAvg: 1.15,
    kFactor: 8,
    avgGA: 1.3,
    drawRate: 0.25,
    reliability: "medium",
    upsetLeague: false,
  },
};

// ── Popular teams — forward substring matching (BUG-M08 FIX) ─────────────────

const POPULAR_TEAMS = new Set([
  "manchester city",
  "manchester united",
  "liverpool",
  "arsenal",
  "chelsea",
  "tottenham",
  "real madrid",
  "barcelona",
  "atletico madrid",
  "bayern munich",
  "borussia dortmund",
  "psg",
  "paris saint-germain",
  "juventus",
  "inter milan",
  "ac milan",
  "napoli",
  "ajax",
  "porto",
  "benfica",
  "man city",
  "man utd",
  "man united",
  "spurs",
  "bvb",
  "fcb",
  "fcbayern",
  "barca",
  "atletico",
  "inter",
  "juve",
  "bayer leverkusen",
  "rb leipzig",
  "sevilla",
  "valencia",
  "real sociedad",
  "villarreal",
  "roma",
  "lazio",
  "fiorentina",
  "atalanta",
  "dortmund",
  "schalke",
  "wolves",
  "wolverhampton",
  "leicester",
  "west ham",
  "newcastle",
  "aston villa",
  "brighton",
  "celtic",
  "rangers",
  "psv",
  "feyenoord",
  "lyon",
  "marseille",
  "monaco",
  "lille",
  "sporting cp",
  "braga",
  "galatasaray",
  "fenerbahce",
  "tottenham hotspur",
  "wolverhampton wanderers",
  "west ham united",
  "leicester city",
  "newcastle united",
  "paris saint germain",
  "atletico de madrid",
  "borussia dortmund",
  "rb leipzig",
  "bayer 04 leverkusen",
  "fc barcelona",
  "real madrid cf",
]);

function isPopularTeam(name: string): boolean {
  if (!name) return false;
  const n = name.toLowerCase().trim();
  if (POPULAR_TEAMS.has(n)) return true;
  return [...POPULAR_TEAMS].some((t) => {
    const re = new RegExp(`(^|\\s)${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`);
    return re.test(n);
  });
}

// ── MarketMakerEngine.price() inlined ────────────────────────────────────────

const VIG_MARGIN = 0.018;

function mmeProbs(pH: number, pD: number, pA: number): Record<string, number> {
  const total = pH + pD + pA;
  if (total <= 0) return {};
  const vf = 1 + VIG_MARGIN;
  return {
    home: parseFloat((1 / ((pH / total) * vf)).toFixed(3)),
    draw: parseFloat((1 / ((pD / total) * vf)).toFixed(3)),
    away: parseFloat((1 / ((pA / total) * vf)).toFixed(3)),
    impliedH: parseFloat(((pH / total) * vf * 100).toFixed(1)),
    impliedD: parseFloat(((pD / total) * vf * 100).toFixed(1)),
    impliedA: parseFloat(((pA / total) * vf * 100).toFixed(1)),
  };
}

function marketMakerPrice(r: Record<string, unknown>): unknown {
  const fp = r.fp as { home: number; draw: number; away: number } | undefined;
  if (!fp) return null;
  const finalMkt = r.finalMkt as MarketBook | undefined;
  const oracleFair = mmeProbs(fp.home, fp.draw, fp.away);
  const oracleOU: Record<string, number> = {};
  const ou = finalMkt?.ou ?? {};
  for (const k of ["over_0.5", "over_1.5", "over_2.5", "over_3.5", "over_4.5"] as const) {
    const v = ou[k];
    if (v && v > 0 && v < 1) {
      oracleOU[k] = parseFloat((1 / (v * (1 + VIG_MARGIN))).toFixed(3));
      oracleOU[k.replace("over", "under")] = parseFloat(
        (1 / ((1 - v) * (1 + VIG_MARGIN))).toFixed(3)
      );
    }
  }
  return {
    timestamp: new Date().toISOString(),
    fixture: `${String(r.home ?? "")} vs ${String(r.away ?? "")}`,
    oracleFair,
    oracleOU,
    lambdaH: r.bayesian_lH,
    lambdaA: r.bayesian_lA,
  };
}

// ── Gemini context type (mirrors LLMKeyConfig without creating a circular dep) ─

type GeminiCtx = {
  config: { geminiApiKey: string; claudeApiKey: string; bankroll: number; [key: string]: unknown };
  requestedAt: string;
};
type GeminiCallFn = (prompt: string, ctx: GeminiCtx) => Promise<string>;

// ── Acquisition JSON parser ───────────────────────────────────────────────────

function parseAcquisitionJson<T>(text: string): T | null {
  try {
    const cleaned = text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

// ── SensitivityResult type ────────────────────────────────────────────────────

interface SensitivityResult {
  fragilityScore: number;
  map: Record<string, unknown>;
  evDropsToZero: number;
  totalRuns: number;
  ensembleStdDev: number;
  paramUncertaintyFlag: string | null;
}

// ── ExecutionEngine ───────────────────────────────────────────────────────────

export class ExecutionEngine {
  constructor(
    private _config: OracleConfig,
    private _storage: StoragePort
  ) {}

  // ── scanMarkets ─────────────────────────────────────────────────────────────

  private scanMarkets(
    markets: MarketBook,
    _fp: { home: number; draw: number; away: number },
    calibFactor: number,
    bankroll: number,
    dqs: number,
    oddsData: Record<string, number>,
    councilPenalty: boolean,
    varMultiplier: number,
    drawdownPenalty: number,
    mes: number,
    globalVelocity: number,
    hoursToKO: number,
    upsetAlertVeto: string | null
  ): EVMarket[] {
    const cfg = this._config;
    const evs: EVMarket[] = [];
    if (!oddsData) return evs;
    const proximateVeto = hoursToKO < 1.5 && globalVelocity < -0.02;

    const check = (cat: string, label: string, mp: number | undefined, od: number | undefined) => {
      if (!mp || !od || od <= 1) return;
      const ip = 1 / od,
        rawEdge = mp - ip,
        ev = adjEV(mp, od);
      const adjHurdle = cat === "1x2" ? Math.max(0.1, hurdle(mp)) : hurdle(mp);
      const _varMod = (() => {
        const lb = label;
        if (lb.includes("First Half Under 1.5") || lb.includes("FH Under 1.5")) return 1.2;
        if (lb.includes("First Half Draw") || lb.includes("FH Draw")) return 1.15;
        if (lb.includes("Team Away Under 1.5") || lb.includes("Away Total Under")) return 1.18;
        if (lb.includes("Team Home Under 1.5") || lb.includes("Home Total Under")) return 1.16;
        if (
          lb.includes("Team Over 0.5") ||
          lb.includes("Home Total Over 0.5") ||
          lb.includes("Away Total Over 0.5")
        )
          return 1.15;
        if (lb.includes("Over 0.5")) return 1.15;
        if (lb.includes("Under 4.5") || lb.includes("Under 3.5")) return 1.12;
        if (lb.includes("Win Either Half")) return 1.12;
        if (lb.includes("Asian 2") || lb.includes("Asian Over 2") || lb.includes("Asian Under 2"))
          return 1.1;
        if (lb.includes("+1.5") || lb.includes("AH Away +1.5") || lb.includes("AH Home +1.5"))
          return 1.1;
        if (lb.includes("+1.0") || lb.includes("AH Away +1.0") || lb.includes("AH Home +1.0"))
          return 1.09;
        if (lb.includes("+0.5") || lb.includes("-0.25") || lb.includes("+0.25")) return 1.08;
        if (
          lb.includes("DNB") ||
          lb.includes("Double Chance") ||
          lb.includes("1X") ||
          lb.includes("X2")
        )
          return 1.08;
        if (lb.includes("Under 2.5") || (lb.includes("Asian") && lb.includes("2.0"))) return 1.05;
        if (lb.includes("Over 1.5")) return 1.02;
        if (lb.includes("Over 2.5")) return 0.97;
        if (lb.includes("BTTS No")) return 1.0;
        if (lb.includes("BTTS Yes") || lb.includes("Over 3.5") || lb.includes("Over 4.5"))
          return 0.75;
        if (lb.includes("Under 1.5")) return 0.82;
        return 1.0;
      })();

      let isUpsetVetoed = false;
      if (upsetAlertVeto === "home" && (label.includes("Home") || label === "1X"))
        isUpsetVetoed = true;
      if (upsetAlertVeto === "away" && (label.includes("Away") || label === "X2"))
        isUpsetVetoed = true;
      const sentinelVeto =
        (rawEdge > 0 && globalVelocity < -0.08) || proximateVeto || isUpsetVetoed;
      const isVolLoving =
        (cat === "Goals O/U" && label.includes("Over")) ||
        (cat === "BTTS" && label.includes("Yes"));
      const mVarMult = varMultiplier < 1.0 && isVolLoving ? 1.0 : varMultiplier;
      const isElasticMesVeto = mes < 0.85 && rawEdge < 0.08;

      if (ev > 0 && rawEdge >= adjHurdle && !sentinelVeto && !isElasticMesVeto) {
        let stake = optimizedKelly(
          rawEdge,
          od,
          dqs,
          councilPenalty,
          mVarMult,
          drawdownPenalty,
          calibFactor,
          0.25,
          mp
        );
        if (cfg.enableSoftmaxBlend) {
          const _approxScore = Math.round(ev * 80);
          const _softmaxEdge = Math.max(0, 1 / (1 + Math.exp(-_approxScore / 8)) - 0.5);
          stake = stake * 0.6 + _softmaxEdge * stake * 2 * 0.4;
        }
        stake = clamp(stake, 0, 0.25);
        const rankScore = ev * _varMod;
        evs.push({
          cat,
          label,
          market: cat,
          side: label,
          mp,
          modelProb: mp,
          ip,
          rawEdge,
          ev,
          odds: od,
          stake,
          stakeAmt: stake * (bankroll || 1000),
          rankingScore: rankScore,
          varianceMod: _varMod,
        });
      } else if (isElasticMesVeto && ev > 0) {
        evs.push({
          cat,
          label,
          market: cat,
          side: label,
          mp,
          modelProb: mp,
          ip,
          rawEdge,
          ev,
          odds: od,
          stake: 0,
          stakeAmt: 0,
          rankingScore: -100,
          varianceMod: _varMod,
          veto: "MES VETO (ELASTIC)",
        });
      } else if (sentinelVeto && ev > 0) {
        evs.push({
          cat,
          label,
          market: cat,
          side: label,
          mp,
          modelProb: mp,
          ip,
          rawEdge,
          ev,
          odds: od,
          stake: 0,
          stakeAmt: 0,
          rankingScore: -100,
          varianceMod: _varMod,
          veto: isUpsetVetoed ? "UPSET ALERT VETO" : "PROXIMATE SHADING VETO",
        });
      }
    };

    // BLOCK 1: Goals O/U
    if (markets.ou) {
      check("Goals O/U", "Over 2.5", markets.ou["over_2.5"], oddsData["over_2.5"]);
      check("Goals O/U", "Under 3.5", markets.ou["under_3.5"], oddsData["under_3.5"]);
      check("Goals O/U", "Under 4.5", markets.ou["under_4.5"], oddsData["under_4.5"]);
      check("Goals O/U", "Under 2.5", markets.ou["under_2.5"], oddsData["under_2.5"]);
      check("Goals O/U", "Over 1.5", markets.ou["over_1.5"], oddsData["over_1.5"]);
      check("Goals O/U", "Over 0.5", markets.ou["over_0.5"], oddsData["over_0.5"]);
      check("Goals O/U", "Over 3.5", markets.ou["over_3.5"], oddsData["over_3.5"]);
      check("Goals O/U", "Over 4.5", markets.ou["over_4.5"], oddsData["over_4.5"]);
      check("Goals O/U", "Under 1.5", markets.ou["under_1.5"], oddsData["under_1.5"]);
      check("Goals O/U", "Under 0.5", markets.ou["under_0.5"], oddsData["under_0.5"] ?? 0);
    }

    // BLOCK 2: Asian 2 Goals
    if (markets.asian2) {
      const a2Over =
        oddsData.asian_2_over > 1
          ? oddsData.asian_2_over
          : markets.asian2.over > 0.01
            ? 1 / markets.asian2.over
            : 0;
      const a2Under =
        oddsData.asian_2_under > 1
          ? oddsData.asian_2_under
          : markets.asian2.under > 0.01
            ? 1 / markets.asian2.under
            : 0;
      check("Asian 2 Goals", "Asian Over 2 Goals", markets.asian2.over, a2Over);
      check("Asian 2 Goals", "Asian Under 2 Goals", markets.asian2.under, a2Under);
    }

    // BLOCK 3: Team totals
    if (markets.teamH && markets.teamA) {
      const htHOdds05 =
        oddsData.home_ou_over_0_5 > 1
          ? oddsData.home_ou_over_0_5
          : (markets.teamH["over_0.5"] ?? 0) > 0.01
            ? 1 / markets.teamH["over_0.5"]!
            : 0;
      const atAOdds05 =
        oddsData.away_ou_over_0_5 > 1
          ? oddsData.away_ou_over_0_5
          : (markets.teamA["over_0.5"] ?? 0) > 0.01
            ? 1 / markets.teamA["over_0.5"]!
            : 0;
      const htHU15 =
        oddsData.home_ou_under_1_5 > 1
          ? oddsData.home_ou_under_1_5
          : (markets.teamH["under_1.5"] ?? 0) > 0.01
            ? 1 / markets.teamH["under_1.5"]!
            : 0;
      const atAU15 =
        oddsData.away_ou_under_1_5 > 1
          ? oddsData.away_ou_under_1_5
          : (markets.teamA["under_1.5"] ?? 0) > 0.01
            ? 1 / markets.teamA["under_1.5"]!
            : 0;
      check("Team Total", "Home Total Over 0.5", markets.teamH["over_0.5"], htHOdds05);
      check("Team Total", "Away Total Over 0.5", markets.teamA["over_0.5"], atAOdds05);
      check("Team Total", "Home Total Under 1.5", markets.teamH["under_1.5"], htHU15);
      check("Team Total", "Away Total Under 1.5", markets.teamA["under_1.5"], atAU15);
      const h15 = markets.teamH["over_1.5"] ?? 0;
      const a15 = markets.teamA["over_1.5"] ?? 0;
      check("Team Total", "Home Total Over 1.5", h15, h15 > 0.01 ? 1 / h15 : 0);
      check("Team Total", "Away Total Over 1.5", a15, a15 > 0.01 ? 1 / a15 : 0);
    }

    // BLOCK 4: Asian Handicap
    if (markets.ah) {
      const ahLines = [
        { key: "hp05", label: "AH Home +0.5" },
        { key: "ap05", label: "AH Away +0.5" },
        { key: "hm025", label: "AH Home -0.25" },
        { key: "am025", label: "AH Away -0.25" },
        { key: "hp025", label: "AH Home +0.25" },
        { key: "ap025", label: "AH Away +0.25" },
        { key: "hp10", label: "AH Home +1.0" },
        { key: "ap10", label: "AH Away +1.0" },
        { key: "hp15", label: "AH Home +1.5" },
        { key: "ap15", label: "AH Away +1.5" },
        { key: "hm05", label: "AH Home -0.5" },
        { key: "am05", label: "AH Away -0.5" },
        { key: "hm075", label: "AH Home -0.75" },
        { key: "am075", label: "AH Away -0.75" },
        { key: "hm10", label: "AH Home -1.0" },
        { key: "am10", label: "AH Away -1.0" },
        { key: "hm15", label: "AH Home -1.5" },
        { key: "am15", label: "AH Away -1.5" },
        { key: "hp20", label: "AH Home +2.0" },
        { key: "ap20", label: "AH Away +2.0" },
        { key: "hm20", label: "AH Home -2.0" },
        { key: "am20", label: "AH Away -2.0" },
        { key: "hp25", label: "AH Home +2.5" },
        { key: "ap25", label: "AH Away +2.5" },
        { key: "hm25", label: "AH Home -2.5" },
        { key: "am25", label: "AH Away -2.5" },
      ];
      ahLines.forEach((m) =>
        check(
          "Asian Handicap",
          m.label,
          markets.ah[m.key] as number | undefined,
          oddsData[`ah_${m.key}`]
        )
      );
    }

    // BLOCK 5: Win Either Half
    if ((oddsData.win_either_half_h ?? 0) > 1) {
      const wEHH_mp = markets.teamH
        ? Math.min(0.97, (markets.teamH["over_0.5"] ?? 0) * 0.88 + markets.hw * 0.12)
        : markets.hw;
      const wEHA_mp = markets.teamA
        ? Math.min(0.97, (markets.teamA["over_0.5"] ?? 0) * 0.88 + markets.aw * 0.12)
        : markets.aw;
      check("Win Either Half", "Win Either Half (H)", wEHH_mp, oddsData.win_either_half_h);
      check("Win Either Half", "Win Either Half (A)", wEHA_mp, oddsData.win_either_half_a);
    }

    // BLOCK 6: First Half
    if ((oddsData.fh_under_1_5 ?? 0) > 1) {
      const fhLH = (markets.teamH ? (markets.teamH["over_0.5"] ?? 0) : 0.7) * 0.5;
      const fhLA = (markets.teamA ? (markets.teamA["over_0.5"] ?? 0) : 0.6) * 0.5;
      const fhGoals0 = Math.exp(-(fhLH + fhLA));
      const fhU15_mp = fhGoals0 + fhGoals0 * (fhLH + fhLA);
      check("First Half", "FH Under 1.5 Goals", Math.min(0.95, fhU15_mp), oddsData.fh_under_1_5);
    }
    if ((oddsData.fh_draw ?? 0) > 1) {
      check("First Half", "FH Draw", Math.min(0.55, markets.dr * 1.35), oddsData.fh_draw);
    }

    // BLOCK 7: BTTS
    check("BTTS", "BTTS Yes", markets.btts, oddsData.btts_yes);
    check("BTTS", "BTTS No", markets.noBtts, oddsData.btts_no);

    // BLOCK 8: Draw No Bet
    check("Draw No Bet", "DNB Home", markets.dnb_h, oddsData.dnb_h);
    check("Draw No Bet", "DNB Away", markets.dnb_a, oddsData.dnb_a);

    // BLOCK 9: Double Chance
    check("Double Chance", "1X", markets.dc_1x, oddsData.dc_1x);
    check("Double Chance", "X2", markets.dc_x2, oddsData.dc_x2);

    return evs.sort((a, b) => b.rankingScore - a.rankingScore);
  }

  // ── SensitivityEngine (Gaussian ensemble, K=20) ──────────────────────────

  private async _sensitivityAnalyze(
    state: RunState,
    baseRes: RunResult
  ): Promise<SensitivityResult> {
    const K = 20,
      SIGMA_FRAC = 0.05;
    const topMarket = baseRes.evMarkets?.[0];
    if (!topMarket)
      return {
        fragilityScore: 0,
        map: {},
        evDropsToZero: 0,
        totalRuns: 0,
        ensembleStdDev: 0,
        paramUncertaintyFlag: null,
      };

    const tel = state.telemetry ?? {};
    const allEVs: number[] = [];
    let evDropsToZero = 0,
      totalRuns = 0;
    const rawMap: Record<string, number[]> = {};

    const runPerturbed = async (key: string, perturbedVal: number) => {
      totalRuns++;
      const ps: RunState = JSON.parse(JSON.stringify(state));
      const t = ps.telemetry ?? {};
      if (key === "piH" || key === "piA") t[key] = clamp(perturbedVal, 500, 3000);
      if (key === "xH" || key === "xA") t[key] = clamp(perturbedVal, 0.05, 8.0);
      if (key === "injPenH" || key === "injPenA") t[key] = clamp(perturbedVal, 0, 0.95);
      ps.telemetry = t;
      const pRes = await this._run(ps, 1000, true);
      const matched = pRes.evMarkets.find((m) => m.label === topMarket.label);
      const ev = matched ? matched.ev : -1;
      allEVs.push(ev);
      if (!rawMap[key]) rawMap[key] = [];
      rawMap[key]?.push(ev);
      if (ev <= 0) evDropsToZero++;
    };

    const params = [
      { key: "piH", base: safeNum(tel.piH, 1500) },
      { key: "piA", base: safeNum(tel.piA, 1500) },
      ...(safeNum(tel.xH, 0) > 0 ? [{ key: "xH", base: safeNum(tel.xH, 0) }] : []),
      ...(safeNum(tel.xA, 0) > 0 ? [{ key: "xA", base: safeNum(tel.xA, 0) }] : []),
      ...(safeNum(tel.injPenH, 0) > 0 ? [{ key: "injPenH", base: safeNum(tel.injPenH, 0) }] : []),
      ...(safeNum(tel.injPenA, 0) > 0 ? [{ key: "injPenA", base: safeNum(tel.injPenA, 0) }] : []),
    ];

    const mapOut: Record<string, { mean: number; stdDev: number; samples: number }> = {};
    for (const { key, base } of params) {
      const sigma = Math.max(0.01, base * SIGMA_FRAC);
      for (let k = 0; k < K; k++) await runPerturbed(key, gaussianRand(base, sigma));
      const vals = rawMap[key] ?? [];
      const mean = vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
      const sd = Math.sqrt(
        vals.map((v) => (v - mean) ** 2).reduce((s, v) => s + v, 0) / (vals.length || 1)
      );
      mapOut[key] = {
        mean: parseFloat(mean.toFixed(4)),
        stdDev: parseFloat(sd.toFixed(4)),
        samples: vals.length,
      };
    }

    const n = allEVs.length;
    const meanEV = n > 0 ? allEVs.reduce((s, v) => s + v, 0) / n : 0;
    const ensembleStdDev =
      n > 1
        ? parseFloat(
            Math.sqrt(allEVs.map((v) => (v - meanEV) ** 2).reduce((s, v) => s + v, 0) / n).toFixed(
              4
            )
          )
        : 0;
    const paramUncertaintyFlag =
      ensembleStdDev > 0.05
        ? `[HIGH_PARAM_UNCERTAINTY] Gaussian ensemble σ=${ensembleStdDev.toFixed(4)} across ${n} runs — edge unreliable under parameter noise. Kelly stake × 0.70.`
        : null;
    const fragilityScore = Math.min(10, (evDropsToZero / Math.max(totalRuns, 1)) * 20);
    return {
      fragilityScore,
      map: mapOut,
      evDropsToZero,
      totalRuns,
      ensembleStdDev,
      paramUncertaintyFlag,
    };
  }

  // ── _acquireContext — Gemini T1/T2/T3 acquisition turns ──────────────────

  private async _acquireContext(state: RunState): Promise<void> {
    if (!this._config.geminiApiKey) return;
    // Two-tier gate: the Gemini xG/injury/context acquisition turns are the
    // expensive LLM tier of the engine. Only the top-N fixtures (llmEligible)
    // pay for them; the rest run fully deterministic on sidecar/scraped stats.
    // Default true when the flag is absent (ad-hoc /analyze, single-fixture).
    if (state.telemetry?.llmEligible === false) return;

    const fixture = state.pipeline?.fixture ?? {};
    const home = String(fixture.home ?? "").trim();
    const away = String(fixture.away ?? "").trim();
    const league = String(fixture.league ?? "").trim();
    const kickoff = String(fixture.date ?? new Date().toISOString());
    if (!home || !away) return;

    let fetchGemini: GeminiCallFn | null = null;
    try {
      const llm = await import("@oracle/llm");
      fetchGemini = llm.fetchGeminiWithCascade;
    } catch {
      return;
    }
    if (!fetchGemini) return;

    const geminiCtx: GeminiCtx = {
      config: {
        geminiApiKey: this._config.geminiApiKey,
        claudeApiKey: this._config.claudeApiKey,
        bankroll: this._config.bankroll,
      },
      requestedAt: new Date().toISOString(),
    };

    // T0 (Perplexity news) is enriched in the runtime layer (runtime/newsIntel.ts)
    // before the batch, so the fs-free engine handles only the Gemini turns here.
    const [t1, t2, t3] = await Promise.allSettled([
      this._runT1(fetchGemini, home, away, league, geminiCtx),
      this._runT2(fetchGemini, home, away, league, geminiCtx),
      this._runT3(fetchGemini, home, away, league, kickoff, geminiCtx),
    ]);

    if (!state.telemetry) state.telemetry = {};

    if (t1.status === "fulfilled" && t1.value) {
      const v = t1.value;
      if (v.xH > 0 && !state.telemetry.xH) state.telemetry.xH = v.xH;
      if (v.xA > 0 && !state.telemetry.xA) state.telemetry.xA = v.xA;
      state.telemetry.xg_confidence = v.confidence ?? "low";
      state.telemetry.xg_sources_count = 1;
      if (!state.telemetry.xgMode) state.telemetry.xgMode = "estimated";
    }

    if (t2.status === "fulfilled" && t2.value) {
      const v = t2.value;
      if (v.injPenH != null && !state.telemetry.injPenH) state.telemetry.injPenH = v.injPenH;
      if (v.injPenA != null && !state.telemetry.injPenA) state.telemetry.injPenA = v.injPenA;
      if (v.softContext?.length) {
        const existing = state.telemetry.softContext ?? [];
        state.telemetry.softContext = [...existing, ...v.softContext];
      }
    }

    if (t3.status === "fulfilled" && t3.value) {
      const v = t3.value;
      if (v.isDerby != null && !state.telemetry.isDerby) state.telemetry.isDerby = v.isDerby;
      if (v.motivationScore != null && !state.telemetry.motivationScore)
        state.telemetry.motivationScore = v.motivationScore;
      if (v.travelKm != null && !state.telemetry.travelKm) state.telemetry.travelKm = v.travelKm;
      if (v.softContext?.length) {
        const existing = state.telemetry.softContext ?? [];
        state.telemetry.softContext = [...existing, ...v.softContext];
      }
    }
  }

  private async _runT1(
    fn: GeminiCallFn,
    home: string,
    away: string,
    league: string,
    ctx: GeminiCtx
  ): Promise<{ xH: number; xA: number; confidence: "low" | "medium" | "high" } | null> {
    const prompt = `Return ONLY JSON, no other text.
Estimate average expected goals per game for each team based on their typical attacking output in ${league}.
Fixture: ${home} vs ${away}
{"xH":1.4,"xA":0.9,"confidence":"medium"}
xH/xA: 0.1-3.0. confidence: "low" if rough estimate, "medium" if reasonable, "high" if well-known teams.`;
    try {
      const raw = await fn(prompt, ctx);
      return parseAcquisitionJson(raw);
    } catch {
      return null;
    }
  }

  private async _runT2(
    fn: GeminiCallFn,
    home: string,
    away: string,
    league: string,
    ctx: GeminiCtx
  ): Promise<{ injPenH: number; injPenA: number; softContext?: SoftContextItem[] } | null> {
    const prompt = `Return ONLY JSON, no other text.
Estimate injury impact for each team based on your training knowledge.
Fixture: ${home} vs ${away} (${league})
{"injPenH":0.0,"injPenA":0.0,"softContext":[]}
injPenH/injPenA: 0=no injuries, 0.1=minor, 0.2=key player out, 0.3=multiple key players out.
Return 0.0 if uncertain.
softContext: 0-1 items: {"kind":"injury","text":"...","source":"Gemini T2","observedAt":"${new Date().toISOString()}"}`;
    try {
      const raw = await fn(prompt, ctx);
      return parseAcquisitionJson(raw);
    } catch {
      return null;
    }
  }

  private async _runT3(
    fn: GeminiCallFn,
    home: string,
    away: string,
    league: string,
    kickoff: string,
    ctx: GeminiCtx
  ): Promise<{
    isDerby: boolean;
    motivationScore: number;
    travelKm: number;
    softContext?: SoftContextItem[];
  } | null> {
    const prompt = `Return ONLY JSON, no other text.
Identify contextual factors for this match.
Fixture: ${home} vs ${away} (${league}), kickoff: ${kickoff}
{"isDerby":false,"motivationScore":1.0,"travelKm":0,"softContext":[]}
isDerby: true if local derby or fierce rivalry.
motivationScore: 0.5=low stakes, 1.0=normal, 1.2=high stakes (relegation/title).
travelKm: estimated away team travel distance (0-2000).
softContext: 0-2 items: {"kind":"motivation","text":"...","source":"Gemini T3","observedAt":"${kickoff}"}`;
    try {
      const raw = await fn(prompt, ctx);
      return parseAcquisitionJson(raw);
    } catch {
      return null;
    }
  }

  // ── _run (synchronous core) ───────────────────────────────────────────────

  async _run(state: RunState, mcRuns = 10000, skipSensitivity = false): Promise<RunResult> {
    await this._acquireContext(state);

    const cfg = this._config;
    const tel = state.telemetry ?? {};
    const pipe = state.pipeline ?? {};
    const ledger = state.ledger;
    const fixture = pipe.fixture ?? {};
    const fetched = pipe.fetched ?? {};

    const p = (val: unknown, fb: number) => safeNum(val, fb);

    const piH = p(tel.piH, 1500);
    const piA = p(tel.piA, 1500);

    const xH_raw = p(tel.xH, 0),
      xA_raw = p(tel.xA, 0);
    const restH = p(tel.restH, 7),
      restA = p(tel.restA, 7);
    const travelKm = p(tel.travelKm, 0),
      altitudeM = p(tel.altitudeM, 0);
    const hoursToKO = p(tel.hoursToKO, 24);
    const homeOdds = p(tel.hOdds, 1.85),
      drawOdds = p(tel.dOdds, 3.4),
      awayOdds = p(tel.aOdds, 4.5);
    const ohO = p(tel.ohO, homeOdds);
    const bankroll = p(tel.broll, cfg.bankroll || 1000);
    const peakBroll = p(tel.peakBroll, bankroll);

    const rawOddsPay = tel.rawOddsPayload as Record<string, unknown> | undefined;
    const oddsData = (fetched.odds ??
      rawOddsPay ?? { home: homeOdds, draw: drawOdds, away: awayOdds }) as Record<string, number>;

    const league = String(fixture.league ?? "");
    const lp: LeagueParam = {
      ...(LEAGUE_PARAMS[league] ?? LEAGUE_PARAMS.Default!),
      ...((ledger?.metrics?.bbnParams as Record<string, Partial<LeagueParam>> | undefined)?.[
        league
      ] ?? {}),
    };
    const dynamicRho = ledger?.metrics?.dynamicRhoParams?.[league];
    if (dynamicRho !== undefined) lp.baseRho = dynamicRho;

    const dqs = (fetched.dqs as number | undefined) ?? 0.85;
    const drawdown = peakBroll > 0 ? Math.max(0, (peakBroll - bankroll) / peakBroll) : 0;
    const drawdownPenalty = getDrawdownPenalty(drawdown);

    const _xgConf = (tel.xg_confidence ?? "medium") as "low" | "medium" | "high";
    const _xgSrc = p(tel.xg_sources_count, 1);
    const xgConfidenceMod = _xgConf === "low" ? 0.75 : _xgConf === "medium" ? 0.9 : 1.0;
    const xgConfidenceFlag =
      _xgConf === "low"
        ? "[LOW_XG_CONFIDENCE] Gemini estimated xG from single/unverified source — Kelly ×0.75"
        : _xgSrc === 1
          ? "[SINGLE_XG_SOURCE] Only one xG source consulted — treat xG estimates with caution"
          : null;

    const _recentOutcomes = (ledger?.bets ?? [])
      .slice(-8)
      .map((b) =>
        b.outcome === "win"
          ? 1
          : b.outcome === "half-win"
            ? 0.5
            : b.outcome === "loss"
              ? -1
              : b.outcome === "half-loss"
                ? -0.5
                : 0
      );
    const _adaptiveRegime = adaptiveVarianceRegime(_recentOutcomes);
    const _leeConstraint = leeRecoveryConstraint(drawdown, 50);
    const _bindingRisk = Math.min(
      drawdownPenalty,
      Math.min(1.0, _adaptiveRegime.factor),
      _leeConstraint.multiplier
    );
    const drawdownPenaltyFinal = clamp(_bindingRisk * xgConfidenceMod, 0.1, 1.0);
    const timeDecayInfo = clamp(1.0 - Math.max(0, hoursToKO - 2) / 200, 0.7, 1.0);

    // Arbitrage vig-removal
    let rawOverround = 1.0,
      isArbitrage = false;
    let adjHome = homeOdds,
      adjDraw = drawOdds,
      adjAway = awayOdds;
    if (homeOdds > 1 && drawOdds > 1 && awayOdds > 1) {
      rawOverround = 1 / homeOdds + 1 / drawOdds + 1 / awayOdds;
      isArbitrage = rawOverround < 1.0;
      if (isArbitrage) {
        adjHome = homeOdds * rawOverround;
        adjDraw = drawOdds * rawOverround;
        adjAway = awayOdds * rawOverround;
      }
    }
    const mes = clamp(1.0 - (rawOverround - 1.0), 0.5, 1.0);
    const fairImp = powerMethodVigRemoval(adjHome, adjDraw, adjAway);

    // Match context flags
    const query_lc = String(fetched.query ?? "").toLowerCase();
    const comp_lc = String(fetched.competition ?? "").toLowerCase();
    const isCupFixture = /cup|fa cup|copa|coupe|pokal|coppa|league cup|carabao|efa/i.test(
      `${comp_lc} ${query_lc}`
    );
    const tierMap: Record<string, number> = {
      "premier league": 1,
      "la liga": 1,
      "serie a": 1,
      bundesliga: 1,
      "ligue 1": 1,
      "champions league": 0,
      eredivisie: 2,
      championship: 2,
      "league one": 3,
      "league two": 4,
      "scottish premiership": 2,
      default: 2,
    };
    const cupTierGap = Math.abs(
      (tierMap[String(fetched.homeLeague ?? "").toLowerCase()] ?? 2) -
        (tierMap[String(fetched.awayLeague ?? "").toLowerCase()] ?? 2)
    );
    const rotationalChanges = safeNum(fetched.rotationalChanges, 0);
    const isKnockout = /knockout|k\.o\.|final|semi.final|quarter.final/i.test(
      `${comp_lc} ${query_lc}`
    );
    const tierEquality = cupTierGap <= 1;

    // Layer 1: Expert Alpha
    const rawXH = xH_raw || lp.homeAvg * (piH / 1500);
    const rawXA = xA_raw || lp.awayAvg * (piA / 1500);
    const adjH = adjustXGForSoS(rawXH, p(tel.oppGA_A, lp.avgGA), lp.avgGA);
    const adjA = adjustXGForSoS(rawXA, p(tel.oppGA_H, lp.avgGA), lp.avgGA);
    let rawInjH = p(tel.injPenH, 0);
    if (rawInjH > 1) rawInjH /= 100;
    let rawInjA = p(tel.injPenA, 0);
    if (rawInjA > 1) rawInjA /= 100;
    const env = applyEnvironmentalPenalties(
      adjH * (1 - clamp(rawInjH, 0, 0.95)),
      adjA * (1 - clamp(rawInjA, 0, 0.95)),
      fetched.weather as Weather | null,
      fetched.referee as Referee | null
    );
    const fat = applyFatigueDecay(restH, restA, env.lH, env.lA);
    const trav = applyTravelFriction(travelKm, altitudeM, fat.lA);

    let cupsetLH = fat.lH,
      cupsetLA = trav.lA;
    if (isCupFixture && cupTierGap >= 2 && rotationalChanges >= 5) {
      cupsetLH *= 0.65;
      cupsetLA *= 0.65;
    }

    // §8.1 A/B flag: bivariate Poisson models correlation via λ3 (no DC rho correction applied).
    const _buildCoreMat: (lh: number, la: number, rho: number) => Matrix =
      (cfg.useBivariatePoisson ?? false)
        ? (lh, la) => buildBivariateMatrix(lh, la, DEFAULT_BIVARIATE_LAMBDA3)
        : (lh, la, rho) => buildMatrix(lh, la, rho);

    const matAlpha = _buildCoreMat(Math.max(0.1, cupsetLH), Math.max(0.1, cupsetLA), lp.baseRho);

    // Layer 1b: Elo-grade
    const eloWinP = 1 / (1 + 10 ** (-(piH - piA) / 400));
    const matElo = _buildCoreMat(
      Math.max(0.1, lp.homeAvg * (0.6 + 0.8 * eloWinP)),
      Math.max(0.1, lp.awayAvg * (0.6 + 0.8 * (1 - eloWinP))),
      lp.baseRho
    );

    // Layer 2: Expert Beta
    const piDiffLog = (piH - piA) / 400,
      mScore = p(tel.motivationScore, 1.0);
    let lH_Beta = lp.homeAvg * 10 ** (piDiffLog / 2) * mScore;
    let lA_Beta = lp.awayAvg * 10 ** (-piDiffLog / 2);
    if (tel.isDerby) {
      const avg = (lH_Beta + lA_Beta) / 2;
      lH_Beta = lH_Beta * 0.8 + avg * 0.2;
      lA_Beta = lA_Beta * 0.8 + avg * 0.2;
    }
    const matBeta = _buildCoreMat(Math.max(0.1, lH_Beta), Math.max(0.1, lA_Beta), lp.baseRho);

    // Layer 3: Expert Gamma (Market Velocity)
    const lmuHome = lstmMarketDecoderProxy(
      0.5,
      ohO,
      homeOdds,
      isPopularTeam(String(fixture.home ?? ""))
    );
    const lmuAway = lstmMarketDecoderProxy(
      0.3,
      p(tel.oaO, awayOdds),
      awayOdds,
      isPopularTeam(String(fixture.away ?? ""))
    );
    const velH = 1 / homeOdds - 1 / ohO;
    const boostH = velH > 0 ? velH * 1.5 : 0,
      penaltyH = velH < 0 ? Math.abs(velH) * 2.0 : 0;
    const _quarantineGamma = cfg.quarantineMarketVelocity ?? false;
    const matGamma = _buildCoreMat(
      Math.max(0.1, lp.homeAvg * (1 + boostH) * Math.max(0, 1 - penaltyH)),
      Math.max(0.1, lp.awayAvg),
      lp.baseRho
    );

    // Layer 4: ZIP
    const totalXGzip = Math.max(0.1, fat.lH) + Math.max(0.1, trav.lA);
    const zipPi = cfg.enableCalibratedZip
      ? calibratedZipPi(
          Math.max(0.1, fat.lH),
          Math.max(0.1, trav.lA),
          ledger?.metrics?.zipCoeffs as ZipCoeffs | null | undefined
        )
      : clamp(1 / (1 + Math.exp(-(-2.8 + 4.2 * totalXGzip))), 0.03, 0.18);
    const matZIP = buildMatrix(
      Math.max(0.1, fat.lH),
      Math.max(0.1, trav.lA),
      lp.baseRho,
      true,
      zipPi
    );

    // Ensemble fusion
    const calibFactor = ledger?.metrics?.calibFactor ?? 1.0;
    const calibDeficit = clamp(1.0 - calibFactor, 0, 0.3);
    const eloBoost = 0.03 + calibDeficit * 0.2;
    const _provReg = detectLowScoringRegime(
      matAlpha,
      Math.max(0.1, cupsetLH),
      Math.max(0.1, cupsetLA)
    );
    const wZIP = _provReg.regime === "LOW_SCORING" ? (cfg.lowScoreZipWeight ?? 0.08) : 0.08;
    const wA_base = (tel.xgMode === "empirical" ? (cfg.xgPrimaryWeight ?? 0.4) : 0.35) - eloBoost;
    const wElo = eloBoost,
      wB = 0.27;
    const wC = _quarantineGamma ? 0 : Math.max(0, 1 - wA_base - eloBoost - wB - wZIP);
    const wA_eff = _quarantineGamma
      ? wA_base + Math.max(0, 1 - wA_base - eloBoost - wB - wZIP)
      : wA_base;

    const finalMat: Matrix = matAlpha.map((row, i) =>
      row.map(
        (cell, j) =>
          cell * wA_eff +
          (matElo[i]?.[j] ?? 0) * wElo +
          (matBeta[i]?.[j] ?? 0) * wB +
          (matZIP[i]?.[j] ?? 0) * wZIP +
          (matGamma[i]?.[j] ?? 0) * wC
      )
    );
    let fSum = 0;
    finalMat.forEach((r) => r.forEach((v) => (fSum += v)));
    if (fSum > 0)
      finalMat.forEach((r, i) =>
        r.forEach((v, j) => {
          finalMat[i]![j] = v / fSum;
        })
      );

    const finalMkt = extractMarkets(finalMat);
    let fp = { home: finalMkt.hw, draw: finalMkt.dr, away: finalMkt.aw };
    let eHg = 0,
      eAg = 0;
    const N = finalMat.length;
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        eHg += i * (finalMat[i]?.[j] ?? 0);
        eAg += j * (finalMat[i]?.[j] ?? 0);
      }

    const mc: VarianceResult = monteCarlo(eHg, eAg, dynamicRho ?? lp.baseRho, mcRuns);

    // Low-scoring regime + AH pivot
    const lowScoreRegime: RegimeReport = detectLowScoringRegime(finalMat, eHg, eAg);
    let ahPivot: AhPivotResult | null = null;
    if (lowScoreRegime.regime === "LOW_SCORING") {
      const leagueAcc =
        (ledger?.metrics?.ahAccuracy as Record<string, Record<string, number>> | undefined)?.[
          league
        ] ?? {};
      ahPivot = asianHandicapPivot(finalMat, lowScoreRegime, leagueAcc);
    }

    // §8.2 Skellam cross-check — divergence flag + 20% blend when Skellam agrees (maxDiv < 0.05)
    let skellamCrossCheck: {
      probs: typeof fp;
      maxDivergence: number;
      ahCoverMinus05: number;
    } | null = null;
    if (cfg.useSkellam ?? false) {
      const skProbs = skellamProbs(eHg, eAg);
      const maxDiv = Math.max(
        Math.abs(fp.home - skProbs.home),
        Math.abs(fp.draw - skProbs.draw),
        Math.abs(fp.away - skProbs.away)
      );
      skellamCrossCheck = {
        probs: skProbs,
        maxDivergence: parseFloat(maxDiv.toFixed(4)),
        ahCoverMinus05: parseFloat(skellamAHCover(eHg, eAg, -0.5).toFixed(4)),
      };
      // §8.2b blend: when Skellam and matrix agree (low divergence), nudge fp toward Skellam
      if (maxDiv < 0.05) {
        const w = 0.2;
        const bH = (1 - w) * fp.home + w * skProbs.home;
        const bD = (1 - w) * fp.draw + w * skProbs.draw;
        const bA = (1 - w) * fp.away + w * skProbs.away;
        const bt = bH + bD + bA;
        fp = { home: bH / bt, draw: bD / bt, away: bA / bt };
      }
    }

    // §8.4 Isotonic calibration — post-hoc PAVA fit on resolved bets (no-op if < 30 resolved)
    fp = isotonicCalibrateFp(fp, (ledger?.bets ?? []) as Parameters<typeof isotonicCalibrateFp>[1]);

    const councilPenalty =
      (fetched.oracle_council as { penalty_active?: boolean } | undefined)?.penalty_active ===
        true ||
      (fetched.council as { penalty_active?: boolean } | undefined)?.penalty_active === true;
    const globalVelocity = Math.min(lmuHome.velocity, lmuAway.velocity, 0);

    const pinHome = p((rawOddsPay?.pinnacle as Record<string, number> | undefined)?.home, homeOdds);
    const sharpConsensusHome = p(
      (rawOddsPay?.sharp_consensus as Record<string, number> | undefined)?.home,
      pinHome
    );
    const squareHome = p(
      (rawOddsPay?.bet365 as Record<string, number> | undefined)?.home,
      homeOdds
    );
    const sharpDelta = sharpConsensusHome - squareHome;

    const rlmDetected = lmuHome.rlm || lmuAway.rlm;
    const steamDetected = lmuHome.steam || lmuAway.steam;
    const sharpCompressionTag =
      lmuHome.sharpCompression ||
      lmuAway.sharpCompression ||
      fetched.sharp_compression_detected === true;
    const marketSuspended = fetched.market_suspended === true;
    const lineupUnconfirmed = !(
      (fetched.starting_xi as { confirmed?: boolean } | undefined)?.confirmed === true
    );

    // Upset score
    let upsetScore = 0;
    if (sharpDelta > 0.05) upsetScore += 4;
    const isHomeFav = eHg > eAg + 0.3,
      isAwayFav = eAg > eHg + 0.3;
    if (isHomeFav && restH < restA - 2) upsetScore += 3;
    else if (isAwayFav && restA < restH - 2) upsetScore += 3;
    if (isHomeFav && xH_raw > 0 && xH_raw < lp.homeAvg * 0.8) upsetScore += 2;
    if (isAwayFav && xA_raw > 0 && xA_raw < lp.awayAvg * 0.8) upsetScore += 2;
    if (tel.isDerby) upsetScore += 3;
    const upsetAlertVeto =
      isHomeFav && upsetScore >= 8 ? "home" : isAwayFav && upsetScore >= 8 ? "away" : null;

    const ahAsymmetryWarning = Math.abs(eHg - eAg - (fairImp.home - fairImp.away) * 3.0) > 0.85;

    // analysis1x2
    type Outcome3 = "home" | "draw" | "away";
    const analysis1x2 = (["home", "draw", "away"] as Outcome3[]).map((out) => {
      const mp = fp[out],
        finalEdge = mp - fairImp[out]!;
      const odds = out === "home" ? homeOdds : out === "draw" ? drawOdds : awayOdds;
      const ev = adjEV(mp, odds),
        cbTripped = mc.varFlag && ev > 0;
      const velocity = out === "home" ? lmuHome.velocity : out === "draw" ? 0 : lmuAway.velocity;
      const proxVetoHome = hoursToKO < 1.5 && lmuHome.velocity < -0.02;
      const sentinelVeto =
        (finalEdge > 0 && velocity < -0.08) ||
        (out === "home" && proxVetoHome) ||
        upsetAlertVeto === out;
      const mesVeto = mes < 0.85 && finalEdge < 0.08;
      const hasEV =
        ev > 0 && finalEdge >= Math.max(0.1, hurdle(mp)) && !cbTripped && !sentinelVeto && !mesVeto;
      const stake = hasEV
        ? optimizedKelly(
            finalEdge,
            odds,
            dqs,
            councilPenalty,
            mc.varMultiplier,
            drawdownPenaltyFinal,
            calibFactor,
            0.25,
            mp
          )
        : 0;
      return {
        outcome: out,
        mp,
        ip: fairImp[out]!,
        ev,
        hasEV,
        stake,
        stakeAmt: stake * bankroll,
        cbTripped,
        sentinelVeto,
        mesVeto,
        proximateVeto: out === "home" && proxVetoHome,
        upsetVeto: upsetAlertVeto === out,
        odds,
      };
    });

    // Expected scoreline
    let maxProb = 0,
      expectedScoreline = "0-0";
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        if ((finalMat[i]?.[j] ?? 0) > maxProb) {
          maxProb = finalMat[i]?.[j]!;
          expectedScoreline = `${i}-${j}`;
        }
      }

    // CLV projection
    const ll =
      (
        {
          "Premier League": 1.3,
          "Champions League": 1.2,
          "La Liga": 1.1,
          Bundesliga: 1.0,
        } as Record<string, number>
      )[league] ?? 0.7;
    const _clvProjection = clvProjection(
      Math.abs(finalMkt.hw - fairImp.home),
      hoursToKO,
      finalMkt.hw > 0.45 ? "1x2" : "AH",
      ll
    );
    const ou25Val = oddsData["over_2.5"] ?? oddsData.over_2_5;
    const lambdaCheck = ou25Val
      ? checkLambdaInconsistency(eHg, eAg, 1 / ou25Val)
      : { inconsistent: false, divergence: 0 };
    const drawCalibFactor = drawCalibrationFactor(
      finalMkt.dr,
      (LEAGUE_PARAMS[league] ?? LEAGUE_PARAMS.Default!).drawRate
    );

    const oddsAvailable = Object.keys(oddsData).some((k) => !["home", "draw", "away"].includes(k));

    const rawRes: RunResult = {
      ...fixture,
      bayesian_lH: eHg,
      bayesian_lA: eAg,
      fp,
      fairImp,
      mat: finalMat,
      mc,
      analysis1x2,
      portfolioCorrelation: null,
      correlatedParlayRisk: null,
      sharpDelta,
      councilPenalty,
      mes,
      rlmDetected,
      steamDetected,
      sharpCompressionTag,
      marketSuspended,
      ahAsymmetryWarning,
      drawdownPenalty,
      dqs,
      isArbitrage,
      rawOverround,
      timeDecayInfo,
      timeDecayMultiplier: timeDecayInfo,
      oddsShiftWeightH: boostH,
      oddsShiftWeightA: 0,
      hoursToKO,
      upsetAlertVeto,
      council: fetched.council,
      lineupUnconfirmed,
      clvProjection: _clvProjection,
      lambdaInconsistency: lambdaCheck,
      drawCalibFactor,
      lmuHome,
      lmuAway,
      ledger,
      bestML: analysis1x2.filter((a) => a.hasEV).sort((a, b) => b.ev - a.ev)[0] ?? null,
      syntheticScripts: generateSyntheticAlpha(finalMat),
      ame: marketMakerPrice({
        home: fixture.home,
        away: fixture.away,
        fp,
        bayesian_lH: eHg,
        bayesian_lA: eAg,
        finalMkt,
      }),
      shapExplanation: [
        {
          name: "Layer 1: Expert Alpha (Fundamentals + SoS + Env + Fatigue + Injuries)",
          pct: wA_eff * 100,
          color: "#10b981",
        },
        {
          name: "Layer 1b: Ensemble Elo-Grade (Pi Rating Logistic — Long-Run Form)",
          pct: wElo * 100,
          color: "#34d399",
        },
        {
          name: "Layer 2: Expert Beta (ELO Class + Motivation + Derby)",
          pct: wB * 100,
          color: "#a78bfa",
        },
        {
          name: _quarantineGamma
            ? "Layer 3: Market Velocity (QUARANTINED)"
            : "Layer 3: Expert Gamma (Market Velocity + RLM)",
          pct: wC * 100,
          color: "#0ea5e9",
        },
        {
          name: "Layer 4: ZIP Model (Zero-Inflated Poisson — Defensive Specialist)",
          pct: wZIP * 100,
          color: "#f59e0b",
        },
      ],
      fetched,
      expectedScoreline,
      timestamp: Date.now(),
      xgConfidenceFlag,
      xgConfidenceMod,
      xgConfidence: _xgConf,
      xgSourcesCount: _xgSrc,
      adaptiveRegime: _adaptiveRegime,
      leeConstraint: _leeConstraint,
      klSignal: klDivergence(fp, {
        home: 1 / homeOdds / rawOverround,
        draw: 1 / drawOdds / rawOverround,
        away: 1 / awayOdds / rawOverround,
      }),
      efficiencySignal: normalizedEfficiency(
        homeOdds,
        drawOdds,
        awayOdds,
        fp.home,
        fp.draw,
        fp.away
      ),
      lowScoreRegime,
      ahPivot,
      skellamCrossCheck,
      isCupFixture,
      isKnockout,
      tierEquality,
      evMarkets: [],
      oddsAvailable,
    };

    rawRes.evMarkets = this.scanMarkets(
      finalMkt,
      fp,
      calibFactor,
      bankroll,
      dqs,
      oddsData,
      councilPenalty,
      mc.varMultiplier,
      drawdownPenalty,
      mes,
      globalVelocity,
      hoursToKO,
      upsetAlertVeto
    );

    // Steam chaser veto
    rawRes.evMarkets = rawRes.evMarkets.map((m) =>
      isSteamChaser(sharpCompressionTag, m.ev)
        ? { ...m, veto: "STEAM_CHASER_VETO", stake: 0, stakeAmt: 0 }
        : m
    );

    // Portfolio covariance + correlated parlay hard cap (BUG-M05 FIX)
    if (!skipSensitivity && rawRes.evMarkets.length >= 2) {
      let maxRho = 0;
      const penalties = new Array<number>(rawRes.evMarkets.length).fill(1.0);
      const correlatedPairs: Array<{ a: string; b: string; rho: number }> = [];
      const vetoSet = new Set<number>();
      for (let i = 0; i < rawRes.evMarkets.length - 1; i++) {
        // Already-vetoed/non-positive-EV markets can never be selected downstream
        // regardless of correlation — skip the whole inner loop for them rather
        // than computing O(n) correlation pairs that are discarded either way.
        if (rawRes.evMarkets[i]?.veto || (rawRes.evMarkets[i]?.ev ?? 0) <= 0) continue;
        for (let j = i + 1; j < rawRes.evMarkets.length; j++) {
          if (rawRes.evMarkets[j]?.veto || (rawRes.evMarkets[j]?.ev ?? 0) <= 0) continue;
          const rho = CorrelationMatrix.compute(
            finalMat,
            rawRes.evMarkets[i]?.label,
            rawRes.evMarkets[j]?.label
          );
          if (rho > 0.1) {
            maxRho = Math.max(maxRho, rho);
            const pen = 1 / (1 + rho);
            penalties[i] = Math.min(penalties[i]!, pen);
            penalties[j] = Math.min(penalties[j]!, pen);
          }
          if (rho > 0.7) {
            correlatedPairs.push({
              a: rawRes.evMarkets[i]?.label,
              b: rawRes.evMarkets[j]?.label,
              rho: parseFloat(rho.toFixed(3)),
            });
            vetoSet.add((rawRes.evMarkets[i]?.ev ?? 0) >= (rawRes.evMarkets[j]?.ev ?? 0) ? j : i);
          }
        }
      }
      for (let i = 0; i < rawRes.evMarkets.length; i++) {
        if (vetoSet.has(i)) {
          rawRes.evMarkets[i]!.stake = 0;
          rawRes.evMarkets[i]!.stakeAmt = 0;
          rawRes.evMarkets[i]!.veto = "CORRELATED_PARLAY_VETO";
        } else {
          rawRes.evMarkets[i]!.stakeAmt *= penalties[i]!;
          rawRes.evMarkets[i]!.stake *= penalties[i]!;
        }
      }
      rawRes.portfolioCorrelation = maxRho;
      rawRes.correlatedParlayRisk = correlatedPairs;
    }

    if (!skipSensitivity) rawRes.sensitivity = await this._sensitivityAnalyze(state, rawRes);

    rawRes.debate = new AntiSycophancyCircuit().execute(
      rawRes as unknown as Record<string, unknown>
    );

    const rag = new RAGSystem(this._storage);
    await rag.init();
    const ragSimilar = rag.findSimilar(rawRes as unknown as Record<string, unknown>, 5);
    rawRes.convergence = new ConvergenceScorer().compute(
      rawRes as unknown as Record<string, unknown>,
      ragSimilar as unknown as Record<string, unknown>[]
    );
    rawRes.mlFilter = new MLSafetyFilter().evaluate(
      fetched as Record<string, unknown>,
      rawRes as unknown as Record<string, unknown>,
      tel as Record<string, unknown>
    );

    await rag.addToStore(rawRes as unknown as Record<string, unknown>, {
      evMarkets: rawRes.evMarkets,
      debate: rawRes.debate,
      expectedScoreline,
      home: fixture.home,
      away: fixture.away,
    });

    // Apply ranking mode to evMarkets
    const mode = cfg.rankingMode ?? "CONFIDENCE_WEIGHTED";
    rawRes.evMarkets = applyRankingMode(rawRes.evMarkets, mode);

    return rawRes;
  }

  // ── Public static factory ─────────────────────────────────────────────────

  static async run(
    state: RunState,
    deps: { storage: StoragePort; config: OracleConfig }
  ): Promise<RunResult> {
    const engine = new ExecutionEngine(deps.config, deps.storage);
    return engine._run(state);
  }
}

// Keep ExecutionResult as a compat alias so engine/src/index.ts export still resolves
export type ExecutionResult = RunResult;

export { applyRankingMode };
