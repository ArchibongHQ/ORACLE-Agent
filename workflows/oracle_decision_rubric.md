# Oracle Decision Rubric v1.1

## Purpose

This rubric guides the gated LLM decision layer (`packages/engine/src/decision/index.ts`) and the AntiSycophancyCircuit when evaluating bet candidates. It is updated offline by `tools/skillopt.py` after calibration improves.

## Hard gates (never override in prompt)

These are enforced in code — no LLM instruction can bypass them. As of `validateSelection()`
(`packages/engine/src/decision/index.ts`), there are exactly two:

1. **Pick must be in `eligibleBets`**, matched on market AND side (`validateSelection` Gate 1) —
   `eligibleBets` itself is `buildEligibleBets()`'s `ev > 0 && !veto` filter, so a pick that isn't
   there is either negative-EV or already vetoed upstream (STEAM_CHASER_VETO,
   CORRELATED_PARLAY_VETO — see #2 below). `MISSING_DATA` grades are exempt: the arbiter is
   allowed to decline to commit to a market, and this gate must not silently overwrite that
   honest verdict with a fabricated pick.
2. **Stake/odds magnitude is always the engine's own number**, never the LLM's restated figure
   (`validateSelection` Gate 1.5) — the LLM may choose *which* eligible market to recommend, but
   not what it's worth.

Two further hard rejects happen **upstream of the decision layer**, before a market ever reaches
`eligibleBets`, so they're gates in the pipeline sense even though `validateSelection()` never
sees them directly:

1. **Correlated parlay ρ > 0.7 → lower-EV leg is discarded** (`CORRELATED_PARLAY_VETO`,
   `packages/engine/src/execution/index.ts`'s portfolio-covariance block) — still a live, unchanged
   hard veto.
2. `NO_BET` / `MISSING_DATA` always allowed and takes precedence over forcing a pick.

### Removed 2026-06-30 — do not reintroduce as hard gates

Two former `validateSelection()` hard gates were removed by owner instruction 2026-06-30 (grep
`decision/index.ts` for `removed per owner instruction 2026-06-30` — the comment sits directly
above `validateSelection()`'s `return pick;`, line numbers drift): the ML-safety-filter
fixture-wide `NO_EDGE` reject, and a
`drawRisk >= VERY_HIGH → no MoneyLine pick` block. **This rubric previously still listed the
draw-risk block as a live hard gate — that was stale and has been corrected here.** The rationale
given at the time: the LLM arbiter reviewing the full 1000+-market catalogue is now the quality
gate, and fixtures with genuinely thin data are already excluded upstream (SRL/virtual filtering
at `selectFixtures`, league-scoring-gated `llmEligible` routing) — a fixture that reaches
`decide()` has real markets, and a deterministic heuristic silently downgrading it to `NO_EDGE` /
blocking its MoneyLine pick was doing the LLM's job worse than the LLM does it.

This does **not** mean draw-risk is ignored — P0-3 (`packages/engine/src/safety/index.ts`,
`MLSafetyFilter.evaluate` / `familyPenaltyMultiplier`) converted the old fixture-wide hard reject
into a **market-family stake downgrade** instead: in the default `safetyMode: "penalty"` posture,
`drawRisk.score >= 61` (VERY_HIGH) multiplies the stake on result-family markets only
(1X2/DNB/Double Chance) by 0.5, and `>= 81` (EXTREME) by 0.25 — every other market family on the
fixture is unaffected, and no fixture is ever killed outright by draw risk alone. (`safetyMode:
"legacy"` restores the old fixture-wide hard block byte-for-byte, as a rollback lever — not the
default.) `buildPrompt()`'s "MoneyLine picks forbidden when drawRisk=VERY_HIGH" decision-rule
text is *soft LLM guidance* the draft cascade is asked to honor, not a `validateSelection()` hard
gate — if the LLM ignores it, nothing in code stops the pick; only the stake-downgrade above still
applies.

## LLM decision criteria (soft)

### Accept a bet when

- `convergenceScore.tier` is `STRONG` or `MODERATE`
- `mlFilter.mlAllowed === true`
- `hoursToKO > 1` (pre-match window)
- `evMarkets` has ≥ 1 market clearing its class's EV gate — per-class thresholds
  live in `marketsV3/evGate.ts:61-69` (`CLASS_GATE`: S ev%≥0.04, M edge-only,
  L ev%≥0.15, X ev%≥0.20 & odds≤15), not a single blanket number. See
  `.claude/skills/oracle-engine/SKILL.md` §4 for the full table plus the v4
  heightened variant.

### Lean NO_BET when

- `mesScore < 0.80` (market efficiency below threshold)
- `sharpCompressionTag === true` (sharp money compressing lines)
- `lineupUnconfirmed === true` and `hoursToKO < 6`
- `portfolioCorrelation > 0.6` and no clear best leg
- Key injury flag present on the recommended side — escalate from MODERATE → NO_BET, not DC
- Fixture is a cross-confederation friendly with no shared opposition baseline (form not comparable)

### Provisional signals (shadow-tracked, not a hard trigger)

Rules added from a single post-mortem match get logged here first, not promoted straight
to "Lean NO_BET" — `tools/skillopt.py`'s own auto-proposed edits already require
`MIN_SAMPLE_SIZE = 10` scored disagreements plus a held-out-RPS improvement before applying
(see `propose_edit`); a rule a human adds manually from one match deserves the same bar, not
a lower one just because a person typed it instead of the script.

- **Title-race / promotion-playoff context** (audit fix, EV-strategy-audit #6): originally
  added 2026-06-04 as a hard "Lean NO_BET when" trigger from a single match (Raja 0-1
  Berkane, see SkillOpt history below) — an n=1 sample, added before `skillopt.py`'s
  `MIN_SAMPLE_SIZE` gate existed. Demoted here: when both teams have live title/promotion/
  survival stakes, note it as a mild negative factor on confidence (home-advantage signal
  may be less reliable than usual) rather than an automatic NO_BET lean. Promote back to a
  hard trigger only once it clears the same n≥10 + held-out-RPS-improvement bar every other
  rubric rule now has to clear.

### Adversary objection framework

The adversary should argue the strongest case AGAINST the proposed bet:

1. Is the edge likely from model error or genuine information asymmetry?
2. Is the line moving against us (steam vs. value)?
3. Would a 10% shift in λH/λA flip the recommendation?

### Confidence calibration

- `confidence > 0.75`: Strong signal — primary pick
- `0.5 < confidence ≤ 0.75`: Moderate — primary pick with reduced stake
- `confidence ≤ 0.5`: Weak — NO_BET or alt pick only

## Ranking mode guidance

- `CONFIDENCE_WEIGHTED` (default): balances edge × probability — use for standard fixtures
- `MAX_PROBABILITY`: use when bankroll is small and variance matters
- `MAX_EV`: use for high-edge scouts when drawdown risk is low

## SkillOpt history

### 2026-06-04 — Post-mortem update (manual, June 3 slate)

Session hit rate: 5/11 confirmed picks = 45%. Three systematic failures identified:

**Rule added — Cross-confederation form is not comparable.**
Gibraltar (12 losses vs European nations) vs BVI (4 wins vs Caribbean minnows) were treated as
equivalent form signals. They are not. Before using recent form as a probability input, confirm
the opposition quality tier is comparable. If tiers differ by ≥ 2 FIFA confederation levels,
suppress the form signal and fall back to ranking + home advantage only.

**Rule added — Title-race / playoff context suppresses home advantage.**
In matches where both teams are actively chasing title, promotion, or survival, home win
probability reverts toward 50% regardless of table position. Apply a home-advantage discount
of ~10 percentage points when both sides have live stakes. Raja (1st) lost 0-1 at home to
Berkane (2nd) in a title-race match — market's 50% implied was correct; our 60%+ read was not.

**Correction (EV-strategy-audit #6, 2026-07-08):** this was a hard "Lean NO_BET" trigger from
one match — never actually held to the n≥10 validation bar `skillopt.py`'s own auto-proposed
edits require. Demoted to a provisional/shadow-tracked signal (see "Provisional signals"
above) until it's validated on more samples the same way every other rule now has to be.

**Rule added — Key injury list → escalate to NO_BET.**
When the recommended side has 2+ confirmed absences (injury or suspension), the pick must
downgrade one full tier. MODERATE → NO_BET. HIGH → MODERATE (reduced stake only). Wydad's
absences (Bakasu, Sabbar, Guilherme) were flagged in the analysis but the DC pick was still
placed — it lost 2-1 in stoppage time.

**Validated — Low-EV friendly win markets correctly skipped.**
Netherlands at 1.29 for a friendly: NO BET call. Algeria won 1-0. Backing at 1.29 would
have lost. Rotation-risk + near-zero EV = correct pass. Reinforces the class EV
gate (see Hard/soft gates above — this was a Class S candidate, below the 0.04
EV% floor).

**Validated — Table position + H2H in mid-table leagues reliable.**
Skellefteå (3rd, H2H 5-1) won 3-1 at Storfors (6th). KSZO (home playoff, strong form) won
2-1 vs Luzino. Both held. Table/H2H signal in same-division fixtures with no external
motivation distortion remains the most reliable manual signal available.
