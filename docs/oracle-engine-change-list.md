# ORACLE `packages/engine` — Prioritized Engineering Change List

**Scope:** remediation of the deterministic prediction engine based on the formula-level audit of
`packages/engine/src/{math,goalsV3,marketsV3,decision,swarm,safety,execution,calibration,ratings}`
(per the "Deterministic Prediction Math" module index) plus the live slate incident of 2026-07-09
(SRL feed contamination; unblended longshot edge inflation).

**Verdict being implemented:** KEEP the engine. Do not lower any EV bar. All observed failures
(losing underdog picks, over-filtering, ignored variables) trace to **wiring and configuration**,
not to the math foundations, which are sound and literature-grounded (Dixon–Coles 1997 with
per-league ρ; Sarmanov extension; Shin 1993 devig; Kelly 1956 quarter-fraction with hard cap;
Boshnakov 2017 correlation veto).

**Success metrics for this whole program (define before shipping anything):**
- Primary: **CLV** — mean % by which pick prices beat the closing/sharp reference line, tracked
  per market class and per league. Not short-run pick win rate.
- Secondary: calibration — Brier / log-loss / ECE per probability decile, per league, per market
  family, from the calibration ledger.
- Guardrail: pick volume per slate may **decrease** further and that is acceptable; volume is
  never a KPI.

---

## P0 — Ship first (directly causal to the reported failures)

### P0-1 · Flip the calibration ledger from shadow to live

- **Module/flag:** `calibration/index.ts` (`CalibrationEngine`), `ORACLE_CALIBRATION_LEDGER`
- **Current state:** `shadow` by default — Brier/RPS/log-loss/ECE/CLV/ROI accumulate and would-be
  `calibFactor` deltas are logged, but the engine prices at `calibFactor = 1.0`. The feedback
  loop that would correct systematic over/under-confidence has never influenced a live price.
- **Change:**
  1. Audit ledger contents: count resolved picks per league and per market family.
  2. Where the existing **bootstrap significance gate** passes (drift is real, not noise), set
     `ORACLE_CALIBRATION_LEDGER=on` so the isotonic (PAVA) / Platt `calibFactor` feeds the Kelly
     formula and — see P0-2 — the gated probability itself.
  3. Where sample is insufficient, keep shadow **per segment** (league × family granularity), not
     globally: one global switch hides segment-level readiness.
  4. Persist `raw_p` and `calib_p` side by side on every pick for drift monitoring.
- **Acceptance:** live `calibFactor ≠ 1.0` observed on segments that pass the bootstrap gate;
  reliability curves per decile regenerated weekly; alert when |raw − calibrated| divergence
  widens.
- **Risk & mitigation:** applying calibration trained on the *old* (unblended, over-filtered)
  pick distribution to the *new* pipeline. Mitigation: reset/segment the ledger at the deploy
  boundary of P0-2/P0-3 and re-accumulate; keep the bootstrap gate mandatory.

### P0-2 · Add market-anchored shrinkage to the EV gate (the underdog fix)

- **Module:** `marketsV3/evGate.ts` (edge computation), consuming the Shin fair probs from
  `math/index.ts:shinPowerVigRemoval` / `devigTwoWay`
- **Current state:** `Raw Edge = P_model − q_implied`; P_model is treated as truth. No shrinkage
  toward the de-vigged market price exists anywhere in the gate path. This is the direct
  mechanism behind losing longshot picks: an unblended Poisson-family model overrates weak sides
  in mismatches (live example 2026-07-09: fake +65–70% raw "edges" at odds 6.20 and 13.50).
  Industry practice is the reverse posture — market as prior, model as adjustment; even strong
  academic models are less well calibrated than bookmaker odds while still carrying real signal.
