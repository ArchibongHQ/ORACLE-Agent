/** Green-Flags report enrichment — maps a scraped sidecar fixture into the
 *  engine's deterministic pattern detector (marketsV3/patterns.ts) and
 *  summarizes the result for the daily fixtures-markets HTML page.
 *
 *  Purpose (owner instruction 2026-07-18): make the patterns/trends the engine
 *  sees VISIBLE per fixture in the delivered report, so a human can verify the
 *  day's picks were driven by those patterns. The detector call here is the
 *  SAME `detectPatterns` the pick engine runs — one source of truth; this
 *  module only maps sidecar fields and renders, it never re-implements
 *  pattern logic.
 *
 *  Basis honesty: venue-split rates (scoringConceding) are preferred; when
 *  only overall season rates (goals.avg_*) exist the detector still runs but
 *  every flag is marked with a ° suffix (overall basis, lower trust) — the
 *  v6.2 §2.5.4 convention. Completeness is computed from actual field
 *  presence, never from the feed's own statscoverage self-assessment
 *  (sidecar data contract, PR #74). */
import { detectPatterns, type PatternInput, type PatternReport } from "@oracle/engine";
import type { SportyBetEvent, SportyBetStats } from "./selectFixtures.js";
import { last5Points } from "./sportyBetStats.js";

export type GreenFlagBasis = "venue" | "overall";

export interface GreenFlagChip {
  /** Pattern kind from the engine detector. */
  kind: "heavy_superior" | "goal_machine" | "corner_kings" | "anomaly";
  /** Short chip label, e.g. "Heavy Superior (home)". */
  label: string;
  basis: GreenFlagBasis;
  /** 0-1 raw pattern score from the detector. */
  score: number;
  rationale: string;
}

export interface GreenFlagSummary {
  flags: GreenFlagChip[];
  flagCount: number;
  /** Overall detector conviction 0-1 (0 when no pattern or no usable input). */
  strength: number;
  /** Field-presence completeness 0-1 over the detector-relevant input groups. */
  completeness: number;
  /** "venue" when venue-split goal rates fed the detector; "overall" when the
   *  season aggregates were the only goal-rate source; null when the fixture
   *  had no usable goal rates at all (detector not run). */
  basis: GreenFlagBasis | null;
  /** One-sentence dominant-trend summary; null when no pattern fired. */
  sentence: string | null;
  trapWarning: string | null;
  recommended: string | null;
}

const KIND_LABEL: Record<GreenFlagChip["kind"], string> = {
  heavy_superior: "Heavy Superior",
  goal_machine: "Goal Machine",
  corner_kings: "Corner Kings",
  anomaly: "Hidden Value",
};

const fin = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** H2H Over-2.5 hit rate from the sidecar's recent meetings; null under 3
 *  scored meetings (too thin to call a trend). */
function h2hOversRate(stats: SportyBetStats): number | null {
  const matches = stats.h2h?.matches;
  if (!matches?.length) return null;
  let n = 0;
  let overs = 0;
  for (const m of matches) {
    if (fin(m.home_goals) && fin(m.away_goals)) {
      n++;
      if (m.home_goals + m.away_goals > 2.5) overs++;
    }
  }
  return n >= 3 ? overs / n : null;
}

/** Build the detector input from a scraped sidecar event. Returns null when
 *  no goal rates exist on either basis (detector would be meaningless). */
