/** Safety module — ported from ORACLE_v2026_8_0.jsx §8b/8c/§10, lines 2359-2990, 3349-4002.
 *  Rewrite #2: window.__ORACLE_CORE__ → injected config/llmKey param. */
import { clamp } from "../math/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConvergenceTier {
  min: number;
  max: number;
  label: "APEX" | "PRIME" | "VIABLE" | "MARGINAL" | "NOISE";
  kelly: string;
}

export interface SignalMap extends Record<string, number | string | undefined> {
  S01?: number;
  S02?: number;
  S03?: number;
  S04?: number;
  S05?: number;
  S06?: number;
  S07?: number;
  S08?: number;
  S09?: number;
  S10?: number;
  S11?: number;
  S12?: number;
  S13?: number;
  S14?: number;
  _survivorshipBiasWarning?: string;
  _impliedEvFlag?: string;
}

export interface MarketConvergenceResult {
  market: string;
  odds: number;
  signals: SignalMap;
  totalScore: number;
  softmaxProb: number;
  tier: ConvergenceTier;
  activeSignals: string[];
  missedSignals: string[];
  apexReason: string;
  negativeEvAlert: string | null;
}

export interface ConvergenceResult {
  apex: MarketConvergenceResult | null;
  scores: MarketConvergenceResult[];
  overallTier: ConvergenceTier;
  deploymentGuide: string;
  noConvergence: boolean;
  runnerUp: MarketConvergenceResult | null;
  skipList: string[];
  dispersionWarning: string | null;
  negativeEvAlert: string | null;
}

export interface MLSafetyResult {
  mlAllowed: boolean;
  safetyScore: number;
  filtersTotal: number;
  filtersPassed: number;
  confidence: string;
  reason: string | null;
  altMarkets: string[];
  drawRisk: DrawRisk;
}

export interface DrawRisk {
  score: number;
  tier: "EXTREME" | "VERY_HIGH" | "HIGH" | "MODERATE" | "LOW";
  drawAdjustment: number;
  mlBlocked: boolean;
}

export interface AntiSycophancyResult {
  agreed: boolean;
  objection?: string;
}

// ── ConvergenceScorer ─────────────────────────────────────────────────────────

const TIERS: ConvergenceTier[] = [
  { min: 18, max: 23, label: "APEX", kelly: "Full Kelly — maximum deployment" },
  { min: 13, max: 17, label: "PRIME", kelly: "Full Kelly — strong deployment" },
  { min: 8, max: 12, label: "VIABLE", kelly: "Half Kelly — proceed with discipline" },
  { min: 4, max: 7, label: "MARGINAL", kelly: "Quarter Kelly or pass" },
  { min: 0, max: 3, label: "NOISE", kelly: "Do not bet — signal too thin" },
];

export class ConvergenceScorer {
  getTier(score: number): ConvergenceTier {
    return TIERS.find((t) => score >= t.min && score <= t.max) ?? TIERS[4]!;
  }

