/** Re-export regime functions that already live in math/index.ts (detectLowScoringRegime,
 *  asianHandicapPivot). Dedicated home per build plan §0.3. */

export type { AhPivotResult, RegimeReport } from "../math/index.js";
export { asianHandicapPivot, detectLowScoringRegime } from "../math/index.js";
