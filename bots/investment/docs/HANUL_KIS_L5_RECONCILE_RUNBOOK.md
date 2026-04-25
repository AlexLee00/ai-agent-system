# Hanul KIS L5 Reconcile Runbook

## Purpose

This runbook captures the L5 safety contract for KIS domestic and overseas stock execution.

Hanul must not treat an accepted zero-fill or partial-fill KIS order as terminal failure. If an order has an `ordNo` but fill confirmation is missing, Hanul must preserve a pending reconcile state and let the reconcile runner close the gap later.

## Required Smokes

```bash
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:kis-order-pending-reconcile-smoke
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:luna-l5-canary
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run check
```

Do not run live `--write`, `--confirm-live`, `--execute`, or `--apply` as part of these checks.

## Dry-Run Queue Check

Use this to inspect current pending KIS reconcile candidates without writing:

```bash
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:kis-order-pending-reconcile
```

Write mode is intentionally explicit and must include confirmation:

```bash
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:kis-order-pending-reconcile:write
```

## Closure Matrix

| Review risk | L5 contract | Code anchor | Smoke evidence |
| --- | --- | --- | --- |
| Accepted zero-fill order becomes terminal failure | `ordNo` plus fill-not-confirmed with zero fill becomes `order_pending_reconcile`, not terminal failure. | `markHanulOrderPendingReconcileSignal()` and execution branches in `team/hanul.ts` | `runtime:kis-order-pending-reconcile-smoke` returns `queued === "order_pending_reconcile"` |
| Partial fill overwrites/loses follow-up state | Partial fill is represented as `partial_fill_pending` with `followUpRequired=true`, preserving order metadata. | `markHanulPartialFillPendingSignal()` and pending meta builders in `team/hanul.ts` | `partial === "partial_fill_pending"` |
| Pending reconcile metadata has no runner | `processHanulPendingReconcileQueue()` scans `order_pending_reconcile` and `partial_fill_pending`, then applies deltas or closes completed orders. | `processHanulPendingReconcileQueue()` in `team/hanul.ts`; `runtime-kis-order-pending-reconcile.ts` | Dry-run command reports candidates/processed/summary |
| Approved KIS signals can strand if upstream interrupts | Hanul execution scans both `pending` and `approved` signals and de-dupes them before execution. | `listHanulExecutableSignals()` in `team/hanul.ts` | `runtime:luna-l5-canary` reports `hanulRecovery.pendingCount` and `hanulRecovery.approvedCount` |
| Overseas KIS fill lookup passes unsupported `ODNO` | Overseas `inquire-ccnl` sends `ODNO: ""` and filters rows locally by order number. | `verifyOverseasOrderFill()` in `shared/kis-client.ts` | Covered by KIS pending reconcile smoke and code inspection |

## Expected Smoke Shape

`runtime:kis-order-pending-reconcile-smoke -- --json` should include:

```json
{
  "ok": true,
  "sourceKey": "pendingReconcile",
  "queued": "order_pending_reconcile",
  "partial": "partial_fill_pending",
  "completed": "order_reconciled"
}
```

`runtime:luna-l5-canary` should include:

```json
{
  "ok": true,
  "hanulRecovery": {
    "pendingCount": 1,
    "approvedCount": 1
  }
}
```

## Fail-Closed Rules

- If KIS accepts an order and returns `ordNo`, do not issue a second order because fill verification is delayed.
- If `filledQty === 0` and verification is not final, keep `order_pending_reconcile`.
- If `0 < filledQty < expectedQty`, keep `partial_fill_pending`.
- If metadata is invalid or the order cannot be matched, leave an explicit reconcile failure/manual state; do not silently mark executed.
- Overseas fill lookup must use period/symbol rows and local order-number filtering, not direct `ODNO` lookup.

## Related Runbooks

- `/Users/alexlee/projects/ai-agent-system/bots/investment/docs/LUNA_L5_CANARY_RUNBOOK.md`
- `/Users/alexlee/projects/ai-agent-system/bots/investment/docs/HEPHAESTOS_L5_RECONCILE_RUNBOOK.md`