  scoreMarket(
    market: Record<string, unknown>,
    resData: Record<string, unknown>,
    ragSimilar: Array<Record<string, unknown>> = []
  ): MarketConvergenceResult {
    const signals: SignalMap = {};
    const mp = (market.mp ?? market.modelProb ?? 0) as number;
    const ip = (market.ip ??
      ((market.odds as number) > 1 ? 1 / (market.odds as number) : 0)) as number;
    const ev = (market.ev ?? 0) as number;

    signals.S01 = Math.abs(mp - ip) > 0.08 ? 3 : 0;
    const frozenPayload = (resData.frozenOdds as Record<string, unknown> | null) ?? null;
    const sharpCount = ((frozenPayload?.sharp_consensus as Record<string, number> | undefined)
      ?.bookCount ?? 0) as number;
    const crowdRoundBias =
      (resData.crowdWisdom as Record<string, unknown> | undefined)?._crowdRoundingBias === true;
    signals.S02 = sharpCount >= 3 ? (crowdRoundBias ? 4 : 3) : 0;
    signals.S03 = resData.rlmDetected && !resData.sharpCompressionTag ? 2 : 0;
    signals.S04 = resData.sharpCompressionTag && !resData.rlmDetected ? 2 : 0;
    signals.S05 =
      ((resData.clvProjection as Record<string, number> | undefined)?.survivalProb ?? 0) > 0.7
        ? 1
        : 0;
    const adjEv = Math.max(0, ev - 0.05);
    signals.S06 = adjEv > 0.09 ? 2 : 0;
    signals.S07 = mp >= 0.75 ? 2 : 0;
    const debate = resData.debate as Record<string, unknown> | undefined;
    const marketId = market.id as string | undefined;
    const advCritique = (
      debate?.adversary as { critiques?: Array<Record<string, unknown>> } | undefined
    )?.critiques?.find((c) => c.id === marketId);
    const refVerdict = (
      debate?.referee as { verdicts?: Array<Record<string, unknown>> } | undefined
    )?.verdicts?.find((v) => v.id === marketId);
    signals.S08 =
      advCritique?.decision === "ACCEPT" && String(refVerdict?.verdict ?? "").includes("+EV")
        ? 2
        : 0;
    const calibFactor =
      (
        (resData.ledger as Record<string, unknown> | undefined)?.metrics as
          | Record<string, number>
          | undefined
      )?.calibFactor ??
      (resData.calibFactor as number | undefined) ??
      1.0;
    signals.S09 = calibFactor > 1.0 ? 1 : 0;
    const bestAnalogue = ragSimilar[0];
    const HIGH_PROFILE = new Set([
      "Premier League",
      "Champions League",
      "La Liga",
      "Bundesliga",
      "Serie A",
    ]);
    const top5Leagues = ragSimilar
      .slice(0, 5)
      .map((a) => String(a.league ?? ""))
      .filter(Boolean);
    const survivorshipBiased =
      top5Leagues.length >= 4 && top5Leagues.every((l) => HIGH_PROFILE.has(l));
    signals.S10 =
      ((bestAnalogue?.similarity as number) ?? 0) >= 0.8 &&
      bestAnalogue?.sameCategoryAsQuery &&
      !survivorshipBiased
        ? 1
        : 0;
    if (survivorshipBiased)
      signals._survivorshipBiasWarning =
        "[SURVIVORSHIP_BIAS_SAMPLE] RAG analogues drawn exclusively from high-profile leagues";
    // S11: CrowdWisdom — no window access; use injected resData crowdWisdom
    const cwPayload = resData.crowdWisdom as Record<string, unknown> | undefined;
    const cwAligns =
      cwPayload &&
      !cwPayload._aborted &&
      ((cwPayload.confidenceScore as number) ?? 0) > 0.6 &&
      String(market.label ?? "")
        .toLowerCase()
        .includes(String(cwPayload.dominantOutcome ?? "").toLowerCase());
    signals.S11 = cwAligns ? 1 : 0;
    const outcome = String(market.label ?? "").includes("Home")
      ? "home"
      : String(market.label ?? "").includes("Away")
        ? "away"
        : "draw";
    const fpProb = (resData.fp as Record<string, number> | undefined)?.[outcome] ?? 0;
    signals.S12 =
      fpProb > ip && ((resData.mc as Record<string, number> | undefined)?.varMultiplier ?? 0) > 0.8
        ? 1
        : 0;
    signals.S13 = !resData.marketSuspended && ((resData.hoursToKO as number) ?? 24) > 1.5 ? 1 : 0;
    const evExcess = ip - mp;
    if (evExcess > 0.05) {
      signals.S14 = 0;
    } else if (evExcess > 0.03) {
      signals.S14 = 0;
      signals._impliedEvFlag = `[IMPLIED_EV_FLAG] Implied ${(ip * 100).toFixed(1)}% vs model ${(mp * 100).toFixed(1)}%`;
    } else {
      signals.S14 = 1;
    }
    const negativeEvAlert =
      evExcess > 0.05
        ? `[NEGATIVE_EV_ALERT] Implied ${(ip * 100).toFixed(1)}% exceeds model ${(mp * 100).toFixed(1)}% — HARD REJECT.`
        : null;

    const totalScore = Math.round(
      Object.entries(signals)
        .filter(([k, v]) => typeof v === "number" && !k.startsWith("_"))
        .reduce((s, [, v]) => s + (v as number), 0)
    );
    const tier = this.getTier(totalScore);
    const activeSignals = Object.entries(signals)
      .filter(([, v]) => v === 1 || (typeof v === "number" && v > 0))
      .map(([k]) => k);
    const missedSignals = Object.entries(signals)
      .filter(([, v]) => v === 0)
      .map(([k]) => k);
    const softmaxProb = 1 / (1 + Math.exp(-totalScore / 8));
    const heavy = activeSignals.filter((s) => ["S01", "S02", "S06", "S07", "S08"].includes(s));
    const apexReason =
      heavy.length === 0
        ? `${activeSignals.slice(0, 3).join(", ")} providing baseline confidence`
        : `${heavy.join(" + ")} driving primary edge`;

    return {
      market: String(market.label ?? market.market ?? ""),
      odds: market.odds as number,
      signals,
      totalScore,
      softmaxProb,
      tier,
      activeSignals,
      missedSignals,
      apexReason,
      negativeEvAlert,
    };
  }

  compute(
    resData: Record<string, unknown>,
    ragSimilar: Array<Record<string, unknown>> = []
  ): ConvergenceResult {
    const candidates = [
      ...((resData.evMarkets as Array<Record<string, unknown>> | undefined) ?? []).filter(
        (m) => !m.veto && (m.ev as number) > 0
      ),
    ];
    const noResult = (noConvergence: boolean): ConvergenceResult => ({
      apex: null,
      scores: [],
      overallTier: this.getTier(0),
      deploymentGuide: "⛔ NO CONVERGENCE — FIXTURE DOES NOT MEET DEPLOYMENT THRESHOLD",
      noConvergence,
      runnerUp: null,
      skipList: [],
      dispersionWarning: null,
      negativeEvAlert: null,
    });
    if (candidates.length === 0) return noResult(true);
    const scores = candidates.map((m) => this.scoreMarket(m, resData, ragSimilar));
    scores.sort((a, b) => b.totalScore - a.totalScore);
    const apex = scores[0]!;
    const overallTier = this.getTier(apex.totalScore);
    const skipList = scores
      .filter((s) => s.totalScore < 8)
      .map((s) => `${s.market} (${s.totalScore}/24)`);
    const noConvergence = apex.totalScore < 8;
    const runnerUpScore = scores[1]?.totalScore ?? 0;
    const dispersionWarning =
      apex.totalScore - runnerUpScore <= 3 && scores.length > 1
        ? "[LOW_DISCRIMINATION] APEX margin ≤3 points over runner-up"
        : null;
    const negEvAlert = scores.find((s) => s.negativeEvAlert)?.negativeEvAlert ?? null;
    let deploymentGuide = "";
    if (noConvergence) {
      deploymentGuide = "⛔ NO CONVERGENCE — FIXTURE DOES NOT MEET DEPLOYMENT THRESHOLD TODAY";
    } else if (overallTier.label === "APEX" || overallTier.label === "PRIME") {
      deploymentGuide = `${overallTier.label} — Deploy full ORACLE Kelly stake on ${apex.market}`;
    } else if (overallTier.label === "VIABLE") {
      deploymentGuide = `VIABLE — Halve the ORACLE Kelly stake on ${apex.market}`;
    } else {
      deploymentGuide = `MARGINAL — Quarter Kelly or consider passing`;
    }
    return {
      apex,
      scores,
      overallTier,
      deploymentGuide,
      noConvergence,
      runnerUp: scores[1] ?? null,
      skipList,
      dispersionWarning,
      negativeEvAlert: negEvAlert,
    };
  }
}