export function buildReportPatternInput(
  event: SportyBetEvent
): { input: PatternInput; basis: GreenFlagBasis; completeness: number } | null {
  const stats = event.detail?.stats;
  if (!stats) return null;

  const sc = stats.scoringConceding;
  const venueOk =
    fin(sc?.home?.scored_avg) &&
    fin(sc?.home?.conceded_avg) &&
    fin(sc?.away?.scored_avg) &&
    fin(sc?.away?.conceded_avg);
  const overallOk =
    fin(stats.goals?.home?.avg_scored) &&
    fin(stats.goals?.home?.avg_conceded) &&
    fin(stats.goals?.away?.avg_scored) &&
    fin(stats.goals?.away?.avg_conceded);
  if (!venueOk && !overallOk) return null;
  const basis: GreenFlagBasis = venueOk ? "venue" : "overall";

  const homeXgEntry = stats.xg?.home;
  const awayXgEntry = stats.xg?.away;
  // Prefer the venue-conditioned xG split when it exists (same preference as
  // buildStatsOverride's venue-xG gate), else the season aggregate.
  const pickXg = (e: typeof homeXgEntry, k: "xgf" | "xga"): number | undefined => {
    const venue = k === "xgf" ? e?.venueXgf : e?.venueXga;
    const season = k === "xgf" ? e?.xgf : e?.xga;
    if (fin(venue)) return venue;
    return fin(season) ? season : undefined;
  };

  const odds1x2 = event.detail?.odds?.["1x2"];
  const restH = stats.congestion?.home?.rest_days;
  const restA = stats.congestion?.away?.rest_days;
  const h2hRate = h2hOversRate(stats);

  const input: PatternInput = venueOk
    ? {
        homeScoredHome: sc?.home?.scored_avg as number,
        homeConcededHome: sc?.home?.conceded_avg as number,
        awayScoredAway: sc?.away?.scored_avg as number,
        awayConcededAway: sc?.away?.conceded_avg as number,
        nHome: fin(sc?.home?.matches) ? sc?.home?.matches : undefined,
        nAway: fin(sc?.away?.matches) ? sc?.away?.matches : undefined,
      }
    : {
        homeScoredHome: stats.goals?.home?.avg_scored as number,
        homeConcededHome: stats.goals?.home?.avg_conceded as number,
        awayScoredAway: stats.goals?.away?.avg_scored as number,
        awayConcededAway: stats.goals?.away?.avg_conceded as number,
        nHome: fin(stats.standings?.home?.played) ? stats.standings?.home?.played : undefined,
        nAway: fin(stats.standings?.away?.played) ? stats.standings?.away?.played : undefined,
      };

  input.homeXg = pickXg(homeXgEntry, "xgf");
  input.homeXga = pickXg(homeXgEntry, "xga");
  input.awayXg = pickXg(awayXgEntry, "xgf");
  input.awayXga = pickXg(awayXgEntry, "xga");
  // over25_pct / btts_rate / clean_sheet_rate / failed_to_score_rate are all
  // 0..1 in the sidecar (see buildStatsOverride's identical reads).
  if (fin(stats.overunder?.home?.over25_pct)) input.ou25PctH = stats.overunder?.home?.over25_pct;
  if (fin(stats.overunder?.away?.over25_pct)) input.ou25PctA = stats.overunder?.away?.over25_pct;
  if (fin(sc?.home?.btts_rate)) input.bttsPctH = sc?.home?.btts_rate;
  if (fin(sc?.away?.btts_rate)) input.bttsPctA = sc?.away?.btts_rate;
  if (fin(sc?.home?.clean_sheet_rate)) input.csPctH = sc?.home?.clean_sheet_rate;
  if (fin(sc?.away?.clean_sheet_rate)) input.csPctA = sc?.away?.clean_sheet_rate;
  if (fin(sc?.home?.failed_to_score_rate)) input.ftsPctH = sc?.home?.failed_to_score_rate;
  if (fin(sc?.away?.failed_to_score_rate)) input.ftsPctA = sc?.away?.failed_to_score_rate;

  // Corners: recent-5 preferred, season corners_avg fallback (for-only) —
  // mirrors buildStatsOverride's source order.
  const cForH = stats.recentCorners?.home ?? stats.possessionValue?.home?.corners_avg;
  const cForA = stats.recentCorners?.away ?? stats.possessionValue?.away?.corners_avg;
  if (fin(cForH)) input.cornersForH = cForH;
  if (fin(cForA)) input.cornersForA = cForA;
  if (fin(stats.recentCornersAgainst?.home))
    input.cornersAgainstH = stats.recentCornersAgainst?.home;
  if (fin(stats.recentCornersAgainst?.away))
    input.cornersAgainstA = stats.recentCornersAgainst?.away;

  const cards = (d: { yellow_avg?: number; red_avg?: number } | null | undefined) =>
    fin(d?.yellow_avg) ? d.yellow_avg + (fin(d?.red_avg) ? d.red_avg : 0) : undefined;
  input.cardsAvgH = cards(stats.disciplinary?.home);
  input.cardsAvgA = cards(stats.disciplinary?.away);

  if (fin(odds1x2?.home)) input.homeOdds = odds1x2?.home;
  if (fin(odds1x2?.draw)) input.drawOdds = odds1x2?.draw;
  if (fin(odds1x2?.away)) input.awayOdds = odds1x2?.away;
  if (fin(stats.form?.home?.streak)) input.streakH = stats.form?.home?.streak;
  if (fin(stats.form?.away?.streak)) input.streakA = stats.form?.away?.streak;
  const l5H = last5Points(stats.form?.home?.last5);
  const l5A = last5Points(stats.form?.away?.last5);
  if (l5H !== null) input.last5PtsH = l5H;
  if (l5A !== null) input.last5PtsA = l5A;
  if (h2hRate !== null) input.h2hOversRate = h2hRate;
  if (fin(restH) || fin(restA)) {
    input.restDaysMin = Math.min(fin(restH) ? restH : Infinity, fin(restA) ? restA : Infinity);
  }

  // Field-presence completeness over the detector-relevant input groups —
  // computed from what actually arrived, never the feed's self-assessment.
  const groups: boolean[] = [
    true, // goal rates (required to get here)
    fin(input.homeXg) && fin(input.awayXg),
    fin(input.ou25PctH) && fin(input.ou25PctA),
    fin(input.bttsPctH) && fin(input.bttsPctA),
    fin(input.cornersForH) && fin(input.cornersForA),
    fin(input.cardsAvgH) && fin(input.cardsAvgA),
    fin(input.streakH) && fin(input.streakA),
    input.h2hOversRate !== undefined,
    fin(input.homeOdds) && fin(input.awayOdds),
    fin(input.restDaysMin),
  ];
  const completeness = groups.filter(Boolean).length / groups.length;

  return { input, basis, completeness };
}