- **Change:** implement the v5-prompt §5.8 blend as a first-class gate stage:
  ```
  w_model = min(0.40, 0.15 + 0.15·completeness + 0.10·[real xG present])
  P_blend = (1 − w_model)·q_fair + w_model·P_model      // q_fair = Shin-devigged prob
  BlendEdge = P_blend × odds − 1
  ```
  - **Odds ≥ 4.00:** `BlendEdge ≥ +5%` is a **mandatory additional gate** on top of the existing
    Class L/X bars. Failures are logged as `model_hot_longshot`, never bet.
  - **Odds < 4.00:** compute and persist `BlendEdge` on every candidate for transparency and for
    the calibration ledger; not a gate.
  - Rank/report both `Raw Edge` and `BlendEdge` on every emitted candidate.
- **Acceptance:** replay the last N resolved slates through the new gate; confirm the historical
  losing-longshot cohort is excluded; confirm Class S/M pick flow is not materially reduced.
- **Do NOT:** raise `w_model` above 0.40 without ledger evidence (positive CLV + calibration in
  the segment) earning it.

### P0-3 · Dismantle the mis-scoped hard rejects in the safety layer

- **Module:** `safety/index.ts` — `MLSafetyFilter` (17 filters), `ConvergenceScorer`,
  `AntiSycophancyCircuit`; instantiated per fixture in `execution/index.ts`
- **Current state:** five sequential gate layers (EV gate → ConvergenceScorer hard reject at
  >5pt model-vs-implied excess → MLSafetyFilter ≥70% pass with hard rejects → AntiSycophancy →
  arbiter). Multiplied false-negative rates are the real cause of "filters out a whole lot of
  qualifying fixtures/markets."
- **Specific defects:**
  1. **`odds outside [1.3, 1.7]` hard reject** — if applied on the general path this
     single-handedly excludes nearly every DNB/DC/BTTS/OU line regardless of edge. Almost
     certainly a constraint from one legacy product that leaked global.
  2. **`xG ≤ 2.1` hard reject** — kills every legitimately low-scoring fixture outright instead
     of penalizing only its goals-family markets.
  3. **`draw-risk ≥ 61/100` hard reject** — plausible for result markets, wrong as a
     fixture-level kill.
- **Change:**
  - Trace each of the 17 `MLSafetyFilter` filters to its origin pipeline. Scope the odds-band
    filter to that pipeline or delete it. Convert xG and draw-risk rejects into **market-family
    penalties / stake-tier downgrades** (the `ConvergenceScorer` tier→Kelly-multiplier pattern is
    the correct template — extend it).
  - Hard rejects remain ONLY for integrity failures: contaminated feed (see P1-3), missing
    mandatory data, non-partition promo markets (v5 §5.7: "Never Down"/"1UP"/"2UP" families),
    withdrawn odds, started fixtures.
  - Log per-filter kill counts per slate so future over-filtering is visible, not anecdotal.
- **Acceptance:** per-filter kill-count dashboard; replay shows qualified-candidate flow
  increases **only** in S/M classes (if longshot flow increases, P0-2 is wrong or bypassed).

### P0-4 · Audit ConvergenceScorer signal polarity ("model/implied gap")

- **Module:** `safety/index.ts` — `ConvergenceScorer` (14 signals → 0–24 score → tier multiplier)
- **Current state:** "model/implied gap" is listed among the 14 additive signals feeding the
  stake tier. Polarity unverified.
- **Change:** verify: beyond a threshold, a **larger** model-vs-market gap must **lower** the
  score (evidence of model error), not raise it. If current polarity is monotone-positive, invert
  above the threshold (suggest: gap ≤ 5pt contributes positively; 5–8pt neutral; > 8pt negative).
  Cross-check consistency with the existing >5pt hard reject — signal and reject currently
  encode contradictory beliefs about what a big gap means; resolve to one belief.
- **Acceptance:** unit tests over synthetic candidates; documented signal table with sign and
  rationale per signal.

---

## P1 — Ship second (capability the failures show is missing)

### P1-1 · Wire the pi-ratings into λ ("ignored every other data variable")