// ── MLSafetyFilter ────────────────────────────────────────────────────────────

const HIGH_RELIABILITY = new Set([
  "bundesliga",
  "eredivisie",
  "scottish premiership",
  "austrian bundesliga",
  "portuguesa primeira liga",
  "primeira liga",
  "belgian pro league",
  "champions league",
  "europa league",
  "fifa world cup",
]);
const HIGH_UPSET = new Set([
  "serie a",
  "la liga",
  "ligue 1",
  "championship",
  "mls",
  "major league soccer",
  "liga mx",
  "french ligue 1",
  "spanish la liga",
  "italian serie a",
  "english championship",
]);

const LEAGUE_DRAW_RATES: Record<string, { drawRate: number; baseRho: number }> = {
  "Premier League": { baseRho: -0.13, drawRate: 0.245 },
  "La Liga": { baseRho: -0.16, drawRate: 0.28 },
  "Serie A": { baseRho: -0.18, drawRate: 0.295 },
  Bundesliga: { baseRho: -0.14, drawRate: 0.22 },
  "Champions League": { baseRho: -0.1, drawRate: 0.235 },
  "FIFA World Cup": { baseRho: -0.07, drawRate: 0.229 },
  Default: { baseRho: -0.13, drawRate: 0.25 },
};

export class MLSafetyFilter {
  evaluate(
    fetched: Record<string, unknown>,
    resData: Record<string, unknown>,
    telemetry: Record<string, unknown>
  ): MLSafetyResult {
    const filters: Array<{ id?: string; name: string; pass: boolean; reason: string }> = [];
    const stats = (fetched.stats ?? {}) as Record<string, number>;
    const odds = (fetched.odds ?? {}) as Record<string, number>;
    const league = String(resData.league ?? "").toLowerCase();

    const favOdds = Math.min(odds.home ?? 9, odds.away ?? 9);
    const favIsHome = (odds.home ?? 9) < (odds.away ?? 9);
    const oddsOk = favOdds >= 1.35 && favOdds <= 1.65;
    filters.push({ id: "S1", name: "Odds Range", pass: oddsOk, reason: `${favOdds}` });
    if (favOdds < 1.3 || favOdds > 1.7)
      return this._buildResult(
        filters,
        false,
        "HARD REJECT: odds outside range",
        resData,
        telemetry
      );

    const eloDiff = Math.abs((stats.home_pi_rating ?? 1500) - (stats.away_pi_rating ?? 1500));
    filters.push({
      id: "S2",
      name: "Team Strength Gap",
      pass: eloDiff >= 120,
      reason: `Elo diff: ${eloDiff.toFixed(0)}`,
    });

    const homeWinRate = stats.home_win_rate ?? 0;
    const homeAdvOk = favIsHome ? homeWinRate >= 0.6 || eloDiff >= 150 : eloDiff >= 180;
    filters.push({
      id: "S3",
      name: "Home Advantage",
      pass: homeAdvOk,
      reason: `Home win rate: ${(homeWinRate * 100).toFixed(0)}%`,
    });

    const favXG = favIsHome
      ? (stats.home_xg ?? (resData.bayesian_lH as number) ?? 0)
      : (stats.away_xg ?? (resData.bayesian_lA as number) ?? 0);
    const favGS = favIsHome ? (stats.home_goals_per_match ?? 0) : (stats.away_goals_per_match ?? 0);
    const _oppGC = favIsHome ? (stats.away_goals_conceded ?? 0) : (stats.home_goals_conceded ?? 0);
    filters.push({
      id: "S4",
      name: "Attacking Superiority",
      pass: favXG >= 1.7 && (favGS >= 1.6 || favXG >= 1.8),
      reason: `xG:${favXG.toFixed(2)}`,
    });

    const favGC = favIsHome ? (stats.home_goals_conceded ?? 0) : (stats.away_goals_conceded ?? 0);
    const cleanSheetPct = favIsHome
      ? (stats.home_clean_sheet_rate ?? 0)
      : (stats.away_clean_sheet_rate ?? 0);
    const defenceOk = (favGC <= 1.2 || eloDiff >= 200) && (cleanSheetPct >= 0.35 || eloDiff >= 180);
    filters.push({
      id: "S5",
      name: "Defensive Stability",
      pass: defenceOk,
      reason: `GC:${favGC.toFixed(2)}`,
    });

    const dogGS = favIsHome ? (stats.away_goals_per_match ?? 0) : (stats.home_goals_per_match ?? 0);
    filters.push({
      id: "S6",
      name: "Underdog Attack Limited",
      pass: dogGS <= 1.1 || eloDiff >= 200,
      reason: `Dog GS:${dogGS.toFixed(2)}`,
    });

    const bayesH = resData.bayesian_lH as number | undefined;
    const bayesA = resData.bayesian_lA as number | undefined;
    const totalXG = bayesH !== undefined && bayesA !== undefined ? bayesH + bayesA : undefined;
    // S7: only hard-reject when we have xG data AND it is genuinely low.
    // When sidecar-only (no sharp xG source), skip the gate rather than hard-reject on null.
    if (totalXG !== undefined) {
      const goalsEnvOk = totalXG >= 2.3 && totalXG <= 3.2;
      if (totalXG <= 2.1) {
        filters.push({
          id: "S7",
          name: "Goals Environment",
          pass: false,
          reason: `xG ${totalXG.toFixed(2)} ≤ 2.1 (HARD REJECT)`,
        });
        return this._buildResult(
          filters,
          false,
          "HARD REJECT: low-scoring environment",
          resData,
          telemetry
        );
      }
      filters.push({
        id: "S7",
        name: "Goals Environment 2.3–3.2",
        pass: goalsEnvOk,
        reason: `xG ${totalXG.toFixed(2)}`,
      });
    } else {
      filters.push({
        id: "S7",
        name: "Goals Environment",
        pass: true,
        reason: "xG unavailable — skipped",
      });
    }

    const favRest = (favIsHome ? (telemetry.restH ?? 7) : (telemetry.restA ?? 7)) as number;
    filters.push({
      id: "S8",
      name: "No Schedule Congestion",
      pass: favRest >= 5,
      reason: `Rest: ${favRest}d`,
    });

    const motivScore = (telemetry.motivationScore as number) ?? 1.0;
    filters.push({
      id: "S9",
      name: "Motivation Present",
      pass: motivScore >= 0.9,
      reason: `Motiv: ${motivScore.toFixed(2)}`,
    });

    const favVelocity =
      (favIsHome
        ? (resData.lmuHome as Record<string, number> | undefined)?.velocity
        : (resData.lmuAway as Record<string, number> | undefined)?.velocity) ?? 0;
    filters.push({
      id: "S10",
      name: "Market Movement",
      pass: favVelocity >= 0,
      reason: `Vel: ${favVelocity.toFixed(4)}`,
    });

    const isDerby = (telemetry.isDerby as boolean) ?? false;
    const keyInjury =
      ((telemetry.injPenH as number) ?? 0) > 0.25 || ((telemetry.injPenA as number) ?? 0) > 0.25;
    const badWeather =
      ((fetched.weather as Record<string, number> | undefined)?.wind_mph ?? 0) > 35 ||
      ((fetched.weather as Record<string, number> | undefined)?.rain_mm ?? 0) > 15;
    const newMgr =
      ((telemetry.newMgrH as boolean) ?? false) || ((telemetry.newMgrA as boolean) ?? false);
    const redFlagOk = !isDerby && !keyInjury && !badWeather && !newMgr;
    filters.push({
      id: "S11",
      name: "No Red Flags",
      pass: redFlagOk,
      reason:
        [isDerby && "Derby", keyInjury && "KeyInjury", badWeather && "Weather", newMgr && "NewMgr"]
          .filter(Boolean)
          .join(",") || "Clean",
    });
    if (!redFlagOk && (isDerby || keyInjury))
      return this._buildResult(
        filters,
        false,
        `HARD REJECT: ${isDerby ? "Derby" : "Key injury"}`,
        resData,
        telemetry
      );

    const trapCount = [
      totalXG !== undefined && totalXG <= 2.1,
      !favIsHome && eloDiff < 150,
      favRest < 4,
      motivScore < 0.8,
      isDerby,
    ].filter(Boolean).length;
    filters.push({
      id: "S12",
      name: "No Favorite Trap",
      pass: trapCount === 0,
      reason: `${trapCount} traps`,
    });

    const highRel = HIGH_RELIABILITY.has(league);
    const highUpset = HIGH_UPSET.has(league);
    filters.push({
      id: "S13",
      name: "High Reliability League",
      pass: highRel && !highUpset,
      reason: league,
    });
    if (highUpset)
      return this._buildResult(
        filters,
        false,
        `HARD REJECT: high-upset league`,
        resData,
        telemetry
      );

    // S16: only hard-reject when we have confirmed sharp-book data fading the selection.
    // When sharpDelta is absent (sidecar-only, no Odds API), skip rather than hard-reject.
    const rawSharpDelta = resData.sharpDelta as number | undefined;
    const sharpBooks = (resData.fetched as Record<string, unknown> | undefined)?.odds as
      | Record<string, unknown>
      | undefined;
    const sharpBookCount =
      (sharpBooks?.sharp_consensus as Record<string, number> | undefined)?.bookCount ?? 0;
    if (rawSharpDelta !== undefined) {
      if (rawSharpDelta > 0.1 && sharpBookCount >= 2) {
        filters.push({
          id: "S16",
          name: "Sharp Consensus",
          pass: false,
          reason: `Sharp fading (delta:${rawSharpDelta.toFixed(3)})`,
        });
        return this._buildResult(
          filters,
          false,
          "HARD REJECT: sharp books fading",
          resData,
          telemetry
        );
      }
      filters.push({
        id: "S16",
        name: "Sharp Consensus",
        pass: rawSharpDelta <= 0.03 || sharpBookCount < 2,
        reason: `Delta:${rawSharpDelta.toFixed(3)}`,
      });
    } else {
      filters.push({
        id: "S16",
        name: "Sharp Consensus",
        pass: true,
        reason: "sharp data unavailable — skipped",
      });
    }

    // S17: only hard-reject on confirmed miscalibration, not missing calibration data.
    const rawCalibFactor =
      (
        (resData.ledger as Record<string, unknown> | undefined)?.metrics as
          | Record<string, number>
          | undefined
      )?.calibFactor ?? (resData.calibFactor as number | undefined);
    if (rawCalibFactor !== undefined) {
      filters.push({
        id: "S17",
        name: "Model Calibration Gate",
        pass: rawCalibFactor >= 0.85,
        reason: `CF:${rawCalibFactor.toFixed(3)}`,
      });
      if (rawCalibFactor < 0.7)
        return this._buildResult(
          filters,
          false,
          "HARD REJECT: severe miscalibration",
          resData,
          telemetry
        );
    } else {
      filters.push({
        id: "S17",
        name: "Model Calibration Gate",
        pass: true,
        reason: "calibration data unavailable — skipped",
      });
    }

    return this._buildResult(filters, true, null, resData, telemetry);
  }

