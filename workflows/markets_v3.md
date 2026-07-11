# SOP: All-Markets v3 Deterministic Engine

## Objective

Implement `all-markets-analysis-prompt-v3` (owner-supplied spec) as deterministic script math instead of LLM probability estimation — for prediction accuracy, latency, and token cost. This doc maps spec sections → code, records what shipped vs what's deferred, and is the entry point for anyone extending the engine or diagnosing a live batch.

## Status: v3 shipped (#29–#35), v4 upgrade shipped (#40–#44 + PR-7/PR-8), `ORACLE_MARKETS_V3` defaults **on**

**v3 foundation (#29–#35):**

| Phase | PR | What |
|---|---|---|
| P1 | #29 | Data foundation — typed corners/cards/BTTS%/CS%/FTS%/1H-share/OU-hit-rate fields through `StatsOverride`; xG estimated-fallback; `goalsFunnel.ts` news-intel fix |
| P2 | #30 | Core deterministic engine — `packages/engine/src/marketsV3/` (grid, dual split, feed dictionary, engines 3.3–3.8, S/M/L/X classes, tiered EV gate) |
| P3 | #31 | Pipeline integration — wired into `decide()` via `batch/index.ts`, `ORACLE_MARKETS_V3` flag (default `on`), standalone eligibility/completeness gate library |
| P4 | #32 | LLM demotion — Q4 catalogue-dump executor suppressed when v3 supplies a fixture's candidates; arbiter gets ≤5 gate-survivors instead |
| P5 | #33 | Goals-batch verification arbiter (R10) — `crossCheckGoalsPick()`, downgrade+re-gate semantics |
| P6 | #34 | Slate-level Phase 7/8 outputs — Output A/B/C/D construction, chunk/final status lines |
| P7 | #35 | Conditional corners (Negative Binomial) + cards (Poisson) modules |

**v4 upgrade (#40–#44 + PR-7/PR-8) — activates what P6/P7 built dormant + closes the v4 spec deltas:**

| PR | What |
|---|---|
| PR-2 #39 | HFA term (×1.10) in the λ core (Under-skew root cause) + venue-split provenance flag; cold-deploy via `ORACLE_V3_HFA`/`ORACLE_V3_VENUE_SPLIT` |
| PR-3 #40 | Gates v4 — heightened youth/friendly EV bars, sample-scaled blend, exact/multigoals odds-band classing, `sanity.ts` slate checks (`ORACLE_V3_GATES_V4`) |
| PR-4 #41 | Completeness v4 — O/U hit-rate demoted from mandatory (critical-tier penalty, not discard) + per-selection line hit-rates (`ORACLE_V3_COMPLETENESS_V4`) |
| PR-5a #42 | Slate gate pre-filter — v3 eligibility+completeness gate over the daily slate before the chunk loop, fail-open (`ORACLE_MARKETS_V3_GATE`); **closes old gap 1** |
| PR-5b #43 | Outputs A–D + sanity assembly wired into delivery (`ORACLE_MARKETS_V3_OUTPUTS`); **closes old gaps 2 + partial** |
| PR-6 #44 | R10 goals cross-check wired via DI hook + corners/cards O/U routed (`ORACLE_V3_GOALS_CROSSCHECK`, `ORACLE_V3_CORNERS_CARDS`); **closes old gaps 3 + 4** |
| PR-7 | Calibration feedback loop — settles resolved picks into the ledger; activates dormant `calibFactor` + isotonic 1x2 (`ORACLE_CALIBRATION_LEDGER=off\|shadow\|on`, default shadow) |
| PR-8 | LLM demote/gate posture A — skip draft cascade when v3 supplied candidates (`ORACLE_V3_DETERMINISTIC_DRAFT`), arbiter top-N only, extras tier-gated (`ORACLE_LLM_EXTRAS_TIERS`); generic lake-source soft-context fallback |

## Spec → code map

| Spec section | Module |
|---|---|
| Rule 0 (data integrity) | `feedDictionary.ts` (`isSkip`) — unmapped markets are skipped, never guessed |
| §0.3/§0.4 (reliability tiers, completeness gate) | `packages/runtime/src/marketsV3/pipeline.ts` (`gateMarketsV3Fixture`), reusing `goalsV3/completeness.ts` |
| §1/§1.2 (eligibility) | `packages/runtime/src/goalsV3/eligibility.ts` (`classifyEligibility`), reused as-is |
| §2 (prioritisation) | `packages/engine/src/marketsV3/prioritise.ts` |
| §3.1 (λ) | `packages/engine/src/goalsV3/lambda.ts` (`computeV3Lambdas`), reused |
| §3.2 (dual split) | `packages/engine/src/marketsV3/split.ts` (`deriveDualSplit`), wraps `goalsV3/matchShape.ts` |
| §3.3–§3.8 (engines) | `packages/engine/src/marketsV3/engines/{totals,result,shape,half,time,exotics}.ts` |
| §3.9 (corners/cards) | `packages/engine/src/marketsV3/engines/{corners,cards}.ts` — **routed (PR-6)** via `feedDictionary.routeMarket` for plain O/U total lines; `ORACLE_V3_CORNERS_CARDS=off` withholds stats to keep dormant |
| §4 (de-vig, classes) | `packages/engine/src/marketsV3/{evGate,classes}.ts` |
| §5 (EV gate) | `packages/engine/src/marketsV3/evGate.ts` (`gateAllMarkets`); v4 heightened bars + sanity in `sanity.ts` (PR-3) |
| §6 (discard/abstain) | Implicit — a fixture with no `V3AllMarketsResult.best` is a valid no-bet outcome throughout |
| §7 (outputs A/B/C/D) | `packages/engine/src/marketsV3/outputs.ts` — **wired into delivery (PR-5b)** behind `ORACLE_MARKETS_V3_OUTPUTS` |
| §8 (status/summary) | `outputs.ts` (`formatChunkStatus`, `formatFinalSummary`) — **called from the worker (PR-5b)** |
| R10 (goals cross-check) | `packages/runtime/src/marketsV3/goalsCrossCheck.ts` — **wired via DI hook (PR-6)**; `buildGoalsCrossCheckHook` in the worker → `runAnalysis` deps → `runBatch` |
| §8.3/§8.4 (calibration) | `packages/engine/src/calibration/index.ts` (`CalibrationEngine`, `isotonicCalibrateFp`); **fed live (PR-7)** by `packages/runtime/src/calibrationFeed.ts` (`appendResolvedToLedger`) + read by `runAnalysis` |
| LLM posture A (demote) | `decide()` opts `{skipDraftLlm, skipArbiter}` (PR-8) — draft cascade skipped when v3 supplied candidates, arbiter top-N only |

## Env flags

| Var | Default | Effect |
|---|---|---|
| `ORACLE_MARKETS_V3` | `on` | `on`: v3 replaces `eligible` for `decide()` per fixture (fail-open to legacy on any error/empty result). `shadow`: v3 runs, output discarded, legacy path acts. `off`: v3 never runs — byte-identical to pre-v3 behavior. |
| `ORACLE_MARKETS_V3_COMPLETENESS_MIN` | `70` | Weighted §0.4 completeness floor (0–100) for `gateMarketsV3Fixture` |
| `ORACLE_MARKETS_V3_HEIGHTENED_MIN` | `85` | Floor for heightened fixtures (youth/women/friendly/cup-final) |
| `ENABLE_LLM_MARKET_EXECUTOR` | `false` | Legacy Q4 catalogue-dump executor — auto-suppressed per-fixture when v3 supplies that fixture's candidates (P4); still fires normally when v3 is off/shadow/declined |
| `ORACLE_V3_HFA` | `1.10` | v4 §3.1a home-field-advantage multiplier in the λ core. `1.0` disables (cold-deploy) |
| `ORACLE_V3_VENUE_SPLIT` | `off` | `on` when input λ already carries venue splits (suppresses the HFA multiplier) |
| `ORACLE_V3_LAKE_BASELINES` | `off` | Audit P0-2: `on` prefers lake-computed per-league goal baselines (from `tools/compute_league_baselines.py` → `.tmp/oracle-store/league_baselines.json`) over the static `V3_LEAGUE_BASELINES` table in `lambda.ts`; static stays the fallback for absent leagues. Fails open to static if the JSON is missing/unusable. Run the tool's `--report` first to see the pricing diff |
| `ORACLE_V3_LAKE_HFA` | `off` | Full-audit P3: `on` uses per-league HFA multipliers fitted from the lake (`hfaByName`, m = √(home gpg / away gpg), clamped [1.0, 1.30]) instead of the global `ORACLE_V3_HFA` for the all-markets λ core; falls back to the global for absent leagues. Only affects the all-markets pipeline (goals-only passes no HFA). Fails open to the global if the JSON lacks `hfaByName` |
| `ORACLE_V3_BLEND` | `on` | Wave-1 P0-2 (v5 §5.8) market-anchored blend. Computes `wModel=min(0.40, 0.15+0.15·completeness+0.10·realXg)`, `pBlend=(1−w)·q_fair+w·P_model`, `blendEdge` on every candidate (persisted in all modes). `on` additionally enforces `blendEdge≥+5%` as a mandatory gate at odds≥4.00 (on top of Class L/X bars) — the longshot-inflation fix; `shadow` computes+reports but doesn't gate; `off` skips. Never lowers a bar. |
| `ORACLE_SAFETY_MODE` | `penalty` | Wave-1 P0-3. `penalty`: former MLSafetyFilter hard rejects (odds-band, low-xG, draw-risk, derby/injury, upset-league, sharp-fade, miscalibration) become market-family stake downgrades via `familyPenaltyMultiplier`. `legacy`: restores the old fixture-wide hard rejects (rollback lever). Contamination/missing-mandatory-data/promo markets stay hard rejects in both modes. |
| `ORACLE_FEED_INTEGRITY` | `on` | Wave-1 P1-3 (v5 Rule 0.14). `on`: `runFeedIntegrity` runs in `prefilterMarketsV3Jobs` — SRL-twin (≥90% odds identity), fixtures-vs-markets headline 1X2 cross-check, duplicate-block scan; contamination is an integrity-class hard reject (headline-markets-only rescue). `shadow` reports without acting; `off` skips. Replays the 2026-07-09 France v Morocco incident. |
| `ORACLE_V3_BLEND_PRICING` | `on` | Wave-4-accuracy (v5.1 §5.3). `on`: market-anchored blend applied to **every** candidate (not just odds≥4.00) — gates/EV/confidence/ranking/Kelly-stake all evaluate on `pBlend` with rescaled `CLASS_GATE_BLEND` bars (S≥1.0/M≥1.5/L≥2.0pt; heightened ×1.30; Class X unreachable by construction). Implausible-edge caps + noise floor stay on RAW edge (hard invariant: blending never resurrects a capped pick). `off` = byte-identical legacy raw-edge gating (rollback). Fixes fake soft-market edges (Highest Scoring Half). |
| `ORACLE_V3_TOTALS_EMPIRICAL` | `on` | Wave-4-accuracy (v5.1 §3.3). `on`: goals O/U 1.5/2.5/3.5 blend empirical hit-rates via `blendEmpirical` (`w=0.3·min(n,5)/5`), same convention shape markets use for BTTS%/CS%. **Goals counter only** — corners/cards/team-total reuse of the O/U pricer stays model-only. `off` = model-only totals (prior behavior). |
| `ORACLE_V3_GATES_V4` | `on` | v4 heightened EV bars, exact/multigoals odds-band classing, slate sanity checks. `off` restores v3 gate semantics |
| `ORACLE_V3_COMPLETENESS_V4` | `on` | Demotes O/U hit-rate out of the mandatory completeness block (critical-tier penalty, not discard) + per-selection line hit-rates. `off` restores v3 |
| `ORACLE_MARKETS_V3_GATE` | `on` | PR-5a slate pre-filter over the daily slate before the chunk loop (fail-open). `off` analyzes the ungated slate |
| `ORACLE_MARKETS_V3_OUTPUTS` | `on` | PR-5b Outputs A–D assembly into delivery. `off` keeps the legacy 39-cap trim (regression pin) |
| `ORACLE_V3_CORNERS_CARDS` | `on` | PR-6 corners/cards O/U pricing. `off` withholds the stats so the routed modules stay dormant |
| `ORACLE_V3_GOALS_CROSSCHECK` | `on` | PR-6 R10 goals cross-check on the all-markets batch. `off` skips the hook |
| `ORACLE_CALIBRATION_LEDGER` | `shadow` | PR-7 calibration loop. `shadow` = write-only (settle picks, log would-be metrics, no live change); `on` = also apply calibFactor+isotonic; `off` = inert |
| `ORACLE_LEDGER_MAX` | `2000` | PR-7 max persisted ledger rows (pruned oldest-first per resolve) |
| `ORACLE_V3_DETERMINISTIC_DRAFT` | `on` | PR-8 posture A — skip the paid draft LLM cascade when v3 supplied candidates (arbiter still reviews top-N). `off` restores the full LLM draft cascade |
| `ORACLE_LLM_EXTRAS_TIERS` | `apex` | PR-8 tier scope for optional LLM extras (briefing/swarm/CVL). `apex` = APEX only; `all` = the route's own tier decisions |
| `ORACLE_CALIBRATION_EPOCH_START` | `2026-07-10` | Wave-2 P0-1. ISO date marking the Wave-1 P0-2/P0-3 pricing-behavior boundary — per-segment calibration (`ORACLE_CALIBRATION_LEDGER=segment` mode) only accumulates `{n,wins,pSum}` from picks stamped on/after this date, so pre-epoch records (old pre-blend, pre-penalty pricing) don't poison segment factors |
| `ORACLE_V3_RATINGS` | `shadow` | Wave-2 P1-1. pi-ratings blend into `goalsV3` lambda. `shadow`: diagnostic deltas logged only, pricing unaffected. `on`: blend is live. `off`: skipped entirely. Live only after clearing the +0.002 RPS walk-forward significance bar — never hand-flipped |
| `ORACLE_SHARP_FEED` | `shadow` | Wave-2 P1-4. Sharp-reference odds feed (Odds API primary + Playwright/Google-AI-Mode fallback). `shadow`: persists CLV records without being the criterion that flips `ORACLE_SHARP_FEED_VERIFIED`. `on`/`off` per the standard tri-state contract |
| `ENABLE_BRIEFING` / `ENABLE_CVL` | `false` | PR-8 made the previously-dead B1 briefing / B2 CVL layers explicit + opt-in |
| `ORACLE_FETCH_INJURIES` | `off` | PR-8 — `on` runs `tools/fetch_injuries.py` (season injury-burden features) in the acquisition chain, best-effort |
| `ORACLE_FETCH_LIVE_XG` | `on` | (PR-7) `on` runs FotMob live-xG (`fetch_fotmob_xg.py`, 1000+ comps, headless) + rebuilds the rolling xG prior (`build_xg_table.py`), filling obscure-league xG gaps. Runs from its own standalone 02:00 WAT worker cron (`acquire_daily.py --live-xg-refresh`, reads the on-disk sidecar for team names), NOT inline in the 09:30 acquisition — decoupled so its Playwright browser-page swarm never stacks with the 09:30 job's own (was the BSOD risk this defaulted off for). Best-effort. |
| `ORACLE_FETCH_XG_FALLBACK` | `on` | (PR-19) After the FotMob+rebuild pass above (same 02:00 WAT window), runs the Google-AI-Mode xG fallback (`fetch_xg_fallback.py`) over the RESIDUAL team list — those still missing xG after Understat/FotMob/Sofascore/FBref — then re-runs `build_xg_table.py` so the new `google_ai` tier merges as the last, lowest-confidence fill (never overwrites a real-tier team). SRL/virtual teams are excluded from the residual list before it's even sent. `off` = byte-identical to pre-PR-19 behavior. |
| `ORACLE_XG_FALLBACK_MAX_TEAMS` | `25` | (PR-19) Cap on residual teams sent to the AI-Mode fallback per run — each is a real Playwright page load against Google AI-Mode. |
| `ORACLE_MARKETS_COVERAGE` | `on` | (PR-20) Slate-wide route-coverage rollup (`rollupCoverage`) — reports total/routed/priced/gate-passed market counts + the top-5 recoverable "unrouted" market names in `RunManifest.marketCoverage` and the Telegram summary's `marketCoverageNote` line. Pure telemetry, never gates a pick. `off` skips the rollup computation entirely (byte-identical manifest/summary to pre-PR-20). |
| `ORACLE_CATALOG_OVERLAY` | `off` | (PR-21) Loads `.tmp/market_catalog_overlay.json` (written by the Saturday `build_market_catalog.py --diff-only --json-out` step, always-on advisory) into `@oracle/engine`'s runtime catalog overlay (`extendCatalog`) at worker startup — fills `lookupMarket`/`familyOf`/`isPriceable` for markets observed since the committed `catalog.generated.ts` was last regenerated. The committed catalog always wins on lookup; the overlay only fills genuine gaps. Default **off** until PR-20's coverage data shows the `uncatalogued` skip tail is material enough to matter live. |

Rollback: set `ORACLE_MARKETS_V3=off` for the whole engine, or flip any single v4 flag above to its `off`/`1.0` value — each PR is independently reversible. The legacy `scanMarkets` path in `packages/engine/src/execution/index.ts` was never touched by this work.

## Known gaps (deliberate scope reductions, not oversights)

Old gaps 1–4 (slate pre-filter, outputs A–D, R10 cross-check, corners/cards routing) were all **wired by the v4 upgrade** (PR-5a/5b/6 — see the v4 table above). Remaining deliberate scope reductions:

1. **Goals-pipeline "Output B"/"Output C" naming** (`apps/worker/src/index.ts`) predates this spec, uses different numbering (its B/C ≈ this spec's C/D), and collides cosmetically with the new A/B/C/D scheme. Not renamed — touches 10 files including `apps/web` and `apps/bot`.
2. **Calibration is shadow-first** — PR-7 defaults `ORACLE_CALIBRATION_LEDGER=shadow`: the ledger fills and would-be `calibFactor`/isotonic deltas are logged, but the engine still runs at `calibFactor=1.0`. Flip to `on` only after 1–2 weeks of shadow logs look sane (or seed ≥30 resolved samples via `tools/backfill_oracle.py` to activate isotonic immediately).
3. **Corners/cards settlement into the ledger** — PR-7's `settlePick` settles families derivable from the final 1x2 score (match_result/DC/DNB/goals O/U/BTTS/team_total/correct_score — the audit-fix pass confirmed correct_score is a pure exact-scoreline check, same shape as the rest). Corners, cards and half-scoped markets stay skipped+counted (no post-match ground truth captured — corner/card counts and half-time score aren't in `ResolutionRecord`). Asian handicaps are goals-derivable too but stay skipped: the handicap line often lives only in the market specifier, which isn't persisted onto the stored pick — see `calibrationFeed.ts`'s header for the full reasoning.
4. **Slate-level daily-batch arbiter (posture B)** — a single flat-cost LLM call replacing the per-fixture arbiter was considered and deferred (owner decision D2) until posture A (PR-8) proves stable.

None of these gate the live `ORACLE_MARKETS_V3=on` default — the full per-fixture pricing/gating/outputs/cross-check pipeline is wired and drives `decide()` today.

## HTML report vs xlsx workbook (which is the LLM feed)

The engine + LLM consume the **Parquet lake + SportyBet sidecar directly** — neither rendered report is the analysis feed. The **xlsx workbook** (`packages/runtime/src/fixtureWorkbook.ts`: Fixtures ~90 cols + Markets tab) is the canonical LLM-readable delivery artifact; the **HTML report** (`report.ts`) stays human-facing. No code change — documented per the v4 plan (Known Gap 9).

## Verification

Every phase passed the full pipeline before merging:
```bash
pnpm turbo run typecheck test build --concurrency=1   # OOM constraint on Windows — always use --concurrency=1
pnpm exec biome ci .                                   # catches import-order regressions pre-commit misses
```
Golden-fixture tests anchor Phase 3/5 math to the spec's own worked examples (`packages/engine/test/marketsV3.test.ts`). Batch-wiring seams are verified with mocked `analyzeFixtureMarketsV3`/`runAllMarketsLlmExecutor` (`packages/engine/test/marketsV3BatchIntegration.test.ts`) so they're deterministic independent of the real engine's output.

## Recommended next step: walk-forward backtest

The engine went live immediately (owner decision — no shadow-mode gate before cutover). To validate it in production, run the walk-forward comparison described in `workflows/backtest.md` once enough resolved fixtures have accumulated under `ORACLE_MARKETS_V3=on` (at minimum 1–2 weeks of daily batches, ideally covering multiple leagues/market classes):

1. Pull resolved fixtures + their v3 `assessments`/`best` picks from `.tmp/oracle-store` (persisted by `runAnalysis`) for the live window.
2. Compare hit-rate and CLV against the equivalent legacy-`scanMarkets` picks for the same fixtures (re-run with `ORACLE_MARKETS_V3=off` on the same historical odds snapshot — `tools/backfill_oracle.py` / `workflows/backtest.md` cover the harness).
3. Segment by market class (S/M/L/X) — the tiered EV gate's thresholds (§5.2) are the main lever if any class is mis-calibrated; adjust `V3_ALLMARKETS_PENALTY_PTS`/`CLASS_GATE` in `evGate.ts` rather than the probability engines themselves if hit-rates diverge from the gate's implied confidence.
4. If v3 underperforms legacy on any class, the fastest safe lever is `ORACLE_MARKETS_V3=shadow` (keeps v3 running for continued data collection without affecting live picks) rather than a full rollback.

This is a recommendation, not something this session could execute — it requires real elapsed time and resolved match outcomes that don't exist yet.

## v4 deltas (planned)

The v3 engine above already implements ~80% of the v4 specs (`docs/prompts/goals-market-analysis-prompt-v4.md`, `docs/prompts/all-markets-analysis-prompt-v4.md`; root-cause audit in `docs/prompts/v4-audit-report.md`). Headline finding: **no home-field-advantage (HFA) term in the core λ engine**, producing a systematic Under-skew (83/17 Under/Over among >5pt signals) and, via the dual-split rule, underrating home favourites across the DNB/DC/handicap "insurance mandate" markets. Tracked as a 9-PR stacked train (PR-1 through PR-8, PR-7 parallel); each row below flips from "planned" to "shipped" as its PR lands.

| PR | Delta vs current v3 | Status |
|---|---|---|
| PR-1 | Docs: v4 specs + audit report copied in; PR #14 / `fix/llm-arbiter-full-market-decisioning` audited and closed (no cherry-pick — collides with PR-7) | shipped |
| PR-2 | HFA term in `lambda.ts` (`ORACLE_V3_HFA`, default 1.10) + venue-split provenance (`ORACLE_V3_VENUE_SPLIT`) + expanded league baselines + worked-example parity tests | planned |
| PR-3 | Heightened EV bars for §1.3 youth/friendly fixtures, S/M-only mini-ACCA (excludes L/X), exact-goals/multigoals pricing, sample-scaled empirical blend, new `sanity.ts` slate sanity-check module | planned |
| PR-4 | Completeness v4 — hit-rate demoted mandatory→critical, per-selection line hit-rates (not just per-fixture) | planned |
| PR-5a | Slate-level fixture pre-filter (`pipeline.ts`) wired into `runDailyBatch` (`ORACLE_MARKETS_V3_GATE`) — closes Known Gap 1 above | planned |
| PR-5b | Outputs A–D + Phase 8 status lines wired into delivery (`ORACLE_MARKETS_V3_OUTPUTS`) + slate sanity checks in final summary — closes Known Gap 2 above | planned |
| PR-6 | R10 goals cross-check (`goalsCrossCheck.ts`) wired live (`ORACLE_V3_GOALS_CROSSCHECK`) + corners/cards routed instead of dormant-skipped (`ORACLE_V3_CORNERS_CARDS`) — closes Known Gaps 3 and 4 above | planned |
| PR-7 | Revive dead calibration feedback loop — `resolveDay` → ledger → `calibFactor`/isotonic activation + accuracy metrics (hit-rate/Brier/ECE/CLV) (`ORACLE_CALIBRATION_LEDGER=off\|shadow\|on`, default shadow). Independent lane, any time after PR-1. | planned |
| PR-8 | LLM demote/gate posture A — skip draft cascade when v3 supplies candidates, arbiter respects top-N cap (today runs for every fixture) — plus news/data gap closes and final doc pass | planned |

Full plan, decision log, and worked-example test additions: see the approved eng-review plan (owner-held; not checked into this repo). Rollback flags for each PR are additive — `ORACLE_MARKETS_V3=off` still restores pre-v3 behavior wholesale, as it does today.
