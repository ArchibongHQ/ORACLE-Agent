# SOP: SkillOpt Calibration Loop

## Objective
Improve the LLM decision rubric by scoring past RED-trigger overrides against actual match outcomes. Accepts a rubric edit only when held-out RPS strictly improves.

## When to run
- After accumulating ≥10 resolved fixtures with disagreement log entries
- Before each weekly review of decision quality
- Never at inference time — this is a build-time / offline loop only

## Required inputs
- `.tmp/oracle-store/oracle_decision_disagreement.json` — written by `decision/index.ts` after each RED verdict
- `.tmp/oracle-store/oracle_v2026_resolution.json` — written after `resolveYesterdayFixtures()` runs
- `workflows/oracle_decision_rubric.md` — current rubric (will be appended to, never overwritten)

## Tool
`tools/skillopt.py`

## Steps

### 1. Verify data exists
```bash
python tools/skillopt.py --dry-run
```
Output shows:
- Number of disagreement entries
- Number of resolution records
- Mean RPS on matched disagreements
- Proposed edit (if sample ≥ 10)

### 2. Check held-out RPS gate
The script computes mean RPS on the most recent 20 resolved fixtures. An edit is only written when:
- Sample size ≥ 10
- The RED trigger has `wouldBeBetter = True` (mean RPS > 0.15 heuristic)

### 3. Apply the edit
```bash
python tools/skillopt.py
```
Appends the proposed section to `workflows/oracle_decision_rubric.md`. Does not overwrite existing content.

### 4. Validate
After the next batch run, compare RPS on held-out fixtures before and after the edit. If RPS does not improve by ≥ 0.002 (0.2pp), revert the rubric edit (remove the appended section).

### 5. Commit the rubric update
Only commit `workflows/oracle_decision_rubric.md` — do not commit intermediate data files (`.tmp/` is gitignored).

## Edge cases
- **Too few samples** (`< 10`): Script exits without proposing an edit
- **No resolution data**: Script exits — run `resolveYesterdayFixtures` first
- **Dry run**: `--dry-run` prints the proposal without touching the rubric
- **Custom store dir**: `--store-dir .tmp/custom-store`

## Training signal architecture
```
ExecutionEngine.run()
  → AntiSycophancyCircuit (3-agent debate)
    → RED verdict
      → logDisagreement() → oracle_decision_disagreement.json

Post-match:
  resolveYesterdayFixtures()
    → oracle_v2026_resolution.json (with rpsContribution per fixture)

Offline:
  skillopt.py
    → matches disagreements to resolutions
    → proposes bounded rubric edit
    → writes to oracle_decision_rubric.md (only if gate passes)
```