- **Module:** `ratings/index.ts` (Elo + Constantinou–Fenton pi-ratings) → `goalsV3/lambda.ts`
- **Current state:** fully implemented, StoragePort-backed, **zero call sites** — the engine's
  own docs call it "a genuinely strong signal sitting unused." λ currently sees only raw
  per-game scored/conceded averages, which is why the model is blind to strength-of-schedule and
  long-run team quality. Pi-ratings were shown in the source literature (Constantinou & Fenton
  2013) to outperform Elo variants and be profitable against market odds across five EPL seasons.
- **Change:**
  1. Instantiate `TeamRatingsEngine` in the batch path; backfill ratings from the historical
     match store.
  2. Blend a ratings-derived expected-goal-difference adjustment into `computeV3Lambdas` as a
     **third factor with its own shrinkage ramp** (same `n/shrinkN` pattern already used for the
     xG blend; start weight ≤ 0.25).
  3. Gate behind a new `ORACLE_V3_RATINGS` flag, default shadow: log the with-ratings λ deltas
     for one full evaluation window before flipping live (same discipline as P0-1).
- **Acceptance:** walk-forward comparison on the ledger — with-ratings λ must improve RPS/log-loss
  by a pre-registered margin (reuse the GBM's +0.002 RPS significance convention) before the flag
  goes live. If it fails, it stays shadow — same rule that correctly keeps the GBM off.

### P1-2 · Consolidate the three pricer generations

- **Modules:** `execution/index.ts:ExecutionEngine.scanMarkets` (legacy), `goalsV3/`,
  `marketsV3/`, reconciled in `batch/index.ts:605–673` via the `usedV3` boolean
- **Current state:** three coexisting pricers; legacy LLM executor "demoted to whatever v3 didn't
  map." Behavior depends on a boolean handoff; the module doc itself warns any pipeline
  description is "a snapshot, not a spec." This is where silent inconsistencies (and yesterday's
  class of contamination bug) hide.
- **Change:** enumerate markets currently reaching legacy-only pricing; port the ones with real
  volume into `marketsV3/engines/*`; mark the remainder unpriced-by-design; delete `scanMarkets`
  and the `usedV3` reconciliation. One pricer, one code path, one spec.
- **Acceptance:** grep shows zero `scanMarkets` call sites; per-market pricing-source report shows
  100% marketsV3 or explicitly-skipped.

### P1-3 · Feed-integrity stage (Rule 0.14) in the decision layer

- **Modules:** new pre-eligibility validator invoked from `batch/index.ts:processOne`, before
  `goalsV3/eligibility.ts`
- **Current state:** nothing catches feed contamination. Live incident 2026-07-09: a real World
  Cup fixture's 736-row markets block was byte-identical to its SRL twin's, while the fixtures
  sheet's headline 1X2 disagreed with the markets tab's. The deterministic layer priced garbage
  confidently.
- **Change:** implement the v5-prompt Rule 0.14 checks as deterministic code: (a) SRL-twin block
  comparison (≥90% odds identity → real fixture flagged CONTAMINATED, restricted to
  fixtures-sheet headline markets); (b) fixtures-vs-markets headline 1X2 cross-check beyond
  rounding tolerance; (c) duplicate-block scan across distinct fixtures. Contamination is one of
  the few remaining **hard** rejects (see P0-3).
- **Acceptance:** replay of 2026-07-09 slate flags France v Morocco automatically.

### P1-4 · Sharp-reference odds feed + CLV persistence

- **Modules:** new ingest adapter; `ConvergenceScorer` inputs; calibration ledger schema
- **Current state:** `ConvergenceScorer` lists "sharp-book consensus," "RLM/steam," and "CLV
  survival" among its 14 signals — but if the only odds source is the soft feed being bet into,
  those three signals compute on air. CLV also cannot be measured without a closing snapshot.
- **Change:** ingest a sharp reference line (e.g., the sharpest available book/exchange) at pick
  time and at kickoff; persist `{pick_odds, sharp_fair_at_pick, sharp_fair_at_close}` per pick;
  make CLV the ledger's headline metric. If no sharp feed can be sourced, **zero-weight** the
  three dead signals rather than letting them contribute noise to the tier score.
- **Acceptance:** CLV populated on 100% of new picks; dead-signal weights set explicitly either
  way.

---

## P2 — Hygiene and hardening

### P2-1 · GBM re-validation cadence
`gbm/index.ts` is correctly inert (walk-forward RPS −0.0012 vs required +0.002). Add a scheduled
re-train/re-validate job (e.g., every 4–6 gameweeks) against the same pre-registered +0.002 bar so
it can earn its way in — or keep failing honestly. Never hand-flip the flag.

### P2-2 · Dead-code disposition
`weighReversibility` (`safety/index.ts:1172`): exported, zero call sites — wire it with a stated
purpose or delete it. Dormant bivariate-Poisson / ZIP / NB grid variants in `math/index.ts`: keep,
but add a one-line comment per variant stating the activation criterion so "dormant" ≠ "forgotten".

### P2-3 · Citation hygiene in source comments
Wilkens 2026 (`math/index.ts:1649`, Skellam win–draw–loss) — **now independently verified**
(Bundesliga xG/Skellam study with isotonic calibration; SAGE, 2026): upgrade its flag from
unverified → verified. Antila 2024 (`:1498`) and Lee 2025 (`:1537`) remain uncorroborated — keep
flagged, and treat the constants they justify (momentum/variance-regime, drawdown-recovery guard)
as house defaults, not literature-backed truths.

### P2-4 · Swarm cost/benefit
`swarm/` fan-out (APEX=7 / PRIME=5 / VIABLE=3 advisory workers) can never set `primaryPick`.
Either (a) log worker-disagreement rate into the ledger as a calibration/uncertainty signal —
making the spend useful — or (b) cut worker counts. Advisory votes that influence nothing are
paid-for decoration.

### P2-5 · Upstream data-pipeline completeness
2026-07-09 fixtures sheet shipped 40+ entirely empty columns (shots, possession, corners,
lineups, news). No engine change compensates for starved inputs. Add a per-slate column-fill
report emitted before pricing, and adopt the v5-prompt Phase 0.5 acquisition budget in the
decision layer to fill Tier-2 gaps (xG first) with cited sources.

### P2-6 · Decision-layer contract
Adopt `unified-markets-analysis-prompt-v5.md` as the formal job description for `decision/`:
acquisition (Phase 0.5), contamination judgment escalation (P1-3 edge cases), rationale
generation, §5.6 slate-level sanity review (directional skew, cap rate). Preserve the existing
invariants exactly as built: no LLM estimates goals or prices odds; the LLM cascade is skipped
when v3 has priced; the arbiter's `validateSelection()` hard gates cannot be bypassed by any LLM
instruction. LLM disagreement with the engine = logged flag for a human, never an edit.

---

## Sequencing & rollout

1. **Week 1:** P0-3 filter audit + P0-4 polarity audit (read-only analysis, per-filter kill
   dashboard) → then P0-2 blend behind a flag, replayed on historical slates.
2. **Week 2:** P0-2 live; ledger reset/segmented; P0-1 flipped live per segment as the bootstrap
   gate passes on post-blend data.
3. **Weeks 3–4:** P1-3 contamination stage; P1-4 sharp feed; P1-1 ratings in shadow.
4. **Weeks 5+:** P1-1 live if it clears its significance bar; P1-2 consolidation; P2 items
   opportunistically.

**Definition of done for the program:** positive mean CLV over a pre-registered window (≥300
resolved picks), reliability curves within ±3pt of the diagonal in every populated decile, zero
contamination incidents reaching the pricer, and pick volume whatever it honestly is.

**Standing notes:** do not respond to losing streaks by loosening any gate — respond via the
ledger. Even a fully remediated engine loses often over any single slate; edges are small, and
sports betting always carries a real and likely risk of loss. These changes optimize a process
metric (CLV/calibration), not outcomes.
