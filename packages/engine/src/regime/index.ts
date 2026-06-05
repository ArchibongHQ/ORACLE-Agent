/** Re-export regime functions that already live in math/index.ts (detectLowScoringRegime,
 *  asianHandicapPivot). Dedicated home per build plan §0.3. */
export { detectLowScoringRegime, asianHandicapPivot } from '../math/index.js';
export type { RegimeReport, AhPivotResult } from '../math/index.js';
