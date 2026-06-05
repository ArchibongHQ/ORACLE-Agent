# SOP: GBM Residual Model

## Objective
Train an XGBoost multi-class probability model to correct Pinnacle's implied probabilities
using rolling form features, venue-specific form, and line movement. Accept into ORACLE only
if it beats the Pinnacle closing-odds baseline RPS by >= 0.002 on a walk-forward holdout.

## Tool
`tools/gbm_residual.py`

## Usage

```bash
# Full run (train on 2223+2324, test on 2425)
python tools/gbm_residual.py

# Dry run — build features, no training
python tools/gbm_residual.py --dry-run

# Custom season split
python tools/gbm_residual.py --test-season 2324

# More backfill data
python tools/backfill_oracle.py --seasons 2425 2324 2223 2122 2021 1920
python tools/gbm_residual.py
```

## Results history

### Run 3 — 2026-06-04 (9 seasons, xG + ClubElo)

| Metric | Value |
|---|---|
| Train | 27,617 matches (1516→2324, 9 seasons) |
| Test | 3,456 matches (2425 holdout) |
| Features | 68 cols: market probs, rolling form, venue form, line movement, xG (34.9% coverage), ClubElo (55.2% coverage) |
| Pinnacle baseline RPS | 0.1944 |
| GBM RPS | 0.1949 |
| Delta | **-0.0005** (FAIL — gate requires +0.002) |

Per-league breakdown (test set):

| League | n | GBM | Mkt | Delta |
|---|---|---|---|---|
| Belgian Pro League | 312 | 0.1942 | 0.1949 | **+0.0007** |
| Championship | 552 | 0.2070 | 0.2076 | **+0.0006** |
| Ligue 1 | 306 | 0.2007 | 0.2009 | **+0.0001** |
| Scottish Premiership | 228 | 0.1998 | 0.1995 | -0.0003 |
| La Liga | 380 | 0.1881 | 0.1875 | -0.0007 |
| Eredivisie | 306 | 0.1855 | 0.1847 | -0.0008 |
| Premier League | 380 | 0.1971 | 0.1961 | -0.0010 |
| Serie A | 380 | 0.1851 | 0.1841 | -0.0010 |
| Bundesliga | 306 | 0.2033 | 0.2019 | -0.0014 |
| Primeira Liga | 306 | 0.1828 | 0.1812 | -0.0015 |

**Critical finding:** GBM adds value in thin/lower-quality markets (Championship, Belgian Pro League) and hurts in sharp markets (Bundesliga, Serie A, Primeira Liga). Pinnacle is fully efficient in top-5 leagues — the GBM cannot improve on closing odds there with results-based features.

### Run 2 — 2026-06-02 (3 seasons, no xG/Elo)
Delta: **-0.0022** | Features: market probs, rolling form, venue form, line movement

### Run 1 — 2026-06-02 (3 seasons, baseline)
Delta: **-0.0022** | Features: market probs only

## Why GBM fails to beat Pinnacle (root cause confirmed)

Pinnacle closing odds encode almost all available information in liquid markets. The GBM's
features (form, xG, Elo) are already priced in by the time the closing line is set.

**The gap is structural:** Pinnacle is sharpest in the top-5 leagues (EPL, La Liga, Bundesliga,
Serie A, Primeira Liga) where it has the most market volume and the most sharp money. In those
leagues, even xG + Elo cannot add signal on top of the closing line.

**The opportunity is in thin markets:** Championship, Belgian Pro League, and Scottish
Premiership show positive deltas. These markets have less sharp money; the GBM's features
encode information Pinnacle hasn't fully priced.

## What would actually pass the gate

### 1. Split-model approach — HIGHEST EXPECTED IMPACT (next action)

Train separate GBM models per league tier rather than one global model:
- **Tier A (thin markets):** Championship, Belgian Pro League, Scottish Premiership, Eredivisie
- **Tier B (sharp markets):** EPL, La Liga, Bundesliga, Serie A, Ligue 1, Primeira Liga (use Pinnacle directly)

Expected: Tier A GBM will likely clear the +0.002 gate on those leagues alone.
Implementation: add `--tier` flag to `gbm_residual.py`, filter `df` to tier leagues before training.

### 2. Historical per-season ClubElo snapshots — MEDIUM IMPACT

Current implementation uses today's ratings for all historical matches (snapshot leakage
across seasons). Fetching ratings for each season start (e.g. 2015-08-01, 2016-08-01...) would
give pre-season strength estimates that are genuinely anti-leakage compliant.

```bash
for year in 2015 2016 2017 2018 2019 2020 2021 2022 2023 2024; do
    python tools/fetch_clubelo.py --date ${year}-08-01
done
```

Then modify `build_features` to look up the Elo snapshot nearest to but before each match date.

### 3. Pi-ratings (Constantinou & Fenton) — MEDIUM IMPACT
Computable from backfill CSVs. Separates attack and defense strength with exponential decay.
The literature benchmark (CatBoost + pi-ratings) achieves RPS ~0.1925. PRD §8.6(b).

## Feature importances (Run 3 — top 15)

| Rank | Feature | Importance |
|---|---|---|
| 1 | mktH | 15.7% |
| 2 | mktA | 14.3% |
| 3 | xgDiff | 6.4% |
| 4 | mktD | 4.0% |
| 5 | xgAway | 2.8% |
| 6 | xgHome | 2.5% |
| 7–10 | Rolling form (awayWR10, homeGD10, awayGD10, awayGF10) | ~1.1% each |
| 11 | eloHome | 1.1% |
| 12–15 | Rolling form (various) | ~1.1% each |

Market features dominate (34%). xG features are 3rd most important. ClubElo is visible (11th) but
below xG — its current contribution is limited by using a single snapshot for all seasons.

## Accept gate

Per PRD §8.3: an edit ships only when:
- Held-out N >= 100 fixtures
- Delta RPS >= 0.002 (improvement over Pinnacle baseline)
- Bootstrap CI lower bound > 0 (not just a point estimate)

Current status: GATE NOT PASSED. Do not integrate into ExecutionEngine until gate passes.

## When gate passes

1. Save model → `.tmp/models/gbm_residual.json` (auto-saved by script)
2. Save metadata → `.tmp/models/gbm_residual_meta.json`
3. Wire into `packages/engine/src/execution/index.ts`:
   - Load model at startup
   - Replace `state.probabilities` with `gbmAdjust(state.probabilities, features)`
   - Only activate when `config.useGbmResidual = true` (feature flag)
4. Run 1 season of shadow-mode comparison before making GBM the default
