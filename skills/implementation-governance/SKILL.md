---
name: implementation-governance
description: Use for non-trivial production code changes that require expert challenge and consensus, test-first implementation, soft and read-only hard verification, runtime and DB consistency checks, refactoring discipline, and an independent code-review gate.
triggers:
  - non-trivial production code or runtime behavior change
  - provider model timeout retry schedule limit auth DB or external I/O change
  - live shadow approval idempotency data-loss or protected-operation boundary
---

# Implementation Governance

## Mode Classification

- **T0 Lean**: copy, comments, formatting, non-operational docs or display-only small settings, and test descriptions with no runtime behavior change. Make the smallest edit and run only the directly relevant check.
- **T1 Governed**: non-trivial logic, cross-team contracts, provider/model/timeout/retry/schedule/limit policy, auth, DB reads or state classification, and external I/O behavior. Apply the governed loop even when the diff is one line.
- **T2 Protected**: an approval overlay for launchd mutation, live trade/payment/reservation/publishing, production DB write or migration, secret change, and commit/push. Keep the underlying T0/T1 process, then stop at the explicit approval boundary before mutation.

Classify by operational impact and reversibility, not file size or line count. When uncertain, use the higher mode. An explicit user request for deeper review overrides a lower automatic classification.

## Expert Challenge Contract

- Cover developer, domain, SRE/data, and test-harness perspectives; expertise is defined by viewpoints, not the number of agents.
- Compare no more than three viable alternatives. Each perspective records `objection / evidence / accepted-or-rejected reason` in one concise entry.
- Consensus means no unresolved objection about correctness, safety, data loss, or rollback. Preference differences do not block implementation.
- Keep **one implementation owner**. Experts inspect and challenge but do not patch overlapping source files in parallel.
- Record routine consensus in the task. Persist it in a handoff only for cross-team, protected, migration, or production-data work.

## Proportional Gates

- Evidence, a focused soft test, and independent review are required for T1 changes and T2 overlays on T1. A T2 approval layered on T0 does not promote the underlying change into the governed loop.
- RED is required for a reproduced defect or new behavior contract. For a behavior-preserving refactor, establish the existing test baseline instead.
- Refactor only duplication, hard-coded policy, or dead code proven relevant to the requested change.
- Run DB consistency checks only when data access, persistence, or state classification can change.
- Run runtime configuration drift checks only when scheduler, process, environment, or deployed configuration can change.
- Run a read-only hard test only when a meaningful safe process boundary exists. Mark an inapplicable gate `N/A` with a reason instead of manufacturing ceremony.

## Boundaries

- Preserve unrelated worktree changes and define the exact mutation scope before editing.
- Treat launchd reloads, live orders, production DB writes, migrations, secrets, and commits as separate approval gates.
- Prefer a repository helper or a small direct fix over a new MCP, plugin, adapter, or framework.
- Never weaken a live/shadow, approval, idempotency, or data-loss guard to make a test pass.

## Required Loop

1. **Evidence**: trace the runtime path function by function, invoke pure/read-only functions with controlled inputs, inspect scheduler configuration, and query DB state read-only.
2. **Challenge/Consensus Gate**: apply the expert challenge contract and reach one bounded implementation decision before editing.
3. **RED**: add the smallest regression test that reproduces the observed failure. Confirm that it fails for the intended reason.
4. **GREEN**: make the narrowest source change that satisfies the safety contract.
5. **REFACTOR**: remove only duplication, hard-coded policy, or dead code proven relevant to the change. Keep configuration in the existing SSOT.
6. **Soft test**: run syntax, type, unit, and focused smoke checks without external mutation.
7. **Read-only hard test**: when applicable, exercise the real process boundary with live reads or dry-run inputs. Compare expected and actual results and verify the DB stale-row delta did not increase when DB state is in scope.
8. **Runtime configuration drift**: when applicable, compare tracked scheduler/config sources with installed runtime values. Do not reload protected processes without explicit approval.
9. **Independent review**: run code-review and Karpathy self-checks. Resolve every actionable P1/P2 finding, then rerun affected tests.
10. **Handoff**: report evidence, commands, mutation status, remaining operational apply steps, and rollback instructions.

## Required Evidence

- Scope and assumptions.
- Expert objections and the accepted decision.
- RED failure and GREEN pass.
- Soft-test command/results.
- Hard-test or dry-run command/results, with `liveMutation=false` where applicable.
- DB baseline and post-test stale-row delta, not a forced global zero.
- Source/runtime scheduler and configuration drift.
- Code-review result and residual risks.

## Stop Conditions

- Stop before implementation when experts disagree on a live mutation boundary.
- Stop before hard testing if the command can trade, publish, restart protected services, or write production data without an explicit current approval.
- Fail closed when approval evidence, market data, test evidence, or runtime ownership is missing.
- Do not classify historical stale rows as a regression unless the post-test delta increases.

## Capability Choice

- Use a skill plus repository harness for this workflow because it orchestrates local source, tests, scheduler files, and read-only DB evidence.
- Add an MCP only when a stable remote capability must be exposed as a typed tool with authentication and an independently useful API.
- Add a plugin only when the workflow needs distribution of multiple skills, MCP servers, or apps. Do not create one solely to wrap this checklist.

## Completion Gate

- `node scripts/harness-principles-audit.ts --strict --smoke` passes.
- Focused regression checks pass after the last source edit.
- No unapproved protected operation or production mutation occurred.
- Any pending launchd/runtime apply step is explicit rather than implied.
