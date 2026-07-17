# ⭐ CURRENT — 2026-07-16 (3rd session): patterns-engine Wave 2 PUSHED + 3 stacked PRs OPEN (#70/71/72) — pre-PR review caught + fixed a critical Under-leak; owner review/merge + deploy still owed

> **Cold-read this first.** This supersedes the section immediately below (still accurate history for
> what Wave 2 phases 2/3/0 actually implement — read it for that). This session pushed the 3 branches
> that section left unpushed and opened the 3 stacked PRs it specified, but **did not just push as-is**:
> per CLAUDE.md's mandatory `/gstack-review` gate for diffs >50 lines, ran two independent adversarial
> review agents (Claude, parallel) against the full stacked diff before opening PRs. **Both independently
> found the same critical bug**: the Phase 3 Under→AH pivot's headline guarantee ("never recommend an
> Under") didn't actually reach the fixture's real, staked, delivered pick — `batch/index.ts`'s
> `bestAssessment`/`v3Best` (feeds the delivered slate/Telegram output) and `safety/pipeline.ts`'s
> `v3AssessmentsToEvMarkets` (the canonical Kelly staker feeding `eligible`/`decision.primaryPick`) both
> read raw `v3Result.assessments`, which `analyzeFixtureMarketsV3`'s Under-strip deliberately leaves
> untouched (only strips its own `evMarkets` return value, for transparency). A gate-passing Under could
> still win either path and become the real, real-money recommendation. **Fixed same session** (commit
> `d26ccf9`, on `feature/patterns-engine-wave2-telemetry`'s tip): both sites now apply the same
> `TOTALS_FAMILIES`/`dirOfDesc==="under"` exclusion already correctly used at `v3BestFallback`; 2 new
> regression tests added proving a high-edge "done" Under can no longer win `v3Best` or `eligibleBets`.
> Grepped every other production reader of `v3Result.assessments` afterward to confirm no third leak site
> exists (the only other reads are the pre-existing R10 goals cross-check, which runs upstream and only
> selects what to *interrogate*, not what gets delivered — and the structurally separate goals-only
> pipeline, a different type entirely, out of scope). Full verification: `pnpm turbo run typecheck test
> --concurrency=1` — 30/30 tasks green; engine 941/941 (was 939, +2); biome clean.

## What happened this session

- **Pushed** `feature/patterns-engine-wave2-gate` (7810b38), `feature/patterns-engine-wave2-ah-pivot`
  (41e98a8), `feature/patterns-engine-wave2-telemetry` (79a8f52, then +`d26ccf9` the fix commit).
- **Opened 3 stacked PRs**: [#70](https://github.com/ArchibongHQ/ORACLE-Agent/pull/70) (Phase 2, base
  `main`), [#71](https://github.com/ArchibongHQ/ORACLE-Agent/pull/71) (Phase 3, base `#70`'s branch),
  [#72](https://github.com/ArchibongHQ/ORACLE-Agent/pull/72) (Phase 0 + the post-review fix, base `#71`'s
  branch). PR bodies use the full commit messages plus explicit cross-references to the fix.
- **Set `.env`**: added `ORACLE_V3_PATTERNS=shadow` explicitly (was previously unset, relying on the code
  default) — matches `.env.example`'s documented default and this repo's established shadow-promotion
  discipline. Zero live effect either way until PR #70-72 merge and deploy (`.env` is gitignored, this
  edit is local-only, not part of any PR).
- **Did NOT**: merge any PR, rebuild, or restart services — per standing instruction, those stay owner
  actions.

## NEXT — owner action: review + merge 3 PRs (in stack order), then deploy

1. Review [#70](https://github.com/ArchibongHQ/ORACLE-Agent/pull/70) →
   [#71](https://github.com/ArchibongHQ/ORACLE-Agent/pull/71) →
   [#72](https://github.com/ArchibongHQ/ORACLE-Agent/pull/72) in that order (each is stacked on the
   previous — merging #70 first lets GitHub re-target #71 automatically, same for #71→#72).
2. After all 3 merge to `main`, deploy (same as every prior wave — elevated shell, owner-only):
   ```
   pnpm turbo run build --concurrency=1
   # then in an ELEVATED PowerShell:
   Restart-Service OracleWorker
   Restart-Service OracleBot
   ```
3. `ORACLE_V3_PATTERNS=shadow` is already set in `.env` (this session) — after deploy, run at least one
   real slate, review the `patternRelaxed:"shadow_pass"` tally + fill-to-39 pool composition in the slate
   report, confirm zero Unders anywhere in a real Telegram/report output, THEN flip to `on`. Never a
   hand-flip straight to `on` without shadow evidence (same discipline as X-carveout/sharp-feed/
   calibration-ledger).

═══════════════════════════════════════════════════════════════════════════════════════════════════

# ⭐ PRIOR — 2026-07-16 (2nd session): patterns-engine Wave 2 ALL 3 PHASES SHIPPED, committed on 3 stacked branches — NOT yet pushed/PR'd/deployed

> **Cold-read this first.** This supersedes the "Wave 2 is the next task" framing directly below (still
> accurate history — read it for full context on Wave 1 + the owner's locked decisions). This session
> (`/orchestrator`, 3 Sonnet subagents per the owner's instruction) implemented all three of Wave 2's
> planned phases from that section's kickoff prompt: Phase 2 (gate wiring + fill-to-39), Phase 3
> (Under→AH pivot), Phase 0 (streak/last5 telemetry). All locally committed, verified, adversarially
> reviewed. **Owner action needed: push the 3 branches + open the 3 stacked PRs** (commands below) —
> this session never pushes/PRs/deploys per standing instruction.

## What shipped this session — 3 commits on 3 stacked branches, none pushed yet

```
main (4e4c871)
 └─ feature/patterns-engine-wave2-gate       (7810b38)  Phase 2
     └─ feature/patterns-engine-wave2-ah-pivot (41e98a8)  Phase 3, stacked on Phase 2
         └─ feature/patterns-engine-wave2-telemetry (fad1afc)  Phase 0, stacked on Phase 3
```

- **Phase 2 (`7810b38`) — pattern-backed class-edge relaxation + fill-to-39.** `evGate.ts`'s
  `gateAllMarkets` gains `patternMode`/`patternBacked`/`patternStrength` opts — relaxes ONLY
  `CLASS_GATE_BLEND`'s `minAdjEdgeBlend`, scaled by the Wave-1 detector's strength (0.3 floor, up to
  50% relaxation at strength 1.0); every other bar (EV%, max odds, raw caps, noise gate) stays full
  strength, plus an explicit `ev>0` value floor on top (defensive-in-depth, provably redundant today
  given `evFloor=0`, but holds the line if that's ever loosened). Three modes via `ORACLE_V3_PATTERNS`
  (**default `shadow`**): off/shadow/on, shadow never admits. `analyzeFixtureMarkets.ts` builds the
  per-fixture `PatternInput` and conservatively matches each outcome against the detector's top
  pattern (anchored `descParse.ts` parsers, never substring). Fill-to-39: `batch/index.ts` derives
  `v3BestFallback` (best +EV candidate that failed ONLY the class_edge bar) for the slate pool.
  **Independent Opus adversarial review caught a critical bug before commit**: the first
  fallback-filter draft (`outcome !== "done"`) also admitted `"capped"`/`"noise"` outcomes — reopening
  the exact fake-longshot-edge door the 2026-07-09 HSH incident closed. Fixed to
  `outcome==="below_gate" && gateReason==="class_edge"` specifically; regression tests added. Also
  fixed a corners line-match substring bug the same review found (now anchored `lineOfDesc`).
  8 new gate-level tests (`patternGate.test.ts`) + 3 integration tests (`patternsIntegration.test.ts`).
- **Phase 3 (`41e98a8`) — Under→Asian Handicap pivot.** `analyzeFixtureMarketsV3` unconditionally
  strips every `goals_ou`/`team_total` Under from `evMarkets` before the final sort — flag-independent,
  not gated on `ORACLE_V3_PATTERNS` or the legacy `LOW_SCORING` regime classifier. **Deliberate
  engineering deviation from the original brief's literal wording**: does NOT call
  `math/index.ts`'s `detectLowScoringRegime`/`asianHandicapPivot` to synthesize a replacement line —
  those recommend a theoretical AH line with no guaranteed real offered odds, and pricing an EV
  against odds nobody offers would be dishonest real-money math. The genuine pivot is structural: a
  real AH pick is already priced+gated in the same per-outcome loop as every other market, so it
  already competes honestly in `evMarkets` and naturally becomes `best` once the Under is stripped —
  no artificial rank promotion, no fabricated substitute. "Never drop": `best` is `null` (not
  fabricated) when nothing else cleared the gate. Also closed a cross-phase gap: Phase 2's
  `v3BestFallback` needed the identical Under-exclusion (it sources from `assessments` directly,
  outside the evMarkets-level strip). 5 new tests (`underAhPivot.test.ts`) — odds/lambda values
  independently verified against a standalone Poisson/devig/gate replica before being committed
  (the subagent caught and corrected an error in this session's own suggested odds).
- **Phase 0 (`fad1afc`) — streak/last5Pts telemetry.** Wires the sidecar's `form.streak` (signed
  win/loss run, direct passthrough) and `form.last5` (new `last5Points()` sum: 3/win+1/draw+0/loss)
  into `PatternInput.streakH/A`/`last5PtsH/A`, mirroring the existing `refereeCardsRate` 4-hop wiring
  precedent exactly. **`h2hOversRate` explicitly deferred** (named in the original brief) — requires
  modifying the separate, rate-limited `h2h.ts` external-API module (its own cache/quota concerns),
  scoped out as its own follow-up. No new tests needed (additive optional-field plumbing, zero
  behavior change for any fixture lacking these fields — every existing test).

**Verification, every commit**: `pnpm --filter @oracle/engine|runtime|worker typecheck` clean;
`pnpm --filter @oracle/engine|runtime|worker test -- run` — engine 939/939, runtime 679/679, worker
65/65 (one transient `decision.test.ts` timeout on a full-suite run, confirmed non-regression on
immediate re-run — this box's known low-RAM contention, see CLAUDE.local.md); `pnpm exec biome ci .`
clean on every file this session touched (net **improved** by 1 warning — fixed a pre-existing
`useOptionalChain` in `batch/index.ts` per this repo's established "CI Biome Gotcha" precedent, same
treatment `7dd15c9` used). Docs updated: `.claude/skills/oracle-engine/SKILL.md` changelog +
`workflows/markets_v3.md`'s env-flag table (new `ORACLE_V3_PATTERNS` row; corrected the X-carveout's
"only deliberate gate relaxation" claim to "first" now that patterns is a second).

**Gotcha for next session**: mid-session, `biome ci .` reported a phantom "1 error" that took real
digging to trace — root cause was a **pre-existing, local-only, orphaned locked worktree**
(`.claude/worktrees/fix-worker-silent-failure-logging`, branch `fix/worker-silent-failure-logging`,
same HEAD as main, unrelated to this work) whose own nested `biome.json` conflicts with the repo
root's. Reproduces identically on a clean `main` (confirmed via `git stash`) — **not a regression**,
won't affect real GitHub Actions CI (fresh clone, no local worktrees), and per CLAUDE.md this session
did not touch the locked worktree without asking. If `biome ci .` ever reports an error with no
matching diagnostic in the rendered output, check `git worktree list` for a stray nested config before
assuming a real lint failure.

## NEXT — owner action: push + open 3 stacked PRs, review, then flip flags

This session never pushes/PRs/deploys (standing instruction). Run these, in order (each depends on the
previous branch already being pushed, since they're stacked):

```powershell
git push -u origin feature/patterns-engine-wave2-gate
git push -u origin feature/patterns-engine-wave2-ah-pivot
git push -u origin feature/patterns-engine-wave2-telemetry

gh pr create --base main --head feature/patterns-engine-wave2-gate `
  --title "feat(engine,runtime,worker): patterns-engine Wave 2 Phase 2 - gate wiring + fill-to-39"
gh pr create --base feature/patterns-engine-wave2-gate --head feature/patterns-engine-wave2-ah-pivot `
  --title "feat(engine): patterns-engine Wave 2 Phase 3 - Under to Asian Handicap pivot"
gh pr create --base feature/patterns-engine-wave2-ah-pivot --head feature/patterns-engine-wave2-telemetry `
  --title "feat(runtime,engine): patterns-engine Wave 2 Phase 0 - streak/last5Pts telemetry"
```

(Use the full commit messages — `git log -1 --format=%B <sha>` on each — as the PR bodies; they already
have the What/Why/verification detail this repo's PR template wants.)

**After merging all 3 to `main`**, deploy = the standard rebuild + restart (nothing here is live until
this happens — `ORACLE_V3_PATTERNS` defaults `shadow`, so even after deploy, pick-selection behavior
is UNCHANGED until the flag is deliberately flipped):
```
pnpm turbo run build --concurrency=1
# then in an ELEVATED PowerShell:
Restart-Service OracleWorker
Restart-Service OracleBot
```

**Then, per the established shadow-promotion discipline this repo uses for every gate-relaxation flag**
(X-carveout, sharp-feed, calibration-ledger): run `ORACLE_V3_PATTERNS=shadow` for at least one real
slate, review the `patternRelaxed:"shadow_pass"` tally + the fill-to-39 pool composition in the slate
report, confirm the Under→AH pivot behavior looks sane on real fixtures (no Under anywhere in a real
Telegram/report output), THEN flip to `on` — never a hand-flip straight to `on` without shadow evidence.

## Kickoff prompt for the NEXT (fresh) session — paste verbatim

```
Read handoff.md top section (⭐ CURRENT, 2026-07-16 later session). patterns-engine Wave 2 is fully
implemented across 3 stacked branches (feature/patterns-engine-wave2-gate ->
feature/patterns-engine-wave2-ah-pivot -> feature/patterns-engine-wave2-telemetry), NOT yet
pushed/PR'd/deployed. First: push the 3 branches + open the 3 stacked PRs per the exact commands in
the "NEXT" section above (or tell me you've already done this and give me PR numbers/merge status).
Once merged: hand me the elevated Restart-Service commands (never run them yourself). Once deployed:
help me review one real slate with ORACLE_V3_PATTERNS=shadow (patternRelaxed shadow_pass tally,
fill-to-39 composition, confirm zero Unders anywhere in the report) before I decide whether to flip
the flag to "on". Rules: typecheck+test --concurrency=3 before any further commit, git worktree list
first (there's a pre-existing locked worktree at .claude/worktrees/fix-worker-silent-failure-logging -
leave it alone, it's unrelated), never push to main directly, adversarially verify any further gate
math changes (this wave's Phase 2 caught a real critical bug this way - a fallback filter that would
have re-admitted capped/noise picks - fixed before merge).
```

═══════════════════════════════════════════════════════════════════════════════════════════════════

# ⭐ PRIOR — 2026-07-16: patterns-engine Wave 1 MERGED to main (PR #69) — Wave 2 (gate integration) is the next task

> **Cold-read this first.** The 2026-07-15 blend-gate decision was resolved by the owner into a full
> program: pattern/trend-driven picks (supersede pure EV, **keep a +EV value floor**), **no Under picks
> (pivot to Asian Handicap)**, **bookable labels**, and **analyse every fixture / ≥39 picks/day**. Plan:
> `.claude/plans/1-today-s-picks-was-modular-marble.md`. Owner-locked decisions: ① pattern-primary **+
> value floor** (not pattern-only), ② **kill ALL Unders → always pivot to best AH**, ③ **enhance
> markets-v3** (keep the clean pipeline; don't blanket-revert to raw-edge). Execution: `/orchestrator`,
> 2 Sonnet subagents/phase, `pnpm turbo run typecheck test --concurrency=3` (owner raised it from 1).

## SHIPPED this session — **PR #69 MERGED to main** (merge commit `4e4c871`, 2026-07-16 06:19 UTC)

3 commits, all verified (typecheck 19/19; engine 907 + runtime 678 + notify 61 + booking 33 tests
green; biome clean on changed files):

- **`c132a6c` — Phase 4 bookable labels.** Legacy fallback pricer no longer labels picks
  `"AllMarkets Scan"` — emits the real `FAMILY_LABEL[family]` + a `sourcedFromScan` provenance flag
  (threaded through `PickRef`/`EVMarket`/`ActionablePick`/`decision/index.ts`; `runPunt` note reads the
  flag). Fixes BOTH the confusing Telegram label AND "no picks could be mapped to SportyBet".
- **`f3659fe` — Phase 5 full funnel.** `gateMarketsV3Fixture` (pipeline.ts) demotes
  `mandatory_data_missing`/`below_completeness_floor`/`heightened_trends_not_aligned` from discards to
  non-gating `annotations` (new `annotationCounts` on both slate summaries + in the gate log). Only
  srl_virtual / missing_mandatory_odds / already_kicked_off / contamination still drop. Every scraped
  fixture with priceable odds now reaches pricing.
- **`33928b3` — Phase 1 pattern detector.** NEW `packages/engine/src/marketsV3/patterns.ts` —
  `detectPatterns(PatternInput): PatternReport`. Deterministic green-flag engine (Heavy Superior→AH,
  Goal Machine→Over/BTTS, Corner Kings→corners Over, Anomaly→DNB), hierarchy 50/30/15/5, never Under,
  degrades gracefully, reuses `scoreV3Priority`. 12 tests incl. the doc's Arsenal-vs-Chelsea example.
  Thresholds exported as `PATTERN_THRESHOLDS`. Ships **inert** — `ORACLE_V3_PATTERNS` defaults `shadow`.
- Also: **`ORACLE_V3_PATTERNS`** tri-state flag (`env.ts` + `OracleConfig.v3Patterns` + `.env.example`).

### Subagent note (why this was built inline)
Wave 1 was launched as 2 background Sonnet subagents; **both died on the account session-limit reset
(2:30am Lagos)**. Subagent A had landed the flag + most of Phase 4 (label) before dying; Subagent B
(detector) produced nothing. Per the parallel-waves resilience rule, the partial was assessed on disk
and **finished inline** rather than blindly re-spawned. When re-spawning, note the shared session limit.

## NEXT — Wave 2 (the part that actually changes picks). NOT started.

This is the real-money gate math — do it carefully, adversarially verify, keep the +EV floor.

- **Phase 2 — wire the detector into the gate + fill-to-39.** In `analyzeFixtureMarkets.ts`, build a
  `PatternInput` from `V3AllMarketsInput` (venue-split `lambdaInput` + `empirical` block + corners) and
  call `detectPatterns` once/fixture. Add a `patternStrength`/`patternBacked` opt to `gateAllMarkets`
  (`evGate.ts`) that, for a strong pattern, **relaxes the `CLASS_GATE_BLEND` class_edge bar** (scaled by
  strength) and **boosts confidence + rankingScore** — this is the direct fix for 0/4394 dryness.
  **HARD: the +EV floor (`ev = modelP·odds − 1 > 0`) + the cap/noise invariants at `evGate.ts:446-448`
  STAY** — patterns relax the class bar, never rescue a −EV/capped/noise pick. Gate it all behind
  `ORACLE_V3_PATTERNS` (shadow records would-pass + pool size like x-carveout; flip `on` after one real
  slate). **Fill-to-39**: ensure the pool feeding `OUTPUT_A_MAX=39` (`outputs.ts`) is the full +EV set,
  not the tiny class-gate survivor set (`curateActionableByV3Outputs`, `slateOutputs.ts:173`).
- **Phase 3 — Under→AH pivot (kill all Unders).** In `analyzeFixtureMarkets.ts`, after ranking, detect
  Under picks via `dirOfDesc(desc)==="under"` for a `TOTALS_FAMILIES` family; replace with the best AH
  selection — generalise `asianHandicapPivot` (`math/index.ts:912`) to run for ANY Under (not only
  LOW_SCORING), price with `priceAsian` (`result.ts:63`), emit a real `EVMarket` family
  `asian_handicap` (bookable via `marketMap.ts:139`). **Never drop**: if no AH line is +EV, fall through
  to the fixture's nearest runner-up +EV **non-Under** market. Assert no goals_ou/team_total Under ever
  reaches `evMarkets`.
- **Phase 0 — telemetry wiring (enriches the detector).** Wire streak / last-5 PPG / H2H-overs-rate from
  the sidecar into `buildStatsOverride` (`sportyBetStats.ts`) → `buildV3Input` → the `PatternInput`
  optionals. Detector already accepts these optionally; this just improves Anomaly/recency coverage.

### Wave 2 verification (owner-required)
Real-slate reproduction (handoff Stage-2/Stage-3 harness): (a) markets-v3 yields picks (not 0/4394),
(b) **no Under picks anywhere**, (c) real bookable labels, (d) funnel ≈ 100%, (e) **≥39 actionable**,
(f) booking maps every pick. Then `ORACLE_V3_PATTERNS=shadow` → review one real slate → flip `on`.

## DEPLOY — OWED to production (owner action, elevated shell)
PR #69 is merged to `main` but the LIVE `OracleWorker`/`OracleBot` still run the pre-merge build. To
ship the label/booking fix + full funnel to production, run:
```
pnpm turbo run build --concurrency=1
# then in an ELEVATED PowerShell:
Restart-Service OracleWorker
Restart-Service OracleBot
```
Do NOT restart services from the agent harness (owner-only). `ORACLE_V3_PATTERNS` defaults `shadow`, so
this deploy changes NO pick-selection behavior yet — it only makes picks bookable (real market labels,
SportyBet mapping) and lets every scraped fixture be analysed. The detector is inert until Wave 2 wires
it into the gate and the flag is flipped `on`.

Also owed (unchanged from 2026-07-15, may already be done): the P0/P1 deploy — verify `OracleWorker`
was restarted after PR #66/67/68 before assuming those are live.

## Kickoff prompt for the NEXT (fresh) session — paste verbatim
```
Read handoff.md top section (⭐ CURRENT, 2026-07-16) + the plan at
.claude/plans/1-today-s-picks-was-modular-marble.md. patterns-engine Wave 1 (PR #69) is MERGED.
Do Wave 2: branch off main. Phase 2 — wire detectPatterns() (packages/engine/src/marketsV3/patterns.ts)
into evGate.ts/analyzeFixtureMarkets.ts: relax the CLASS_GATE_BLEND class_edge bar for pattern-backed
picks + boost ranking, KEEP the +EV floor (ev = modelP*odds-1 > 0) and the cap/noise invariants at
evGate.ts:446-448, fill-to-39 from the slate-wide +EV pool. Phase 3 — Under->AH pivot (generalise
asianHandicapPivot math/index.ts:912, price with priceAsian result.ts:63, never drop -> runner-up +EV
non-Under; assert no goals_ou/team_total Under reaches evMarkets). Phase 0 — wire streak/last5/H2H
telemetry into the detector. Gate all pattern gating behind ORACLE_V3_PATTERNS (shadow first, flip on
after one clean real-slate). Rules: one branch/PR per phase, never push to main, typecheck test
--concurrency=3 before every commit, git worktree list first, don't restart services (hand me the
elevated Restart-Service commands). Adversarially verify the gate math — it sizes real bets.
GOTCHA: account session limit killed both wave-1 subagents mid-run; if re-spawning fails, finish inline.
```

═══════════════════════════════════════════════════════════════════════════════════════════════════

# ⭐ PRIOR — 2026-07-15: P0-A/P0-B/P1-C/D/E ALL SHIPPED + MERGED + **DEPLOYED**; blend-gate decision AWAITING OWNER

> **Cold-read this section first.** Written 2026-07-15. All three fix PRs from the 2026-07-14 plan
> below are **merged to `main`** (`1c74b23`). Clean-slate evidence for the blend-gate question has been
> gathered on real production data — see "BLEND-GATE DECISION" below, which **supersedes** the old
> "BLEND-GATE RELAXATION" section's caveat (that caveat is now resolved: the 0-actionable streak is
> confirmed NOT purely a P0-A artifact). **Blend-gate options 1-4: still not implemented — genuinely
> owner's call, do not implement without explicit sign-off.**
> **UPDATE (later same session, ~20:40 UTC): NOW DEPLOYED.** `OracleWorker` was restarted (elevated
> shell, owner-run) — confirmed via the `SIGINT received`/`effective config` log lines being the newest
> entries in `.tmp/servy_worker_stdout.log`, well after all three merges. No `build-freshness` stale
> warning fired. `OracleBot` was NOT restarted (not required for these worker-side fixes per the "DEPLOY"
> section below; low-priority follow-up if a fully consistent dist/state split ever matters). The
> "DEPLOY — pending owner action" section below is now historical — deploy is done, just not by the
> session that wrote it.
> **First real post-fix test**: the goals batch that ran earlier 2026-07-15 (29 actionable) used the
> PRE-fix build — restart happened ~10h after. Tonight's evening back-online re-scrape and tomorrow's
> 09:35 WAT batch are the first runs on genuinely fixed code — nobody has reviewed those results yet.

## What shipped this session (2026-07-15)

Three branches, three PRs, all merged to `main` same-day:

- **PR #66** — [P0-A] SportyBet index empty-memo poisoning + lake-shadows-fresh-sidecar + evening
  partition-clobber + placeholder-spam suppression. `dailyStore.ts`'s per-date memo no longer sticks on
  a null/empty read (with a race-condition guard for two dates in flight concurrently — caught and
  fixed in my own first draft); `selectFixtures.ts` falls through to the JSON sidecar when the lake
  index is truthy-but-empty; `tools/daily_store.py` refuses to replace a healthy fixtures partition
  (≥10 rows) with a collapsed one (<50% of existing rows); Telegram placeholder spam suppressed via
  `(date, reason)`-keyed heartbeat. https://github.com/ArchibongHQ/ORACLE-Agent/pull/66
- **PR #67** — [P0-B] Telegram document timeout scaling (30s + ~10s/MB, was a flat 30s that always
  timed out on the 12.3MB HTML report) + honest delivery reporting. `sendTelegramDocument` now returns
  `Promise<boolean>`; the "delivered" log + `fixtureReportDelivered` heartbeat only fire when every
  send actually succeeds; a partial/total failure now stamps `fixtureReportPlaceholder` with
  `reason: "delivery-failed"` so the existing hourly retry mechanism genuinely picks it up (the first
  draft's comment claiming this happened "naturally" was checked against `index.ts:387`'s actual gate
  condition and found false — fixed to actually stamp the heartbeat).
  https://github.com/ArchibongHQ/ORACLE-Agent/pull/67
- **PR #68** — [P1-C/D/E] Batch sidecar re-load guard (one-shot re-acquire if the index is still empty
  at batch start despite a fresh lake); resolve-yesterday 15-minute job-level timeout via `Promise.race`
  + capped web-search sweep budget (10 min max, was unbounded ×35s/unmatched) + Windows tree-kill on
  timeout (was bare `child.kill()`, could orphan the Playwright subtree); 42 previously-silent LLM
  cascade failure branches across `callOpenRouter.ts`/`callGemini.ts`/`callVerification.ts`/
  `callKimi.ts`/`callNewsIntel.ts`/`callBriefing.ts` now logged via a `_fail()`/`_redact()` pattern
  mirroring `callClaudeCode.ts`. Two real bugs caught and fixed mid-implementation: a corrupted regex
  (literal Unicode line-separator characters instead of escape sequences) that broke the whole
  `@oracle/llm` package build, and a credential-redaction gap (`sk-[A-Za-z0-9]{10,}` didn't allow
  hyphens, so real hyphenated key shapes like `sk-ant-api03-…`/`sk-or-v1-…` weren't redacted if echoed
  in an error) — flagged by the automated security scanner, fixed with regression tests across all 6
  files. **Known gap**: two specialist review subagents hit their session limit mid-run; this PR's
  review is my own manual pass, disclosed in the PR body.
  https://github.com/ArchibongHQ/ORACLE-Agent/pull/68

Also confirmed (no action needed): **PR #63 and #65** — both already merged 2026-07-14, before this
session started. The old plan below listed them as open; they weren't.

Full verification: `pnpm turbo run typecheck test --concurrency=1` green before every commit; Biome
clean; `apps/worker/dist` rebuilt fresh at 17:06 WAT (after the `1c74b23` merge commit at 17:02:45) —
the evidence run below used this exact fresh build.

## BLEND-GATE DECISION — evidence gathered, genuinely awaiting owner choice of Option 1-4

**Two-stage evidence run against real production data** (today, 2026-07-15, on the fresh post-merge
build):

**Stage 1 — read-only smoke test** (`loadSportyBetIndex`, no network/LLM/Telegram calls): sidecar
populated, 100 events, 98/99 sampled fixtures carrying real `allMarkets` odds. P0-A fix confirmed live.

**Stage 2 — slate gate reproduction** (`prefilterMarketsV3Jobs` against real fixtures): real,
differentiated log line —
```
[markets-v3] gate: 40 mapped → 15 survive (0 unmapped pass through; mandatory_data_missing: 19,
heightened_trends_not_aligned: 2, missing_mandatory_odds: 4) | feed-integrity: 0 contaminated, 2 flagged
```
Not fail-open — a real breakdown of why 25/40 were dropped. This is the piece P0-A was blocking
(sidecar was empty → gate always fail-opened → no evidence either way).

**Stage 3 — full paid `--run-now` batch, 15 survivors analyzed** (owner-authorized real API spend):
15 fixtures, 6 actionable, `oracle-2026-07-15.html` report. The markets-v3 slate-wide rollup:
```
[markets-v3] markets: 3595 entries total / 2821 routed / 4394 outcomes priced / 0 gate-passed
```
`gatePassed` (`packages/runtime/src/marketsV3/slateOutputs.ts:252`) counts individual OUTCOMES whose
gate verdict was `"done"` — i.e. cleared `evGate.ts`'s `CLASS_GATE_BLEND` tiers. **0 of 4394 priced
outcomes passed, across the whole slate.** Report's Gate-reasons tally: `class_edge=2803` (dominant —
adjusted blend edge below the class floor), `noise=680`, `capped_absolute=651`, `capped_relative=246`,
`class_evpct=9`, `ev_floor=5`.

**Critical: this is NOT the LLM-outage-confounded evidence the old caveat worried about.**
`evGate.ts`/`CLASS_GATE_BLEND` is pure deterministic script-math (no LLM in the loop) — it ran to
completion on all 4394 outcomes regardless of the LLM cascade's health that day. The 6 actionable
picks that DID surface (`priceAllMarketOutcome` / "AllMarkets Scan" + "Goals O/U" + "Team Total",
LEAN/STRONG, 0.3–1.7% Kelly, 69.5–88.7% conf) came from the **separate legacy all-markets pricer**
(`packages/engine/src/execution/index.ts:1223`), which is NOT gated by `evGate.ts` at all — proving
the two pipelines are genuinely decoupled and the markets-v3 blend gate's 0-output is real, not an
artifact of something else silently starving it.

**Net: on a clean, fully-populated, real slate, `CLASS_GATE_BLEND` genuinely produces zero picks.**
Wave-4's own tuning target (~39 picks on a normal wide slate) has still never been observed — today's
slate is only 15 fixtures (a slow day), but 0/4394 at every class tier, dominated by `class_edge`,
is a strong, unconfounded signal that the blend bars (S 1pt/M 1.5pt/L 2pt/X 2pt, `evGate.ts:130-138`)
are too tight for `V3_BLEND_W_CAP=0.40`'s edge compression, not merely "today was quiet."

**Separately discovered, real, ongoing issue — NOT part of the blend-gate evidence, flagged
independently**: the LLM decision cascade was severely degraded during this run — Gemini quota fully
exhausted (3267 of 3294 total log lines were `429`s), `callClaudeCode` (local CLI) hit its session
limit and timed out on every call, OpenRouter free-tier models mostly `404`/`429`. P1-E's new logging
is what made this visible — previously silent. This affects the LLM-driven layers (briefing/
verification/news) but did NOT confound the blend-gate evidence above, since `evGate.ts` never calls
an LLM. Recommend treating this as its own follow-up (see P2 items below) — not blocking this decision.

**Options (unchanged from 07-14, owner's call — do not implement without explicit sign-off):**
- **Option 1 — flag-only, instant, reversible:** `ORACLE_V3_BLEND_PRICING=off` in `.env`. Reverts to
  pre-Wave-4 raw-edge gates (2026-07-10 behavior, DID produce picks, with known pathologies already
  separately fixed by Wave 4: fake HSH edges, Kelly=0). Zero code changes.
- **Option 2 — halve the blend bars:** `CLASS_GATE_BLEND` (`packages/engine/src/marketsV3/evGate.ts:130`)
  S 0.01→0.005, M 0.015→0.0075, L/X 0.02→0.01 (`CLASS_GATE_BLEND_HEIGHTENED` stays ×1.30 of those).
  Keeps market-anchored honesty, admits roughly 2x more. One constant table + test updates.
- **Option 3 — X-carveout path:** already merged (PR #65) and currently `ORACLE_V3_X_CARVEOUT=shadow`
  in `.env` — narrow (Class X exotics only, odds ≤15, high data-quality bar), does not touch S/M/L,
  and today's evidence shows S/M/L is where all the dryness is (`class_edge` rejections dominate
  regardless of class). Shadow mode is already collecting `shadow_pass` evidence passively; promoting
  to `on` alone would not move today's 0-actionable outcome.
- **Option 4 — remove constraints (owner's "if necessary"):** make the blend gate log-only/shadow —
  every priced candidate proceeds on raw-edge gates alone, blend verdict recorded per pick. Honest
  warning: at soft-book margins this admits −EV picks by construction; Option 1 is strictly safer if
  pick volume is the goal.

**My read given today's evidence**: Option 1 is the lowest-risk lever that's guaranteed to restore
pick volume immediately (it's the exact pre-Wave-4 path that was producing picks, just with its known
bugs already fixed). Option 2 is worth trying first only if the owner wants to keep the market-anchored
honesty property and is willing to accept another slate-or-two of possibly-still-zero output while
validating the halved bars empirically. Option 3 alone will not fix this. Option 4 is available but not
recommended as a first move.

## Symptoms observed in production (2026-07-11 → 2026-07-14)

- Telegram spam: repeated "ORACLE — no SportyBet fixtures found for <date>" placeholders (3+/day),
  each claiming `sidecar 0.0h old`.
- **Goals batch has not run since 2026-07-10** — `[goals] no SportyBet fixtures available — skipping`
  once per day in `.tmp/servy_worker_stdout.log` (lines 7218/8331/9258/9687/10678); heartbeat
  `lastGoalsBatch` frozen at 2026-07-10T09:19Z. This is why no picks arrive.
- Daily batches run on degraded API-fallback slates (07-11: 313 analysed, 07-13: 69, 07-14: 68) with
  **0 actionable** every time, `[markets-v3] gate` line absent (slate gate fail-open, no sidecar).
- Daily fixture report: **not delivered since 07-11**; the 12.3MB HTML attachment times out on every
  attempt even when the xlsx parts deliver.
- `⚠️ build freshness: @oracle/worker dist STALE` on every batch summary.
- resolve-yesterday wedged 2+ hours on 07-11 (internet outage, no timeout); 07-13 resolved only
  15/69.

## ROOT CAUSES (verified 2026-07-14, evidence inline)

### P0-A — SportyBet index reads empty all day: THREE interacting defects (this is the big one)

1. **Per-date memoization poisons the whole day** — `packages/runtime/src/dailyStore.ts:174-187`:
   the daemon memoizes the FIRST lake read per date for the entire process lifetime. The first read
   happens at batch start (~08:35 UTC), BEFORE the morning scrape writes the partition (~10:07 UTC
   observed today) → the cached null/empty result is served to every later caller (fixture report,
   goals batch, back-online batches) all day, even after good data lands on disk.
2. **Lake shadows the fresh JSON sidecar** — `packages/runtime/src/selectFixtures.ts:556`:
   `if (fromLake) return …` treats ANY truthy lake index — including one with **0 events** (an
   existing-but-empty partition) — as authoritative, never falling back to the JSON sidecar.
   Verified today: `.tmp/fixtures/sportybet_today.json` was GOOD (date 2026-07-14, 109 events,
   correct kickoffs) while the pipeline still reported "no SportyBet fixtures".
3. **Evening back-online acquires clobber the day's partition** — observed partition rewrites at
   21:03/23:31/23:33 local shrinking `part.parquet` to ~1.5KB (near-empty; healthy morning write is
   ~9KB): scraping SportyBet's "today" page near midnight returns almost nothing and the Parquet
   `write_table` REPLACES the partition. Next morning the sidecar JSON still carries yesterday's
   `date` → the date check at `selectFixtures.ts:565` rejects it → "no fixtures" until ~10:07, at
   which point defect 1 hides the recovery for the rest of the day.

**Fixes (in this order):**
- `dailyStore.ts`: never memoize a null/empty index — retry on next call (or key cache on partition
  mtime). Smallest safe change: only cache when `events.length > 0`.
- `selectFixtures.ts:556`: when the lake index has 0 events, fall through to the JSON-sidecar path
  instead of returning it.
- Evening clobber: in the acquire chain, refuse to replace an existing fixtures partition with a
  smaller/near-empty one (min-events or only-grow guard), OR gate back-online acquire re-scrapes to
  before ~18:00 WAT.
- Telegram placeholder spam: suppress repeat "no SportyBet fixtures" sends per date — the
  `fixtureReportPlaceholder` heartbeat stamp exists (`workerUtils.ts`) but hasn't been written since
  06-30; stamp it on the placeholder path and skip re-sends for the same date.

### P0-B — Telegram document send silently drops large files, then reports success

- `packages/notify/src/telegramDocument.ts:59` (fetch, `AbortSignal.timeout(30_000)`) and `:119`
  (https fallback, `timeout: 30_000`): the 12.3MB HTML report times out on BOTH paths, 2/2 attempts
  (`[telegram-document] send failed — https.request timed out`). Well under Telegram's 50MB cap —
  it's purely a 30s-timeout-vs-upload-bandwidth issue.
- `sendTelegramDocument` returns `void`; caller `apps/worker/src/dailyAcquisition.ts:252/258/265`
  ignores outcomes, logs "delivered N file(s)" at `:272-274` and stamps `fixtureReportDelivered` at
  `:275` unconditionally.
- **Fix:** return `Promise<boolean>` (all call sites ignore the return today — backward-compatible;
  update 2 test assertions in `packages/notify/test/telegramDocument.test.ts:55/62`), scale timeout
  with file size (e.g. 30s + ~10s/MB) or wrap in the existing `withRetry` from `@oracle/engine`
  (already used in `workerUtils.ts:231-240`), and gate the "delivered" log + heartbeat stamp on all
  sends succeeding.

### P1-C — Daily batch snapshots the sidecar index once; slate gate fail-opens for the whole run

- `apps/worker/src/dailyBatch.ts:112` (single `loadSportyBetIndex` at batch start), `:126`
  (prefilter), `:149-153` (fail-open "gate dropped every fixture"). On 07-11 the index loaded at
  10:04 while the sidecar landed 10:29 → whole 313-fixture run ungated.
- **Fix:** if the loaded index is empty, run the existing gap-fill acquisition (`dailyBatch.ts:71-76`
  pattern) once and re-load before accepting fail-open. Largely subsumed by P0-A fixes 1+2, but the
  one-shot re-load guard is still worth having.

### P1-D — resolve-yesterday has no job-level timeout (wedged 2h+ on 07-11)

- Cron wiring `apps/worker/src/index.ts:668-672` passes `resolveYesterdayFixtures` with no ceiling
  (contrast the 09:35 batch's `awaitAcquireDailyJobOrTimeout` at `:659-663`, `ACQUIRE_CHAIN_TIMEOUT_MS`
  at `:278`). Sub-timeouts exist (API fetches 15s, closing odds 10s) but
  `resolveUnmatchedViaWebSearch` (`packages/runtime/src/resolveFixtures.ts:601-604`) scales its
  subprocess timeout **35s × unmatched-count** (55 unmatched ≈ 32 min) and uses `child.kill()` — not
  the tree-kill helper (`packages/runtime/src/fixtures.ts:697`) — so on Windows the Playwright
  subtree can orphan.
- **Fix:** wrap the job in `Promise.race` with a hard ceiling (~15 min) that logs and returns; cap
  the web-search sweep's total budget; use the tree-kill helper.
- Related (P2-G): matching is team-name+date only (`resolveFixtures.ts:324-333`) — during an outage
  everything unmatches (07-13: 15/69). Consider a D-2 retry sweep for unmatched leftovers.

### P1-E — LLM cascade rungs fail silently (only callClaudeCode logs)

- Replicate `callClaudeCode.ts`'s `_fail()` pattern (`packages/llm/src/callClaudeCode.ts:260-262`) at:
  `callOpenRouter.ts` return-null branches (lines 29/51/57/64), `callGemini.ts` catch-accumulate +
  skip points (34-36/68-72/98-100), `callVerification.ts` (51/53/60/71/73), `callKimi.ts`
  (33/41/45/54/65/85/92), `callNewsIntel.ts` (~22 branches), `callBriefing.ts` per-rung (34).
- Context: 2,003 `[callClaudeCode]` quota failures on 07-11 were diagnosable ONLY because that one
  file logs; the API-fallback rungs that carried the batch were invisible.

### P2-F — Deploy debt

- `apps/worker/dist` built 2026-07-11 03:53, **misses PR #64** (merged 2026-07-14 07:42). Deploy =
  `pnpm turbo run build --concurrency=1` + elevated `Restart-Service OracleWorker` (owner shell —
  cannot elevate from this harness). Restart also flushes the P0-A poisoned memo cache immediately.
- PR #63 (build-freshness git-time fix) and PR #65 (x-carveout) still open — merge decisions are the
  owner's; folding either into the same rebuild+restart avoids a second restart.

## DEPLOY — pending owner action

`apps/worker/dist` in THIS checkout is fresh (rebuilt 17:06 WAT, after the `1c74b23` merge at
17:02:45) — that's the build the evidence run above used. The LIVE Windows services have **not**
been touched this session (explicit instruction: never restart them from here):

```
Get-Service -Name OracleWorker,OracleBot
# OracleBot    Running Automatic   (pre-merge build)
# OracleWorker Running Automatic   (pre-merge build)
```

To actually deploy today's three merges, run this in an **elevated** PowerShell:

```
Restart-Service OracleWorker
Restart-Service OracleBot
```

(`OracleBot` doesn't strictly need a restart for these fixes, but it shares the same `.tmp/` heartbeat
state and dist — restarting both avoids a stale-vs-fresh split.) The restart also flushes the P0-A
memo cache immediately, which is itself a small win (no more waiting out a poisoned slot).

## STILL OPEN — carried forward, none blocking

- **Blend-gate decision** (above) — the only item this session was told not to touch without sign-off.
- **LLM cascade degradation, discovered live this session** — Gemini quota exhausted, Claude CLI
  session-limited, OpenRouter free tiers mostly down, all on 2026-07-15. P1-E's new per-file logging
  means this is now visible going forward (previously silent) — worth a look at whether Gemini's quota
  tier needs upgrading or a paid OpenRouter fallback is warranted, since today wasn't a one-off (07-11
  had a similar Claude-CLI exhaustion event).
- **P2-G**: resolve-yesterday matches by team-name+date only, so an outage unmatches everything
  (07-13 was 15/69). Consider a bounded D-2 retry sweep for leftover unmatched records. Not started.
- **Verify-don't-assume item (a) — now has fresh, directly relevant evidence**: whether the Gemini/
  OpenRouter fallback cascade actually succeeded during the 07-11 outage was previously unconfirmable
  (no logging existed then). Today's LLM-cascade-degradation finding shows the SAME failure mode is
  live and reproducible now — worth checking today's `analysis` records for which provider actually
  carried the 6 picks that did get analyzed, now that P1-E's logging exists to answer it.
- **Verify-don't-assume item (b)**: resolve-yesterday's exact 2h+ hang mechanism on 07-11 is still
  unconfirmed root-cause — moot for safety purposes now (P1-D's 15-minute hard ceiling bounds it
  regardless), but the underlying "why" was never found.
- **Wave-4 soak-gate counter reset**: still an open question — every slate since the 07-11 Wave-4
  deploy ran on a poisoned/empty sidecar (P0-A) except today's. Today's 15-fixture slate is the FIRST
  valid soak-evidence slate; the ≥7-slate counter should probably start counting from today, not reset
  to include the poisoned runs. Owner call.
- **Long-standing lower-priority items**, unchanged from 07-14: `v3VenueSplitUsed` reads false in every
  boot snapshot since Wave 1 (never confirmed if that's correct or a real gap in
  `sportyBetStats.ts`'s `buildStatsOverride`); PR #37 (docs-only CLAUDE.md restructure) stale/
  conflicting against main, owner said leave it; the shadow-promotion list (per-segment calibration
  flip, pi-ratings walk-forward bar, sharp-feed 95%/7-slate verification, lake baselines/HFA) is
  evidence-gated and not started; the "news-gate anomaly" and "live pick-volume watch" flagged in the
  Wave-4 memory were never investigated.

## Kickoff prompt for the next session (paste verbatim)

```
Read handoff.md in this repo (c:\Users\HP PC\Documents\ORACLE\ORACLE Agent) — the top section
(marked "⭐ CURRENT", dated 2026-07-15) is your plan. PR #66/#67/#68 are already merged to main;
this is NOT a fix-implementation session unless I've told you otherwise.

First: [I will tell you which blend-gate option to implement, if any — see "BLEND-GATE DECISION"
in the current section]. Implement ONLY that option, on its own branch, with tests, then stop.

Second, once the blend-gate work (if any) is done and deployed: work through "STILL OPEN — carried
forward, none blocking" in order of what's most valuable — the LLM cascade degradation item and the
Wave-4 soak-gate counter question are probably highest-value; P2-G and the verify-don't-assume items
are next; the long-standing lower-priority list is last.

Rules: one branch per concern, never push straight to main; `pnpm turbo run typecheck test
--concurrency=1` before every commit (this box OOMs above concurrency 1 — see CLAUDE.local.md);
run `git worktree list` before assuming exclusive access; don't restart the OracleWorker/OracleBot
services yourself — hand me the exact elevated Restart-Service commands to run (see "DEPLOY" above
for the exact ones still owed from THIS session if I haven't run them yet).

Report back with: what shipped (branch/PR links), and an updated handoff.md.
```

═══════════════════════════════════════════════════════════════════════════════════════════════════

# [SUPERSEDED 2026-07-14, still-accurate history] — Waves 1-4 ALL SHIPPED + DEPLOYED LIVE; post-Wave-4 quick wins in flight (2026-07-11)

> **Cold-read this section first.** Everything below the `═══` divider is prior history — the old
> top section's "Wave 3 not yet pushed, Wave 4 planning" framing is **fully superseded**: both waves
> merged, deployed, and confirmed live since this section was written. Read on for what's active now.

## Status

- **Wave 3 MERGED** via PR #61. **Wave 4 MERGED** via **PR #62** (merge commit **`ba734dd`**,
  2026-07-11) — **rebuilt + `OracleWorker` restarted and confirmed live**: `v3BlendPricing` /
  `v3TotalsEmpirical` **on**, **1881 tests green at merge**. All four refactor waves are now shipped,
  deployed, and running in production. See the divider-and-below history for the full Wave 1-4
  implementation trail (commits, review findings, deploy-gap incidents).

## THIS SESSION (2026-07-11, post-Wave-4) — two quick-win items in flight

1. **Build-freshness watchdog false-positive — FIXED, PR #63 OPEN awaiting merge.**
   Branch `bugfix/build-freshness-git-time`, commit `4c260ae`. Root cause: the watchdog compared
   `dist` mtime against **`src` mtimes**, but a `git pull` rewrites `src` mtimes to checkout-time
   while turbo's cache can restore `dist` with an *older* mtime — false-positive staleness alarm on
   every single pull, not just genuinely-stale builds. Fix: `apps/worker/src/buildFreshness.ts` now
   compares `dist` mtime against the **last git commit touching that package's `src/`**
   (`git log -1 --format=%ct`) instead. Mtime comparison is retained as a fallback (fires one
   observability warn) only when git is unavailable. **Deliberate side effect**: uncommitted local
   src edits no longer trigger the watchdog — this is intended, not a regression.
   **Not yet deployed** — after merge this needs the standard `pnpm turbo run build --concurrency=1`
   rebuild + elevated `Restart-Service OracleWorker` to actually take effect, same as every prior
   wave's deploy step.

2. **Class X high-conviction carve-out — implemented, branch `feature/x-carveout`, PR number TBD**
   (orchestrator fills in once opened). New tri-state flag **`ORACLE_V3_X_CARVEOUT`** (config
   `v3XCarveout`; `off`/`shadow`/`on`, **DEFAULT OFF**) — **the repo's first deliberate gate
   relaxation**; every other flag in this codebase only ever raises bars. Background: Wave-4's
   `ORACLE_V3_BLEND_PRICING` made Class X exotics unreachable by construction (raw-space −5pt
   exotic penalty vs blend-space edges: max rawEdgeBlend = 0.40×0.12 = 0.048, minus 0.05 ⇒ can never
   reach X's 0.02 blend floor). The carve-out re-evaluates ONLY the blend-edge floor, penalty
   rescaled into blend units (×1/3, same raw→blend ratio the class bars already use) — every other X
   bar (odds≤15, blendEV≥12%, EV floor, raw caps+noise gate, heightened X-exclusion) stays at full
   strength, untouched. Additionally requires data-quality conviction: confirmed real xG AND
   completeness≥0.8. Reachable window is deliberately narrow (shortish-odds exotics ~3.0–3.5 with
   near-cap raw edge and near-full data quality). Full detail: `workflows/markets_v3.md`'s env-flag
   table + `.claude/skills/oracle-engine/SKILL.md`'s changelog. **DEFAULT OFF ⇒ merging and deploying
   this changes nothing** until the flag is deliberately flipped. **Recommended path: `shadow` for ≥
   a few slates, review the `shadow_pass` tally in slate reports, then decide** — never hand-flip
   straight to `on`. **Opus review pass (verdict SHIP-AFTER-FIXES) found one pre-merge P1, now
   fixed**: admitted picks would have staked/ranked on the structurally-negative `adjustedEdgeBlend`
   (≤ −0.002 by construction for every X candidate — the exact unreachability the carve-out exists to
   bypass), zero-Kelly-ing and bottom-ranking every pick it was built to admit. Fixed by exposing a
   new `adjustedEdgeCarveout` field on the gate assessment (the rescaled edge, ≥0.02 by construction);
   `analyzeFixtureMarketsV3` now swaps it in as the primary `adjustedEdge` for `xCarveout:"passed"`
   picks only — `shadow_pass` rows keep the honest (negative) blend value since shadow never reaches
   `evMarkets`. All other Opus checklist items passed clean. **Shipped as PR #65**, branch
   `feature/x-carveout`, commit `f70899a`.

## CONCURRENT SESSION NOTE — corrected, was wrong earlier this session

Earlier drafts of this section (and this session's own early behavior) treated `feature/cloud-
enrichment-routines`'s WIP as sharing this exact checkout and stashed/popped it around commits. That
was a **mistaken assumption** — `feature/cloud-enrichment-routines` is checked out in its own
separate git worktree at `C:\wt-fix1` (`git worktree list` shows it), entirely independent of this
directory's working tree and index. The files that looked like "uncommitted concurrent WIP" here
(`.env.example`, `apps/worker/src/dailyAcquisition.ts`, `packages/runtime/src/env.ts`,
`packages/runtime/src/newsIntel.ts`, `workflows/news_intel.md`, `workflows/scrape_fixtures.md` +
untracked `tools/sync_cloud_news.py`, `tools/test_sync_cloud_news.py`, `workflows/cloud_news_intel.md`,
`.github/workflows/browser-scrape.yml`) were **stale orphaned duplicates of an earlier draft** — the
real work was finished independently in the `wt-fix1` worktree and landed as commit `18f71e2`
(**PR #64**, "feat(runtime,worker): cloud news-intel routine + off-box xG GH Actions tier"), pushed to
`origin/feature/cloud-enrichment-routines`. Verified via diff: the orphaned copies in this checkout
differed from the committed version only in trivial wording polish — nothing unique was at risk.
The orphaned untracked files were confirmed byte-identical (`md5sum`) to their committed counterparts
and left alone (not deleted, not part of any commit here) — **safe to delete or `git clean` them from
this checkout** next time someone's in here, since they're redundant with PR #64. The tracked-file
diffs (`.env.example`/`env.ts`/etc.) are already gone from this checkout's working tree as of this
commit — nothing left to reconcile. **If two sessions land in the same checkout again, verify with
`git worktree list` before assuming shared state** — this mistake cost several stash-cycle round-trips
for no reason.

## OPEN ITEMS carried forward

- **Wave-4 soak gate unchanged**: ≥7 REAL production slates must clear the parity harness before
  deleting `scanMarkets`/`scanAllMarketsFallback` or flipping `ORACLE_LEGACY_PRICER=off` — do not
  force this regardless of how clean Wave-4 looks so far.
- **Shadow-promotion list, on evidence only**: per-segment calibration flip, pi-ratings +0.002 RPS
  walk-forward bar, sharp-feed 95%/7-consecutive-slates verification, lake baselines/HFA flags.
- **PR #37** (docs-only `CLAUDE.md` restructure) — still open + conflicting against current `main`;
  owner decided 2026-07-11 to leave it for now.
- **Watchdog-fix deploy pending merge** (item 1 above) — rebuild + restart still owed once PR #63
  lands.
- **News-gate anomaly + live pick-volume watch** from the Wave-4 memory — still open observations,
  not yet resolved either way.
- **What to do next on resume**: the merge decision on PR #63, PR #65 (carve-out), and PR #64
  (cloud-news, separate worktree/track) is the **user's** call, not to be made unilaterally. After
  either PR #63 or #65 merges, deploy = the standard `pnpm turbo run build --concurrency=1` rebuild +
  elevated `Restart-Service OracleWorker`. For the carve-out specifically, **recommended rollout is
  flip `ORACLE_V3_X_CARVEOUT=shadow` right after
  deploy**, let it run ≥ a few slates, and **only promote to `on` on ledger evidence from
  `shadow_pass`-tagged assessments** — never hand-flip straight to `on`.

═══════════════════════════════════════════════════════════════════════════════════════════════════

# Handoff — ORACLE audit fixes + xG/coverage/enrichment (feature/audit-fixes-wave1)

_Updated again 2026-07-09. This pass closed the entire "Model-accuracy items from the three earlier
2026-07-06 audits" list further down (mini-ACCA haircut, lake-baselines+per-league HFA, skew
auto-conservatism, tournament-prior n<5 shrink, graduated xG penalty, rubric shadow-track) — every
item in that section is now DONE; that section's narrative is still accurate as history but its
"genuinely still open" framing is stale. Also settled `correct_score` into the calibration ledger
(a fresh finding, not on any prior list) and closed out the PPDA/reverse-line-movement dormant-tools
question (investigated, found already-correctly-wired, no code change needed — see
`workflows/gbm_residual.md`). Skip to this section for current state; sections below (including the
2026-07-08 "Latest close-out") are still-accurate history, just superseded on status.

## PENDING ITEMS — current state (2026-07-09, cold-read this first)

Branch `feature/audit-fixes-wave1` (PR #53). HEAD `03e173a`, fully pushed, tree clean (only this
file + the concurrent session's untracked `CLAUDE.md`/`.claude/skills/oracle-engine/` remain). The
entire model-accuracy audit backlog from all three 2026-07-06 audits is CLOSED. Per-league HFA — the
one item the section below still calls "another session's uncommitted work" — is now COMMITTED as
`03e173a` (that note is stale). What actually remains:

**0. NOT LIVE YET — activate what's shipped (highest ROI, user-gated).** Everything on this branch is
committed + green but does nothing in production: the deployed `OracleWorker` runs older code and the
two new lake flags default OFF.
   - Merge PR #53 → main, then rebuild (`pnpm turbo run build --concurrency=1`) + restart
     `OracleWorker` (elevated `Restart-Service`) so the audit fixes actually price real picks.
   - Only after that, decide on flipping `ORACLE_V3_LAKE_BASELINES` / `ORACLE_V3_LAKE_HFA` on — FIRST
     run `python tools/compute_league_baselines.py --report` and review the per-league diff (it's a
     live pricing change: PL baseline +0.13, Ligue 1 −0.13; PL HFA 1.08 vs global 1.10). Both flags
     fail open to the static table/global, default off = byte-identical to today.
   - The lake tool is NOT cron-wired (`.tmp/backfill` is static historical data). Regenerate the
     JSON manually when new season data lands.

**1. Data-enrichment track (PR-25) — the only remaining feature work, each needs fresh design.**
   - Item 2: referee-assignment fetcher (no fetcher exists, effort M) + a referee→cards adjustment.
   - Item 4: FBref advanced features (npxG/xA/PSxG as DISTINCT signals). NOTE: FBref plain-xG is
     already consumed via `build_xg_table`; only the advanced columns are unwired.
   - Item 5: ClubElo. NOTE: already covered BY DESIGN — the engine uses its own pi-ratings as the
     ClubElo stand-in (`gbm/index.ts:230`, `execution/index.ts:1851`); wiring raw ClubElo would
     duplicate/conflict. Treat as done-by-design unless a concrete need appears.

**2. Test/triage debt (from specialist reviews).** PR-22 CRITICAL test-coverage gaps (4 items) +
INFORMATIONAL review-finding triage (PR-22 x4, PR-23 x3).

**3. Blocked / not actionable now.** PR-24 FotMob per-match xG (gated on live `xG coverage:` data
accumulating — needs #0 deployed + a few days first) · PR-26 items 4/5 (browser-page budget declined,
off-box VPS = owner decision) · PR-12 PGlite→SQLite (user-deferred) · RAM/hosting (blocked on the
user creating an Oracle Cloud account — see "Machine/hosting" below).

**This session's contribution (P0-2 + P3, 3 commits):** `331e981` lake-baseline compute tool
(+7 pytests) · `15602c8` engine wiring behind `ORACLE_V3_LAKE_BASELINES` (+11 tests) · `03e173a`
lake-fitted per-league HFA behind `ORACLE_V3_LAKE_HFA` (+8 tests). All default off, fail open, static
table/global as fallback. Verified: typecheck 11 pkgs · tool pytest 11/11 · runtime env 53/53 ·
engine goalsV3 67/67 · biome clean · reviewed clean (no P0/P1). Docs: `.env.example`,
`workflows/markets_v3.md` flag table, `.claude/skills/oracle-engine/SKILL.md` changelog.

## Latest close-out (2026-07-09 session)

**Context**: this session picked up from a compaction boundary mid-way through implementing the
findings of an audit-verification pass (three 2026-07-06 audit docs cross-checked against live code;
see "Model-accuracy items" section below for the original list). Standing instruction was "proceed
and implement/fix all pending issues" — everything below is that instruction's output.

**Shipped, tested, reviewed (`/gstack-review`-equivalent Opus pass on every diff >50 lines), pushed**
— HEAD is `6db1519`, branch fully matches `origin/feature/audit-fixes-wave1`, no divergence:

- `0c3cd53` — **mini-ACCA haircut** (EV-audit #5): replaced the unexplained flat ×0.85 "correlation"
  discount with the real `copulaJointProbability`/`jointProb()` method already used elsewhere in the
  engine (verified rho=0 for cross-league legs collapses to the naive independent product before
  trusting it as the fix's foundation). Surfaced the separate "margin compounding" concern via a new
  `miniAccaTrueEv` field instead of continuing to fake it with a constant.
- `87c7449` — **tournament-prior n<5 shrink** (Desktop-2) + **xG blend weight scaled by sample size**
  (was flat 50/50 regardless of n; now shrinks toward non-xG lambda at low n). `SHRINK_N` exported
  from `lambda.ts` for reuse.
- `eca7069` — **rubric post-mortem shadow-track** (EV-audit #6): the n=1 title-race rule demoted from
  a live-applied adjustment to a shadow-tracked signal in `workflows/oracle_decision_rubric.md`
  (process/doc change, not code).
- `67213c9` — **graduated xG-missing penalty** (Desktop-4): added the missing 3rd tier (n>=8 raw-goals
  fallback = -1pt, not -2pt) using the same `SHRINK_N=8` threshold `lambda.ts` already treats as
  "fully trusted," instead of inventing a new one.
- `988817a` + `11f09d3` — **skew auto-conservatism shadow diagnostic** (Desktop-7): new
  `marketsV3/skewShrink.ts` module — on a §5.6 sanity skew flag, shadow-evaluates whether a
  majority-direction pick's `adjustedEdge` would still clear its own class gate after shrinking
  `rawEdge` toward the market by 35%. Shadow-only by design (never mutates a real pick; diagnostic
  line in the daily report only). `11f09d3` is a review-fix pass: two independent specialist review
  agents on `988817a` both found the same critical bug (ad-hoc regex matching instead of reusing
  `sanity.ts`'s own `sideOfDesc`/`dirOfDesc`, which incorrectly swept an ambiguous "Home or Away"
  desc into the shrink population) — fixed by reusing the existing classifiers + exporting
  `RESULT_FAMILIES`/`TOTALS_FAMILIES` from `sanity.ts`. Re-reviewed clean after the fix.
- `a4ccc9c` — **`correct_score` settlement in the calibration ledger** (new finding, not on any prior
  audit list — surfaced while investigating why it was unsettled). It was grouped with corners/
  cards/asian_handicap under "not settleable from the 1x2 score," but a correct-score pick is a pure
  exact-scoreline equality check — same shape as the already-settled `goals_ou`/`team_total`
  families. Also investigated `asian_handicap` (its price math is goals-only too) but did NOT close
  it: the handicap line often lives only in the market specifier, never persisted onto
  `EVMarket`/`BetRecord`, so settling only the desc-recoverable fraction would silently bias the
  ledger. Documented precisely in `calibrationFeed.ts`'s header rather than shipped as a partial fix.
- `7f32e19` — docs-only: recorded that `fetch_ppda.py`/`fetch_reverse_lm.py` are already fully wired
  into `gbm_residual.py`'s training pipeline (not dormant code), the currently-saved model's real
  95-col `feat_cols` was verified byte-for-byte against `packages/engine/src/gbm/index.ts`'s
  `GBM_FEAT_COLS` (no train/inference mismatch), and PPDA/reverse-LM are a genuinely untried — not
  broken — research lever for a future Run 4.
- `6db1519` — **real CI failure, caught and fixed same session**: `988817a`'s barrel-export addition
  to `packages/engine/src/index.ts` had an unsorted export list. Passed local pre-commit (stages-only
  lint) but failed the actual GitHub Actions `pnpm exec biome ci .` step — the exact "CI Biome
  Gotcha" documented in memory (import-assist diagnostics only surface under the full `ci` command).
  Ran `biome ci .` locally to get the authoritative picture before touching anything: exactly 1 error
  (this) + 18 pre-existing warnings (console.log in `tools/verify_python_resolution.mjs`, a manual
  SYSTEM-account diagnostic script untouched by this session — `noConsole` is configured `"warn"` in
  `biome.json`, not `"error"`, so those don't fail CI and were correctly left alone). Applied Biome's
  own safe auto-fix, re-verified `biome ci .` reports 0 errors.

**Verification per commit**: typecheck clean + full package test suite green (`packages/engine`
729/729, `packages/runtime` 552-554/552-554 depending on commit) before every commit; one transient
`decision.test.ts` timeout traced to running two vitest suites in parallel on this box (resource
contention, confirmed by re-running standalone — not a real regression, box's known low-RAM ceiling,
see "Machine/hosting" section below).

**Concurrent-session collision handled again this pass** — `packages/engine/src/batch/index.ts` and
`workflows/markets_v3.md` both still carry another session's in-progress, uncommitted per-league HFA
work (`v3HfaByLeague`/`ORACLE_V3_LAKE_HFA`) at the time of writing. Used the same isolate-commit-
restore technique as documented in the concurrent-session section below (temporarily revert their
hunk via Edit, verify+commit mine in isolation, restore their hunk byte-for-byte, `git diff` to
confirm exact restoration) on both files, twice each across this session's commits. Their work is
untouched and still uncommitted, exactly as they left it — not shipped by this session, not lost.

**What's left from the original 3-audit list**: nothing — every item is now either DONE (this pass)
or was already correctly closed before this session (devig doc/code split, EV-gate true-EV floor,
league-baseline collision fix — see "Model-accuracy items" section below for the full original
list and which session closed which item).

**Still open, unrelated to the 3-audit list** (pre-existing backlog, not part of this pass's scope):
PR-25 items 2/4/5 (referee assignment fetcher — no existing fetcher, effort M; FBref npxG/xA/PSxG;
ClubElo ratings columns), PR-22 CRITICAL test-coverage gaps (4 items from an earlier Testing
specialist review), INFORMATIONAL review-finding triage (PR-22 x4, PR-23 x3), PR-26 items 4/5
(browser-page budget, off-box swarm VPS), PR-12 (PGlite→SQLite, user-deferred), RAM/hosting decision
(blocked on the user creating an Oracle Cloud account — see "Machine/hosting" section, unchanged).

## Prior close-out (2026-07-08 session)

Working tree clean (`git status --short` shows only this file, untracked as always). `origin/feature/
audit-fixes-wave1` has nothing this branch doesn't already have — fully pushed, no divergence. HEAD
is `e945124`.

**Committed this pass** (on top of the "uncommitted right now" pair below, which this pass found
already-correct and simply committed+pushed after independently re-deriving and verifying the same
two fixes via its own `/gstack-review` pass — see the "concurrent session" note lower in this file for
why two sessions converged on identical fixes):
- `3ac67b6` — the `feedDictionary.ts` suffix-convention generalization described below.
- `13ea3f6` — the `scrape_fixtures.py` weather city-dedup fix described below, PLUS two more real bugs
  the same `/gstack-review` pass caught on top of it: the per-event loop had no exception handling
  (one bad event could blank the whole slate's weather, since this loop runs before the
  ThreadPoolExecutor that isolates failures elsewhere), and `fetch_forecast()` built its URL/cache
  path from `date_iso` with no format validation (defense-in-depth fix, mirrors this file's existing
  `_to_iso()` pattern — low real risk today since the only caller derives it from an internal
  timestamp, but cheap to close). Also reused `fw.ADVERSE_PRECIP_MM`/`fw.ADVERSE_WIND_KPH` instead of
  a duplicate local copy. 18 tests total in `test_weather_fetch.py` now (was 17).
- `a775773` — new `batchDecisionDisagreement.test.ts`, closing the zero-coverage gap `/gstack-review`'s
  testing specialist found on `3618ae1`'s EV-sort fix. Verified the test actually catches the
  regression (reverted the fix locally, confirmed the test fails, restored it).
- `e945124` — **PR-26 item 1, new work**: `tools/lib/artifact_health.py` (freshness/yield registry
  for team_xg_table.json, fotmob_xg.json, ai_mode_xg.json, availability_features.csv,
  market_catalog_overlay.json, today's sidecar — OK/WARN/MISSING per artifact), `acquire_daily.py
  --health` CLI flag, wired into `sendDailyFixtureReport`'s log line + Telegram caption
  (`getDataHealthLine`, best-effort, matches every other Python-subprocess call in that file).
  Live-verified against this box's actual `.tmp/` state (not just tests): correctly reported
  `availability` at 28.3 days old (STALE) and `catalog-overlay` as MISSING (expected,
  `ORACLE_CATALOG_OVERLAY` defaults off).

**PR-26 item 4 (browser-page budget) explicitly DECLINED, not just deferred** — verified
`tools/swarm_dispatch.py`'s `browser_swarm_max_workers` already caps concurrent Playwright pages at 4
on this exact box (the deliberate, incident-hardened fix for the GPU-driver-crash root cause), plus a
`_MIN_FREE_MB_FOR_BROWSER` pre-launch memory gate, plus the two page-consuming tiers (fotmob,
xg-fallback) already run sequentially, never concurrently with each other. A new global budget on top
would be redundant with already-adequate, battle-tested protection — the plan item was written
without full visibility into how much `swarm_dispatch.py` already covers. **PR-26 is now fully
closed**: items 2/3/6 already done (see below), item 5 remains an owner decision (same as the RAM/VPS
section further down — it's the same decision), item 1 shipped, item 4 declined with reasoning.

**What's actually left, in priority order:**
1. PR-25 items 2 (referee — no existing fetcher, effort M), 4 (FBref npxG/xA/PSxG, effort S/S-M,
   partial fetcher exists), 5 (ClubElo, effort S, partial fetcher exists). Plan's own sequencing:
   4 → 5 → 2.
2. PR-24 (FotMob per-match xG harvest) — still gated on live `xG coverage:` Telegram data
   accumulating now that the worker is actually deployed (see the deploy-gap story below).
3. RAM/hosting decision — still blocked on the user creating an Oracle Cloud account (see the
   "Machine/hosting" section below); nothing else can move on that track.
4. The accuracy-audit backlog — pure-math/low-blast-radius, not in any PR-9-26 scope:
   - **lake-computed league baselines (audit P0-2): DONE 2026-07-08.** `tools/compute_league_baselines.py`
     (331e981) computes recency-weighted per-league goals/game from the `.tmp/backfill` results lake +
     a `--report` staleness diff; engine wiring (15602c8) threads it through `computeV3Lambdas` behind
     `ORACLE_V3_LAKE_BASELINES` (default OFF ⇒ byte-identical to the static table; static stays the
     fallback). Report already shows PL +0.13 / Ligue 1 −0.13 / Eredivisie −0.15 off static. To go
     live: run the tool's `--report`, review the diff, then set the flag on.
   - **AUDIT BACKLOG FULLY CLOSED 2026-07-09** — every remaining accuracy item from the two designated
     audits (+ the Desktop concepts) is now shipped: mini-ACCA relabel (0c3cd53/bbcff34),
     rubric shadow-track (eca7069), n<5 shrink ramp (87c7449), graduated xG penalty (67213c9),
     skew auto-shrink shadow (988817a/11f09d3/6db1519), PPDA/reverse-LM dormant-tools note
     (7f32e19), correct_score calibration (a4ccc9c) — all by the concurrent session — plus
     **per-league HFA (full-audit P3): DONE 03e173a** (lake-fitted `hfaByName`, flag
     `ORACLE_V3_LAKE_HFA`, default off; PL 1.080 / Serie A 1.076 / Championship 1.134).

**Confirmed no data loss / no conflict from the concurrent-session activity documented lower in this
file** — `git log` shows a clean linear history through `e945124`, `git status` is clean, origin
matches HEAD exactly.

## The goal this branch (and the wider project) is working toward

ORACLE is an automated football-betting analysis agent: scrape SportyBet + stats/xG/odds sources →
price every market with a deterministic Poisson/Dixon-Coles engine (`marketsV3`) → gate on true EV →
have an LLM arbiter ratify/override → post picks to Telegram + optionally auto-book on SportyBet →
resolve yesterday's results → feed outcomes back into a calibration ledger. This branch
(`feature/audit-fixes-wave1`) is a large, multi-session **accuracy-and-robustness audit** closing out
P0/P1 findings from three earlier 2026-07-06 audits (EV-gate math, league-baseline staleness, xG/data
coverage gaps) plus two later PR-numbered work plans (PR-9→18, PR-19→26) that converged onto this one
branch. The throughline across all of it: the pricing math and data feeding it should be *correct and
fresh*, not just "runs without crashing."

## Status at a glance

- Branch `feature/audit-fixes-wave1`, PR **#53**: last known OPEN, MERGEABLE, CI green at HEAD
  `2a243e6` (see full history below) — **re-check `gh pr view 53` before trusting this**, since CI
  hasn't seen the two new uncommitted fixes yet.
- **Deployed and live** as of 06:10 WAT (2026-07-08) — `OracleWorker` service confirmed Running,
  Automatic start type. That deploy predates today's two new fixes below (they're uncommitted, so
  obviously not yet built/deployed).
- Two plans that shared this branch (`let-s-implement-this-audit-greedy-kazoo.md` = PR-9→18, and
  `task-notification-task-id-a5f315edf7180-sorted-karp.md` = PR-19→26) have fully converged — no
  more "whose commit is whose," just one history.

## Uncommitted right now — verified passing, not yet committed/pushed

`git status --short`:
```
 M packages/engine/src/marketsV3/feedDictionary.ts
 M packages/engine/test/marketsV3.test.ts
 M tools/scrape_fixtures.py
 M tools/test_weather_fetch.py   (untracked → now present, 17 tests)
?? packages/engine/test/batchDecisionDisagreement.test.ts   (untracked, 1 test)
```

**Fix 1 — `feedDictionary.ts`, second team-scoping naming convention for `exact_goals`.**
`a4c2910` (already committed, see history below) fixed team-scoped Exact Goals pricing for catalog
ids 23/24 ("Home/Away Team Exact Goals" — a PREFIX naming convention). This uncommitted change
generalizes the same fix to a second, independent SUFFIX convention the catalog also uses: ids
450002/450003 ("Goal Bounds - Home/Away") and 450005/450006 ("Excluded Goals - Home/Away"). Without
this, those four market ids silently fell through to match-total pricing — the same ~1.69x
overstatement bug `a4c2910` fixed for the other four ids. `marketsV3.test.ts`'s edit is unrelated and
trivial — two test names/comments had the wrong catalog id (22→21) for the match-total "6+"/"3+"
exact_goals tests; no behavior change.

**Fix 2 — `scrape_fixtures.py`, `_load_weather_table` silently dropped weather for the second of two
teams sharing a city.** The old code kept a `seen: set[(lat,lon,date)]` and skipped the whole
fetch-and-store step on a repeat key — meaning when two teams share a city (Inter/Milan at San Siro,
Roma/Lazio at the Olimpico), only the first-processed team ever got a `table` entry; the second got
silently no weather data at all, with no error. Fixed by caching the **fetch result** keyed by
`(lat, lon, date)` instead of just membership, so every team sharing that key still gets its own
table write from the one shared network call. Also added a per-event try/except so one team's fetch
exception can't blank weather for the rest of the slate (this loop runs before the
`ThreadPoolExecutor` that isolates failures elsewhere in the file — an unhandled exception here
previously would have propagated and aborted the whole day's weather, not just one fixture).
`test_weather_fetch.py` is a new 17-test file covering `fetch_forecast`'s cache/negative-cache/parse/
error paths, `city_for_team`, and all of `_load_weather_table`'s branches including both bugs above
as named regressions. Recall `ORACLE_FETCH_WEATHER` still defaults **off** in the real `.env` — this
fix improves correctness for whenever it's eventually flipped on, it does not change any live
behavior today.

**Verified this session** (targeted runs, not full turbo — see the box's OOM history below):
- `python -m pytest tools/test_weather_fetch.py -q` → **17 passed**
- `npx vitest run packages/engine/test/marketsV3.test.ts packages/engine/test/batchDecisionDisagreement.test.ts --root packages/engine` → **2 files, 88 tests, all passed**

**Not yet done**: `git add` + commit + push. No TS/Python lint pass run on just these files. Full
`pnpm turbo run typecheck test build --concurrency=1` not re-run (box constraint, see below) — the
targeted test runs above are the verification that exists so far for this specific diff.

## Full implementation history — everything shipped on this branch

**Wave 1 (P0), Wave 2 (P1)** — EV-gate true-EV floor, league-baseline refresh + ID-collision fix +
`lambdaV5` wiring, calibration settlement from clean outcome desc, acquire→batch→goals cron
chaining, dynamic rho + recency decay, squad-availability→λ (both goals and all-markets pipelines),
FotMob live-xG decoupled to its own 02:00 WAT cron. 9 commits, `ca700d8`…`6837d96`.

**PR-8a/8b** — persisted-state (not in-memory-timer) T-30m closing-odds sweep cron; real CLV +
steam/sharp-compression signal computed post-hoc on `ResolutionRecord` (the original "wire into
`fixtures.ts`'s opening-odds telemetry" framing was temporally impossible — decisions fire hours
before any T-30m snapshot exists — redirected after catching this mid-implementation). `cbdc44d`,
`e66a5e3`.

**PR-9** — full worker god-file split: `apps/worker/src/index.ts` down from ~2400 to a 612-line
cron shell; 5 new pipeline modules (`dailyAcquisition.ts`, `dailyBatch.ts`, `goalsAccumulator.ts`,
`goalsV3Pipeline.ts`, `resolveYesterday.ts`) plus `workerContext.ts`/`workerUtils.ts` for shared
bootstrap/helpers. Landed in two steps across sessions: `d0407f4` (minimal wiring), `3eac0f1`
(full split).

**PR-10 through PR-18** — generalized retry primitive (`withRetry`, `runPythonScript`, Telegram
`post()` retries); startup effective-config log with env-vs-default drift warnings; cross-batch
portfolio correlation veto (same-day-committed legs, with a same-fixture bypass on the correlation
primitive); venue-split scoring preferred over pooled stats in `buildStatsOverride`; booking's
exotic-market matcher made family-first via the catalog bijection (was a collision-prone substring
match); backtest significance floor raised 30→300; `ConvergenceTier` Kelly-multiplier composed with
the existing stake cap; Open-Meteo forecast wired into `applyEnvironmentalPenalties` and
`MLSafetyFilter`'s badWeather check. 11 commits + review-fix follow-ups, `9bd3b47`…`132b63a`.
PR-12 (PGlite→SQLite) is the one item **not** shipped — see "Deferred" below.

**PR-19 through PR-23** — Google AI-Mode xG fallback tier + provenance-downgrade fix + coverage
reporting; `RouteCoverage.unrouted` tally persisted through to the manifest and a Telegram
`markets:` summary line; weekly catalog-drift report + runtime overlay (`extendCatalog`, off by
default); corners/cards variant grids + a new shots-on-target NB module; `ENABLE_LLM_MARKET_
EXECUTOR=unmapped` tri-state scope so the LLM tail-sweeper can run against v3's leftover/uncatalogued
markets without displacing the deterministic draft. `ba09d1b`…`e1e6e85`, each with a post-commit
review pass.

**Two review-fix commits found and shipped this session** (2026-07-08), on top of already-shipped
PR-22/23 code:
- `a4c2910` — "Home/Away Team Exact Goals" (catalog ids 23/24) was pricing against the **match**
  total (home+away) instead of the named team's own axis — confirmed 1.69x overstatement of the
  true probability on every fixture routed through that market. Fixed via a new `side?: "home" |
  "away"` parameter threaded through the exotics router; regression tests added for both the bug
  and the correct match-total path.
- `3618ae1` — under `unmapped` LLM-executor scope, the executor's validated candidate gets spliced
  into `effectiveEligible[0]` regardless of its own EV rank, so array position stopped reliably
  meaning "the top-EV pick" wherever that was assumed (disagreement logging, the CVL prompt). Fixed
  with an explicit EV-sorted array at both consumption sites in `batch/index.ts`.

**PR-25 items 1 and 3** (of the plan's 5, sequenced 1→3→4→5→2) — shipped this session:
- `778dee5` — weekly squad-availability refresh (`fetch_squad_availability.py`) now runs
  unconditionally inside `runWeeklyKaggleRefresh`, right after the Transfermarkt player-scores
  refresh it depends on. No env flag (matches every other unconditional fetcher in that function).
  Retires the old daily-cron-gated-off-by-default path that left `availability_features.csv` stale
  for 6 weeks. Plan doc calls this **"highest value/effort ratio in the whole PR-19-26 plan."**
- `2a243e6` — `fetch_weather.py` gained `fetch_forecast()`/`city_for_team()` (Open-Meteo *forecast*
  endpoint — the pre-existing `fetch_weather()` only serves past dates via the archive endpoint);
  `scrape_fixtures.py` wired it into `enrich_sportybet_events`'s per-fixture `weather` block.
  **Deliberately kept `ORACLE_FETCH_WEATHER=off`** — a deviation from the plan doc's "default on,"
  because the flag is the sole gate on `@oracle/engine`'s already-shipped, unconditional
  `applyEnvironmentalPenalties` λ adjustment (dormant only for lack of data until now) — flipping it
  is a live pricing change, not a cheap toggle. `.env.example`'s comment spells this out for
  whoever considers flipping it.

## Deploy-gap incident — found and fixed this session (2026-07-08, 05:58→06:10 WAT)

`apps/worker`'s `start` script runs a **compiled** `node dist/index.js`, not source. Its
`dist/index.js` had a build timestamp of **2026-07-06 10:27 WAT** — which predates this branch's
own merge-base with `main` (`717cb20`, 2026-07-06 **11:01:35** WAT) by half an hour. Every other
workspace package's `dist/` was already fresh (rebuilt piecemeal during various commits'
verification passes across sessions) — `apps/worker` was the one package nobody had rebuilt, going
back to before Wave 1. **Net effect: every commit on this branch — all of the implementation above
— was committed, tested, and CI-green, but the live `OracleWorker` had never executed any of it. It
was still running whatever was on `main` before this branch existed.**

Fixed before today's 09:30 WAT batch: `pnpm turbo run build --concurrency=1` (`@oracle/worker:build`
showed "cache miss, executing," confirming it genuinely hadn't built before; all 11 packages
completed clean) → confirmed the PR-9-split modules compiled with current content (`grep` for
`fetch_squad_availability` in the new `dailyAcquisition.js`) → restarted `OracleWorker` via elevated
`Restart-Service` (new Servy PID 19092, was 4932) → confirmed it's genuinely running the new build,
not just bounced: PR-11's startup `effective config:` log line appeared in
`.tmp/servy_worker_stdout.log` for the first time ever. Boot-time flag snapshot: `enableMarketsV3:
on, v3LambdaV5:true, v3GatesV4:true, v3CompletenessV4:true, v3CornersCards:true,
v3GoalsCrossCheck:true, marketsV3Gate:true, marketsCoverageNote:true, catalogOverlay:false,
calibrationLedger:shadow, enableLlmMarketExecutor:true, llmExecutorScope:full, useNegBinom:true,
useMCRuin:false`. No new stderr errors post-restart (the DNS/Telegram/bot-stale lines visible in the
log tail are leftover from 07-07's run, not fresh).

**One value from that boot snapshot worth a follow-up look, not investigated further this
session:** `v3VenueSplitUsed` read `false`. PR-14 (`ec0b145`) was supposed to wire real venue-split
scoring in — could be correctly false (no fixture in the boot-time sample had venue-split data
available) or could mean that wiring needs a second look. Check `packages/runtime/src/
sportyBetStats.ts`'s `buildStatsOverride` against this flag's source next time someone's in that
code, before assuming either way.

**Systemic takeaway, not yet acted on:** this is the same failure class documented before
(`OracleBot` missing `EnableHealthMonitoring`, the `.env`→`process.env` backfill gap) but the
largest instance yet — a service PID bouncing doesn't mean new code is running if `dist/` itself is
stale, and nothing currently checks build freshness automatically. PR-26 item 1 (artifact-health
watchdog, scoped below for data freshness) could reasonably be extended to cover build freshness
too — check `dist/*.js` mtime against the latest commit touching that package's `src/` on a cron,
WARN if stale past some threshold.

## What's still pending

- **PR-24** (FotMob per-match xG harvest via browser interception): gated on "PR-19's coverage line
  quantifies the remaining gap." That line has never run in production until today's deploy — let a
  few days of live `xG coverage: X/Y` Telegram captions accumulate before deciding if the spike
  justifies this PR.
- **PR-25 items 2, 4, 5** (referee assignments, FBref advanced stats [npxG/xA/PSxG], ClubElo
  ratings) — none started. Plan sequencing: fbref (4) next, then elo (5), then referee (2) last
  (referee has no existing fetcher at all — effort M; the others are S/S-M with partial fetchers
  already in place).
- **PR-26 item 1** (acquisition yield telemetry + freshness watchdog, `tools/lib/artifact_health.py`)
  — not started. Would have caught the FotMob zero-yield bug, the 6-week-stale availability CSV,
  *and* tonight's deploy gap automatically instead of by manual audit each time. Worth prioritizing
  — see the "systemic takeaway" note above for the build-freshness extension idea.
- **PR-26 item 4** (02:00-window global browser-page budget, ≤80 pages/cap 4) — not started, worth
  doing before PR-24 adds another browser tier to the same window.
- **PR-26 item 5** (off-box swarm VPS) — explicitly an owner decision in the plan doc, not a code
  task.
- **PR-12** (PGlite→SQLite storage engine) — deferred, user's explicit call via AskUserQuestion.
  Real blocker: Vitest/Vite 5.4.21 doesn't recognize `node:sqlite` as an externalizable builtin
  (confirmed empirically), and `better-sqlite3`'s native build needs a `pnpm approve-builds` step
  that wasn't run since it wasn't user-requested. Re-open only when the user wants to resolve that
  fork directly.
- **PR #53's title/description** — still says "waves 1-2," stale now that the branch spans both
  plans through PR-25(partial). Cosmetic, never actioned since the PR is shared across sessions.

### Model-accuracy items from the three earlier 2026-07-06 audits — status re-verified

**[2026-07-09: every "genuinely still open" item below is now DONE — see "Latest close-out" at the
top of this file for what shipped and which commit. Left as-is below for the original investigation
narrative (why each item mattered, what the audits actually found); just don't trust the open/closed
status inline, trust the top section.]**

A verification pass this session checked every finding from the three 2026-07-06 audit memories
([[oracle-full-system-audit-2026-07-06]], [[oracle-ev-strategy-audit-2026-07-06]],
[[oracle-desktop-prompt-fork-audit-2026-07-06]]) against current HEAD. The **P0 tier of all three is
closed** (EV-gate floor, calibration settlement, acquire→batch chain, league-baseline
collision+refresh, DC-rho+recency decay, absences→λ — all shipped above). Of the remaining
**accuracy** items (none are in any PR-9 through PR-26 scope, all pure-math/flag-gateable/
low-blast-radius), one turned out to already be closed on closer inspection — listed first, so it
doesn't get lost — the rest are genuinely still open:

- ~~**Devig doc/code split**~~ — **CLOSED, was mis-flagged as still-open in an earlier draft of
  this section.** The original 2026-07-06 finding (EV-audit #2) was real at the time: `docs/
  prompts/all-markets-analysis-prompt-v4.md` §4.1 described multiplicative 2-way devig while
  `devig.ts`/`evGate.ts` computed additive. Checked the actual doc this session — §4.1 now reads
  "de-vig the pair via the **additive** method... mathematically identical to the Shin (1993)
  method for exactly two-way markets... see `packages/engine/src/markets/devig.ts` for the
  citation," and a worked-example note explicitly warns readers that two earlier drafts used a
  multiplicative/proportional formula that "the live code has never used." Fixed in `ca700d8` —
  this branch's very first commit (2026-07-06 22:53, bundled into the EV-gate-floor fix) — so it
  predates essentially all of the implementation history above. Confirmed via `git log` on the doc
  file. **Don't re-flag this one without re-reading the actual doc first** — both a caveat added
  earlier in this same session and the concurrent session's "verified open" note above were wrong
  about this specific item; [[oracle-ev-strategy-audit-2026-07-06]] has been corrected accordingly.
- **Mini-ACCA ×0.85 haircut mislabeled** (EV-audit #5): legs are ~independent, so a flat ×0.85
  mislabels correlation and ignores parlay-margin compounding `(1+m)^n`. Untouched, not re-verified
  this session beyond confirming no commit on this branch touches it.
- **Lake-computed dynamic league baselines / per-league HFA fit** (full-audit P0-2 *ideal form* +
  Desktop-audit #1): the collision-gap fix and static-table refresh shipped in Wave 1/2; the
  auto-compute-from-lake replacement and a per-league HFA fit did not. Only a global `v3Hfa: 1.1`
  exists (`packages/runtime/src/env.ts`); the ID-keyed baseline override map is present but empty
  (`packages/engine/src/goalsV3/lambda.ts`).
- **Skew auto-conservatism, shadow-mode** (Desktop-audit #7): `sanity.ts` detects
  `result_skew_*`/`totals_skew_*` but there is no shrink consumer and no `ORACLE_V3_SKEW_SHRINK`
  flag anywhere in the codebase. Proposed remedy unchanged: on a §5.6 sanity fire, shrink the
  majority-direction `P_model` toward the market `q` by 25-50%, shadow-first, promote on ledger
  evidence.
- **Tournament-prior faster n<5 shrink** (Desktop-audit #2): the World Cup baseline did refresh to
  2.65 (incidentally, via the general baseline pass, not this specific fix), but `shrink()` still
  uses a single linear `n/8` ramp rather than a faster `n/5` ramp below n=5.
- **Graduated xG-penalty distinction** (Desktop-audit #4): PR-19 shipped the flat `estimated`-
  provenance −1pt downgrade; the graduated incomplete(−1)/none(−2)/n≥8-raw(−1) tiers remain
  unconfirmed in `evGate.ts`. Low stakes.
- **Rubric post-mortem n=1 anecdotes → shadow-track first** (EV-audit #6): process/doc change, not
  code — not started.

None of the Desktop prompt-fork audit's 4 accepted concepts is fully implemented — only the WC
prior value (2.65) landed, and only incidentally via the general baseline refresh. The rejected
items from that audit (hardcoded HFA tier table, pseudo-xG formula, baked-in slate picks) stay
rejected — do not re-import if they resurface. Suggested order if this list gets picked up (devig
dropped — it's closed, see above): lake-baselines + per-league HFA → skew-shrink (shadow) → then
the smaller mini-ACCA / n<5-shrink / graduated-penalty cleanups.

## Two operational flags worth knowing before assuming behavior

1. `ORACLE_FETCH_LIVE_XG=on` in the real `.env` — the 02:00 WAT FotMob cron runs a real Playwright
   swarm daily on the 7.84GB-RAM box (documented BSOD/OOM history). Watch that window periodically.
2. `ORACLE_FETCH_WEATHER` defaults **off**, not set in the real `.env` — the weather feature (PR-18
   + this session's PR-25 item 3) is fully wired but inert until someone deliberately flips it.

## Concurrent-session protocol (still relevant — happened live during this session)

Two Claude Code sessions were editing this branch **and this file** simultaneously during this
session: the 8-file diff analyzed above was committed and pushed by a different session
(`a4c2910`/`3618ae1`/`778dee5`/`2a243e6`) while this session was mid-way through the same fix; the
"Model-accuracy items" section above was added directly to this file by that other session, not by
edits from this one. Nothing was lost in either case — verified by re-reading actual file/code
content, not just git status — but if you're resuming this branch and another session might be
active: re-run `git status --short` immediately before any commit/build step, not just at task
start, and re-read this file fresh rather than trusting a cached view of it, since it can change
out from under you mid-task.

## Machine/hosting: RAM, and moving the worker off this box

Separate track from the accuracy audit above, but load-bearing on the same box: this machine has
**only 7.84 GB RAM** and has a documented crash history (7 BSODs in ~30h, 2 worker OOMs — see
`oracle_machine_crash_2026_07_05` memory). Quick Heal AV has since been uninstalled (one contributing
factor removed), and a Servy heap-ceiling fix + crash-loop backoff shipped, but the underlying
RAM ceiling is unchanged. `ORACLE_FETCH_LIVE_XG=on` now runs a real Playwright browser swarm daily
(02:00 WAT) — exactly the memory-pressure class that caused the BSODs, just moved to an off-peak
window rather than removed.

**Recommendation given (RAM upgrade):** 16 GB is the floor to clear the worker's own peak
(Node ~2GB + browser swarm ~2GB + OS/AV); **32 GB** recommended if this box keeps double-dutying as
the interactive dev machine (VS Code + Claude Code) *while* the worker/browser-swarm/turbo builds
run — the two workloads' peaks genuinely overlap and both matter here. A second, independent reason
to separate the two: the worker's LLM arbiter tier (`ORACLE_RUNTIME=local`, spawns the `claude` CLI)
shares this machine's interactive Claude Code OAuth session — a live batch was caught mid-run hitting
"You've hit your session limit" because of exactly that contention (see
`oracle_resolution_zero_match_blocker` memory's "LLM tier rate-limited" note).

**Alternative to buying RAM — move the worker to a VPS**, researched this session:
- **GitHub Actions**: ruled out. Scheduled-workflow cron has documented 10–30 min delays (sometimes
  dropped) under load, no persistent daemon (wrong for an always-listening Telegram bot + PGlite
  lake state), and auto-disables after 60 days of repo inactivity. Wrong shape for this workload.
- **Oracle Cloud "Always Free" (Ampere A1 ARM)**: recommended first try — genuinely $0/month forever,
  and even after Oracle halved the free allowance (June 15, 2026) it's still 2 OCPU/12GB, comfortably
  above ORACLE's ~8GB peak. Real risk: free A1 capacity is often unavailable when actually
  provisioning (well-known community pain point) — pick a less-popular home region (UK South,
  Frankfurt, smaller APAC) to improve odds, and that region choice is **permanent** for the account.
  **Blocked on the user** — needs a personal OCI account (email/phone/card verification) I can't do
  on their behalf. Nothing else can proceed on this path until that account exists.
- **Hetzner (paid fallback)**: CX32, 4 vCPU/8GB ≈ $9/mo — guaranteed availability (no capacity
  gamble), 3-5x cheaper than DigitalOcean/Vultr for the same spec. The clear "just works" option if
  Oracle's free tier can't be provisioned.
- **Claude Code CLI on a remote box**: confirmed viable — `ANTHROPIC_API_KEY` env var bypasses OAuth
  entirely, or `claude setup-token` mints a portable 1-year OAuth token, either way decoupling the
  worker's arbiter calls from this machine's interactive session (fixes the rate-limit contention
  above as a side effect of migrating).
- **nexo.systems** (asked about this session): prepaid KVM VPS provider (Skylink DC, Eygelshoven NL),
  Intel Xeon/AMD Ryzen plans up to 8-core/~32GB confirmed via a public benchmark listing. Trustpilot
  ~4/5 stars but only **16 reviews** — too thin to be conclusive on its own; one independent positive
  mention on LowEndTalk ("nice owner, stable, good performance for the price"); no red flags
  (scam/billing-dispute reports) surfaced. Could not verify current pricing/SLA/refund policy
  directly — both nexo.systems' own site and Trustpilot returned HTTP 403 to automated fetches this
  session, so this is secondary-source signal only, not confirmed firsthand. **If used**: confirm
  full KVM (not container-based — Xvfb/Playwright need real virtualization), start month-to-month
  rather than a large prepaid commitment, and treat Hetzner as the safer, better-documented default
  unless nexo.systems is meaningfully cheaper for the same spec.

**Net recommendation**: try to provision Oracle Free Tier first (user action required — account
creation); fall back to Hetzner CX32 (~$9/mo) if that free capacity isn't obtainable; treat
nexo.systems as a possible cheaper alternative to Hetzner but verify its plan/SLA firsthand before
committing meaningfully, given the thin review sample. None of this is started — no VPS provisioned,
no account created, no migration code written. Purely a researched recommendation awaiting the
user's account-creation step.

## What's next (concrete, in priority order)

1. **Commit + push the two uncommitted, verified fixes above** (feedDictionary.ts suffix-convention
   scoping + the weather city-dedup bug), on this branch, following this repo's commit-message style.
   Re-run `git status --short` first in case another concurrent session has changed the tree again.
2. **Re-check PR #53's CI** after that push — last known green was at `2a243e6`, before these two
   fixes existed.
3. **RAM/hosting decision** (see section above) — waiting on the user to either buy RAM, or create an
   Oracle Cloud account (my next step, once they do: attempt A1 provisioning, set up the box, migrate
   the worker, wire portable Claude Code auth, cut over).
4. Backlog, unchanged from the prior close-out: PR-24 (FotMob per-match xG harvest, gated on live
   coverage-line data accumulating), PR-25 items 2/4/5 (referee/FBref-advanced/ClubElo), PR-26 items
   1/4/5 (freshness watchdog, browser-page budget cap, off-box swarm VPS — item 5 is literally the
   RAM/hosting decision above), PR-12 (PGlite→SQLite, user-deferred), and the accuracy-audit items
   listed earlier (mini-ACCA haircut, lake-computed baselines/per-league HFA, skew auto-shrink,
   n<5 shrink ramp, graduated xG penalty tiers).
5. Keep watching the `v3VenueSplitUsed: false` boot-snapshot value noted above next time anyone's in
   `sportyBetStats.ts` — not investigated further, could be correctly false or could be a real gap.

## Session close

Nothing uncommitted going INTO this session; two new verified-passing fixes are uncommitted COMING
OUT of it (see "Uncommitted right now" near the top). Nothing blocking, nothing broken — just not
yet pushed. The RAM/hosting track is genuinely paused on a user action (Oracle account creation),
not on anything I can move forward alone right now.
