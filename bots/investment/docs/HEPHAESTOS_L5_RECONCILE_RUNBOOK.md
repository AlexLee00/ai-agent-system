# Hephaestos L5 Reconcile Runbook

## Purpose

This runbook captures the L5 safety contract for Binance order execution and pending reconciliation.

The goal is simple: after any mutating order attempt, Hephaestos must either persist the broker-confirmed fill exactly once or leave a repairable reconcile state. It must not issue a second order because parsing, lookup, or DB persistence failed.

## Required Smokes

```bash
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:binance-order-pending-reconcile-smoke -- --json
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:binance-mcp-client-orderid-smoke -- --json
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run check
```

Do not run live `--execute` or `--apply` as part of these checks.

## Closure Matrix

| Review risk | L5 contract | Code anchor | Smoke evidence |
| --- | --- | --- | --- |
| `orderId` missing is closed manually too early | If `clientOrderId` exists, retry with `clientOrderId` and all-orders matching. Only definitive `not_found`/`ambiguous` or no key becomes `manual_reconcile_required`. | `executeSignal()` pending branch in `team/hephaestos.ts`; `fetchBinanceOrder()` in `shared/binance-client.ts` | `queuePath.clientOrderRecoverCode === "order_reconciled"` and `missingOrderIdCode === "manual_reconcile_required"` |
| Binance order lookup is orderId-only | Public client accepts `{ symbol, orderId?, clientOrderId?, submittedAtMs?, side? }`, then uses `origClientOrderId` lookup and all-orders fallback. | `fetchBinanceOrder()` in `shared/binance-client.ts` | `runtime:binance-order-pending-reconcile-smoke` client recovery path |
| MCP fetch cannot recover by client order id | MCP `fetch_order` accepts `clientOrderId`/`origClientOrderId`, and MCP `all_orders` is available for fallback parity. | `binance-market-mcp-server.py` actions `fetch_order` and `all_orders` | `runtime:binance-mcp-client-orderid-smoke` |
| MCP market orders drop `clientOrderId` | MCP `market_buy`/`market_sell` passes `clientOrderId` into order options so Binance receives `newClientOrderId`. | `binance-market-mcp-server.py` actions `market_buy` and `market_sell` | `marketBuyClientOrderId` and `marketSellClientOrderId` match smoke ids |
| `order_fill_unverified` bypasses reconcile | `order_fill_unverified` is reconcile-eligible when `orderId` or `clientOrderId` exists. | `executeSignal()` pending eligibility in `team/hephaestos.ts` | Covered by pending reconcile smoke client-order recovery |
| Direct `clientOrderId` lookup depends only on all-orders | Direct lookup uses `origClientOrderId` via private order endpoint before all-orders fallback. | `fetchBinanceOrder()` in `shared/binance-client.ts` | `runtime:binance-order-pending-reconcile-smoke` and MCP client-order smoke |
| Transient `clientOrderId` lookup failure closes queue | Transient lookup failure with a client key enqueues `order_pending_reconcile` and retries later. | `enqueueClientOrderPendingRetry()` in `team/hephaestos.ts` | Pending retry paths in `runtime:binance-order-pending-reconcile-smoke` |
| Smoke capture can fake live fills | `BINANCE_MCP_SMOKE_CAPTURE` is accepted only when `NODE_ENV === "test"`. | `createBinanceMarketBuy/Sell()` in `shared/binance-client.ts` | `runtime:binance-mcp-client-orderid-smoke` sets test-only env |
| Pending queue write failure is swallowed | Queue write failure returns `pending_reconcile_enqueue_failed`, persists failure metadata, and alerts. | `enqueueClientOrderPendingRetry()` in `team/hephaestos.ts` | `pendingEnqueueFailurePath.resultCode === "pending_reconcile_enqueue_failed"` |
| Enqueue failure lacks regression coverage | Smoke injects mark failure and verifies failure return, persisted code, and notify count. | `runtime-binance-order-pending-reconcile-smoke.ts` | `pendingEnqueueFailurePath.notifyCount >= 1` |
| Unsupported quote mismatch falls through as raw units | Only same quote or `BTC -> USDT` conversion is allowed. Unsupported quote mismatch throws and becomes manual reconcile. | `normalizePendingReconcileOrderUnits()` in `team/hephaestos.ts` | `queuePath.unsupportedQuoteCode === "manual_reconcile_required"` |
| BTC pair fills use BTC units in USDT ledger | BTC quote fills convert price/cost to USDT using pending BTC reference or `BTC/USDT`. | `normalizePendingReconcileOrderUnits()` in `team/hephaestos.ts` | `queuePath.btcPairClosedCode === "order_reconciled"` |

## Expected Smoke Shape

The Binance pending reconcile smoke should include these high-signal fields:

```json
{
  "ok": true,
  "queuePath": {
    "btcPairClosedCode": "order_reconciled",
    "clientOrderRecoverCode": "order_reconciled",
    "missingOrderIdCode": "manual_reconcile_required",
    "unsupportedQuoteCode": "manual_reconcile_required"
  },
  "actualApplyPath": {
    "positionAmount": 7
  },
  "btcFallbackGuardPath": {
    "orderAttemptedBlocked": true,
    "pendingBlocked": true,
    "preOrderAllowed": true
  },
  "pendingEnqueueFailurePath": {
    "resultCode": "pending_reconcile_enqueue_failed",
    "persistCode": "pending_reconcile_enqueue_failed"
  }
}
```

## Fail-Closed Rules

- Mutating MCP/CCXT order actions must not direct-fallback after a bridge/order attempt may have reached the broker.
- If broker lookup has a `clientOrderId`, keep a retryable pending reconcile state unless lookup definitively returns `not_found` or `ambiguous`.
- If no durable broker key exists, use `manual_reconcile_required`; do not mark the signal as successfully queued.
- If queue metadata cannot be written, return `pending_reconcile_enqueue_failed`; do not report success.
- If quote conversion is unsupported, fail closed; never write non-USDT cost into USDT positions/trades.

## Related Runbooks

- `/Users/alexlee/projects/ai-agent-system/bots/investment/docs/LUNA_L5_CANARY_RUNBOOK.md`
