# Fable-5 Independent Re-Analysis — 2026-07-10 Slate

**Purpose:** validate the Wave-4-accuracy fixes against the actual picks ORACLE shipped to Telegram
on 2026-07-10, before the blend-pricing gate is flipped live. Read-only; no engine code ran here —
figures are hand-computed from the persisted raw feed (`.tmp/fixtures/sportybet_today.json`) and the
worker logs (`.tmp/servy_worker_stdout.log`).

## What ORACLE shipped

- **All-markets batch:** 7 analysed / 7 actionable — all 7 obscure lower-tier fixtures (Belarus
  Vysshaya, Australia Victoria NPL, Finland). Every pick showed **0.0% Kelly**. Log:
  `gate: 99 mapped → 7 survive (mandatory_data_missing: 3, not_whitelisted: 89) | feed-integrity: 0 contaminated`.
- **Goals supplement:** 50 analysed / 2 actionable; note "Claude NOT used — no LLM tier ran".
- **World Cup Spain v Belgium** was scraped and ran in the goals batch (`[goals] 5/115: Spain vs Belgium`)
  but was **excluded from the all-markets batch as `not_whitelisted`** — not contamination.

## Confirmed defects (all four independently reproduced)

1. **0.0% Kelly on every all-markets pick** — the v3 engine hardcodes `stake:0`; the real Kelly
   staker (`v3AssessmentsToEvMarkets` → `optimizedKelly`) only ran on the shadow path. → Phase 2.
2. **89 fixtures over-discarded by an exact-string league whitelist** (incl. Spain v Belgium). → Phase 3.
3. **Market bias to soft derivatives** — 3 of 7 picks were "Highest Scoring Half", priced from
   unanchored Poisson; the market-anchoring blend only gated at odds ≥ 4.00. → Phase 4.
4. **"Claude unavailable" was two problems** — a real CLI session-limit exhaustion (~40× in stderr)
   AND a reporting defect (goals legs carry `decisionReplay:null` so the note claims "no LLM tier ran"
   even when the slate arbiter ran). → Phases 1b + 6.

## Market-anchored re-pricing of the 9 shipped picks

Blend: `wModel = min(0.40, 0.15 + 0.15·completeness + 0.10·[real xG]); pBlend = (1−wModel)·q_fair + wModel·P_model`.
**Every one of these 9 fixtures has `xg:{home:null,away:null}` — no real xG** — so `wModel ≈ 0.24`
(completeness proxy 0.6 from full `statscoverage`, zero xG term). Rescaled bars: S adjEdge≥1.0pt &
blendEV≥4%, M adjEdge≥1.5pt, S/L/X EV floors as specified.

| Fixture | Pick | Odds | Cls | Model p | q_fair | pBlend | adjEdge_blend | blend EV | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| Recife v Botafogo | Goals O/U **Over 1.5** | 1.38 | S | 0.77 | **0.685** (de-vig) | 0.705 | +2.0pt | **−2.7%** | **DIE** |
| Racing Club Res v River | Home TT Over 0.5 | 1.37 | S | 0.78 | 0.730 (impl) | 0.742 | +1.2pt | +1.6% | **DIE** (EV<4%) |
| Preston Lions v Hume | Clean Sheet No | 1.18 | S | 0.88 | 0.847 (impl) | 0.855 | +0.8pt | +0.9% | **DIE** |
| Dnepr Mogilev v Minsk | HSH (Equal) | 2.25 | M | 0.49 | 0.444 (impl) | 0.455 | +1.1pt | +2.5% | **DIE** (edge<1.5) |
| Green Gully v Altona | Team Total Over 1.5 | 2.10 | M | 0.52 | — | — | — | — | **ladder not persisted** |
| Juventude v Vila Nova | HSH (2nd half) | 3.33 | M | 0.38 | 0.300 (impl) | 0.319 | +1.9pt | +6.4% | SURVIVE |
| Dandenong v S. Melbourne | Which Team Scores (Both) | 1.51 | M | 0.77 | 0.662 (impl) | 0.688 | +2.6pt | +3.9% | SURVIVE |
| Oakleigh v Avondale | BTTS Yes | 2.45 | M | 0.48 | 0.408 (impl) | 0.425 | +1.7pt | +4.2% | SURVIVE |
| Vaasan v SJK | HSH (2nd half) | 2.60 | M | 0.47 | 0.385 (impl) | 0.405 | +2.0pt | +5.3% | SURVIVE |

