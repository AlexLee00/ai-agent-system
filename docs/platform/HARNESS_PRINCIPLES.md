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

## Challenge/Consensus Gate

Non-trivial implementation starts only after developer, domain, SRE/data, and test-harness views have challenged the proposed change. The accepted decision must identify rejected alternatives, mutation boundaries, and rollback conditions. Parallel agents provide evidence; they do not independently patch overlapping source files.

## Verification Contract

- Test-first is required for a reproduced defect: RED for the observed failure, then GREEN for the narrow fix.
- Soft tests cover syntax, types, focused unit tests, and isolated smoke checks.
- A read-only hard test may use live reads and dry-run process boundaries, but must not trade, publish, reload protected launchd services, or mutate production DB state without explicit approval.
- DB health uses a stale-row delta from a recorded baseline. Historical rows are reported separately and are never force-cleared to manufacture a passing result.
- Runtime configuration drift compares tracked source with installed scheduler/config values before any operational apply.
- Code review and Karpathy self-check are permanent evaluator gates after the final edit.

## Pipeline Mapping

| Pipeline | Planner | Generator | Evaluator |
| --- | --- | --- | --- |
| Codex spec loop | Meti SPEC in `~/project-docs/ai-agent-system/codex-specs` | Codex implementation | Meti/code-review/verification smoke |
| Write report | `bots/orchestrator/lib/write/report-aggregator.ts` | `bots/orchestrator/src/write.ts` report writer | Hub selector fallback + runtime smoke |
| Claude refactor-cycle | `bots/claude/scripts/refactor-cycle-runner.ts` planner phase | refactor candidate builder/fixer | strict gate, reviewer gate, mutation isolation tests |
| Governed implementation | expert challenge and bounded acceptance criteria | one scoped Codex implementation owner | RED/GREEN, soft test, read-only hard test, DB delta, runtime drift, code review |

## Capability Boundary

The governed implementation loop is a tracked skill plus repository harness. It is not an MCP because no new remote typed capability is required, and it is not a plugin because there is no multi-capability distribution boundary yet. Promote it to MCP or plugin only when a stable external API or reusable bundle exists.

## Semiannual Review Template

- Review date:
- Pipelines checked:
- Gates removed:
- Gates retained with evidence:
- Duplicate jobs or reports retired:
- New evaluator coverage required:
