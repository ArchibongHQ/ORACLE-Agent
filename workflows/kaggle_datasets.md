# Kaggle Dataset Integration — ORACLE Workflow

## Objective

Download and integrate curated Kaggle football datasets to close ORACLE's data gaps:
- xG coverage beyond top-5 leagues
- Asian Handicap + line-movement features
- SPI attack/defense ratings (pi-ratings substitute)
- Squad market values
- Player lineups (soft context)
- Extended historical backfill (pre-2015)

---

## Prerequisites

1. **Kaggle CLI installed:**
   ```
   pip install kaggle
   ```
2. **Kaggle API credentials** in `~/.kaggle/kaggle.json`:
   ```json
   {"username": "<your-username>", "key": "<your-api-key>"}
   ```
   Get from: https://www.kaggle.com/settings → API → Create New Token

3. **API-Football key** (for lineups) in `.env`:
   ```
   API_FOOTBALL_KEY=<your-key>
   ```
   Free tier (100 calls/day): https://www.api-football.com

---

## Phase 1 — Highest-Impact Datasets (GBM gate blockers)

Run these in order. Each step feeds the next.

### Step 1a — Extended Match History + Lower Leagues

**Dataset:** Club Football Match Data 2000–2025 (adamgbor)

```bash
mkdir -p .tmp/kaggle/club-football-2000-2025
kaggle datasets download -d adamgbor/club-football-match-data-2000-2025 \
  -p .tmp/kaggle/club-football-2000-2025 --unzip
```

Then ingest into backfill:
```bash
python tools/backfill_oracle.py \
  --source kaggle \
  --kaggle-dir .tmp/kaggle/club-football-2000-2025
```

**Also recommended:**
```bash
# mexwell — 22 leagues, 25 seasons, referee data
kaggle datasets download -d mexwell/historical-football-resultsbetting-odds-data \
  -p .tmp/kaggle/mexwell --unzip

# Championship full dataset
kaggle datasets download -d panaaaaa/english-premier-league-and-championship-full-dataset \
  -p .tmp/kaggle/championship --unzip

# 30-year odds
kaggle datasets download -d laisassini/soccer-bet-all-euro-data-from-1993-to-2023 \
  -p .tmp/kaggle/euro-bet-1993 --unzip
```

---

### Step 1b — Asian Handicap + Line-Movement Features

**Dataset 1:** Beat The Bookie (32 bookmakers, hourly, 72h window)

```bash
kaggle datasets download -d austro/beat-the-bookie-worldwide-football-dataset \
  -p .tmp/kaggle/beat-the-bookie --unzip
```

**Dataset 2:** AH Odds Time-Series (5 leagues, 15 books, opening→closing)

```bash
kaggle datasets download -d realsingwong/european-football-asian-handicap-odds-time-series \
  -p .tmp/kaggle/ah-odds --unzip
```

**Process both:**
```bash
python tools/fetch_odds_timeseries.py \
  --btb-dir .tmp/kaggle/beat-the-bookie \
  --ah-dir  .tmp/kaggle/ah-odds
```

Output: `.tmp/odds-timeseries/odds_timeseries_features.csv`
GBM features added: `line_movement_slope`, `opening_to_close_delta`, `ah_open_line`, `ah_close_line`, `ah_close_delta`

---

### Step 1c — SPI Attack/Defense Ratings (pi-ratings substitute)

FiveThirtyEight SPI data is auto-fetched from GitHub (no Kaggle auth needed):

```bash
python tools/fetch_spi.py
```

Or use Kaggle dataset as backup:
```bash
kaggle datasets download -d thedevastator/club-soccer-predictions-spi-ratings-and-forecast \
  -p .tmp/kaggle/spi --unzip

python tools/fetch_spi.py --local-dir .tmp/kaggle/spi
```

Output: `.tmp/spi/spi_features.csv` + per-div/season files
GBM features added: `home_spi_off`, `home_spi_def`, `away_spi_off`, `away_spi_def`, `spi_off_diff`, `spi_def_diff`

---

### Step 1d — PPDA + npxG (pressing + non-penalty xG)

**Dataset:** Extended Football Stats for European Leagues xG (slehkyi)

```bash
kaggle datasets download -d slehkyi/extended-football-stats-for-european-leagues-xg \
  -p .tmp/kaggle/xg-ppda --unzip
```

Merge into existing xG pipeline:
```bash
python tools/fetch_xg.py --kaggle-ppda-dir .tmp/kaggle/xg-ppda
```

GBM features added: `ppda`, `npxg_home`, `npxg_away`

---

## Phase 2 — Soft Context + Squad Quality

### Step 2a — Squad Market Values (Transfermarkt)

```bash
kaggle datasets download -d davidcariboo/player-scores \
  -p .tmp/kaggle/player-scores --unzip

python tools/fetch_transfermarkt.py \
  --player-scores-dir .tmp/kaggle/player-scores
```

Output: `.tmp/transfermarkt/squad_value_ratio.csv`
GBM feature added: `squad_value_ratio` (home_squad_value / away_squad_value)

---

### Step 2b — Lineups (Soft Context — requires API key)

Runs automatically 60–75 min before kick-off in the daily worker:

```bash
python tools/fetch_lineups.py
```

Or for a specific fixture:
```bash
python tools/fetch_lineups.py --fixture-id 12345
```

Output: `.tmp/lineups/today_summary.json` + `.tmp/oracle-store/oracle_lineups.json`
Injected into LLM decision prompt: formations, confirmed XI, defensive shape scores.

---

### Step 2c — FBref Player Stats (PPDA, Progressive Passes)

```bash
# 2025-26 (auto-updated weekly)
kaggle datasets download -d hubertsidorowicz/football-players-stats-2025-2026 \
  -p .tmp/kaggle/fbref-2526 --unzip

# 2024-25
kaggle datasets download -d hubertsidorowicz/football-players-stats-2024-2025 \
  -p .tmp/kaggle/fbref-2425 --unzip
```

Process to team-level aggregates (add to GBM features in future sprint).

---

## Phase 3 — Match Events + Advanced Analytics

### StatsBomb Open Data (event-level, shot locations)

```bash
kaggle datasets download -d saurabhshahane/statsbomb-football-data \
  -p .tmp/kaggle/statsbomb --unzip
```

Used to build an in-house xG model for non-Understat leagues.

### Referee History

```bash
kaggle datasets download -d gokhanergul/football-match-statistics \
  -p .tmp/kaggle/match-stats --unzip
```

Builds `ref_avg_cards` + `ref_foul_rate` lookup for GBM feature `ref_strictness_percentile`.

---

## Phase 3 ML Feature Layers (3A–3F)

Six targeted feature layers filling concrete gaps in the GBM feature matrix. Each
follows the same pattern: fetch tool → CSV → `load_X()` loader → `build_features()`
param → `--no-X` flag. All join via `_normalise_team()` (the shared TM↔fdco bridge).

| Phase | Feature | Tool | Status |
| --- | --- | --- | --- |
| 3A | HKJC AH line + 15-book consensus (`hkjcAhLine`, `ahConsensus15`, `ahSharpSoftGap`) | extend `fetch_odds_timeseries.py` | **BLOCKED — data unavailable.** The public `realsingwong` Kaggle download is only a 90-match `sample/` (EPL/LaLiga/SerieA, 2024-25), with **Chinese team names** and obfuscated bookmaker codes. The 700 MB full set the README describes is not actually hosted. Not buildable without another AH source. |
| 3B | FTE/SPI calibrated probabilities (`prob1/prob2/probtie`, SPI off/def ratings) | `fetch_spi.py --local-dir` | **DONE** — `saurabhshahane/soccer-prediction-dataset` (538 soccer-spi CSV) loaded via existing loader. 45,109 match rows, 2016–2021. GBM SPI join 20.1%. |
| 3C | PPDA pressing (`ppdaHome/Away/Diff`, `oppdaHome/Away`) | `fetch_ppda.py` | **DONE** — 10,850 match rows, top-5, 5% coverage. |
| 3D | Squad availability (`availIdxHome/Away`, `keyPlayerHome/Away`, `availIdxDiff`) | new `fetch_squad_availability.py` | **DONE (redesigned)** — see below. |
| 3E | Reverse line movement (`mlHomeDrift`, `mlDrawDrift`, `mlReverseLM`) | new `fetch_reverse_lm.py` | **DONE** — `eladsil/football-games-odds` moneyline snapshots. 2,379 matches, 9 leagues; GBM RLM join 4.4% (dataset spans 2016–2018). |
| 3F | Match-day weather (`tempC`, `precipMm`, `windKph`, `isAdverse`) | new `fetch_weather.py` | **DONE** — Open-Meteo, no key. |

### 3D — Squad Availability (redesigned)

The original plan (per-match availability from a player-season injuries file) was
unbuildable — `injuries/dataset.csv` has no club or match-date keys. Rebuilt from
the Transfermarkt `player-scores` dataset (already downloaded):

```bash
python tools/fetch_squad_availability.py --kaggle-dir .tmp/kaggle/player-scores
```

- Matchday squad value = sum of each lineup player's latest market value ≤ match date.
- `availability_idx` = matchday squad value / **rolling-peak** squad value (expanding
  max of prior matches, anti-leakage). 1.0 = at peak strength; <0.7 = depleted.
  Prototype variance on D1: mean 0.79, std 0.18, 28% of matches < 0.70.
- `key_player_present` = is the club's top-valued rostered player in today's squad (1/0).
- Top-5 leagues only; club names mapped to fdco canonical via `TM_CODE_TO_FDCO`
  (Transfermarkt `club_code` → fdco short name — the single TM↔fdco bridge, also
  reusable for the OTS name-gap fix).

**Also wired live (2026-07-07, audit PR-6, not just the offline GBM trainer):**
`tools/acquire_daily.py`'s `_maybe_fetch_squad_availability()` refreshes
`availability_features.csv` during daily acquisition when
`ORACLE_FETCH_SQUAD_AVAILABILITY=on` (off by default — requires
`.tmp/kaggle/player-scores/` already downloaded). `scrape_fixtures.py` then
looks up each team's MOST RECENT row (there's no "today's" row for a fixture
that hasn't been played yet — this is a recency proxy, not a live lineup feed)
and merges it into the sidecar as `stats.availability.{home,away}.idx` /
`.keyPlayerPresent`, same pattern as the existing xG-table merge.
`apps/worker/src/index.ts`'s `buildGoalsV3Input` reads `idx` into
`V3LambdaInput.homeAvailabilityMult`/`awayAvailabilityMult`
(`packages/engine/src/goalsV3/lambda.ts`), applied as a multiplier on the raw λ
before shrinkage — a real, tool-derived replacement for the legacy engine's
`injPenH`/`injPenA`, which is an LLM guess. Top-5 domestic leagues only; other
fixtures simply get no mult (no-op, λ unchanged).

### 3F — Match-Day Weather

```bash
python tools/fetch_weather.py --backfill-dir .tmp/backfill
```

- Open-Meteo archive API (`archive-api.open-meteo.com/v1/archive`) — free, no key.
- City-level coordinates per home team (`TEAM_CITY`, ~150 top-5 + English clubs).
- Responses cached by `(lat, lon, date)` to `.tmp/weather/cache/` — re-runs hit disk.
- `is_adverse` = precip > 5 mm OR wind > 50 km/h.
- 19.5k unique (date, home) matches in scope; throttle 0.1–0.2 s between live calls.

### 3E — Reverse Line Movement

```bash
kaggle datasets download -d eladsil/football-games-odds -p .tmp/kaggle/reverse-lm --unzip
python tools/fetch_reverse_lm.py --src-dir .tmp/kaggle/reverse-lm
```

