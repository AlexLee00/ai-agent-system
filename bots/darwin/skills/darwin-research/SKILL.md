---
name: darwin-research
description: Darwin research cycle operations: cycle overview, predicate authoring, adopt review, and recurring gotchas.
triggers:
  - darwin cycle
  - success predicate
  - adopt review
---

# Darwin Research

Use this skill when operating the remodeled Darwin loop. Route to the shortest command doc that matches the task.

| Need | Command doc |
| --- | --- |
| Explain or inspect the current cycle | `commands/cycle-overview.md` |
| Write or repair `successPredicate` | `commands/predicate-authoring.md` |
| Review measured proposals for adopt | `commands/adopt-review.md` |
| Avoid known Darwin mistakes | `commands/gotchas.md` |

## Guardrails

- Work inside Darwin lab worktrees, never by switching the OPS root branch.
- Predicate assertions are the VERIFY source of truth.
- Adopt creates PR specs first; main merge remains master-owned.
- PROTECTED paths and launchd/plist changes are blocked from Darwin adopt.
- D5 V2 Elixir shadow/evaluator is frozen unless `DARWIN_V2_SHADOW_ENABLED=true`.
