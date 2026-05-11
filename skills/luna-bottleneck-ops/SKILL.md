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

1. Inspect `git status --short` and preserve unrelated dirty files.
2. Prefer MCP first when available: call `luna_status`, `luna_bottlenecks`, `luna_llm_usage`, `luna_guardrails`, `luna_discovery_funnel`, and `luna_apply_plan`.
3. Always run the primary operator with JSON, event publishing, and no-fail mode: `npm --prefix bots/investment run -s runtime:luna-bottleneck-autonomy -- --json --publish-events --no-fail`.
4. Treat the operator result and `luna_bottleneck_autonomy` event as the source of truth before scraping logs.
5. Classify the result into `hardBlockers`, `bottlenecks`, `warnings`, and `safeFixCandidates`.
6. If a hard blocker appears, report it with rollback or manual commands, but do not execute live trades, live-fire cutover, manual reconcile, rollback, or protected PID changes.
7. If a safe fix candidate is `read_only` or `diagnostic`, run it directly and attach the result to the final report.
8. If a candidate is `confirm_required`, do not apply it; report the exact command and evidence needed.
9. If a candidate is `codex_patch_required`, inspect source and process evidence, identify the root cause, patch narrowly, and keep changes scoped to Luna/investment unless the evidence proves another scope is required.
10. Run `npm --prefix bots/investment run -s check:luna-bottleneck-autonomy` after any source change.
11. Run broader checks only when touched code demands them.
12. Run `git diff --check` before staging.
13. When the active automation explicitly authorizes it, stage only scoped Luna/investment changes, commit, and push after checks pass.
14. Re-run the operator after a patch when time allows; stop only when no actionable patch candidate remains or a human/confirm-required blocker is reached.

## Automation Contract

- Automation cadence: 30 minutes.
- Preferred automation model: `gpt-5.5` with `xhigh` reasoning.
- The automation should call MCP/operator first; it should not scrape logs ad hoc before standardized evidence exists.
- The automation may create, test, commit, and push patches for root-cause fixes when `safeFixCandidates[].applyMode === codex_patch_required`.
- The automation must not perform live order execution, manual reconcile apply, live-fire cutover, live-fire rollback, secret changes, or protected PID changes without explicit current user approval.
- The operator emits `luna_bottleneck_autonomy` events to `agent.event_lake` when `--publish-events` is used; this is the default hook/event trail.
- If event publication fails, the automation should still use the JSON report and flag the event failure as a warning.

## MCP Usage

- Use `luna_status` for a quick summary.
- Use `luna_bottlenecks` for the full report.
- Use `luna_llm_usage` for LLM hot-path checks.
- Use `luna_guardrails` for final gate and marketdata guardrail status.
- Use `luna_discovery_funnel` for candidate/persistence/decision bottlenecks.
- Use `luna_apply_plan` for safe commands; the MCP never executes apply commands.

## Patch Discipline

- Patch source, not smoke expectations, unless the smoke itself is stale or incorrect.
- Fix root causes directly in the runtime path when evidence identifies them.
- Do not broaden trading permissions to make a test pass.
- Do not edit secrets, local runtime data, trade ledgers, manual reconcile state, or live-fire flags.
- Do not stage unrelated files, generated reports, credentials, or user worktree changes.
- If the evidence is ambiguous, add a read-only diagnostic or targeted report before patching.

## Completion Criteria

- No unexpected protected PID manipulation.
- `check:luna-bottleneck-autonomy` passes.
- Any event publication failure is reported but does not hide the bottleneck report.
- If a patch is made, `git diff --check` passes before commit.
- If a patch is committed, the commit message clearly names the Luna bottleneck fixed.
