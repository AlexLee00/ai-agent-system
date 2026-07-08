---
name: cancel-pipeline-ops
description: Inspect SKA Naver cancellation evidence, Pickko cancellation sync, and retry queue status without mutating live reservations.
triggers:
  - ska cancel pipeline
  - cancel sync status
  - pickko cancel retry queue
permissions:
  - read-only
owner: ska
llm_routing: hub.agent_policy
---

# SKA Cancel Pipeline Ops

Use this skill when checking whether Naver cancellations are detected, whether Pickko cancellation work is synchronized, or whether retry queue rows need manual attention.

## Read-Only Checks

- Call `ska-ops-mcp` tool `cancel-pipeline-status` for retry queue depth and v14 migration state.
- Call `reservation-sync-check` for advisory mismatches between `reservation.reservations` and `reservation.pickko_order_raw`.

## Manual Intervention

- Treat `naverCompletedMissingPickko`, `pickkoOnly`, and `cancelledButPickkoEvidence` as advisory evidence, not as automatic mutation candidates.
- For `manual_required` or `exhausted` retry queue rows, inspect the booking slot and Pickko admin manually before changing any live state.
- Do not enable `SKA_CANCEL_RETRY_ENABLED`, mutate live cancellation state, or restart PROTECTED services from this skill.
