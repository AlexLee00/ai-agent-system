# orchestrator-skill

## Purpose
Orchestrator maps tickets to teams, agents, workspace plans, runner plans, and quality gates.

## Flow
1. Normalize ticket source from Hub, GitHub, Telegram, Notion, or docs.
2. Dispatch to target team and owner agent.
3. Build isolated workspace and runner plan.
4. Require Reviewer, Guardian, Builder, and test-runner validation.
5. Report status without bypassing approval gates.

## Outputs
- Dispatch plan.
- Assignment plan.
- Validation chain and status update payload.

## Safety
Default mode is plan-only. Mutating Hub status is allowed only when explicitly requested; git worktree creation and protected process actions require separate approval.