function sentence(report: PatternReport, basis: GreenFlagBasis): string | null {
  const top = report.topPattern;
  if (!top) return null;
  const deg = basis === "overall" ? "°" : "";
  const names = report.patterns
    .map((p) => `${KIND_LABEL[p.kind]}${p.side ? ` (${p.side})` : ""}${deg}`)
    .join(" + ");
  const rec =
    report.recommendedFamily && report.recommendedSide
      ? ` → leans ${report.recommendedFamily} ${report.recommendedSide}`
      : "";
  return `${names}${rec} (strength ${(report.strength * 100).toFixed(0)}%).`;
}

/** Run the shared detector over one sidecar fixture and summarize. Never
 *  throws; a fixture with no usable stats gets an empty summary. */
export function summarizeGreenFlags(event: SportyBetEvent): GreenFlagSummary {
  const empty: GreenFlagSummary = {
    flags: [],
    flagCount: 0,
    strength: 0,
    completeness: 0,
    basis: null,
    sentence: null,
    trapWarning: null,
    recommended: null,
  };
  try {
    const built = buildReportPatternInput(event);
    if (!built) return empty;
    const report = detectPatterns(built.input);
    const flags: GreenFlagChip[] = report.patterns.map((p) => ({
      kind: p.kind,
      label: `${KIND_LABEL[p.kind]}${p.side ? ` (${p.side})` : ""}`,
      basis: built.basis,
      score: p.score,
      rationale: p.rationale,
    }));
    return {
      flags,
      flagCount: flags.length,
      strength: report.strength,
      completeness: built.completeness,
      basis: built.basis,
      sentence: sentence(report, built.basis),
      trapWarning: report.trapWarning,
      recommended:
        report.recommendedFamily && report.recommendedSide
          ? `${report.recommendedFamily} ${report.recommendedSide}`
          : null,
    };
  } catch {
    return empty; // report enrichment must never break report generation
  }
}

/** Sort key for the report listing: most green flags first; venue basis
 *  outranks overall° at equal counts; then strength, then completeness. */
export function compareGreenFlagSummaries(a: GreenFlagSummary, b: GreenFlagSummary): number {
  if (b.flagCount !== a.flagCount) return b.flagCount - a.flagCount;
  const basisRank = (s: GreenFlagSummary) =>
    s.basis === "venue" ? 2 : s.basis === "overall" ? 1 : 0;
  if (basisRank(b) !== basisRank(a)) return basisRank(b) - basisRank(a);
  if (b.strength !== a.strength) return b.strength - a.strength;
  return b.completeness - a.completeness;
}

/** Slate-level dominant-trends line, e.g.
 *  "Slate profile: 14 Goal Machine · 9 Heavy Superior · 6 Corner Kings · 3 Hidden Value (of 122 fixtures)".
 *  Null when no fixture raised any flag. */
export function slateGreenFlagProfile(
  summaries: GreenFlagSummary[],
  fixtureCount: number
): string | null {
  const counts = new Map<GreenFlagChip["kind"], number>();
  for (const s of summaries) {
    for (const f of s.flags) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${KIND_LABEL[kind]}`);
  return `Slate profile: ${parts.join(" · ")} (of ${fixtureCount} fixtures)`;
}
