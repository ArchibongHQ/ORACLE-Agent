import type { EVMarket, RankingMode } from '../types.js';

/** applyRankingMode — Phase 1 full implementation. Stub returns input sorted by existing rankingScore.
 *  PRD §5: three risk-preference views over the same calibrated probability distribution. */
export function applyRankingMode(evs: EVMarket[], mode: RankingMode = 'CONFIDENCE_WEIGHTED'): EVMarket[] {
  const sorted = [...evs];
  switch (mode) {
    case 'MAX_PROBABILITY':
      return sorted
        .filter(e => e.ev > 0)
        .sort((a, b) => b.modelProb - a.modelProb);
    case 'MAX_EV':
      return sorted.sort((a, b) => (b.ev * b.varianceMod) - (a.ev * a.varianceMod));
    case 'CONFIDENCE_WEIGHTED':
    default:
      return sorted.sort(
        (a, b) =>
          (b.ev * b.modelProb * b.varianceMod) - (a.ev * a.modelProb * a.varianceMod),
      );
  }
}