  private _buildResult(
    filters: Array<{ pass: boolean }>,
    eligible: boolean,
    hardRejectReason: string | null,
    resData: Record<string, unknown>,
    telemetry: Record<string, unknown>
  ): MLSafetyResult {
    const filtersPassed = filters.filter((f) => f.pass).length;
    const filtersTotal = filters.length;
    const pct = filtersTotal > 0 ? filtersPassed / filtersTotal : 0;
    let mlAllowed = eligible && pct >= 0.7;
    let confidence = "";
    if (!eligible || hardRejectReason) {
      mlAllowed = false;
      confidence = "HARD_REJECT";
    } else if (pct >= 0.85) confidence = "HIGH_CONFIDENCE";
    else if (pct >= 0.7) confidence = "MODERATE_CONFIDENCE";
    else {
      mlAllowed = false;
      confidence = "REJECTED";
    }
    const drawRisk = this._computeDrawRisk(resData, telemetry);
    if (drawRisk.mlBlocked) mlAllowed = false;
    return {
      mlAllowed,
      safetyScore: filtersPassed,
      filtersTotal,
      filtersPassed,
      confidence,
      reason: hardRejectReason,
      altMarkets: [],
      drawRisk,
    };
  }

  private _computeDrawRisk(
    resData: Record<string, unknown>,
    _telemetry: Record<string, unknown>
  ): DrawRisk {
    let score = 0;
    const lH = (resData.bayesian_lH as number) ?? 0;
    const lA = (resData.bayesian_lA as number) ?? 0;
    const league = String(resData.league ?? "");
    const lp = LEAGUE_DRAW_RATES[league] ?? LEAGUE_DRAW_RATES.Default!;
    const lambdaDiff = lH > 0 && lA > 0 ? Math.abs(lH - lA) / Math.max(lH, lA) : 0;
    if (lambdaDiff < 0.1) score += 15;
    else if (lambdaDiff < 0.2) score += 8;
    const totalXG = lH + lA;
    if (totalXG < 1.6) score += 15;
    else if (totalXG < 2.0) score += 8;
    else if (totalXG < 2.4) score += 4;
    score += Math.min(5, Math.round(Math.max(0, lp.drawRate - 0.24) * 100));
    const windMph = (resData.fetched as Record<string, unknown> | undefined)?.weather as
      | Record<string, number>
      | undefined;
    if ((windMph?.wind_mph ?? 0) > 35 || (windMph?.rain_mm ?? 0) > 15) score += 10;
    else if ((windMph?.wind_mph ?? 0) > 20 || (windMph?.rain_mm ?? 0) > 8) score += 5;
    const homeUnavailable = (resData.homeUnavailablePlayers as number) ?? 0;
    if (homeUnavailable >= 5 && homeUnavailable < 10) score += 8;
    if (homeUnavailable >= 10) score += 12;
    if (Math.abs(lp.baseRho ?? 0.13) > 0.15) score += 5;
    score = Math.min(100, score);
    const tier =
      score >= 81
        ? "EXTREME"
        : score >= 61
          ? "VERY_HIGH"
          : score >= 41
            ? "HIGH"
            : score >= 21
              ? "MODERATE"
              : "LOW";
    const drawAdjustment =
      score >= 81 ? 0.15 : score >= 61 ? 0.12 : score >= 41 ? 0.08 : score >= 21 ? 0.04 : 0;
    return { score, tier, drawAdjustment, mlBlocked: score >= 61 };
  }
}

