# Mainbot Queue Retirement Plan

## Current State

`mainbot_queue` is no longer the preferred alert path.

Current preferred path:
- team producers -> alert publisher / OpenClaw webhook
- orchestrator -> filter / batch / Telegram fanout

`mainbot_queue` is still alive as a legacy rail and cannot be removed yet.

Live OPS status as of 2026-04-14:
- `ai.orchestrator` is running with `MAINBOT_QUEUE_CONSUMER_ENABLED=false`
- operator paths now use `recent-alerts.json`
- recent queue telemetry file `/tmp/mainbot-queue-usage.jsonl` is still empty
- live queue had no fresh `pending` rows during the disable trial
- `publishToQueue(...)` now requires `MAINBOT_QUEUE_PUBLISH_ENABLED=true`

Related archive planning:
- [MAINBOT_QUEUE_ARCHIVAL_PLAN_2026-04-14.md](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/context/MAINBOT_QUEUE_ARCHIVAL_PLAN_2026-04-14.md)

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
- The generic reporting-hub queue target is now the biggest functional blocker for full retirement.
- Queue retirement must start by turning these producers off or rerouting them.
- `publishToQueue(...)` now emits legacy queue usage telemetry to `/tmp/mainbot-queue-usage.jsonl`
  so remaining runtime callers can be observed before removal.

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

1. observe `/tmp/mainbot-queue-usage.jsonl` for any explicit re-enable caller
2. keep observing OPS runtime for any queue writer reappearance
3. if telemetry stays quiet, treat queue publish and queue polling as retired-by-default
4. then evaluate table retirement / archival timing