- `Matches_Odds.csv` = one row per moneyline snapshot (`date_created` timestamp).
- Per match: de-vig each snapshot, take opening (earliest) vs closing (latest).
- `mlHomeDrift` = closing home implied-prob − opening; `mlReverseLM` = 1 when the
  line moves against the opening favourite (favourite weakens, or underdog firms).
- English team names join fdco directly via `_normalise_team`. 9 leagues mapped
  in `COMP_TO_DIV`; dataset spans 2016–2018 so GBM coverage is ~4%.

### 3B — SPI / FTE Probabilities (Kaggle mirror)

`fivethirtyeight.com` is dead, but the soccer-spi CSV lives on in a Kaggle mirror:

```bash
kaggle datasets download -d saurabhshahane/soccer-prediction-dataset -p .tmp/kaggle/fte --unzip
python tools/fetch_spi.py --local-dir .tmp/kaggle/fte/soccer-spi
```

No new tool — `fetch_spi.py --local-dir` already accepts the `spi_matches.csv`
from this download and the existing `load_spi_features()` loader joins it.

### 3A — STILL BLOCKED (data does not exist publicly)

The `realsingwong` AH time-series Kaggle download is a **90-match `sample/` only**
(EPL/LaLiga/SerieA, 2024-25), with Chinese team names and obfuscated bookmaker
codes — the 700 MB full set its README describes is not hosted. No fix without a
different AH-odds source; do **not** waste a build attempt on the sample.

```bash
# (download confirms the limitation — it is the sample, not the full set)
kaggle datasets download -d realsingwong/european-football-asian-handicap-odds-time-series -p .tmp/kaggle/ah-timeseries --unzip
```

---

## Verification After Each Phase

```bash
# Confirm new features appear in GBM output
python tools/gbm_residual.py --dry-run

# Run walk-forward backtest with new features
python tools/walkforward_backtest.py

# Gate: thin-market RPS delta target ≥ +0.002
# (current baseline: +0.0007 for Championship/Belgian/Scottish)

# Full pipeline check
pnpm turbo run typecheck test build
```

---

## Dataset Catalogue Reference

Full audit with 45 datasets across 4 tiers, ORACLE gap mapping, and integration notes:
See: `.claude/plans/analyze-and-audit-all-dynamic-sedgewick.md`

| Tier | Datasets | Key Feature |
|---|---|---|
| 1 (Critical) | Beat The Bookie, AH Time-Series, mexwell, Club Football 2000–2025, slehkyi xG/PPDA, Understat mirror, StatsBomb | Line movement, AH, backfill, PPDA, events |
| 2 (High Value) | Transfermarkt, 5.7M records, FBref 2025-26, SPI, Euro Bet 1993–2023, Championship | Squad values, injuries, pressing, pi-ratings |
| 3 (Supplement) | FBref FBRef, Sofascore+TM, injury datasets, match stats | Cross-validation, soft context |
| 4 (Low Priority) | VAR data, stadium locations, market value prediction | Weather API lookup, VAR signals |

---

## Edge Cases

- **Column name mismatches:** Kaggle datasets vary in column naming. All tools use `_find_col()` fuzzy matching against a candidate list. If a new dataset uses unusual names, extend the candidates list in the relevant tool.
- **Duplicate rows:** Kaggle datasets often overlap with football-data.co.uk CSVs. `backfill_oracle.py` uses a content-hash deduplication key (`match_id = hash(date+home+away+div+season)`).
- **Kaggle quota:** Kaggle API has no hard quota for public dataset downloads. Large datasets (Beat the Bookie ~700MB, Club Football ~1GB) may take 2–10 minutes to download.
- **API-Football lineup timing:** Lineups are released 60–70 min pre-kick. Running `fetch_lineups.py` before this window returns empty `startXI` arrays (confirmed=False). The tool skips fixtures outside the `--minutes-before` window automatically.
