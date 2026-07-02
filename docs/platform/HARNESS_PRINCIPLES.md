# Harness Principles

Team Jay automation uses a three-role harness contract for self-improving loops.

## P/G/E Roles

- **Planner (P)**: proposes a bounded plan, scope, and acceptance criteria.
- **Generator (G)**: implements or produces the candidate output inside the approved scope.
- **Evaluator (E)**: independently checks correctness, safety, regressions, and operational boundaries.

The evaluator is permanent. A loop is not autonomous just because the generator can produce code or reports; it is autonomous only when evaluator evidence can stop, defer, or roll back the next action.

## Operating Rules

- Gen2 autonomy is bounded by default: shadow or advisory first, promotion gate later.
- Protected operations stay outside autonomous loops unless the master explicitly approves the current step.
- Every loop must expose its mode, mutation boundary, and failure result in machine-readable output.
- Semiannual simplification review removes obsolete gates, duplicate reports, stale launchd jobs, and unused skills.

## Pipeline Mapping

| Pipeline | Planner | Generator | Evaluator |
| --- | --- | --- | --- |
| Codex spec loop | Meti SPEC in `~/project-docs/ai-agent-system/codex-specs` | Codex implementation | Meti/code-review/verification smoke |
| Write report | `bots/orchestrator/lib/write/report-aggregator.ts` | `bots/orchestrator/src/write.ts` report writer | Hub selector fallback + runtime smoke |
| Claude refactor-cycle | `bots/claude/scripts/refactor-cycle-runner.ts` planner phase | refactor candidate builder/fixer | strict gate, reviewer gate, mutation isolation tests |

## Semiannual Review Template

- Review date:
- Pipelines checked:
- Gates removed:
- Gates retained with evidence:
- Duplicate jobs or reports retired:
- New evaluator coverage required:

