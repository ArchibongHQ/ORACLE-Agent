/** GBM residual model — TS inference shim for tools/gbm_residual.py's offline-trained
 *  XGBoost ensemble (.tmp/models/gbm_residual.json). Pure tree-walking re-implementation
 *  of XGBoost's multi:softprob prediction path — no Python subprocess, no new npm deps.
 *
 *  IMPORTANT — gated off by default. The currently-saved model fails its own walk-forward
 *  significance gate (tools/gbm_residual.py: RPS improvement -0.0012 vs the +0.002
 *  threshold, single test season 2425, n=3456) — it does not beat the market baseline.
 *  This module is wired but inert until `OracleConfig.enableGbmResidual` is explicitly
 *  set true AND a retrained model that passes the gate is dropped into
 *  .tmp/models/gbm_residual.json. See tools/gbm_residual.py's _save_model/_meta for the
 *  gate_passed flag — check the meta JSON before ever flipping this on in production.
 */
import { readFileSync } from "node:fs";

/** One CART tree as stored in XGBoost's native JSON format (gradient_booster.model.trees[i]). */
interface XgbTree {
  left_children: number[];
  right_children: number[];
  split_indices: number[];
  split_conditions: number[];
  default_left: number[];
}

interface XgbModelJson {
  learner: {
    attributes?: { best_iteration?: string };
    learner_model_param: { num_class: string; num_feature: string; base_score: string };
    gradient_booster: {
      model: {
        trees: XgbTree[];
        tree_info: number[]; // class index each tree boosts (round-robin 0..num_class-1)
      };
    };
  };
}

export interface GbmModel {
  numClass: number;
  numFeature: number;
  baseScore: number[]; // per-class margin offset, length numClass
  trees: XgbTree[];
  treeInfo: number[];
}

/** Parses XGBoost's `learner_model_param.base_score` string, e.g.
 *  "[3.038063E-1,-2.668264E-1,-3.6980033E-2]" -> [0.3038063, -0.2668264, -0.036980033]. */
function parseBaseScore(raw: string): number[] {
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => parseFloat(s));
}

/** Loads and parses a model saved by xgboost's `Booster.save_model(path)` (native JSON format).
 *
 *  Truncates to `best_iteration` (early-stopping round, from `learner.attributes`) when present:
 *  xgboost keeps every round trained — including rounds after the best one — in the saved
 *  JSON, but `XGBClassifier.predict_proba()` (what the Python trainer's walk-forward gate
 *  actually scores against) only walks trees through `best_iteration`. Walking the full
 *  tree list here would silently diverge from the validated/gated prediction path. */
export function loadGbmModel(path: string): GbmModel {
  const json = JSON.parse(readFileSync(path, "utf8")) as XgbModelJson;
  const lmp = json.learner.learner_model_param;
  const gbm = json.learner.gradient_booster.model;
  const numClass = parseInt(lmp.num_class, 10);
  const bestIterationRaw = json.learner.attributes?.best_iteration;
  const treeLimit =
    bestIterationRaw !== undefined ? (parseInt(bestIterationRaw, 10) + 1) * numClass : undefined;
  return {
    numClass,
    numFeature: parseInt(lmp.num_feature, 10),
    baseScore: parseBaseScore(lmp.base_score),
    trees: treeLimit !== undefined ? gbm.trees.slice(0, treeLimit) : gbm.trees,
    treeInfo: treeLimit !== undefined ? gbm.tree_info.slice(0, treeLimit) : gbm.tree_info,
  };
}

/** Walks one CART tree to its leaf for a single feature row, returning the leaf weight.
 *  Missing features (NaN) follow `default_left`, matching XGBoost's own missing-value
 *  routing — the same semantics the Python trainer relies on for `fillna(0)` columns
 *  that were truly absent at train time (0 is a real value, not "missing", here). */
