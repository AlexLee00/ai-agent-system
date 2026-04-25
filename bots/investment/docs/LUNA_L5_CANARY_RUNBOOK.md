# Luna L5 Canary Runbook

## Purpose

This canary verifies that Luna can produce L5-safe signals without exposing an executable `pending` signal between risk evaluation and persistence.

It is intentionally non-trading. It writes short-lived synthetic DB rows, validates them, and cleans them up.

## Command

```bash
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:luna-l5-canary
```

Expected result:

```json
{
  "ok": true,
  "approved": { "status": "approved" },
  "rejected": { "status": "rejected", "blockCode": "risk_rejected" },
  "hanulRecovery": { "pendingCount": 1, "approvedCount": 1 },
  "directPath": {
    "approvedStatus": "approved",
    "rejectedStatus": "rejected",
    "failedStatus": "failed"
  }
}
```

## What It Covers

- L30 saves approved decisions initially as `approved`, with `nemesis_verdict` and `approved_at`.
- L30 saves rejected decisions initially as `rejected`, with `risk_rejected` block metadata.
- Hanul scans both `pending` and `approved` KIS signals so approved signals stranded after upstream interruption remain executable.
- Direct `team/luna.ts` persistence builds a risk input with `amount_usdt`, then persists only `approved`, `rejected`, or `failed` states.

## Promotion Gate

Luna L5 can stay enabled only when:

- `runtime:luna-l5-canary` passes.
- `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run check` passes.
- There are no unexpected executable `pending` Luna signals created by a risk-evaluated path.
- Hephaestos/Hanul pending reconcile smokes pass before live execution windows.

## Fail-Closed Rules

- If risk evaluation fails, persist `failed`, not `pending`.
- If risk rejects, persist `rejected`, not `pending`.
- If approved, persist `approved` with adjusted amount and approval metadata in the initial insert.
- Do not run live `--execute` or `--apply` as part of this canary.

## Related Smokes

```bash
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:binance-order-pending-reconcile-smoke -- --json
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:binance-mcp-client-orderid-smoke -- --json
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:kis-order-pending-reconcile-smoke
```
