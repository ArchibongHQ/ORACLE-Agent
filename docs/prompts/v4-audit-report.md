# ORACLE Predictions and Algo Audit Report

> Source: pasted audit transcript that led to the goals-market-analysis-prompt-v4 and
> all-markets-analysis-prompt-v4 syntheses. Preserved verbatim as the provenance record for the
> HFA root-cause finding. See [`workflows/markets_v3.md`](../../workflows/markets_v3.md) for how
> this maps onto the deterministic engine.

I dug through all five prompt versions and cross-checked them against the actual selection data from the run. There's a real, findable root cause for the Under-skew — and it's not random variance.

## The headline finding: no home-advantage term

None of the five prompts include a home-field adjustment in the λ formula. The engine takes `SeasonGF_H` / `SeasonGA_H` at face value as if they were already venue-specific, but the column naming convention across the whole sheet (`Form_H`, `Pos_H`, `Pts_H`, `Streak_H`...) indicates these are just "the team designated Home's overall season stats" — not "this team's stats when playing at home." Real bookmakers price in a home boost (historically ~+0.2–0.4 goals for the home side); a model that omits it will systematically produce a lower μ than the market's implied total, in every single fixture, in the same direction, all day long.

That's exactly the fingerprint in the numbers:

- Of all candidate selections with raw edge > 5 pts, 29 were Under, 6 were Over — an 83/17 split.
- Every one of the 15 selections killed by the implausible-edge cap was an Under.
- The clearest smoking gun: Vikingur Reykjavík — home side scoring 2.46/g, conceding 0.46/g, priced at 1.16 to win and 1.25 for Over 2.5 (bookmaker essentially certain of a blowout). The model's λ (via the ungated simple-average fallback, since Besta deild had no league baseline) came out to μ=2.34 — a modest total — manufacturing a fake +34-point Under edge on a match the market considers a near-certain goal-fest. The cap correctly nuked it, but the fact the model was that wrong on direction, not just magnitude, is the tell. A dominant team's own scoring rate got diluted by averaging it against a mediocre opponent's defense, instead of being trusted on its own merits.

The cap firing on 15 of 35 real signals (43%) isn't the system working as designed ("genuine edge >12 pts is rare") — it's the system catching a systematic miscalibration, not rare tail noise. A gate that fires that often on one slate is telling you the upstream model is biased, not that today happened to have a lot of mismatches.

## Contributing factors (secondary)