function walkTree(tree: XgbTree, x: number[]): number {
  let node = 0;
  while (tree.left_children[node] !== -1) {
    const featIdx = tree.split_indices[node]!;
    const cond = tree.split_conditions[node]!;
    const val = x[featIdx];
    const goLeft =
      val === undefined || Number.isNaN(val) ? tree.default_left[node] === 1 : val < cond;
    node = goLeft ? tree.left_children[node]! : tree.right_children[node]!;
  }
  // Leaf weight is stored in split_conditions at the leaf node (XGBoost JSON convention).
  return tree.split_conditions[node]!;
}

function softmax(margins: number[]): number[] {
  const max = Math.max(...margins);
  const exps = margins.map((m) => Math.exp(m - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/** Runs the full ensemble for one fixture's feature row, returning class probabilities
 *  in [home, draw, away] order (training label convention: 0=home win, 1=draw, 2=away win —
 *  see tools/gbm_residual.py's `_outcome` column). `x` must be in the exact order of the
 *  model's `feat_cols` (see GBM_FEAT_COLS below) — length must equal model.numFeature. */
export function predictGbm(model: GbmModel, x: number[]): number[] {
  if (x.length !== model.numFeature) {
    throw new Error(
      `predictGbm: feature vector length ${x.length} !== model.numFeature ${model.numFeature}`
    );
  }
  const margins = [...model.baseScore];
  for (let i = 0; i < model.trees.length; i++) {
    const classIdx = model.treeInfo[i]!;
    margins[classIdx]! += walkTree(model.trees[i]!, x);
  }
  return softmax(margins);
}

/** Canonical feature column order the model was trained on (tools/gbm_residual.py's
 *  `feat_cols`, persisted verbatim in .tmp/models/gbm_residual_meta.json). Any TS caller
 *  building a feature vector MUST follow this exact order. */
export const GBM_FEAT_COLS = [
  "mktH",
  "mktD",
  "mktA",
  "lineMovH",
  "lineMovD",
  "lineMovA",
  "lineMovHAbs",
  "openAvgH",
  "openAvgD",
  "openAvgA",
  "openMovH",
  "openMovA",
  "maxCloseH",
  "maxCloseD",
  "maxCloseA",
  "maxCloseEdgeH",
  "maxCloseEdgeA",
  "homeAttack",
  "homeDefense",
  "awayAttack",
  "awayDefense",
  "homeGD10",
  "awayGD10",
  "homeGF5",
  "homeGA5",
  "homePts5",
  "homeWR5",
  "homeDR5",
  "awayGF5",
  "awayGA5",
  "awayPts5",
  "awayWR5",
  "awayDR5",
  "homeGF10",
  "homeGA10",
  "homePts10",
  "homeWR10",
  "homeDR10",
  "awayGF10",
  "awayGA10",
  "awayPts10",
  "awayWR10",
  "awayDR10",
  "hHomeGF5",
  "hHomeGA5",
  "hHomePts5",
  "hHomeWR5",
  "hHomeDR5",
  "aAwayGF5",
  "aAwayGA5",
  "aAwayPts5",
  "aAwayWR5",
  "aAwayDR5",
  "hHomeGF10",
  "hHomeGA10",
  "hHomePts10",
  "hHomeWR10",
  "hHomeDR10",
  "aAwayGF10",
  "aAwayGA10",
  "aAwayPts10",
  "aAwayWR10",
  "aAwayDR10",
  "xgForHome5",
  "xgAgainstHome5",
  "xgForAway5",
  "xgAgainstAway5",
  "xgDiffHome5",
  "xgDiffAway5",
  "xgForHome10",
  "xgAgainstHome10",
  "xgForAway10",
  "xgAgainstAway10",
  "xgDiffHome10",
  "xgDiffAway10",
  "eloHome",
  "eloAway",
  "eloDiff",
  "spiOffHome",
  "spiDefHome",
  "spiOffAway",
  "spiDefAway",
  "spiOffDiff",
  "spiDefDiff",
  "squadValueRatio",
  "lineMovSlope",
  "openToCloseDelta",
  "ahOpenLine",
  "ahCloseLine",
  "ahCloseDelta",
  "fbrefGoalsHome",
  "fbrefShotsHome",
  "fbrefSotP90Home",
  "fbrefGoalsAway",
  "fbrefShotsAway",
  "fbrefSotP90Away",
  "fbrefSotDiff",
  "refStrictness",
  "ppdaHome",
  "ppdaAway",
  "ppdaDiff",
  "oppdaHome",
  "oppdaAway",
  "tempC",
  "precipMm",
  "windKph",
  "isAdverse",
  "availIdxHome",
  "availIdxAway",
  "keyPlayerHome",
  "keyPlayerAway",
  "availIdxDiff",
  "mlHomeDrift",
  "mlDrawDrift",
  "mlReverseLM",
  "h2hHomeWin",
  "h2hDraw",
  "h2hAwayWin",
  "h2hN",
  "h2hGoalDiff",
] as const;

/** Live-data inputs the engine can honestly supply today. Everything in GBM_FEAT_COLS
 *  not listed here zero-fills — identical to the Python trainer's own `fillna(0)` for
 *  genuinely missing columns, not a fabricated signal. */
export interface GbmLiveInputs {
  /** Market-implied probabilities (de-vigged), home/draw/away. */
  mktH: number;
  mktD: number;
  mktA: number;
  /** Pi-ratings (engine's own rating system) standing in for the trainer's ClubElo feature —
   *  same role (a single attack/defense-agnostic team-strength scalar), different source. */
  eloHome: number;
  eloAway: number;
}

/** Builds a model-ready feature row from whatever the live engine actually has.
 *  Returns a Float64Array-equivalent plain array of length GBM_FEAT_COLS.length. */
export function buildGbmFeatureVector(inputs: GbmLiveInputs): number[] {
  const live: Partial<Record<(typeof GBM_FEAT_COLS)[number], number>> = {
    mktH: inputs.mktH,
    mktD: inputs.mktD,
    mktA: inputs.mktA,
    eloHome: inputs.eloHome,
    eloAway: inputs.eloAway,
    eloDiff: inputs.eloHome - inputs.eloAway,
  };
  return GBM_FEAT_COLS.map((col) => live[col] ?? 0);
}

/** Blends the GBM's [home, draw, away] probabilities into an existing fp triple at
 *  weight `w` (0-1), renormalising. Mirrors execution/index.ts's existing Skellam
 *  cross-check blend (same shape: low-weight nudge, not a replacement).
 *
 *  [P2-2 hygiene] Activation criterion (same gate as `ratings/index.ts`'s
 *  `buildRatingsLambdaInput`): do NOT wire this into a live call site until a retrained model
 *  clears its own walk-forward significance gate (`tools/gbm_residual.py`'s RPS-improvement
 *  check vs. the +0.002 bar, `calibration/index.ts`'s `significanceAcceptGate` machinery) —
 *  check `.tmp/models/gbm_residual_meta.json`'s `gate_passed` flag before ever calling this
 *  from `batch/`, `execution/`, `goalsV3/`, or `marketsV3/`. As of this entry there is still
 *  zero call site anywhere in `packages/` and `OracleConfig.enableGbmResidual` stays the
 *  required (necessary, not sufficient) opt-in flag on top of that gate. */
export function blendGbmIntoFp(
  fp: { home: number; draw: number; away: number },
  gbmProbs: [number, number, number],
  w: number
): { home: number; draw: number; away: number } {
  const bH = (1 - w) * fp.home + w * gbmProbs[0];
  const bD = (1 - w) * fp.draw + w * gbmProbs[1];
  const bA = (1 - w) * fp.away + w * gbmProbs[2];
  const bt = bH + bD + bA;
  return { home: bH / bt, draw: bD / bt, away: bA / bt };
}