// ── AntiSycophancyCircuit — full 3-agent deterministic pipeline ───────────────
// Ported from ORACLE_v2026_8_0.jsx §8d/§10 (lines 3349-3693).
// evFinderAgent: scores all +EV markets
// adversarialAgent: critiques each proposal with risk analysis
// refereeAgent: determines ground truth verdict per market
// All logic is deterministic. Phase 2 will wire LLM for the challenge() path.

import { getConfidenceBand } from "../math/index.js";

export class AntiSycophancyCircuit {
  evFinderAgent(resData: Record<string, unknown>): Record<string, unknown> {
    const proposed: Record<string, unknown>[] = [];

    const scoreMarket = (m: Record<string, unknown>): number => {
      const ev = (m.ev as number | undefined) ?? 0;
      const mp = (m.mp as number | undefined) ?? 0;
      const varFlag = (resData.mc as Record<string, unknown> | undefined)?.varFlag ?? false;
      let score = 0;
      if (ev > 0.15) score += 10;
      else if (ev > 0.08) score += 5;
      else if (ev > 0.03) score += 1;
      if (mp >= 0.75) score += 5;
      else if (mp >= 0.6) score += 3;
      if (varFlag) score -= 2;
      if (resData.rlmDetected) score += 3;
      if (resData.steamDetected) score += 2;
      if (resData.sharpCompressionTag) score += 2;
      const sovereignGap = Math.abs((mp ?? 0) - ((m.ip as number | undefined) ?? 0));
      if (sovereignGap > 0.08) score += 5;
      return Math.max(0, score);
    };

    for (const m of (resData.evMarkets as Array<Record<string, unknown>> | undefined) ?? []) {
      if (m.veto) continue;
      const score = scoreMarket(m);
      if (score <= 0) continue;
      const mp = (m.mp as number | undefined) ?? 0;
      const ip = (m.ip as number | undefined) ?? 0;
      const ev = (m.ev as number | undefined) ?? 0;
      const sovereignGap = Math.abs(mp - ip);
      proposed.push({
        id: `EV_${proposed.length + 1}`,
        market: m.market ?? m.label,
        label: m.label,
        odds: m.odds,
        modelProb: mp,
        edge: ev,
        stake: m.stake,
        stakeAmt: m.stakeAmt,
        score,
        impactLevel: score >= 10 ? "High Confidence" : score >= 5 ? "Medium Edge" : "Low Variance",
        reason: `+EV opportunity: ${(ev * 100).toFixed(1)}% edge, model prob ${(mp * 100).toFixed(1)}%${resData.rlmDetected ? " [TRUE RLM]" : ""}${resData.sharpCompressionTag ? " [SHARP_COMPRESSION]" : ""}${sovereignGap > 0.08 ? " [Sovereign gap >8%]" : ""}`,
        confidenceBand: getConfidenceBand(mp),
      });
    }

    for (const a of (resData.analysis1x2 as Array<Record<string, unknown>> | undefined) ?? []) {
      if (!(a.hasEV && ((a.ev as number) ?? 0) > 0)) continue;
      const m = {
        ev: a.ev as number,
        mp: a.mp as number,
        ip: a.ip as number,
        odds: a.odds as number,
      };
      const score = scoreMarket(m as Record<string, unknown>);
      if (score <= 0) continue;
      proposed.push({
        id: `1X2_${proposed.length + 1}`,
        market: `Match Winner: ${a.outcome}`,
        label: `Match Winner: ${a.outcome}`,
        odds: a.odds,
        modelProb: m.mp,
        edge: m.ev,
        stake: a.stake,
        stakeAmt: a.stakeAmt,
        score,
        impactLevel: score >= 10 ? "High Confidence" : score >= 5 ? "Medium Edge" : "Low Variance",
        reason: `1X2 +EV: ${(m.ev * 100).toFixed(1)}% edge on ${a.outcome}`,
        confidenceBand: getConfidenceBand(m.mp),
      });
    }

    proposed.sort((a, b) => (b.score as number) - (a.score as number));
    const top = proposed.slice(0, 12);
    return {
      agent: "EV-FINDER",
      mission: "Maximize score by finding ALL +EV opportunities",
      proposed: top,
      totalScore: top.reduce((s, b) => s + (b.score as number), 0),
      evFound: top.length,
      breakdown: {
        high: top.filter((b) => (b.score as number) >= 10).length,
        medium: top.filter((b) => (b.score as number) >= 5 && (b.score as number) < 10).length,
        low: top.filter((b) => (b.score as number) > 0 && (b.score as number) < 5).length,
      },
    };
  }

