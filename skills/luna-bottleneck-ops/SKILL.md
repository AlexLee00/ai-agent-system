---
name: luna-bottleneck-ops
description: Use when diagnosing or improving Luna investment-team autonomous operation bottlenecks, especially the 30-minute Codex automation loop, live-fire watchdog issues, LLM hot-path overuse, discovery funnel stalls, marketdata connectivity, reconcile blockers, or safe fix planning.
---

# Luna Bottleneck Ops

## Operating Boundary

- Worktree: `/Users/alexlee/projects/ai-agent-system`.
- Primary operator: `npm --prefix bots/investment run -s runtime:luna-bottleneck-autonomy -- --json --publish-events`.
- Read-only MCP server: `bots/investment/mcp/luna-ops-mcp/src/server.ts`.
- Never unload, kill, restart, or bootout the PROTECTED 6 from this workflow:
  - `ai.luna.tradingview-ws`
  - `ai.investment.commander`
  - `ai.elixir.supervisor`
  - `ai.luna.marketdata-mcp`
  - `ai.claude.auto-dev.autonomous`
  - `ai.hub.resource-api`

## Standard Loop

1. Run the bottleneck operator with JSON and event publishing.
2. Classify the result into `hardBlockers`, `bottlenecks`, `warnings`, and `safeFixCandidates`.
3. If a hard blocker appears, report it and do not execute live trades.
4. If a safe fix candidate is `read_only` or `diagnostic`, run it directly.
5. If a candidate is `confirm_required`, do not apply it unless the existing command already contains the exact confirm token and the user explicitly approved that class of operation.
6. If a candidate is `codex_patch_required`, inspect source, patch with tests, and keep changes scoped to Luna/investment unless the evidence points elsewhere.
7. Run the narrow check first: `npm --prefix bots/investment run -s check:luna-bottleneck-autonomy`.
8. Run broader checks only when touched code demands them.
9. Commit/push only when the user asks or the active automation instruction explicitly requires it.

## Automation Contract

- Automation cadence: 30 minutes.
- Preferred automation model: `gpt-5.5` with `xhigh` reasoning.
- The automation should call the operator first; it should not scrape logs ad hoc before the standardized report exists.
- The automation may create patches for root-cause fixes, but it must not perform live order execution, manual reconcile apply, live-fire rollback, or protected PID changes without explicit instruction.
- The operator emits `luna_bottleneck_autonomy` events to `agent.event_lake` when `--publish-events` is used.

## MCP Usage

- Use `luna_status` for a quick summary.
- Use `luna_bottlenecks` for the full report.
- Use `luna_llm_usage` for LLM hot-path checks.
- Use `luna_guardrails` for final gate and marketdata guardrail status.
- Use `luna_apply_plan` for safe commands; the MCP never executes apply commands.

## Completion Criteria

- No unexpected protected PID manipulation.
- `check:luna-bottleneck-autonomy` passes.
- Any event publication failure is reported but does not hide the bottleneck report.
- If a patch is made, `git diff --check` passes before commit.