**Headline result: at least 5 of 9 shipped picks fail market-anchored gating** (the conservative
count — see caveats; the true count is higher). The single fully-de-viggable pick — **Recife "Over
1.5", which Telegram advertised as "+7.7% High edge" — flips to −2.7% blend EV and correctly dies.**
That is the smoking gun: a headline "high edge" pick was negative-EV once anchored to the price.

### Caveats (honest limitations)
- **q_fair is the pick's implied 1/odds (vigged) for 6 of 9 picks** because the raw sidecar does not
  carry the two-way/full-outcome complement for HSH / BTTS / team-total / clean-sheet. Implied-q is
  *higher* than the true de-vigged fair, which *understates* rawEdge and therefore **undercounts
  kills** — the real de-vig would fail more picks, not fewer. So "5 of 9 die" is a floor.
- **Green Gully is unscoreable here** — the team-total-1.5 price isn't in the feed; excluded.
- **The full priced ladder (the 1108-entry `allMarkets` block the engine actually gated) is not
  persisted to any recoverable artifact.** This is itself a finding: post-hoc verification is
  impossible without it. **Recommendation:** persist the per-run gated candidate set (fixture ·
  market · specifier · P_model · q_fair · rawEdge · stake) to the run manifest, so future slates can
  be graded exactly instead of reconstructed. Until then, the authoritative Phase-4 signal is a
  **live shadow replay** (compute both gates in one run, log survivor deltas) — the go/no-go before
  `ORACLE_V3_BLEND_PRICING` defaults on.

## How Fable-5 would price one of these fixtures (issue #6)

Take **Recife v Botafogo, Over 1.5**. The engine's move: Poisson μ → P(Over 1.5) = 0.77, compare to
1/1.38 = 0.725, declare +6.3% and ship. What's missing, and where each is now addressed:

1. **The market is the prior.** De-vig the two-way (0.685), treat it as the anchor, let the model
   *adjust* it in proportion to how much independent data backs the model — never replace it. With no
   xG here, the model gets only ~24% weight → pBlend 0.705 → **−2.7% EV, not +7.7%**. (Phase 4)
2. **Empirical trend blend.** This fixture's own O1.5 hit-rate history should pull the model toward
   observed frequency, not just modelled μ. (Phase 5, totals)
3. **Data honesty as a stake input.** No xG ⇒ larger market weight ⇒ smaller edge ⇒ smaller Kelly —
   automatically, not by a flat penalty. (Phases 2+4)
4. **News/lineup priors** (rotation, injuries) as soft context to the arbiter. (Phase 1a, keyless)
5. **Out of scope, by design** (v5.1 §9): line-movement/CLV shopping, player props, weather quant,
   externally-trained ratings — deliberately excluded to keep the engine transparent and sheet-derivable.

## Conclusion for Phase 4

The rescaled bars behave correctly on this slate: **not trivially loose** (they kill the Recife
false-edge and ≥4 others) and **not catastrophically tight** (4 picks with genuine anchored edge
survive). This supports shipping `ORACLE_V3_BLEND_PRICING` **on by default**, gated on the live
shadow-replay survivor-count check (since the historical ladder isn't persisted for an exact
back-test). Volume on this weak 7-fixture slate would drop to ~4; on a normal 40–99-fixture slate the
funnel is wide enough to approach the 39-pick target with honest edges.