  adversarialAgent(
    resData: Record<string, unknown>,
    finderOutput: Record<string, unknown>
  ): Record<string, unknown> {
    const critiques: Record<string, unknown>[] = [];
    let totalScore = 0;
    let disprovedCount = 0;

    const analyzeRisks = (bet: Record<string, unknown>) => {
      const risks: string[] = [];
      let confidence = 100;
      let veto = false;
      const edge = (bet.edge as number | undefined) ?? 0;

      if ((resData.mc as Record<string, unknown> | undefined)?.varFlag && edge < 0.1) {
        risks.push(
          `High variance environment (varFlag=true) with only ${(edge * 100).toFixed(1)}% edge`
        );
        confidence -= 25;
      }
      if (resData.lineupUnconfirmed && ((resData.hoursToKO as number) ?? 24) < 3) {
        risks.push("Lineup unconfirmed < 3h to kickoff — significant xG uncertainty");
        confidence -= 20;
      }
      if (((resData.drawdownPenalty as number) ?? 1.0) < 1.0) {
        risks.push(
          `Drawdown penalty active — bankroll in protective mode (${((1 - (resData.drawdownPenalty as number)) * 100).toFixed(0)}% stake reduction)`
        );
        confidence -= 10;
      }
      const band = bet.confidenceBand as string | undefined;
      if (band === "D" || band === "E") {
        risks.push(`Longshot territory (${band} band) — sample size unreliable`);
        confidence -= 30;
        veto = true;
      }
      if (((resData.mes as number) ?? 1.0) < 0.85 && edge < 0.08) {
        risks.push(
          `MES veto zone: market efficiency ${(((resData.mes as number) ?? 0) * 100).toFixed(1)}% — edge may be vig noise`
        );
        confidence -= 35;
        veto = true;
      }
      if (((resData.sensitivity as Record<string, number> | undefined)?.fragilityScore ?? 0) > 6) {
        risks.push(
          `High fragility score (${((resData.sensitivity as Record<string, number>).fragilityScore).toFixed(1)}/10)`
        );
        confidence -= 20;
      }
      const upsetVeto = resData.upsetAlertVeto as string | undefined;
      if (
        upsetVeto &&
        String(bet.label ?? "")
          .toLowerCase()
          .includes(upsetVeto)
      ) {
        risks.push(`Upset alert triggered for ${upsetVeto} team`);
        confidence -= 25;
        veto = true;
      }
      if (
        (resData.ledger as Record<string, unknown> | undefined)?.metrics &&
        ((resData.ledger as Record<string, unknown>).metrics as Record<string, boolean>)?.driftAlert
      ) {
        risks.push("Model drift alert: recent Brier score diverging from baseline");
        confidence -= 15;
      }
      if (resData.marketSuspended) {
        risks.push("[MARKET_SUSPENDED] — Market pulled by bookmakers");
        confidence -= 10;
      }
      const survivalProb =
        (resData.clvProjection as Record<string, number> | undefined)?.survivalProb ?? 1.0;
      if (survivalProb < 0.5) {
        risks.push(
          `CLV projection: edge survival probability only ${(survivalProb * 100).toFixed(0)}%`
        );
        confidence -= 15;
      }
      return { risks, veto, confidence: Math.max(0, confidence) };
    };

    for (const bet of (finderOutput.proposed as Array<Record<string, unknown>> | undefined) ?? []) {
      const analysis = analyzeRisks(bet);
      const decision = analysis.veto || analysis.confidence < 50 ? "DISPROVE" : "ACCEPT";
      const score = (bet.score as number | undefined) ?? 0;
      if (decision === "DISPROVE") {
        totalScore += score;
        disprovedCount++;
      }
      critiques.push({
        id: bet.id,
        market: bet.market,
        originalScore: score,
        counterArgument:
          analysis.risks.join("; ") || "No significant disprovable risks — accepting claim",
        confidence: analysis.confidence,
        riskCalculation:
          decision === "DISPROVE"
            ? `+${score} points (disproving claim)`
            : `Risk: -${score * 2} if wrong dismissal`,
        decision,
        pointsGainedRisked: decision === "DISPROVE" ? `+${score}` : `risk -${score * 2}`,
      });
    }

    return {
      agent: "ADVERSARIAL",
      mission: "Maximize score by disproving Finder proposals with aggressive risk analysis",
      critiques,
      disprovedCount,
      acceptedCount: critiques.filter((c) => c.decision === "ACCEPT").length,
      totalScore: parseFloat(totalScore.toFixed(1)),
      verifiedList: critiques.filter((c) => c.decision === "ACCEPT").map((c) => c.id),
    };
  }

