# SOP: Punting Analysis — Market-Anchored Convergence Route

## Purpose

Produce calibrated, honest bet market selections for a given set of fixtures using ORACLE's
WAT framework. This workflow is the manual-route fallback when the live engine pipeline
(odds API + LLM credits) is unavailable. It applies the same decision logic as
`packages/engine/src/decision/index.ts` but executed by Claude rather than code.

## When to use

- Live odds API quota or Anthropic credits are exhausted (check `.env` / worker logs first)
- User provides a fixture list for same-day or next-day analysis
- Quick pre-match scan before `runBatch()` is unblocked

## Inputs required

- Fixture list: Home vs Away, KO time (UTC), league/competition, venue
- Odds (1X2 at minimum) — required to anchor the convergence check
- Competition level / team level flag (Senior / U23 / Women / Youth) — **mandatory for
  internationals; never assume senior men without an explicit marker**

---

## Execution phases

### Phase 0 — Framework load

- Check `tools/` and `packages/engine/src/` for an executable pipeline path
- If `scrape_live_odds.py` + LLM credits are available: run the real pipeline
  (`scrape → runBatch → decide`) and label output **ENGINE OUTPUT**
- Otherwise: proceed with this manual workflow and label output **REASONED READ**

### Phase 1 — Fixture triage

For each fixture, assess data availability before spending search budget:

| Signal | Threshold | Action |
|---|---|---|
| Tier-1 league (ORACLE 16 leagues) | Always proceed | Full Phase 2 |
| Regional / lower division | Check if odds exist | If no odds → NO BET |
| Reserve / U23 / Youth | Proceed with LOW confidence cap | Flag volatility |
| Cross-confederation friendly | **Check competition level first** | See note below |
| Below information floor (Kolmonen, Kärntner Liga, etc.) | No public market | NO BET |

**International level check:** If the fixture is an international and the list does not
explicitly state Senior / U23 / Women, state the assumed level and proceed — user will
redirect if wrong. Never silently analyze the senior men's fixture when a different level
was intended.

**Dead-rubber check:** If the home team has already won the title / secured promotion and
the match has no table consequence, suppress the home-win signal and avoid the result market.

### Phase 2 — Real-time data collection

Search and cite for each fixture. Minimum required:

- Table: position, points, goal difference, games played
- Form: last 5–6 results with scores, noting HOME vs AWAY split separately
- Goals: scored/conceded per game; Over/BTTS rate
- H2H: record, avg goals, last meeting result and venue
- Context: injuries, suspensions, lineup news, motivation, travel
- **Market odds anchor:** pull current 1X2 prices. If none exist → NO BET

**Cross-confederation form warning:** When comparing teams from different confederation
tiers (e.g. UEFA vs CONCACAF minnows), do not use raw form as equivalent signals.
Fall back to FIFA ranking + home advantage only. See rubric rule added 2026-06-04.

### Phase 3 — Independent probability estimate

Build a directional read from goal rates (Poisson-style on scored/conceded is sufficient).
Express as a **range**, never a fake exact percentage:

- e.g. "Home win true prob: 55–62%"
- Note venue effects and small-sample volatility
- Apply home advantage discount (~10pp) when both sides have live stakes in a
  title race, promotion playoff, or relegation battle

### Phase 4 — Convergence check and gates

Recommend only when the independent estimate and the market line agree on direction.
If they disagree that is a NO BET, not a contrarian punt.

Apply gates in order:

1. **Injury gate:** 2+ key absences on recommended side → downgrade one tier
   (MODERATE → NO BET; HIGH → MODERATE, reduced stake)
2. **Draw risk gate:** `drawRisk >= VERY_HIGH` → no MoneyLine; use Double Chance
3. **Lineup gate:** Unconfirmed lineup within 6h of KO → NO BET
4. **EV gate:** Market-implied prob within 3pp of model estimate → no edge, NO BET
5. **Correlation gate:** Do not combine correlated legs (e.g. home win + home team
   to score) without explicit EV justification

Adversary check — state the single strongest case AGAINST each pick before confirming it.

### Phase 5 — Output

For each recommended market:

```
Market label
Odds | Confidence: HIGH / MODERATE / LOW | ~prob range
One-line rationale anchored in model–market convergence
Adversary: [strongest counter-argument]
```

If nothing clears the gates → output `NO BET` plainly.
End with a `Sources:` section listing all URLs used as markdown links.

Label the response header: **ENGINE OUTPUT** or **REASONED READ**.

---

## Confidence tiers

| Tier | Model–market gap | Stake guidance |
|---|---|---|
| HIGH | True prob > implied by ≥ 8pp | Full unit |
| MODERATE | True prob > implied by 4–7pp | Half unit |
| LOW | True prob > implied by < 4pp | No bet or token only |

---

## Known failure modes (from post-mortem 2026-06-04)

| Failure | Pattern | Fix |
|---|---|---|
| Cross-confederation form comparison | Gibraltar vs BVI — form vs Europeans ≠ form vs Caribbean minnows | Use ranking + home advantage only; suppress cross-tier form |
| Title-race home advantage | Raja (1st) lost at home to Berkane (2nd) | Apply ~10pp home discount when both teams have live stakes |
| Injury list ignored | Wydad DC pick despite 3 key absences | 2+ absences → downgrade one full tier, no exceptions |
| Low-EV friendly win market | NED at 1.29 — lost 0-1 to Algeria | Skip win market when EV < 4% on any friendly |
| Reserve football overconfidence | Estudiantes Res. backed at MODERATE — lost | Reserve/U23 confidence cap is LOW; never exceed MODERATE |
| H2H decay in high-stakes end-of-season | Schwaz won both H2H 3-0 but lost 4-3 at home in final round | H2H from mid-season doesn't carry full weight in playoff/final-round context |

---

## Related files

- `workflows/oracle_decision_rubric.md` — hard gates and soft criteria
- `packages/engine/src/decision/index.ts` — real engine implementation
- `tools/scrape_live_odds.py` — live odds ingestion (requires quota)
- `tools/scrape_fixtures.py` — fixture scraping SOP
