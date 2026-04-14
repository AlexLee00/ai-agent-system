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
  - `buildSeverityTargets(...)` default now keeps `includeQueue = false`

Recently removed from this bucket:

- [luna-commander.cjs](/Users/alexlee/projects/ai-agent-system/bots/investment/luna-commander.cjs)
  - `publishToQueue(...)` -> `publishToWebhook(...)`

Interpretation:
- The generic reporting-hub queue target is now the biggest functional blocker for full retirement.
- Queue retirement must start by turning these producers off or rerouting them.
- `publishToQueue(...)` now emits legacy queue usage telemetry to `/tmp/mainbot-queue-usage.jsonl`
  so remaining runtime callers can be observed before removal.

### 2. Legacy consumer/runtime path

These still read from `mainbot_queue` as part of orchestrator behavior.

- [mainbot.legacy.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/mainbot.legacy.js)
  - queue polling / processing loop
- [router.ts](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.ts)
  - `queue` command summary
  - `mute_last_alert`
  - `unmute_last_alert`
  - now migrating to `recent-alerts.json` snapshot written by `postAlarm(...)`

Interpretation:
- This is user-visible behavior, but not the preferred ingestion path anymore.
- It should be migrated after producer writes are cut down.

### 3. Monitoring-only usage

These only read queue state for status/reporting.

- [dashboard.ts](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/dashboard.ts)
  - now migrating to `recent-alerts.json` snapshot for totals and recent alerts

Interpretation:
- These can be migrated last.
- They should move to alert publisher/webhook delivery metrics or reporting-hub telemetry.

## Recommended Retirement Order

### Phase A. Stop new writes

1. Audit every `publishToQueue(...)` caller.
2. Observe `/tmp/mainbot-queue-usage.jsonl` to confirm real runtime callers.
3. Replace current runtime producers with webhook / reporting-hub non-queue targets.
4. Keep queue reads temporarily for compatibility.

Exit condition:
- no current producer writes to `mainbot_queue`

### Phase B. Replace queue-driven operator affordances

1. Replace `/queue` summary with `recent-alerts.json` snapshot first.
2. Replace `mute_last_alert` / `unmute_last_alert` to use the same snapshot.
3. Migrate dashboard reads after operator commands are stable.
4. Keep legacy polling only if old producers still exist.

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

1. observe `/tmp/mainbot-queue-usage.jsonl` for remaining runtime writers
2. finish router `/queue` + mute/unmute migration to `recent-alerts.json`
3. verify snapshot-based dashboard and operator flows in live runtime
4. then evaluate whether legacy consumer loop still needs live queue visibility
