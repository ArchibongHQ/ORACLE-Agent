# gstack Workflow Integration & Skill Routing

The full gstack skill suite (garrytan/gstack, MIT) is installed globally at `~/.claude/skills/gstack/`. Available in every Claude Code session across all projects.

| Stage | Command |
|---|---|
| New feature scoping | `/gstack-office-hours` |
| Architecture decisions | `/gstack-plan-eng-review` |
| Debugging failures | `/gstack-investigate` |
| Pre-PR review (>50 lines) | `/gstack-review` |
| Pre-release security | `/gstack-cso` |
| Shipping a PR | `/gstack-ship` |
| Weekly sprint review | `/gstack-retro` |
| Docs sync post-ship | `/gstack-document-release` |
| Update gstack | `bash ~/.claude/skills/gstack/register-skills.sh` (after git pull in gstack dir) |

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
- Prediction math / engine internals (`packages/engine/src/{math,goalsV3,marketsV3,safety,calibration,ratings,rag,swarm,gbm}/**`) → invoke `oracle-engine` skill first
