---
name: cancel-pipeline-ops
description: Inspect SKA Naver cancel scanner, Pickko cancellation sync, retry queue, and legacy cleanup readiness without mutating live reservations.
triggers:
  - ska cancel pipeline
  - cancel sync status
  - pickko cancel retry queue
  - legacy cancel cleanup gate
permissions:
  - read-only
owner: ska
llm_routing: hub.agent_policy
---

# SKA Cancel Pipeline Ops

Use this skill when checking whether Naver cancellations are detected, whether Pickko cancellation work is synchronized, or whether legacy absence-inference cleanup is ready.

## Read-Only Checks

- Call `ska-ops-mcp` tool `cancel-pipeline-status` for retry queue depth, v14 migration state, and latest shadow-diff summary.
- Call `reservation-sync-check` for advisory mismatches between `reservation.reservations` and `reservation.pickko_order_raw`.
- Call `shadow-diff` for recorded shadow history and the 3-day cleanup gate.

## Manual Intervention

- Treat `naverCompletedMissingPickko`, `pickkoOnly`, and `cancelledButPickkoEvidence` as advisory evidence, not as automatic mutation candidates.
- For `manual_required` or `exhausted` retry queue rows, inspect the booking slot and Pickko admin manually before changing any live state.
- Do not enable `SKA_CANCEL_RETRY_ENABLED`, apply cleanup deletion, or restart PROTECTED services from this skill.

## Cleanup Gate

Legacy absence-inference cleanup is ready only after 3 distinct shadow days with:

- `todayMissingInLegacy = 0`
- `todayMissingInUnified = 0`
- no scanner skip/login failure
- at least one `futureUnifiedOnly` observation in the window

If any blocker remains, keep legacy detection as a safety net.
