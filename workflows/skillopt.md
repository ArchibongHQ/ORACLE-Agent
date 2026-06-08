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

### 3. Apply the edit (atomic keep-or-revert)

```bash
python tools/skillopt.py
```

The script uses git stash as a checkpoint before writing the edit:

1. **Stash** — current rubric is staged and stashed (`git stash push`)
2. **Apply** — proposed edit is appended to `workflows/oracle_decision_rubric.md`
3. **Re-score** — held-out RPS is re-computed on the same recent-20 window
4. **Keep or revert**:
   - If RPS delta ≥ 0.002 → drop the stash, accept the edit
   - If RPS delta < 0.002 → `git stash pop` (rubric restored to baseline)
5. **Log** — attempt is recorded to `.tmp/oracle_skillopt_log.json` with status `ACCEPTED` or `REJECTED`

No manual revert step needed — the script handles it atomically.

### 4. Commit the rubric update

Only commit `workflows/oracle_decision_rubric.md` if the script reported `ACCEPTED`. Do not commit `.tmp/` files (gitignored).

```bash
git add workflows/oracle_decision_rubric.md
git commit -m "chore(skillopt): accept rubric edit — RPS delta +X.XXX"
```

## Edge cases

- **Too few samples** (`< 10`): Script exits without proposing an edit
- **No resolution data**: Script exits — run `resolveYesterdayFixtures` first
- **Dry run**: `--dry-run` prints the proposal without touching the rubric or running git
- **Custom store dir**: `--store-dir .tmp/custom-store`
- **Git not available / dirty index**: stash fails silently; edit is still written but without atomic revert protection — check the warning in output
- **< 5 resolved records**: held-out RPS cannot be computed; edit is written without RPS gate (stash is dropped)

## GPU-gated autonomous mode

By default, SkillOpt runs in **propose-only** mode — a human reviews and runs the script manually.

To enable fully autonomous overnight loops (analogous to Karpathy's autoresearch pattern), two conditions must both be true:

1. Set `ORACLE_AUTORESEARCH_ENABLED=true` in `.env`
2. The runtime must detect an NVIDIA GPU (`nvidia-smi` returns a device) **or** a VPS (`ORACLE_IS_VPS=true` or `systemd-detect-virt` returns non-`none`)

When both are satisfied, `config.enableAutoResearch` is `true` in `OracleConfig`. A cron worker can then call `skillopt.py` unattended — the atomic revert ensures bad edits don't persist.

On a local Windows dev machine without a GPU, `enableAutoResearch` stays `false` — autonomous mode never fires.

## Training signal architecture

```text
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
    → stashes baseline rubric (git stash)
    → proposes + applies bounded rubric edit
    → re-scores held-out RPS
    → keeps (drop stash) or reverts (pop stash)
    → logs result to .tmp/oracle_skillopt_log.json
```