  refereeAgent(
    resData: Record<string, unknown>,
    finderOutput: Record<string, unknown>,
    adversaryOutput: Record<string, unknown>
  ): Record<string, unknown> {
    const verdicts: Record<string, unknown>[] = [];
    let confirmedCount = 0,
      rejectedCount = 0;

    const determineGroundTruth = (bet: Record<string, unknown>, critique: { veto: boolean }) =>
      ((bet.edge as number) ?? 0) > 0.05 &&
      bet.confidenceBand !== "E" &&
      !critique.veto &&
      ((resData.mc as Record<string, number> | undefined)?.varMultiplier ?? 1) > 0.5 &&
      ((resData.mes as number | undefined) ?? 1) > 0.75;

    for (const bet of (finderOutput.proposed as Array<Record<string, unknown>> | undefined) ?? []) {
      const critique = (
        (adversaryOutput.critiques as Array<Record<string, unknown>> | undefined) ?? []
      ).find((c) => c.id === bet.id) ?? { decision: "ACCEPT", confidence: 100 };
      const adversaryDisproved = critique.decision === "DISPROVE";
      const groundTruth = determineGroundTruth(bet, {
        veto: ((critique.confidence as number) ?? 100) < 50,
      });

      let verdict: string, trigger: string;
      if (groundTruth && adversaryDisproved) {
        verdict = "REAL +EV";
        trigger = "GREEN";
      } else if (!groundTruth && !adversaryDisproved) {
        verdict = "NOT +EV";
        trigger = "RED";
      } else if (groundTruth && !adversaryDisproved) {
        verdict = "CONFIRMED +EV";
        trigger =
          bet.confidenceBand === "A" && ((bet.edge as number) ?? 0) > 0.1 ? "GREEN" : "YELLOW";
      } else {
        verdict = "REJECTED";
        trigger = "RED";
      }

      // NEW-05: Force YELLOW if lineup unconfirmed < 3h to KO
      if (
        resData.lineupUnconfirmed &&
        ((resData.hoursToKO as number) ?? 24) < 3 &&
        trigger === "GREEN"
      ) {
        trigger = "YELLOW";
        verdict = `${verdict} [LINEUP_GATE]`;
      }

      // B10-01: S14 [NEGATIVE_EV_ALERT] hard reject — absolute priority
      const convergenceNegEvAlert =
        (resData.convergence as Record<string, unknown> | undefined)?.negativeEvAlert ?? null;
      const convergenceScores = (resData.convergence as Record<string, unknown> | undefined)
        ?.scores;
      const betNegEvAlert = Array.isArray(convergenceScores)
        ? ((convergenceScores as Array<Record<string, unknown>>).find(
            (s) => (s.market === bet.market || s.market === bet.label) && s.negativeEvAlert
          )?.negativeEvAlert ?? null)
        : null;
      if (convergenceNegEvAlert || betNegEvAlert) {
        trigger = "RED";
        verdict = `HARD_REJECT [NEGATIVE_EV_ALERT] ${betNegEvAlert ?? convergenceNegEvAlert}`;
      }

      // B10-02: Loss Aversion Override — guard against adversary asymmetrically killing edge
      if (
        trigger === "RED" &&
        ((bet.edge as number) ?? 0) > 0.08 &&
        critique.decision === "DISPROVE" &&
        ((critique.confidence as number) ?? 100) < 65 &&
        bet.confidenceBand !== "E" &&
        bet.confidenceBand !== "D" &&
        ((resData.mes as number | undefined) ?? 1) > 0.75 &&
        !convergenceNegEvAlert &&
        !betNegEvAlert
      ) {
        trigger = "YELLOW";
        verdict = "REAL +EV [LOSS_AVERSION_OVERRIDE]";
      }

      if (trigger !== "RED") confirmedCount++;
      else rejectedCount++;

      verdicts.push({
        id: bet.id,
        market: bet.market,
        odds: bet.odds,
        edge: bet.edge,
        finderClaim: `+EV opportunity with score ${bet.score} [${bet.impactLevel}]`,
        adversaryCounter: critique.counterArgument ?? "No risks identified",
        adversaryDecision: critique.decision,
        refereeAnalysis: `Edge:${(((bet.edge as number) ?? 0) * 100).toFixed(1)}% Band:${bet.confidenceBand} Risks:${critique.decision === "DISPROVE" ? "PRESENT" : "MINIMAL"}`,
        verdict,
        trigger,
        confidenceScore: critique.confidence,
      });
    }

    const greenCount = verdicts.filter((v) => v.trigger === "GREEN").length;
    const yellowCount = verdicts.filter((v) => v.trigger === "YELLOW").length;
    const overallTrigger = greenCount > 0 ? "GREEN" : yellowCount > 0 ? "YELLOW" : "RED";
    const validBets = verdicts.filter((v) => v.trigger !== "RED");
    const topBetVerdict = validBets.length > 0 ? validBets[0]! : null;
    const topBet = topBetVerdict
      ? {
          market: topBetVerdict.market,
          odds: topBetVerdict.odds,
          trigger: topBetVerdict.trigger,
          edge: topBetVerdict.edge,
        }
      : null;

    return {
      agent: "REFEREE",
      mission: "Determine TRUTH for each +EV claim",
      verdicts,
      topBet,
      overallTrigger,
      confirmedBets: confirmedCount,
      rejectedBets: rejectedCount,
      confirmedList: verdicts
        .filter((v) => String(v.verdict ?? "").includes("+EV"))
        .map((v) => ({ id: v.id, market: v.market, verdict: v.verdict })),
    };
  }

