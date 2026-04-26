# Mainbot Queue Retirement Plan

## Current State

`mainbot_queue` is no longer the preferred alert path.

Current preferred path:
- team producers -> alert publisher / Hub alarm webhook
- orchestrator -> filter / batch / Telegram fanout

`mainbot_queue` no longer exists on the live DB surface as an active or
compatibility object.

Live OPS status as of 2026-04-14:
- `ai.orchestrator` is running with `MAINBOT_QUEUE_CONSUMER_ENABLED=false`
- operator paths now use `recent-alerts.json`
- recent queue telemetry file `/tmp/mainbot-queue-usage.jsonl` is still empty
- live queue had no fresh `pending` rows during the disable trial
- `publishToQueue(...)` now requires `MAINBOT_QUEUE_PUBLISH_ENABLED=true`
- final destructive cleanup completed successfully

Related archive planning:
- [MAINBOT_QUEUE_ARCHIVAL_PLAN_2026-04-14.md](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/context/MAINBOT_QUEUE_ARCHIVAL_PLAN_2026-04-14.md)
  - archive tables created and row-count verified on 2026-04-14
  - live freeze applied on 2026-04-14
  - final destructive cleanup applied on 2026-04-14
  - rollback SQL script prepared
- [MAINBOT_QUEUE_FINAL_RETIREMENT_CHECKLIST_2026-04-14.md](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/context/MAINBOT_QUEUE_FINAL_RETIREMENT_CHECKLIST_2026-04-14.md)
  - final destructive cleanup gate

## Current Usage Classification

### 1. Legacy producer write path

These still write or can write into `mainbot_queue`.

- [reporting-hub.ts](/Users/alexlee/projects/ai-agent-system/packages/core/lib/reporting-hub.ts)
  - `publishToQueue(...)`
  - `publishEventPipeline(... target.type === 'queue')`
  - `buildSeverityTargets(...)` default now keeps `includeQueue = false`
  - queue publish is now opt-in via `MAINBOT_QUEUE_PUBLISH_ENABLED=true`

Recently removed from this bucket:

- [luna-commander.cjs](/Users/alexlee/projects/ai-agent-system/bots/investment/luna-commander.cjs)
  - `publishToQueue(...)` -> `publishToWebhook(...)`

Interpretation:
- The generic reporting-hub queue target was the biggest functional blocker for full retirement.
- It is now retired-by-default and remains only as an explicit compatibility rail.
- `publishToQueue(...)` still emits legacy queue usage telemetry to `/tmp/mainbot-queue-usage.jsonl`
  if anyone explicitly re-enables it.

### 2. Legacy consumer/runtime path

These still read from `mainbot_queue` as part of orchestrator behavior.

- [mainbot.legacy.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/mainbot.legacy.js)
  - queue polling / processing loop
  - now supports `MAINBOT_QUEUE_CONSUMER_ENABLED=false` for staged disable
  - live OPS trial completed successfully with consumer disabled
  - queue-specific cleanup/maintenance is also skipped when disabled
- [router.ts](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.ts)
  - `queue` command summary
  - `mute_last_alert`
  - `unmute_last_alert`
  - now migrating to `recent-alerts.json` snapshot written by `postAlarm(...)`

Interpretation:
- This path has been retired in live OPS.
- The remaining code is compatibility-oriented and no longer backed by live queue tables.

### 3. Monitoring-only usage

These only read queue state for status/reporting.

- [dashboard.ts](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/dashboard.ts)
  - now migrating to `recent-alerts.json` snapshot for totals and recent alerts

Interpretation:
- These have already been migrated away from direct queue reads.
- Current operator visibility comes from alert snapshot / webhook flow.

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

## Current Outcome

Current state:

1. queue publish is retired-by-default
2. queue consumer is disabled in live OPS
3. queue-specific maintenance is disabled in live OPS
4. operator affordances use alert snapshot data
5. live queue views and frozen live tables have been removed
6. archive tables remain as the retained legacy record
