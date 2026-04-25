# Investment L5 Master Runbook

## Purpose

This is the top-level L5 operating gate for the investment team.

Use this document before enabling, keeping, or resuming live autonomous investment execution. The detailed contracts live in the team-specific runbooks linked below.

## Scope

- Luna: signal decision and risk-gated persistence
- Hephaestos: Binance execution and pending reconciliation
- Hanul: KIS domestic/overseas execution and pending reconciliation

## Required Gate

Run all commands below before live execution windows and after any investment code change:

```bash
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:luna-l5-canary
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:binance-order-pending-reconcile-smoke -- --json
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:binance-mcp-client-orderid-smoke -- --json
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:kis-order-pending-reconcile-smoke -- --json
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run check
```

These commands are non-trading. They must not require live `--execute`, `--apply`, `--write`, or `--confirm-live`.

## Required Pass Signals

| Area | Required signal |
| --- | --- |
| Luna | `runtime:luna-l5-canary` returns `ok: true`, approved signals persist as `approved`, rejected signals persist as `rejected`, and direct path failure persists as `failed`. |
| Hephaestos | Binance pending reconcile smoke returns `clientOrderRecoverCode: "order_reconciled"`, `missingOrderIdCode: "manual_reconcile_required"`, `unsupportedQuoteCode: "manual_reconcile_required"`, and `pending_reconcile_enqueue_failed` coverage. |
| Binance MCP | MCP client order-id smoke returns the same `clientOrderId` sent to market buy/sell. |
| Hanul | KIS pending reconcile smoke returns `queued: "order_pending_reconcile"`, `partial: "partial_fill_pending"`, and `completed: "order_reconciled"`. |
| Full package | `npm --prefix .../bots/investment run check` passes. |

## Stop Conditions

Immediately pause or avoid live L5 execution if any condition below is true:

- Any required gate command fails.
- Luna creates an unexpected executable `pending` signal after risk evaluation.
- A mutating broker action can be retried without a durable `orderId` or `clientOrderId`.
- Binance quote conversion is unsupported but would be written as USDT cost.
- KIS accepted zero-fill or partial-fill orders are marked terminal without pending reconcile metadata.
- Pending reconcile queue metadata cannot be written but the caller reports success.
- `BINANCE_MCP_SMOKE_CAPTURE=1` appears outside `NODE_ENV=test`.
- Runtime ops files show repeated manual reconcile pressure that is not being repaired.

## Live Boundary

The master gate is allowed to run in normal operations because it is non-trading.

The following require explicit operator intent and must not be run as part of the gate:

```bash
--execute
--apply
--write
--confirm-live
```

## Recovery Order

1. Stop new live execution if a stop condition is active.
2. Run the master gate commands and capture the failing output.
3. Inspect the relevant detailed runbook.
4. Repair the failing contract or leave the system in manual reconcile state.
5. Re-run the master gate.
6. Resume live execution only after all required pass signals are present.

## Detailed Runbooks

- `/Users/alexlee/projects/ai-agent-system/bots/investment/docs/LUNA_L5_CANARY_RUNBOOK.md`
- `/Users/alexlee/projects/ai-agent-system/bots/investment/docs/HEPHAESTOS_L5_RECONCILE_RUNBOOK.md`
- `/Users/alexlee/projects/ai-agent-system/bots/investment/docs/HANUL_KIS_L5_RECONCILE_RUNBOOK.md`

## Commit Hygiene

When updating investment L5 contracts:

- Keep `bots/investment/output/ops/*` runtime output out of code/doc commits unless the task is explicitly about ops evidence.
- Keep unrelated `bots/blog/*` changes on a separate branch or commit.
- Re-run the master gate after staging investment changes.