  execute(rawRes: Record<string, unknown>): Record<string, unknown> {
    const finder = this.evFinderAgent(rawRes);
    const adversary = this.adversarialAgent(rawRes, finder);
    const referee = this.refereeAgent(rawRes, finder, adversary);
    return {
      finder,
      adversary,
      referee,
      executiveSummary: this._summary(rawRes, referee),
      topBankerBet: (referee.topBet as Record<string, unknown> | null)
        ? `${(referee.topBet as Record<string, unknown>).market} @ ${(referee.topBet as Record<string, unknown>).odds}`
        : "NO_EDGE",
      betTrigger: referee.overallTrigger,
      asianHandicapAlt: this._findAH(rawRes),
      riskFlags: this._riskFlags(rawRes, referee),
      sovereignGapDetected: this._sovereignGap(rawRes),
      betWindow: this._betWindow(rawRes),
    };
  }

  private _summary(resData: Record<string, unknown>, referee: Record<string, unknown>): string {
    const fixture = `${resData.home ?? "Home"} vs ${resData.away ?? "Away"}`;
    const t = referee.overallTrigger as string;
    if (t === "RED")
      return `${fixture}: No actionable edge confirmed by 3-Agent debate. Anti-Sycophancy circuit rejected all Finder proposals. Grade: NO_EDGE.`;
    const top = referee.topBet as Record<string, unknown> | null;
    const signal =
      t === "GREEN" ? "Strong mathematical edge confirmed" : "Edge detected with caveats";
    const scTag = resData.sharpCompressionTag ? " [SHARP_COMPRESSION]" : "";
    return `${fixture}: ${signal} in ${top?.market ?? "N/A"} (${(((top?.edge as number) ?? 0) * 100).toFixed(1)}% EV)${scTag}. Referee confirmed ${referee.confirmedBets}/${(referee.verdicts as unknown[]).length} proposals after adversarial challenge. Trigger: ${t}.`;
  }

  private _findAH(resData: Record<string, unknown>): string {
    const ah = ((resData.evMarkets as Array<Record<string, unknown>> | undefined) ?? []).filter(
      (m) => m.cat === "Asian Handicap" && !m.veto && ((m.ev as number) ?? 0) > 0.03
    );
    if (ah.length === 0) return "None available";
    const top = ah.sort((a, b) => (b.ev as number) - (a.ev as number))[0]!;
    return `${top.label} @ ${top.odds}`;
  }

  private _riskFlags(resData: Record<string, unknown>, referee: Record<string, unknown>): string[] {
    const flags: string[] = [];
    if ((resData.mc as Record<string, unknown> | undefined)?.varFlag)
      flags.push("[HIGH_VARIANCE] High variance environment");
    if (((resData.drawdownPenalty as number) ?? 1.0) < 1.0)
      flags.push(
        `[DRAWDOWN] Drawdown penalty: ${((1 - (resData.drawdownPenalty as number)) * 100).toFixed(0)}% stake reduction`
      );
    if (resData.rlmDetected) flags.push("[TRUE_RLM] Reverse Line Movement detected");
    if (resData.sharpCompressionTag)
      flags.push("[SHARP_COMPRESSION] Sharp syndicate velocity > 0.03 detected");
    if (resData.marketSuspended) flags.push("[MARKET_SUSPENDED] Bookmaker pulled market");
    if (resData.upsetAlertVeto) flags.push(`[UPSET_ALERT] ${resData.upsetAlertVeto}`);
    if (((resData.sensitivity as Record<string, number> | undefined)?.fragilityScore ?? 0) > 6)
      flags.push("[HIGH_FRAGILITY] High sensitivity to input changes");
    if (
      (resData.ledger as Record<string, unknown> | undefined) &&
      ((resData.ledger as Record<string, unknown>).metrics as Record<string, boolean> | undefined)
        ?.driftAlert
    )
      flags.push("[DRIFT_ALERT] Recent calibration divergence");
    if (resData.lineupUnconfirmed && ((resData.hoursToKO as number) ?? 24) < 3)
      flags.push("[LINEUP_GATE] Starting XI unconfirmed < 3h to KO");
    if (resData.isArbitrage)
      flags.push("[ARB_STATE] Market in arbitrage — pre-scaled for correct EV calc");
    if (((resData.clvProjection as Record<string, number> | undefined)?.survivalProb ?? 1) < 0.5)
      flags.push("[CLV_FADE] Edge survival < 50% — close now if value exists");
    void referee;
    return flags.length > 0 ? flags : ["[OK] No critical risk flags"];
  }

  private _sovereignGap(resData: Record<string, unknown>): Record<string, unknown> | null {
    const top = (resData.evMarkets as Array<Record<string, unknown>> | undefined)?.[0];
    if (!top) return null;
    const gap = Math.abs(
      ((top.mp as number | undefined) ?? 0) - ((top.ip as number | undefined) ?? 0)
    );
    if (gap > 0.08)
      return {
        market: top.label,
        gap: parseFloat((gap * 100).toFixed(1)),
        verdict: "PRICING ERROR DETECTED",
      };
    return null;
  }

  // BUG-022: STANDARD window has actionable guidance
  private _betWindow(resData: Record<string, unknown>): string {
    const h = (resData.hoursToKO as number | undefined) ?? 24;
    if (h > 20) return "EARLY_VALUE"; // best CLV window
    if (h >= 4 && h <= 20) return "STANDARD"; // normal betting window
    if (h >= 2 && h < 4) return "PRE_MATCH_NEWS"; // watch for lineup confirmations
    return "AVOID"; // too close; line fully compressed
  }

  /** Phase 2 async variant — full LLM debate via claudeKey. */
  async challenge(_briefing: string, _claudeKey: string): Promise<AntiSycophancyResult> {
    return { agreed: true };
  }
}

clamp; // satisfy import
