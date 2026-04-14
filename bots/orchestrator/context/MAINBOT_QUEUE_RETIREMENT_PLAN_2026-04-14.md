# Mainbot Queue Retirement Plan

## Current State

`mainbot_queue` is no longer the preferred alert path.

Current preferred path:
- team producers -> alert publisher / OpenClaw webhook
- orchestrator -> filter / batch / Telegram fanout

`mainbot_queue` is still alive as a legacy rail and cannot be removed yet.

## Current Usage Classification

### 1. Legacy producer write path

These still write or can write into `mainbot_queue`.

- [reporting-hub.ts](/Users/alexlee/projects/ai-agent-system/packages/core/lib/reporting-hub.ts)
  - `publishToQueue(...)`
  - `publishEventPipeline(... target.type === 'queue')`
- [luna-commander.cjs](/Users/alexlee/projects/ai-agent-system/bots/investment/luna-commander.cjs)
  - explicit `publishToQueue(...)`

Interpretation:
- This is the biggest functional blocker for full retirement.
- Queue retirement must start by turning these producers off or rerouting them.

### 2. Legacy consumer/runtime path

These still read from `mainbot_queue` as part of orchestrator behavior.

- [mainbot.legacy.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/mainbot.legacy.js)
  - queue polling / processing loop
- [router.ts](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.ts)
  - `queue` command summary
  - `mute_last_alert`
  - `unmute_last_alert`

Interpretation:
- This is user-visible behavior, but not the preferred ingestion path anymore.
- It should be migrated after producer writes are cut down.

### 3. Monitoring-only usage

These only read queue state for status/reporting.

- [dashboard.ts](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/dashboard.ts)
  - queue totals
  - recent alerts

Interpretation:
- These can be migrated last.
- They should move to alert publisher/webhook delivery metrics or reporting-hub telemetry.

## Recommended Retirement Order

### Phase A. Stop new writes

1. Audit every `publishToQueue(...)` caller.
2. Replace current runtime producers with webhook / reporting-hub non-queue targets.
3. Keep queue reads temporarily for compatibility.

Exit condition:
- no current producer writes to `mainbot_queue`

### Phase B. Replace queue-driven operator affordances

1. Replace `/queue` summary with webhook/reporting-hub delivery summary.
2. Replace `mute_last_alert` / `unmute_last_alert` to use new delivery/event storage.
3. Keep legacy polling only if old producers still exist.

Exit condition:
- operator commands no longer depend on `mainbot_queue`

### Phase C. Remove legacy consumer loop

1. Disable `mainbot.legacy.js` queue polling responsibility.
2. Remove `publishToQueue(...)` as an active target.
3. Mark `mainbot_queue` schema/table as retirement candidate.

Exit condition:
- runtime no longer needs queue polling

### Phase D. Database retirement

1. Confirm no read/write traffic in production.
2. Archive monitoring queries if needed.
3. Deprecate migration/docs references.
4. Remove or freeze table ownership.

## Guardrails

- Do not remove `mainbot_queue` while `publishToQueue(...)` still has current callers.
- Do not remove queue reads before operator commands have replacement data sources.
- Treat dashboard reads as the last migration step, not the first.

## Next Practical Step

The next safe implementation step is:

1. enumerate actual runtime callers of `publishToQueue(...)`
2. migrate those producers to webhook / alert publisher
3. then revisit orchestrator queue command paths