- **Version chaos.** The two files named "FINAL" and "FINAL_2" are actually the older, mathematically flawed drafts — they still use the normal-approximation + θ=2 negative-binomial method that the "v2"/"v3"/"original" docs explicitly call out as inflating probabilities and manufacturing phantom edges. Anyone picking "FINAL" by name would silently regress to the broken engine. There's no version header, changelog, or deprecation marker anywhere.
- `goals-market-analysis-prompt-v2.md` is missing the BTTS match-shape correction present in `original_v2` and `v3` — a regression that would let lopsided-favorite BTTS bets slip back through.
- FINAL/FINAL_2 hardcode a fictional data-source stack (Flashscore via Apify, Understat, Sportmonks, Opta, StadiumDB) that isn't connected in any actual deployment — a real hallucination risk against Rule 0's own "don't describe API calls you didn't make."
- FINAL/FINAL_2 still instruct the model to "use the current user's IP address" for the clock — something the other three versions explicitly (and correctly) forbid as impossible.
- v3's youth/friendly exception is wired incorrectly — it declares a "100% completeness + aligned signals" carve-out in §1.2 but nothing in Phase 5's discard gate actually enforces it, so the exception is decorative, not functional.
- League baselines (L) are static and undated, with no mandated refresh — Botola's 2.30 could be stale, and a low L mechanically compounds the missing-home-advantage bias by pulling every shrunk λ down further.
- Completeness scoring is fixture-level, keyed mostly off O2.5 odds, not selection-level — a 1.5-line or 3.5-line pick (where most of today's "edge" actually lived) isn't separately vetted.
- No calibration/backtest step exists anywhere — nothing checks whether the model's historical hit-rate matches its stated probabilities, and nothing flags "hey, 83% of your signals point one direction, sanity-check before you output."

I've folded all of this into a single synthesized v4 prompt — corrected engine, home-advantage term, fixed BTTS correction everywhere, real tool posture (no fictional APIs), a directional sanity-check gate, selection-level completeness, and a version header so this doesn't happen again.

## Quick recap of what changed and why it matters for next time you run a slate

- **Home-advantage term added (§3.1a)** — this was the actual bug behind the all-Unders result, not bad luck. Without it, a dominant home side's true scoring rate gets diluted toward league-average, μ comes out too low, and the model disagrees with the market in the same direction every time.
- **Directional sanity-check gate (§4.5)** — if 70%+ of the day's signals point one way, or the cap fires on more than a quarter of them, the prompt now forces an explicit "something may be miscalibrated" flag in the output instead of quietly shipping a lopsided shortlist.
- **BTTS match-shape correction is mandatory everywhere** — one of the source files had silently dropped it.
- **Honest tool posture** — stripped the fictional always-on Understat/Flashscore/Sportmonks stack that two of the files hardcoded; it'll only claim to have used a source it actually queried this session.
- **Per-selection completeness** instead of per-fixture, so a 1.5-line pick isn't riding on the 2.5-line's data completeness.
- **Fixed the impossible "read the user's IP for the clock" instruction** that was still live in two of the five files.

One thing worth flagging honestly: the "no venue-split data" diagnosis was inferred from the column-naming pattern in the Oracle export (`_H`/`_A` suffixes look like "home-designated team" not "home-venue performance"), not from a confirmed data dictionary. It's a strong, well-supported hypothesis given the evidence (83/17 directional split, every capped selection being an Under, the Vikingur case), but worth a quick check against the data provider's actual field definitions before treating it as settled.

## All-markets sibling audit

Checking this against the same lens as the goals-prompt postmortem — this is clearly the "all markets" sibling of that lineage, and it was worth checking whether the root-cause bug carried over.

### What's actually well-built there

The dual-split rule (§3.2) is the standout addition. Using the model's own stats-driven split for result markets (DC, DNB, handicaps) but an odds-anchored split for goals-shape markets (BTTS, team totals) is the correct fix for a problem the goals-only prompts never even noticed: if you anchor a result market's probability to the market's own 1X2 price and then bet DNB off that, your edge is ≈0 by construction — you're just re-quoting the bookmaker. This document catches that. It's good, careful thinking.

The tiered EV gate by market class (S/M/L/X, §5.2) is also a real improvement over the flat 5-point bar in the goals prompts. A flat bar structurally locks out short-priced insurance markets (odds ~1.40, where a 3-point edge is a big deal) while letting longshots sneak through on raw points alone. Tiering by class fixes that.

Correct handling of push markets (whole-ball lines, DNB, AH 0.0) via conditional probability p′ = p_win/(1−p_push) — the goals-only prompts never had to deal with pushes at all (all their lines were half-lines), so this is new, and it's mathematically the right approach.

Exotics get meaningfully tighter treatment (−5 class penalty, 30% relative cap vs. 40%, odds ceiling ≤15.0) — appropriate paranoia for Correct Score / HT-FT, where model error compounds fastest.

### The bug that carried over — and it's worse here

Section 3.1's λ formula is byte-for-byte the same as the goals-only prompt's, home-advantage term and all — meaning: still none.

```
λ_home = (Home_scored/90 ÷ L) × (Away_conceded/90 ÷ L) × L
λ_away = (Away_scored/90 ÷ L) × (Home_conceded/90 ÷ L) × L
```

In the goals-only version, this only distorted Over/Under and BTTS. Here, because of §3.2's dual-split rule, this same uncorrected λ also becomes the direct input to every result-class market — DNB, Double Chance, handicaps, winning margin — which the document itself names as the "flagship" low-variance mandate. A quick illustrative check with plausible mid-table numbers (home side 1.5 scored/1.0 conceded, away 1.2/1.3, league L=1.35):

- Without a home-advantage term: DNB-Home comes out to 68.4% model probability, a modest +5.9 pt raw edge against a 1.53/2.55 market.
- With a standard 1.10 HFA multiplier: DNB-Home rises to 74.6%, a +12.1 pt raw edge — more than double, and now bumping right against the 12-point "too hot" cap.

That's not a rounding difference — it's the gap between a pick that limps over the Class-S bar and one that would either look like the model's best idea on the slate or get auto-discarded as implausible, depending on which side of the missing term you're on. Since the "standing priority" mandate explicitly favors DNB-on-favourite and DC-1X as the flagship low-variance plays, this is exactly the market family where the bug does the most damage — it will systematically underrate home favourites across the whole result-market universe, not just misjudge one goals total.

Worth being precise about direction here: unlike the goals-only run (which came out skewed Under), this bug in the all-markets context would skew the model against home sides generally — fewer DNB-Home/DC-1X picks clearing the gate than should, and correspondingly inflated confidence on away-side and draw-adjacent result markets. Same root cause, different symptom because it's now feeding a different set of markets.

### Other gaps

- Not actually self-contained despite calling itself "v3, deployment." §3.3 says "full table as in v2" for league baselines — there's no league-baseline table in this document at all. If this file is handed to a fresh session without also attaching whatever "v2" it's referencing, the model has no L values to compute anything with. A file labeled for deployment shouldn't have an unstated external dependency.
- The friendlies/cup-final "heightened eligibility" clause (§1.2) is declared but not wired in, same defect flagged in the goals-only v3: it shouts "HEIGHTENED ELIGIBILITY FILTER, ADJUSTED EDGE, CONFIDENCE & PREDICTABILITY SCORE APPLY" twice but no phase downstream actually defines a different numeric bar for these fixtures. It's a placeholder, not a rule.
- No directional/cap-rate sanity-check gate — exactly the safety net added to the goals v4 (flag if signals or caps skew heavily one way) is absent here, and given this document has a confirmed systematic bias source, it's the document that would benefit from it most. With this many market families in play, a systematic bias is much harder to eyeball-spot from a table than it was with a slate of nine goals picks.
- Version-numbering collision: this is "v3" and the goals-only lineage also has a "v3" — two unrelated documents, same label. Filenames disambiguate for now, but the in-document header doesn't cross-reference which lineage it forked from.
- Empirical blend (§3.5) underspecifies its own shrinkage. It says the 0.3-weight empirical hit-rate is "shrunk toward P_model if sample < 5" but never gives the formula (unlike §3.1's explicit n/8 shrink for λ). Also worth flagging conceptually: BTTS%/CS%/FTS% last-5 hit-rates are typically drawn from the same underlying match log as the season goals averages already feeding λ — blending two views of substantially the same data isn't real diversification, it can just double-count the same small-sample noise.
- Mini-ACCA construction doesn't hard-exclude Class X legs, only "prefers" S/M — leaves room for a flat 0.85 correlation haircut (designed for near-independent legs like two different-league O2.5s) to be applied to a Correct Score or HT/FT leg, where the real model-error variance is much higher than a flat 15% discount captures.
- League-default ρ=0.44 (half-engine) and the minute-share table (time-engine) are global hardcoded constants with no league variation and no "verify/cite if you have a current figure" caveat, unlike the league-baseline table's own disclaimer elsewhere.

The home-advantage gap is the one to fix before running anything live off this document — it's the same defect that produced the all-Unders result last time, now with a wider footprint across DNB/DC/handicap markets too.

## v4 synthesis summary (all-markets)

Mapped back to the audit:

- §3.1 now has the HFA term, applied once at the core λ stage so it propagates automatically into totals, results, half, and time markets without needing to patch each engine separately. The odds-anchored split (§3.2, used for BTTS/shape markets) deliberately does not get the multiplier — it's already calibrated to market prices, so applying HFA there would double-count.
- §3.4 now has the league-baseline table inline, plus an explicit fallback (2.60 default) for unlisted leagues, so the file no longer depends on an unattached "v2."
- §1.3 replaces the old shouty-but-unenforced friendlies/cup-final clause with actual numeric bars (§5.2's heightened table) and a hard restriction on which market families are even eligible — exotics are flatly excluded from that path.
- §5.6 is the new sanity-check gate, split into cap-rate, result-family skew, and totals-family skew — so a bias hiding inside a 39-row, multi-market list has a better chance of surfacing than it would from eyeballing a table.
- §3.6's empirical blend now has an explicit shrinkage formula, and a note that it's smoothing, not a second independent data source.
- Mini-ACCA hard-excludes Class L/X legs now, not just "prefers" S/M.
- Added the worked DNB example (+5.9 → +12.1 pts) so the HFA fix isn't just asserted — it's shown.

One thing worth being upfront about: the §5.6 skew thresholds (25%/70%) and the HFA default (1.10) are reasonable, literature-consistent starting points, not values calibrated against these specific leagues or bookmaker margins. If the result-family or totals-family checks fire constantly even after the fix on a real slate, that's a signal to tune those numbers per league cluster rather than assume the gate itself is broken.

## Final QA pass — defects found and fixed

The QA pass caught defects in the v4 syntheses themselves, not just the originals:

1. **Goals v4 — arithmetic error in the worked example.** The original synthesis stated P(Over 2.5 | μ=2.89) = 56.4%; the exact Poisson value is 55.1%, so raw edge is +5.1 (not +6.4) and adjusted is +2.1 (not +3.4). The DISCARD conclusion was unchanged, but a worked example is the calibration anchor readers check the model against — a wrong anchor in a document whose entire thesis is "unverified numbers manufacture phantom edges" would have been an embarrassing irony. Fixed.
2. **All-markets v4 — inherited de-vig error in the Class S worked example.** The 1H Under 1.5 example (carried verbatim from the original v3 file) quotes q = 66.6% for prices 1.36/3.05. The correct de-vig is 69.2%, making the raw edge +1.0 (not +3.7) and adjusted −1.0. Same conclusion (DISCARD), wrong arithmetic — and notably, this means the source v3 shipped with an unverified worked example too. Fixed the numbers and left a one-line note in the example itself flagging the correction, since anyone diffing against the old file would wonder.
3. **All-markets v4 — stale cross-references.** When the league-baseline table was inserted as §3.4, every downstream engine shifted by one (Result 3.4→3.5, Shape 3.5→3.6, Half 3.6→3.7, Time 3.7→3.8, Exotics 3.8→3.9, Corners/Cards 3.9→3.10) — but the §0.2 feed dictionary, the §1.3 market-family list, and one changelog line still pointed at the old numbers. In a prompt that routes markets to engines by those section numbers, that's a functional bug, not cosmetic. All references were re-swept against the actual section headers: zero unresolved.
4. **Goals v4 — unenforced penalty.** §0.1 demoted the O/U hit-rate from Mandatory to Critical with "penalty," but the §4.2 penalty table had no corresponding row — a repeat of the exact declared-but-unwired pattern criticized in the v3 friendlies clause. Added the −1 pt row.

### Verified clean

Every §-reference in both files resolves to a real section; the θ=2 method appears only as explicitly retired; the DNB HFA example (+5.9 → +12.1) and Class M example re-verify exactly; the two §5.2 gate tables are internally consistent with §1.3; and the goals/all-markets shared-engine sections (§3.1/3.1a vs §3.1) now say the same thing in both files, per the sync guardrail.

### On the audit reports themselves — one honest caveat to carry forward

The audits' core root-cause finding (missing home advantage) stands and is well-evidenced, but two things deserve a flag. First, the venue-split diagnosis remains an inference from column-naming patterns, not a confirmed data dictionary — both v4s now instruct the model to verify which case applies rather than assume, which is the right posture, but it should still be confirmed with the feed provider once. Second, the worked-example error in defect #2 above means the audits under-scoped slightly: they checked the originals' formulas and structure but not their example arithmetic. Lesson folded into practice here — every numeric example in both v4s has now been machine-verified, which is the standard worth holding any future version to before calling it done.
